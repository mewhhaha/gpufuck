import type { Diagnostic, EvaluationProfile, Span, Type, TypeSchema } from "./abi.ts";
import type { EvaluationStats, RuntimeFault } from "./evaluator.ts";
import type { ModuleArtifact, ModuleImport } from "./module_linker.ts";
import type { SurfaceDefinition, SurfaceTypeDeclaration } from "./surface_builder.ts";

export type Constant =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "whole-number-f64"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" }
  | {
    readonly kind: "tuple";
    readonly values: readonly [Constant, Constant];
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fields: readonly Constant[];
  };

export interface ComptimeModuleArtifact {
  readonly name: string;
  readonly definitions: readonly SurfaceDefinition[];
  readonly typeDeclarations: readonly SurfaceTypeDeclaration[];
  readonly imports: readonly ModuleImport[];
  readonly exports: readonly ComptimeModuleExport[];
  readonly sourceByteLength: number;
  readonly evaluationProfile?: EvaluationProfile;
}

export interface ComptimeModuleExport {
  readonly name: string;
  readonly definition: string;
  readonly type: TypeSchema;
}

export interface ComptimeExecutionOptions {
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

export interface ComptimeFunctionCompilationOptions {
  readonly maximumCompilationSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly signal?: AbortSignal;
}

export interface ComptimeInvocationOptions {
  readonly maximumExecutionSteps?: number;
  readonly maximumOutputNodes?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumOutputDepth?: number;
  readonly signal?: AbortSignal;
}

export interface ComptimeExportSelection {
  readonly module: string;
  readonly exportName: string;
}

export interface ComptimeExportValue {
  readonly module: string;
  readonly exportName: string;
  readonly definition: string;
  readonly type: TypeSchema;
  readonly value: Constant;
}

export type ComptimeDiagnosticCode =
  | "F5001"
  | "F5002";

export type ComptimeFaultKind =
  | "non-constant-output"
  | "output-limit";

export interface ComptimeDiagnostic {
  readonly stage: "comptime";
  readonly code: ComptimeDiagnosticCode;
  readonly kind: ComptimeFaultKind;
  readonly message: string;
  readonly module?: string;
  readonly exportName?: string;
  readonly span?: Span;
  readonly limit?: number;
  readonly observed?: number;
}

export interface ComptimeStats {
  readonly compilationCount: number;
  readonly evaluation: EvaluationStats;
  readonly outputNodes: number;
  readonly outputBytes: number;
  readonly outputDepth: number;
}

export interface ComptimeInvocationStats {
  readonly evaluation: EvaluationStats;
  readonly outputNodes: number;
  readonly outputBytes: number;
  readonly outputDepth: number;
  readonly memoized: boolean;
}

export interface CompiledComptimeFunction {
  readonly parameterType: Type;
  readonly resultType: Type;
  invoke(
    argument: Constant,
    options?: ComptimeInvocationOptions,
  ): Promise<ComptimeInvocationResult>;
  destroy(): void;
}

export type ComptimeFunctionCompilationResult =
  | {
    readonly ok: true;
    readonly compiledFunction: CompiledComptimeFunction;
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  };

export type ComptimeInvocationResult =
  | {
    readonly ok: true;
    readonly value: Constant;
    readonly stats: ComptimeInvocationStats;
  }
  | {
    readonly ok: false;
    readonly stage: "execute";
    readonly fault: RuntimeFault;
    readonly stats: EvaluationStats;
  }
  | {
    readonly ok: false;
    readonly stage: "comptime";
    readonly diagnostic: ComptimeDiagnostic;
    readonly stats?: EvaluationStats;
  };

export type ComptimeExecutionResult =
  | {
    readonly ok: true;
    readonly exports: readonly ComptimeExportValue[];
    readonly stats: ComptimeStats;
  }
  | {
    readonly ok: false;
    readonly stage: "compile";
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  }
  | {
    readonly ok: false;
    readonly stage: "execute";
    readonly fault: RuntimeFault;
    readonly stats: EvaluationStats;
  }
  | {
    readonly ok: false;
    readonly stage: "comptime";
    readonly diagnostic: ComptimeDiagnostic;
    readonly stats?: EvaluationStats;
  };

export interface PartialEvaluationResult {
  readonly artifact: ModuleArtifact;
  readonly attemptedDefinitions: readonly string[];
  readonly foldedDefinitions: readonly string[];
  readonly skipped?:
    | { readonly stage: "compile"; readonly diagnostics: readonly Diagnostic[] }
    | { readonly stage: "execute"; readonly fault: RuntimeFault }
    | { readonly stage: "comptime"; readonly diagnostic: ComptimeDiagnostic };
}
