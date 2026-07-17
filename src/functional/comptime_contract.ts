import type {
  FunctionalDiagnostic,
  FunctionalEvaluationProfile,
  FunctionalSpan,
  FunctionalType,
  FunctionalTypeSchema,
} from "./abi.ts";
import type { FunctionalEvaluationStats, FunctionalRuntimeFault } from "./evaluator.ts";
import type {
  FunctionalModuleArtifact,
  FunctionalModuleExport,
  FunctionalModuleImport,
} from "./module_linker.ts";
import type {
  FunctionalSurfaceDefinition,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_builder.ts";

export type FunctionalConstant =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" }
  | {
    readonly kind: "tuple";
    readonly values: readonly [FunctionalConstant, FunctionalConstant];
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fields: readonly FunctionalConstant[];
  };

export interface FunctionalComptimeModuleArtifact {
  readonly name: string;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly imports: readonly FunctionalModuleImport[];
  readonly exports: readonly FunctionalModuleExport[];
  readonly sourceByteLength: number;
  readonly evaluationProfile?: FunctionalEvaluationProfile;
}

export interface FunctionalComptimeExecutionOptions {
  readonly maximumCompilationSteps?: number;
  readonly maximumExecutionSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly heapSlots?: number;
  readonly stackFrames?: number;
  readonly maximumOutputNodes?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumOutputDepth?: number;
  readonly signal?: AbortSignal;
}

export interface FunctionalComptimeFunctionCompilationOptions {
  readonly maximumCompilationSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly signal?: AbortSignal;
}

export interface FunctionalComptimeInvocationOptions {
  readonly maximumExecutionSteps?: number;
  readonly maximumOutputNodes?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumOutputDepth?: number;
  readonly signal?: AbortSignal;
}

export interface FunctionalComptimeExportSelection {
  readonly module: string;
  readonly exportName: string;
}

export interface FunctionalComptimeExportValue {
  readonly module: string;
  readonly exportName: string;
  readonly definition: string;
  readonly type: FunctionalTypeSchema;
  readonly value: FunctionalConstant;
}

export type FunctionalComptimeDiagnosticCode =
  | "F5001"
  | "F5002";

export type FunctionalComptimeFaultKind =
  | "non-constant-output"
  | "output-limit";

export interface FunctionalComptimeDiagnostic {
  readonly stage: "comptime";
  readonly code: FunctionalComptimeDiagnosticCode;
  readonly kind: FunctionalComptimeFaultKind;
  readonly message: string;
  readonly module?: string;
  readonly exportName?: string;
  readonly span?: FunctionalSpan;
  readonly limit?: number;
  readonly observed?: number;
}

export interface FunctionalComptimeStats {
  readonly compilationCount: number;
  readonly evaluation: FunctionalEvaluationStats;
  readonly outputNodes: number;
  readonly outputBytes: number;
  readonly outputDepth: number;
}

export interface FunctionalComptimeInvocationStats {
  readonly evaluation: FunctionalEvaluationStats;
  readonly outputNodes: number;
  readonly outputBytes: number;
  readonly outputDepth: number;
  readonly memoized: boolean;
}

export interface CompiledFunctionalComptimeFunction {
  readonly parameterType: FunctionalType;
  readonly resultType: FunctionalType;
  invoke(
    argument: FunctionalConstant,
    options?: FunctionalComptimeInvocationOptions,
  ): Promise<FunctionalComptimeInvocationResult>;
  destroy(): void;
}

export type FunctionalComptimeFunctionCompilationResult =
  | {
    readonly ok: true;
    readonly compiledFunction: CompiledFunctionalComptimeFunction;
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [FunctionalDiagnostic, ...FunctionalDiagnostic[]];
  };

export type FunctionalComptimeInvocationResult =
  | {
    readonly ok: true;
    readonly value: FunctionalConstant;
    readonly stats: FunctionalComptimeInvocationStats;
  }
  | {
    readonly ok: false;
    readonly stage: "execute";
    readonly fault: FunctionalRuntimeFault;
    readonly stats: FunctionalEvaluationStats;
  }
  | {
    readonly ok: false;
    readonly stage: "comptime";
    readonly diagnostic: FunctionalComptimeDiagnostic;
    readonly stats?: FunctionalEvaluationStats;
  };

export type FunctionalComptimeExecutionResult =
  | {
    readonly ok: true;
    readonly exports: readonly FunctionalComptimeExportValue[];
    readonly stats: FunctionalComptimeStats;
  }
  | {
    readonly ok: false;
    readonly stage: "compile";
    readonly diagnostics: readonly [FunctionalDiagnostic, ...FunctionalDiagnostic[]];
  }
  | {
    readonly ok: false;
    readonly stage: "execute";
    readonly fault: FunctionalRuntimeFault;
    readonly stats: FunctionalEvaluationStats;
  }
  | {
    readonly ok: false;
    readonly stage: "comptime";
    readonly diagnostic: FunctionalComptimeDiagnostic;
    readonly stats?: FunctionalEvaluationStats;
  };

export interface FunctionalPartialEvaluationResult {
  readonly artifact: FunctionalModuleArtifact;
  readonly attemptedDefinitions: readonly string[];
  readonly foldedDefinitions: readonly string[];
  readonly skipped?:
    | { readonly stage: "compile"; readonly diagnostics: readonly FunctionalDiagnostic[] }
    | { readonly stage: "execute"; readonly fault: FunctionalRuntimeFault }
    | { readonly stage: "comptime"; readonly diagnostic: FunctionalComptimeDiagnostic };
}
