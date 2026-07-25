import { GpuCompiler, requestWebGpuDevice } from "../functional.ts";
import { type GleamSourceModule, lowerGleamSources } from "../gleam.ts";
import { parseGleamModule } from "../src/gleam/parser.ts";

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

  const stdlibSources: GleamSourceModule[] = await Promise.all(
    GLEAM_STDLIB_MODULES.map(async (name) => ({
      name: `gleam/${name}`,
      source: await Deno.readTextFile(`${checkout}/src/gleam/${name}.gleam`),
    })),
  );
  const testSources: GleamSourceModule[] = await Promise.all(
    GLEAM_STDLIB_TEST_MODULES.map(async (name) => ({
      name: `gleam/${name}`,
      source: await Deno.readTextFile(`${checkout}/test/gleam/${name}.gleam`),
    })),
  );
  const sources = [...stdlibSources, { name: "stdlib_check", source: stdlibCheckSource() }];

  const loweringStart = performance.now();
  const frontend = lowerGleamSources(sources, {
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
    const compiler = await GpuCompiler.create(device);
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
    compilation.module.destroy();
    console.log(JSON.stringify(
      {
        gleamStdlibCommit: actualCommit,
        modules: GLEAM_STDLIB_MODULES,
        sourceModuleCount: sources.length,
        testModuleCount: testSources.length,
        testFunctionCount: testCompilation.functionCount,
        testCompilationBatchCount: testCompilation.batchCount,
        largestTestBatchNodeCount: testCompilation.largestNodeCount,
        gpuTestCompilationMilliseconds: testCompilation.milliseconds,
        functionalNodeCount: frontend.lowered.module.nodeCount,
        loweringMilliseconds,
        gpuCompilationMilliseconds: compilationMilliseconds,
      },
      null,
      2,
    ));
  } finally {
    device.destroy();
  }
} finally {
  if (temporaryRoot !== null) await Deno.remove(temporaryRoot, { recursive: true });
}

async function compileStdlibTests(
  compiler: GpuCompiler,
  stdlibSources: readonly GleamSourceModule[],
  testSources: readonly GleamSourceModule[],
): Promise<{
  readonly functionCount: number;
  readonly batchCount: number;
  readonly largestNodeCount: number;
  readonly milliseconds: number;
}> {
  const started = performance.now();
  let functionCount = 0;
  let batchCount = 0;
  let largestNodeCount = 0;
  for (const testSource of testSources) {
    console.error(`Checking ${testSource.name}...`);
    const parsed = parseGleamModule(testSource.name, testSource.source);
    const testFunctions = parsed.declarations.flatMap((declaration) =>
      declaration.kind === "function" && declaration.public &&
        declaration.name.endsWith("_test")
        ? [declaration.name]
        : []
    );
    functionCount += testFunctions.length;
    for (let offset = 0; offset < testFunctions.length; offset += TEST_COMPILATION_BATCH_SIZE) {
      const batch = testFunctions.slice(offset, offset + TEST_COMPILATION_BATCH_SIZE);
      const harness: GleamSourceModule = {
        name: "stdlib_test_check",
        source: stdlibTestCheckSource(testSource.name, batch),
      };
      const frontend = lowerGleamSources(
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
      compilation.module.destroy();
      batchCount++;
    }
  }
  return {
    functionCount,
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
