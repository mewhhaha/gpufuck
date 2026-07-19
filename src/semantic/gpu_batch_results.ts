import {
  LAZULI_CONSTRUCTOR_BYTE_LENGTH,
  LAZULI_DEFINITION_BYTE_LENGTH,
  LAZULI_NO_INDEX,
  LAZULI_NODE_BYTE_LENGTH,
} from "./abi.ts";
import { LazuliCompilationStatus } from "./compiler_shader.ts";
import {
  diagnosticFromSemanticState,
  formatInvalidSurfaceState,
  formatSemanticState,
  semanticWorkLimitDiagnostic,
} from "./compilation_diagnostics.ts";
import { CompiledGpuLazuliModule, type LazuliCompileResult } from "./compiler_module.ts";
import type { BatchLane } from "./gpu_batch_compiler.ts";
import type { GpuLazuliSemanticStateSnapshot } from "./gpu_semantic_contract.ts";
import type { InferenceStateSnapshot } from "./gpu_type_inference_contract.ts";
import {
  decodeMainType,
  diagnosticFromState,
  publicTypeMetadata,
} from "./gpu_type_inference_results.ts";
import { inferredTypeOutputByteLength } from "./gpu_type_inference_workspace.ts";
import {
  LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
  LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH,
  LazuliInferenceDiagnosticCode,
  LazuliInferenceMetadataFailure,
  LazuliInferenceStatus,
} from "./type_inference_shader.ts";

const WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;

export interface TerminalInference {
  readonly state: InferenceStateSnapshot;
  readonly semanticState: GpuLazuliSemanticStateSnapshot;
}

interface ModuleBuffers {
  readonly nodes: GPUBuffer;
  readonly definitions: GPUBuffer;
  readonly constructors: GPUBuffer;
}

