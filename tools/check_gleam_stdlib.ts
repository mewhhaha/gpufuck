import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../functional.ts";
import {
  type GleamFunctionalSourceModule,
  lowerGleamFunctionalSources,
} from "../gleam_functional.ts";

const GLEAM_STDLIB_REPOSITORY = "https://github.com/gleam-lang/stdlib.git";
const GLEAM_STDLIB_COMMIT = "bacc20c7c857c52dff6bd5ce336d067404884e60";
const GLEAM_STDLIB_MODULES = [
  "bit_array",
  "bool",
  "bytes_tree",
  "dict",
  "dynamic",
  "dynamic/decode",
  "float",
  "function",
  "int",
  "io",
  "list",
  "option",
  "order",
  "pair",
  "result",
  "set",
  "string",
  "string_tree",
  "uri",
] as const;

const suppliedCheckout = Deno.args[0];
const temporaryRoot = suppliedCheckout === undefined
  ? await Deno.makeTempDir({ prefix: "gpufuck-gleam-stdlib-" })
  : null;
const checkout = suppliedCheckout ?? `${temporaryRoot}/stdlib`;

try {
  if (suppliedCheckout === undefined) {
    await runGit(["clone", "--quiet", "--no-checkout", GLEAM_STDLIB_REPOSITORY, checkout]);
    await runGit(["-C", checkout, "checkout", "--quiet", GLEAM_STDLIB_COMMIT]);
  }
  const actualCommit = (await runGit(["-C", checkout, "rev-parse", "HEAD"])).trim();
  if (actualCommit !== GLEAM_STDLIB_COMMIT) {
    throw new Error(
      `Gleam stdlib checkout ${
        JSON.stringify(checkout)
      } is at ${actualCommit}; expected ${GLEAM_STDLIB_COMMIT}`,
    );
  }

  const sources: GleamFunctionalSourceModule[] = await Promise.all(
    GLEAM_STDLIB_MODULES.map(async (name) => ({
      name: `gleam/${name}`,
      source: await Deno.readTextFile(`${checkout}/src/gleam/${name}.gleam`),
    })),
  );
  sources.push({ name: "stdlib_check", source: stdlibCheckSource() });

  const loweringStart = performance.now();
  const frontend = lowerGleamFunctionalSources(sources, {
    module: "stdlib_check",
    exportName: "main",
  });
  const loweringMilliseconds = performance.now() - loweringStart;
  if (!frontend.ok) {
    const diagnostic = frontend.diagnostics[0];
    throw new Error(
      `Gleam stdlib compatibility failed for ${diagnostic.module} at bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.code}: ${diagnostic.message}`,
    );
  }

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuFunctionalCompiler.create(device);
    const compilationStart = performance.now();
    const compilation = await compiler.compileModule(frontend.lowered.module, {
      maximumSteps: 10_000_000,
    });
    const compilationMilliseconds = performance.now() - compilationStart;
    if (!compilation.ok) {
      throw new Error(
        `Gleam stdlib GPU compilation failed: ${JSON.stringify(compilation.diagnostics[0])}`,
      );
    }
    try {
      const init = Object.fromEntries(compilation.module.hostCapabilities.map((capability) => [
        capability.name,
        Object.fromEntries(capability.fields.flatMap((field) => {
          if (
            field.kind === "value"
              ? field.wasmLiteral !== undefined
              : field.wasmIntrinsic !== undefined
          ) {
            return [];
          }
          return [[field.name, () => {
            throw new Error(
              `Gleam stdlib compatibility harness unexpectedly called ${capability.name}.${field.name}`,
            );
          }]];
        })),
      ]));
      const execution = await runFunctionalWasmModule(compilation.module, { init });
      if (execution.value.kind !== "integer" || execution.value.value !== 42) {
        throw new Error(
          `Gleam stdlib compatibility program returned ${
            JSON.stringify(execution.value)
          }; expected integer 42`,
        );
      }
      console.log(JSON.stringify(
        {
          gleamStdlibCommit: actualCommit,
          modules: GLEAM_STDLIB_MODULES,
          sourceModuleCount: sources.length,
          functionalNodeCount: frontend.lowered.module.nodeCount,
          loweringMilliseconds,
          gpuCompilationMilliseconds: compilationMilliseconds,
          wasmByteLength: execution.bytes.byteLength,
          value: execution.value,
        },
        null,
        2,
      ));
    } finally {
      compilation.module.destroy();
    }
  } finally {
    device.destroy();
  }
} finally {
  if (temporaryRoot !== null) await Deno.remove(temporaryRoot, { recursive: true });
}

async function runGit(arguments_: readonly string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [...arguments_],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.success) return new TextDecoder().decode(output.stdout);
  throw new Error(
    `git ${arguments_.join(" ")} failed with exit code ${output.code}: ${
      new TextDecoder().decode(output.stderr).trim()
    }`,
  );
}

function stdlibCheckSource(): string {
  return `import gleam/bool
import gleam/function
import gleam/order
import gleam/pair

pub fn main() -> Int {
  let #(left, right) = pair.swap(#(20, 22))
  case bool.and(
    function.identity(True),
    order.compare(order.Eq, with: order.Eq) == order.Eq,
  ) {
    True -> left + right
    False -> 0
  }
}
`;
}
