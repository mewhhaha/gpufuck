import type { EncodedSemanticSurface } from "./abi.ts";
import {
  COMPILATION_STATE_BYTE_LENGTH,
  CompilationStateWord,
  CompilationStatus,
} from "./compiler_shader.ts";
import type { GpuDispatchScheduler } from "./gpu_dispatch_scheduler.ts";
import type {
  GpuSemanticCompilationPass,
  GpuSemanticStateSnapshot,
} from "./gpu_semantic_contract.ts";
import type {
  GpuTypeInferenceOptions,
  InferenceStateSnapshot,
  WorkspaceLayout,
} from "./gpu_type_inference_contract.ts";
import {
  checkedProduct,
  INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
  inferenceOutputBufferByteLength,
  inferredTypeOutputByteLength,
} from "./gpu_type_inference_workspace.ts";
import {
  INFERENCE_PROFILE_BUCKET_COUNT,
  INFERENCE_TYPE_RECORD_WORD_LENGTH,
  InferenceSchedulerWord,
  InferenceStateWord,
  TYPE_INFERENCE_SHADER,
} from "./type_inference_shader.ts";

const WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;
export const SEMANTIC_SNAPSHOT_BYTE_OFFSET = InferenceSchedulerWord.SemanticState *
  WORD_BYTES;

/** Creates the shader module used with {@link runGpuSemanticTypeInference}. */
export function createTypeInferenceShaderModule(device: GPUDevice): GPUShaderModule {
  return device.createShaderModule({
    label: "type inference",
    code: TYPE_INFERENCE_SHADER,
  });
}

export async function createInferenceBindGroup(
  options: GpuTypeInferenceOptions,
  metadataBuffer: GPUBuffer,
  workspaceBuffer: GPUBuffer,
  outputBuffer: GPUBuffer,
  stateBuffer: GPUBuffer,
): Promise<GPUBindGroup> {
  const allocationEvidence =
    `metadata=${metadataBuffer.size} bytes, workspace=${workspaceBuffer.size} bytes, output=${outputBuffer.size} bytes, state=${stateBuffer.size} bytes`;
  options.device.pushErrorScope("validation");
  let bindGroup: GPUBindGroup | undefined;
  let validation: Promise<GPUError | null>;
  try {
    bindGroup = options.device.createBindGroup({
      label: "type inference bindings",
      layout: options.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: options.coreNodeBuffer } },
        { binding: 1, resource: { buffer: options.definitionBuffer } },
        { binding: 2, resource: { buffer: options.typeBuffer } },
        { binding: 3, resource: { buffer: options.constructorBuffer } },
        { binding: 4, resource: { buffer: metadataBuffer } },
        { binding: 5, resource: { buffer: workspaceBuffer } },
        { binding: 6, resource: { buffer: outputBuffer } },
        { binding: 7, resource: { buffer: stateBuffer } },
      ],
    });
    validation = options.device.popErrorScope();
  } catch (cause) {
    const validationError = await options.device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected type inference bindings for ${options.surface.nodeCount} nodes (${allocationEvidence}): ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    throw new Error(
      `WebGPU rejected type inference bindings for ${options.surface.nodeCount} nodes (${allocationEvidence}): ${validationError.message}`,
    );
  }
  if (bindGroup === undefined) {
    throw new Error(
      `WebGPU did not create type inference bindings for ${options.surface.nodeCount} nodes (${allocationEvidence})`,
    );
  }
  return bindGroup;
}

