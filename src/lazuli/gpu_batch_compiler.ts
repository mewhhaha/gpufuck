import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_BYTE_LENGTH,
  LAZULI_DEFINITION_BYTE_LENGTH,
  LAZULI_NO_INDEX,
  LAZULI_NODE_BYTE_LENGTH,
  LAZULI_TYPE_BYTE_LENGTH,
} from "./abi.ts";
import {
  LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH,
  LazuliCompilationInternalStateWord,
  LazuliCompilationStateWord,
  LazuliCompilationStatus,
} from "./compiler_shader.ts";
import { LazuliSemanticCompilerErrorCode } from "./compilation_diagnostics.ts";
import type { LazuliCompileResult } from "./compiler_module.ts";
import {
  batchSemanticFailure,
  finishBatchInferenceResults,
  type TerminalInference,
} from "./gpu_batch_results.ts";
import { readInferenceState, readSemanticState } from "./gpu_type_inference_gpu_io.ts";
import { fuelExhausted } from "./gpu_type_inference_results.ts";
import {
  assertStorageSize,
  checkedProduct,
  createInitialState,
  INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
  inferredTypeOutputByteLength,
  workspaceLayout,
} from "./gpu_type_inference_workspace.ts";
import type {
  GpuLazuliTypeInferenceWorkspaceCapacities,
  WorkspaceLayout,
} from "./gpu_type_inference_contract.ts";
import {
  LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH,
  LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
  LazuliInferenceSchedulerWord,
  type LazuliInferenceShaderMetadata,
  LazuliInferenceStateWord,
  LazuliInferenceStatus,
  prepareLazuliInferenceShaderMetadata,
} from "./type_inference_shader.ts";
import { flattenLazuliTypeSchemas } from "./type_schema_abi.ts";

const WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const FAST_OUTPUT_RECORD_CAPACITY = 64;
const FAST_COMPLETION_MINIMUM_DISPATCH_QUANTUM = 4_096;

export interface LazuliBatchCompilationInput {
  readonly surface: EncodedLazuliSurface;
  readonly sourceByteLength: number;
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
  readonly initialWorkspaceCapacities?: GpuLazuliTypeInferenceWorkspaceCapacities;
}

export interface LazuliBatchCompilationInstrumentation {
  readonly observeDispatch: (laneCount: number) => void;
}

export interface BatchLane extends LazuliBatchCompilationInput {
  readonly resultIndex: number;
  readonly metadata: LazuliInferenceShaderMetadata;
  readonly localWorkspace: WorkspaceLayout;
  readonly nodeBase: number;
  readonly definitionBase: number;
  readonly typeBase: number;
  readonly constructorBase: number;
  readonly metadataBase: number;
  readonly workspaceBase: number;
  readonly outputBase: number;
  readonly fastOutputBase: number;
  readonly fastOutputCapacity: number;
}

export interface BatchModuleBuffers {
  readonly nodes: GPUBuffer;
  readonly definitions: GPUBuffer;
  readonly constructors: GPUBuffer;
}

export async function compileLazuliBatch(
  device: GPUDevice,
  semanticPipeline: GPUComputePipeline,
  inferencePipeline: GPUComputePipeline,
  inputs: readonly LazuliBatchCompilationInput[],
  signal: AbortSignal | undefined,
  compileScalar: (input: LazuliBatchCompilationInput) => Promise<LazuliCompileResult>,
  instrumentation?: LazuliBatchCompilationInstrumentation,
): Promise<readonly LazuliCompileResult[]> {
  signal?.throwIfAborted();
  if (inputs.length === 0) return [];
  if (inputs.length === 1) return [await compileScalar(inputs[0]!)];
  if (inputs.length > device.limits.maxComputeWorkgroupsPerDimension) {
    return await compileSplitBatch(
      device,
      semanticPipeline,
      inferencePipeline,
      inputs,
      signal,
      compileScalar,
      instrumentation,
    );
  }

  let lanes: readonly BatchLane[];
  try {
    lanes = prepareBatchLanes(inputs, device.limits);
  } catch (error) {
    if (error instanceof RangeError) {
      return await compileSplitBatch(
        device,
        semanticPipeline,
        inferencePipeline,
        inputs,
        signal,
        compileScalar,
        instrumentation,
      );
    }
    throw error;
  }

  let packed: readonly (LazuliCompileResult | undefined)[];
  try {
    packed = await runPackedCompilation(
      device,
      semanticPipeline,
      inferencePipeline,
      lanes,
      signal,
      instrumentation,
    );
  } catch (error) {
    if (error instanceof PackedAllocationError) {
      return await compileSplitBatch(
        device,
        semanticPipeline,
        inferencePipeline,
        inputs,
        signal,
        compileScalar,
        instrumentation,
      );
    }
    throw error;
  }

  const results = [...packed];
  try {
    for (const lane of lanes) {
      if (results[lane.resultIndex] !== undefined) continue;
      signal?.throwIfAborted();
      results[lane.resultIndex] = await compileScalar(lane);
    }
  } catch (error) {
    for (const result of results) if (result?.ok) result.module.destroy();
    throw error;
  }
  return completeResults(results);
}

