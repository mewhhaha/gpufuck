/**
 * gpufuck against the Gleam compiler on the same input.
 *
 * The corpus is the nineteen gleam-lang/stdlib source modules this frontend accepts plus the
 * generated entry that keeps every public function reachable. Both compilers receive those same
 * twenty sources in a fresh package and emit executable output:
 *
 *   - Gleam parses, typechecks, and emits JavaScript to disk.
 *   - gpufuck parses, lowers, resolves names, typechecks, and emits WebAssembly in memory.
 *
 * Phases remain separate so CPU and GPU semantic compilation and uncached WebAssembly emission can
 * be compared without hiding work in process-wide artifact caches.
 *
 * Usage: deno task bench:gleam-stdlib <stdlib-checkout>
 */
import {
  compileModuleToWasm,
  CpuCompiler,
  FunctionalCompilerService,
  GpuCompiler,
  requestWebGpuDevice,
} from "../functional.ts";
import { GleamFrontendService, type GleamSourceModule, lowerGleamSources } from "../gleam.ts";
import { compileWasmArtifact } from "../src/functional/wasm_codegen.ts";
import { parseGleamModule } from "../src/gleam/parser.ts";
// The CPU oracle the shader is differentially tested against: same Hindley-Milner, same input, so
// the ratio isolates the GPU rather than comparing two different algorithms.
import { inferTypes } from "../src/semantic/type_inference.ts";
import { allExportsEntry } from "../tools/gleam_stdlib_corpus.ts";

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
  console.error("usage: gleam_stdlib_compile_bench.ts <stdlib-checkout> [entry.gleam]");
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
// The entry is generated rather than required, so the benchmark is reproducible from a checkout
// alone. An explicit path still overrides it, for comparing against a hand-written entry.
const entryPath = Deno.args[1];
const entry: GleamSourceModule = entryPath === undefined
  ? allExportsEntry(sources)
  : { name: "stdlib_entry", source: await Deno.readTextFile(entryPath) };
const all = [...sources, entry];

const sourceBytes = all.reduce(
  (total, module) => total + new TextEncoder().encode(module.source).byteLength,
  0,
);

