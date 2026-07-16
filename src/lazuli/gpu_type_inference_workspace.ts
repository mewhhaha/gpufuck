import { type EncodedLazuliSurface, LAZULI_NO_INDEX } from "./abi.ts";
import { LazuliCompilationStateWord, LazuliCompilationStatus } from "./compiler_shader.ts";
import type {
  GpuLazuliTypeInferenceOptions,
  GpuLazuliTypeInferenceWorkspaceCapacities,
  InferenceStateSnapshot,
  WorkspaceCapacities,
  WorkspaceLayout,
} from "./gpu_type_inference_contract.ts";
import {
  LAZULI_INFERENCE_ENVIRONMENT_WORD_LENGTH,
  LAZULI_INFERENCE_FRAME_WORD_LENGTH,
  LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH,
  LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
  LAZULI_INFERENCE_REFINEMENT_WORD_LENGTH,
  LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH,
  LazuliInferenceDiagnosticCode,
  LazuliInferenceSchedulerWord,
  LazuliInferenceStateWord,
  LazuliInferenceStatus,
  type prepareLazuliInferenceShaderMetadata,
} from "./type_inference_shader.ts";

const WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const MAXIMUM_CONSTRUCTOR_ARITY = 64;
export const INITIAL_INFERENCE_OUTPUT_RECORD_CAPACITY = 64;
const INITIAL_TYPE_RECORDS_PER_INPUT = 4;
const INITIAL_MINIMUM_FRAME_CAPACITY = 64;
export const INFERENCE_INTERNAL_STATE_BYTE_LENGTH = LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH *
  WORD_BYTES;
// Staged output copies need a substantial dispatch quantum to amortize their bandwidth cost.
const COMBINED_READBACK_MINIMUM_DISPATCH_TRANSITIONS = 256;

export function validateFuel(
  maximumSteps: number,
  maximumStepsPerDispatch: number,
  initialSteps: number,
): void {
  for (
    const [name, value] of [
      ["maximumSteps", maximumSteps],
      ["maximumStepsPerDispatch", maximumStepsPerDispatch],
      ["initialSteps", initialSteps],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`${name} must be an unsigned 32-bit integer; received ${value}`);
    }
  }
  if (maximumStepsPerDispatch === 0) {
    throw new RangeError("maximumStepsPerDispatch must be at least 1");
  }
  if (initialSteps > maximumSteps) {
    throw new RangeError(
      `initialSteps=${initialSteps} already exceeds maximumSteps=${maximumSteps}`,
    );
  }
}

export function workspaceLayout(
  surface: EncodedLazuliSurface,
  schemaNodeCount: number,
  typeParameterCount: number,
  limits: GPUSupportedLimits,
  overrides: GpuLazuliTypeInferenceWorkspaceCapacities | undefined,
): WorkspaceLayout {
  const inferenceInputs = checkedSum(
    "inference input count",
    surface.nodeCount,
    surface.definitionCount,
    surface.typeCount,
    surface.constructorCount,
    schemaNodeCount,
    1,
  );
  const defaultTypeCapacity = checkedProduct(
    "type arena capacity",
    inferenceInputs,
    INITIAL_TYPE_RECORDS_PER_INPUT,
  );
  const defaultEnvironmentCapacity = checkedProduct(
    "environment arena capacity",
    checkedSum("environment input count", surface.nodeCount, surface.definitionCount, 1),
    2,
  );
  const defaultFrameCapacity = Math.max(
    INITIAL_MINIMUM_FRAME_CAPACITY,
    checkedProduct(
      "frame arena capacity",
      checkedSum("frame input count", surface.nodeCount, surface.definitionCount, 1),
      1,
    ),
  );
  const defaultRefinementCapacity = checkedProduct(
    "refinement arena capacity",
    inferenceInputs,
    4,
  );
  const schemaScratchCapacity = checkedSum(
    "schema scratch capacity",
    checkedProduct("schema parameter mapping", Math.max(schemaNodeCount, typeParameterCount), 2),
    checkedProduct("schema traversal", schemaNodeCount, 3),
    MAXIMUM_CONSTRUCTOR_ARITY,
    32,
  );
  const inferredTypeTraversalCapacity = checkedSum(
    "inferred type traversal capacity",
    checkedProduct(
      "inferred type traversal words",
      checkedSum(
        "inferred type structure count",
        surface.nodeCount,
        schemaNodeCount,
        typeParameterCount,
        surface.constructorCount,
        8,
      ),
      3,
    ),
    MAXIMUM_CONSTRUCTOR_ARITY,
  );
  const defaultScratchCapacity = checkedSum(
    "scratch arena capacity",
    checkedProduct("definition scratch", surface.definitionCount, 8),
    Math.max(schemaScratchCapacity, inferredTypeTraversalCapacity),
  );
  const capacities = optionsWorkspaceCapacities(
    {
      type: defaultTypeCapacity,
      environment: defaultEnvironmentCapacity,
      frame: defaultFrameCapacity,
      refinement: defaultRefinementCapacity,
      scratch: defaultScratchCapacity,
      output: Math.min(defaultTypeCapacity, INITIAL_INFERENCE_OUTPUT_RECORD_CAPACITY),
    },
    checkedProduct("minimum scratch arena capacity", surface.definitionCount, 8),
    overrides,
  );
  return createWorkspaceLayout(capacities, limits);
}