async function compileSplitBatch(
  device: GPUDevice,
  semanticPipeline: GPUComputePipeline,
  inferencePipeline: GPUComputePipeline,
  inputs: readonly LazuliBatchCompilationInput[],
  signal: AbortSignal | undefined,
  compileScalar: (input: LazuliBatchCompilationInput) => Promise<LazuliCompileResult>,
  instrumentation: LazuliBatchCompilationInstrumentation | undefined,
): Promise<readonly LazuliCompileResult[]> {
  if (inputs.length <= 2) return await compileScalars(inputs, compileScalar);
  const middle = Math.floor(inputs.length / 2);
  const compileHalf = (half: readonly LazuliBatchCompilationInput[]) =>
    compileLazuliBatch(
      device,
      semanticPipeline,
      inferencePipeline,
      half,
      signal,
      compileScalar,
      instrumentation,
    );
  const left = await compileHalf(inputs.slice(0, middle));
  try {
    const right = await compileHalf(inputs.slice(middle));
    return [...left, ...right];
  } catch (error) {
    for (const result of left) if (result.ok) result.module.destroy();
    throw error;
  }
}

async function runPackedCompilation(
  device: GPUDevice,
  semanticPipeline: GPUComputePipeline,
  inferencePipeline: GPUComputePipeline,
  lanes: readonly BatchLane[],
  signal: AbortSignal | undefined,
  instrumentation: LazuliBatchCompilationInstrumentation | undefined,
): Promise<readonly (LazuliCompileResult | undefined)[]> {
  const totals = batchTotals(lanes);
  const fastCompletion = lanes.every((lane) =>
    lane.maximumStepsPerDispatch >= FAST_COMPLETION_MINIMUM_DISPATCH_QUANTUM
  );
  const surfaceWords = new Uint32Array(totals.nodes * 8);
  const definitionWords = new Uint32Array(totals.definitions * 4);
  const typeWords = new Uint32Array(totals.types * 5);
  const constructorWords = new Uint32Array(totals.constructors * 5);
  const metadataWords = new Uint32Array(totals.metadataWords);
  const semanticStates = new Uint8Array(
    lanes.length * LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH,
  );
  const inferenceStates = new Uint8Array(lanes.length * INFERENCE_INTERNAL_STATE_BYTE_LENGTH);

  for (const [laneIndex, lane] of lanes.entries()) {
    surfaceWords.set(lane.surface.nodeWords, lane.nodeBase * 8);
    definitionWords.set(lane.surface.definitionWords, lane.definitionBase * 4);
    typeWords.set(lane.surface.typeWords, lane.typeBase * 5);
    constructorWords.set(lane.surface.constructorWords, lane.constructorBase * 5);
    metadataWords.set(lane.metadata.words, lane.metadataBase);
    semanticStates.set(createSemanticState(lane), semanticStateByteOffset(laneIndex));
    inferenceStates.set(createBatchInferenceState(lane), inferenceStateByteOffset(laneIndex));
  }

  let surfaceBuffer: GPUBuffer | undefined;
  let coreBuffer: GPUBuffer | undefined;
  let definitionBuffer: GPUBuffer | undefined;
  let typeBuffer: GPUBuffer | undefined;
  let constructorBuffer: GPUBuffer | undefined;
  let semanticStateBuffer: GPUBuffer | undefined;
  let metadataBuffer: GPUBuffer | undefined;
  let workspaceBuffer: GPUBuffer | undefined;
  let outputBuffer: GPUBuffer | undefined;
  let inferenceStateBuffer: GPUBuffer | undefined;
  let stateReadbackBuffer: GPUBuffer | undefined;
  let preparedModuleBuffers: (BatchModuleBuffers | undefined)[] = [];
  let stateReadbackMapped = false;

  try {
    const buffers = await allocateBatchBuffers(device, lanes, totals);
    surfaceBuffer = buffers.surface;
    coreBuffer = buffers.core;
    definitionBuffer = buffers.definitions;
    typeBuffer = buffers.types;
    constructorBuffer = buffers.constructors;
    semanticStateBuffer = buffers.semanticStates;
    metadataBuffer = buffers.metadata;
    workspaceBuffer = buffers.workspace;
    outputBuffer = buffers.output;
    inferenceStateBuffer = buffers.inferenceStates;
    stateReadbackBuffer = buffers.stateReadback;
    if (fastCompletion) {
      preparedModuleBuffers = await allocateBatchModuleBuffers(device, lanes);
    }

    device.queue.writeBuffer(surfaceBuffer, 0, surfaceWords);
    device.queue.writeBuffer(definitionBuffer, 0, definitionWords);
    if (typeWords.byteLength > 0) device.queue.writeBuffer(typeBuffer, 0, typeWords);
    if (constructorWords.byteLength > 0) {
      device.queue.writeBuffer(constructorBuffer, 0, constructorWords);
    }
    device.queue.writeBuffer(semanticStateBuffer, 0, semanticStates);
    device.queue.writeBuffer(metadataBuffer, 0, metadataWords);
    device.queue.writeBuffer(inferenceStateBuffer, 0, inferenceStates);

    const semanticBindings = device.createBindGroup({
      label: `Lazuli packed semantic bindings (${lanes.length} lanes)`,
      layout: semanticPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: surfaceBuffer } },
        { binding: 1, resource: { buffer: definitionBuffer } },
        { binding: 2, resource: { buffer: typeBuffer } },
        { binding: 3, resource: { buffer: constructorBuffer } },
        { binding: 4, resource: { buffer: coreBuffer } },
        { binding: 5, resource: { buffer: semanticStateBuffer } },
      ],
    });
    const inferenceBindings = device.createBindGroup({
      label: `Lazuli packed inference bindings (${lanes.length} lanes)`,
      layout: inferencePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: coreBuffer } },
        { binding: 1, resource: { buffer: definitionBuffer } },
        { binding: 2, resource: { buffer: typeBuffer } },
        { binding: 3, resource: { buffer: constructorBuffer } },
        { binding: 4, resource: { buffer: metadataBuffer } },
        { binding: 5, resource: { buffer: workspaceBuffer } },
        { binding: 6, resource: { buffer: outputBuffer } },
        { binding: 7, resource: { buffer: inferenceStateBuffer } },
      ],
    });

    const results: (LazuliCompileResult | undefined)[] = new Array(lanes.length);
    const terminalInference: (TerminalInference | undefined)[] = new Array(lanes.length);
    const terminalOutputs: (ArrayBuffer | undefined)[] = new Array(lanes.length);
    const previousSemanticSteps = new Uint32Array(lanes.length);
    const previousInferenceTransitions = new Uint32Array(lanes.length);
    let terminalLaneCount = 0;

    while (terminalLaneCount < lanes.length) {
      signal?.throwIfAborted();
      await dispatchBatch(
        device,
        semanticPipeline,
        semanticBindings,
        inferencePipeline,
        inferenceBindings,
        semanticStateBuffer,
        inferenceStateBuffer,
        stateReadbackBuffer,
        outputBuffer,
        coreBuffer,
        definitionBuffer,
        constructorBuffer,
        lanes,
        preparedModuleBuffers,
        fastCompletion,
        signal,
      );
      instrumentation?.observeDispatch(lanes.length);
      try {
        await stateReadbackBuffer.mapAsync(GPUMapMode.READ);
      } catch (cause) {
        throw new Error(`could not read ${lanes.length} packed Lazuli compiler states`, { cause });
      }
      stateReadbackMapped = true;
      const stateBytes = stateReadbackBuffer.getMappedRange().slice(0);
      stateReadbackBuffer.unmap();
      stateReadbackMapped = false;
      signal?.throwIfAborted();
      const stateView = new DataView(stateBytes);

      for (const [laneIndex, lane] of lanes.entries()) {
        if (results[lane.resultIndex] !== undefined || terminalInference[laneIndex] !== undefined) {
          continue;
        }
        const inferenceOffset = inferenceStateByteOffset(laneIndex);
        const inferenceState = readInferenceState(stateView, inferenceOffset);
        const semanticState = readSemanticState(
          stateView,
          inferenceOffset + LazuliInferenceSchedulerWord.SemanticState * WORD_BYTES,
        );
        const semanticProgress = semanticState.totalSteps - previousSemanticSteps[laneIndex]!;
        const inferenceProgress = inferenceState.transitions -
          previousInferenceTransitions[laneIndex]!;
        const progress = semanticProgress + inferenceProgress;
        if (
          semanticProgress < 0 || inferenceProgress < 0 || progress < 1 ||
          progress > lane.maximumStepsPerDispatch ||
          (semanticState.status !== LazuliCompilationStatus.Ok && inferenceProgress !== 0)
        ) {
          throw new Error(
            `GPU Lazuli packed lane ${lane.resultIndex} returned invalid progress: semantic=${semanticState.totalSteps}, previousSemantic=${
              previousSemanticSteps[laneIndex]
            }, inference=${inferenceState.transitions}, previousInference=${
              previousInferenceTransitions[laneIndex]
            }, quantum=${lane.maximumStepsPerDispatch}`,
          );
        }
        previousSemanticSteps[laneIndex] = semanticState.totalSteps;
        previousInferenceTransitions[laneIndex] = inferenceState.transitions;

        if (semanticState.status === LazuliCompilationStatus.Pending) continue;
        if (semanticState.status !== LazuliCompilationStatus.Ok) {
          results[lane.resultIndex] = batchSemanticFailure(lane, semanticState);
          terminalLaneCount++;
          continue;
        }

        const totalSteps = semanticState.totalSteps + inferenceState.transitions;
        if (
          inferenceState.status === LazuliInferenceStatus.Uninitialized ||
          inferenceState.status === LazuliInferenceStatus.Pending
        ) {
          if (totalSteps < lane.maximumSteps) continue;
          const exhausted = fuelExhausted(
            batchInferenceOptions(device, inferencePipeline, lane, buffers),
            inferenceState.transitions,
            semanticState.totalSteps,
          );
          if (exhausted.ok) {
            throw new Error(
              `fuel exhaustion unexpectedly succeeded for packed lane ${lane.resultIndex}`,
            );
          }
          results[lane.resultIndex] = {
            ok: false,
            diagnostics: [exhausted.diagnostic],
          };
          terminalLaneCount++;
          continue;
        }
        if (
          inferenceState.status === LazuliInferenceStatus.Complete ||
          inferenceState.status === LazuliInferenceStatus.Diagnostic
        ) {
          terminalInference[laneIndex] = { state: inferenceState, semanticState };
          if (
            fastCompletion &&
            inferenceState.status === LazuliInferenceStatus.Complete &&
            inferenceState.outputCount <= lane.fastOutputCapacity
          ) {
            const outputByteLength = inferredTypeOutputByteLength(inferenceState.outputCount);
            const outputByteOffset = fastOutputByteOffset(lanes.length, lane);
            terminalOutputs[laneIndex] = stateBytes.slice(
              outputByteOffset,
              outputByteOffset + outputByteLength,
            );
          }
          terminalLaneCount++;
          continue;
        }
        if (inferenceState.status === LazuliInferenceStatus.Exhausted) {
          terminalLaneCount++;
          continue;
        }
        if (inferenceState.status === LazuliInferenceStatus.InvalidInput) {
          throw new Error(
            `GPU Lazuli packed lane ${lane.resultIndex} rejected the supplied ABI: code=${inferenceState.errorCode}, detail=${inferenceState.errorDetail}`,
          );
        }
        throw new Error(
          `GPU Lazuli packed lane ${lane.resultIndex} returned unknown inference status ${inferenceState.status}`,
        );
      }
    }

    await finishBatchInferenceResults(
      device,
      lanes,
      terminalInference,
      terminalOutputs,
      preparedModuleBuffers,
      results,
      workspaceBuffer,
      outputBuffer,
      coreBuffer,
      definitionBuffer,
      constructorBuffer,
    );
    return results;
  } finally {
    if (stateReadbackMapped) stateReadbackBuffer?.unmap();
    surfaceBuffer?.destroy();
    coreBuffer?.destroy();
    definitionBuffer?.destroy();
    typeBuffer?.destroy();
    constructorBuffer?.destroy();
    semanticStateBuffer?.destroy();
    metadataBuffer?.destroy();
    workspaceBuffer?.destroy();
    outputBuffer?.destroy();
    inferenceStateBuffer?.destroy();
    stateReadbackBuffer?.destroy();
    for (const buffers of preparedModuleBuffers) destroyModuleBuffers(buffers);
  }
}

