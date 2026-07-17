import type {
  FunctionalCoreTag,
  FunctionalDiagnostic,
  FunctionalEvaluationMode,
  FunctionalEvaluationProfile,
  FunctionalType,
  FunctionalTypeDeclaration,
} from "./abi.ts";
import type { FunctionalHostCapabilityDeclaration } from "./host_contract.ts";

export interface FunctionalCoreNode {
  readonly tag: FunctionalCoreTag;
  readonly payload: number;
  readonly child0: number;
  readonly child1: number;
  readonly child2: number;
  readonly sourceByteOffset: number;
  readonly evaluationMode: FunctionalEvaluationMode;
}

export interface GpuFunctionalModule {
  readonly nodeBuffer: GPUBuffer;
  readonly definitionBuffer: GPUBuffer;
  readonly constructorBuffer: GPUBuffer;
  readonly nodeCount: number;
  readonly definitionCount: number;
  readonly constructorCount: number;
  readonly typeCount: number;
  readonly constructorNames: readonly string[];
  readonly constructorArities: readonly number[];
  readonly definitionRoots: readonly number[];
  readonly entryDefinition: number;
  readonly entryType: FunctionalType;
  readonly entryEffects: readonly string[];
  readonly typeDeclarations: readonly FunctionalTypeDeclaration[];
  readonly hostCapabilities: readonly FunctionalHostCapabilityDeclaration[];
  readonly evaluationProfile: FunctionalEvaluationProfile;
  readCoreNodes(): Promise<readonly FunctionalCoreNode[]>;
  destroy(): void;
}

export interface FunctionalCompilationOptions {
  readonly maximumSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly signal?: AbortSignal;
}

export type FunctionalCompileResult =
  | { readonly ok: true; readonly module: GpuFunctionalModule }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [FunctionalDiagnostic, ...FunctionalDiagnostic[]];
  };
