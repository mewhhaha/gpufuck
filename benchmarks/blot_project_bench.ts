import { CompilerPerformanceTrace, summarizeCompilerPerformance } from "../functional.ts";
import {
  BlotCompilerSession,
  type Verified,
  type VerifyMetrics,
  type VerifyTimings,
} from "../playground/blot/src/backend/compile.ts";
import { hostInit } from "../playground/blot/src/backend/host.ts";
import { configureSourceLexerRecords, configureSources } from "../playground/blot/src/load.ts";
import {
  dispose as disposeBlotParser,
  initializeBlotParser,
} from "../playground/blot/src/syntax/parse.ts";
import { resetBlotSyntaxSession, validateBlotSyntax } from "../playground/blot/gpu_frontend.ts";
import { createBlotStressProject } from "../playground/blot/stress_project.ts";

const RESIDENT_SAMPLE_COUNT = 3;
const parallelColdSetup = Deno.args.includes("--parallel-setup");
const gpuSyntax = Deno.args.includes("--gpu-syntax");
const blot = new URL("../playground/blot/", import.meta.url);
const prelude = await Deno.readTextFile(new URL("src/prelude/prelude.blot", blot));
const stressProject = createBlotStressProject();
const parserWasmUrl = new URL("generated/wasm/parser.wasm", blot);
const parserPlanUrl = new URL("generated/wasm/parser.plan", blot);

const stages: readonly [label: string, timing: keyof VerifyTimings][] = [
  ["Blot load + cursor AST", "blotLoadMilliseconds"],
  ["Blot check", "blotCheckMilliseconds"],
  ["Blot stage", "blotStageMilliseconds"],
  ["Blot lower", "blotLowerMilliseconds"],
  ["Surface encode", "surfaceEncodeMilliseconds"],
  ["GPU device", "gpuDeviceMilliseconds"],
  ["GPU compiler init", "gpuCompilerMilliseconds"],
  ["GPU evaluator init", "gpuEvaluatorMilliseconds"],
  ["Core compile", "coreCompileMilliseconds"],
  ["GPU evaluate", "gpuEvaluateMilliseconds"],
  ["Wasm emit + run", "wasmExecuteMilliseconds"],
  ["Canonical Wasm emit", "canonicalWasmMilliseconds"],
];

const syntaxStages: readonly [label: string, timing: keyof SyntaxTimings][] = [
  ["Parser resources", "parserResourcesMilliseconds"],
  ["GPU syntax setup", "gpuSetupMilliseconds"],
  ["GPU syntax ingest", "gpuIngestMilliseconds"],
  ["Source configuration", "sourceConfigurationMilliseconds"],
];

interface Workload {
  readonly label: string;
  readonly path: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly expectedRuntimeExports?: number;
  readonly editSource?: (source: string, sample: number) => string;
}

interface Sample {
  readonly timings: VerifyTimings;
  readonly syntax: SyntaxTimings;
  readonly wallMilliseconds: number;
  readonly trace: CompilerPerformanceTrace;
}

interface SyntaxTimings {
  readonly parserResourcesMilliseconds: number;
  readonly gpuSetupMilliseconds: number;
  readonly gpuIngestMilliseconds: number;
  readonly sourceConfigurationMilliseconds: number;
  readonly totalMilliseconds: number;
}

interface Measurement {
  readonly cold: readonly Sample[];
  readonly unchanged: readonly Sample[];
  readonly edited: readonly Sample[];
  readonly wasmBytes: number;
  readonly metrics: VerifyMetrics;
}

