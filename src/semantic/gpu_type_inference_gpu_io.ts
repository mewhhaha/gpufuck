import type { EncodedLazuliSurface } from "./abi.ts";
import {
  FUNCTIONAL_COMPILATION_STATE_BYTE_LENGTH,
  FunctionalCompilationStateWord,
  FunctionalCompilationStatus,
} from "./compiler_shader.ts";
import type { GpuDispatchScheduler } from "./gpu_dispatch_scheduler.ts";
import type {
  GpuFunctionalSemanticCompilationPass,
  GpuFunctionalSemanticStateSnapshot,
} from "./gpu_semantic_contract.ts";
import type {
  GpuFunctionalTypeInferenceOptions,
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
  FUNCTIONAL_INFERENCE_TYPE_RECORD_WORD_LENGTH,
  FUNCTIONAL_TYPE_INFERENCE_SHADER,
  FunctionalInferenceSchedulerWord,
  FunctionalInferenceStateWord,
} from "./type_inference_shader.ts";

const WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;
export const SEMANTIC_SNAPSHOT_BYTE_OFFSET = FunctionalInferenceSchedulerWord.SemanticState *
  WORD_BYTES;

/** Creates the shader module used with {@link runGpuLazuliTypeInference}. */
export function createLazuliTypeInferenceShaderModule(device: GPUDevice): GPUShaderModule {
  return device.createShaderModule({
    label: "Lazuli type inference",
    code: FUNCTIONAL_TYPE_INFERENCE_SHADER,
  });
}

export async function createInferenceBindGroup(
  options: GpuFunctionalTypeInferenceOptions,
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
  options: GpuFunctionalTypeInferenceOptions,
  semanticPass: GpuFunctionalSemanticCompilationPass,
): Promise<GpuFunctionalSemanticStateSnapshot> {
  let readbackBuffer: GPUBuffer | undefined;
  let mapped = false;
  options.device.pushErrorScope("validation");
  let creationValidation: Promise<GPUError | null>;
  try {
    readbackBuffer = options.device.createBuffer({
      label: "Lazuli semantic preflight fallback readback",
      size: FUNCTIONAL_COMPILATION_STATE_BYTE_LENGTH,
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
        encodeSemanticCompilation(commands, semanticPass, 1);
        commands.copyBufferToBuffer(
          semanticPass.stateBuffer,
          0,
          readbackBuffer,
          0,
          FUNCTIONAL_COMPILATION_STATE_BYTE_LENGTH,
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
      if (semanticState.status !== FunctionalCompilationStatus.Pending) return semanticState;
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
  surface: EncodedLazuliSurface,
  semanticPass: GpuFunctionalSemanticCompilationPass | undefined,
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
  coreNodeBuffer: GPUBuffer,
  coreReadbackByteOffset: number,
  coreReadbackByteLength: number,
  semanticPass: GpuFunctionalSemanticCompilationPass | undefined,
): void {
  if (semanticPass !== undefined) {
    encodeSemanticCompilation(commands, semanticPass, 1);
    commands.copyBufferToBuffer(
      semanticPass.stateBuffer,
      0,
      stateBuffer,
      SEMANTIC_SNAPSHOT_BYTE_OFFSET,
      FUNCTIONAL_COMPILATION_STATE_BYTE_LENGTH,
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
  semanticPass: GpuFunctionalSemanticCompilationPass,
  laneCount: number,
): void {
  const compilation = commands.beginComputePass({
    label: "Compile Lazuli surface nodes",
  });
  compilation.setPipeline(semanticPass.pipelines.compilation);
  compilation.setBindGroup(0, semanticPass.bindGroup);
  compilation.dispatchWorkgroups(laneCount);
  compilation.end();
  if (semanticPass.plannedLoweringWorkgroups === 0) return;

  const lowering = commands.beginComputePass({
    label: "Lower planned Lazuli nodes",
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
    FUNCTIONAL_INFERENCE_TYPE_RECORD_WORD_LENGTH * WORD_BYTES,
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
    status: word(FunctionalInferenceStateWord.Status),
    errorCode: word(FunctionalInferenceStateWord.ErrorCode),
    errorStartByte: word(FunctionalInferenceStateWord.ErrorStartByte),
    errorEndByte: word(FunctionalInferenceStateWord.ErrorEndByte),
    errorDetail: word(FunctionalInferenceStateWord.ErrorDetail),
    errorOperand0: word(FunctionalInferenceStateWord.ErrorOperand0),
    errorOperand1: word(FunctionalInferenceStateWord.ErrorOperand1),
    errorContext: word(FunctionalInferenceStateWord.ErrorContext),
    transitions: word(FunctionalInferenceStateWord.Transitions),
    phase: word(FunctionalInferenceStateWord.Phase),
    typeTop: word(FunctionalInferenceStateWord.TypeTop),
    environmentTop: word(FunctionalInferenceStateWord.EnvironmentTop),
    frameTop: word(FunctionalInferenceStateWord.FrameTop),
    refinementTop: word(FunctionalInferenceStateWord.RefinementTop),
    outputRoot: word(FunctionalInferenceStateWord.OutputRoot),
    outputCount: word(FunctionalInferenceStateWord.OutputCount),
  };
}

export function readSemanticState(
  view: DataView,
  byteOffset: number,
): GpuFunctionalSemanticStateSnapshot {
  const word = (offset: number) => view.getUint32(byteOffset + offset * WORD_BYTES, true);
  return {
    nodeCount: word(FunctionalCompilationStateWord.NodeCount),
    definitionCount: word(FunctionalCompilationStateWord.DefinitionCount),
    typeCount: word(FunctionalCompilationStateWord.TypeCount),
    constructorCount: word(FunctionalCompilationStateWord.ConstructorCount),
    entrySymbol: word(FunctionalCompilationStateWord.EntrySymbol),
    status: word(FunctionalCompilationStateWord.Status),
    errorCode: word(FunctionalCompilationStateWord.ErrorCode),
    errorSource: word(FunctionalCompilationStateWord.ErrorSource),
    errorDetail: word(FunctionalCompilationStateWord.ErrorDetail),
    entryDefinition: word(FunctionalCompilationStateWord.EntryDefinition),
    totalSteps: word(FunctionalCompilationStateWord.TotalSteps),
    maximumSteps: word(FunctionalCompilationStateWord.MaximumSteps),
    maximumStepsPerDispatch: word(FunctionalCompilationStateWord.MaximumStepsPerDispatch),
  };
}
