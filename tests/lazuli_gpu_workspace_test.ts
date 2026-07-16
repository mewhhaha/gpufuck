import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";

import {
  GpuLazuliCompiler,
  LAZULI_NO_INDEX,
  type LazuliType,
  parseLazuliSource,
  requestWebGpuDevice,
} from "../mod.ts";
import {
  type GpuLazuliCompilationDispatchObservation,
  type GpuLazuliTypeInferenceDispatchObservation,
  type GpuLazuliTypeInferenceWorkspaceCapacities,
  runGpuLazuliTypeInference,
} from "../src/lazuli/gpu_type_inference.ts";
import { GpuLazuliSemanticCompiler } from "../src/lazuli/gpu_semantic_compiler.ts";
import { inferLazuliTypes } from "../src/lazuli/type_inference.ts";
import {
  LAZULI_INFERENCE_ENVIRONMENT_WORD_LENGTH,
  LAZULI_INFERENCE_FRAME_WORD_LENGTH,
  LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH,
  LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
  LAZULI_INFERENCE_REFINEMENT_WORD_LENGTH,
  LAZULI_INFERENCE_STATE_WORD_LENGTH,
  LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH,
  LAZULI_TYPE_INFERENCE_SHADER,
  LazuliInferenceDiagnosticCode,
  LazuliInferenceSchedulerWord,
  LazuliInferenceStatus,
} from "../src/lazuli/type_inference_shader.ts";
import {
  LAZULI_TYPE_SCHEMA_WORD_LENGTH,
  LazuliTypeSchemaMetadataWord,
  LazuliTypeSchemaWord,
} from "../src/lazuli/type_schema_abi.ts";

interface InferenceControls {
  readonly capacities?: GpuLazuliTypeInferenceWorkspaceCapacities;
  readonly maximumStepsPerDispatch?: number;
  readonly signal?: AbortSignal;
  readonly onDispatch?: (observation: GpuLazuliTypeInferenceDispatchObservation) => void;
  readonly mutateMetadataForTest?: (words: Uint32Array) => void;
}

async function runInferenceWithCapacities(
  device: GPUDevice,
  compiler: GpuLazuliCompiler,
  pipeline: GPUComputePipeline,
  source: string,
  controls: InferenceControls,
) {
  const parsing = parseLazuliSource(source);
  ok(parsing.ok, `expected workspace fixture to parse: ${source}`);
  if (!parsing.ok) throw new Error("unreachable");
  const surface = parsing.surface;
  const compilation = await compiler.compile(source);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) throw new Error("unreachable");
  const buffers: GPUBuffer[] = [];
  const inputBuffer = (label: string, words: Uint32Array): GPUBuffer => {
    const buffer = device.createBuffer({
      label,
      size: Math.max(4, words.byteLength),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    if (words.byteLength > 0) {
      device.queue.writeBuffer(buffer, 0, new Uint32Array([...words]).buffer);
    }
    buffers.push(buffer);
    return buffer;
  };
  const observations: GpuLazuliTypeInferenceDispatchObservation[] = [];
  const compilationObservations: GpuLazuliCompilationDispatchObservation[] = [];
  try {
    const result = await runGpuLazuliTypeInference({
      device,
      pipeline,
      surface,
      coreNodeBuffer: compilation.module.nodeBuffer,
      definitionBuffer: compilation.module.definitionBuffer,
      typeBuffer: inputBuffer("Workspace test types", surface.typeWords),
      constructorBuffer: compilation.module.constructorBuffer,
      maximumSteps: 1_000_000,
      maximumStepsPerDispatch: controls.maximumStepsPerDispatch ?? 4_096,
      ...(controls.signal === undefined ? {} : { signal: controls.signal }),
      ...(controls.capacities === undefined
        ? {}
        : { initialWorkspaceCapacities: controls.capacities }),
      ...(controls.mutateMetadataForTest === undefined
        ? {}
        : { mutateMetadataForTest: controls.mutateMetadataForTest }),
      observeDispatch: (observation) => {
        observations.push(observation);
        controls.onDispatch?.(observation);
      },
      observeCompilationDispatch: (observation) => {
        compilationObservations.push(observation);
      },
    });
    return { result, observations, compilationObservations, surface };
  } finally {
    for (const buffer of buffers) buffer.destroy();
    compilation.module.destroy();
  }
}

function shaderMinimumScratchCapacity(source: string): number {
  const parsing = parseLazuliSource(source);
  ok(parsing.ok);
  if (!parsing.ok) throw new Error("unreachable");
  return parsing.surface.definitionCount * 8;
}

function assertSuccessfulInference(
  source: string,
  result: Awaited<ReturnType<typeof runInferenceWithCapacities>>["result"],
): void {
  const parsing = parseLazuliSource(source);
  ok(parsing.ok);
  if (!parsing.ok) throw new Error("unreachable");
  const expected = inferLazuliTypes(parsing.surface);
  ok(expected.ok);
  ok(result.ok, result.ok ? undefined : result.diagnostic.message);
  if (!expected.ok || !result.ok) throw new Error("unreachable");
  deepStrictEqual(result.mainType, expected.mainType);
}

function typeNodeCount(type: LazuliType): number {
  const pending = [type];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) throw new Error("missing inferred type node");
    count++;
    if (current.kind === "tuple") pending.push(current.values[0], current.values[1]);
    if (current.kind === "function") pending.push(current.parameter, current.result);
    if (current.kind === "named") pending.push(...current.arguments);
  }
  return count;
}

