import {
  type EncodedLazuliSurface,
  LAZULI_NO_INDEX,
  type LazuliDiagnostic,
  type LazuliType,
  type LazuliTypeDeclaration,
  type LazuliTypeSchema,
} from "./abi.ts";
import {
  type LazuliTypeInferenceResult,
  type LazuliTypeInferenceSuccess,
} from "./type_inference.ts";
import {
  LAZULI_COMPILATION_STATE_BYTE_LENGTH,
  LazuliCompilationStateWord,
  LazuliCompilationStatus,
} from "./compiler_shader.ts";
import {
  LAZULI_INFERENCE_ENVIRONMENT_WORD_LENGTH,
  LAZULI_INFERENCE_FRAME_WORD_LENGTH,
  LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH,
  LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
  LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH,
  LAZULI_TYPE_INFERENCE_SHADER,
  LazuliInferenceDiagnosticCode,
  LazuliInferenceMetadataFailure,
  LazuliInferenceSchedulerWord,
  type LazuliInferenceShaderMetadata,
  LazuliInferenceStateWord,
  LazuliInferenceStatus,
  prepareLazuliInferenceShaderMetadata,
} from "./type_inference_shader.ts";
import { decodeLazuliType, flattenLazuliTypeSchemas } from "./type_schema_abi.ts";

/** Buffers resolved by the semantic compiler and consumed by type inference. */
export interface GpuLazuliTypeInferenceBuffers {
  readonly coreNodeBuffer: GPUBuffer;
  readonly definitionBuffer: GPUBuffer;
  readonly typeBuffer: GPUBuffer;
  readonly constructorBuffer: GPUBuffer;
}

export interface GpuLazuliTypeInferenceOptions extends GpuLazuliTypeInferenceBuffers {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
  readonly surface: EncodedLazuliSurface;
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
  /** Work already consumed by semantic resolution in the enclosing compilation. */
  readonly initialSteps?: number;
  readonly sourceByteLength?: number;
  readonly signal?: AbortSignal;
  /** Internal runner controls used to exercise arena growth without changing compiler APIs. */
  readonly initialWorkspaceCapacities?: GpuLazuliTypeInferenceWorkspaceCapacities;
  /** Internal runner observation point invoked after each completed dispatch. */
  readonly observeDispatch?: (observation: GpuLazuliTypeInferenceDispatchObservation) => void;
}

export interface GpuLazuliTypeInferenceWorkspaceCapacities {
  readonly type?: number;
  readonly environment?: number;
  readonly frame?: number;
  readonly scratch?: number;
  readonly output?: number;
}

export interface GpuLazuliTypeInferenceDispatchObservation {
  readonly status: number;
  readonly errorCode: number;
  readonly requiredCapacity: number;
  readonly transitions: number;
  readonly typeCapacity: number;
  readonly environmentCapacity: number;
  readonly frameCapacity: number;
  readonly scratchCapacity: number;
  readonly outputCapacity: number;
}

export type GpuLazuliTypeInferenceRun = LazuliTypeInferenceResult & {
  readonly transitions: number;
  readonly totalSteps: number;
};

export interface GpuLazuliSemanticCompilationPass {
  readonly pipeline: GPUComputePipeline;
  readonly bindGroup: GPUBindGroup;
  readonly stateBuffer: GPUBuffer;
}

export interface GpuLazuliSemanticStateSnapshot {
  readonly nodeCount: number;
  readonly definitionCount: number;
  readonly typeCount: number;
  readonly constructorCount: number;
  readonly entrySymbol: number;
  readonly status: number;
  readonly errorCode: number;
  readonly errorSource: number;
  readonly errorDetail: number;
  readonly entryDefinition: number;
  readonly totalSteps: number;
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
}

export type GpuLazuliCompilationInferenceRun =
  | {
    readonly semanticState: GpuLazuliSemanticStateSnapshot;
    readonly inference: GpuLazuliTypeInferenceRun;
  }
  | {
    readonly semanticState: GpuLazuliSemanticStateSnapshot;
    readonly inference?: never;
  };

interface InferenceStateSnapshot {
  readonly status: number;
  readonly errorCode: number;
  readonly errorStartByte: number;
  readonly errorEndByte: number;
  readonly errorDetail: number;
  readonly errorOperand0: number;
  readonly errorOperand1: number;
  readonly errorContext: number;
  readonly transitions: number;
  readonly phase: number;
  readonly typeTop: number;
  readonly environmentTop: number;
  readonly frameTop: number;
  readonly outputRoot: number;
  readonly outputCount: number;
}

interface WorkspaceLayout {
  readonly typeBase: number;
  readonly typeCapacity: number;
  readonly environmentBase: number;
  readonly environmentCapacity: number;
  readonly frameBase: number;
  readonly frameCapacity: number;
  readonly scratchBase: number;
  readonly scratchCapacity: number;
  readonly workspaceWordLength: number;
  readonly outputCapacity: number;
}

interface WorkspaceCapacities {
  readonly type: number;
  readonly environment: number;
  readonly frame: number;
  readonly scratch: number;
  readonly output: number;
}

const WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;
const MAXIMUM_CONSTRUCTOR_ARITY = 64;
const INFERENCE_INTERNAL_STATE_BYTE_LENGTH = LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH *
  WORD_BYTES;
const SEMANTIC_SNAPSHOT_BYTE_OFFSET = LazuliInferenceSchedulerWord.SemanticState * WORD_BYTES;
// Full-arena copies need a substantial dispatch quantum to amortize their bandwidth cost.
const COMBINED_READBACK_MINIMUM_DISPATCH_TRANSITIONS = 256;

/**
 * Runs the persistent GPU Hindley-Milner inference machine until it produces a
 * type, a source diagnostic, or consumes the compiler's remaining fuel.
 *
 * The caller retains ownership of its resolved ABI buffers. Every buffer this
 * runner creates is destroyed before this promise settles, including failed or
 * aborted runs.
 */
