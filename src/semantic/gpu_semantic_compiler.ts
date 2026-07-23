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
  LAZULI_COMPILER_SHADER,
  LAZULI_PLANNED_LOWERING_WORKGROUP_SIZE,
  LazuliCompilationInternalStateWord as InternalStateWord,
  LazuliCompilationStateWord as StateWord,
  LazuliCompilationStatus as Status,
} from "./compiler_shader.ts";
import {
  diagnosticFromSemanticState,
  formatInvalidSurfaceState,
  formatSemanticState,
  LazuliSemanticCompilerErrorCode as ErrorCode,
  semanticWorkLimitDiagnostic,
} from "./compilation_diagnostics.ts";
import { CompiledGpuLazuliModule, type LazuliCompileResult } from "./compiler_module.ts";
import {
  compileLazuliBatch,
  type LazuliBatchCompilationInput,
  type LazuliBatchCompilationInstrumentation,
} from "./gpu_batch_compiler.ts";
import { GpuDispatchScheduler } from "../functional/gpu_dispatch_scheduler.ts";
import type { GpuLazuliSemanticPipelines } from "./gpu_semantic_contract.ts";
import { runGpuLazuliCompilationInference } from "./gpu_type_inference_runner.ts";
import type { GpuLazuliCompilationDispatchObservation } from "./gpu_type_inference_contract.ts";
import { LAZULI_TYPE_INFERENCE_SHADER } from "./type_inference_shader.ts";
import { createLazuliSymbolLookup } from "./symbol_lookup.ts";

export interface LazuliSemanticCompilationLimits {
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
}

export interface LazuliSemanticCompilationInstrumentation {
  readonly observeDispatch: (observation: GpuLazuliCompilationDispatchObservation) => void;
}

export class GpuLazuliSemanticCompiler {
  readonly #device: GPUDevice;
  readonly #pipelines: GpuLazuliSemanticPipelines;
  readonly #inferencePipeline: GPUComputePipeline;
  readonly #dispatchScheduler: GpuDispatchScheduler;

  private constructor(
    device: GPUDevice,
    pipelines: GpuLazuliSemanticPipelines,
    inferencePipeline: GPUComputePipeline,
  ) {
    this.#device = device;
    this.#pipelines = pipelines;
    this.#inferencePipeline = inferencePipeline;
    this.#dispatchScheduler = new GpuDispatchScheduler(device);
  }

  static async create(device: GPUDevice): Promise<GpuLazuliSemanticCompiler> {
    const shaderModule = device.createShaderModule({
      label: "Lazuli semantic compiler",
      code: LAZULI_COMPILER_SHADER,
    });
    const inferenceShaderModule = device.createShaderModule({
      label: "Lazuli type inference",
      code: LAZULI_TYPE_INFERENCE_SHADER,
    });
    const [compilation, inferenceCompilation] = await Promise.all([
      shaderModule.getCompilationInfo(),
      inferenceShaderModule.getCompilationInfo(),
    ]);
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length > 0) {
      const formattedErrors = errors.map((message) =>
        `${message.lineNum}:${message.linePos}: ${message.message}`
      ).join("\n");
      throw new Error(`WebGPU rejected the Lazuli compiler shader:\n${formattedErrors}`);
    }
    const inferenceErrors = inferenceCompilation.messages.filter((message) =>
      message.type === "error"
    );
    if (inferenceErrors.length > 0) {
      const formattedErrors = inferenceErrors.map((message) =>
        `${message.lineNum}:${message.linePos}: ${message.message}`
      ).join("\n");
      throw new Error(`WebGPU rejected the Lazuli type inference shader:\n${formattedErrors}`);
    }