function prepareBatchLanes(
  inputs: readonly LazuliBatchCompilationInput[],
  limits: GPUSupportedLimits,
): readonly BatchLane[] {
  let nodes = 0;
  let definitions = 0;
  let types = 0;
  let constructors = 0;
  let metadataWords = 0;
  let workspaceWords = 0;
  let outputRecords = 0;
  let fastOutputRecords = 0;
  const lanes = inputs.map((input, resultIndex): BatchLane => {
    const metadata = prepareLazuliInferenceShaderMetadata(
      input.surface,
      flattenLazuliTypeSchemas(input.surface),
    );
    const localWorkspace = workspaceLayout(
      input.surface,
      metadata.schemaNodeCount,
      metadata.typeParameterCount,
      limits,
      input.initialWorkspaceCapacities,
    );
    const lane = {
      ...input,
      resultIndex,
      metadata,
      localWorkspace,
      nodeBase: nodes,
      definitionBase: definitions,
      typeBase: types,
      constructorBase: constructors,
      metadataBase: metadataWords,
      workspaceBase: workspaceWords,
      outputBase: outputRecords,
      fastOutputBase: fastOutputRecords,
      fastOutputCapacity: Math.min(
        localWorkspace.outputCapacity,
        FAST_OUTPUT_RECORD_CAPACITY,
      ),
    };
    nodes = checkedSum("packed node count", nodes, input.surface.nodeCount);
    definitions = checkedSum(
      "packed definition count",
      definitions,
      input.surface.definitionCount,
    );
    types = checkedSum("packed type count", types, input.surface.typeCount);
    constructors = checkedSum(
      "packed constructor count",
      constructors,
      input.surface.constructorCount,
    );
    metadataWords = checkedSum("packed metadata words", metadataWords, metadata.words.length);
    workspaceWords = checkedSum(
      "packed workspace words",
      workspaceWords,
      localWorkspace.workspaceWordLength,
    );
    outputRecords = checkedSum(
      "packed output records",
      outputRecords,
      localWorkspace.outputCapacity,
    );
    fastOutputRecords = checkedSum(
      "packed fast output records",
      fastOutputRecords,
      lane.fastOutputCapacity,
    );
    return lane;
  });
  assertBatchStorage("surface nodes", nodes, 8, limits);
  assertBatchStorage("core nodes", nodes, 8, limits);
  assertBatchStorage("definitions", definitions, 4, limits);
  assertBatchStorage("algebraic types", types, 5, limits);
  assertBatchStorage("constructors", constructors, 5, limits);
  assertStorageSize("packed inference metadata", metadataWords, limits);
  assertStorageSize("packed inference workspace", workspaceWords, limits);
  assertBatchStorage(
    "inference output",
    outputRecords,
    LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
    limits,
  );
  assertBatchStorage(
    "semantic states",
    lanes.length,
    LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH / WORD_BYTES,
    limits,
  );
  assertBatchStorage(
    "inference states",
    lanes.length,
    LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH,
    limits,
  );
  assertStorageSize(
    "packed state and fast output readback",
    checkedSum(
      "packed state and fast output readback words",
      checkedProduct(
        "packed inference state readback words",
        lanes.length,
        LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH,
      ),
      checkedProduct(
        "packed fast output readback words",
        fastOutputRecords,
        LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
      ),
    ),
    limits,
  );
  return lanes;
}