export async function runSemanticCompilationToCompletion(
  options: GpuTypeInferenceOptions,
  semanticPass: GpuSemanticCompilationPass,
): Promise<GpuSemanticStateSnapshot> {
  let readbackBuffer: GPUBuffer | undefined;
  let mapped = false;
  options.device.pushErrorScope("validation");
  let creationValidation: Promise<GPUError | null>;
  try {
    readbackBuffer = options.device.createBuffer({
      label: "semantic preflight fallback readback",
      size: COMPILATION_STATE_BYTE_LENGTH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    creationValidation = options.device.popErrorScope();
  } catch (cause) {
    const validationError = await options.device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected semantic preflight fallback: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }

  try {
    const creationError = await creationValidation;
    if (creationError !== null) {
      throw new Error(
        `WebGPU rejected semantic preflight fallback: ${creationError.message}`,
      );
    }
    if (readbackBuffer === undefined) {
      throw new Error("WebGPU did not create a semantic preflight fallback readback");
    }
    let previousSteps = 0;
    while (true) {
      options.signal?.throwIfAborted();
      options.device.pushErrorScope("validation");
      let dispatchValidation: Promise<GPUError | null>;
      try {
        const commands = options.device.createCommandEncoder({
          label: "semantic preflight fallback commands",
        });
        encodeSemanticCompilation(commands, semanticPass, 1);
        commands.copyBufferToBuffer(
          semanticPass.stateBuffer,
          0,
          readbackBuffer,
          0,
          COMPILATION_STATE_BYTE_LENGTH,
        );
        options.signal?.throwIfAborted();
        options.device.queue.submit([commands.finish()]);
        dispatchValidation = options.device.popErrorScope();
      } catch (cause) {
        const validationError = await options.device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected semantic preflight fallback for ${options.surface.nodeCount} nodes: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }
      const dispatchError = await dispatchValidation;
      if (dispatchError !== null) {
        throw new Error(
          `WebGPU rejected semantic preflight fallback for ${options.surface.nodeCount} nodes: ${dispatchError.message}`,
        );
      }
      options.signal?.throwIfAborted();
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      mapped = true;
      const semanticState = readSemanticState(
        new DataView(readbackBuffer.getMappedRange()),
        0,
      );
      readbackBuffer.unmap();
      mapped = false;
      options.signal?.throwIfAborted();
      const dispatchSteps = semanticState.totalSteps - previousSteps;
      if (
        !Number.isSafeInteger(dispatchSteps) || dispatchSteps < 1 ||
        dispatchSteps > options.maximumStepsPerDispatch
      ) {
        throw new Error(
          `GPU semantic preflight fallback returned invalid progress: previousSteps=${previousSteps}, steps=${semanticState.totalSteps}, maximumStepsPerDispatch=${options.maximumStepsPerDispatch}`,
        );
      }
      if (semanticState.status !== CompilationStatus.Pending) return semanticState;
      previousSteps = semanticState.totalSteps;
    }
  } finally {
    if (mapped) readbackBuffer?.unmap();
    readbackBuffer?.destroy();
  }
}

export async function dispatchForReadback(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  bindGroup: GPUBindGroup,
  outputBuffer: GPUBuffer,
  outputCapacity: number,
  stateBuffer: GPUBuffer,
  readbackBuffer: GPUBuffer,
  outputReadbackCapacity: number,
  coreNodeBuffer: GPUBuffer,
  coreReadbackByteOffset: number,
  coreReadbackByteLength: number,
  surface: EncodedSemanticSurface,
  semanticPass: GpuSemanticCompilationPass | undefined,
  signal: AbortSignal | undefined,
  dispatchScheduler: GpuDispatchScheduler | undefined,
): Promise<void> {
  if (dispatchScheduler !== undefined) {
    await dispatchScheduler.schedule({
      encode: (commands) =>
        encodeInferenceDispatch(
          commands,
          pipeline,
          bindGroup,
          outputBuffer,
          outputCapacity,
          stateBuffer,
          readbackBuffer,
          outputReadbackCapacity,
          coreNodeBuffer,
          coreReadbackByteOffset,
          coreReadbackByteLength,
          semanticPass,
        ),
      validationContext: `WebGPU rejected type inference for ${surface.nodeCount} nodes`,
      ...(signal === undefined ? {} : { signal }),
    });
    return;
  }

  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    const commands = device.createCommandEncoder({
      label: semanticPass === undefined
        ? "type inference commands"
        : "semantic compilation and type inference commands",
    });
    encodeInferenceDispatch(
      commands,
      pipeline,
      bindGroup,
      outputBuffer,
      outputCapacity,
      stateBuffer,
      readbackBuffer,
      outputReadbackCapacity,
      coreNodeBuffer,
      coreReadbackByteOffset,
      coreReadbackByteLength,
      semanticPass,
    );
    signal?.throwIfAborted();
    device.queue.submit([commands.finish()]);
    validation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected type inference for ${surface.nodeCount} nodes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    throw new Error(
      `WebGPU rejected type inference for ${surface.nodeCount} nodes: ${validationError.message}`,
    );
  }
}

function encodeInferenceDispatch(
  commands: GPUCommandEncoder,
  pipeline: GPUComputePipeline,
  bindGroup: GPUBindGroup,
  outputBuffer: GPUBuffer,
  outputCapacity: number,
  stateBuffer: GPUBuffer,
  readbackBuffer: GPUBuffer,
  outputReadbackCapacity: number,
  coreNodeBuffer: GPUBuffer,
  coreReadbackByteOffset: number,
  coreReadbackByteLength: number,
  semanticPass: GpuSemanticCompilationPass | undefined,
): void {
  if (semanticPass !== undefined) {
    encodeSemanticCompilation(commands, semanticPass, 1);
    commands.copyBufferToBuffer(
      semanticPass.stateBuffer,
      0,
      stateBuffer,
      SEMANTIC_SNAPSHOT_BYTE_OFFSET,
      COMPILATION_STATE_BYTE_LENGTH,
    );
  }
  const pass = commands.beginComputePass({ label: "Infer types" });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
  commands.copyBufferToBuffer(
    stateBuffer,
    0,
    readbackBuffer,
    0,
    INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
  );
  if (outputReadbackCapacity > 0) {
    commands.copyBufferToBuffer(
      outputBuffer,
      0,
      readbackBuffer,
      INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
      inferenceOutputBufferByteLength(Math.min(outputCapacity, outputReadbackCapacity)),
    );
  }
  if (semanticPass !== undefined && coreReadbackByteLength > 0) {
    commands.copyBufferToBuffer(
      coreNodeBuffer,
      0,
      readbackBuffer,
      coreReadbackByteOffset,
      coreReadbackByteLength,
    );
  }
}

function encodeSemanticCompilation(
  commands: GPUCommandEncoder,
  semanticPass: GpuSemanticCompilationPass,
  laneCount: number,
): void {
  const compilation = commands.beginComputePass({
    label: "Compile surface nodes",
  });
  compilation.setPipeline(semanticPass.pipelines.compilation);
  compilation.setBindGroup(0, semanticPass.bindGroup);
  compilation.dispatchWorkgroups(laneCount);
  compilation.end();
  if (semanticPass.plannedLoweringWorkgroups === 0) return;

  const lowering = commands.beginComputePass({
    label: "Lower planned nodes",
  });
  lowering.setPipeline(semanticPass.pipelines.plannedLowering);
  lowering.setBindGroup(0, semanticPass.bindGroup);
  lowering.dispatchWorkgroups(semanticPass.plannedLoweringWorkgroups);
  lowering.end();
}

export async function copyOutputForReadback(
  device: GPUDevice,
  outputBuffer: GPUBuffer,
  outputReadbackBuffer: GPUBuffer,
  outputCount: number,
  surface: EncodedSemanticSurface,
): Promise<void> {
  const byteLength = inferredTypeOutputByteLength(outputCount);
  if (byteLength === 0) {
    throw new Error("GPU type inference completed without an output type");
  }
  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    const commands = device.createCommandEncoder({
      label: "inferred type readback commands",
    });
    commands.copyBufferToBuffer(outputBuffer, 0, outputReadbackBuffer, 0, byteLength);
    device.queue.submit([commands.finish()]);
    validation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected inferred type readback for ${surface.nodeCount} nodes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    throw new Error(
      `WebGPU rejected inferred type readback for ${surface.nodeCount} nodes: ${validationError.message}`,
    );
  }
}

