import {
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "./functional.ts";
import {
  lowerHaskellFunctionalSource,
  renderHaskellFunctionalTrace,
} from "./haskell_functional.ts";

type HaskellFunctionalCommand = "run" | "trace";
type CliOutput = Pick<Console, "error" | "log">;

export async function main(
  arguments_: readonly string[],
  output: CliOutput = console,
): Promise<number> {
  const command = arguments_[0];
  const sourcePath = arguments_[1];
  const tracePath = arguments_[2];
  if (!isCommand(command) || sourcePath === undefined || arguments_.length > 3) {
    output.error("usage: haskell_functional_cli.ts run <source.hs>");
    output.error("       haskell_functional_cli.ts trace <source.hs> [trace.md]");
    return 2;
  }
  if (command === "run" && tracePath !== undefined) {
    output.error("run does not accept an output path");
    return 2;
  }

  const source = await readSource(sourcePath);
  const frontend = lowerHaskellFunctionalSource(source);
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
      if (command === "run") {
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
      }

      const evaluator = await GpuFunctionalEvaluator.create(device);
      const evaluation = await evaluator.evaluate(compilation.module);
      const trace = renderHaskellFunctionalTrace({
        title: `Haskell functional compilation trace: ${fileName(sourcePath)}`,
        source,
        lowered: frontend.lowered,
        compiledModule: compilation.module,
        coreNodes: await compilation.module.readCoreNodes(),
        evaluation,
      });
      if (tracePath === undefined) output.log(trace);
      else await writeTrace(tracePath, trace);
      return evaluation.ok ? 0 : 1;
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
    throw new Error(`could not read Haskell functional source ${JSON.stringify(path)}${reason}`, {
      cause,
    });
  }
}

async function writeTrace(path: string, trace: string): Promise<void> {
  try {
    await Deno.writeTextFile(path, trace);
  } catch (cause) {
    const reason = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(`could not write Haskell functional trace ${JSON.stringify(path)}${reason}`, {
      cause,
    });
  }
}

function fileName(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function isCommand(value: string | undefined): value is HaskellFunctionalCommand {
  return value === "run" || value === "trace";
}

if (import.meta.main) {
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (cause) {
    console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
    Deno.exitCode = 1;
  }
}