export async function finishBatchInferenceResults(
  device: GPUDevice,
  lanes: readonly BatchLane[],
  terminal: readonly (TerminalInference | undefined)[],
  terminalOutputs: readonly (ArrayBuffer | undefined)[],
  terminalCoreNodes: readonly (ArrayBuffer | undefined)[],
  results: (LazuliCompileResult | undefined)[],
  workspaceBuffer: GPUBuffer,
  outputBuffer: GPUBuffer,
  coreSource: GPUBuffer,
  definitionSource: GPUBuffer,
  constructorSource: GPUBuffer,
): Promise<void> {
  const successfulLaneIndexes: number[] = [];
  for (const [laneIndex, completed] of terminal.entries()) {
    if (completed?.state.status === LazuliInferenceStatus.Complete) {
      successfulLaneIndexes.push(laneIndex);
    }
  }
  const outputOffsets = new Map<number, number>();
  let outputBytes = 0;
  for (const laneIndex of successfulLaneIndexes) {
    if (terminalOutputs[laneIndex] !== undefined) continue;
    const completed = terminal[laneIndex]!;
    outputOffsets.set(laneIndex, outputBytes);
    outputBytes += inferredTypeOutputByteLength(completed.state.outputCount);
  }
  let outputReadback: GPUBuffer | undefined;
  let outputMapped = false;
  const createdBuffers: GPUBuffer[] = [];
  const completedModules: CompiledGpuLazuliModule[] = [];
  const moduleBuffers = new Map<number, ModuleBuffers>();
  try {
    let outputView: DataView | undefined;
    if (successfulLaneIndexes.length > 0) {
      device.pushErrorScope("validation");
      device.pushErrorScope("out-of-memory");
      let allocationCause: unknown;
      try {
        for (const laneIndex of successfulLaneIndexes) {
          const buffers = allocateModuleBuffers(device, lanes[laneIndex]!);
          createdBuffers.push(buffers.nodes, buffers.definitions, buffers.constructors);
          moduleBuffers.set(laneIndex, buffers);
        }
      } catch (error) {
        allocationCause = error;
      }
      const [outOfMemory, validation] = await Promise.all([
        device.popErrorScope(),
        device.popErrorScope(),
      ]);
      if (validation !== null) {
        throw new Error(
          `WebGPU rejected module buffers for ${successfulLaneIndexes.length} packed Lazuli lanes: ${validation.message}`,
          allocationCause === undefined ? undefined : { cause: allocationCause },
        );
      }
      if (
        outOfMemory !== null || allocationCause !== undefined ||
        moduleBuffers.size !== successfulLaneIndexes.length
      ) {
        throw new PackedModuleAllocationError(
          `could not allocate independent module buffers for ${successfulLaneIndexes.length} packed Lazuli lanes${
            outOfMemory === null ? "" : `: ${outOfMemory.message}`
          }`,
          allocationCause,
        );
      }

      let commandsRequired = false;
      if (outputBytes > 0) {
        outputReadback = device.createBuffer({
          label: "Lazuli packed inferred type readback",
          size: outputBytes,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
      }
      const commands = device.createCommandEncoder({ label: "Finish packed Lazuli compilation" });
      for (const laneIndex of successfulLaneIndexes) {
        const lane = lanes[laneIndex]!;
        const completed = terminal[laneIndex]!;
        if (terminalOutputs[laneIndex] === undefined) {
          if (outputReadback === undefined) {
            throw new Error(`GPU Lazuli packed lane ${lane.resultIndex} omitted output readback`);
          }
          commands.copyBufferToBuffer(
            outputBuffer,
            lane.outputBase * LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES,
            outputReadback,
            outputOffsets.get(laneIndex)!,
            inferredTypeOutputByteLength(completed.state.outputCount),
          );
          commandsRequired = true;
        }
        const buffers = moduleBuffers.get(laneIndex)!;
        if (lane.surface.nodeCount > 0) {
          commands.copyBufferToBuffer(
            coreSource,
            lane.nodeBase * LAZULI_NODE_BYTE_LENGTH,
            buffers.nodes,
            0,
            lane.surface.nodeCount * LAZULI_NODE_BYTE_LENGTH,
          );
          commandsRequired = true;
        }
        if (lane.surface.definitionCount > 0) {
          commands.copyBufferToBuffer(
            definitionSource,
            lane.definitionBase * LAZULI_DEFINITION_BYTE_LENGTH,
            buffers.definitions,
            0,
            lane.surface.definitionCount * LAZULI_DEFINITION_BYTE_LENGTH,
          );
          commandsRequired = true;
        }
        if (lane.surface.constructorCount > 0) {
          commands.copyBufferToBuffer(
            constructorSource,
            lane.constructorBase * LAZULI_CONSTRUCTOR_BYTE_LENGTH,
            buffers.constructors,
            0,
            lane.surface.constructorCount * LAZULI_CONSTRUCTOR_BYTE_LENGTH,
          );
          commandsRequired = true;
        }
      }
      if (commandsRequired) device.queue.submit([commands.finish()]);
      if (outputReadback !== undefined) {
        await outputReadback.mapAsync(GPUMapMode.READ);
        outputMapped = true;
        outputView = new DataView(outputReadback.getMappedRange());
      }
    }

    for (const [laneIndex, completed] of terminal.entries()) {
      if (completed === undefined) continue;
      const lane = lanes[laneIndex]!;
      const totalSteps = completed.semanticState.totalSteps + completed.state.transitions;
      if (completed.state.status === LazuliInferenceStatus.Complete) {
        const byteLength = inferredTypeOutputByteLength(completed.state.outputCount);
        const fastOutput = terminalOutputs[laneIndex];
        const offset = outputOffsets.get(laneIndex);
        const output = fastOutput === undefined
          ? outputView === undefined || offset === undefined
            ? undefined
            : new DataView(outputView.buffer, outputView.byteOffset + offset, byteLength)
          : new DataView(fastOutput);
        if (output === undefined) {
          throw new Error(`GPU Lazuli packed lane ${lane.resultIndex} omitted its inferred type`);
        }
        const mainType = decodeMainType(
          output,
          completed.state,
          lane.surface,
        );
        const buffers = moduleBuffers.get(laneIndex);
        if (buffers === undefined) {
          throw new Error(`GPU Lazuli packed lane ${lane.resultIndex} omitted module buffers`);
        }
        const module = new CompiledGpuLazuliModule(
          device,
          buffers.nodes,
          buffers.definitions,
          buffers.constructors,
          lane.surface,
          completed.semanticState.entryDefinition,
          mainType,
          publicTypeMetadata(lane.surface).typeDeclarations,
          terminalCoreNodes[laneIndex],
        );
        completedModules.push(module);
        results[lane.resultIndex] = { ok: true, module };
        continue;
      }
      const workspace = requiresDiagnosticWorkspace(completed.state)
        ? await readLaneTypeWorkspace(device, workspaceBuffer, lane, completed.state)
        : undefined;
      results[lane.resultIndex] = {
        ok: false,
        diagnostics: [diagnosticFromState(
          completed.state,
          lane.surface,
          lane.metadata,
          workspace,
        )],
      };
      if (totalSteps > lane.maximumSteps) {
        throw new Error(
          `GPU Lazuli packed lane ${lane.resultIndex} exceeded fuel: ${totalSteps} > ${lane.maximumSteps}`,
        );
      }
    }
    createdBuffers.length = 0;
    completedModules.length = 0;
  } catch (error) {
    for (const module of completedModules) module.destroy();
    throw error;
  } finally {
    if (outputMapped) outputReadback?.unmap();
    outputReadback?.destroy();
    for (const buffer of createdBuffers) buffer.destroy();
  }
}

export class PackedModuleAllocationError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PackedModuleAllocationError";
  }
}

