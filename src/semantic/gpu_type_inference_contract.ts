import type { EncodedSemanticSurface } from "./abi.ts";
import type { GpuSemanticStateSnapshot } from "./gpu_semantic_contract.ts";
import type { TypeInferenceResult } from "./type_inference.ts";

export interface GpuTypeInferenceBuffers {
  readonly coreNodeBuffer: GPUBuffer;
  readonly definitionBuffer: GPUBuffer;
  readonly typeBuffer: GPUBuffer;
  readonly constructorBuffer: GPUBuffer;
}

export interface GpuTypeInferenceOptions extends GpuTypeInferenceBuffers {
  readonly device: GPUDevice;
  readonly pipeline: GPUComputePipeline;
  readonly surface: EncodedSemanticSurface;
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
  /** Work already consumed by semantic resolution in the enclosing compilation. */
  readonly initialSteps?: number;
  readonly sourceByteLength?: number;
  readonly signal?: AbortSignal;
  /** Internal runner controls used to exercise arena growth without changing compiler APIs. */
  readonly initialWorkspaceCapacities?: GpuTypeInferenceWorkspaceCapacities;
  /** Internal runner observation point invoked after each completed dispatch. */
  readonly observeDispatch?: (observation: GpuTypeInferenceDispatchObservation) => void;
  /** Internal profiling point covering both semantic resolution and inference dispatches. */
  readonly observeCompilationDispatch?: (
    observation: GpuCompilationDispatchObservation,
  ) => void;
  /** Internal test hook invoked on the prepared schema buffer before upload. */
  readonly mutateMetadataForTest?: (words: Uint32Array) => void;
}

export interface GpuCompilationDispatchObservation {
  readonly semanticStatus: number;
  readonly semanticSteps: number;
  readonly inferenceStatus: number;
  readonly inferenceTransitions: number;
  /** Cumulative per-frame-kind split of {@link inferenceTransitions}. */
  readonly inferenceProfile: Uint32Array;
  readonly requiredCapacity: number;
}

export interface GpuTypeInferenceWorkspaceCapacities {
  readonly type?: number;
  readonly environment?: number;
  readonly frame?: number;
  readonly refinement?: number;
  readonly scratch?: number;
  readonly output?: number;
}

export interface GpuTypeInferenceDispatchObservation {
  readonly status: number;
  readonly errorCode: number;
  readonly requiredCapacity: number;
  readonly transitions: number;
  /** Cumulative per-frame-kind split of {@link transitions}. */
  readonly profile: Uint32Array;
  readonly typeCapacity: number;
  readonly environmentCapacity: number;
  readonly frameCapacity: number;
  readonly refinementCapacity: number;
  readonly scratchCapacity: number;
  readonly outputCapacity: number;
}

export type GpuTypeInferenceRun = TypeInferenceResult & {
  readonly transitions: number;
  readonly totalSteps: number;
};

export type GpuCompilationInferenceRun =
  | {
    readonly semanticState: GpuSemanticStateSnapshot;
    readonly inference: GpuTypeInferenceRun;
    readonly coreNodeBytes?: ArrayBuffer;
  }
  | {
    readonly semanticState: GpuSemanticStateSnapshot;
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
  /**
   * Cumulative transition count per frame kind, in `INFERENCE_PROFILE_BUCKET_NAMES` order. Splits
   * `transitions` into the work it was spent on, which is what says whether inference can be
   * re-encoded as generation plus a solve.
   */
  readonly profile: Uint32Array;
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