function createSemanticState(lane: BatchLane): Uint8Array {
  const bytes = new Uint8Array(LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH);
  const view = new DataView(bytes.buffer);
  const set = (word: number, value: number) => view.setUint32(word * WORD_BYTES, value, true);
  set(LazuliCompilationStateWord.NodeCount, lane.surface.nodeCount);
  set(LazuliCompilationStateWord.DefinitionCount, lane.surface.definitionCount);
  set(LazuliCompilationStateWord.TypeCount, lane.surface.typeCount);
  set(LazuliCompilationStateWord.ConstructorCount, lane.surface.constructorCount);
  set(LazuliCompilationStateWord.EntrySymbol, lane.surface.mainSymbol);
  set(LazuliCompilationStateWord.ErrorCode, LazuliSemanticCompilerErrorCode.None);
  set(LazuliCompilationStateWord.ErrorSource, LAZULI_NO_INDEX);
  set(LazuliCompilationStateWord.ErrorDetail, LAZULI_NO_INDEX);
  set(LazuliCompilationStateWord.EntryDefinition, LAZULI_NO_INDEX);
  set(LazuliCompilationStateWord.MaximumSteps, lane.maximumSteps);
  set(LazuliCompilationStateWord.MaximumStepsPerDispatch, lane.maximumStepsPerDispatch);
  set(LazuliCompilationInternalStateWord.SurfaceNodeBase, lane.nodeBase);
  set(LazuliCompilationInternalStateWord.DefinitionBase, lane.definitionBase);
  set(LazuliCompilationInternalStateWord.AlgebraicTypeBase, lane.typeBase);
  set(LazuliCompilationInternalStateWord.ConstructorBase, lane.constructorBase);
  set(LazuliCompilationInternalStateWord.CoreNodeBase, lane.nodeBase);
  set(LazuliCompilationInternalStateWord.InferenceOutputBase, lane.outputBase);
  return bytes;
}

