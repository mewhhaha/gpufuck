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
 * Usage: deno task bench:gleam-stdlib <stdlib-checkout> [entry.gleam] [--trace=trace.json]
 */
import {
  compileModuleToWasm,
  CompilerPerformanceTrace,
  CpuCompiler,
  FunctionalCompilerService,
  GpuCompiler,
  measureCompilerStageAsync,
  renderCompilerPerformanceTrace,
  requestWebGpuDevice,
  runWasmModule,
  summarizeCompilerPerformance,
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
  console.error(
    "usage: gleam_stdlib_compile_bench.ts <stdlib-checkout> [entry.gleam] [--trace=trace.json]",
  );
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
const performanceTraceArgument = Deno.args.find((argument) => argument.startsWith("--trace="));
const performanceTracePath = performanceTraceArgument?.slice("--trace=".length);
if (performanceTraceArgument !== undefined && performanceTracePath === "") {
  throw new TypeError("Gleam stdlib benchmark --trace requires a non-empty output path");
}
const entryPath = Deno.args.slice(1).find((argument) => !argument.startsWith("--trace="));
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
  readonly internalCodeEdit: number;
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
      const clean = await new Deno.Command("gleam", {
        cwd: root,
        args: ["clean"],
        stdout: "null",
        stderr: "piped",
      }).output();
      if (!clean.success) {
        throw new Error(
          `Gleam clean failed in ${root}: ${new TextDecoder().decode(clean.stderr)}`,
        );
      }
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
    const entryResult = "\n  Nil\n}\n";
    if (!entry.source.endsWith(entryResult)) {
      throw new Error("generated stdlib entry does not end in its expected Nil result");
    }
    const entryPrefix = entry.source.slice(0, -entryResult.length);
    const internalEditSamples: number[] = [];
    for (let index = 0; index < REPETITIONS; index++) {
      await Deno.writeTextFile(
        `${root}/src/${entry.name}.gleam`,
        `${entryPrefix}\n  ${index}\n}\n`,
      );
      internalEditSamples.push(
        await runGleamBuild(root, `internal-code edited Gleam build ${index}`),
      );
    }
    internalEditSamples.sort((left, right) => left - right);
    return {
      cold: samples[Math.floor(samples.length / 2)]!,
      warm: warmSamples[Math.floor(warmSamples.length / 2)]!,
      sourceOnlyEdit: editedSamples[Math.floor(editedSamples.length / 2)]!,
      internalCodeEdit: internalEditSamples[Math.floor(internalEditSamples.length / 2)]!,
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

  const pipelineTraces: CompilerPerformanceTrace[] = [];
  for (let index = 0; index < REPETITIONS; index++) {
    const trace = new CompilerPerformanceTrace();
    await trace.measureAsync(
      "compiler.total",
      { modules: all.length, sourceBytes },
      async () => {
        const tracedFrontend = lowerGleamSources(
          all,
          { module: entry.name, exportName: "main" },
          { trace },
        );
        if (!tracedFrontend.ok) {
          throw new Error(`traced lowering failed: ${tracedFrontend.diagnostics[0]?.message}`);
        }
        const compilation = await cpuCompiler.compileModule(
          tracedFrontend.lowered.module,
          { trace },
        );
        if (!compilation.ok) {
          throw new Error(`traced CPU compilation failed: ${compilation.diagnostics[0]?.code}`);
        }
        const nodes = await measureCompilerStageAsync(
          trace,
          "wasm.read-core",
          { nodes: compilation.module.nodeCount },
          () => compilation.module.readCoreNodes(),
        );
        compileWasmArtifact(compilation.module, nodes, false, {}, trace);
        compilation.module.destroy();
      },
    );
    pipelineTraces.push(trace);
  }
  const tracedStageMilliseconds = medianStageMilliseconds(pipelineTraces);
  const representativeTrace = representativePipelineTrace(pipelineTraces);
  const tracedPipelineBreakdown = pipelineBreakdown(representativeTrace);
  if (performanceTracePath !== undefined) {
    await Deno.writeTextFile(
      performanceTracePath,
      renderCompilerPerformanceTrace(representativeTrace.snapshot()),
    );
  }

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

  const emptyRuntimeResult = "\n  Nil\n}\n";
  if (!entry.source.endsWith(emptyRuntimeResult)) {
    throw new Error("generated stdlib entry does not end in its expected Nil result");
  }
  const runtimeEntry = {
    ...entry,
    source: `${
      entry.source.slice(0, -emptyRuntimeResult.length)
    }\n  gleam_list.fold(\n    gleam_list.map(gleam_list.repeat(1, 10_000), fn(value) { value + 1 }),\n    0,\n    fn(value, total) { value + total },\n  )\n}\n`,
  };
  const runtimeFrontend = lowerGleamSources(
    [...sources, runtimeEntry],
    { module: runtimeEntry.name, exportName: "main" },
  );
  if (!runtimeFrontend.ok) {
    throw new Error(
      `runtime lowering failed: ${runtimeFrontend.diagnostics[0]?.message}`,
    );
  }
  const runtimeCompilation = await cpuCompiler.compileModule(runtimeFrontend.lowered.module);
  if (!runtimeCompilation.ok) {
    throw new Error(
      `runtime CPU compilation failed: ${runtimeCompilation.diagnostics[0]?.code}`,
    );
  }
  const benchmarkInit: Record<string, Record<string, () => never>> = Object.fromEntries(
    runtimeCompilation.module.hostCapabilities.map((capability) => [
      capability.name,
      Object.fromEntries(capability.fields.flatMap((field) => {
        if (field.kind === "value") {
          if (field.wasmLiteral !== undefined) return [];
          throw new Error(
            `stdlib runtime benchmark cannot stub host value ${
              JSON.stringify(`${capability.name}.${field.name}`)
            }`,
          );
        }
        if (field.wasmIntrinsic !== undefined) return [];
        return [[field.name, () => {
          throw new Error(
            `stdlib runtime benchmark unexpectedly called ${
              JSON.stringify(`${capability.name}.${field.name}`)
            }`,
          );
        }]];
      })),
    ]),
  );
  const wasmRuntimeMilliseconds = await median(async () => {
    const execution = await runWasmModule(runtimeCompilation.module, { init: benchmarkInit });
    if (
      execution.value.kind !== "signed-integer-64" ||
      execution.value.value !== 20_000n
    ) {
      throw new Error(
        `stdlib benchmark entry expected 20000; received ${
          JSON.stringify(execution.value, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value)
        }`,
      );
    }
  });
  runtimeCompilation.module.destroy();

  const cpuInferenceMilliseconds = await median(() => {
    const inferred = inferTypes(frontend.lowered.module);
    if (!inferred.ok) {
      throw new Error(`CPU inference failed: ${JSON.stringify(inferred.diagnostic)}`);
    }
  });

  const gleamMilliseconds = await measureGleam();
  const requiredToMatchGleam = tracedPipelineBreakdown.total - gleamMilliseconds.cold;
  const withoutFrontend = tracedPipelineBreakdown.total - tracedPipelineBreakdown.frontend;
  const withoutSemantic = tracedPipelineBreakdown.total - tracedPipelineBreakdown.semantic;
  const withoutWasm = tracedPipelineBreakdown.total - tracedPipelineBreakdown.wasm;
  const withFrontendAndWasmHalved = tracedPipelineBreakdown.total -
    tracedPipelineBreakdown.frontend / 2 -
    tracedPipelineBreakdown.wasm / 2;
  const cpuCompleteWithWasm = await median(async () => {
    const completeFrontend = lowerGleamSources(all, {
      module: entry.name,
      exportName: "main",
    });
    if (!completeFrontend.ok) {
      throw new Error(
        `complete CPU lowering failed: ${completeFrontend.diagnostics[0]?.message}`,
      );
    }
    const completeCompilation = await cpuCompiler.compileModule(
      completeFrontend.lowered.module,
    );
    if (!completeCompilation.ok) {
      throw new Error(
        `complete CPU compilation failed: ${completeCompilation.diagnostics[0]?.code}`,
      );
    }
    const completeNodes = await completeCompilation.module.readCoreNodes();
    compileWasmArtifact(completeCompilation.module, completeNodes);
    completeCompilation.module.destroy();
  });
  const gpuCompleteWithWasm = await median(async () => {
    const completeFrontend = lowerGleamSources(all, {
      module: entry.name,
      exportName: "main",
    });
    if (!completeFrontend.ok) {
      throw new Error(
        `complete GPU lowering failed: ${completeFrontend.diagnostics[0]?.message}`,
      );
    }
    const completeCompilation = await compiler.compileModule(
      completeFrontend.lowered.module,
      { maximumSteps: 10_000_000 },
    );
    if (!completeCompilation.ok) {
      throw new Error(
        `complete GPU compilation failed: ${completeCompilation.diagnostics[0]?.code}`,
      );
    }
    const completeNodes = await completeCompilation.module.readCoreNodes();
    compileWasmArtifact(completeCompilation.module, completeNodes);
    completeCompilation.module.destroy();
  });
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
  const compileSourceOnlyEdit = async (
    trace?: CompilerPerformanceTrace,
  ): Promise<void> => {
    const editedSources = all.map((source, index) =>
      index === all.length - 1
        ? { ...source, source: `${source.source}\n// benchmark edit ${editIndex++}\n` }
        : source
    );
    const compile = async (): Promise<void> => {
      const editedFrontend = frontendService.lower(
        editedSources,
        { module: entry.name, exportName: "main" },
        trace === undefined ? {} : { trace },
      );
      if (!editedFrontend.ok) {
        throw new Error(`edited lowering failed: ${editedFrontend.diagnostics[0]?.message}`);
      }
      const editedCompilation = await compilerService.compileModule(
        editedFrontend.lowered.module,
        trace === undefined ? {} : { trace },
      );
      if (!editedCompilation.ok) {
        throw new Error(
          `edited compilation failed: ${editedCompilation.diagnostics[0]?.code}`,
        );
      }
      await compileModuleToWasm(
        editedCompilation.module,
        trace === undefined ? {} : { trace },
      );
    };
    if (trace === undefined) {
      await compile();
      return;
    }
    await trace.measureAsync(
      "compiler.total",
      { modules: editedSources.length, sourceBytes },
      compile,
    );
  };
  const editedCompleteWithWasm = await median(compileSourceOnlyEdit);
  const sourceOnlyEditTraces: CompilerPerformanceTrace[] = [];
  for (let index = 0; index < REPETITIONS; index++) {
    const trace = new CompilerPerformanceTrace();
    await compileSourceOnlyEdit(trace);
    sourceOnlyEditTraces.push(trace);
  }
  const representativeSourceOnlyEditTrace = representativePipelineTrace(sourceOnlyEditTraces);
  const tracedSourceOnlyEditMilliseconds = medianStageMilliseconds(sourceOnlyEditTraces);
  const tracedSourceOnlyEditBreakdown = pipelineBreakdown(representativeSourceOnlyEditTrace);
  const incrementalFrontendService = new GleamFrontendService();
  const incrementalCompilerService = new FunctionalCompilerService({ backend: "cpu" });
  const compileIncrementalProject = async (
    sources: readonly GleamSourceModule[],
    trace?: CompilerPerformanceTrace,
  ): Promise<void> => {
    const compile = async (): Promise<void> => {
      const editedFrontend = incrementalFrontendService.lower(
        sources,
        { module: entry.name, exportName: "main" },
        trace === undefined ? {} : { trace },
      );
      if (!editedFrontend.ok) {
        throw new Error(
          `internal-code edited lowering failed: ${editedFrontend.diagnostics[0]?.message}`,
        );
      }
      const editedCompilation = await incrementalCompilerService.compileModule(
        editedFrontend.lowered.module,
        trace === undefined ? {} : { trace },
      );
      if (!editedCompilation.ok) {
        throw new Error(
          `internal-code edited compilation failed: ${editedCompilation.diagnostics[0]?.code}`,
        );
      }
      await compileModuleToWasm(
        editedCompilation.module,
        trace === undefined ? {} : { trace },
      );
    };
    if (trace === undefined) {
      await compile();
      return;
    }
    await trace.measureAsync(
      "compiler.total",
      { modules: sources.length, sourceBytes },
      compile,
    );
  };
  await compileIncrementalProject(all);
  const entryResult = "\n  Nil\n}\n";
  if (!entry.source.endsWith(entryResult)) {
    throw new Error("generated stdlib entry does not end in its expected Nil result");
  }
  const entryPrefix = entry.source.slice(0, -entryResult.length);
  let internalEditIndex = 0;
  const incrementalTraces: CompilerPerformanceTrace[] = [];
  const compileInternalCodeEdit = async (): Promise<void> => {
    const trace = new CompilerPerformanceTrace();
    const editedSources = all.map((source, index) =>
      index === all.length - 1
        ? {
          ...source,
          source: `${entryPrefix}\n  ${internalEditIndex++}\n}\n`,
        }
        : source
    );
    await compileIncrementalProject(editedSources, trace);
    incrementalTraces.push(trace);
  };
  const internalCodeEditCompleteWithWasm = await median(compileInternalCodeEdit);
  const representativeInternalEditTrace = representativePipelineTrace(incrementalTraces);
  const incrementalEvent = representativeInternalEditTrace.snapshot().find((event) =>
    event.stage === "frontend.parse.incremental"
  );
  if (incrementalEvent === undefined) {
    throw new Error("internal-code edit trace omitted frontend.parse.incremental");
  }
  const incrementalEditWork = {
    scannedCodeUnits: incrementalEvent.annotations.scannedCodeUnits,
    createdTokens: incrementalEvent.annotations.createdTokens,
    reusedTokens: incrementalEvent.annotations.reusedTokens,
    parserActions: incrementalEvent.annotations.parserActions,
    reuseChecks: incrementalEvent.annotations.reuseChecks,
    reusedCheckpoints: incrementalEvent.annotations.reusedCheckpoints,
    createdCheckpoints: incrementalEvent.annotations.createdCheckpoints,
  };
  const tracedInternalCodeEditMilliseconds = medianStageMilliseconds(incrementalTraces);
  const tracedInternalCodeEditBreakdown = pipelineBreakdown(representativeInternalEditTrace);
  frontendService.clear();
  incrementalFrontendService.clear();
  await compilerService.destroy();
  await incrementalCompilerService.destroy();

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
        runWasm: Number(wasmRuntimeMilliseconds.toFixed(1)),
        cpuCompleteWithWasm: Number(cpuCompleteWithWasm.toFixed(1)),
        gpuCompleteWithWasm: Number(gpuCompleteWithWasm.toFixed(1)),
        warmCompleteWithWasm: Number(warmCompleteWithWasm.toFixed(3)),
        sourceOnlyEditCompleteWithWasm: Number(editedCompleteWithWasm.toFixed(1)),
        internalCodeEditCompleteWithWasm: Number(
          internalCodeEditCompleteWithWasm.toFixed(1),
        ),
        gleamBuild: Number(gleamMilliseconds.cold.toFixed(1)),
        gleamWarmBuild: Number(gleamMilliseconds.warm.toFixed(1)),
        gleamSourceOnlyEditBuild: Number(gleamMilliseconds.sourceOnlyEdit.toFixed(1)),
        gleamInternalCodeEditBuild: Number(gleamMilliseconds.internalCodeEdit.toFixed(1)),
      },
      incrementalEditWork,
      tracedSourceOnlyEditMilliseconds,
      tracedSourceOnlyEditBreakdown,
      tracedInternalCodeEditMilliseconds,
      tracedInternalCodeEditBreakdown,
      tracedColdCpuPipelineMilliseconds: tracedStageMilliseconds,
      tracedColdCpuPipelineBreakdown: tracedPipelineBreakdown,
      tracedColdDeltaVersusUntracedPercent: Number(
        ((tracedPipelineBreakdown.total / cpuCompleteWithWasm - 1) * 100).toFixed(1),
      ),
      measurementScope: {
        gpufuckCold:
          "warm Deno process; full frontend, uncached semantic compilation, and uncached Wasm emission",
        gleamCold:
          "new Gleam process after gleam clean; compiler and filesystem pages may remain in the OS cache",
        edit: "resident compiler processes with one real internal edit per sample",
      },
      optimizationCeilings: {
        requiredToMatchGleamMilliseconds: Number(requiredToMatchGleam.toFixed(1)),
        requiredToMatchGleamPercent: Number(
          ((requiredToMatchGleam / tracedPipelineBreakdown.total) * 100).toFixed(1),
        ),
        eliminateFrontendMilliseconds: Number(withoutFrontend.toFixed(1)),
        eliminateFrontendStillSlowerThanGleam: Number(
          (withoutFrontend / gleamMilliseconds.cold).toFixed(2),
        ),
        eliminateSemanticMilliseconds: Number(withoutSemantic.toFixed(1)),
        eliminateSemanticStillSlowerThanGleam: Number(
          (withoutSemantic / gleamMilliseconds.cold).toFixed(2),
        ),
        eliminateWasmMilliseconds: Number(withoutWasm.toFixed(1)),
        eliminateWasmStillSlowerThanGleam: Number(
          (withoutWasm / gleamMilliseconds.cold).toFixed(2),
        ),
        halveFrontendAndWasmMilliseconds: Number(withFrontendAndWasmHalved.toFixed(1)),
        halveFrontendAndWasmStillSlowerThanGleam: Number(
          (withFrontendAndWasmHalved / gleamMilliseconds.cold).toFixed(2),
        ),
      },
      performanceTraceFile: performanceTracePath,
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
      internalCodeEditSlowerThanGleam: Number(
        (internalCodeEditCompleteWithWasm / gleamMilliseconds.internalCodeEdit).toFixed(2),
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

function medianStageMilliseconds(
  traces: readonly CompilerPerformanceTrace[],
): Readonly<Record<string, number>> {
  const stageSamples = new Map<string, number[]>();
  for (const trace of traces) {
    for (const summary of summarizeCompilerPerformance(trace.snapshot())) {
      const samples = stageSamples.get(summary.stage) ?? [];
      samples.push(summary.totalMilliseconds);
      stageSamples.set(summary.stage, samples);
    }
  }
  return Object.freeze(Object.fromEntries([...stageSamples.entries()].map(([stage, samples]) => {
    samples.sort((left, right) => left - right);
    return [stage, Number(samples[Math.floor(samples.length / 2)]!.toFixed(3))];
  })));
}

function representativePipelineTrace(
  traces: readonly CompilerPerformanceTrace[],
): CompilerPerformanceTrace {
  const ranked = traces.map((trace) => {
    const total = trace.snapshot().find((event) => event.stage === "compiler.total");
    if (total === undefined) throw new Error("compiler performance trace omitted compiler.total");
    return { trace, durationMilliseconds: total.durationMilliseconds };
  }).sort((left, right) => left.durationMilliseconds - right.durationMilliseconds);
  return ranked[Math.floor(ranked.length / 2)]!.trace;
}

function pipelineBreakdown(
  trace: CompilerPerformanceTrace,
): Readonly<{
  total: number;
  frontend: number;
  semantic: number;
  wasm: number;
  orchestration: number;
  attributedPercent: number;
  unattributedPercent: number;
}> {
  const stages = new Map(
    summarizeCompilerPerformance(trace.snapshot()).map((summary) => [
      summary.stage,
      summary.totalMilliseconds,
    ]),
  );
  const total = stages.get("compiler.total");
  if (total === undefined) {
    throw new Error("compiler performance trace omitted compiler.total");
  }
  const frontendParse = stages.get("frontend.parse") ??
    stages.get("frontend.parse.module") ??
    0;
  const frontend = frontendParse + [
    "frontend.signatures.nominal",
    "frontend.signatures.value",
    "frontend.lower",
    "frontend.link",
    "frontend.link.literal-update",
  ].reduce((sum, stage) => sum + (stages.get(stage) ?? 0), 0);
  const semantic = [
    "semantic.fingerprint",
    "semantic.service-cache",
    "semantic.rebind-source",
    "semantic.apply-literal-update",
    "semantic.validate-envelope",
    "semantic.validate-declarations",
    "semantic.symbol-index",
    "semantic.inference.metadata",
    "semantic.inference.graph",
    "semantic.inference.solve",
    "semantic.inference.materialize",
    "semantic.lower-core",
    "semantic.publish",
  ].reduce((sum, stage) => sum + (stages.get(stage) ?? 0), 0);
  const wasm = stages.get("wasm.total") ??
    ["wasm.read-core", "wasm.plan", "wasm.emit"].reduce(
      (sum, stage) => sum + (stages.get(stage) ?? 0),
      0,
    );
  const orchestration = total - frontend - semantic - wasm;
  if (orchestration < -total * 0.01) {
    throw new Error(
      `compiler performance stages double-count ${(-orchestration).toFixed(3)} ms of ${
        total.toFixed(3)
      } ms total`,
    );
  }
  const attributedPercent = total === 0
    ? 0
    : Math.min(100, ((frontend + semantic + wasm) / total) * 100);
  return Object.freeze({
    total: Number(total.toFixed(3)),
    frontend: Number(frontend.toFixed(3)),
    semantic: Number(semantic.toFixed(3)),
    wasm: Number(wasm.toFixed(3)),
    orchestration: Number(orchestration.toFixed(3)),
    attributedPercent: Number(attributedPercent.toFixed(1)),
    unattributedPercent: Number((100 - attributedPercent).toFixed(1)),
  });
}