export async function runGpuLazuliTypeInference(
  options: GpuLazuliTypeInferenceOptions,
): Promise<GpuLazuliTypeInferenceRun> {
  const run = await runGpuLazuliTypeInferenceMachine(options);
  if (run.inference === undefined) {
    throw new Error(
      `synthetic semantic compilation did not succeed: status=${run.semanticState.status}`,
    );
  }
  return run.inference;
}

export async function runGpuLazuliCompilationInference(
  options: GpuLazuliTypeInferenceOptions,
  semanticPass: GpuLazuliSemanticCompilationPass,
): Promise<GpuLazuliCompilationInferenceRun> {
  return await runGpuLazuliTypeInferenceMachine(options, semanticPass);
}

async function runGpuLazuliTypeInferenceMachine(
  options: GpuLazuliTypeInferenceOptions,
  semanticPass?: GpuLazuliSemanticCompilationPass,
): Promise<GpuLazuliCompilationInferenceRun> {
  const initialSteps = semanticPass === undefined ? options.initialSteps ?? 0 : 0;
  validateFuel(options.maximumSteps, options.maximumStepsPerDispatch, initialSteps);
  options.signal?.throwIfAborted();

  const metadata = prepareLazuliInferenceShaderMetadata(
    options.surface,
    flattenLazuliTypeSchemas(options.surface),
  );
  let layout: WorkspaceLayout;
  try {
    assertStorageSize(
      "type inference schema metadata",
      metadata.words.length,
      options.device.limits,
    );
    layout = workspaceLayout(
      options.surface,
      metadata.schemaNodeCount,
      metadata.typeParameterCount,
      options.device.limits,
      options.initialWorkspaceCapacities,
    );
  } catch (error) {
    if (error instanceof RangeError) {
      const inference = compilerWorkspacePreflightFailed(options, initialSteps, error.message);
      return await finishAfterInferenceSetupFailure(
        options,
        semanticPass,
        initialSteps,
        inference,
      );
    }
    throw error;
  }
  const initialState = createInitialState(
    options,
    metadata,
    layout,
    semanticPass === undefined,
  );

  let metadataBuffer: GPUBuffer | undefined;
  let workspaceBuffer: GPUBuffer | undefined;
  let outputBuffer: GPUBuffer | undefined;
  let stateBuffer: GPUBuffer | undefined;
  let stateReadbackBuffer: GPUBuffer | undefined;
  let outputReadbackBuffer: GPUBuffer | undefined;
  let stateReadbackMapped = false;
  let outputReadbackMapped = false;

  try {
    const buffers = await createInferenceBuffers(options, metadata.words, layout, initialState);
    if (!buffers.ok) {
      return await finishAfterInferenceSetupFailure(
        options,
        semanticPass,
        initialSteps,
        compilerInferenceAllocationFailed(options, initialSteps, buffers.reason),
      );
    }
    metadataBuffer = buffers.metadataBuffer;
    workspaceBuffer = buffers.workspaceBuffer;
    outputBuffer = buffers.outputBuffer;
    stateBuffer = buffers.stateBuffer;

    let outputCapacity = layout.outputCapacity;
    let readbackIncludesOutput = shouldCopyOutputWithDispatch(
      options.maximumStepsPerDispatch,
      outputCapacity,
      options.device.limits,
    );
    const stateReadback = await createInferenceReadbackBuffer(
      options.device,
      outputCapacity,
      readbackIncludesOutput,
    );
    if (!stateReadback.ok) {
      metadataBuffer.destroy();
      workspaceBuffer.destroy();
      outputBuffer.destroy();
      stateBuffer.destroy();
      metadataBuffer = undefined;
      workspaceBuffer = undefined;
      outputBuffer = undefined;
      stateBuffer = undefined;
      return await finishAfterInferenceSetupFailure(
        options,
        semanticPass,
        initialSteps,
        compilerInferenceAllocationFailed(options, initialSteps, stateReadback.reason),
      );
    }
    stateReadbackBuffer = stateReadback.buffer;
    let bindGroup = await createInferenceBindGroup(
      options,
      metadataBuffer,
      workspaceBuffer,
      outputBuffer,
      stateBuffer,
    );

    let previousSemanticSteps = initialSteps;
    let previousTransitions = 0;
    let semanticState = syntheticSemanticState(options, initialSteps);
    while (true) {
      options.signal?.throwIfAborted();
      const remainingSteps = options.maximumSteps - previousSemanticSteps - previousTransitions;
      if (remainingSteps === 0) {
        return {
          semanticState,
          inference: fuelExhausted(options, previousTransitions, previousSemanticSteps),
        };
      }
      const dispatchTransitions = Math.min(options.maximumStepsPerDispatch, remainingSteps);
      writeStateWord(
        options.device,
        stateBuffer,
        LazuliInferenceStateWord.MaximumTransitionsPerDispatch,
        dispatchTransitions,
      );

      await dispatchForReadback(
        options.device,
        options.pipeline,
        bindGroup,
        outputBuffer,
        outputCapacity,
        stateBuffer,
        stateReadbackBuffer,
        readbackIncludesOutput,
        options.surface,
        semanticPass,
        options.signal,
      );
      options.signal?.throwIfAborted();

      await stateReadbackBuffer.mapAsync(GPUMapMode.READ);
      stateReadbackMapped = true;
      const dispatchReadback = stateReadbackBuffer.getMappedRange().slice(0);
      const dispatchView = new DataView(dispatchReadback);
      const state = readInferenceState(dispatchView);
      semanticState = readSemanticState(dispatchView, SEMANTIC_SNAPSHOT_BYTE_OFFSET);
      stateReadbackBuffer.unmap();
      stateReadbackMapped = false;
      options.signal?.throwIfAborted();

      assertConsistentState(
        state,
        semanticState,
        layout,
        outputCapacity,
        previousSemanticSteps,
        previousTransitions,
        dispatchTransitions,
      );
      if (semanticState.status === LazuliCompilationStatus.Pending) {
        previousSemanticSteps = semanticState.totalSteps;
        continue;
      }
      if (semanticState.status !== LazuliCompilationStatus.Ok) {
        return { semanticState };
      }
      options.observeDispatch?.({
        status: state.status,
        errorCode: state.errorCode,
        requiredCapacity: state.errorDetail,
        transitions: state.transitions,
        typeCapacity: layout.typeCapacity,
        environmentCapacity: layout.environmentCapacity,
        frameCapacity: layout.frameCapacity,
        scratchCapacity: layout.scratchCapacity,
        outputCapacity,
      });
      options.signal?.throwIfAborted();
      const totalSteps = semanticState.totalSteps + state.transitions;
      if (
        state.status === LazuliInferenceStatus.Uninitialized ||
        state.status === LazuliInferenceStatus.Pending
      ) {
        if (totalSteps >= options.maximumSteps) {
          return {
            semanticState,
            inference: fuelExhausted(options, state.transitions, semanticState.totalSteps),
          };
        }
        previousSemanticSteps = semanticState.totalSteps;
        previousTransitions = state.transitions;
        continue;
      }

      if (state.status === LazuliInferenceStatus.Complete) {
        const outputByteLength = inferredTypeOutputByteLength(state.outputCount);
        if (outputByteLength === 0) {
          throw new Error("GPU Lazuli type inference completed without an output type");
        }
        let output: DataView;
        if (readbackIncludesOutput) {
          output = new DataView(
            dispatchReadback,
            INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
            outputByteLength,
          );
        } else {
          outputReadbackBuffer = await createOutputReadbackBuffer(
            options.device,
            state.outputCount,
          );
          await copyOutputForReadback(
            options.device,
            outputBuffer,
            outputReadbackBuffer,
            state.outputCount,
            options.surface,
          );
          await outputReadbackBuffer.mapAsync(GPUMapMode.READ);
          outputReadbackMapped = true;
          output = new DataView(outputReadbackBuffer.getMappedRange().slice(0));
          outputReadbackBuffer.unmap();
          outputReadbackMapped = false;
        }
        const mainType = decodeMainType(output, state, options.surface);
        const inference = Object.freeze({
          ok: true,
          mainType,
          ...publicTypeMetadata(options.surface),
          transitions: state.transitions,
          totalSteps,
        });
        return { semanticState, inference };
      }

      if (state.status === LazuliInferenceStatus.Diagnostic) {
        const workspace = state.errorCode === LazuliInferenceDiagnosticCode.TypeMismatch ||
            state.errorCode === LazuliInferenceDiagnosticCode.InfiniteType ||
            (state.errorCode === LazuliInferenceDiagnosticCode.NonConcreteMain &&
              state.errorOperand0 !== LAZULI_NO_INDEX)
          ? await readDiagnosticWorkspace(
            options.device,
            workspaceBuffer,
            state,
            layout,
            options.surface,
          )
          : undefined;
        const inference = Object.freeze({
          ok: false,
          diagnostic: diagnosticFromState(state, options.surface, metadata, workspace),
          transitions: state.transitions,
          totalSteps,
        });
        return { semanticState, inference };
      }

      if (state.status === LazuliInferenceStatus.Exhausted) {
        if (state.errorCode === LazuliInferenceDiagnosticCode.OutputArenaExhausted) {
          const nextOutputCapacity = Math.max(outputCapacity * 2, state.errorDetail * 2);
          try {
            assertStorageSize(
              "type inference output",
              checkedProduct(
                "output words",
                nextOutputCapacity,
                LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
              ),
              options.device.limits,
            );
          } catch (error) {
            if (error instanceof RangeError) {
              return {
                semanticState,
                inference: compilerWorkspaceExhausted(
                  options,
                  state,
                  semanticState.totalSteps,
                  `cannot grow output capacity ${outputCapacity} to ${nextOutputCapacity}: ${error.message}`,
                ),
              };
            }
            throw error;
          }
          const expandedOutput = await createInferenceOutputBuffer(
            options.device,
            nextOutputCapacity,
          );
          if (!expandedOutput.ok) {
            return {
              semanticState,
              inference: compilerWorkspaceExhausted(
                options,
                state,
                semanticState.totalSteps,
                `could not allocate ${nextOutputCapacity} output records (${expandedOutput.byteLength} bytes): ${expandedOutput.reason}`,
              ),
            };
          }
          const expandedReadbackIncludesOutput = readbackIncludesOutput &&
            shouldCopyOutputWithDispatch(
              options.maximumStepsPerDispatch,
              nextOutputCapacity,
              options.device.limits,
            );
          let expandedReadbackBuffer: GPUBuffer | undefined;
          try {
            await copyOutputForGrowth(
              options.device,
              outputBuffer,
              expandedOutput.buffer,
              state.outputCount,
              options.surface,
            );
            if (expandedReadbackIncludesOutput) {
              const expandedReadback = await createInferenceReadbackBuffer(
                options.device,
                nextOutputCapacity,
                true,
              );
              if (!expandedReadback.ok) {
                expandedOutput.buffer.destroy();
                return {
                  semanticState,
                  inference: compilerWorkspaceExhausted(
                    options,
                    state,
                    semanticState.totalSteps,
                    `could not allocate expanded output readback (${expandedReadback.byteLength} bytes): ${expandedReadback.reason}`,
                  ),
                };
              }
              expandedReadbackBuffer = expandedReadback.buffer;
            }
          } catch (error) {
            expandedOutput.buffer.destroy();
            expandedReadbackBuffer?.destroy();
            throw error;
          }
          let expandedBindGroup: GPUBindGroup;
          try {
            expandedBindGroup = await createInferenceBindGroup(
              options,
              metadataBuffer,
              workspaceBuffer,
              expandedOutput.buffer,
              stateBuffer,
            );
          } catch (error) {
            expandedOutput.buffer.destroy();
            expandedReadbackBuffer?.destroy();
            throw error;
          }
          const previousOutputBuffer = outputBuffer;
          outputBuffer = expandedOutput.buffer;
          outputCapacity = nextOutputCapacity;
          bindGroup = expandedBindGroup;
          previousOutputBuffer.destroy();
          if (expandedReadbackBuffer !== undefined) {
            const previousReadbackBuffer = stateReadbackBuffer;
            stateReadbackBuffer = expandedReadbackBuffer;
            previousReadbackBuffer.destroy();
          }
          readbackIncludesOutput = expandedReadbackIncludesOutput;
          resumeOutputAfterGrowth(options.device, stateBuffer, outputCapacity);
          previousSemanticSteps = semanticState.totalSteps;
          previousTransitions = discardGrowthTransition(options.device, stateBuffer, state);
          continue;
        }
        if (isWorkspaceArenaExhaustion(state.errorCode)) {
          let expandedLayout: WorkspaceLayout;
          try {
            expandedLayout = growWorkspaceLayout(
              layout,
              state.errorCode,
              outputCapacity,
              options.device.limits,
            );
          } catch (error) {
            if (error instanceof RangeError) {
              return {
                semanticState,
                inference: compilerWorkspaceExhausted(
                  options,
                  state,
                  semanticState.totalSteps,
                  `cannot double ${inferenceArenaName(state.errorCode)} capacity from ${
                    workspaceArenaCapacity(layout, state.errorCode)
                  }: ${error.message}`,
                ),
              };
            }
            throw error;
          }
          const expandedWorkspace = await createExpandedWorkspace(
            options.device,
            workspaceBuffer,
            layout,
            expandedLayout,
            state,
            options.surface,
          );
          if (!expandedWorkspace.ok) {
            return {
              semanticState,
              inference: compilerWorkspaceExhausted(
                options,
                state,
                semanticState.totalSteps,
                `could not allocate ${expandedLayout.workspaceWordLength} workspace words (${expandedWorkspace.byteLength} bytes) after doubling ${
                  inferenceArenaName(state.errorCode)
                } capacity from ${
                  workspaceArenaCapacity(layout, state.errorCode)
                }: ${expandedWorkspace.reason}`,
              ),
            };
          }
          let expandedBindGroup: GPUBindGroup;
          try {
            expandedBindGroup = await createInferenceBindGroup(
              options,
              metadataBuffer,
              expandedWorkspace.buffer,
              outputBuffer,
              stateBuffer,
            );
          } catch (error) {
            expandedWorkspace.buffer.destroy();
            throw error;
          }
          const previousWorkspaceBuffer = workspaceBuffer;
          workspaceBuffer = expandedWorkspace.buffer;
          layout = expandedLayout;
          bindGroup = expandedBindGroup;
          resumeWorkspaceAfterGrowth(options.device, stateBuffer, layout);
          previousSemanticSteps = semanticState.totalSteps;
          previousTransitions = discardGrowthTransition(options.device, stateBuffer, state);
          previousWorkspaceBuffer.destroy();
          continue;
        }
        return {
          semanticState,
          inference: compilerWorkspaceExhausted(
            options,
            state,
            semanticState.totalSteps,
          ),
        };
      }
      if (state.status === LazuliInferenceStatus.InvalidInput) {
        throw new Error(
          `GPU Lazuli type inference rejected the supplied ABI: code=${state.errorCode}, detail=${state.errorDetail}`,
        );
      }
      throw new Error(`GPU Lazuli type inference returned unknown status ${state.status}`);
    }
  } finally {
    if (stateReadbackMapped) stateReadbackBuffer?.unmap();
    if (outputReadbackMapped) outputReadbackBuffer?.unmap();
    metadataBuffer?.destroy();
    workspaceBuffer?.destroy();
    outputBuffer?.destroy();
    stateBuffer?.destroy();
    stateReadbackBuffer?.destroy();
    outputReadbackBuffer?.destroy();
  }
}

