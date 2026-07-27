/**
 * Can a grammar's lexer run on baba's WebGPU kernel?
 *
 * The kernel keeps the whole DFA in **workgroup storage**, so eligibility is decided by the grammar,
 * not by the program being compiled. That surprises people — a bigger project does not help, because
 * the tables are the same size whatever you feed them.
 *
 * The kernel's own accounting, from its refusal message:
 *
 *   bytes = 4 * (128 + states + states * classes)   // DFA tables
 *         + 32 * states                             // four rotating columns of two u32 per state
 *
 * so a grammar fits when `states * (36 + 4 * classes) <= limit - 512`. At the 63 character classes a
 * typical ASCII language grammar produces, that is about **168 states** on a device reporting
 * 49,152 B, and about **55** on the 16,384 B every conforming WebGPU device must provide.
 *
 * Rather than recompute that, this asks the kernel: `WebGpuLexer.create` reports exact numbers when
 * it refuses, which cannot drift from the implementation the way a copied formula would.
 *
 * Usage: deno task check:gpu-lexer [plan...]     (defaults to this repository's three grammars)
 *
 * @module
 */
import { decodeLexerPlanTables, WebGpuLexer } from "@mewhhaha/baba/runtime/webgpu-lexer";

const DEFAULT_PLANS = [
  "language/gleam/generated/wasm/parser.plan",
  "language/lazuli/generated/wasm/parser.plan",
  "examples/javascript-aot/language/generated/wasm/parser.plan",
];

const plans = Deno.args.length > 0 ? Deno.args : DEFAULT_PLANS;

for (const path of plans) {
  // ".../language/gleam/generated/wasm/parser.plan" -> "gleam"
  const label = path.split("/").at(-4) ?? path;
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(path);
  } catch {
    console.log(`${path}: no plan on disk`);
    continue;
  }

  let guardFree: boolean;
  let states: number;
  try {
    const tables = decodeLexerPlanTables(bytes);
    guardFree = tables.guardFree;
    states = tables.stateCount;
  } catch (error) {
    // An older plan format cannot be read at all, which is a real answer: regenerate it first.
    console.log(`${label}: unreadable — ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }

  if (!guardFree) {
    console.log(
      `${label}: ${states} states, NOT guard-free — the kernel takes guard-free grammars only`,
    );
    continue;
  }

  try {
    const lexer = await WebGpuLexer.create(bytes);
    console.log(`${label}: ${states} states, guard-free, FITS (chunk ${lexer.chunkSize})`);
    lexer.destroy?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sizes = message.match(/needs (\d+) B.*?maxComputeWorkgroupStorageSize=(\d+)/);
    if (sizes === null) {
      console.log(`${label}: ${states} states, refused — ${message.slice(0, 120)}`);
      continue;
    }
    const needed = Number(sizes[1]);
    const limit = Number(sizes[2]);
    console.log(
      `${label}: ${states} states, guard-free, OVER by ${
        (needed - limit).toLocaleString()
      } B — needs ${needed.toLocaleString()} B, device allows ${limit.toLocaleString()} B`,
    );
  }
}
