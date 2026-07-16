import { deepStrictEqual, equal, rejects } from "node:assert/strict";

import { requestWebGpuDevice } from "../mod.ts";
import {
  compileBrainfuckSource,
  createLazuliBrainfuckRuntime,
  type LazuliBrainfuckRuntime,
  runBrainfuckWasm,
} from "../examples/lazuli-brainfuck/run.ts";

let device: GPUDevice | undefined;
let runtime: LazuliBrainfuckRuntime | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  runtime = await createLazuliBrainfuckRuntime(device);
});

Deno.test.afterAll(() => {
  runtime?.module.destroy();
  runtime = undefined;
  device?.destroy();
  device = undefined;
});

Deno.test("Lazuli compiles Brainfuck arithmetic and loops to executable WebAssembly", async () => {
  const compilation = await compileBrainfuckSource(brainfuckRuntime(), "+++[>++++<-]>.+.");
  const execution = await runBrainfuckWasm(compilation.wasmBytes);

  deepStrictEqual(execution.output, [12, 13]);
  equal(execution.finalCell, 13);
});

Deno.test("Lazuli Brainfuck compilation preserves input and output instructions", async () => {
  const compilation = await compileBrainfuckSource(brainfuckRuntime(), ",+.");
  const execution = await runBrainfuckWasm(compilation.wasmBytes, [41]);

  deepStrictEqual(execution.output, [42]);
  equal(execution.finalCell, 42);
});

Deno.test("Lazuli Brainfuck compilation ignores comments", async () => {
  const compilation = await compileBrainfuckSource(
    brainfuckRuntime(),
    "three plus signs + + + and output .",
  );
  const execution = await runBrainfuckWasm(compilation.wasmBytes);

  deepStrictEqual(execution.output, [3]);
});

Deno.test("Lazuli compiles Brainfuck Hello World with multi-byte WASM section lengths", async () => {
  const helloWorld =
    "++++++++++[>+++++++>++++++++++>+++>+<<<<-]>++.>+.+++++++..+++.>++.<<+++++++++++++++.>.+++.------.--------.>+.>.";
  const compilation = await compileBrainfuckSource(brainfuckRuntime(), helloWorld);
  const execution = await runBrainfuckWasm(compilation.wasmBytes);

  equal(new TextDecoder().decode(Uint8Array.from(execution.output)), "Hello World!\n");
  equal(compilation.wasmBytes.byteLength > 127, true);
});

Deno.test("Lazuli Brainfuck compilation rejects unmatched loops", async () => {
  await rejects(
    () => compileBrainfuckSource(brainfuckRuntime(), "++[>+"),
    /error: unmatched \[/,
  );
  await rejects(
    () => compileBrainfuckSource(brainfuckRuntime(), "++]+"),
    /error: unmatched \]/,
  );
});

function brainfuckRuntime(): LazuliBrainfuckRuntime {
  if (runtime === undefined) throw new Error("Lazuli Brainfuck runtime was not initialized");
  return runtime;
}