function createBatchInferenceState(lane: BatchLane): Uint8Array {
  const relocatedWorkspace = relocateWorkspace(lane.localWorkspace, lane.workspaceBase);
  const state = new Uint8Array(createInitialState(
    {
      surface: lane.surface,
      maximumSteps: lane.maximumSteps,
      maximumStepsPerDispatch: lane.maximumStepsPerDispatch,
    },
    lane.metadata,
    relocatedWorkspace,
    false,
  ));
  const view = new DataView(state.buffer, state.byteOffset, state.byteLength);
  const relocate = (word: number, base: number) =>
    view.setUint32(word * WORD_BYTES, lane.metadataBase + base, true);
  relocate(
    LazuliInferenceStateWord.DefinitionAnnotationBase,
    lane.metadata.definitionAnnotationBase,
  );
  relocate(LazuliInferenceStateWord.SchemaBase, lane.metadata.schemaBase);
  relocate(LazuliInferenceStateWord.TypeParameterBase, lane.metadata.typeParameterBase);
  relocate(
    LazuliInferenceStateWord.TypeParameterOffsetsBase,
    lane.metadata.typeParameterOffsetsBase,
  );
  relocate(LazuliInferenceStateWord.ConstructorFieldBase, lane.metadata.constructorFieldBase);
  relocate(
    LazuliInferenceStateWord.ConstructorFieldOffsetsBase,
    lane.metadata.constructorFieldOffsetsBase,
  );
  relocate(LazuliInferenceStateWord.ConstructorResultBase, lane.metadata.constructorResultBase);
  return state;
}

