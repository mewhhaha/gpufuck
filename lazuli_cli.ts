import {
  GpuLazuliCompiler,
  GpuLazuliEvaluator,
  type GpuLazuliModule,
  LAZULI_ABI_VERSION,
  requestWebGpuDevice,
} from "./mod.ts";

type LazuliCommand = "compile" | "run" | "run-batch";
type CliOutput = Pick<Console, "error" | "log">;

export async function main(
  arguments_: readonly string[],
  output: CliOutput = console,
): Promise<number> {
  const command = arguments_[0];
  const sourcePaths = arguments_.slice(1);
  if (
    !isLazuliCommand(command) || sourcePaths.length === 0 ||
    (command !== "run-batch" && sourcePaths.length !== 1)
  ) {
    output.error("usage: lazuli_cli.ts <compile|run> <source.laz>");
    output.error("       lazuli_cli.ts run-batch <first.laz> <second.laz> [...]");
    return 2;
  }

  if (command === "run-batch") return await runBatch(sourcePaths, output);

  const sourcePath = sourcePaths[0];
  if (sourcePath === undefined) throw new Error("missing Lazuli source path");

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
        output.error(
          `error[${diagnostic.code}] bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
        );
      }
      return 1;
    }

    try {
      if (command === "compile") {
        const nodes = await compilation.module.readCoreNodes();
        output.log(JSON.stringify(
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
        output.error(
          `runtime[${evaluation.fault.code}] ${location}: ${evaluation.fault.message}`,
        );
        return 1;
      }

      output.log(JSON.stringify(
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

async function runBatch(
  sourcePaths: readonly string[],
  output: CliOutput,
): Promise<number> {
  const sources: string[] = [];
  for (const sourcePath of sourcePaths) {
    try {
      sources.push(await Deno.readTextFile(sourcePath));
    } catch (cause) {
      const reason = cause instanceof Error ? `: ${cause.message}` : "";
      throw new Error(`could not read Lazuli source ${JSON.stringify(sourcePath)}${reason}`, {
        cause,
      });
    }
  }

  const device = await requestWebGpuDevice();
  const modules: GpuLazuliModule[] = [];
  try {
    const compiler = await GpuLazuliCompiler.create(device);
    const compilationOutcomes = await Promise.allSettled(
      sources.map((source) => compiler.compile(source)),
    );
    for (const outcome of compilationOutcomes) {
      if (outcome.status === "fulfilled" && outcome.value.ok) {
        modules.push(outcome.value.module);
      }
    }

    let hasCompilationFailure = false;
    for (let index = 0; index < compilationOutcomes.length; index += 1) {
      const outcome = compilationOutcomes[index];
      const sourcePath = sourcePaths[index];
      if (outcome === undefined || sourcePath === undefined) {
        throw new Error(`batch source ${index} is missing`);
      }

      if (outcome.status === "rejected") throw outcome.reason;
      if (outcome.value.ok) continue;

      hasCompilationFailure = true;
      for (const diagnostic of outcome.value.diagnostics) {
        const displayPath = JSON.stringify(sourcePath);
        output.error(
          `${displayPath}: error[${diagnostic.code}] bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
        );
      }
    }

    if (hasCompilationFailure) return 1;

    const evaluator = await GpuLazuliEvaluator.create(device);
    const evaluations = await evaluator.evaluateBatch(modules);
    if (evaluations.length !== sourcePaths.length) {
      throw new Error(
        `Lazuli batch evaluator returned ${evaluations.length} results for ${sourcePaths.length} sources`,
      );
    }

    output.log(JSON.stringify(
      evaluations.map((evaluation, index) => {
        const sourcePath = sourcePaths[index];
        if (sourcePath === undefined) {
          throw new Error(`Lazuli batch source ${index} is missing`);
        }
        return { path: sourcePath, ...evaluation };
      }),
      null,
      2,
    ));
    return evaluations.some((evaluation) => !evaluation.ok) ? 1 : 0;
  } finally {
    for (const module of modules) module.destroy();
    device.destroy();
  }
}

function isLazuliCommand(value: string | undefined): value is LazuliCommand {
  return value === "compile" || value === "run" || value === "run-batch";
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
