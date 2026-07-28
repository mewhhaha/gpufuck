import { WebGpuRuntime } from "@mewhhaha/baba/runtime/webgpu";

import { BabaGpuLazuliCompiler } from "../src/lazuli/baba_gpu_compiler.ts";
import { GpuLazuliCompiler } from "../src/lazuli/compiler.ts";

const planBytes = await Deno.readFile(
  new URL("../language/lazuli/generated/wasm/parser.plan", import.meta.url),
);
const runtime = await WebGpuRuntime.create({ powerPreference: "high-performance" });
const babaCompiler = await BabaGpuLazuliCompiler.create(runtime, planBytes);
const referenceCompiler = await GpuLazuliCompiler.create(runtime.device);
globalThis.addEventListener("unload", () => runtime.dispose(), { once: true });

for (const declarationCount of [64, 512, 2_048] as const) {
  const source = wideLazuliSource(declarationCount);

  Deno.bench({
    name: `compile ${declarationCount} Lazuli declarations with Wasm frontend`,
    async fn(context) {
      context.start();
      const compilation = await referenceCompiler.compile(source);
      context.end();
      if (!compilation.ok) {
        throw new Error(
          `Wasm frontend rejected ${declarationCount} declarations: ` +
            compilation.diagnostics[0].message,
        );
      }
      compilation.module.destroy();
    },
  });

  Deno.bench({
    name: `compile ${declarationCount} Lazuli declarations with Baba GPU frontend`,
    async fn(context) {
      context.start();
      const compilation = await babaCompiler.compile(source);
      context.end();
      if (!compilation.result.ok) {
        throw new Error(
          `Baba GPU frontend rejected ${declarationCount} declarations: ` +
            compilation.result.diagnostics[0].message,
        );
      }
      compilation.result.module.destroy();
    },
  });
}

function wideLazuliSource(declarationCount: number): string {
  return [
    ...Array.from(
      { length: declarationCount },
      (_, index) => `fn value${index} = ${index};`,
    ),
    `fn main = value${declarationCount - 1};`,
  ].join("\n");
}