function optionsWorkspaceCapacities(
  defaults: WorkspaceCapacities,
  minimumScratchCapacity: number,
  overrides: GpuLazuliTypeInferenceWorkspaceCapacities | undefined,
): WorkspaceCapacities {
  const capacity = (name: string, value: number | undefined, fallback: number): number => {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 0 || selected > LAZULI_NO_INDEX) {
      throw new RangeError(`${name} must be an unsigned 32-bit integer; received ${selected}`);
    }
    return selected;
  };
  const scratch = capacity("initial scratch capacity", overrides?.scratch, defaults.scratch);
  if (scratch < minimumScratchCapacity) {
    throw new RangeError(
      `initial scratch capacity ${scratch} is below the shader-required ${minimumScratchCapacity} words`,
    );
  }
  return {
    type: capacity("initial type capacity", overrides?.type, defaults.type),
    environment: capacity(
      "initial environment capacity",
      overrides?.environment,
      defaults.environment,
    ),
    frame: capacity("initial frame capacity", overrides?.frame, defaults.frame),
    refinement: capacity(
      "initial refinement capacity",
      overrides?.refinement,
      defaults.refinement,
    ),
    scratch,
    output: capacity("initial output capacity", overrides?.output, defaults.output),
  };
}

function createWorkspaceLayout(
  capacities: WorkspaceCapacities,
  limits: GPUSupportedLimits,
): WorkspaceLayout {
  const typeBase = 0;
  const environmentBase = checkedProduct(
    "type arena words",
    capacities.type,
    LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH,
  );
  const frameBase = checkedSum(
    "environment arena base",
    environmentBase,
    checkedProduct(
      "environment arena words",
      capacities.environment,
      LAZULI_INFERENCE_ENVIRONMENT_WORD_LENGTH,
    ),
  );
  const refinementBase = checkedSum(
    "refinement arena base",
    frameBase,
    checkedProduct(
      "frame arena words",
      capacities.frame,
      LAZULI_INFERENCE_FRAME_WORD_LENGTH,
    ),
  );
  const scratchBase = checkedSum(
    "scratch arena base",
    refinementBase,
    checkedProduct(
      "refinement arena words",
      capacities.refinement,
      LAZULI_INFERENCE_REFINEMENT_WORD_LENGTH,
    ),
  );
  const workspaceWordLength = checkedSum(
    "workspace length",
    scratchBase,
    capacities.scratch,
  );
  assertStorageSize("type inference workspace", workspaceWordLength, limits);
  assertStorageSize(
    "type inference output",
    checkedProduct(
      "output words",
      capacities.output,
      LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
    ),
    limits,
  );
  return {
    typeBase,
    typeCapacity: capacities.type,
    environmentBase,
    environmentCapacity: capacities.environment,
    frameBase,
    frameCapacity: capacities.frame,
    refinementBase,
    refinementCapacity: capacities.refinement,
    scratchBase,
    scratchCapacity: capacities.scratch,
    workspaceWordLength,
    outputCapacity: capacities.output,
  };
}

