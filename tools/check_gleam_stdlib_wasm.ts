/**
 * Runs Gleam's own standard-library test suite through the WebAssembly backend.
 *
 * `check_gleam_stdlib.ts` proves the corpus *compiles*; it stops at resolved Core and never
 * executes. That measures the frontend and the GPU semantic phases, but says nothing about whether
 * the code generator emits a correct program. This tool closes that gap by using upstream's own
 * assertions as the oracle: a stdlib test is `assert <expr> == <expr>`, which lowers to an explicit
 * fault, so a batch that runs to completion is a batch whose every assertion held.
 *
 * Failures are classified rather than thrown, because the useful output is a breakdown of what is
 * not yet supported, not the first thing that broke.
 *
 * Usage: deno task check:gleam-stdlib-wasm <checkout> [module ...]
 */
import {
  compileModuleToWasm,
  GpuCompiler,
  requestWebGpuDevice,
  runWasmModule,
} from "../functional.ts";
import { type GleamSourceModule, lowerGleamSources } from "../gleam.ts";
import { parseGleamModule } from "../src/gleam/parser.ts";

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

/** One test per module, so a failure names the function rather than a batch of eight. */
/**
 * `host` is not a failure: the module compiled and emitted, but declares Gleam's JavaScript FFI
 * (`@external(javascript, "../gleam_stdlib.mjs", ...)`) as a host capability that this harness
 * supplies no implementation for. Counting those as failures would understate the backend and
 * hide the one number that matters -- how much of the corpus needs no runtime adapter at all.
 */
type Stage = "parse" | "lower" | "compile" | "emit" | "run" | "host";

interface Failure {
  readonly module: string;
  readonly test: string;
  readonly stage: Stage;
  readonly detail: string;
}

const checkout = Deno.args[0];
if (checkout === undefined) {
  console.error("usage: check_gleam_stdlib_wasm.ts <stdlib-checkout> [module ...]");
  Deno.exit(2);
}
const moduleFilter = new Set(Deno.args.slice(1));

const revision = new TextDecoder()
  .decode(
    (await new Deno.Command("git", { args: ["-C", checkout, "rev-parse", "HEAD"] }).output())
      .stdout,
  )
  .trim();
if (revision !== GLEAM_STDLIB_COMMIT) {
  throw new Error(`stdlib checkout is at ${revision}; expected ${GLEAM_STDLIB_COMMIT}`);
}

const stdlibSources: GleamSourceModule[] = await Promise.all(
  GLEAM_STDLIB_MODULES.map(async (name) => ({
    name: `gleam/${name}`,
    source: await Deno.readTextFile(`${checkout}/src/gleam/${name}.gleam`),
  })),
);

const device = await requestWebGpuDevice();
const compiler = await GpuCompiler.create(device);

const failures: Failure[] = [];
const perModule: { module: string; total: number; passed: number }[] = [];
let totalTests = 0;
let totalPassed = 0;
let totalWasmBytes = 0;
const started = performance.now();

try {
  for (const testModule of GLEAM_STDLIB_TEST_MODULES) {
    if (moduleFilter.size > 0 && !moduleFilter.has(testModule)) continue;
    const source = await Deno.readTextFile(`${checkout}/test/gleam/${testModule}.gleam`);
    const testSource: GleamSourceModule = { name: `gleam/${testModule}`, source };
    // `parseGleamModule` throws instead of returning diagnostics, and one unparseable module
    // would otherwise end the run and report nothing about the other seventeen.
    let tests: string[];
    try {
      const parsed = parseGleamModule(testSource.name, source);
      tests = parsed.declarations.flatMap((declaration) =>
        declaration.kind === "function" && declaration.public && declaration.name.endsWith("_test")
          ? [declaration.name]
          : []
      );
    } catch (error) {
      failures.push({
        module: testSource.name,
        test: "<module>",
        stage: "parse",
        detail: describe(error),
      });
      console.error(`${testModule}: PARSE FAILED ${describe(error)}`);
      continue;
    }

    let passed = 0;
    for (const test of tests) {
      const result = await runOne(testSource, test);
      if (result === undefined) passed++;
      else failures.push(result);
    }
    totalTests += tests.length;
    totalPassed += passed;
    perModule.push({ module: testModule, total: tests.length, passed });
    console.error(`${testModule}: ${passed}/${tests.length}`);
  }
} finally {
  device.destroy();
}

const byStage = new Map<Stage, number>();
for (const failure of failures) byStage.set(failure.stage, (byStage.get(failure.stage) ?? 0) + 1);

console.log(JSON.stringify(
  {
    gleamStdlibCommit: revision,
    totalTests,
    totalPassed,
    passRate: totalTests === 0 ? 0 : Number((totalPassed / totalTests).toFixed(4)),
    failuresByStage: Object.fromEntries(byStage),
    totalWasmKilobytes: Number((totalWasmBytes / 1024).toFixed(1)),
    wallClockSeconds: Number(((performance.now() - started) / 1000).toFixed(1)),
    perModule,
    failures,
  },
  null,
  2,
));

async function runOne(
  testSource: GleamSourceModule,
  test: string,
): Promise<Failure | undefined> {
  const module = testSource.name;
  const harness: GleamSourceModule = {
    name: "stdlib_wasm_check",
    source: `import ${module} as subject\n\npub fn main() -> Int {\n  subject.${test}()\n  1\n}\n`,
  };
  // The Gleam frontend reports some failures as diagnostics and throws others -- surface packing
  // and module linking raise. Both are "this program is not supported yet" here, so both are
  // classified rather than allowed to end the run.
  let frontend: ReturnType<typeof lowerGleamSources>;
  try {
    frontend = lowerGleamSources([...stdlibSources, testSource, harness], {
      module: harness.name,
      exportName: "main",
    });
  } catch (error) {
    return { module, test, stage: "lower", detail: describe(error) };
  }
  if (!frontend.ok) {
    const diagnostic = frontend.diagnostics[0]!;
    return { module, test, stage: "lower", detail: `${diagnostic.code}: ${diagnostic.message}` };
  }

  let compilation: Awaited<ReturnType<typeof compiler.compileModule>>;
  try {
    compilation = await compiler.compileModule(frontend.lowered.module, {
      maximumSteps: 10_000_000,
    });
  } catch (error) {
    return { module, test, stage: "compile", detail: describe(error) };
  }
  if (!compilation.ok) {
    const diagnostic = compilation.diagnostics[0]!;
    return { module, test, stage: "compile", detail: `${diagnostic.code}: ${diagnostic.message}` };
  }

  try {
    let bytes: Uint8Array;
    try {
      bytes = await compileModuleToWasm(compilation.module);
    } catch (error) {
      return { module, test, stage: "emit", detail: describe(error) };
    }
    totalWasmBytes += bytes.byteLength;

    // `runWasmModule` throws rather than returning a result union, so a failed Gleam `assert`
    // arrives here as a trap. That is the oracle: reaching the end means every assertion held.
    try {
      await runWasmModule(compilation.module);
      return undefined;
    } catch (error) {
      const detail = describe(error);
      const capabilities = compilation.module.hostCapabilities ?? [];
      const stage = detail.includes("F4102") ? "host" : "run";
      return {
        module,
        test,
        stage,
        detail: stage === "host"
          ? capabilities.map((capability) => capability.name).join(", ")
          : detail,
      };
    }
  } finally {
    compilation.module.destroy();
  }
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.name}: ${error.message.slice(0, 200)}`;
}
