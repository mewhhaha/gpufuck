import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import { lazuliSurfaceToFunctionalModule } from "../src/lazuli/functional_adapter.ts";
import { semanticSurfaceFromModule } from "../src/functional/compiler.ts";
import { GpuLazuliSemanticCompiler } from "../src/lazuli/gpu_semantic_compiler.ts";
import type { GpuLazuliCompilationDispatchObservation } from "../src/lazuli/gpu_type_inference_contract.ts";
import { LazuliCompilationStatus } from "../src/lazuli/compiler_shader.ts";
import { LazuliInferenceStatus } from "../src/lazuli/type_inference_shader.ts";

const DEFAULT_SOURCE_PATH = "examples/lazuli-brainfuck/compiler.laz";
const SAMPLE_COUNT = 5;
const BATCH_SIZE = 16;
const BATCH_SCALING_SIZES = [2, 4, 8, 16, 32, 64, 128, 256, 512] as const;
const BATCH_DISPATCH_QUANTUM = 65_536;
const DISPATCH_QUANTA = [4_096, 8_192, 16_384, 65_536] as const;
const MAXIMUM_STEPS = 10_000_000;

interface DispatchProfile {
  readonly elapsedMilliseconds: number;
  readonly phase: "resolution" | "inference" | "complete";
  readonly semanticStatus: number;
  readonly semanticSteps: number;
  readonly inferenceStatus: number;
  readonly inferenceTransitions: number;
  readonly requiredCapacity: number | null;
}

const sourcePath = Deno.args[0] ?? DEFAULT_SOURCE_PATH;
const source = await Deno.readTextFile(sourcePath);
const sourceBytes = new TextEncoder().encode(source).byteLength;