export function createInitialState(
  options: Pick<
    GpuLazuliTypeInferenceOptions,
    "surface" | "maximumSteps" | "maximumStepsPerDispatch" | "initialSteps"
  >,
  metadata: ReturnType<typeof prepareLazuliInferenceShaderMetadata>,
  layout: WorkspaceLayout,
  syntheticSemanticSuccess: boolean,
): ArrayBuffer {
  const state = new ArrayBuffer(INFERENCE_INTERNAL_STATE_BYTE_LENGTH);
  const words = new DataView(state);
  const set = (word: number, value: number) => words.setUint32(word * WORD_BYTES, value, true);
  set(LazuliInferenceStateWord.NodeCount, options.surface.nodeCount);
  set(LazuliInferenceStateWord.DefinitionCount, options.surface.definitionCount);
  set(LazuliInferenceStateWord.TypeCount, options.surface.typeCount);
  set(LazuliInferenceStateWord.ConstructorCount, options.surface.constructorCount);
  set(LazuliInferenceStateWord.SchemaNodeCount, metadata.schemaNodeCount);
  set(LazuliInferenceStateWord.MainSymbol, options.surface.mainSymbol);
  set(
    LazuliInferenceStateWord.MaximumTransitionsPerDispatch,
    Math.min(options.maximumStepsPerDispatch, options.maximumSteps - (options.initialSteps ?? 0)),
  );
  set(LazuliInferenceStateWord.TypeBase, layout.typeBase);
  set(LazuliInferenceStateWord.TypeCapacity, layout.typeCapacity);
  set(LazuliInferenceStateWord.EnvironmentBase, layout.environmentBase);
  set(LazuliInferenceStateWord.EnvironmentCapacity, layout.environmentCapacity);
  set(LazuliInferenceStateWord.FrameBase, layout.frameBase);
  set(LazuliInferenceStateWord.FrameCapacity, layout.frameCapacity);
  set(LazuliInferenceStateWord.RefinementBase, layout.refinementBase);
  set(LazuliInferenceStateWord.RefinementCapacity, layout.refinementCapacity);
  set(LazuliInferenceStateWord.ScratchBase, layout.scratchBase);
  set(LazuliInferenceStateWord.ScratchCapacity, layout.scratchCapacity);
  set(LazuliInferenceStateWord.OutputCapacity, layout.outputCapacity);
  set(LazuliInferenceStateWord.DefinitionAnnotationBase, metadata.definitionAnnotationBase);
  set(LazuliInferenceStateWord.SchemaBase, metadata.schemaBase);
  set(LazuliInferenceStateWord.TypeParameterBase, metadata.typeParameterBase);
  set(LazuliInferenceStateWord.TypeParameterCount, metadata.typeParameterCount);
  set(
    LazuliInferenceStateWord.TypeParameterOffsetsBase,
    metadata.typeParameterOffsetsBase,
  );
  set(LazuliInferenceStateWord.ConstructorFieldBase, metadata.constructorFieldBase);
  set(LazuliInferenceStateWord.ConstructorFieldCount, metadata.constructorFieldCount);
  set(
    LazuliInferenceStateWord.ConstructorFieldOffsetsBase,
    metadata.constructorFieldOffsetsBase,
  );
  set(LazuliInferenceStateWord.ConstructorResultBase, metadata.constructorResultBase);
  set(LazuliInferenceStateWord.UntouchableTypeCutoff, LAZULI_NO_INDEX);
  set(LazuliInferenceStateWord.IndexedEliminationAllowed, 1);
  set(LazuliInferenceStateWord.IndexedEliminationRestrictionSymbol, LAZULI_NO_INDEX);
  const initialSteps = syntheticSemanticSuccess ? options.initialSteps ?? 0 : 0;
  set(LazuliInferenceSchedulerWord.PreviousSemanticSteps, initialSteps);
  const setSemantic = (word: number, value: number) =>
    set(LazuliInferenceSchedulerWord.SemanticState + word, value);
  setSemantic(LazuliCompilationStateWord.NodeCount, options.surface.nodeCount);
  setSemantic(LazuliCompilationStateWord.DefinitionCount, options.surface.definitionCount);
  setSemantic(LazuliCompilationStateWord.TypeCount, options.surface.typeCount);
  setSemantic(LazuliCompilationStateWord.ConstructorCount, options.surface.constructorCount);
  setSemantic(LazuliCompilationStateWord.EntrySymbol, options.surface.mainSymbol);
  setSemantic(
    LazuliCompilationStateWord.Status,
    syntheticSemanticSuccess ? LazuliCompilationStatus.Ok : LazuliCompilationStatus.Pending,
  );
  setSemantic(LazuliCompilationStateWord.ErrorSource, LAZULI_NO_INDEX);
  setSemantic(LazuliCompilationStateWord.ErrorDetail, LAZULI_NO_INDEX);
  setSemantic(LazuliCompilationStateWord.EntryDefinition, LAZULI_NO_INDEX);
  setSemantic(LazuliCompilationStateWord.TotalSteps, initialSteps);
  setSemantic(LazuliCompilationStateWord.MaximumSteps, options.maximumSteps);
  setSemantic(
    LazuliCompilationStateWord.MaximumStepsPerDispatch,
    options.maximumStepsPerDispatch,
  );
  return state;
}

export function dispatchOutputReadbackCapacity(
  maximumStepsPerDispatch: number,
  limits: GPUSupportedLimits,
): number {
  if (maximumStepsPerDispatch < COMBINED_READBACK_MINIMUM_DISPATCH_TRANSITIONS) return 0;
  const outputByteLength = inferenceOutputBufferByteLength(
    INITIAL_INFERENCE_OUTPUT_RECORD_CAPACITY,
  );
  return outputByteLength <= limits.maxBufferSize - INFERENCE_INTERNAL_STATE_BYTE_LENGTH &&
      outputByteLength <= LAZULI_NO_INDEX - INFERENCE_INTERNAL_STATE_BYTE_LENGTH
    ? INITIAL_INFERENCE_OUTPUT_RECORD_CAPACITY
    : 0;
}