/** Creates the shader module used with {@link runGpuLazuliTypeInference}. */
export function createLazuliTypeInferenceShaderModule(device: GPUDevice): GPUShaderModule {
  return device.createShaderModule({
    label: "Lazuli type inference",
    code: LAZULI_TYPE_INFERENCE_SHADER,
  });
}

async function createInferenceBindGroup(
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

function validateFuel(
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

function workspaceLayout(
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
  const defaultTypeCapacity = checkedProduct("type arena capacity", inferenceInputs, 32);
  const defaultEnvironmentCapacity = checkedProduct(
    "environment arena capacity",
    checkedSum("environment input count", surface.nodeCount, surface.definitionCount, 1),
    2,
  );
  const defaultFrameCapacity = checkedProduct(
    "frame arena capacity",
    checkedSum("frame input count", surface.nodeCount, surface.definitionCount, 1),
    2,
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
      scratch: defaultScratchCapacity,
      output: defaultTypeCapacity,
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
  const scratchBase = checkedSum(
    "frame arena base",
    frameBase,
    checkedProduct(
      "frame arena words",
      capacities.frame,
      LAZULI_INFERENCE_FRAME_WORD_LENGTH,
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
    scratchBase,
    scratchCapacity: capacities.scratch,
    workspaceWordLength,
    outputCapacity: capacities.output,
  };
}

function createInitialState(
  options: GpuLazuliTypeInferenceOptions,
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
  set(LazuliInferenceStateWord.DeclaredResultKindBase, metadata.declaredResultKindBase);
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

function shouldCopyOutputWithDispatch(
  maximumStepsPerDispatch: number,
  outputCapacity: number,
  limits: GPUSupportedLimits,
): boolean {
  if (maximumStepsPerDispatch < COMBINED_READBACK_MINIMUM_DISPATCH_TRANSITIONS) return false;
  const outputByteLength = inferenceOutputBufferByteLength(outputCapacity);
  return outputByteLength <= limits.maxBufferSize - INFERENCE_INTERNAL_STATE_BYTE_LENGTH &&
    outputByteLength <= LAZULI_NO_INDEX - INFERENCE_INTERNAL_STATE_BYTE_LENGTH;
}

function combinedInferenceReadbackByteLength(outputCapacity: number): number {
  return checkedSum(
    "type inference readback bytes",
    INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
    inferenceOutputBufferByteLength(outputCapacity),
  );
}

function inferenceOutputBufferByteLength(outputCapacity: number): number {
  return Math.max(WORD_BYTES, inferredTypeOutputByteLength(outputCapacity));
}

function inferredTypeOutputByteLength(outputCount: number): number {
  return checkedProduct(
    "inferred type output bytes",
    outputCount,
    LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES,
  );
}

async function createInferenceBuffers(
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
    const outOfMemoryError = await options.device.popErrorScope();
    const validationError = await options.device.popErrorScope();
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

async function createInferenceReadbackBuffer(
  device: GPUDevice,
  outputCapacity: number,
  includesOutput: boolean,
): Promise<BufferAllocation> {
  const size = includesOutput
    ? combinedInferenceReadbackByteLength(outputCapacity)
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
    const outOfMemoryError = await device.popErrorScope();
    const validationError = await device.popErrorScope();
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

async function createOutputReadbackBuffer(
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

async function createInferenceOutputBuffer(
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
    const outOfMemoryError = await device.popErrorScope();
    const validationError = await device.popErrorScope();
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

async function createExpandedWorkspace(
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
    const outOfMemoryError = await device.popErrorScope();
    const validationError = await device.popErrorScope();
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

async function copyOutputForGrowth(
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

function resumeOutputAfterGrowth(
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

function isWorkspaceArenaExhaustion(errorCode: number): boolean {
  return errorCode === LazuliInferenceDiagnosticCode.TypeArenaExhausted ||
    errorCode === LazuliInferenceDiagnosticCode.EnvironmentArenaExhausted ||
    errorCode === LazuliInferenceDiagnosticCode.FrameArenaExhausted ||
    errorCode === LazuliInferenceDiagnosticCode.ScratchArenaExhausted;
}

function workspaceArenaCapacity(layout: WorkspaceLayout, errorCode: number): number {
  switch (errorCode) {
    case LazuliInferenceDiagnosticCode.TypeArenaExhausted:
      return layout.typeCapacity;
    case LazuliInferenceDiagnosticCode.EnvironmentArenaExhausted:
      return layout.environmentCapacity;
    case LazuliInferenceDiagnosticCode.FrameArenaExhausted:
      return layout.frameCapacity;
    case LazuliInferenceDiagnosticCode.ScratchArenaExhausted:
      return layout.scratchCapacity;
    default:
      throw new Error(`cannot read capacity for non-workspace arena error ${errorCode}`);
  }
}

function growWorkspaceLayout(
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
    scratch: errorCode === LazuliInferenceDiagnosticCode.ScratchArenaExhausted
      ? doubledCapacity
      : layout.scratchCapacity,
    output: outputCapacity,
  }, limits);
}

function resumeWorkspaceAfterGrowth(
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

function discardGrowthTransition(
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

async function runSemanticCompilationToCompletion(
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

async function finishAfterInferenceSetupFailure(
  options: GpuLazuliTypeInferenceOptions,
  semanticPass: GpuLazuliSemanticCompilationPass | undefined,
  initialSteps: number,
  inference: GpuLazuliTypeInferenceRun,
): Promise<GpuLazuliCompilationInferenceRun> {
  if (semanticPass === undefined) {
    return {
      semanticState: syntheticSemanticState(options, initialSteps),
      inference,
    };
  }
  const semanticState = await runSemanticCompilationToCompletion(options, semanticPass);
  if (semanticState.status !== LazuliCompilationStatus.Ok) return { semanticState };
  return {
    semanticState,
    inference: Object.freeze({
      ...inference,
      totalSteps: semanticState.totalSteps + inference.transitions,
    }),
  };
}

async function dispatchForReadback(
  device: GPUDevice,
  pipeline: GPUComputePipeline,
  bindGroup: GPUBindGroup,
  outputBuffer: GPUBuffer,
  outputCapacity: number,
  stateBuffer: GPUBuffer,
  readbackBuffer: GPUBuffer,
  readbackIncludesOutput: boolean,
  surface: EncodedLazuliSurface,
  semanticPass: GpuLazuliSemanticCompilationPass | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  device.pushErrorScope("validation");
  let validation: Promise<GPUError | null>;
  try {
    const commands = device.createCommandEncoder({
      label: semanticPass === undefined
        ? "Lazuli type inference commands"
        : "Lazuli semantic compilation and type inference commands",
    });
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
    if (readbackIncludesOutput) {
      commands.copyBufferToBuffer(
        outputBuffer,
        0,
        readbackBuffer,
        INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
        inferenceOutputBufferByteLength(outputCapacity),
      );
    }
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

async function copyOutputForReadback(
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

async function readDiagnosticWorkspace(
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

function writeStateWord(
  device: GPUDevice,
  stateBuffer: GPUBuffer,
  word: number,
  value: number,
): void {
  const bytes = new ArrayBuffer(WORD_BYTES);
  new DataView(bytes).setUint32(0, value, true);
  device.queue.writeBuffer(stateBuffer, word * WORD_BYTES, bytes);
}

function readInferenceState(view: DataView): InferenceStateSnapshot {
  const word = (offset: number) => view.getUint32(offset * WORD_BYTES, true);
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
    outputRoot: word(LazuliInferenceStateWord.OutputRoot),
    outputCount: word(LazuliInferenceStateWord.OutputCount),
  };
}

function readSemanticState(
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

function syntheticSemanticState(
  options: GpuLazuliTypeInferenceOptions,
  initialSteps: number,
): GpuLazuliSemanticStateSnapshot {
  return {
    nodeCount: options.surface.nodeCount,
    definitionCount: options.surface.definitionCount,
    typeCount: options.surface.typeCount,
    constructorCount: options.surface.constructorCount,
    entrySymbol: options.surface.mainSymbol,
    status: LazuliCompilationStatus.Ok,
    errorCode: 0,
    errorSource: LAZULI_NO_INDEX,
    errorDetail: LAZULI_NO_INDEX,
    entryDefinition: LAZULI_NO_INDEX,
    totalSteps: initialSteps,
    maximumSteps: options.maximumSteps,
    maximumStepsPerDispatch: options.maximumStepsPerDispatch,
  };
}

function assertConsistentState(
  state: InferenceStateSnapshot,
  semanticState: GpuLazuliSemanticStateSnapshot,
  layout: WorkspaceLayout,
  outputCapacity: number,
  previousSemanticSteps: number,
  previousTransitions: number,
  dispatchTransitions: number,
): void {
  const semanticProgress = semanticState.totalSteps - previousSemanticSteps;
  const inferenceProgress = state.transitions - previousTransitions;
  const progress = semanticProgress + inferenceProgress;
  if (
    !Number.isSafeInteger(progress) || progress < 1 || progress > dispatchTransitions ||
    !Number.isSafeInteger(semanticProgress) || semanticProgress < 0 ||
    !Number.isSafeInteger(inferenceProgress) || inferenceProgress < 0 ||
    (semanticState.status !== LazuliCompilationStatus.Ok && inferenceProgress !== 0) ||
    state.typeTop > layout.typeCapacity || state.environmentTop > layout.environmentCapacity ||
    state.frameTop > layout.frameCapacity || state.outputCount > outputCapacity ||
    (state.outputCount !== 0 && state.outputRoot >= state.outputCount)
  ) {
    throw new Error(
      `GPU Lazuli compilation returned inconsistent dispatch progress: semanticSteps=${semanticState.totalSteps}, previousSemanticSteps=${previousSemanticSteps}, inferenceTransitions=${state.transitions}, previousInferenceTransitions=${previousTransitions}, maximumTransitions=${dispatchTransitions}, typeTop=${state.typeTop}, environmentTop=${state.environmentTop}, frameTop=${state.frameTop}, outputRoot=${state.outputRoot}, outputCount=${state.outputCount}`,
    );
  }
}

function fuelExhausted(
  options: GpuLazuliTypeInferenceOptions,
  transitions: number,
  initialSteps: number,
): GpuLazuliTypeInferenceRun {
  const sourceByteLength = options.sourceByteLength ?? largestSourceOffset(options.surface);
  const diagnostic: LazuliDiagnostic = {
    stage: "compile",
    code: "L1003",
    message: `program exhausted the compiler limit after ${
      initialSteps + transitions
    } serial semantic transitions; the limit is ${options.maximumSteps}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
  return Object.freeze({
    ok: false,
    diagnostic,
    transitions,
    totalSteps: initialSteps + transitions,
  });
}

function compilerWorkspaceExhausted(
  options: GpuLazuliTypeInferenceOptions,
  state: InferenceStateSnapshot,
  initialSteps: number,
  reason?: string,
): GpuLazuliTypeInferenceRun {
  const sourceByteLength = options.sourceByteLength ?? largestSourceOffset(options.surface);
  const diagnostic: LazuliDiagnostic = {
    stage: "compile",
    code: "L1003",
    message: `program exhausted the GPU compiler ${
      inferenceArenaName(state.errorCode)
    } workspace; required capacity is ${state.errorDetail}${
      reason === undefined ? "" : `; ${reason}`
    }`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
  return Object.freeze({
    ok: false,
    diagnostic,
    transitions: state.transitions,
    totalSteps: initialSteps + state.transitions,
  });
}

function compilerWorkspacePreflightFailed(
  options: GpuLazuliTypeInferenceOptions,
  initialSteps: number,
  reason: string,
): GpuLazuliTypeInferenceRun {
  const sourceByteLength = options.sourceByteLength ?? largestSourceOffset(options.surface);
  const diagnostic: LazuliDiagnostic = {
    stage: "compile",
    code: "L1003",
    message: `program exceeds the GPU compiler workspace limit: ${reason}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
  return Object.freeze({
    ok: false,
    diagnostic,
    transitions: 0,
    totalSteps: initialSteps,
  });
}

function compilerInferenceAllocationFailed(
  options: GpuLazuliTypeInferenceOptions,
  initialSteps: number,
  reason: string,
): GpuLazuliTypeInferenceRun {
  const sourceByteLength = options.sourceByteLength ?? largestSourceOffset(options.surface);
  const diagnostic: LazuliDiagnostic = {
    stage: "compile",
    code: "L1003",
    message: `program exhausted GPU memory before type inference: ${reason}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
  return Object.freeze({
    ok: false,
    diagnostic,
    transitions: 0,
    totalSteps: initialSteps,
  });
}

function diagnosticFromState(
  state: InferenceStateSnapshot,
  surface: EncodedLazuliSurface,
  metadata: LazuliInferenceShaderMetadata,
  workspace: DataView | undefined,
): LazuliDiagnostic {
  const span = { startByte: state.errorStartByte, endByte: state.errorEndByte };
  switch (state.errorCode) {
    case LazuliInferenceDiagnosticCode.NonExhaustiveCase:
      return {
        stage: "compile",
        code: "L2010",
        message: `non-exhaustive case; missing constructor ${
          JSON.stringify(
            symbolName(surface, state.errorDetail),
          )
        }`,
        span,
      };
    case LazuliInferenceDiagnosticCode.InvalidTypeMetadata:
      return {
        stage: "compile",
        code: "L2101",
        message: metadataFailureMessage(state, metadata.identifierNames),
        span,
      };
    case LazuliInferenceDiagnosticCode.TypeMismatch:
      return {
        stage: "compile",
        code: "L2102",
        message: `type mismatch: expected ${
          formatWorkspaceType(
            state.errorOperand0,
            workspace,
            surface,
            metadata.identifierNames,
          )
        }, received ${
          formatWorkspaceType(state.errorOperand1, workspace, surface, metadata.identifierNames)
        }`,
        span,
      };
    case LazuliInferenceDiagnosticCode.InfiniteType:
      return {
        stage: "compile",
        code: "L2103",
        message: `cannot construct infinite type by unifying ${
          formatWorkspaceType(
            state.errorOperand0,
            workspace,
            surface,
            metadata.identifierNames,
          )
        } with ${
          formatWorkspaceType(state.errorOperand1, workspace, surface, metadata.identifierNames)
        }`,
        span,
      };
    case LazuliInferenceDiagnosticCode.NonConcreteMain:
      return {
        stage: "compile",
        code: "L2104",
        message: state.errorOperand0 === LAZULI_NO_INDEX
          ? "main has no inferred type"
          : `main must have a concrete type; inferred ${
            formatWorkspaceType(
              state.errorOperand0,
              workspace,
              surface,
              metadata.identifierNames,
            )
          }`,
        span,
      };
    default:
      throw new Error(
        `GPU Lazuli type inference returned unknown diagnostic code ${state.errorCode} at ${state.errorStartByte}..${state.errorEndByte}`,
      );
  }
}

function metadataFailureMessage(
  state: InferenceStateSnapshot,
  identifierNames: readonly string[],
): string {
  const name = (identifier: number): string => identifierName(identifierNames, identifier);
  switch (state.errorContext) {
    case LazuliInferenceMetadataFailure.UnknownName:
      return `cannot infer unknown name ${name(state.errorDetail)}`;
    case LazuliInferenceMetadataFailure.UnknownCaseConstructor:
      return `cannot infer unknown case constructor ${name(state.errorDetail)}`;
    case LazuliInferenceMetadataFailure.CaseFieldCountMismatch:
      return `constructor ${
        JSON.stringify(name(state.errorDetail))
      } has ${state.errorOperand0} fields but the arm binds ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.UndeclaredTypeParameter:
      return `type parameter ${JSON.stringify(name(state.errorDetail))} is not in scope`;
    case LazuliInferenceMetadataFailure.UnknownType:
      return `unknown type ${JSON.stringify(name(state.errorDetail))}`;
    case LazuliInferenceMetadataFailure.TypeArgumentCountMismatch:
      return `type ${
        JSON.stringify(name(state.errorDetail))
      } expects ${state.errorOperand0} arguments; received ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.UnsupportedExpression:
      return `Unsupported Lazuli expression tag ${state.errorDetail} at node ${state.errorOperand0}.`;
    case LazuliInferenceMetadataFailure.InvalidDefinitionAnnotation:
      return `definition ${state.errorDetail} annotation ${state.errorOperand0} is outside ${state.errorOperand1} schema nodes`;
    case LazuliInferenceMetadataFailure.InvalidTypeDeclaration:
      return `invalid type declaration ${state.errorDetail}: ${state.errorOperand0} constructors and ${state.errorOperand1} parameters`;
    case LazuliInferenceMetadataFailure.RepeatedTypeParameter:
      return `type ${JSON.stringify(name(state.errorDetail))} repeats parameter ${
        JSON.stringify(name(state.errorOperand0))
      }`;
    case LazuliInferenceMetadataFailure.BuiltInTupleParameterCount:
      return "the built-in tuple type must declare exactly two parameters";
    case LazuliInferenceMetadataFailure.InvalidConstructor:
      return `invalid constructor ${state.errorDetail}: type ${state.errorOperand0}, detail ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.ConstructorFieldCountMismatch:
      return `constructor ${
        JSON.stringify(name(state.errorDetail))
      } has ${state.errorOperand0} fields but metadata declares ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.InvalidConstructorField:
      return `constructor ${
        JSON.stringify(name(state.errorDetail))
      } field ${state.errorOperand0} references invalid schema ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.InvalidSchemaShape:
      return `schema ${state.errorDetail} has invalid shape: tag ${state.errorOperand0}, ${state.errorOperand1} children`;
    case LazuliInferenceMetadataFailure.InvalidSchemaConversion:
      return `cannot convert invalid schema ${state.errorDetail}`;
    case LazuliInferenceMetadataFailure.DuplicateTypeName:
      return `duplicate type name ${JSON.stringify(name(state.errorDetail))}`;
    default:
      throw new Error(
        `GPU Lazuli type inference returned unknown L2101 context ${state.errorContext}`,
      );
  }
}

function decodeMainType(
  output: DataView,
  state: InferenceStateSnapshot,
  surface: EncodedLazuliSurface,
): LazuliType {
  const byteLength = state.outputCount * LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES;
  const schemaWords = new Uint32Array(
    output.buffer.slice(output.byteOffset, output.byteOffset + byteLength),
  );
  return decodeLazuliType(schemaWords, state.outputRoot, surface.symbolNames);
}

function publicTypeMetadata(surface: EncodedLazuliSurface): Pick<
  LazuliTypeInferenceSuccess,
  "typeDeclarations" | "constructorFieldTypes"
> {
  const copySchema = (schema: LazuliTypeSchema): LazuliTypeSchema => {
    switch (schema.kind) {
      case "integer":
      case "boolean":
      case "unit":
        return Object.freeze({ kind: schema.kind });
      case "parameter":
        return Object.freeze({ kind: "parameter", name: schema.name });
      case "tuple":
        return Object.freeze({
          kind: "tuple",
          values: Object.freeze([copySchema(schema.values[0]), copySchema(schema.values[1])]),
        }) as LazuliTypeSchema;
      case "named":
        return Object.freeze({
          kind: "named",
          name: schema.name,
          arguments: Object.freeze(schema.arguments.map(copySchema)),
        });
      case "function":
        return Object.freeze({
          kind: "function",
          parameter: copySchema(schema.parameter),
          result: copySchema(schema.result),
        });
    }
  };
  const typeDeclarations: LazuliTypeDeclaration[] = [];
  const constructorFieldTypes: (readonly LazuliTypeSchema[])[] = [];
  for (const declaration of surface.typeDeclarations) {
    const constructors = declaration.constructors.map((constructor) => {
      const fields = Object.freeze(
        constructor.fields.map((field) =>
          Object.freeze({ name: field.name, type: copySchema(field.type) })
        ),
      );
      constructorFieldTypes.push(Object.freeze(fields.map((field) => field.type)));
      return Object.freeze({ name: constructor.name, fields });
    });
    if (!declaration.name.startsWith("$")) {
      typeDeclarations.push(Object.freeze({
        name: declaration.name,
        parameters: Object.freeze([...declaration.parameters]),
        constructors: Object.freeze(constructors),
      }));
    }
  }
  return {
    typeDeclarations: Object.freeze(typeDeclarations),
    constructorFieldTypes: Object.freeze(constructorFieldTypes),
  };
}

function formatWorkspaceType(
  root: number,
  workspace: DataView | undefined,
  surface: EncodedLazuliSurface,
  identifierNames: readonly string[],
): string {
  if (workspace === undefined) {
    throw new Error("GPU Lazuli type diagnostic omitted its workspace snapshot");
  }
  const typeCount = workspace.byteLength / (LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH * WORD_BYTES);
  const typeWord = (typeIndex: number, word: number): number => {
    if (!Number.isInteger(typeIndex) || typeIndex < 0 || typeIndex >= typeCount) {
      throw new Error(
        `GPU Lazuli diagnostic referenced type ${typeIndex} outside ${typeCount} records`,
      );
    }
    return workspace.getUint32(
      (typeIndex * LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH + word) * WORD_BYTES,
      true,
    );
  };
  const prune = (typeIndex: number): number => {
    const seen = new Set<number>();
    let current = typeIndex;
    while (typeWord(current, 0) === 1) {
      const replacement = typeWord(current, 1);
      if (replacement === LAZULI_NO_INDEX) return current;
      if (seen.has(current)) {
        throw new Error(`GPU Lazuli diagnostic contains cyclic variable link at type ${current}`);
      }
      seen.add(current);
      current = replacement;
    }
    return current;
  };
  const names = new Map<number, string>();
  const variableName = (typeIndex: number): string => {
    const existing = names.get(typeIndex);
    if (existing !== undefined) return existing;
    const index = names.size;
    const name = `'${String.fromCharCode(97 + index % 26)}${
      index < 26 ? "" : Math.floor(index / 26)
    }`;
    names.set(typeIndex, name);
    return name;
  };
  const format = (raw: number, nestedFunction: boolean): string => {
    const typeIndex = prune(raw);
    const kind = typeWord(typeIndex, 0);
    switch (kind) {
      case 1:
      case 2:
        return variableName(typeIndex);
      case 3:
        return identifierName(identifierNames, typeWord(typeIndex, 1));
      case 11:
        return identifierName(identifierNames, typeWord(typeIndex, 1));
      case 4:
        return "Int";
      case 5:
        return "Bool";
      case 6:
        return "()";
      case 7:
        return `(${format(typeWord(typeIndex, 2), false)}, ${
          format(typeWord(typeIndex, 3), false)
        })`;
      case 8: {
        const typeDeclaration = typeWord(typeIndex, 1);
        const typeOffset = typeDeclaration * 5;
        const symbol = surface.typeWords[typeOffset];
        if (symbol === undefined) {
          throw new Error(
            `GPU Lazuli diagnostic named missing type declaration ${typeDeclaration}`,
          );
        }
        const arguments_: string[] = [];
        let list = typeWord(typeIndex, 2);
        const seenLists = new Set<number>();
        while (list !== LAZULI_NO_INDEX) {
          if (seenLists.has(list) || typeWord(list, 0) !== 10) {
            throw new Error(
              `GPU Lazuli diagnostic named type ${typeIndex} has invalid argument list`,
            );
          }
          seenLists.add(list);
          arguments_.push(format(typeWord(list, 1), false));
          list = typeWord(list, 2);
        }
        const name = symbolName(surface, symbol);
        return arguments_.length === 0 ? name : `${name}[${arguments_.join(", ")}]`;
      }
      case 9: {
        const rendered = `${format(typeWord(typeIndex, 2), true)} -> ${
          format(
            typeWord(typeIndex, 3),
            false,
          )
        }`;
        return nestedFunction ? `(${rendered})` : rendered;
      }
      default:
        throw new Error(`GPU Lazuli diagnostic type ${typeIndex} has unknown kind ${kind}`);
    }
  };
  return format(root, false);
}

function identifierName(identifierNames: readonly string[], identifier: number): string {
  const name = identifierNames[identifier];
  if (name === undefined) {
    throw new Error(`GPU Lazuli inference returned unknown schema identifier ${identifier}`);
  }
  return name;
}

function inferenceArenaName(errorCode: number): string {
  switch (errorCode) {
    case LazuliInferenceDiagnosticCode.TypeArenaExhausted:
      return "type";
    case LazuliInferenceDiagnosticCode.EnvironmentArenaExhausted:
      return "environment";
    case LazuliInferenceDiagnosticCode.FrameArenaExhausted:
      return "frame";
    case LazuliInferenceDiagnosticCode.ScratchArenaExhausted:
      return "scratch";
    case LazuliInferenceDiagnosticCode.OutputArenaExhausted:
      return "output";
    default:
      return `unknown (${errorCode})`;
  }
}

function symbolName(surface: EncodedLazuliSurface, symbol: number): string {
  const name = surface.symbolNames[symbol];
  if (name === undefined) throw new Error(`GPU Lazuli inference returned unknown symbol ${symbol}`);
  return name;
}

function largestSourceOffset(surface: EncodedLazuliSurface): number {
  let largest = 0;
  for (let node = 0; node < surface.nodeCount; node++) {
    const end = surface.nodeWords[node * 8 + 2];
    if (end !== undefined) largest = Math.max(largest, end);
  }
  return largest;
}

function checkedSum(name: string, ...values: readonly number[]): number {
  const result = values.reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(result) || result < 0 || result > LAZULI_NO_INDEX) {
    throw new RangeError(`${name} cannot be represented as a u32: ${result}`);
  }
  return result;
}

function checkedProduct(name: string, left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0 || result > LAZULI_NO_INDEX) {
    throw new RangeError(`${name} cannot be represented as a u32: ${left} * ${right}`);
  }
  return result;
}

function assertStorageSize(name: string, wordLength: number, limits: GPUSupportedLimits): void {
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