const compilerHost = hostInit(() => {});

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function prepareSource(
  workload: Workload,
  workloadSources: Readonly<Record<string, string>>,
  cache: "clear" | "reuse-unchanged",
  resetResources: boolean,
): Promise<SyntaxTimings> {
  const entrySource = workloadSources[workload.path];
  if (entrySource === undefined) {
    throw new Error(`${workload.label} has no configured entry source at ${workload.path}`);
  }
  const start = performance.now();
  const parserResourcesStart = start;
  if (resetResources) {
    disposeBlotParser();
    await resetBlotSyntaxSession();
  }
  await initializeBlotParser(parserWasmUrl, parserPlanUrl);
  const parserResourcesMilliseconds = performance.now() - parserResourcesStart;
  let gpuSetupMilliseconds = 0;
  let gpuIngestMilliseconds = 0;
  let lexerRecords: Int32Array | undefined;
  if (gpuSyntax) {
    const gpuSyntaxStart = performance.now();
    const syntax = await validateBlotSyntax(entrySource, parserPlanUrl);
    const gpuSyntaxMilliseconds = performance.now() - gpuSyntaxStart;
    if (!syntax.ok) {
      throw new Error(
        `${workload.label} failed GPU syntax validation: ${
          syntax.diagnostics[0]?.message ?? "no diagnostic"
        }`,
      );
    }
    gpuIngestMilliseconds = syntax.cacheHit ? 0 : syntax.timings.totalMs;
    gpuSetupMilliseconds = Math.max(0, gpuSyntaxMilliseconds - gpuIngestMilliseconds);
    lexerRecords = syntax.lexerRecords;
  }
  const sourceConfigurationStart = performance.now();
  configureSources({
    "/blot/prelude.blot": prelude,
    ...workloadSources,
  }, { cache });
  if (lexerRecords !== undefined) {
    configureSourceLexerRecords(workload.path, entrySource, lexerRecords);
  }
  const sourceConfigurationMilliseconds = performance.now() - sourceConfigurationStart;
  return {
    parserResourcesMilliseconds,
    gpuSetupMilliseconds,
    gpuIngestMilliseconds,
    sourceConfigurationMilliseconds,
    totalMilliseconds: performance.now() - start,
  };
}

async function measureVerification(
  session: BlotCompilerSession,
  workload: Workload,
  syntax: SyntaxTimings,
): Promise<{ readonly sample: Sample; readonly verified: Verified }> {
  const trace = new CompilerPerformanceTrace();
  const start = performance.now();
  const verified = await session.verify(workload.path, {
    evaluatorInit: compilerHost,
    wasmInit: compilerHost,
    trace,
  });
  return {
    sample: {
      timings: verified.timings,
      syntax,
      wallMilliseconds: performance.now() - start,
      trace,
    },
    verified,
  };
}

function assertRuntimeExports(workload: Workload, verified: Verified): void {
  if (workload.expectedRuntimeExports === undefined) return;
  const runtimeExports = verified.manifest.exports.filter((entry) => entry.phase === "runtime");
  if (runtimeExports.length === workload.expectedRuntimeExports) return;
  throw new Error(
    `${workload.label} emitted ${runtimeExports.length} runtime exports; expected ${workload.expectedRuntimeExports}`,
  );
}

async function measureCold(workload: Workload): Promise<readonly Sample[]> {
  const start = performance.now();
  const setup = prepareSource(
    workload,
    workload.sources,
    "clear",
    true,
  );
  let syntax: SyntaxTimings;
  let session: BlotCompilerSession;
  if (parallelColdSetup) {
    const [prepared, created] = await Promise.allSettled([
      setup,
      BlotCompilerSession.create(),
    ]);
    if (prepared.status === "rejected") {
      if (created.status === "fulfilled") created.value.destroy();
      throw prepared.reason;
    }
    if (created.status === "rejected") throw created.reason;
    syntax = prepared.value;
    session = created.value;
  } else {
    syntax = await setup;
    session = await BlotCompilerSession.create();
  }
  try {
    const measured = await measureVerification(session, workload, syntax);
    assertRuntimeExports(workload, measured.verified);
    return [{
      ...measured.sample,
      wallMilliseconds: performance.now() - start,
    }];
  } finally {
    session.destroy();
  }
}

