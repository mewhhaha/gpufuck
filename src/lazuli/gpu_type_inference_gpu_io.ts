import { type EncodedLazuliSurface } from "./abi.ts";
import {
  LAZULI_COMPILATION_STATE_BYTE_LENGTH,
  LazuliCompilationStateWord,
  LazuliCompilationStatus,
} from "./compiler_shader.ts";
import { type GpuDispatchScheduler } from "../functional/gpu_dispatch_scheduler.ts";
import {
  type GpuLazuliSemanticCompilationPass,
  type GpuLazuliSemanticStateSnapshot,
} from "./gpu_semantic_contract.ts";
import {
  type GpuLazuliTypeInferenceOptions,
  type InferenceStateSnapshot,
  type WorkspaceLayout,
} from "./gpu_type_inference_contract.ts";
import {
  checkedProduct,
  INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
  inferenceOutputBufferByteLength,
  inferredTypeOutputByteLength,
} from "./gpu_type_inference_workspace.ts";
import {
  LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH,
  LAZULI_TYPE_INFERENCE_SHADER,
  LazuliInferenceSchedulerWord,
  LazuliInferenceStateWord,
} from "./type_inference_shader.ts";

const WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;
export const SEMANTIC_SNAPSHOT_BYTE_OFFSET = LazuliInferenceSchedulerWord.SemanticState *
  WORD_BYTES;

/** Creates the shader module used with {@link runGpuLazuliTypeInference}. */
export function createLazuliTypeInferenceShaderModule(device: GPUDevice): GPUShaderModule {
  return device.createShaderModule({
    label: "Lazuli type inference",
    code: LAZULI_TYPE_INFERENCE_SHADER,
  });
}

