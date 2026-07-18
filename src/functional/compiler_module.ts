import type {
  FunctionalCoreTag,
  FunctionalDiagnostic,
  FunctionalEvaluationMode,
  FunctionalEvaluationProfile,
  FunctionalSourceRange,
  FunctionalType,
  FunctionalTypeDeclaration,
} from "./abi.ts";
import type {
  FunctionalHostCapabilityDeclaration,
  FunctionalHostDefinitionBinding,
} from "./host_contract.ts";

export interface FunctionalWasmExport {
  readonly name: string;
  readonly definitionIndex: number;
  readonly type: FunctionalType;
}

export interface FunctionalCoreNode {
  readonly tag: FunctionalCoreTag;
  readonly payload: number;
  readonly child0: number;
  readonly child1: number;
  readonly child2: number;
  readonly sourceByteOffset: number;
  readonly sourceEndByte: number;
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
  readonly definitionNames: readonly string[];
  readonly symbolNames: readonly string[];
  readonly definitionRoots: readonly number[];
  readonly entryDefinition: number;
  readonly entryType: FunctionalType;
  readonly entryEffects: readonly string[];
  readonly typeDeclarations: readonly FunctionalTypeDeclaration[];
  readonly hostCapabilities: readonly FunctionalHostCapabilityDeclaration[];
  readonly hostDefinitions: readonly FunctionalHostDefinitionBinding[];
  readonly wasmExports: readonly FunctionalWasmExport[];
  readonly sources: readonly FunctionalSourceRange[];
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
