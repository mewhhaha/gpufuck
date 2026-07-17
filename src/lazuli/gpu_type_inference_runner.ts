import { LAZULI_NO_INDEX, LAZULI_NODE_BYTE_LENGTH } from "./abi.ts";
import { LazuliCompilationStatus } from "./compiler_shader.ts";
import type { GpuDispatchScheduler } from "../functional/gpu_dispatch_scheduler.ts";
import type { GpuLazuliSemanticCompilationPass } from "./gpu_semantic_contract.ts";
import type {
  GpuLazuliCompilationInferenceRun,
  GpuLazuliTypeInferenceOptions,
  GpuLazuliTypeInferenceRun,
  InferenceStateSnapshot,
  WorkspaceLayout,
} from "./gpu_type_inference_contract.ts";
import {
  copyOutputForReadback,
  createInferenceBindGroup,
  dispatchForReadback,
  readDiagnosticWorkspace,
  readInferenceState,
  readSemanticState,
  runSemanticCompilationToCompletion,
  SEMANTIC_SNAPSHOT_BYTE_OFFSET,
} from "./gpu_type_inference_gpu_io.ts";
import {
  assertConsistentState,
  compilerInferenceAllocationFailed,
  compilerWorkspaceExhausted,
  compilerWorkspacePreflightFailed,
  decodeMainType,
  diagnosticFromState,
  fuelExhausted,
  publicTypeMetadata,
  syntheticSemanticState,
} from "./gpu_type_inference_results.ts";
import {
  assertStorageSize,
  checkedProduct,
  copyOutputForGrowth,
  createExpandedWorkspace,
  createInferenceBuffers,
  createInferenceOutputBuffer,
  createInferenceReadbackBuffer,
  createInitialState,
  createOutputReadbackBuffer,
  discardGrowthTransition,
  dispatchOutputReadbackCapacity,
  growWorkspaceLayout,
  INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
  inferenceArenaName,
  inferenceReadbackCoreByteOffset,
  inferredTypeOutputByteLength,
  isWorkspaceArenaExhaustion,
  resumeOutputAfterGrowth,
  resumeWorkspaceAfterGrowth,
  validateFuel,
  workspaceArenaCapacity,
  workspaceLayout,
} from "./gpu_type_inference_workspace.ts";
import {
  LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
  LazuliInferenceDiagnosticCode,
  LazuliInferenceMetadataFailure,
  LazuliInferenceStatus,
  prepareLazuliInferenceShaderMetadata,
} from "./type_inference_shader.ts";
import { flattenLazuliTypeSchemas } from "./type_schema_abi.ts";

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
  dispatchScheduler?: GpuDispatchScheduler,
): Promise<GpuLazuliCompilationInferenceRun> {
  return await runGpuLazuliTypeInferenceMachine(options, semanticPass, dispatchScheduler);
}