function relocateWorkspace(layout: WorkspaceLayout, base: number): WorkspaceLayout {
  return {
    ...layout,
    typeBase: base + layout.typeBase,
    environmentBase: base + layout.environmentBase,
    frameBase: base + layout.frameBase,
    refinementBase: base + layout.refinementBase,
    scratchBase: base + layout.scratchBase,
  };
}

interface BatchTotals {
  readonly nodes: number;
  readonly definitions: number;
  readonly types: number;
  readonly constructors: number;
  readonly metadataWords: number;
  readonly workspaceWords: number;
  readonly outputRecords: number;
  readonly fastOutputRecords: number;
}

function batchTotals(lanes: readonly BatchLane[]): BatchTotals {
  const last = lanes.at(-1)!;
  return {
    nodes: last.nodeBase + last.surface.nodeCount,
    definitions: last.definitionBase + last.surface.definitionCount,
    types: last.typeBase + last.surface.typeCount,
    constructors: last.constructorBase + last.surface.constructorCount,
    metadataWords: last.metadataBase + last.metadata.words.length,
    workspaceWords: last.workspaceBase + last.localWorkspace.workspaceWordLength,
    outputRecords: last.outputBase + last.localWorkspace.outputCapacity,
    fastOutputRecords: last.fastOutputBase + last.fastOutputCapacity,
  };
}

interface BatchBuffers {
  readonly surface: GPUBuffer;
  readonly core: GPUBuffer;
  readonly definitions: GPUBuffer;
  readonly types: GPUBuffer;
  readonly constructors: GPUBuffer;
  readonly semanticStates: GPUBuffer;
  readonly metadata: GPUBuffer;
  readonly workspace: GPUBuffer;
  readonly output: GPUBuffer;
  readonly inferenceStates: GPUBuffer;
  readonly stateReadback: GPUBuffer;
}

async function allocateBatchBuffers(
  device: GPUDevice,
  lanes: readonly BatchLane[],
  totals: BatchTotals,
): Promise<BatchBuffers> {
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  let buffers: BatchBuffers | undefined;
  const created: GPUBuffer[] = [];
  let cause: unknown;
  try {
    const create = (label: string, size: number, usage: number) => {
      const buffer = device.createBuffer({
        label,
        size: Math.max(WORD_BYTES, size),
        usage,
      });
      created.push(buffer);
      return buffer;
    };
    buffers = {
      surface: create(
        "Lazuli packed surface nodes",
        Math.max(LAZULI_NODE_BYTE_LENGTH, totals.nodes * LAZULI_NODE_BYTE_LENGTH),
        GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
      ),
      core: create(
        "Lazuli packed core nodes",
        Math.max(LAZULI_NODE_BYTE_LENGTH, totals.nodes * LAZULI_NODE_BYTE_LENGTH),
        GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      ),
      definitions: create(
        "Lazuli packed definitions",
        Math.max(
          LAZULI_DEFINITION_BYTE_LENGTH,
          totals.definitions * LAZULI_DEFINITION_BYTE_LENGTH,
        ),
        GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      ),
      types: create(
        "Lazuli packed algebraic types",
        Math.max(LAZULI_TYPE_BYTE_LENGTH, totals.types * LAZULI_TYPE_BYTE_LENGTH),
        GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
      ),
      constructors: create(
        "Lazuli packed constructors",
        Math.max(
          LAZULI_CONSTRUCTOR_BYTE_LENGTH,
          totals.constructors * LAZULI_CONSTRUCTOR_BYTE_LENGTH,
        ),
        GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      ),
      semanticStates: create(
        "Lazuli packed semantic states",
        lanes.length * LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      ),
      metadata: create(
        "Lazuli packed inference metadata",
        totals.metadataWords * WORD_BYTES,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
      ),
      workspace: create(
        "Lazuli packed inference workspace",
        totals.workspaceWords * WORD_BYTES,
        GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      ),
      output: create(
        "Lazuli packed inferred types",
        totals.outputRecords * LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES,
        GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      ),
      inferenceStates: create(
        "Lazuli packed inference states",
        lanes.length * INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      ),
      stateReadback: create(
        "Lazuli packed state readback",
        lanes.length * INFERENCE_INTERNAL_STATE_BYTE_LENGTH +
          totals.fastOutputRecords * LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      ),
    };
  } catch (error) {
    cause = error;
  }
  const outOfMemory = await device.popErrorScope();
  const validation = await device.popErrorScope();
  if (outOfMemory !== null || validation !== null || buffers === undefined) {
    for (const buffer of created) buffer.destroy();
    if (validation !== null) {
      throw new Error(
        `WebGPU rejected packed Lazuli compiler buffers for ${lanes.length} lanes: ${validation.message}`,
        cause === undefined ? undefined : { cause },
      );
    }
    throw new PackedAllocationError(
      `could not allocate packed Lazuli compiler buffers for ${lanes.length} lanes${
        outOfMemory === null ? "" : `: ${outOfMemory.message}`
      }`,
      cause,
    );
  }
  return buffers;
}