async function measureResident(
  workload: Workload,
): Promise<{
  readonly unchanged: readonly Sample[];
  readonly edited: readonly Sample[];
  readonly wasmBytes: number;
  readonly metrics: VerifyMetrics;
}> {
  await prepareSource(workload, workload.sources, "clear", true);
  const session = await BlotCompilerSession.create();
  try {
    const seeded = await session.verify(workload.path, {
      evaluatorInit: compilerHost,
      wasmInit: compilerHost,
    });
    assertRuntimeExports(workload, seeded);

    const unchanged: Sample[] = [];
    for (let sampleIndex = 0; sampleIndex < RESIDENT_SAMPLE_COUNT; sampleIndex += 1) {
      const syntax = await prepareSource(
        workload,
        workload.sources,
        "reuse-unchanged",
        false,
      );
      const start = performance.now();
      const measured = await measureVerification(session, workload, syntax);
      assertRuntimeExports(workload, measured.verified);
      unchanged.push({
        ...measured.sample,
        wallMilliseconds: syntax.totalMilliseconds + performance.now() - start,
      });
    }

    const edited: Sample[] = [];
    if (workload.editSource !== undefined) {
      const original = workload.sources[workload.path];
      if (original === undefined) {
        throw new Error(`${workload.label} has no configured entry source at ${workload.path}`);
      }
      for (let sampleIndex = 0; sampleIndex < RESIDENT_SAMPLE_COUNT; sampleIndex += 1) {
        const changedSources = {
          ...workload.sources,
          [workload.path]: workload.editSource(original, sampleIndex),
        };
        const syntax = await prepareSource(
          workload,
          changedSources,
          "reuse-unchanged",
          false,
        );
        const start = performance.now();
        const measured = await measureVerification(session, workload, syntax);
        assertRuntimeExports(workload, measured.verified);
        const coreCache = measured.sample.trace.snapshot().find((event) =>
          event.stage === "semantic.service-cache"
        );
        if (coreCache?.annotations.cacheLevel !== "literal-update") {
          throw new Error(
            `${workload.label} literal edit used Core cache level ${
              String(coreCache?.annotations.cacheLevel)
            }; expected literal-update`,
          );
        }
        edited.push({
          ...measured.sample,
          wallMilliseconds: syntax.totalMilliseconds + performance.now() - start,
        });
      }
    }
    return { unchanged, edited, wasmBytes: seeded.wasm.byteLength, metrics: seeded.metrics };
  } finally {
    session.destroy();
  }
}

async function measureWorkload(workload: Workload): Promise<Measurement> {
  const cold = await measureCold(workload);
  const resident = await measureResident(workload);
  return { cold, ...resident };
}

function printSamples(label: string, samples: readonly Sample[]): void {
  if (samples.length === 0) return;
  console.log(`\n  ${label}`);
  console.log(`${"Stage".padEnd(24)} ${"first".padStart(9)} ${"median".padStart(9)}`);
  for (const [stageLabel, timing] of syntaxStages) {
    console.log(
      `${stageLabel.padEnd(24)} ${(samples[0]!.syntax[timing].toFixed(1) + " ms").padStart(9)} ${
        (median(samples.map((sample) => sample.syntax[timing])).toFixed(1) + " ms").padStart(9)
      }`,
    );
  }
  for (const [stageLabel, timing] of stages) {
    console.log(
      `${stageLabel.padEnd(24)} ${(samples[0]!.timings[timing].toFixed(1) + " ms").padStart(9)} ${
        (median(samples.map((sample) => sample.timings[timing])).toFixed(1) + " ms").padStart(9)
      }`,
    );
  }
  console.log(
    `${"Wall-clock total".padEnd(24)} ${
      (samples[0]!.wallMilliseconds.toFixed(1) + " ms").padStart(9)
    } ${(median(samples.map((sample) => sample.wallMilliseconds)).toFixed(1) + " ms").padStart(9)}`,
  );

  const traceEvents = samples[0]!.trace.snapshot();
  const hottest = [...summarizeCompilerPerformance(traceEvents)]
    .sort((left, right) => right.totalMilliseconds - left.totalMilliseconds)
    .slice(0, 5);
  console.log(
    `  Core trace: ${
      hottest.map((stage) => `${stage.stage} ${stage.totalMilliseconds.toFixed(1)} ms`).join(", ")
    }`,
  );
  const gpuMachine = traceEvents.find((event) =>
    event.stage === "semantic.gpu.resolve-infer-readback"
  );
  if (gpuMachine !== undefined) {
    console.log(
      `  GPU machine: ${gpuMachine.annotations.dispatches} dispatches, ` +
        `${gpuMachine.annotations.semanticSteps} resolution steps, ` +
        `${gpuMachine.annotations.inferenceTransitions} inference transitions`,
    );
  }
  const cache = traceEvents.find((event) => event.stage === "semantic.service-cache");
  if (cache?.annotations.cacheHit === true) {
    console.log(`  Core cache: ${cache.annotations.cacheLevel}`);
  }
}