function combinedInferenceReadbackByteLength(outputCapacity: number): number {
  return checkedSum(
    "type inference readback bytes",
    INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
    inferenceOutputBufferByteLength(outputCapacity),
  );
}

export function inferenceOutputBufferByteLength(outputCapacity: number): number {
  return Math.max(WORD_BYTES, inferredTypeOutputByteLength(outputCapacity));
}

export function inferredTypeOutputByteLength(outputCount: number): number {
  return checkedProduct(
    "inferred type output bytes",
    outputCount,
    LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES,
  );
}

export async function createInferenceBuffers(
  options: GpuLazuliTypeInferenceOptions,
  metadataWords: Uint32Array,
  layout: WorkspaceLayout,
  initialState: ArrayBuffer,
): Promise<InferenceBuffersAllocation> {
  const metadataByteLength = storageBytes(metadataWords.length);
  const workspaceByteLength = storageBytes(layout.workspaceWordLength);
  const outputByteLength = inferenceOutputBufferByteLength(layout.outputCapacity);
  const allocationEvidence =
    `schema metadata=${metadataByteLength} bytes, workspace=${workspaceByteLength} bytes, output=${outputByteLength} bytes, state=${INFERENCE_INTERNAL_STATE_BYTE_LENGTH} bytes`;
  options.device.pushErrorScope("validation");
  options.device.pushErrorScope("out-of-memory");
  let metadataBuffer: GPUBuffer | undefined;
  let workspaceBuffer: GPUBuffer | undefined;
  let outputBuffer: GPUBuffer | undefined;
  let stateBuffer: GPUBuffer | undefined;
  let outOfMemory: Promise<GPUError | null>;
  let validation: Promise<GPUError | null>;
  try {
    metadataBuffer = options.device.createBuffer({
      label: "Lazuli type inference schema metadata",
      size: metadataByteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    workspaceBuffer = options.device.createBuffer({
      label: "Lazuli type inference workspace",
      size: workspaceByteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });
    outputBuffer = options.device.createBuffer({
      label: "Lazuli inferred type output",
      size: outputByteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });
    stateBuffer = options.device.createBuffer({
      label: "Lazuli type inference state",
      size: INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });
    outOfMemory = options.device.popErrorScope();
    validation = options.device.popErrorScope();
  } catch (cause) {
    const outOfMemoryScope = options.device.popErrorScope();
    const validationScope = options.device.popErrorScope();
    const [outOfMemoryError, validationError] = await Promise.all([
      outOfMemoryScope,
      validationScope,
    ]);
    metadataBuffer?.destroy();
    workspaceBuffer?.destroy();
    outputBuffer?.destroy();
    stateBuffer?.destroy();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli type inference buffers (${allocationEvidence}): ${validationError.message}`,
        { cause },
      );
    }
    if (outOfMemoryError !== null) {
      return {
        ok: false,
        reason:
          `initial inference buffers require ${allocationEvidence}: ${outOfMemoryError.message}`,
      };
    }
    throw cause;
  }
  const [outOfMemoryError, validationError] = await Promise.all([outOfMemory, validation]);
  if (validationError !== null) {
    metadataBuffer.destroy();
    workspaceBuffer.destroy();
    outputBuffer.destroy();
    stateBuffer.destroy();
    throw new Error(
      `WebGPU rejected Lazuli type inference buffers (${allocationEvidence}): ${validationError.message}`,
    );
  }
  if (outOfMemoryError !== null) {
    metadataBuffer?.destroy();
    workspaceBuffer?.destroy();
    outputBuffer?.destroy();
    stateBuffer?.destroy();
    return {
      ok: false,
      reason:
        `initial inference buffers require ${allocationEvidence}: ${outOfMemoryError.message}`,
    };
  }
  if (
    metadataBuffer === undefined || workspaceBuffer === undefined || outputBuffer === undefined ||
    stateBuffer === undefined
  ) {
    metadataBuffer?.destroy();
    workspaceBuffer?.destroy();
    outputBuffer?.destroy();
    stateBuffer?.destroy();
    throw new Error("WebGPU did not create Lazuli type inference buffers");
  }

  options.device.pushErrorScope("validation");
  let initializationValidation: Promise<GPUError | null>;
  try {
    options.device.queue.writeBuffer(metadataBuffer, 0, encodeWords(metadataWords));
    options.device.queue.writeBuffer(stateBuffer, 0, initialState);
    initializationValidation = options.device.popErrorScope();
  } catch (cause) {
    const validationError = await options.device.popErrorScope();
    metadataBuffer.destroy();
    workspaceBuffer.destroy();
    outputBuffer.destroy();
    stateBuffer.destroy();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli type inference buffer initialization (${allocationEvidence}): ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const initializationError = await initializationValidation;
  if (initializationError !== null) {
    metadataBuffer.destroy();
    workspaceBuffer.destroy();
    outputBuffer.destroy();
    stateBuffer.destroy();
    throw new Error(
      `WebGPU rejected Lazuli type inference buffer initialization (${allocationEvidence}): ${initializationError.message}`,
    );
  }
  return {
    ok: true,
    metadataBuffer,
    workspaceBuffer,
    outputBuffer,
    stateBuffer,
  };
}

type InferenceBuffersAllocation =
  | {
    readonly ok: true;
    readonly metadataBuffer: GPUBuffer;
    readonly workspaceBuffer: GPUBuffer;
    readonly outputBuffer: GPUBuffer;
    readonly stateBuffer: GPUBuffer;
  }
  | { readonly ok: false; readonly reason: string };

export async function createInferenceReadbackBuffer(
  device: GPUDevice,
  outputReadbackCapacity: number,
): Promise<BufferAllocation> {
  const includesOutput = outputReadbackCapacity > 0;
  const size = includesOutput
    ? combinedInferenceReadbackByteLength(outputReadbackCapacity)
    : INFERENCE_INTERNAL_STATE_BYTE_LENGTH;
  const errorSubject = includesOutput
    ? "Lazuli inferred type readback"
    : "Lazuli type inference buffers";
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  let buffer: GPUBuffer | undefined;
  let outOfMemory: Promise<GPUError | null>;
  let validation: Promise<GPUError | null>;
  try {
    buffer = device.createBuffer({
      label: includesOutput
        ? "Lazuli type inference state and output readback"
        : "Lazuli type inference state readback",
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    outOfMemory = device.popErrorScope();
    validation = device.popErrorScope();
  } catch (cause) {
    const outOfMemoryScope = device.popErrorScope();
    const validationScope = device.popErrorScope();
    const [outOfMemoryError, validationError] = await Promise.all([
      outOfMemoryScope,
      validationScope,
    ]);
    buffer?.destroy();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected ${errorSubject}: ${validationError.message}`,
        {
          cause,
        },
      );
    }
    if (outOfMemoryError !== null) {
      return { ok: false, byteLength: size, reason: outOfMemoryError.message };
    }
    throw cause;
  }
  const [outOfMemoryError, validationError] = await Promise.all([outOfMemory, validation]);
  if (validationError !== null) {
    buffer?.destroy();
    throw new Error(`WebGPU rejected ${errorSubject}: ${validationError.message}`);
  }
  if (outOfMemoryError !== null) {
    buffer?.destroy();
    return { ok: false, byteLength: size, reason: outOfMemoryError.message };
  }
  if (buffer === undefined) {
    throw new Error(
      includesOutput
        ? "WebGPU did not create Lazuli inferred type readback"
        : "WebGPU did not create Lazuli type inference buffers",
    );
  }
  return { ok: true, buffer };
}

