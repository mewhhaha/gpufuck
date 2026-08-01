/**
 * Runs a Sweep program: parse, lower, compile on the GPU, evaluate.
 *
 * A repository sample, not part of the published package.
 *
 * @module
 */
import { GpuCompiler, requestWebGpuDevice, runWasmModule } from "./functional.ts";
import { compileSweepSource } from "./sweep.ts";

export async function main(
  arguments_: readonly string[],
  output: Pick<Console, "error" | "log"> = console,
): Promise<number> {
  const path = arguments_[0];
  if (path === undefined) {
    output.error("usage: sweep_cli.ts <program.sweep>");
    return 2;
  }
  const source = await Deno.readTextFile(path);
  const lowered = compileSweepSource(path, source);
  if (!lowered.ok) {
    for (const diagnostic of lowered.diagnostics) {
      output.error(
        `error ${path} bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
      );
    }
    return 1;
  }

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuCompiler.create(device);
    const compilation = await compiler.compileModule(lowered.module, { maximumSteps: 10_000_000 });
    if (!compilation.ok) {
      for (const diagnostic of compilation.diagnostics) {
        output.error(
          `error[${diagnostic.code}] bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
        );
      }
      return 1;
    }
    try {
      const execution = await runWasmModule(compilation.module);
      output.log(
        JSON.stringify(
          execution.value,
          (_key, value) => typeof value === "bigint" ? `${value}` : value,
        ),
      );
      return 0;
    } finally {
      compilation.module.destroy();
    }
  } finally {
    device.destroy();
  }
}

if (import.meta.main) Deno.exitCode = await main(Deno.args);