export async function readDiagnosticWorkspace(
  device: GPUDevice,
  workspaceBuffer: GPUBuffer,
  state: InferenceStateSnapshot,
  layout: WorkspaceLayout,
  surface: EncodedSemanticSurface,
): Promise<DataView> {
  const byteLength = checkedProduct(
    "type diagnostic workspace bytes",
    state.typeTop,
    INFERENCE_TYPE_RECORD_WORD_LENGTH * WORD_BYTES,
  );
  if (byteLength === 0) return new DataView(new ArrayBuffer(0));

  let readbackBuffer: GPUBuffer | undefined;
  let mapped = false;
  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    readbackBuffer = device.createBuffer({
      label: "type diagnostic workspace readback",
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const commands = device.createCommandEncoder({
      label: "type diagnostic workspace readback commands",
    });
    commands.copyBufferToBuffer(
      workspaceBuffer,
      layout.typeBase * WORD_BYTES,
      readbackBuffer,
      0,
      byteLength,
    );
    device.queue.submit([commands.finish()]);
    validation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    readbackBuffer?.destroy();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected type diagnostic readback for ${surface.nodeCount} nodes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  try {
    const validationError = await validation;
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected type diagnostic readback for ${surface.nodeCount} nodes: ${validationError.message}`,
      );
    }
    if (readbackBuffer === undefined) {
      throw new Error("WebGPU did not create a type diagnostic readback buffer");
    }
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    mapped = true;
    return new DataView(readbackBuffer.getMappedRange().slice(0));
  } finally {
    if (mapped) readbackBuffer?.unmap();
    readbackBuffer?.destroy();
  }
}

export function readInferenceState(
  view: DataView,
  byteOffset = 0,
): InferenceStateSnapshot {
  const word = (offset: number) => view.getUint32(byteOffset + offset * WORD_BYTES, true);
  return {
    status: word(InferenceStateWord.Status),
    errorCode: word(InferenceStateWord.ErrorCode),
    errorStartByte: word(InferenceStateWord.ErrorStartByte),
    errorEndByte: word(InferenceStateWord.ErrorEndByte),
    errorDetail: word(InferenceStateWord.ErrorDetail),
    errorOperand0: word(InferenceStateWord.ErrorOperand0),
    errorOperand1: word(InferenceStateWord.ErrorOperand1),
    errorContext: word(InferenceStateWord.ErrorContext),
    transitions: word(InferenceStateWord.Transitions),
    phase: word(InferenceStateWord.Phase),
    typeTop: word(InferenceStateWord.TypeTop),
    environmentTop: word(InferenceStateWord.EnvironmentTop),
    frameTop: word(InferenceStateWord.FrameTop),
    refinementTop: word(InferenceStateWord.RefinementTop),
    outputRoot: word(InferenceStateWord.OutputRoot),
    outputCount: word(InferenceStateWord.OutputCount),
    profile: readInferenceProfile(view, byteOffset),
  };
}

/**
 * Per-frame-kind transition counts, in `INFERENCE_PROFILE_BUCKET_NAMES` order. Cumulative across
 * dispatches, like `transitions` itself, so the terminal readback carries the whole run.
 */
export function readInferenceProfile(view: DataView, byteOffset = 0): Uint32Array {
  const profile = new Uint32Array(INFERENCE_PROFILE_BUCKET_COUNT);
  for (let bucket = 0; bucket < INFERENCE_PROFILE_BUCKET_COUNT; bucket++) {
    profile[bucket] = view.getUint32(
      byteOffset + (InferenceSchedulerWord.Profile + bucket) * WORD_BYTES,
      true,
    );
  }
  return profile;
}

export function readSemanticState(
  view: DataView,
  byteOffset: number,
): GpuSemanticStateSnapshot {
  const word = (offset: number) => view.getUint32(byteOffset + offset * WORD_BYTES, true);
  return {
    nodeCount: word(CompilationStateWord.NodeCount),
    definitionCount: word(CompilationStateWord.DefinitionCount),
    typeCount: word(CompilationStateWord.TypeCount),
    constructorCount: word(CompilationStateWord.ConstructorCount),
    entrySymbol: word(CompilationStateWord.EntrySymbol),
    status: word(CompilationStateWord.Status),
    errorCode: word(CompilationStateWord.ErrorCode),
    errorSource: word(CompilationStateWord.ErrorSource),
    errorDetail: word(CompilationStateWord.ErrorDetail),
    entryDefinition: word(CompilationStateWord.EntryDefinition),
    totalSteps: word(CompilationStateWord.TotalSteps),
    maximumSteps: word(CompilationStateWord.MaximumSteps),
    maximumStepsPerDispatch: word(CompilationStateWord.MaximumStepsPerDispatch),
  };
}
