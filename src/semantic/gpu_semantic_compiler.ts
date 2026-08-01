import {
  CONSTRUCTOR_BYTE_LENGTH,
  DEFINITION_BYTE_LENGTH,
  type EncodedSemanticSurface,
  NO_INDEX,
  NODE_BYTE_LENGTH,
  TYPE_BYTE_LENGTH,
} from "./abi.ts";
import {
  COMPILATION_INTERNAL_STATE_BYTE_LENGTH,
  CompilationInternalStateWord as InternalStateWord,
  CompilationStateWord as StateWord,
  CompilationStatus as Status,
  COMPILER_SHADER,
  PLANNED_LOWERING_WORKGROUP_SIZE,
} from "./compiler_shader.ts";
import {
  diagnosticFromSemanticState,
  formatInvalidSurfaceState,
  formatSemanticState,
  SemanticCompilerErrorCode as ErrorCode,
  semanticWorkLimitDiagnostic,
} from "./compilation_diagnostics.ts";
import { CompiledGpuSemanticModule, type SemanticCompileResult } from "./compiler_module.ts";
import {
  type BatchCompilationInput,
  type BatchCompilationInstrumentation,
  compileSemanticBatch,
} from "./gpu_batch_compiler.ts";
import { GpuDispatchScheduler } from "./gpu_dispatch_scheduler.ts";
import type { GpuSemanticPipelines } from "./gpu_semantic_contract.ts";
import { runGpuSemanticCompilationInference } from "./gpu_type_inference_runner.ts";
import type { GpuCompilationDispatchObservation } from "./gpu_type_inference_contract.ts";
import { TYPE_INFERENCE_PROFILE_SHADER, TYPE_INFERENCE_SHADER } from "./type_inference_shader.ts";
import { createSymbolLookup } from "./symbol_lookup.ts";
import {
  type CompilerPerformanceTrace,
  measureCompilerStageAsync,
} from "../compiler_performance_trace.ts";

export interface SemanticCompilationLimits {
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
}

export interface SemanticCompilationInstrumentation {
  readonly observeDispatch: (observation: GpuCompilationDispatchObservation) => void;
}

export class GpuSemanticCompiler {
  readonly #device: GPUDevice;
  readonly #pipelines: GpuSemanticPipelines;
  readonly #inferencePipeline: GPUComputePipeline;
  readonly #dispatchScheduler: GpuDispatchScheduler;

  private constructor(
    device: GPUDevice,
    pipelines: GpuSemanticPipelines,
    inferencePipeline: GPUComputePipeline,
  ) {
    this.#device = device;
    this.#pipelines = pipelines;
    this.#inferencePipeline = inferencePipeline;
    this.#dispatchScheduler = new GpuDispatchScheduler(device);
  }

