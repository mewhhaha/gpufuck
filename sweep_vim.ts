/**
 * A modal editor whose entire logic lives in `examples/sweep/vim.sweep`.
 *
 * This file is the host, and it is deliberately dumb: put the terminal in raw mode, read a key,
 * append it to the history, hand the whole history to the compiled WebAssembly, and draw whatever
 * comes back. It holds no buffer, no cursor, and no mode — those exist only inside the Sweep
 * program, so there is nothing here that can disagree with it.
 *
 * Sweep is compiled once on the GPU at startup. Each keystroke is a WebAssembly call that replays
 * the session from empty. Measured, that is linear rather than quadratic -- each key is O(1) on a
 * zipper -- at 0.2 ms for 25 keys and 3.2 ms for 2,000.
 *
 * Usage: deno task vim
 *
 * @module
 */
import { GpuCompiler, requestWebGpuDevice, runWasmModule } from "./functional.ts";
import type { GpuModule, WasmHostValue } from "./functional.ts";
import { compileSweepSource } from "./sweep.ts";

const SOURCE = "examples/sweep/vim.sweep";

/**
 * Every character in the document is one `Char` constructor in the returned value, and the decoder
 * defaults to 2,047 nodes -- about a thousand characters. Raising it is the difference between an
 * editor and a demo.
 */
const RESULT_NODE_LIMIT = 200_000;

/** The constructor tree Sweep's `main` expects: a cons list of key codes. */
function keyList(codes: readonly number[]): WasmHostValue {
  let list: WasmHostValue = { kind: "constructor", name: "NoKeys", fields: [] };
  for (let index = codes.length - 1; index >= 0; index--) {
    list = {
      kind: "constructor",
      name: "Press",
      fields: [{ kind: "integer", value: codes[index]! }, list],
    };
  }
  return list;
}

function field(value: WasmHostValue, index: number): WasmHostValue {
  if (value.kind !== "constructor") throw new Error(`expected a constructor, got ${value.kind}`);
  const found = value.fields[index];
  if (found === undefined) throw new Error(`${value.name} has no field ${index}`);
  return found;
}

function constructorName(value: WasmHostValue): string {
  if (value.kind !== "constructor") throw new Error(`expected a constructor, got ${value.kind}`);
  return value.name;
}

/** `Line` is a cons list of character codes. */
function readLine(value: WasmHostValue): string {
  let text = "";
  let at = value;
  while (constructorName(at) === "Char") {
    const code = field(at, 0);
    if (code.kind !== "integer") throw new Error("Char code is not an integer");
    text += String.fromCharCode(code.value);
    at = field(at, 1);
  }
  return text;
}

/** `before` is stored reversed, so reading order is its reverse followed by `after`. */
function readZipper(value: WasmHostValue): { readonly text: string; readonly column: number } {
  const before = [...readLine(field(value, 0))].reverse().join("");
  const after = readLine(field(value, 1));
  return { text: before + after, column: before.length };
}

function readBuffer(value: WasmHostValue): string[] {
  const lines: string[] = [];
  let at = value;
  while (constructorName(at) === "Lines") {
    lines.push(readZipper(field(at, 0)).text);
    at = field(at, 1);
  }
  return lines;
}

interface Screen {
  readonly lines: readonly string[];
  readonly row: number;
  readonly column: number;
  readonly mode: string;
  readonly quit: boolean;
}

function readState(value: WasmHostValue): Screen {
  const document = field(value, 0);
  const mode = constructorName(field(value, 1));
  const quitValue = field(value, 2);
  // `above` is nearest-first, so it reverses into display order.
  const above = readBuffer(field(document, 0)).reverse();
  const current = readZipper(field(document, 1));
  const below = readBuffer(field(document, 2));
  return {
    lines: [...above, current.text, ...below],
    row: above.length,
    column: current.column,
    mode,
    quit: quitValue.kind === "boolean" && quitValue.value,
  };
}

function draw(screen: Screen, milliseconds: number, keys: number): void {
  const rows = screen.lines.length === 0 ? [""] : screen.lines;
  const body = rows.map((line, index) => `${String(index + 1).padStart(3)} │ ${line}`).join("\r\n");
  const status = `[7m ${screen.mode.toUpperCase().padEnd(6)} ${rows.length} lines  ` +
    `${screen.row + 1}:${screen.column + 1}  ${keys} keys replayed in ${
      milliseconds.toFixed(1)
    } ms  ` +
    `-- q quits [0m`;
  // Clear, draw, then park the cursor where the editor says it is.
  Deno.stdout.writeSync(new TextEncoder().encode(
    `[2J[H${body}\r\n\r\n${status}[${screen.row + 1};${screen.column + 7}H`,
  ));
}

async function compile(): Promise<{ module: GpuModule; device: GPUDevice; milliseconds: number }> {
  const source = await Deno.readTextFile(SOURCE);
  const lowered = compileSweepSource("vim", source);
  if (!lowered.ok) throw new Error(`${SOURCE}: ${lowered.diagnostics[0]!.message}`);
  const device = await requestWebGpuDevice();
  const started = performance.now();
  const compiler = await GpuCompiler.create(device);
  const compilation = await compiler.compileModule(lowered.module, { maximumSteps: 10_000_000 });
  if (!compilation.ok) {
    const diagnostic = compilation.diagnostics[0]!;
    throw new Error(`${SOURCE}: ${diagnostic.code}: ${diagnostic.message}`);
  }
  return { module: compilation.module, device, milliseconds: performance.now() - started };
}

if (import.meta.main) {
  console.log(`compiling ${SOURCE} on the GPU...`);
  const { module, device, milliseconds } = await compile();
  console.log(`compiled in ${milliseconds.toFixed(0)} ms; press any key to start`);

  const raw = Deno.stdin.isTerminal();
  if (raw) Deno.stdin.setRaw(true);
  const codes: number[] = [];
  const input = new Uint8Array(64);
  try {
    let screen = readState(
      (await runWasmModule(module, {
        argument: keyList(codes),
        maximumResultNodes: RESULT_NODE_LIMIT,
      })).value as WasmHostValue,
    );
    draw(screen, 0, 0);
    while (!screen.quit) {
      const read = await Deno.stdin.read(input);
      if (read === null) break;
      for (let index = 0; index < read; index++) codes.push(input[index]!);
      const started = performance.now();
      const execution = await runWasmModule(module, {
        argument: keyList(codes),
        maximumResultNodes: RESULT_NODE_LIMIT,
      });
      const elapsed = performance.now() - started;
      screen = readState(execution.value as WasmHostValue);
      draw(screen, elapsed, codes.length);
    }
  } finally {
    if (raw) Deno.stdin.setRaw(false);
    Deno.stdout.writeSync(new TextEncoder().encode("[2J[H"));
    module.destroy();
    device.destroy();
  }
}
