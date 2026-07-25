/**
 * gpufuck against the Gleam compiler on the same input.
 *
 * The corpus is gleam-lang/stdlib's nineteen source modules, which both compilers accept. Phases
 * are reported separately because the two do not do the same work and a single wall-clock number
 * would imply they do:
 *
 *   - Gleam parses, typechecks, and emits JavaScript to disk.
 *   - gpufuck parses, lowers to the portable surface, then resolves names and runs Hindley-Milner
 *     on the GPU. Emitting WebAssembly is a separate phase, reported separately.
 *
 * So `parse + lower + GPU` is the honest comparison against `gleam build`, and it still flatters
 * gpufuck: it writes nothing to disk and its Gleam frontend covers a subset of the language.
 *
 * Usage: deno task bench:gleam-stdlib <stdlib-checkout>
 */
import { compileModuleToWasm, GpuCompiler, requestWebGpuDevice } from "../functional.ts";
import { type GleamSourceModule, lowerGleamSources } from "../gleam.ts";
import { parseGleamModule } from "../src/gleam/parser.ts";
// The CPU oracle the shader is differentially tested against: same Hindley-Milner, same input, so
// the ratio isolates the GPU rather than comparing two different algorithms.
import { inferTypes } from "../src/semantic/type_inference.ts";

const MODULES = [
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

/** GPU batch timings spread run to run; compare medians, not single samples. */
const REPETITIONS = 9;

const checkout = Deno.args[0];
if (checkout === undefined) {
  console.error("usage: gleam_stdlib_compile_bench.ts <stdlib-checkout> <entry.gleam>");
  Deno.exit(2);
}

const sources: GleamSourceModule[] = await Promise.all(
  MODULES.map(async (name) => ({
    name: `gleam/${name}`,
    source: await Deno.readTextFile(`${checkout}/src/gleam/${name}.gleam`),
  })),
);
// Lowering prunes to what the entry reaches, so a small `main` would leave gpufuck compiling a
// handful of nodes while `gleam build` compiles all nineteen modules. The entry therefore binds
// every public function in the corpus, which roots the whole library as reachable. Without this
// the comparison measures nothing: an earlier version of this benchmark lowered 241 KB of Gleam to
// 66 surface nodes.
const entryPath = Deno.args[1];
if (entryPath === undefined) {
  console.error("usage: gleam_stdlib_compile_bench.ts <stdlib-checkout> <all-exports-entry.gleam>");
  Deno.exit(2);
}
const entry: GleamSourceModule = {
  name: "stdlib_entry",
  source: await Deno.readTextFile(entryPath),
};
const all = [...sources, entry];

const sourceBytes = all.reduce(
  (total, module) => total + new TextEncoder().encode(module.source).byteLength,
  0,
);

async function median(run: () => Promise<void> | void): Promise<number> {
  const samples: number[] = [];
  for (let index = 0; index < REPETITIONS; index++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)]!;
}

const device = await requestWebGpuDevice();
const compiler = await GpuCompiler.create(device);

try {
  // Parsing alone, to separate the frontend from everything downstream of it.
  const parseMilliseconds = await median(() => {
    for (const module of all) parseGleamModule(module.name, module.source);
  });

  // Lowering includes parsing, so the lowering-only cost is the difference.
  const lowerMilliseconds = await median(() => {
    const frontend = lowerGleamSources(all, { module: entry.name, exportName: "main" });
    if (!frontend.ok) throw new Error(`lowering failed: ${frontend.diagnostics[0]?.message}`);
  });

  const frontend = lowerGleamSources(all, { module: entry.name, exportName: "main" });
  if (!frontend.ok) throw new Error(`lowering failed: ${frontend.diagnostics[0]?.message}`);

  const gpuMilliseconds = await median(async () => {
    const compilation = await compiler.compileModule(frontend.lowered.module, {
      maximumSteps: 10_000_000,
    });
    if (!compilation.ok) {
      throw new Error(`GPU compilation failed: ${compilation.diagnostics[0]?.code}`);
    }
    compilation.module.destroy();
  });

  // `compileModuleToWasm` memoizes per module, so a median over repeats would time a cache hit --
  // an earlier version of this benchmark reported 0.8 ms for what actually costs ~500 ms. Each
  // sample therefore gets a freshly compiled module.
  let wasmBytes = 0;
  const wasmSamples: number[] = [];
  for (let index = 0; index < REPETITIONS; index++) {
    const fresh = await compiler.compileModule(frontend.lowered.module, {
      maximumSteps: 10_000_000,
    });
    if (!fresh.ok) throw new Error("GPU compilation failed");
    const started = performance.now();
    wasmBytes = (await compileModuleToWasm(fresh.module)).byteLength;
    wasmSamples.push(performance.now() - started);
    fresh.module.destroy();
  }
  wasmSamples.sort((left, right) => left - right);
  const wasmMilliseconds = wasmSamples[Math.floor(wasmSamples.length / 2)]!;

  const cpuInferenceMilliseconds = await median(() => {
    const inferred = inferTypes(frontend.lowered.module);
    if (!inferred.ok) {
      throw new Error(`CPU inference failed: ${JSON.stringify(inferred.diagnostic)}`);
    }
  });

  const frontendTotal = lowerMilliseconds;
  const comparable = frontendTotal + gpuMilliseconds;

  console.log(JSON.stringify(
    {
      modules: all.length,
      sourceKilobytes: Number((sourceBytes / 1024).toFixed(1)),
      surfaceNodes: frontend.lowered.module.nodeCount,
      repetitions: REPETITIONS,
      medianMilliseconds: {
        parse: Number(parseMilliseconds.toFixed(1)),
        parseAndLower: Number(lowerMilliseconds.toFixed(1)),
        gpuResolveAndInfer: Number(gpuMilliseconds.toFixed(1)),
        cpuHindleyMilnerOracle: Number(cpuInferenceMilliseconds.toFixed(1)),
        comparableToGleamBuild: Number(comparable.toFixed(1)),
        emitWasm: Number(wasmMilliseconds.toFixed(1)),
      },
      wasmKilobytes: Number((wasmBytes / 1024).toFixed(1)),
      gpuSlowerThanCpuOracle: Number((gpuMilliseconds / cpuInferenceMilliseconds).toFixed(1)),
      microsecondsPerSourceByte: Number(((comparable * 1000) / sourceBytes).toFixed(3)),
    },
    null,
    2,
  ));
} finally {
  device.destroy();
}
