import {
  FunctionalWasmRuntimeError,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../functional.ts";
import {
  type GleamFunctionalSourceModule,
  lowerGleamFunctionalSources,
} from "../gleam_functional.ts";
import { parseGleamFunctionalModule } from "../src/gleam_functional/parser.ts";

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
const GLEAM_STDLIB_TEST_MODULES = [
  "bit_array_test",
  "bool_test",
  "bytes_tree_test",
  "dict_test",
  "dynamic_test",
  "dynamic/decode_test",
  "float_test",
  "function_test",
  "int_test",
  "list_test",
  "option_test",
  "order_test",
  "pair_test",
  "result_test",
  "set_test",
  "string_test",
  "string_tree_test",
  "uri_test",
] as const;
const TEST_COMPILATION_BATCH_SIZE = 8;

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

  const stdlibSources: GleamFunctionalSourceModule[] = await Promise.all(
    GLEAM_STDLIB_MODULES.map(async (name) => ({
      name: `gleam/${name}`,
      source: await Deno.readTextFile(`${checkout}/src/gleam/${name}.gleam`),
    })),
  );
  const testSources: GleamFunctionalSourceModule[] = await Promise.all(
    GLEAM_STDLIB_TEST_MODULES.map(async (name) => ({
      name: `gleam/${name}`,
      source: await Deno.readTextFile(`${checkout}/test/gleam/${name}.gleam`),
    })),
  );
  const sources = [...stdlibSources, { name: "stdlib_check", source: stdlibCheckSource() }];

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
    const testCompilation = await compileStdlibTests(compiler, stdlibSources, testSources);
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
          testModuleCount: testSources.length,
          testFunctionCount: testCompilation.functionCount,
          executedCoreTestFunctionCount: testCompilation.executedFunctionCount,
          testCompilationBatchCount: testCompilation.batchCount,
          largestTestBatchNodeCount: testCompilation.largestNodeCount,
          gpuTestCompilationMilliseconds: testCompilation.milliseconds,
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

async function compileStdlibTests(
  compiler: GpuFunctionalCompiler,
  stdlibSources: readonly GleamFunctionalSourceModule[],
  testSources: readonly GleamFunctionalSourceModule[],
): Promise<{
  readonly functionCount: number;
  readonly executedFunctionCount: number;
  readonly batchCount: number;
  readonly largestNodeCount: number;
  readonly milliseconds: number;
}> {
  const started = performance.now();
  let functionCount = 0;
  let executedFunctionCount = 0;
  let batchCount = 0;
  let largestNodeCount = 0;
  for (const testSource of testSources) {
    console.error(`Checking ${testSource.name}...`);
    const parsed = parseGleamFunctionalModule(testSource.name, testSource.source);
    const testFunctions = parsed.declarations.flatMap((declaration) =>
      declaration.kind === "function" && declaration.public &&
        declaration.name.endsWith("_test")
        ? [declaration.name]
        : []
    );
    functionCount += testFunctions.length;
    for (let offset = 0; offset < testFunctions.length; offset += TEST_COMPILATION_BATCH_SIZE) {
      const batch = testFunctions.slice(offset, offset + TEST_COMPILATION_BATCH_SIZE);
      const harness: GleamFunctionalSourceModule = {
        name: "stdlib_test_check",
        source: stdlibTestCheckSource(testSource.name, batch),
      };
      const frontend = lowerGleamFunctionalSources(
        [...stdlibSources, testSource, harness],
        { module: harness.name, exportName: "main" },
      );
      if (!frontend.ok) {
        const diagnostic = frontend.diagnostics[0];
        throw new Error(
          `Gleam stdlib test batch ${testSource.name} ${offset}..${offset + batch.length} ` +
            `failed for ${diagnostic.module} at bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ` +
            `${diagnostic.code}: ${diagnostic.message}`,
        );
      }
      largestNodeCount = Math.max(largestNodeCount, frontend.lowered.module.nodeCount);
      const compilation = await compiler.compileModule(frontend.lowered.module, {
        maximumSteps: 10_000_000,
      });
      if (!compilation.ok) {
        throw new Error(
          `Gleam stdlib GPU test compilation ${testSource.name} ${offset}..${
            offset + batch.length
          } failed: ${JSON.stringify(compilation.diagnostics[0])}`,
        );
      }
      try {
        if (compilation.module.hostCapabilities.length === 0) {
          let execution: Awaited<ReturnType<typeof runFunctionalWasmModule>> | null = null;
          try {
            execution = await runFunctionalWasmModule(compilation.module);
          } catch (error) {
            const needsRuntimeAdapter = error instanceof FunctionalWasmRuntimeError &&
              error.kind === "explicit-fault" &&
              error.message.includes("unbound Gleam external");
            if (!needsRuntimeAdapter) {
              throw new Error(
                `Gleam stdlib test execution ${testSource.name} ${offset}..${
                  offset + batch.length
                } failed`,
                { cause: error },
              );
            }
          }
          if (
            execution !== null &&
            (execution.value.kind !== "integer" || execution.value.value !== batch.length)
          ) {
            throw new Error(
              `Gleam stdlib test execution ${testSource.name} ${offset}..${
                offset + batch.length
              } returned ${JSON.stringify(execution.value)}; expected integer ${batch.length}`,
            );
          }
          if (execution !== null) executedFunctionCount += batch.length;
        }
      } finally {
        compilation.module.destroy();
      }
      batchCount++;
    }
  }
  return {
    functionCount,
    executedFunctionCount,
    batchCount,
    largestNodeCount,
    milliseconds: performance.now() - started,
  };
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

function stdlibTestCheckSource(
  module: string,
  testFunctions: readonly string[],
): string {
  return `import ${module} as subject

pub fn main() -> Int {
${testFunctions.map((name) => `  subject.${name}()`).join("\n")}
  ${testFunctions.length}
}
`;
}