async function allocateBatchModuleBuffers(
  device: GPUDevice,
  lanes: readonly BatchLane[],
): Promise<BatchModuleBuffers[]> {
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  const buffers: BatchModuleBuffers[] = [];
  const created: GPUBuffer[] = [];
  let cause: unknown;
  try {
    for (const lane of lanes) {
      const nodes = device.createBuffer({
        label: `Lazuli packed lane ${lane.resultIndex} core nodes`,
        size: Math.max(LAZULI_NODE_BYTE_LENGTH, lane.surface.nodeCount * LAZULI_NODE_BYTE_LENGTH),
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      });
      created.push(nodes);
      const definitions = device.createBuffer({
        label: `Lazuli packed lane ${lane.resultIndex} definitions`,
        size: Math.max(
          LAZULI_DEFINITION_BYTE_LENGTH,
          lane.surface.definitionCount * LAZULI_DEFINITION_BYTE_LENGTH,
        ),
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      });
      created.push(definitions);
      const constructors = device.createBuffer({
        label: `Lazuli packed lane ${lane.resultIndex} constructors`,
        size: Math.max(
          LAZULI_CONSTRUCTOR_BYTE_LENGTH,
          lane.surface.constructorCount * LAZULI_CONSTRUCTOR_BYTE_LENGTH,
        ),
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
      });
      created.push(constructors);
      buffers.push({ nodes, definitions, constructors });
    }
  } catch (error) {
    cause = error;
  }
  const outOfMemory = await device.popErrorScope();
  const validation = await device.popErrorScope();
  if (outOfMemory !== null || validation !== null || buffers.length !== lanes.length) {
    for (const buffer of created) buffer.destroy();
    if (validation !== null) {
      throw new Error(
        `WebGPU rejected packed Lazuli module buffers for ${lanes.length} lanes: ${validation.message}`,
        cause === undefined ? undefined : { cause },
      );
    }
    throw new PackedAllocationError(
      `could not allocate packed Lazuli module buffers for ${lanes.length} lanes${
        outOfMemory === null ? "" : `: ${outOfMemory.message}`
      }`,
      cause,
    );
  }
  return buffers;
}