function allocateModuleBuffers(device: GPUDevice, lane: BatchLane): ModuleBuffers {
  let nodes: GPUBuffer | undefined;
  let definitions: GPUBuffer | undefined;
  let constructors: GPUBuffer | undefined;
  try {
    nodes = device.createBuffer({
      label: `Lazuli packed lane ${lane.resultIndex} core nodes`,
      size: Math.max(LAZULI_NODE_BYTE_LENGTH, lane.surface.nodeCount * LAZULI_NODE_BYTE_LENGTH),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });
    definitions = device.createBuffer({
      label: `Lazuli packed lane ${lane.resultIndex} definitions`,
      size: Math.max(
        LAZULI_DEFINITION_BYTE_LENGTH,
        lane.surface.definitionCount * LAZULI_DEFINITION_BYTE_LENGTH,
      ),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });
    constructors = device.createBuffer({
      label: `Lazuli packed lane ${lane.resultIndex} constructors`,
      size: Math.max(
        LAZULI_CONSTRUCTOR_BYTE_LENGTH,
        lane.surface.constructorCount * LAZULI_CONSTRUCTOR_BYTE_LENGTH,
      ),
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });
    return { nodes, definitions, constructors };
  } catch (error) {
    nodes?.destroy();
    definitions?.destroy();
    constructors?.destroy();
    throw error;
  }
}

export function batchSemanticFailure(
  lane: BatchLane,
  state: GpuLazuliSemanticStateSnapshot,
): LazuliCompileResult {
  if (state.status === LazuliCompilationStatus.Diagnostic) {
    const diagnostic = diagnosticFromSemanticState(
      state,
      lane.surface,
      lane.sourceByteLength,
    );
    if (diagnostic === undefined) {
      throw new Error(
        `GPU Lazuli packed lane returned inconsistent diagnostic: ${formatSemanticState(state)}`,
      );
    }
    return { ok: false, diagnostics: [diagnostic] };
  }
  if (state.status === LazuliCompilationStatus.StepLimit) {
    return {
      ok: false,
      diagnostics: [semanticWorkLimitDiagnostic(
        state.totalSteps,
        lane.sourceByteLength,
        lane.maximumSteps,
      )],
    };
  }
  if (state.status === LazuliCompilationStatus.InvalidSurface) {
    throw new Error(
      `GPU Lazuli packed lane rejected an impossible encoded surface: ${
        formatInvalidSurfaceState(state)
      }`,
    );
  }
  throw new Error(
    `GPU Lazuli packed lane returned unknown semantic status: ${formatSemanticState(state)}`,
  );
}

function requiresDiagnosticWorkspace(state: InferenceStateSnapshot): boolean {
  return state.errorCode === LazuliInferenceDiagnosticCode.TypeMismatch ||
    state.errorCode === LazuliInferenceDiagnosticCode.InfiniteType ||
    (state.errorCode === LazuliInferenceDiagnosticCode.InvalidTypeMetadata &&
      (state.errorContext === LazuliInferenceMetadataFailure.InvalidEmptyCaseScrutinee ||
        state.errorContext >= LazuliInferenceMetadataFailure.IndexedExpectedTypeUnresolved)) ||
    (state.errorCode === LazuliInferenceDiagnosticCode.NonConcreteMain &&
      state.errorOperand0 !== LAZULI_NO_INDEX);
}

async function readLaneTypeWorkspace(
  device: GPUDevice,
  workspaceBuffer: GPUBuffer,
  lane: BatchLane,
  state: InferenceStateSnapshot,
): Promise<DataView> {
  const byteLength = state.typeTop * LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH * WORD_BYTES;
  if (byteLength === 0) {
    throw new Error(`GPU Lazuli packed lane ${lane.resultIndex} omitted diagnostic types`);
  }
  const readback = device.createBuffer({
    label: `Lazuli packed lane ${lane.resultIndex} diagnostic types`,
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  let mapped = false;
  try {
    const commands = device.createCommandEncoder({ label: "Read packed diagnostic types" });
    commands.copyBufferToBuffer(
      workspaceBuffer,
      (lane.workspaceBase + lane.localWorkspace.typeBase) * WORD_BYTES,
      readback,
      0,
      byteLength,
    );
    device.queue.submit([commands.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    mapped = true;
    return new DataView(readback.getMappedRange().slice(0));
  } finally {
    if (mapped) readback.unmap();
    readback.destroy();
  }
}
