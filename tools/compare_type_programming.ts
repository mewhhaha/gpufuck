import {
  GpuTypeCoreExecutor,
  requestWebGpuDevice,
  type TypeCoreExecutionResult,
  type TypeCoreProgram,
} from "../functional.ts";
import { zigMatrixTypeProgram } from "../examples/type-programming/zig_comptime.ts";
import { zigReflectionProgram } from "../examples/type-programming/zig_reflection_program.ts";

const WARM_SAMPLE_COUNT = 7;
const BATCH_PROGRAM_COUNT = 32;

interface SteadyStateTimingSummary {
  readonly warmMedianMilliseconds: number;
  readonly warmMinimumMilliseconds: number;
  readonly warmMaximumMilliseconds: number;
  readonly batchProgramCount: number;
  readonly batchMilliseconds: number;
  readonly batchMillisecondsPerProgram: number;
}

const deviceStart = performance.now();
const device = await requestWebGpuDevice();
const deviceInitializationMilliseconds = performance.now() - deviceStart;
try {
  const executorStart = performance.now();
  const executor = await GpuTypeCoreExecutor.create(device);
  const gpuExecutorInitializationMilliseconds = performance.now() - executorStart;
  const gpuLazyInitializationStart = performance.now();
  requireSuccessfulTypeCore(
    await executor.execute(zigMatrixTypeProgram()),
    "GPU lazy initialization probe",
  );
  const gpuLazyInitializationMilliseconds = performance.now() - gpuLazyInitializationStart;
  const gpuMatrix = await measureGpuProgram(executor, zigMatrixTypeProgram());
  const gpuReflection = await measureGpuProgram(executor, zigReflectionProgram());
  const zigMatrix = await measureZigSource("examples/type-programming/zig_comptime.zig");
  const zigReflection = await measureZigSource("examples/type-programming/zig_reflection.zig");

  console.log(JSON.stringify(
    {
      gpuInitialization: {
        deviceMilliseconds: deviceInitializationMilliseconds,
        executorMilliseconds: gpuExecutorInitializationMilliseconds,
        lazyPipelineAndFirstMatrixProgramMilliseconds: gpuLazyInitializationMilliseconds,
      },
      warmSampleCount: WARM_SAMPLE_COUNT,
      batchProgramCount: BATCH_PROGRAM_COUNT,
      gpuTypeCoreEndToEnd: {
        matrix: gpuMatrix,
        reflection: gpuReflection,
      },
      nativeZigTest: {
        matrix: zigMatrix,
        reflection: zigReflection,
      },
      comparison:
        "The GPU initialization probe executes the matrix program once and includes lazy shader and pipeline initialization. GPU warm timings include Type Core validation, lowering, GPU semantic compilation, execution, and readback; GPU batches submit programs concurrently. Zig first timings use an empty cache and include process startup, parsing, semantic analysis, code generation, linking, and the test run; Zig batches run warm-cache commands sequentially. Compare these as pipeline and throughput measurements, not equivalent compiler phases.",
    },
    null,
    2,
  ));
} finally {
  device.destroy();
}

async function measureGpuProgram(
  executor: GpuTypeCoreExecutor,
  program: TypeCoreProgram,
): Promise<SteadyStateTimingSummary> {
  const warmMilliseconds: number[] = [];
  for (let sample = 0; sample < WARM_SAMPLE_COUNT; sample++) {
    const start = performance.now();
    requireSuccessfulTypeCore(await executor.execute(program), `warm GPU sample ${sample}`);
    warmMilliseconds.push(performance.now() - start);
  }
  const batchStart = performance.now();
  await Promise.all(Array.from({ length: BATCH_PROGRAM_COUNT }, async (_, programIndex) => {
    requireSuccessfulTypeCore(
      await executor.execute(program),
      `concurrent GPU batch program ${programIndex}`,
    );
  }));
  return steadyStateTimingSummary(warmMilliseconds, performance.now() - batchStart);
}

async function measureZigSource(
  sourcePath: string,
): Promise<SteadyStateTimingSummary & { readonly freshCacheFirstMilliseconds: number }> {
  const cacheRoot = await Deno.makeTempDir({ prefix: "gpufuck-zig-timing-" });
  const cache = `${cacheRoot}/local`;
  const globalCache = `${cacheRoot}/global`;
  try {
    const firstStart = performance.now();
    await runZigTest(sourcePath, cache, globalCache);
    const firstMilliseconds = performance.now() - firstStart;

    const warmMilliseconds: number[] = [];
    for (let sample = 0; sample < WARM_SAMPLE_COUNT; sample++) {
      const start = performance.now();
      await runZigTest(sourcePath, cache, globalCache);
      warmMilliseconds.push(performance.now() - start);
    }
    const batchStart = performance.now();
    for (let program = 0; program < BATCH_PROGRAM_COUNT; program++) {
      await runZigTest(sourcePath, cache, globalCache);
    }
    return {
      freshCacheFirstMilliseconds: firstMilliseconds,
      ...steadyStateTimingSummary(warmMilliseconds, performance.now() - batchStart),
    };
  } finally {
    await Deno.remove(cacheRoot, { recursive: true });
  }
}

async function runZigTest(sourcePath: string, cache: string, globalCache: string): Promise<void> {
  const result = await new Deno.Command("zig", {
    args: [
      "test",
      "--cache-dir",
      cache,
      "--global-cache-dir",
      globalCache,
      sourcePath,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (result.success) return;
  throw new Error(
    `zig test failed for ${JSON.stringify(sourcePath)} with exit code ${result.code}: ${
      new TextDecoder().decode(result.stderr).trim()
    }`,
  );
}

function requireSuccessfulTypeCore(result: TypeCoreExecutionResult, context: string): void {
  if (result.ok) return;
  const reason = result.stage === "compile" ? result.diagnostics[0].message : result.fault.message;
  throw new Error(`${context} failed during ${result.stage}: ${reason}`);
}

function steadyStateTimingSummary(
  warmMilliseconds: readonly number[],
  batchMilliseconds: number,
): SteadyStateTimingSummary {
  const ordered = [...warmMilliseconds].sort((left, right) => left - right);
  const middle = ordered[Math.floor(ordered.length / 2)];
  const minimum = ordered[0];
  const maximum = ordered.at(-1);
  if (middle === undefined || minimum === undefined || maximum === undefined) {
    throw new Error("type-programming timing requires at least one warm sample");
  }
  return {
    warmMedianMilliseconds: middle,
    warmMinimumMilliseconds: minimum,
    warmMaximumMilliseconds: maximum,
    batchProgramCount: BATCH_PROGRAM_COUNT,
    batchMilliseconds,
    batchMillisecondsPerProgram: batchMilliseconds / BATCH_PROGRAM_COUNT,
  };
}