Deno.test("GPU inference keeps its ABI-v5 state prefix ahead of the scheduler envelope", () => {
  equal(LAZULI_INFERENCE_STATE_WORD_LENGTH, 72);
  equal(LazuliInferenceSchedulerWord.PreviousSemanticSteps, 72);
  equal(LazuliInferenceSchedulerWord.SemanticState, 73);
  equal(LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH, 97);
});

Deno.test("packed inference falls back only the exhausted lane", async () => {
  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuLazuliSemanticCompiler.create(device);
    const sources = ["let main = (1, true);", "let main = 42;"] as const;
    const inputs = sources.map((source, index) => {
      const parsed = parseLazuliSource(source);
      ok(parsed.ok);
      if (!parsed.ok) throw new Error(`packed workspace fixture ${index} did not parse`);
      return {
        surface: parsed.surface,
        sourceByteLength: new TextEncoder().encode(source).byteLength,
        maximumSteps: 1_000_000,
        maximumStepsPerDispatch: 4_096,
        ...(index === 0 ? { initialWorkspaceCapacities: { output: 1 } } : {}),
      };
    });
    const dispatchLaneCounts: number[] = [];
    const results = await compiler.compileBatch(inputs, undefined, {
      observeDispatch: (laneCount) => dispatchLaneCounts.push(laneCount),
    });
    equal(results.length, 2);
    ok(dispatchLaneCounts.length > 0);
    ok(dispatchLaneCounts.every((laneCount) => laneCount === 2));
    ok(results[0]?.ok);
    ok(results[1]?.ok);
    if (results[0]?.ok) {
      deepStrictEqual(results[0].module.mainType, {
        kind: "tuple",
        values: [{ kind: "integer" }, { kind: "boolean" }],
      });
    }
    if (results[1]?.ok) deepStrictEqual(results[1].module.mainType, { kind: "integer" });
    for (const result of results) if (result.ok) result.module.destroy();
  } finally {
    device.destroy();
  }
});

Deno.test("GPU inference rejects a constructor result root outside the schema table", async () => {
  const device = await requestWebGpuDevice();
  try {
    const shader = device.createShaderModule({
      label: "Lazuli malformed result metadata test shader",
      code: LAZULI_TYPE_INFERENCE_SHADER,
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "Lazuli malformed result metadata test pipeline",
      layout: "auto",
      compute: { module: shader, entryPoint: "infer_lazuli_types" },
    });
    const compiler = await GpuLazuliCompiler.create(device);
    const source = "data Box a = Box(value: a); let main = 0;";
    const { result } = await runInferenceWithCapacities(
      device,
      compiler,
      pipeline,
      source,
      {
        maximumStepsPerDispatch: 1,
        mutateMetadataForTest: (words) => {
          const resultBase = words[
            LazuliTypeSchemaMetadataWord.ConstructorResultRootsOffset
          ];
          ok(resultBase !== undefined);
          words[resultBase] = LAZULI_NO_INDEX;
        },
      },
    );

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.diagnostic.code, "L2101");
    equal(
      result.diagnostic.message,
      'constructor "Box" references invalid result schema 4294967295',
    );
    deepStrictEqual(result.diagnostic.span, { startByte: 13, endByte: 26 });
  } finally {
    device.destroy();
  }
});

