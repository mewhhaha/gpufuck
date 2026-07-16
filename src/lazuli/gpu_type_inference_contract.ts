import { type EncodedLazuliSurface } from "./abi.ts";
import { type GpuLazuliSemanticStateSnapshot } from "./gpu_semantic_contract.ts";
import { type LazuliTypeInferenceResult } from "./type_inference.ts";

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
  /** Internal profiling point covering both semantic resolution and inference dispatches. */
  readonly observeCompilationDispatch?: (
    observation: GpuLazuliCompilationDispatchObservation,
  ) => void;
  /** Internal test hook invoked on the prepared schema buffer before upload. */
  readonly mutateMetadataForTest?: (words: Uint32Array) => void;
}

export interface GpuLazuliCompilationDispatchObservation {
  readonly semanticStatus: number;
  readonly semanticSteps: number;
  readonly inferenceStatus: number;
  readonly inferenceTransitions: number;
  readonly requiredCapacity: number;
}

export interface GpuLazuliTypeInferenceWorkspaceCapacities {
  readonly type?: number;
  readonly environment?: number;
  readonly frame?: number;
  readonly refinement?: number;
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
  readonly refinementCapacity: number;
  readonly scratchCapacity: number;
  readonly outputCapacity: number;
}

export type GpuLazuliTypeInferenceRun = LazuliTypeInferenceResult & {
  readonly transitions: number;
  readonly totalSteps: number;
};

export type GpuLazuliCompilationInferenceRun =
  | {
    readonly semanticState: GpuLazuliSemanticStateSnapshot;
    readonly inference: GpuLazuliTypeInferenceRun;
  }
  | {
    readonly semanticState: GpuLazuliSemanticStateSnapshot;
    readonly inference?: never;
  };

export interface InferenceStateSnapshot {
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
  readonly refinementTop: number;
  readonly outputRoot: number;
  readonly outputCount: number;
}

export interface WorkspaceLayout {
  readonly typeBase: number;
  readonly typeCapacity: number;
  readonly environmentBase: number;
  readonly environmentCapacity: number;
  readonly frameBase: number;
  readonly frameCapacity: number;
  readonly refinementBase: number;
  readonly refinementCapacity: number;
  readonly scratchBase: number;
  readonly scratchCapacity: number;
  readonly workspaceWordLength: number;
  readonly outputCapacity: number;
}

export interface WorkspaceCapacities {
  readonly type: number;
  readonly environment: number;
  readonly frame: number;
  readonly refinement: number;
  readonly scratch: number;
  readonly output: number;
}