const parseStart = performance.now();
const parsed = parseLazuliSource(source);
const parseAndSurfacePackingMilliseconds = performance.now() - parseStart;
if (!parsed.ok) {
  const diagnostic = parsed.diagnostics[0];
  throw new Error(
    `profile source ${
      JSON.stringify(sourcePath)
    } failed at bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
  );
}

const adapterStart = performance.now();
const functionalModule = lazuliSurfaceToFunctionalModule(parsed.surface, sourceBytes);
const semanticSurface = semanticSurfaceFromModule(functionalModule);
const functionalAdapterMilliseconds = performance.now() - adapterStart;

const warmParseAndSurfacePackingMilliseconds: number[] = [];
const warmFunctionalAdapterMilliseconds: number[] = [];
for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
  const warmParseStart = performance.now();
  const warmParsed = parseLazuliSource(source);
  warmParseAndSurfacePackingMilliseconds.push(performance.now() - warmParseStart);
  if (!warmParsed.ok) throw new Error("profile source stopped parsing during warm samples");
  const warmAdapterStart = performance.now();
  semanticSurfaceFromModule(lazuliSurfaceToFunctionalModule(warmParsed.surface, sourceBytes));
  warmFunctionalAdapterMilliseconds.push(performance.now() - warmAdapterStart);
}

const deviceStart = performance.now();
const adapter = await navigator.gpu.requestAdapter();
if (adapter === null) throw new Error("Lazuli compiler profile could not find a WebGPU adapter");
const device = await adapter.requestDevice();
const deviceInitializationMilliseconds = performance.now() - deviceStart;
try {
  const compilerStart = performance.now();
  const compiler = await GpuLazuliSemanticCompiler.create(device);
  const compilerInitializationMilliseconds = performance.now() - compilerStart;

  const warmupSource = "fn main = 0;";
  const warmupParsed = parseLazuliSource(warmupSource);
  if (!warmupParsed.ok) throw new Error("internal Lazuli profiling warmup did not parse");
  const warmupSurface = semanticSurfaceFromModule(
    lazuliSurfaceToFunctionalModule(
      warmupParsed.surface,
      new TextEncoder().encode(warmupSource).byteLength,
    ),
  );
  const warmupStart = performance.now();
  const warmup = await compiler.compile(
    warmupSurface,
    warmupSource.length,
    { maximumSteps: MAXIMUM_STEPS, maximumStepsPerDispatch: 65_536 },
    undefined,
  );
  const firstDispatchWarmupMilliseconds = performance.now() - warmupStart;
  if (!warmup.ok) throw new Error(warmup.diagnostics[0].message);
  warmup.module.destroy();

  const quantumProfiles: Record<string, unknown> = {};
  for (const maximumStepsPerDispatch of DISPATCH_QUANTA) {
    const samples: number[] = [];
    let representativeDispatches: readonly DispatchProfile[] = [];
    let representativeCoreReadbackMilliseconds = 0;
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      const dispatches: DispatchProfile[] = [];
      let previousDispatch = performance.now();
      const compilationStart = previousDispatch;
      const compilation = await compiler.compile(
        semanticSurface,
        sourceBytes,
        { maximumSteps: MAXIMUM_STEPS, maximumStepsPerDispatch },
        undefined,
        {
          observeDispatch: (observation: GpuLazuliCompilationDispatchObservation) => {
            const now = performance.now();
            dispatches.push({
              elapsedMilliseconds: now - previousDispatch,
              phase: dispatchPhase(observation),
              semanticStatus: observation.semanticStatus,
              semanticSteps: observation.semanticSteps,
              inferenceStatus: observation.inferenceStatus,
              inferenceTransitions: observation.inferenceTransitions,
              requiredCapacity: observation.requiredCapacity === 0xffffffff
                ? null
                : observation.requiredCapacity,
            });
            previousDispatch = now;
          },
        },
      );
      samples.push(performance.now() - compilationStart);
      if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
      if (sample === SAMPLE_COUNT - 1) {
        representativeDispatches = dispatches;
        const readbackStart = performance.now();
        await compilation.module.readCoreNodes();
        representativeCoreReadbackMilliseconds = performance.now() - readbackStart;
      }
      compilation.module.destroy();
    }
    quantumProfiles[maximumStepsPerDispatch] = {
      samplesMilliseconds: samples,
      medianMilliseconds: median(samples),
      representativeDispatches,
      representativeCoreReadbackMilliseconds,
    };
  }

  const scheduledBatchSamplesMilliseconds: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const scheduledBatchStart = performance.now();
    const scheduledBatch = await Promise.all(
      Array.from({ length: BATCH_SIZE }, () =>
        compiler.compile(
          semanticSurface,
          sourceBytes,
          { maximumSteps: MAXIMUM_STEPS, maximumStepsPerDispatch: BATCH_DISPATCH_QUANTUM },
          undefined,
        )),
    );
    scheduledBatchSamplesMilliseconds.push(performance.now() - scheduledBatchStart);
    for (const compilation of scheduledBatch) {
      if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
      compilation.module.destroy();
    }
  }
  const scheduledBatchMilliseconds = median(scheduledBatchSamplesMilliseconds);

  const packedBatchSamplesMilliseconds: number[] = [];
  let packedDispatchLaneCounts: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
    const dispatchLaneCounts: number[] = [];
    const packedBatchStart = performance.now();
    const packedBatch = await compiler.compileBatch(
      Array.from({ length: BATCH_SIZE }, () => ({
        surface: semanticSurface,
        sourceByteLength: sourceBytes,
        maximumSteps: MAXIMUM_STEPS,
        maximumStepsPerDispatch: BATCH_DISPATCH_QUANTUM,
      })),
      undefined,
      { observeDispatch: (laneCount) => dispatchLaneCounts.push(laneCount) },
    );
    packedBatchSamplesMilliseconds.push(performance.now() - packedBatchStart);
    packedDispatchLaneCounts = dispatchLaneCounts;
    for (const compilation of packedBatch) {
      if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
      compilation.module.destroy();
    }
  }
  const packedBatchMilliseconds = median(packedBatchSamplesMilliseconds);

  const packedScaling: {
    readonly programCount: number;
    readonly samplesMilliseconds: readonly number[];
    readonly medianMilliseconds: number;
    readonly millisecondsPerProgram: number;
  }[] = [];
  for (const programCount of BATCH_SCALING_SIZES) {
    const samplesMilliseconds: number[] = [];
    for (let sample = 0; sample < SAMPLE_COUNT; sample++) {
      const start = performance.now();
      const compilations = await compiler.compileBatch(
        Array.from({ length: programCount }, () => ({
          surface: semanticSurface,
          sourceByteLength: sourceBytes,
          maximumSteps: MAXIMUM_STEPS,
          maximumStepsPerDispatch: BATCH_DISPATCH_QUANTUM,
        })),
        undefined,
      );
      samplesMilliseconds.push(performance.now() - start);
      for (const compilation of compilations) {
        if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
        compilation.module.destroy();
      }
    }
    const medianMilliseconds = median(samplesMilliseconds);
    packedScaling.push({
      programCount,
      samplesMilliseconds,
      medianMilliseconds,
      millisecondsPerProgram: medianMilliseconds / programCount,
    });
  }

  console.log(JSON.stringify(
    {
      sourcePath,
      sourceBytes,
      nodeCount: semanticSurface.nodeCount,
      definitionCount: semanticSurface.definitionCount,
      parseAndSurfacePackingMilliseconds,
      warmParseAndSurfacePackingMilliseconds,
      warmParseAndSurfacePackingMedianMilliseconds: median(warmParseAndSurfacePackingMilliseconds),
      functionalAdapterMilliseconds,
      warmFunctionalAdapterMilliseconds,
      warmFunctionalAdapterMedianMilliseconds: median(warmFunctionalAdapterMilliseconds),
      adapter: {
        vendor: adapter.info.vendor,
        architecture: adapter.info.architecture,
        device: adapter.info.device,
        description: adapter.info.description,
        isFallbackAdapter: adapter.info.isFallbackAdapter,
      },
      measurementScope: adapter.info.isFallbackAdapter
        ? "Software fallback adapter; cold JIT and execution timings do not represent hardware GPU performance."
        : "Hardware WebGPU adapter.",
      deviceInitializationMilliseconds,
      compilerInitializationMilliseconds,
      firstDispatchWarmupMilliseconds,
      sampleCount: SAMPLE_COUNT,
      quantumProfiles,
      batch: {
        programCount: BATCH_SIZE,
        maximumStepsPerDispatch: BATCH_DISPATCH_QUANTUM,
        scheduled: {
          samplesMilliseconds: scheduledBatchSamplesMilliseconds,
          medianMilliseconds: scheduledBatchMilliseconds,
          millisecondsPerProgram: scheduledBatchMilliseconds / BATCH_SIZE,
        },
        packed: {
          samplesMilliseconds: packedBatchSamplesMilliseconds,
          medianMilliseconds: packedBatchMilliseconds,
          millisecondsPerProgram: packedBatchMilliseconds / BATCH_SIZE,
          dispatchCount: packedDispatchLaneCounts.length,
          dispatchLaneCounts: packedDispatchLaneCounts,
          throughputRatio: scheduledBatchMilliseconds / packedBatchMilliseconds,
        },
        packedScaling,
      },
    },
    null,
    2,
  ));
} finally {
  device.destroy();
}

function median(samples: readonly number[]): number {
  const ordered = [...samples].sort((left, right) => left - right);
  const middle = ordered[Math.floor(ordered.length / 2)];
  if (middle === undefined) throw new Error("Lazuli profile requires at least one sample");
  return middle;
}

function dispatchPhase(
  observation: GpuLazuliCompilationDispatchObservation,
): DispatchProfile["phase"] {
  if (observation.semanticStatus === LazuliCompilationStatus.Pending) return "resolution";
  if (observation.inferenceStatus === LazuliInferenceStatus.Complete) return "complete";
  return "inference";
}