Deno.test("GPU inference validates the shape of sentinel-marked constructor results", async () => {
  const device = await requestWebGpuDevice();
  try {
    const shader = device.createShaderModule({
      label: "Lazuli malformed synthetic result shader",
      code: LAZULI_TYPE_INFERENCE_SHADER,
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "Lazuli malformed synthetic result pipeline",
      layout: "auto",
      compute: { module: shader, entryPoint: "infer_lazuli_types" },
    });
    const compiler = await GpuLazuliCompiler.create(device);
    const source = "data Box a = Box(value: a); let main = 0;";
    const { result } = await runInferenceWithCapacities(
      device,
      compiler,
      pipeline,
      source,
      {
        mutateMetadataForTest: (words) => {
          const schemaBase = words[LazuliTypeSchemaMetadataWord.SchemaWordsOffset];
          const resultBase = words[
            LazuliTypeSchemaMetadataWord.ConstructorResultRootsOffset
          ];
          ok(schemaBase !== undefined && resultBase !== undefined);
          const root = words[resultBase];
          ok(root !== undefined && root !== LAZULI_NO_INDEX);
          words[
            schemaBase + root * LAZULI_TYPE_SCHEMA_WORD_LENGTH + LazuliTypeSchemaWord.Tag
          ] = 99;
        },
      },
    );

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.diagnostic.code, "L2101");
    ok(result.diagnostic.message.includes("invalid shape: tag 99"));
    deepStrictEqual(result.diagnostic.span, { startByte: 13, endByte: 26 });
  } finally {
    device.destroy();
  }
});

Deno.test("GPU inference bounds deep types and repeated constructor schemes", async () => {
  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuLazuliCompiler.create(device);

    let nestedValue = "0";
    for (let depth = 0; depth < 140; depth++) nestedValue = `(0, ${nestedValue})`;
    const nestedCompilation = await compiler.compile(`let main = ${nestedValue};`);
    ok(nestedCompilation.ok);
    nestedCompilation.module.destroy();

    let nestedType = "Int";
    for (let depth = 0; depth < 60; depth++) nestedType = `(Int, ${nestedType})`;
    const constructorReferences = Array.from({ length: 60 }, () => "C").join(", ");
    const constructorCompilation = await compiler.compile(
      `data Box = C(field: ${nestedType}); let main = [${constructorReferences}];`,
    );
    ok(constructorCompilation.ok);
    constructorCompilation.module.destroy();

    let duplicatedValue = "1";
    for (let depth = 0; depth < 10; depth++) duplicatedValue = `duplicate (${duplicatedValue})`;
    const expandedOutputCompilation = await compiler.compile(
      `let duplicate = value => (value, value); let main = ${duplicatedValue};`,
    );
    ok(expandedOutputCompilation.ok);
    equal(typeNodeCount(expandedOutputCompilation.module.mainType), 2_047);
    expandedOutputCompilation.module.destroy();
  } finally {
    device.destroy();
  }
});

Deno.test("GPU inference cancels after an observed dispatch and leaves the compiler reusable", async () => {
  const device = await requestWebGpuDevice();
  try {
    const shader = device.createShaderModule({
      label: "Lazuli cancellation test shader",
      code: LAZULI_TYPE_INFERENCE_SHADER,
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "Lazuli cancellation test pipeline",
      layout: "auto",
      compute: { module: shader, entryPoint: "infer_lazuli_types" },
    });
    const compiler = await GpuLazuliCompiler.create(device);
    const source = "let identity = value => value; let main = identity 42;";
    const controller = new AbortController();
    let dispatches = 0;

    await rejects(
      () =>
        runInferenceWithCapacities(device, compiler, pipeline, source, {
          maximumStepsPerDispatch: 1,
          signal: controller.signal,
          onDispatch: () => {
            dispatches++;
            controller.abort(new Error("cancel after observed inference dispatch"));
          },
        }),
      /cancel after observed inference dispatch/,
    );
    equal(dispatches, 1);

    const reused = await compiler.compile(source);
    ok(reused.ok);
    reused.module.destroy();
  } finally {
    device.destroy();
  }
});

