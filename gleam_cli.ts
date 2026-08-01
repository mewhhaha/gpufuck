import { GpuCompiler, requestWebGpuDevice, runWasmModule } from "./functional.ts";
import { type GleamSourceModule, lowerGleamSources, renderGleamTrace } from "./gleam.ts";

type GleamCommand = "run" | "trace";
type CliOutput = Pick<Console, "error" | "log">;

export async function main(
  arguments_: readonly string[],
  output: CliOutput = console,
): Promise<number> {
  const command = arguments_[0];
  const entryModule = arguments_[1];
  if (!isCommand(command) || entryModule === undefined) {
    printUsage(output);
    return 2;
  }
  const tracePath = command === "trace" ? arguments_[2] : undefined;
  const sourceArguments = arguments_.slice(command === "trace" ? 3 : 2);
  if ((command === "trace" && tracePath === undefined) || sourceArguments.length === 0) {
    printUsage(output);
    return 2;
  }

  const sources = await Promise.all(
    sourceArguments.map((argument) => readModuleSource(argument, entryModule)),
  );
  const frontend = lowerGleamSources(sources, {
    module: entryModule,
    exportName: "main",
  });
  if (!frontend.ok) {
    for (const diagnostic of frontend.diagnostics) {
      output.error(
        `error[${diagnostic.code}] ${diagnostic.module} bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
      );
    }
    return 1;
  }

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuCompiler.create(device);
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
      const evaluation = await runWasmModule(compilation.module);
      if (command === "run") {
        output.log(JSON.stringify(
          {
            entryType: compilation.module.entryType,
            value: evaluation.value,
            stats: evaluation.stats,
          },
          // Gleam Int lowers to i64, so values arrive as BigInt, which JSON cannot serialize.
          (_key, value) => typeof value === "bigint" ? value.toString() : value,
          2,
        ));
        return 0;
      }

      const source = sources.map((module) => `// ${module.name}\n${module.source.trimEnd()}`).join(
        "\n\n",
      );
      const trace = renderGleamTrace({
        title: `Gleam functional compilation trace: ${entryModule}`,
        source,
        lowered: frontend.lowered,
        compiledModule: compilation.module,
        coreNodes: await compilation.module.readCoreNodes(),
        evaluation,
      });
      await writeTrace(tracePath!, trace);
      return 0;
    } finally {
      compilation.module.destroy();
    }
  } finally {
    device.destroy();
  }
}

async function readModuleSource(
  argument: string,
  entryModule: string,
): Promise<GleamSourceModule> {
  const separator = argument.indexOf("=");
  const name = separator === -1 ? entryModule : argument.slice(0, separator);
  const path = separator === -1 ? argument : argument.slice(separator + 1);
  if (name.length === 0 || path.length === 0) {
    throw new Error(
      `invalid Gleam module argument ${JSON.stringify(argument)}; expected name=path`,
    );
  }
  try {
    return { name, source: await Deno.readTextFile(path) };
  } catch (cause) {
    const reason = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(
      `could not read Gleam module ${JSON.stringify(name)} from ${JSON.stringify(path)}${reason}`,
      { cause },
    );
  }
}

async function writeTrace(path: string, trace: string): Promise<void> {
  try {
    await Deno.writeTextFile(path, trace);
  } catch (cause) {
    const reason = cause instanceof Error ? `: ${cause.message}` : "";
    throw new Error(`could not write Gleam functional trace ${JSON.stringify(path)}${reason}`, {
      cause,
    });
  }
}

function printUsage(output: CliOutput): void {
  output.error("usage: gleam_cli.ts run <entry-module> <module=source.gleam>...");
  output.error(
    "       gleam_cli.ts trace <entry-module> <trace.md> <module=source.gleam>...",
  );
}

function isCommand(value: string | undefined): value is GleamCommand {
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