  /**
   * `profileInference` swaps in the histogram-counting inference kernel. It is about 40% slower, so
   * it exists for `tools/profile_inference_frames.ts` and never for a timing measurement.
   */
  static async create(
    device: GPUDevice,
    options: { readonly profileInference?: boolean } = {},
  ): Promise<GpuSemanticCompiler> {
    const shaderModule = device.createShaderModule({
      label: "semantic compiler",
      code: COMPILER_SHADER,
    });
    const inferenceShaderModule = device.createShaderModule({
      label: options.profileInference ? "type inference (profiling)" : "type inference",
      code: options.profileInference ? TYPE_INFERENCE_PROFILE_SHADER : TYPE_INFERENCE_SHADER,
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
      throw new Error(`WebGPU rejected the compiler shader:\n${formattedErrors}`);
    }
    const inferenceErrors = inferenceCompilation.messages.filter((message) =>
      message.type === "error"
    );
    if (inferenceErrors.length > 0) {
      const formattedErrors = inferenceErrors.map((message) =>
        `${message.lineNum}:${message.linePos}: ${message.message}`
      ).join("\n");
      throw new Error(`WebGPU rejected the type inference shader:\n${formattedErrors}`);
    }

    try {
      const semanticBindGroupLayout = device.createBindGroupLayout({
        label: "semantic compiler bindings",
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
        label: "semantic compiler pipeline layout",
        bindGroupLayouts: [semanticBindGroupLayout],
      });
      // Chromium 151 leaves the async pipeline promise pending indefinitely for these generated
      // shaders. Synchronous creation completes on the same adapter; the browser tour guards this.
      const compilationPipeline = device.createComputePipeline({
        label: "semantic compiler pipeline",
        layout: semanticPipelineLayout,
        compute: {
          module: shaderModule,
          entryPoint: "compile_module",
        },
      });
      const plannedLoweringPipeline = device.createComputePipeline({
        label: "planned lowering pipeline",
        layout: semanticPipelineLayout,
        compute: {
          module: shaderModule,
          entryPoint: "lower_planned_module",
        },
      });
      const inferencePipeline = device.createComputePipeline({
        label: "type inference pipeline",
        layout: "auto",
        compute: {
          module: inferenceShaderModule,
          entryPoint: "infer_types",
        },
      });
      return new GpuSemanticCompiler(
        device,
        {
          compilation: compilationPipeline,
          plannedLowering: plannedLoweringPipeline,
        },
        inferencePipeline,
      );
    } catch (cause) {
      throw new Error("WebGPU could not create the semantic compiler pipeline", { cause });
    }
  }

  async compile(
    surface: EncodedSemanticSurface,
    sourceByteLength: number,
    limits: SemanticCompilationLimits,
    signal: AbortSignal | undefined,
    instrumentation?: SemanticCompilationInstrumentation,
    trace?: CompilerPerformanceTrace,
  ): Promise<SemanticCompileResult> {
    const initialState = new ArrayBuffer(COMPILATION_INTERNAL_STATE_BYTE_LENGTH);
    const initialStateView = new DataView(initialState);
    initialStateView.setUint32(StateWord.NodeCount * 4, surface.nodeCount, true);
    initialStateView.setUint32(StateWord.DefinitionCount * 4, surface.definitionCount, true);
    initialStateView.setUint32(StateWord.TypeCount * 4, surface.typeCount, true);
    initialStateView.setUint32(StateWord.ConstructorCount * 4, surface.constructorCount, true);
    initialStateView.setUint32(StateWord.EntrySymbol * 4, surface.entrySymbol, true);
    initialStateView.setUint32(StateWord.Status * 4, 0, true);
    initialStateView.setUint32(StateWord.ErrorCode * 4, ErrorCode.None, true);
    initialStateView.setUint32(StateWord.ErrorSource * 4, NO_INDEX, true);
    initialStateView.setUint32(StateWord.ErrorDetail * 4, NO_INDEX, true);
    initialStateView.setUint32(StateWord.EntryDefinition * 4, NO_INDEX, true);
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
    const symbolLookupWords = createSymbolLookup(surface);

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
      NODE_BYTE_LENGTH,
    );
    const definitionByteLength = storageBufferSize(
      surface.definitionCount,
      DEFINITION_BYTE_LENGTH,
    );
    const typeByteLength = storageBufferSize(surface.typeCount, TYPE_BYTE_LENGTH);
    const constructorByteLength = storageBufferSize(
      surface.constructorCount,
      CONSTRUCTOR_BYTE_LENGTH,
    );
    const symbolLookupByteLength = storageBufferSize(
      symbolLookupWords.length,
      Uint32Array.BYTES_PER_ELEMENT,
    );
    const allocationEvidence =
      `surface nodes=${surfaceNodeByteLength} bytes, core nodes=${surfaceNodeByteLength} bytes, definitions=${definitionByteLength} bytes, algebraic types=${typeByteLength} bytes, constructors=${constructorByteLength} bytes, state=${COMPILATION_INTERNAL_STATE_BYTE_LENGTH} bytes`;
    const allocationSpan = trace?.start("semantic.gpu.allocate-upload");
    let allocationSpanFinished = false;

    try {
      this.#device.pushErrorScope("validation");
      this.#device.pushErrorScope("out-of-memory");
      let setupFailure: { readonly cause: unknown } | undefined;
      try {
        surfaceNodeBuffer = this.#device.createBuffer({
          label: "surface nodes",
          size: surfaceNodeByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        definitionBuffer = this.#device.createBuffer({
          label: "definitions",
          size: definitionByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        typeBuffer = this.#device.createBuffer({
          label: "algebraic types",
          size: typeByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        constructorBuffer = this.#device.createBuffer({
          label: "constructors",
          size: constructorByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        coreNodeBuffer = this.#device.createBuffer({
          label: "core nodes",
          size: surfaceNodeByteLength,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateBuffer = this.#device.createBuffer({
          label: "compilation state",
          size: COMPILATION_INTERNAL_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        symbolLookupBuffer = this.#device.createBuffer({
          label: "symbol lookup",
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
          label: "semantic compiler bindings",
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
          `WebGPU rejected compilation for ${surface.nodeCount} nodes, ${surface.definitionCount} definitions, ${surface.typeCount} types, and ${surface.constructorCount} constructors (${allocationEvidence}): ${validationError.message}`,
          setupFailure === undefined ? undefined : { cause: setupFailure.cause },
        );
      }
      if (outOfMemoryError !== null) {
        return {
          ok: false,
          diagnostics: [{
            stage: "compile",
            code: "F1003",
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
          `WebGPU did not create semantic compiler buffers and bindings (${allocationEvidence})`,
        );
      }
      allocationSpan?.finish({
        nodes: surface.nodeCount,
        definitions: surface.definitionCount,
        uploadedBytes: surfaceNodeByteLength + definitionByteLength + typeByteLength +
          constructorByteLength + symbolLookupByteLength + COMPILATION_INTERNAL_STATE_BYTE_LENGTH,
      });
      allocationSpanFinished = true;
      const resolvedCoreNodeBuffer = coreNodeBuffer;
      const resolvedDefinitionBuffer = definitionBuffer;
      const resolvedTypeBuffer = typeBuffer;
      const resolvedConstructorBuffer = constructorBuffer;
      const resolvedStateBuffer = stateBuffer;
      const resolvedBindGroup = bindGroup;

      const plannedLoweringWorkgroups = surface.nodeCount <
          PLANNED_LOWERING_WORKGROUP_SIZE
        ? 0
        : Math.ceil(surface.nodeCount / PLANNED_LOWERING_WORKGROUP_SIZE);
      let dispatchCount = 0;
      const dispatchAnnotations: Record<string, number> = {
        nodes: surface.nodeCount,
        definitions: surface.definitionCount,
        plannedLoweringWorkgroups,
      };
      const combined = await measureCompilerStageAsync(
        trace,
        "semantic.gpu.resolve-infer-readback",
        dispatchAnnotations,
        () =>
          runGpuSemanticCompilationInference({
            device: this.#device,
            pipeline: this.#inferencePipeline,
            surface,
            coreNodeBuffer: resolvedCoreNodeBuffer,
            definitionBuffer: resolvedDefinitionBuffer,
            typeBuffer: resolvedTypeBuffer,
            constructorBuffer: resolvedConstructorBuffer,
            maximumSteps: limits.maximumSteps,
            maximumStepsPerDispatch: limits.maximumStepsPerDispatch,
            sourceByteLength,
            ...(signal === undefined ? {} : { signal }),
            ...(trace === undefined && instrumentation === undefined ? {} : {
              observeCompilationDispatch: (observation) => {
                dispatchCount += 1;
                instrumentation?.observeDispatch(observation);
              },
            }),
          }, {
            pipelines: this.#pipelines,
            bindGroup: resolvedBindGroup,
            stateBuffer: resolvedStateBuffer,
            plannedLoweringWorkgroups,
          }, this.#dispatchScheduler),
        (result) => {
          dispatchAnnotations.dispatches = dispatchCount;
          dispatchAnnotations.semanticSteps = result.semanticState.totalSteps;
          dispatchAnnotations.inferenceTransitions = result.inference?.transitions ?? 0;
        },
      );
      const state = combined.semanticState;

      if (state.status === Status.Ok) {
        if (
          state.nodeCount !== surface.nodeCount ||
          state.definitionCount !== surface.definitionCount ||
          state.typeCount !== surface.typeCount ||
          state.constructorCount !== surface.constructorCount ||
          state.errorCode !== ErrorCode.None ||
          state.errorSource !== NO_INDEX ||
          state.errorDetail !== NO_INDEX ||
          state.entryDefinition >= surface.definitionCount
        ) {
          throw new Error(
            `GPU compiler returned inconsistent success state: ${formatSemanticState(state)}`,
          );
        }
        const inference = combined.inference;
        if (inference === undefined) {
          throw new Error(
            `GPU type inference omitted a result after semantic success: ${
              formatSemanticState(state)
            }`,
          );
        }
        if (!inference.ok) {
          return { ok: false, diagnostics: [inference.diagnostic] };
        }
        const module = new CompiledGpuSemanticModule(
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
            `GPU compiler returned inconsistent diagnostic state: ${formatSemanticState(state)}`,
          );
        }
        return { ok: false, diagnostics: [diagnostic] };
      }

      if (state.status === Status.InvalidSurface) {
        throw new Error(
          `GPU compiler rejected an impossible encoded surface: ${
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
        `GPU compiler returned unknown status: ${formatSemanticState(state)}`,
      );
    } finally {
      if (!allocationSpanFinished) allocationSpan?.finish({ failed: true });
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
    inputs: readonly BatchCompilationInput[],
    signal: AbortSignal | undefined,
    instrumentation?: BatchCompilationInstrumentation,
    trace?: CompilerPerformanceTrace,
  ): Promise<readonly SemanticCompileResult[]> {
    return await compileSemanticBatch(
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
          undefined,
          trace,
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