    try {
      const semanticBindGroupLayout = device.createBindGroupLayout({
        label: "Lazuli semantic compiler bindings",
        entries: [
          semanticStorageBinding(0, "storage"),
          semanticStorageBinding(1, "read-only-storage"),
          semanticStorageBinding(2, "read-only-storage"),
          semanticStorageBinding(3, "read-only-storage"),
          semanticStorageBinding(4, "storage"),
          semanticStorageBinding(5, "storage"),
          semanticStorageBinding(6, "storage"),
        ],
      });
      const semanticPipelineLayout = device.createPipelineLayout({
        label: "Lazuli semantic compiler pipeline layout",
        bindGroupLayouts: [semanticBindGroupLayout],
      });
      const [
        compilationPipeline,
        plannedLoweringPipeline,
        inferencePipeline,
      ] = await Promise.all([
        device.createComputePipelineAsync({
          label: "Lazuli semantic compiler pipeline",
          layout: semanticPipelineLayout,
          compute: {
            module: shaderModule,
            entryPoint: "compile_lazuli",
          },
        }),
        device.createComputePipelineAsync({
          label: "Lazuli planned lowering pipeline",
          layout: semanticPipelineLayout,
          compute: {
            module: shaderModule,
            entryPoint: "lower_planned_lazuli",
          },
        }),
        device.createComputePipelineAsync({
          label: "Lazuli type inference pipeline",
          layout: "auto",
          compute: {
            module: inferenceShaderModule,
            entryPoint: "infer_lazuli_types",
          },
        }),
      ]);
      return new GpuLazuliSemanticCompiler(
        device,
        {
          compilation: compilationPipeline,
          plannedLowering: plannedLoweringPipeline,
        },
        inferencePipeline,
      );
    } catch (cause) {
      throw new Error("WebGPU could not create the Lazuli semantic compiler pipeline", { cause });
    }
  }

  async compile(
    surface: EncodedLazuliSurface,
    sourceByteLength: number,
    limits: LazuliSemanticCompilationLimits,
    signal: AbortSignal | undefined,
    instrumentation?: LazuliSemanticCompilationInstrumentation,
  ): Promise<LazuliCompileResult> {
    const initialState = new ArrayBuffer(LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH);
    const initialStateView = new DataView(initialState);
    initialStateView.setUint32(StateWord.NodeCount * 4, surface.nodeCount, true);
    initialStateView.setUint32(StateWord.DefinitionCount * 4, surface.definitionCount, true);
    initialStateView.setUint32(StateWord.TypeCount * 4, surface.typeCount, true);
    initialStateView.setUint32(StateWord.ConstructorCount * 4, surface.constructorCount, true);
    initialStateView.setUint32(StateWord.EntrySymbol * 4, surface.mainSymbol, true);
    initialStateView.setUint32(StateWord.Status * 4, 0, true);
    initialStateView.setUint32(StateWord.ErrorCode * 4, ErrorCode.None, true);
    initialStateView.setUint32(StateWord.ErrorSource * 4, LAZULI_NO_INDEX, true);
    initialStateView.setUint32(StateWord.ErrorDetail * 4, LAZULI_NO_INDEX, true);
    initialStateView.setUint32(StateWord.EntryDefinition * 4, LAZULI_NO_INDEX, true);
    initialStateView.setUint32(StateWord.TotalSteps * 4, 0, true);
    initialStateView.setUint32(StateWord.MaximumSteps * 4, limits.maximumSteps, true);
    initialStateView.setUint32(
      StateWord.MaximumStepsPerDispatch * 4,
      limits.maximumStepsPerDispatch,
      true,
    );
    initialStateView.setUint32(
      InternalStateWord.SymbolCount * 4,
      surface.symbolNames.length,
      true,
    );
    initialStateView.setUint32(InternalStateWord.SymbolLookupBase * 4, 0, true);
    const symbolLookupWords = createLazuliSymbolLookup(surface);

    let surfaceNodeBuffer: GPUBuffer | undefined;
    let coreNodeBuffer: GPUBuffer | undefined;
    let definitionBuffer: GPUBuffer | undefined;
    let typeBuffer: GPUBuffer | undefined;
    let constructorBuffer: GPUBuffer | undefined;
    let stateBuffer: GPUBuffer | undefined;
    let symbolLookupBuffer: GPUBuffer | undefined;
    let bindGroup: GPUBindGroup | undefined;
    let nodeBufferTransferred = false;
    let definitionBufferTransferred = false;
    let constructorBufferTransferred = false;
    const surfaceNodeByteLength = storageBufferSize(
      surface.nodeCount,
      LAZULI_NODE_BYTE_LENGTH,
    );
    const definitionByteLength = storageBufferSize(
      surface.definitionCount,
      LAZULI_DEFINITION_BYTE_LENGTH,
    );
    const typeByteLength = storageBufferSize(surface.typeCount, LAZULI_TYPE_BYTE_LENGTH);
    const constructorByteLength = storageBufferSize(
      surface.constructorCount,
      LAZULI_CONSTRUCTOR_BYTE_LENGTH,
    );
    const symbolLookupByteLength = storageBufferSize(
      symbolLookupWords.length,
      Uint32Array.BYTES_PER_ELEMENT,
    );
    const allocationEvidence =
      `surface nodes=${surfaceNodeByteLength} bytes, core nodes=${surfaceNodeByteLength} bytes, definitions=${definitionByteLength} bytes, algebraic types=${typeByteLength} bytes, constructors=${constructorByteLength} bytes, state=${LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH} bytes`;

    try {
      this.#device.pushErrorScope("validation");
      this.#device.pushErrorScope("out-of-memory");
      let setupFailure: { readonly cause: unknown } | undefined;
      try {
        surfaceNodeBuffer = this.#device.createBuffer({
          label: "Lazuli surface nodes",
          size: surfaceNodeByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        definitionBuffer = this.#device.createBuffer({
          label: "Lazuli definitions",
          size: definitionByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        typeBuffer = this.#device.createBuffer({
          label: "Lazuli algebraic types",
          size: typeByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        constructorBuffer = this.#device.createBuffer({
          label: "Lazuli constructors",
          size: constructorByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        coreNodeBuffer = this.#device.createBuffer({
          label: "Lazuli core nodes",
          size: surfaceNodeByteLength,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateBuffer = this.#device.createBuffer({
          label: "Lazuli compilation state",
          size: LAZULI_COMPILATION_INTERNAL_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        symbolLookupBuffer = this.#device.createBuffer({
          label: "Lazuli symbol lookup",
          size: symbolLookupByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });

        writeWords(this.#device.queue, surfaceNodeBuffer, surface.nodeWords);
        writeWords(this.#device.queue, definitionBuffer, surface.definitionWords);
        writeWords(this.#device.queue, typeBuffer, surface.typeWords);
        writeWords(this.#device.queue, constructorBuffer, surface.constructorWords);
        writeWords(this.#device.queue, symbolLookupBuffer, symbolLookupWords);
        this.#device.queue.writeBuffer(stateBuffer, 0, initialState);

        bindGroup = this.#device.createBindGroup({
          label: "Lazuli semantic compiler bindings",
          layout: this.#pipelines.compilation.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: surfaceNodeBuffer } },
            { binding: 1, resource: { buffer: definitionBuffer } },
            { binding: 2, resource: { buffer: typeBuffer } },
            { binding: 3, resource: { buffer: constructorBuffer } },
            { binding: 4, resource: { buffer: coreNodeBuffer } },
            { binding: 5, resource: { buffer: stateBuffer } },
            { binding: 6, resource: { buffer: symbolLookupBuffer } },
          ],
        });
      } catch (cause) {
        setupFailure = { cause };
      }

      const outOfMemory = this.#device.popErrorScope();
      const validation = this.#device.popErrorScope();
      const [outOfMemoryError, validationError] = await Promise.all([
        outOfMemory,
        validation,
      ]);
      if (validationError !== null) {
        throw new Error(
          `WebGPU rejected Lazuli compilation for ${surface.nodeCount} nodes, ${surface.definitionCount} definitions, ${surface.typeCount} types, and ${surface.constructorCount} constructors (${allocationEvidence}): ${validationError.message}`,
          setupFailure === undefined ? undefined : { cause: setupFailure.cause },
        );
      }
      if (outOfMemoryError !== null) {
        return {
          ok: false,
          diagnostics: [{
            stage: "compile",
            code: "L1003",
            message:
              `program exhausted GPU memory before semantic compilation; required ${allocationEvidence}: ${outOfMemoryError.message}`,
            span: { startByte: 0, endByte: sourceByteLength },
          }],
        };
      }
      if (setupFailure !== undefined) throw setupFailure.cause;
      if (
        surfaceNodeBuffer === undefined || coreNodeBuffer === undefined ||
        definitionBuffer === undefined || typeBuffer === undefined ||
        constructorBuffer === undefined || stateBuffer === undefined ||
        symbolLookupBuffer === undefined || bindGroup === undefined
      ) {
        throw new Error(
          `WebGPU did not create Lazuli semantic compiler buffers and bindings (${allocationEvidence})`,
        );
      }

      const plannedLoweringWorkgroups = surface.nodeCount <
          LAZULI_PLANNED_LOWERING_WORKGROUP_SIZE
        ? 0
        : Math.ceil(surface.nodeCount / LAZULI_PLANNED_LOWERING_WORKGROUP_SIZE);
      const combined = await runGpuLazuliCompilationInference({
        device: this.#device,
        pipeline: this.#inferencePipeline,
        surface,
        coreNodeBuffer,
        definitionBuffer,
        typeBuffer,
        constructorBuffer,
        maximumSteps: limits.maximumSteps,
        maximumStepsPerDispatch: limits.maximumStepsPerDispatch,
        sourceByteLength,
        ...(signal === undefined ? {} : { signal }),
        ...(instrumentation === undefined
          ? {}
          : { observeCompilationDispatch: instrumentation.observeDispatch }),
      }, {
        pipelines: this.#pipelines,
        bindGroup,
        stateBuffer,
        plannedLoweringWorkgroups,
      }, this.#dispatchScheduler);
      const state = combined.semanticState;

      if (state.status === Status.Ok) {
        if (
          state.nodeCount !== surface.nodeCount ||
          state.definitionCount !== surface.definitionCount ||
          state.typeCount !== surface.typeCount ||
          state.constructorCount !== surface.constructorCount ||
          state.errorCode !== ErrorCode.None ||
          state.errorSource !== LAZULI_NO_INDEX ||
          state.errorDetail !== LAZULI_NO_INDEX ||
          state.entryDefinition >= surface.definitionCount
        ) {
          throw new Error(
            `GPU Lazuli compiler returned inconsistent success state: ${
              formatSemanticState(state)
            }`,
          );
        }
        const inference = combined.inference;
        if (inference === undefined) {
          throw new Error(
            `GPU Lazuli type inference omitted a result after semantic success: ${
              formatSemanticState(state)
            }`,
          );
        }
        if (!inference.ok) {
          return { ok: false, diagnostics: [inference.diagnostic] };
        }
        const module = new CompiledGpuLazuliModule(
          this.#device,
          coreNodeBuffer,
          definitionBuffer,
          constructorBuffer,
          surface,
          state.entryDefinition,
          inference.mainType,
          inference.typeDeclarations,
          combined.coreNodeBytes,
        );
        nodeBufferTransferred = true;
        definitionBufferTransferred = true;
        constructorBufferTransferred = true;
        return { ok: true, module };
      }

      if (state.status === Status.Diagnostic) {
        const diagnostic = diagnosticFromSemanticState(state, surface, sourceByteLength);
        if (diagnostic === undefined) {
          throw new Error(
            `GPU Lazuli compiler returned inconsistent diagnostic state: ${
              formatSemanticState(state)
            }`,
          );
        }
        return { ok: false, diagnostics: [diagnostic] };
      }

      if (state.status === Status.InvalidSurface) {
        throw new Error(
          `GPU Lazuli compiler rejected an impossible encoded surface: ${
            formatInvalidSurfaceState(state)
          }`,
        );
      }

      if (state.status === Status.StepLimit) {
        return {
          ok: false,
          diagnostics: [semanticWorkLimitDiagnostic(
            state.totalSteps,
            sourceByteLength,
            limits.maximumSteps,
          )],
        };
      }

      throw new Error(
        `GPU Lazuli compiler returned unknown status: ${formatSemanticState(state)}`,
      );
    } finally {
      surfaceNodeBuffer?.destroy();
      typeBuffer?.destroy();
      stateBuffer?.destroy();
      symbolLookupBuffer?.destroy();
      if (!nodeBufferTransferred) {
        coreNodeBuffer?.destroy();
      }
      if (!definitionBufferTransferred) {
        definitionBuffer?.destroy();
      }
      if (!constructorBufferTransferred) {
        constructorBuffer?.destroy();
      }
    }
  }

  async compileBatch(
    inputs: readonly LazuliBatchCompilationInput[],
    signal: AbortSignal | undefined,
    instrumentation?: LazuliBatchCompilationInstrumentation,
  ): Promise<readonly LazuliCompileResult[]> {
    return await compileLazuliBatch(
      this.#device,
      this.#pipelines,
      this.#inferencePipeline,
      inputs,
      signal,
      async (input) =>
        await this.compile(
          input.surface,
          input.sourceByteLength,
          input,
          signal,
        ),
      instrumentation,
    );
  }
}

function semanticStorageBinding(
  binding: number,
  type: GPUBufferBindingType,
): GPUBindGroupLayoutEntry {
  return {
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type },
  };
}

function storageBufferSize(recordCount: number, recordByteLength: number): number {
  return Math.max(recordByteLength, recordCount * recordByteLength);
}

function writeWords(queue: GPUQueue, buffer: GPUBuffer, words: Uint32Array): void {
  if (words.byteLength === 0) return;
  const transferableWords = words.buffer instanceof ArrayBuffer
    ? new Uint32Array(words.buffer, words.byteOffset, words.length)
    : words.slice();
  queue.writeBuffer(buffer, 0, transferableWords);
}