async function measureGleam(): Promise<{
  readonly cold: number;
  readonly warm: number;
  readonly sourceOnlyEdit: number;
}> {
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "gpufuck-gleam-stdlib-" });
  try {
    await Deno.mkdir(`${root}/src/gleam/dynamic`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/gleam.toml`,
      'name = "gleam_stdlib_benchmark"\nversion = "1.0.0"\ntarget = "javascript"\n',
    );
    for (const module of all) {
      await Deno.writeTextFile(`${root}/src/${module.name}.gleam`, module.source);
    }
    for (const foreignModule of ["gleam_stdlib.mjs", "gleam_stdlib.erl", "dict.mjs"]) {
      await Deno.copyFile(`${checkout}/src/${foreignModule}`, `${root}/src/${foreignModule}`);
    }

    const samples: number[] = [];
    for (let index = 0; index < REPETITIONS; index++) {
      await new Deno.Command("gleam", {
        cwd: root,
        args: ["clean"],
        stdout: "null",
        stderr: "null",
      }).output();
      const started = performance.now();
      const result = await new Deno.Command("gleam", {
        cwd: root,
        args: ["build", "--target", "javascript", "--no-print-progress"],
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!result.success) {
        throw new Error(
          `gleam build failed in ${root}: ${new TextDecoder().decode(result.stderr)}`,
        );
      }
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);

    const warmSamples: number[] = [];
    for (let index = 0; index < REPETITIONS; index++) {
      const started = performance.now();
      const result = await new Deno.Command("gleam", {
        cwd: root,
        args: ["build", "--target", "javascript", "--no-print-progress"],
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!result.success) {
        throw new Error(
          `warm Gleam build failed in ${root}: ${new TextDecoder().decode(result.stderr)}`,
        );
      }
      warmSamples.push(performance.now() - started);
    }
    warmSamples.sort((left, right) => left - right);

    const editedSamples: number[] = [];
    for (let index = 0; index < REPETITIONS; index++) {
      await Deno.writeTextFile(
        `${root}/src/${entry.name}.gleam`,
        `${entry.source}\n// benchmark edit ${index}\n`,
      );
      editedSamples.push(
        await runGleamBuild(root, `edited Gleam build ${index}`),
      );
    }
    editedSamples.sort((left, right) => left - right);
    return {
      cold: samples[Math.floor(samples.length / 2)]!,
      warm: warmSamples[Math.floor(warmSamples.length / 2)]!,
      sourceOnlyEdit: editedSamples[Math.floor(editedSamples.length / 2)]!,
    };
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function runGleamBuild(root: string, description: string): Promise<number> {
  const started = performance.now();
  const result = await new Deno.Command("gleam", {
    cwd: root,
    args: ["build", "--target", "javascript", "--no-print-progress"],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `${description} failed in ${root}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return performance.now() - started;
}

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
const cpuCompiler = new CpuCompiler();

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

  const cpuMilliseconds = await median(async () => {
    const compilation = await cpuCompiler.compileModule(frontend.lowered.module);
    if (!compilation.ok) {
      throw new Error(`CPU compilation failed: ${compilation.diagnostics[0]?.code}`);
    }
    compilation.module.destroy();
  });

  const gpuMilliseconds = await median(async () => {
    const compilation = await compiler.compileModule(frontend.lowered.module, {
      maximumSteps: 10_000_000,
    });
    if (!compilation.ok) {
      throw new Error(`GPU compilation failed: ${compilation.diagnostics[0]?.code}`);
    }
    compilation.module.destroy();
  });

  // The public emitter memoizes by Core fingerprint across module objects. Call raw code generation
  // so every sample includes emission rather than measuring the process-wide cache after sample one.
  let wasmBytes = 0;
  const wasmSamples: number[] = [];
  for (let index = 0; index < REPETITIONS; index++) {
    const fresh = await compiler.compileModule(frontend.lowered.module, {
      maximumSteps: 10_000_000,
    });
    if (!fresh.ok) throw new Error("GPU compilation failed");
    const nodes = await fresh.module.readCoreNodes();
    const started = performance.now();
    wasmBytes = compileWasmArtifact(fresh.module, nodes).bytes.byteLength;
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
  const gleamMilliseconds = await measureGleam();
  const cpuCompleteWithWasm = frontendTotal + cpuMilliseconds + wasmMilliseconds;
  const gpuCompleteWithWasm = frontendTotal + gpuMilliseconds + wasmMilliseconds;
  const frontendService = new GleamFrontendService();
  const compilerService = new FunctionalCompilerService({ backend: "cpu" });
  const compileWarmProject = async (): Promise<void> => {
    const warmFrontend = frontendService.lower(all, {
      module: entry.name,
      exportName: "main",
    });
    if (!warmFrontend.ok) {
      throw new Error(`warm lowering failed: ${warmFrontend.diagnostics[0]?.message}`);
    }
    const warmCompilation = await compilerService.compileModule(warmFrontend.lowered.module);
    if (!warmCompilation.ok) {
      throw new Error(`warm compilation failed: ${warmCompilation.diagnostics[0]?.code}`);
    }
    await compileModuleToWasm(warmCompilation.module);
  };
  await compileWarmProject();
  const warmCompleteWithWasm = await median(compileWarmProject);
  let editIndex = 0;
  const compileSourceOnlyEdit = async (): Promise<void> => {
    const editedSources = all.map((source, index) =>
      index === all.length - 1
        ? { ...source, source: `${source.source}\n// benchmark edit ${editIndex++}\n` }
        : source
    );
    const editedFrontend = frontendService.lower(editedSources, {
      module: entry.name,
      exportName: "main",
    });
    if (!editedFrontend.ok) {
      throw new Error(`edited lowering failed: ${editedFrontend.diagnostics[0]?.message}`);
    }
    const editedCompilation = await compilerService.compileModule(
      editedFrontend.lowered.module,
    );
    if (!editedCompilation.ok) {
      throw new Error(`edited compilation failed: ${editedCompilation.diagnostics[0]?.code}`);
    }
    await compileModuleToWasm(editedCompilation.module);
  };
  const editedCompleteWithWasm = await median(compileSourceOnlyEdit);
  await compilerService.destroy();

  console.log(JSON.stringify(
    {
      modules: all.length,
      sourceKilobytes: Number((sourceBytes / 1024).toFixed(1)),
      surfaceNodes: frontend.lowered.module.nodeCount,
      repetitions: REPETITIONS,
      medianMilliseconds: {
        parse: Number(parseMilliseconds.toFixed(1)),
        parseAndLower: Number(lowerMilliseconds.toFixed(1)),
        cpuResolveAndInfer: Number(cpuMilliseconds.toFixed(1)),
        gpuResolveAndInfer: Number(gpuMilliseconds.toFixed(1)),
        cpuHindleyMilnerOracle: Number(cpuInferenceMilliseconds.toFixed(1)),
        emitWasm: Number(wasmMilliseconds.toFixed(1)),
        cpuCompleteWithWasm: Number(cpuCompleteWithWasm.toFixed(1)),
        gpuCompleteWithWasm: Number(gpuCompleteWithWasm.toFixed(1)),
        warmCompleteWithWasm: Number(warmCompleteWithWasm.toFixed(3)),
        sourceOnlyEditCompleteWithWasm: Number(editedCompleteWithWasm.toFixed(1)),
        gleamBuild: Number(gleamMilliseconds.cold.toFixed(1)),
        gleamWarmBuild: Number(gleamMilliseconds.warm.toFixed(1)),
        gleamSourceOnlyEditBuild: Number(gleamMilliseconds.sourceOnlyEdit.toFixed(1)),
      },
      wasmKilobytes: Number((wasmBytes / 1024).toFixed(1)),
      gpuSlowerThanCpuOracle: Number((gpuMilliseconds / cpuInferenceMilliseconds).toFixed(1)),
      cpuSlowerThanGleam: Number((cpuCompleteWithWasm / gleamMilliseconds.cold).toFixed(2)),
      gpuSlowerThanGleam: Number((gpuCompleteWithWasm / gleamMilliseconds.cold).toFixed(2)),
      warmFasterThanGleam: Number(
        (gleamMilliseconds.warm / warmCompleteWithWasm).toFixed(1),
      ),
      sourceOnlyEditSlowerThanGleam: Number(
        (editedCompleteWithWasm / gleamMilliseconds.sourceOnlyEdit).toFixed(2),
      ),
      cpuMicrosecondsPerSourceByte: Number(
        ((cpuCompleteWithWasm * 1000) / sourceBytes).toFixed(3),
      ),
    },
    null,
    2,
  ));
} finally {
  device.destroy();
}