async function runGpuLazuliTypeInferenceMachine(
  options: GpuLazuliTypeInferenceOptions,
  semanticPass?: GpuLazuliSemanticCompilationPass,
  dispatchScheduler?: GpuDispatchScheduler,
): Promise<GpuLazuliCompilationInferenceRun> {
  const initialSteps = semanticPass === undefined ? options.initialSteps ?? 0 : 0;
  validateFuel(options.maximumSteps, options.maximumStepsPerDispatch, initialSteps);
  options.signal?.throwIfAborted();

  const metadata = prepareLazuliInferenceShaderMetadata(
    options.surface,
    flattenLazuliTypeSchemas(options.surface),
  );
  options.mutateMetadataForTest?.(metadata.words);
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
    const outputReadbackCapacity = dispatchOutputReadbackCapacity(
      options.maximumStepsPerDispatch,
      options.device.limits,
    );
    const coreNodeByteLength = semanticPass === undefined || outputReadbackCapacity === 0
      ? 0
      : options.surface.nodeCount * LAZULI_NODE_BYTE_LENGTH;
    const coreReadbackByteOffset = inferenceReadbackCoreByteOffset(outputReadbackCapacity);
    let coreReadbackByteLength = coreNodeByteLength <=
        options.device.limits.maxBufferSize - coreReadbackByteOffset
      ? coreNodeByteLength
      : 0;
    let stateReadback = await createInferenceReadbackBuffer(
      options.device,
      outputReadbackCapacity,
      coreReadbackByteLength,
    );
    if (!stateReadback.ok && coreReadbackByteLength > 0) {
      coreReadbackByteLength = 0;
      stateReadback = await createInferenceReadbackBuffer(
        options.device,
        outputReadbackCapacity,
      );
    }
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
    let activeSemanticPass = semanticPass;
    let coreNodeBytes: ArrayBuffer | undefined;
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

      await dispatchForReadback(
        options.device,
        options.pipeline,
        bindGroup,
        outputBuffer,
        outputCapacity,
        stateBuffer,
        stateReadbackBuffer,
        outputReadbackCapacity,
        options.coreNodeBuffer,
        coreReadbackByteOffset,
        coreReadbackByteLength,
        options.surface,
        activeSemanticPass,
        options.signal,
        dispatchScheduler,
      );
      options.signal?.throwIfAborted();

      await stateReadbackBuffer.mapAsync(GPUMapMode.READ);
      stateReadbackMapped = true;
      let state: InferenceStateSnapshot;
      let completedOutput: ArrayBuffer | undefined;
      let semanticPassCompleted = false;
      try {
        const mappedRange = stateReadbackBuffer.getMappedRange();
        const dispatchView = new DataView(mappedRange);
        state = readInferenceState(dispatchView);
        semanticState = readSemanticState(dispatchView, SEMANTIC_SNAPSHOT_BYTE_OFFSET);
        assertConsistentState(
          state,
          semanticState,
          layout,
          outputCapacity,
          previousSemanticSteps,
          previousTransitions,
          dispatchTransitions,
        );
        semanticPassCompleted = activeSemanticPass !== undefined &&
          semanticState.status !== LazuliCompilationStatus.Pending;
        if (
          semanticPassCompleted && semanticState.status === LazuliCompilationStatus.Ok &&
          coreReadbackByteLength > 0
        ) {
          coreNodeBytes = mappedRange.slice(
            coreReadbackByteOffset,
            coreReadbackByteOffset + coreReadbackByteLength,
          );
        }
        if (
          state.outputCount <= outputReadbackCapacity &&
          semanticState.status === LazuliCompilationStatus.Ok &&
          state.status === LazuliInferenceStatus.Complete
        ) {
          completedOutput = mappedRange.slice(
            INFERENCE_INTERNAL_STATE_BYTE_LENGTH,
            INFERENCE_INTERNAL_STATE_BYTE_LENGTH +
              inferredTypeOutputByteLength(state.outputCount),
          );
        }
      } finally {
        stateReadbackBuffer.unmap();
        stateReadbackMapped = false;
      }
      if (semanticPassCompleted) activeSemanticPass = undefined;
      options.signal?.throwIfAborted();
      options.observeCompilationDispatch?.({
        semanticStatus: semanticState.status,
        semanticSteps: semanticState.totalSteps,
        inferenceStatus: state.status,
        inferenceTransitions: state.transitions,
        requiredCapacity: state.errorDetail,
      });
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
        refinementCapacity: layout.refinementCapacity,
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
        if (completedOutput !== undefined) {
          output = new DataView(completedOutput);
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
        return {
          semanticState,
          inference,
          ...(coreNodeBytes === undefined ? {} : { coreNodeBytes }),
        };
      }

      if (state.status === LazuliInferenceStatus.Diagnostic) {
        const workspace = state.errorCode === LazuliInferenceDiagnosticCode.TypeMismatch ||
            state.errorCode === LazuliInferenceDiagnosticCode.InfiniteType ||
            (state.errorCode === LazuliInferenceDiagnosticCode.InvalidTypeMetadata &&
              (state.errorContext ===
                  LazuliInferenceMetadataFailure.InvalidEmptyCaseScrutinee ||
                state.errorContext >=
                  LazuliInferenceMetadataFailure.IndexedExpectedTypeUnresolved)) ||
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
          try {
            await copyOutputForGrowth(
              options.device,
              outputBuffer,
              expandedOutput.buffer,
              state.outputCount,
              options.surface,
            );
          } catch (error) {
            expandedOutput.buffer.destroy();
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
            throw error;
          }
          const previousOutputBuffer = outputBuffer;
          outputBuffer = expandedOutput.buffer;
          outputCapacity = nextOutputCapacity;
          bindGroup = expandedBindGroup;
          previousOutputBuffer.destroy();
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