Deno.test("GPU inference observer aborts a terminal dispatch before returning output", async () => {
  const device = await requestWebGpuDevice();
  try {
    const shader = device.createShaderModule({
      label: "Lazuli terminal cancellation test shader",
      code: LAZULI_TYPE_INFERENCE_SHADER,
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "Lazuli terminal cancellation test pipeline",
      layout: "auto",
      compute: { module: shader, entryPoint: "infer_lazuli_types" },
    });
    const compiler = await GpuLazuliCompiler.create(device);
    const source = "let main = 42;";
    const controller = new AbortController();
    let terminalDispatches = 0;

    await rejects(
      () =>
        runInferenceWithCapacities(device, compiler, pipeline, source, {
          maximumStepsPerDispatch: 4_096,
          signal: controller.signal,
          onDispatch: (observation) => {
            if (observation.status !== LazuliInferenceStatus.Complete) return;
            terminalDispatches++;
            controller.abort(new Error("cancel terminal inference dispatch"));
          },
        }),
      /cancel terminal inference dispatch/,
    );
    equal(terminalDispatches, 1);

    const reused = await compiler.compile(source);
    ok(reused.ok);
    reused.module.destroy();
  } finally {
    device.destroy();
  }
});

Deno.test("GPU inference observer aborts an exhausted dispatch before arena growth", async () => {
  const device = await requestWebGpuDevice();
  try {
    const shader = device.createShaderModule({
      label: "Lazuli exhausted cancellation test shader",
      code: LAZULI_TYPE_INFERENCE_SHADER,
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "Lazuli exhausted cancellation test pipeline",
      layout: "auto",
      compute: { module: shader, entryPoint: "infer_lazuli_types" },
    });
    const compiler = await GpuLazuliCompiler.create(device);
    const source = "let main = (1, 2);";
    const controller = new AbortController();
    let exhaustedDispatches = 0;

    await rejects(
      () =>
        runInferenceWithCapacities(device, compiler, pipeline, source, {
          capacities: { output: 1 },
          maximumStepsPerDispatch: 1,
          signal: controller.signal,
          onDispatch: (observation) => {
            if (
              observation.status !== LazuliInferenceStatus.Exhausted ||
              observation.errorCode !== LazuliInferenceDiagnosticCode.OutputArenaExhausted
            ) return;
            exhaustedDispatches++;
            controller.abort(new Error("cancel exhausted inference dispatch"));
          },
        }),
      /cancel exhausted inference dispatch/,
    );
    equal(exhaustedDispatches, 1);

    const reused = await compiler.compile(source);
    ok(reused.ok);
    reused.module.destroy();
  } finally {
    device.destroy();
  }
});