export async function createInferenceBindGroup(
  options: GpuLazuliTypeInferenceOptions,
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
      label: "Lazuli type inference bindings",
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
        `WebGPU rejected Lazuli type inference bindings for ${options.surface.nodeCount} nodes (${allocationEvidence}): ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    throw new Error(
      `WebGPU rejected Lazuli type inference bindings for ${options.surface.nodeCount} nodes (${allocationEvidence}): ${validationError.message}`,
    );
  }
  if (bindGroup === undefined) {
    throw new Error(
      `WebGPU did not create Lazuli type inference bindings for ${options.surface.nodeCount} nodes (${allocationEvidence})`,
    );
  }
  return bindGroup;
}

export async function runSemanticCompilationToCompletion(
  options: GpuLazuliTypeInferenceOptions,
  semanticPass: GpuLazuliSemanticCompilationPass,
): Promise<GpuLazuliSemanticStateSnapshot> {
  let readbackBuffer: GPUBuffer | undefined;
  let mapped = false;
  options.device.pushErrorScope("validation");
  let creationValidation: Promise<GPUError | null>;
  try {
    readbackBuffer = options.device.createBuffer({
      label: "Lazuli semantic preflight fallback readback",
      size: LAZULI_COMPILATION_STATE_BYTE_LENGTH,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    creationValidation = options.device.popErrorScope();
  } catch (cause) {
    const validationError = await options.device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli semantic preflight fallback: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }

  try {
    const creationError = await creationValidation;
    if (creationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli semantic preflight fallback: ${creationError.message}`,
      );
    }
    if (readbackBuffer === undefined) {
      throw new Error("WebGPU did not create a Lazuli semantic preflight fallback readback");
    }
    let previousSteps = 0;
    while (true) {
      options.signal?.throwIfAborted();
      options.device.pushErrorScope("validation");
      let dispatchValidation: Promise<GPUError | null>;
      try {
        const commands = options.device.createCommandEncoder({
          label: "Lazuli semantic preflight fallback commands",
        });
        const pass = commands.beginComputePass({ label: "Compile Lazuli surface nodes" });
        pass.setPipeline(semanticPass.pipeline);
        pass.setBindGroup(0, semanticPass.bindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        commands.copyBufferToBuffer(
          semanticPass.stateBuffer,
          0,
          readbackBuffer,
          0,
          LAZULI_COMPILATION_STATE_BYTE_LENGTH,
        );
        options.signal?.throwIfAborted();
        options.device.queue.submit([commands.finish()]);
        dispatchValidation = options.device.popErrorScope();
      } catch (cause) {
        const validationError = await options.device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli semantic preflight fallback for ${options.surface.nodeCount} nodes: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }
      const dispatchError = await dispatchValidation;
      if (dispatchError !== null) {
        throw new Error(
          `WebGPU rejected Lazuli semantic preflight fallback for ${options.surface.nodeCount} nodes: ${dispatchError.message}`,
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
          `GPU Lazuli semantic preflight fallback returned invalid progress: previousSteps=${previousSteps}, steps=${semanticState.totalSteps}, maximumStepsPerDispatch=${options.maximumStepsPerDispatch}`,
        );
      }
      if (semanticState.status !== LazuliCompilationStatus.Pending) return semanticState;
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
  surface: EncodedLazuliSurface,
  semanticPass: GpuLazuliSemanticCompilationPass | undefined,
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
          semanticPass,
        ),
      validationContext: `WebGPU rejected Lazuli type inference for ${surface.nodeCount} nodes`,
      ...(signal === undefined ? {} : { signal }),
    });
    return;
  }

  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    const commands = device.createCommandEncoder({
      label: semanticPass === undefined
        ? "Lazuli type inference commands"
        : "Lazuli semantic compilation and type inference commands",
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
      semanticPass,
    );
    signal?.throwIfAborted();
    device.queue.submit([commands.finish()]);
    validation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli type inference for ${surface.nodeCount} nodes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    throw new Error(
      `WebGPU rejected Lazuli type inference for ${surface.nodeCount} nodes: ${validationError.message}`,
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
  semanticPass: GpuLazuliSemanticCompilationPass | undefined,
): void {
  if (semanticPass !== undefined) {
    const semanticCompute = commands.beginComputePass({
      label: "Compile Lazuli surface nodes",
    });
    semanticCompute.setPipeline(semanticPass.pipeline);
    semanticCompute.setBindGroup(0, semanticPass.bindGroup);
    semanticCompute.dispatchWorkgroups(1);
    semanticCompute.end();
    commands.copyBufferToBuffer(
      semanticPass.stateBuffer,
      0,
      stateBuffer,
      SEMANTIC_SNAPSHOT_BYTE_OFFSET,
      LAZULI_COMPILATION_STATE_BYTE_LENGTH,
    );
  }
  const pass = commands.beginComputePass({ label: "Infer Lazuli types" });
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
}

export async function copyOutputForReadback(
  device: GPUDevice,
  outputBuffer: GPUBuffer,
  outputReadbackBuffer: GPUBuffer,
  outputCount: number,
  surface: EncodedLazuliSurface,
): Promise<void> {
  const byteLength = inferredTypeOutputByteLength(outputCount);
  if (byteLength === 0) {
    throw new Error("GPU Lazuli type inference completed without an output type");
  }
  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    const commands = device.createCommandEncoder({
      label: "Lazuli inferred type readback commands",
    });
    commands.copyBufferToBuffer(outputBuffer, 0, outputReadbackBuffer, 0, byteLength);
    device.queue.submit([commands.finish()]);
    validation = device.popErrorScope();
  } catch (cause) {
    const validationError = await device.popErrorScope();
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli inferred type readback for ${surface.nodeCount} nodes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  const validationError = await validation;
  if (validationError !== null) {
    throw new Error(
      `WebGPU rejected Lazuli inferred type readback for ${surface.nodeCount} nodes: ${validationError.message}`,
    );
  }
}

export async function readDiagnosticWorkspace(
  device: GPUDevice,
  workspaceBuffer: GPUBuffer,
  state: InferenceStateSnapshot,
  layout: WorkspaceLayout,
  surface: EncodedLazuliSurface,
): Promise<DataView> {
  const byteLength = checkedProduct(
    "type diagnostic workspace bytes",
    state.typeTop,
    LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH * WORD_BYTES,
  );
  if (byteLength === 0) return new DataView(new ArrayBuffer(0));

  let readbackBuffer: GPUBuffer | undefined;
  let mapped = false;
  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    readbackBuffer = device.createBuffer({
      label: "Lazuli type diagnostic workspace readback",
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const commands = device.createCommandEncoder({
      label: "Lazuli type diagnostic workspace readback commands",
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
        `WebGPU rejected Lazuli type diagnostic readback for ${surface.nodeCount} nodes: ${validationError.message}`,
        { cause },
      );
    }
    throw cause;
  }
  try {
    const validationError = await validation;
    if (validationError !== null) {
      throw new Error(
        `WebGPU rejected Lazuli type diagnostic readback for ${surface.nodeCount} nodes: ${validationError.message}`,
      );
    }
    if (readbackBuffer === undefined) {
      throw new Error("WebGPU did not create a Lazuli type diagnostic readback buffer");
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
    status: word(LazuliInferenceStateWord.Status),
    errorCode: word(LazuliInferenceStateWord.ErrorCode),
    errorStartByte: word(LazuliInferenceStateWord.ErrorStartByte),
    errorEndByte: word(LazuliInferenceStateWord.ErrorEndByte),
    errorDetail: word(LazuliInferenceStateWord.ErrorDetail),
    errorOperand0: word(LazuliInferenceStateWord.ErrorOperand0),
    errorOperand1: word(LazuliInferenceStateWord.ErrorOperand1),
    errorContext: word(LazuliInferenceStateWord.ErrorContext),
    transitions: word(LazuliInferenceStateWord.Transitions),
    phase: word(LazuliInferenceStateWord.Phase),
    typeTop: word(LazuliInferenceStateWord.TypeTop),
    environmentTop: word(LazuliInferenceStateWord.EnvironmentTop),
    frameTop: word(LazuliInferenceStateWord.FrameTop),
    refinementTop: word(LazuliInferenceStateWord.RefinementTop),
    outputRoot: word(LazuliInferenceStateWord.OutputRoot),
    outputCount: word(LazuliInferenceStateWord.OutputCount),
  };
}

export function readSemanticState(
  view: DataView,
  byteOffset: number,
): GpuLazuliSemanticStateSnapshot {
  const word = (offset: number) => view.getUint32(byteOffset + offset * WORD_BYTES, true);
  return {
    nodeCount: word(LazuliCompilationStateWord.NodeCount),
    definitionCount: word(LazuliCompilationStateWord.DefinitionCount),
    typeCount: word(LazuliCompilationStateWord.TypeCount),
    constructorCount: word(LazuliCompilationStateWord.ConstructorCount),
    entrySymbol: word(LazuliCompilationStateWord.EntrySymbol),
    status: word(LazuliCompilationStateWord.Status),
    errorCode: word(LazuliCompilationStateWord.ErrorCode),
    errorSource: word(LazuliCompilationStateWord.ErrorSource),
    errorDetail: word(LazuliCompilationStateWord.ErrorDetail),
    entryDefinition: word(LazuliCompilationStateWord.EntryDefinition),
    totalSteps: word(LazuliCompilationStateWord.TotalSteps),
    maximumSteps: word(LazuliCompilationStateWord.MaximumSteps),
    maximumStepsPerDispatch: word(LazuliCompilationStateWord.MaximumStepsPerDispatch),
  };
}
