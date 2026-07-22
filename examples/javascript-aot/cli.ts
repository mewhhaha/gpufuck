import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../../functional.ts";
import { lowerJavaScriptAotSource } from "./mod.ts";

type CliOutput = Pick<Console, "error" | "log">;

export async function main(
  arguments_: readonly string[],
  output: CliOutput = console,
): Promise<number> {
  const sourcePath = arguments_[0];
  if (sourcePath === undefined || arguments_.length !== 1) {
    output.error("usage: examples/javascript-aot/cli.ts <source.mjs>");
    return 2;
  }

  const source = await readSource(sourcePath);
  const frontend = lowerJavaScriptAotSource(fileName(sourcePath), source);
  if (!frontend.ok) {
    for (const diagnostic of frontend.diagnostics) {
      output.error(
        `error[${diagnostic.code}] bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
      );
    }
    return 1;
  }

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuFunctionalCompiler.create(device);
    const compilation = await compiler.compileModule(frontend.lowered.module);
    if (!compilation.ok) {
      for (const diagnostic of compilation.diagnostics) {
        output.error(
          `error[${diagnostic.code}] bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
        );
      }
      return 1;
    }
    try {
      const execution = await runFunctionalWasmModule(compilation.module);
      output.log(JSON.stringify(
        {
          entryType: compilation.module.entryType,
          value: execution.value,
          stats: execution.stats,
          wasmByteLength: execution.bytes.byteLength,
        },
        null,
        2,
      ));
      return 0;
    } finally {
      compilation.module.destroy();
    }
  } finally {
    device.destroy();
  }
}

async function readSource(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (cause) {
    const reason = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(`could not read JavaScript source ${JSON.stringify(path)}${reason}`, {
      cause,
    });
  }
}

function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

if (import.meta.main) {
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (cause) {
    console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
    Deno.exitCode = 1;
  }
}