Deno.test("GPU inference grows each exhausted arena and preserves inferred types", async () => {
  const device = await requestWebGpuDevice();
  try {
    const shader = device.createShaderModule({
      label: "Lazuli workspace growth test shader",
      code: LAZULI_TYPE_INFERENCE_SHADER,
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "Lazuli workspace growth test pipeline",
      layout: "auto",
      compute: { module: shader, entryPoint: "infer_lazuli_types" },
    });
    const compiler = await GpuLazuliCompiler.create(device);

    const scratchSource = "data Box a = Box(value: a); let main : Box Int = Box 1;";

    const fixtures = [
      {
        name: "type",
        source: "let main = 0;",
        capacities: { type: 1 },
        errorCode: LazuliInferenceDiagnosticCode.TypeArenaExhausted,
        capacity: (observation: GpuLazuliTypeInferenceDispatchObservation) =>
          observation.typeCapacity,
      },
      {
        name: "environment",
        source: "let main = (outer => inner => outer) 1 true;",
        capacities: { environment: 1 },
        errorCode: LazuliInferenceDiagnosticCode.EnvironmentArenaExhausted,
        capacity: (observation: GpuLazuliTypeInferenceDispatchObservation) =>
          observation.environmentCapacity,
      },
      {
        name: "frame",
        source: "let main = (1, 2);",
        capacities: { frame: 1 },
        errorCode: LazuliInferenceDiagnosticCode.FrameArenaExhausted,
        capacity: (observation: GpuLazuliTypeInferenceDispatchObservation) =>
          observation.frameCapacity,
      },
      {
        name: "refinement",
        source:
          "data Equal a b = Refl : Equal a a; let cast : Equal a b -> a -> b = proof => value => case proof of | Refl -> value end; let main = cast Refl 42;",
        capacities: { refinement: 1 },
        errorCode: LazuliInferenceDiagnosticCode.RefinementArenaExhausted,
        capacity: (observation: GpuLazuliTypeInferenceDispatchObservation) =>
          observation.refinementCapacity,
      },
      {
        name: "scratch",
        source: scratchSource,
        capacities: { scratch: shaderMinimumScratchCapacity(scratchSource) },
        errorCode: LazuliInferenceDiagnosticCode.ScratchArenaExhausted,
        capacity: (observation: GpuLazuliTypeInferenceDispatchObservation) =>
          observation.scratchCapacity,
      },
      {
        name: "output",
        source: "let main = (1, 2);",
        capacities: { output: 1 },
        errorCode: LazuliInferenceDiagnosticCode.OutputArenaExhausted,
        capacity: (observation: GpuLazuliTypeInferenceDispatchObservation) =>
          observation.outputCapacity,
      },
    ] as const;

    await Promise.all(fixtures.map(async (fixture) => {
      const { result, observations } = await runInferenceWithCapacities(
        device,
        compiler,
        pipeline,
        fixture.source,
        { capacities: fixture.capacities, maximumStepsPerDispatch: 1 },
      );
      assertSuccessfulInference(fixture.source, result);
      const normalCapacity = await runInferenceWithCapacities(
        device,
        compiler,
        pipeline,
        fixture.source,
        { maximumStepsPerDispatch: 4_096 },
      );
      assertSuccessfulInference(fixture.source, normalCapacity.result);
      equal(
        result.transitions,
        normalCapacity.result.transitions,
        `${fixture.name} growth changed the final semantic transition count`,
      );
      const exhaustedIndex = observations.findIndex((observation) =>
        observation.status === LazuliInferenceStatus.Exhausted &&
        observation.errorCode === fixture.errorCode
      );
      ok(exhaustedIndex >= 0, `${fixture.name} fixture did not exhaust its target arena`);
      const exhausted = observations[exhaustedIndex];
      const resumed = observations[exhaustedIndex + 1];
      ok(exhausted !== undefined && resumed !== undefined);
      equal(
        resumed.transitions,
        exhausted.transitions,
        `${fixture.name} growth consumed semantic fuel`,
      );
      if (fixture.name === "output") {
        ok(fixture.capacity(resumed) >= exhausted.requiredCapacity);
      } else {
        equal(
          fixture.capacity(resumed),
          Math.max(1, fixture.capacity(exhausted) * 2),
          `${fixture.name} arena did not double`,
        );
      }
      equal(
        resumed.typeCapacity,
        fixture.name === "type" ? Math.max(1, exhausted.typeCapacity * 2) : exhausted.typeCapacity,
      );
      equal(
        resumed.environmentCapacity,
        fixture.name === "environment"
          ? Math.max(1, exhausted.environmentCapacity * 2)
          : exhausted.environmentCapacity,
      );
      equal(
        resumed.frameCapacity,
        fixture.name === "frame"
          ? Math.max(1, exhausted.frameCapacity * 2)
          : exhausted.frameCapacity,
      );
      equal(
        resumed.refinementCapacity,
        fixture.name === "refinement"
          ? Math.max(1, exhausted.refinementCapacity * 2)
          : exhausted.refinementCapacity,
      );
      equal(
        resumed.scratchCapacity,
        fixture.name === "scratch"
          ? Math.max(1, exhausted.scratchCapacity * 2)
          : exhausted.scratchCapacity,
      );
      if (fixture.name !== "output") equal(resumed.outputCapacity, exhausted.outputCapacity);
    }));

    const outputFuel = await runInferenceWithCapacities(
      device,
      compiler,
      pipeline,
      "let main = (1, 2);",
      { capacities: { output: 1 }, maximumStepsPerDispatch: 1 },
    );
    const outputExhaustion = outputFuel.observations.findIndex((observation) =>
      observation.errorCode === LazuliInferenceDiagnosticCode.OutputArenaExhausted
    );
    ok(outputExhaustion >= 0);
    const exhausted = outputFuel.observations[outputExhaustion];
    const resumed = outputFuel.observations[outputExhaustion + 1];
    ok(exhausted !== undefined && resumed !== undefined);
    equal(resumed.transitions, exhausted.transitions);

    const maximumStorageWords = Math.floor(
      Math.min(
        device.limits.maxStorageBufferBindingSize,
        device.limits.maxBufferSize,
      ) / Uint32Array.BYTES_PER_ELEMENT,
    );
    const capacityLimits = [
      {
        name: "type",
        capacities: {
          type: Math.floor(maximumStorageWords / LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH) + 1,
        },
      },
      {
        name: "environment",
        capacities: {
          environment: Math.floor(
            maximumStorageWords / LAZULI_INFERENCE_ENVIRONMENT_WORD_LENGTH,
          ) + 1,
        },
      },
      {
        name: "frame",
        capacities: {
          frame: Math.floor(maximumStorageWords / LAZULI_INFERENCE_FRAME_WORD_LENGTH) + 1,
        },
      },
      {
        name: "refinement",
        capacities: {
          refinement: Math.floor(
            maximumStorageWords / LAZULI_INFERENCE_REFINEMENT_WORD_LENGTH,
          ) + 1,
        },
      },
      { name: "scratch", capacities: { scratch: maximumStorageWords + 1 } },
      {
        name: "output",
        capacities: {
          output: Math.floor(maximumStorageWords / LAZULI_INFERENCE_OUTPUT_WORD_LENGTH) + 1,
        },
      },
    ] as const;
    for (const capacityLimit of capacityLimits) {
      const allocationLimit = await runInferenceWithCapacities(
        device,
        compiler,
        pipeline,
        "let main = 0;",
        { capacities: capacityLimit.capacities },
      );
      ok(!allocationLimit.result.ok, `${capacityLimit.name} limit unexpectedly succeeded`);
      if (allocationLimit.result.ok) throw new Error("unreachable");
      equal(allocationLimit.result.diagnostic.code, "L1003");
      ok(allocationLimit.result.diagnostic.message.includes("max"));
    }
  } finally {
    device.destroy();
  }
});