async function dispatchBatch(
  device: GPUDevice,
  semanticPipeline: GPUComputePipeline,
  semanticBindings: GPUBindGroup,
  inferencePipeline: GPUComputePipeline,
  inferenceBindings: GPUBindGroup,
  semanticStateBuffer: GPUBuffer,
  inferenceStateBuffer: GPUBuffer,
  stateReadbackBuffer: GPUBuffer,
  outputBuffer: GPUBuffer,
  coreBuffer: GPUBuffer,
  definitionBuffer: GPUBuffer,
  constructorBuffer: GPUBuffer,
  lanes: readonly BatchLane[],
  moduleBuffers: readonly (BatchModuleBuffers | undefined)[],
  fastCompletion: boolean,
  signal: AbortSignal | undefined,
): Promise<void> {
  const laneCount = lanes.length;
  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    const commands = device.createCommandEncoder({
      label: `Compile Lazuli packed batch (${laneCount} lanes)`,
    });
    const semanticPass = commands.beginComputePass({ label: "Resolve packed Lazuli lanes" });
    semanticPass.setPipeline(semanticPipeline);
    semanticPass.setBindGroup(0, semanticBindings);
    semanticPass.dispatchWorkgroups(laneCount);
    semanticPass.end();
    for (let laneIndex = 0; laneIndex < laneCount; laneIndex++) {
      commands.copyBufferToBuffer(
        semanticStateBuffer,
        semanticStateByteOffset(laneIndex),
        inferenceStateBuffer,
        inferenceStateByteOffset(laneIndex) +
          LazuliInferenceSchedulerWord.SemanticState * WORD_BYTES,
        24 * WORD_BYTES,
      );
    }
    const inferencePass = commands.beginComputePass({ label: "Infer packed Lazuli lanes" });
    inferencePass.setPipeline(inferencePipeline);
    inferencePass.setBindGroup(0, inferenceBindings);
    inferencePass.dispatchWorkgroups(laneCount);
    inferencePass.end();
    commands.copyBufferToBuffer(
      inferenceStateBuffer,
      0,
      stateReadbackBuffer,
      0,
      laneCount * INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
    );
    if (fastCompletion) {
      for (const [laneIndex, lane] of lanes.entries()) {
        const destination = moduleBuffers[laneIndex];
        if (destination === undefined) {
          throw new Error(`Lazuli packed lane ${lane.resultIndex} omitted fast module buffers`);
        }
        const fastOutputByteLength = lane.fastOutputCapacity *
          LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES;
        if (fastOutputByteLength > 0) {
          commands.copyBufferToBuffer(
            outputBuffer,
            lane.outputBase * LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES,
            stateReadbackBuffer,
            fastOutputByteOffset(laneCount, lane),
            fastOutputByteLength,
          );
        }
        if (lane.surface.nodeCount > 0) {
          commands.copyBufferToBuffer(
            coreBuffer,
            lane.nodeBase * LAZULI_NODE_BYTE_LENGTH,
            destination.nodes,
            0,
            lane.surface.nodeCount * LAZULI_NODE_BYTE_LENGTH,
          );
        }
        if (lane.surface.definitionCount > 0) {
          commands.copyBufferToBuffer(
            definitionBuffer,
            lane.definitionBase * LAZULI_DEFINITION_BYTE_LENGTH,
            destination.definitions,
            0,
            lane.surface.definitionCount * LAZULI_DEFINITION_BYTE_LENGTH,
          );
        }
        if (lane.surface.constructorCount > 0) {
          commands.copyBufferToBuffer(
            constructorBuffer,
            lane.constructorBase * LAZULI_CONSTRUCTOR_BYTE_LENGTH,
            destination.constructors,
            0,
            lane.surface.constructorCount * LAZULI_CONSTRUCTOR_BYTE_LENGTH,
          );
        }
      }
    }
    signal?.throwIfAborted();
    device.queue.submit([commands.finish()]);
    validation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected packed Lazuli compilation for ${laneCount} lanes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    throw new Error(
      `WebGPU rejected packed Lazuli compilation for ${laneCount} lanes: ${validationError.message}`,
    );
  }
}

function batchInferenceOptions(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  lane: BatchLane,
  buffers: BatchBuffers,
) {
  return {
    device,
    pipeline,
    surface: lane.surface,
    maximumSteps: lane.maximumSteps,
    maximumStepsPerDispatch: lane.maximumStepsPerDispatch,
    sourceByteLength: lane.sourceByteLength,
    coreNodeBuffer: buffers.core,
    definitionBuffer: buffers.definitions,
    typeBuffer: buffers.types,
    constructorBuffer: buffers.constructors,
  };
}

async function compileScalars(
  inputs: readonly LazuliBatchCompilationInput[],
  compileScalar: (input: LazuliBatchCompilationInput) => Promise<LazuliCompileResult>,
): Promise<readonly LazuliCompileResult[]> {
  const outcomes = await Promise.allSettled(inputs.map(compileScalar));
  const results: LazuliCompileResult[] = [];
  let firstRejection: unknown;
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      firstRejection ??= outcome.reason;
      continue;
    }
    results.push(outcome.value);
  }
  if (firstRejection !== undefined) {
    for (const result of results) if (result.ok) result.module.destroy();
    throw firstRejection;
  }
  return results;
}

function completeResults(
  results: readonly (LazuliCompileResult | undefined)[],
): readonly LazuliCompileResult[] {
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`Lazuli packed compilation omitted result ${index}`);
    return result;
  });
}

function assertBatchStorage(
  name: string,
  records: number,
  wordsPerRecord: number,
  limits: GPUSupportedLimits,
): void {
  assertStorageSize(name, checkedProduct(`${name} words`, records, wordsPerRecord), limits);
}

function checkedSum(name: string, left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0 || result > LAZULI_NO_INDEX) {
    throw new RangeError(`${name} cannot be represented as a u32: ${left} + ${right}`);
  }
  return result;
}

function semanticStateByteOffset(laneIndex: number): number {
  return laneIndex * LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH;
}

function inferenceStateByteOffset(laneIndex: number): number {
  return laneIndex * INFERENCE_INTERNAL_STATE_BYTE_LENGTH;
}

function fastOutputByteOffset(laneCount: number, lane: BatchLane): number {
  return laneCount * INFERENCE_INTERNAL_STATE_BYTE_LENGTH +
    lane.fastOutputBase * LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES;
}

function destroyModuleBuffers(buffers: BatchModuleBuffers | undefined): void {
  buffers?.nodes.destroy();
  buffers?.definitions.destroy();
  buffers?.constructors.destroy();
}

class PackedAllocationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PackedAllocationError";
  }
}