export async function createOutputReadbackBuffer(
  device: GPUDevice,
  outputCount: number,
): Promise<GPUBuffer> {
  const size = Math.max(WORD_BYTES, inferredTypeOutputByteLength(outputCount));
  device.pushErrorScope("validation");
  let buffer: GPUBuffer | undefined;
  let validation: Promise<GPUError | null>;
  try {
    buffer = device.createBuffer({
      label: "Lazuli inferred type readback",
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    validation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(`WebGPU rejected Lazuli inferred type readback: ${validationError.message}`, {
        cause,
      });
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    buffer?.destroy();
    throw new Error(`WebGPU rejected Lazuli inferred type readback: ${validationError.message}`);
  }
  if (buffer === undefined) {
    throw new Error("WebGPU did not create Lazuli inferred type readback");
  }
  return buffer;
}

export async function createInferenceOutputBuffer(
  device: GPUDevice,
  outputCapacity: number,
): Promise<BufferAllocation> {
  const size = inferenceOutputBufferByteLength(outputCapacity);
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  let buffer: GPUBuffer | undefined;
  let outOfMemory: Promise<GPUError | null>;
  let validation: Promise<GPUError | null>;
  try {
    buffer = device.createBuffer({
      label: "Expanded Lazuli inferred type output",
      size,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });
    outOfMemory = device.popErrorScope();
    validation = device.popErrorScope();
  } catch (cause) {
    const outOfMemoryScope = device.popErrorScope();
    const validationScope = device.popErrorScope();
    const [outOfMemoryError, validationError] = await Promise.all([
      outOfMemoryScope,
      validationScope,
    ]);
    buffer?.destroy();
    if (outOfMemoryError !== null) {
      return { ok: false, byteLength: size, reason: outOfMemoryError.message };
    }
    if (validationError !== null) {
      throw new Error(`WebGPU rejected expanded Lazuli type output: ${validationError.message}`, {
        cause,
      });
    }
    throw cause;
  }
  const [outOfMemoryError, validationError] = await Promise.all([outOfMemory, validation]);
  if (outOfMemoryError !== null) {
    buffer?.destroy();
    return { ok: false, byteLength: size, reason: outOfMemoryError.message };
  }
  if (validationError !== null) {
    buffer?.destroy();
    throw new Error(`WebGPU rejected expanded Lazuli type output: ${validationError.message}`);
  }
  if (buffer === undefined) throw new Error("WebGPU did not create expanded Lazuli type output");
  return { ok: true, buffer };
}

type BufferAllocation =
  | { readonly ok: true; readonly buffer: GPUBuffer }
  | { readonly ok: false; readonly byteLength: number; readonly reason: string };

export async function createExpandedWorkspace(
  device: GPUDevice,
  workspaceBuffer: GPUBuffer,
  layout: WorkspaceLayout,
  expandedLayout: WorkspaceLayout,
  state: InferenceStateSnapshot,
  surface: EncodedLazuliSurface,
): Promise<BufferAllocation> {
  const byteLength = storageBytes(expandedLayout.workspaceWordLength);
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  let expandedBuffer: GPUBuffer | undefined;
  let outOfMemory: Promise<GPUError | null>;
  let validation: Promise<GPUError | null>;
  try {
    expandedBuffer = device.createBuffer({
      label: "Expanded Lazuli type inference workspace",
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });
    outOfMemory = device.popErrorScope();
    validation = device.popErrorScope();
  } catch (cause) {
    const outOfMemoryScope = device.popErrorScope();
    const validationScope = device.popErrorScope();
    const [outOfMemoryError, validationError] = await Promise.all([
      outOfMemoryScope,
      validationScope,
    ]);
    expandedBuffer?.destroy();
    if (outOfMemoryError !== null) {
      return { ok: false, byteLength, reason: outOfMemoryError.message };
    }
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected expanded Lazuli type inference workspace: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const [outOfMemoryError, validationError] = await Promise.all([outOfMemory, validation]);
  if (outOfMemoryError !== null) {
    expandedBuffer?.destroy();
    return { ok: false, byteLength, reason: outOfMemoryError.message };
  }
  if (validationError !== null) {
    expandedBuffer?.destroy();
    throw new Error(
      `WebGPU rejected expanded Lazuli type inference workspace: ${validationError.message}`,
    );
  }
  if (expandedBuffer === undefined) {
    throw new Error("WebGPU did not create expanded Lazuli type inference workspace");
  }

  device.pushErrorScope("validation");
  let copyValidation: Promise<GPUError | null>;
  try {
    const commands = device.createCommandEncoder({
      label: "Expand Lazuli type inference workspace",
    });
    copyWorkspaceRegion(
      commands,
      workspaceBuffer,
      layout.typeBase,
      expandedBuffer,
      expandedLayout.typeBase,
      state.typeTop,
      LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH,
    );
    copyWorkspaceRegion(
      commands,
      workspaceBuffer,
      layout.environmentBase,
      expandedBuffer,
      expandedLayout.environmentBase,
      state.environmentTop,
      LAZULI_INFERENCE_ENVIRONMENT_WORD_LENGTH,
    );
    copyWorkspaceRegion(
      commands,
      workspaceBuffer,
      layout.frameBase,
      expandedBuffer,
      expandedLayout.frameBase,
      state.frameTop,
      LAZULI_INFERENCE_FRAME_WORD_LENGTH,
    );
    copyWorkspaceRegion(
      commands,
      workspaceBuffer,
      layout.refinementBase,
      expandedBuffer,
      expandedLayout.refinementBase,
      state.refinementTop,
      LAZULI_INFERENCE_REFINEMENT_WORD_LENGTH,
    );
    copyWorkspaceRegion(
      commands,
      workspaceBuffer,
      layout.scratchBase,
      expandedBuffer,
      expandedLayout.scratchBase,
      layout.scratchCapacity,
      1,
    );
    device.queue.submit([commands.finish()]);
    copyValidation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    expandedBuffer.destroy();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli workspace growth for ${surface.nodeCount} nodes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  try {
    const validationError = await copyValidation;
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli workspace growth for ${surface.nodeCount} nodes: ${validationError.message}`,
      );
    }
    await device.queue.onSubmittedWorkDone();
    return { ok: true, buffer: expandedBuffer };
  } catch (error) {
    expandedBuffer.destroy();
    throw error;
  }
}

function copyWorkspaceRegion(
  commands: GPUCommandEncoder,
  source: GPUBuffer,
  sourceBase: number,
  destination: GPUBuffer,
  destinationBase: number,
  recordCount: number,
  recordWordLength: number,
): void {
  const byteLength = checkedProduct(
    "workspace region copy bytes",
    checkedProduct("workspace region copy words", recordCount, recordWordLength),
    WORD_BYTES,
  );
  if (byteLength === 0) return;
  commands.copyBufferToBuffer(
    source,
    sourceBase * WORD_BYTES,
    destination,
    destinationBase * WORD_BYTES,
    byteLength,
  );
}

export async function copyOutputForGrowth(
  device: GPUDevice,
  source: GPUBuffer,
  destination: GPUBuffer,
  outputCount: number,
  surface: EncodedLazuliSurface,
): Promise<void> {
  const byteLength = checkedProduct(
    "live output growth bytes",
    checkedProduct("live output growth words", outputCount, LAZULI_INFERENCE_OUTPUT_WORD_LENGTH),
    WORD_BYTES,
  );
  if (byteLength === 0) return;

  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    const commands = device.createCommandEncoder({ label: "Expand Lazuli inferred type output" });
    commands.copyBufferToBuffer(source, 0, destination, 0, byteLength);
    device.queue.submit([commands.finish()]);
    validation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli output growth for ${surface.nodeCount} nodes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    throw new Error(
      `WebGPU rejected Lazuli output growth for ${surface.nodeCount} nodes: ${validationError.message}`,
    );
  }
  await device.queue.onSubmittedWorkDone();
}

export function resumeOutputAfterGrowth(
  device: GPUDevice,
  stateBuffer: GPUBuffer,
  outputCapacity: number,
): void {
  for (
    const [word, value] of [
      [LazuliInferenceStateWord.OutputCapacity, outputCapacity],
      [LazuliInferenceStateWord.Status, LazuliInferenceStatus.Pending],
      [LazuliInferenceStateWord.ErrorCode, LazuliInferenceDiagnosticCode.None],
      [LazuliInferenceStateWord.ErrorStartByte, 0],
      [LazuliInferenceStateWord.ErrorEndByte, 0],
      [LazuliInferenceStateWord.ErrorDetail, LAZULI_NO_INDEX],
      [LazuliInferenceStateWord.ErrorOperand0, LAZULI_NO_INDEX],
      [LazuliInferenceStateWord.ErrorOperand1, LAZULI_NO_INDEX],
      [LazuliInferenceStateWord.ErrorContext, 0],
    ] as const
  ) {
    writeStateWord(device, stateBuffer, word, value);
  }
}

export function isWorkspaceArenaExhaustion(errorCode: number): boolean {
  return errorCode === LazuliInferenceDiagnosticCode.TypeArenaExhausted ||
    errorCode === LazuliInferenceDiagnosticCode.EnvironmentArenaExhausted ||
    errorCode === LazuliInferenceDiagnosticCode.FrameArenaExhausted ||
    errorCode === LazuliInferenceDiagnosticCode.RefinementArenaExhausted ||
    errorCode === LazuliInferenceDiagnosticCode.ScratchArenaExhausted;
}

export function workspaceArenaCapacity(layout: WorkspaceLayout, errorCode: number): number {
  switch (errorCode) {
    case LazuliInferenceDiagnosticCode.TypeArenaExhausted:
      return layout.typeCapacity;
    case LazuliInferenceDiagnosticCode.EnvironmentArenaExhausted:
      return layout.environmentCapacity;
    case LazuliInferenceDiagnosticCode.FrameArenaExhausted:
      return layout.frameCapacity;
    case LazuliInferenceDiagnosticCode.RefinementArenaExhausted:
      return layout.refinementCapacity;
    case LazuliInferenceDiagnosticCode.ScratchArenaExhausted:
      return layout.scratchCapacity;
    default:
      throw new Error(`cannot read capacity for non-workspace arena error ${errorCode}`);
  }
}

export function growWorkspaceLayout(
  layout: WorkspaceLayout,
  errorCode: number,
  outputCapacity: number,
  limits: GPUSupportedLimits,
): WorkspaceLayout {
  const currentCapacity = workspaceArenaCapacity(layout, errorCode);
  const doubledCapacity = Math.max(
    1,
    checkedProduct(`${inferenceArenaName(errorCode)} arena growth`, currentCapacity, 2),
  );
  return createWorkspaceLayout({
    type: errorCode === LazuliInferenceDiagnosticCode.TypeArenaExhausted
      ? doubledCapacity
      : layout.typeCapacity,
    environment: errorCode === LazuliInferenceDiagnosticCode.EnvironmentArenaExhausted
      ? doubledCapacity
      : layout.environmentCapacity,
    frame: errorCode === LazuliInferenceDiagnosticCode.FrameArenaExhausted
      ? doubledCapacity
      : layout.frameCapacity,
    refinement: errorCode === LazuliInferenceDiagnosticCode.RefinementArenaExhausted
      ? doubledCapacity
      : layout.refinementCapacity,
    scratch: errorCode === LazuliInferenceDiagnosticCode.ScratchArenaExhausted
      ? doubledCapacity
      : layout.scratchCapacity,
    output: outputCapacity,
  }, limits);
}

export function resumeWorkspaceAfterGrowth(
  device: GPUDevice,
  stateBuffer: GPUBuffer,
  layout: WorkspaceLayout,
): void {
  for (
    const [word, value] of [
      [LazuliInferenceStateWord.TypeBase, layout.typeBase],
      [LazuliInferenceStateWord.TypeCapacity, layout.typeCapacity],
      [LazuliInferenceStateWord.EnvironmentBase, layout.environmentBase],
      [LazuliInferenceStateWord.EnvironmentCapacity, layout.environmentCapacity],
      [LazuliInferenceStateWord.FrameBase, layout.frameBase],
      [LazuliInferenceStateWord.FrameCapacity, layout.frameCapacity],
      [LazuliInferenceStateWord.RefinementBase, layout.refinementBase],
      [LazuliInferenceStateWord.RefinementCapacity, layout.refinementCapacity],
      [LazuliInferenceStateWord.ScratchBase, layout.scratchBase],
      [LazuliInferenceStateWord.ScratchCapacity, layout.scratchCapacity],
      [LazuliInferenceStateWord.Status, LazuliInferenceStatus.Pending],
      [LazuliInferenceStateWord.ErrorCode, LazuliInferenceDiagnosticCode.None],
      [LazuliInferenceStateWord.ErrorStartByte, 0],
      [LazuliInferenceStateWord.ErrorEndByte, 0],
      [LazuliInferenceStateWord.ErrorDetail, LAZULI_NO_INDEX],
      [LazuliInferenceStateWord.ErrorOperand0, LAZULI_NO_INDEX],
      [LazuliInferenceStateWord.ErrorOperand1, LAZULI_NO_INDEX],
      [LazuliInferenceStateWord.ErrorContext, 0],
    ] as const
  ) {
    writeStateWord(device, stateBuffer, word, value);
  }
}

export function discardGrowthTransition(
  device: GPUDevice,
  stateBuffer: GPUBuffer,
  state: InferenceStateSnapshot,
): number {
  if (state.transitions === 0) {
    throw new Error("GPU Lazuli type inference exhausted an arena before its first transition");
  }
  const resumedTransitions = state.transitions - 1;
  writeStateWord(
    device,
    stateBuffer,
    LazuliInferenceStateWord.Transitions,
    resumedTransitions,
  );
  return resumedTransitions;
}

export function writeStateWord(
  device: GPUDevice,
  stateBuffer: GPUBuffer,
  word: number,
  value: number,
): void {
  const bytes = new ArrayBuffer(WORD_BYTES);
  new DataView(bytes).setUint32(0, value, true);
  device.queue.writeBuffer(stateBuffer, word * WORD_BYTES, bytes);
}

export function inferenceArenaName(errorCode: number): string {
  switch (errorCode) {
    case LazuliInferenceDiagnosticCode.TypeArenaExhausted:
      return "type";
    case LazuliInferenceDiagnosticCode.EnvironmentArenaExhausted:
      return "environment";
    case LazuliInferenceDiagnosticCode.FrameArenaExhausted:
      return "frame";
    case LazuliInferenceDiagnosticCode.RefinementArenaExhausted:
      return "refinement";
    case LazuliInferenceDiagnosticCode.ScratchArenaExhausted:
      return "scratch";
    case LazuliInferenceDiagnosticCode.OutputArenaExhausted:
      return "output";
    default:
      return `unknown (${errorCode})`;
  }
}

function checkedSum(name: string, ...values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result < 0 || result > LAZULI_NO_INDEX) {
    throw new RangeError(`${name} cannot be represented as a u32: ${result}`);
  }
  return result;
}

export function checkedProduct(name: string, left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0 || result > LAZULI_NO_INDEX) {
    throw new RangeError(`${name} cannot be represented as a u32: ${left} * ${right}`);
  }
  return result;
}

export function assertStorageSize(
  name: string,
  wordLength: number,
  limits: GPUSupportedLimits,
): void {
  const bytes = checkedProduct(`${name} bytes`, wordLength, WORD_BYTES);
  if (bytes > limits.maxBufferSize || bytes > limits.maxStorageBufferBindingSize) {
    throw new RangeError(
      `${name} requires ${bytes} bytes, beyond maxBufferSize=${limits.maxBufferSize} or maxStorageBufferBindingSize=${limits.maxStorageBufferBindingSize}`,
    );
  }
}

function storageBytes(wordLength: number): number {
  return Math.max(WORD_BYTES, checkedProduct("storage buffer bytes", wordLength, WORD_BYTES));
}

function encodeWords(words: Uint32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(storageBytes(words.length));
  const view = new DataView(bytes);
  for (let index = 0; index < words.length; index++) {
    const value = words[index];
    if (value === undefined) throw new Error(`Lazuli metadata omitted word ${index}`);
    view.setUint32(index * WORD_BYTES, value, true);
  }
  return bytes;
}