Deno.test("GPU inference transition counts are invariant across dispatch quanta", async () => {
  const sources = [
    "let main = 42;",
    "data Equal a b = Refl : Equal a a; let cast : Equal a b -> a -> b = proof => value => case proof of | Refl -> value end; let main = cast Refl 42;",
    "let identity = value => value; let main = (identity 1, identity true);",
    "fn factorial value = if value == 0 then 1 else value * factorial (value - 1); fn main = factorial 5;",
    "data Box a = Box(value: a); let main : Box Int = Box 1;",
    "data Maybe a = Nothing | Just(value: a); let main = case Just 1 of | Nothing -> 0 | Just(value) -> value end;",
    "let main = case (20, 22) of | (left, right) -> left + right end;",
    "let main = case () of | () -> 42 end;",
    "let increment : Int -> Int = value => value + 1; let main = increment 41;",
    "fn main = let rec count value = if value == 0 then 0 else count (value - 1) in count 4;",
    "fn even value = if value == 0 then true else odd (value - 1); fn odd value = if value == 0 then false else even (value - 1); fn main = even 4;",
    "let constant = value => ignored => value; let main = (constant 1 true, constant true 1);",
    "let main = [1, 2, 3];",
    "data Pair a b = Pair(first: a, second: b); let main = Pair 1 true;",
    "let main = if 1 < 2 then 42 else 0;",
    "let apply = function => value => function value; let main = apply (value => value + 1) 41;",
  ] as const;
  equal(sources.length, 16);

  const device = await requestWebGpuDevice();
  try {
    const shader = device.createShaderModule({
      label: "Lazuli transition invariance test shader",
      code: LAZULI_TYPE_INFERENCE_SHADER,
    });
    const pipeline = await device.createComputePipelineAsync({
      label: "Lazuli transition invariance test pipeline",
      layout: "auto",
      compute: { module: shader, entryPoint: "infer_lazuli_types" },
    });
    const compiler = await GpuLazuliCompiler.create(device);

    const runsByQuantum: Awaited<ReturnType<typeof runInferenceWithCapacities>>[][] = [];
    for (const maximumStepsPerDispatch of [1, 7, 4_096]) {
      runsByQuantum.push(
        await Promise.all(
          sources.map((source) =>
            runInferenceWithCapacities(device, compiler, pipeline, source, {
              maximumStepsPerDispatch,
            })
          ),
        ),
      );
    }
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const source = sources[sourceIndex];
      if (source === undefined) throw new Error(`missing invariance source ${sourceIndex}`);
      const one = runsByQuantum[0]?.[sourceIndex];
      const seven = runsByQuantum[1]?.[sourceIndex];
      const large = runsByQuantum[2]?.[sourceIndex];
      ok(one !== undefined && seven !== undefined && large !== undefined);
      deepStrictEqual(one.result, seven.result, source);
      deepStrictEqual(seven.result, large.result, source);
      equal(one.result.transitions, seven.result.transitions, source);
      equal(seven.result.transitions, large.result.transitions, source);
      const finalObservation = large.compilationObservations.at(-1);
      ok(finalObservation !== undefined, `${source} omitted compilation dispatch observations`);
      equal(finalObservation.inferenceTransitions, large.result.transitions, source);
    }
  } finally {
    device.destroy();
  }
});
