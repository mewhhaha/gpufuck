import {
  GpuLazuliCompiler,
  GpuLazuliEvaluator,
  LAZULI_ABI_VERSION,
  requestWebGpuDevice,
} from "./mod.ts";

type LazuliCommand = "compile" | "run";

async function main(arguments_: readonly string[]): Promise<number> {
  const command = arguments_[0];
  const sourcePath = arguments_[1];
  if (!isLazuliCommand(command) || sourcePath === undefined || arguments_.length !== 2) {
    console.error("usage: lazuli_cli.ts <compile|run> <source.lz>");
    return 2;
  }

  let source: string;
  try {
    source = await Deno.readTextFile(sourcePath);
  } catch (cause) {
    const reason = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(`could not read Lazuli source ${JSON.stringify(sourcePath)}${reason}`, {
      cause,
    });
  }

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuLazuliCompiler.create(device);
    const compilation = await compiler.compile(source);
    if (!compilation.ok) {
      for (const diagnostic of compilation.diagnostics) {
        console.error(
          `error[${diagnostic.code}] bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
        );
      }
      return 1;
    }

    try {
      if (command === "compile") {
        const nodes = await compilation.module.readCoreNodes();
        console.log(JSON.stringify(
          {
            abiVersion: LAZULI_ABI_VERSION,
            nodeCount: compilation.module.nodeCount,
            definitionCount: compilation.module.definitionCount,
            typeCount: compilation.module.typeCount,
            constructorCount: compilation.module.constructorCount,
            constructors: compilation.module.constructorNames.map((name, index) => ({
              name,
              arity: compilation.module.constructorArities[index],
            })),
            entryDefinition: compilation.module.entryDefinition,
            nodes,
          },
          null,
          2,
        ));
        return 0;
      }

      const evaluator = await GpuLazuliEvaluator.create(device);
      const evaluation = await evaluator.evaluate(compilation.module);
      if (!evaluation.ok) {
        const location = evaluation.fault.sourceByteOffset === null
          ? "unknown source"
          : `byte ${evaluation.fault.sourceByteOffset}`;
        console.error(
          `runtime[${evaluation.fault.code}] ${location}: ${evaluation.fault.message}`,
        );
        return 1;
      }

      console.log(JSON.stringify(
        {
          value: evaluation.value,
          stats: evaluation.stats,
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

function isLazuliCommand(value: string | undefined): value is LazuliCommand {
  return value === "compile" || value === "run";
}

if (import.meta.main) {
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`error: ${message}`);
    Deno.exitCode = 1;
  }
}