function printMeasurement(workload: Workload, measurement: Measurement): void {
  console.log(`\n${workload.label}: ${(measurement.wasmBytes / 1024).toFixed(1)} KB Wasm`);
  console.log(
    `  Surface: ${measurement.metrics.surfaceNodes.toLocaleString()} nodes, ` +
      `${measurement.metrics.surfaceDefinitions.toLocaleString()} definitions, ` +
      `${measurement.metrics.surfaceTypes.toLocaleString()} types, ` +
      `${measurement.metrics.surfaceConstructors.toLocaleString()} constructors, ` +
      `${measurement.metrics.sourceSpanBytes.toLocaleString()} source-span bytes`,
  );
  const coldMachine = measurement.cold[0]?.trace.snapshot().find((event) =>
    event.stage === "semantic.gpu.resolve-infer-readback"
  );
  if (coldMachine !== undefined) {
    const transitions = Number(coldMachine.annotations.inferenceTransitions);
    console.log(
      `  Inference density: ${
        (transitions / Math.max(1, measurement.metrics.surfaceNodes)).toFixed(1)
      } ` +
        "transitions per Surface node",
    );
  }
  printSamples("Cold page resources", measurement.cold);
  printSamples("Resident unchanged source", measurement.unchanged);
  printSamples("Resident same-shape literal edits", measurement.edited);
}

async function exampleWorkload(
  file: string,
  label: string,
  options: Pick<Workload, "expectedRuntimeExports" | "editSource"> = {},
): Promise<Workload> {
  const path = `/examples/${file}`;
  return {
    label,
    path,
    sources: { [path]: await Deno.readTextFile(new URL(`examples/${file}`, blot)) },
    ...options,
  };
}

const workloads: readonly Workload[] = [
  await exampleWorkload("compiled.blot", "Compiled example", {
    expectedRuntimeExports: 1,
    editSource: (source, sample) => source.replace("- 66", `- ${65 - sample}`),
  }),
  await exampleWorkload("tour.blot", "Language tour"),
  await exampleWorkload("storage.blot", "Storage metaprogramming"),
  {
    label: `Stress project (${stressProject.moduleCount} modules, ` +
      `${stressProject.definitionCount} functions, ${stressProject.lineCount} lines, ` +
      `${(stressProject.sourceBytes / 1024).toFixed(1)} KB source)`,
    path: stressProject.entryPath,
    sources: stressProject.sources,
    expectedRuntimeExports: stressProject.moduleCount - 1,
  },
];

console.log(
  `Syntax uses the ${gpuSyntax ? "Baba GPU" : "Blot CPU"} path. ` +
    `Cold syntax and Core setup are ${parallelColdSetup ? "parallel" : "serial"}. ` +
    "Each cold workload has one sample with fresh JavaScript parser, syntax, source, and Core GPU " +
    "resources; repeating cold samples in one process would reuse global Wasm artifacts. " +
    "Cold totals include concurrent GPU evaluation and Wasm work. " +
    "Resident totals reuse parser, dependencies, checked modules, prepared Surface, GPU resources, " +
    "and compiled Core. Concurrent phase rows overlap and must not be summed.",
);
for (const workload of workloads) {
  printMeasurement(workload, await measureWorkload(workload));
}
disposeBlotParser();
await resetBlotSyntaxSession();
