import type { FunctionalDiagnostic } from "./abi.ts";
import type { FunctionalEvaluationStats, FunctionalRuntimeFault } from "./evaluator.ts";

export const TypeCoreKind = {
  Type: "type",
  Integer: "integer",
  Boolean: "boolean",
  Symbol: "symbol",
} as const;

export type TypeCoreKind = (typeof TypeCoreKind)[keyof typeof TypeCoreKind];

export type TypeCoreType =
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly TypeCoreValue[];
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [TypeCoreType, TypeCoreType];
  }
  | {
    readonly kind: "function";
    readonly parameter: TypeCoreType;
    readonly result: TypeCoreType;
  };

export type TypeCoreValue =
  | { readonly kind: "type"; readonly type: TypeCoreType }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "symbol"; readonly value: string };

export type TypeCoreTypeExpression =
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly TypeCoreExpression[];
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [TypeCoreExpression, TypeCoreExpression];
  }
  | {
    readonly kind: "function";
    readonly parameter: TypeCoreExpression;
    readonly result: TypeCoreExpression;
  };

export type TypeCoreExpression =
  | { readonly kind: "type"; readonly type: TypeCoreTypeExpression }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "symbol"; readonly value: string }
  | { readonly kind: "reference"; readonly name: string }
  | {
    readonly kind: "call";
    readonly function: string;
    readonly arguments: readonly TypeCoreExpression[];
  }
  | {
    readonly kind: "if";
    readonly condition: TypeCoreExpression;
    readonly consequent: TypeCoreExpression;
    readonly alternate: TypeCoreExpression;
  }
  | {
    readonly kind: "integer-operation";
    readonly operator: "add" | "subtract" | "multiply";
    readonly left: TypeCoreExpression;
    readonly right: TypeCoreExpression;
  }
  | {
    readonly kind: "integer-equal";
    readonly left: TypeCoreExpression;
    readonly right: TypeCoreExpression;
  }
  | {
    readonly kind: "symbol-equal";
    readonly left: TypeCoreExpression;
    readonly right: TypeCoreExpression;
  }
  | {
    readonly kind: "match";
    readonly value: TypeCoreExpression;
    readonly arms: readonly TypeCoreMatchArm[];
    readonly fallback: TypeCoreExpression;
  };

export interface TypeCoreMatchArm {
  readonly pattern: TypeCorePattern;
  readonly result: TypeCoreExpression;
}

export type TypeCoreTypePattern =
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly TypeCorePattern[];
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [TypeCorePattern, TypeCorePattern];
  }
  | {
    readonly kind: "function";
    readonly parameter: TypeCorePattern;
    readonly result: TypeCorePattern;
  };

export type TypeCorePattern =
  | { readonly kind: "bind"; readonly name: string }
  | { readonly kind: "type"; readonly type: TypeCoreTypePattern }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "symbol"; readonly value: string };

export interface TypeCoreTypeConstructor {
  readonly name: string;
  readonly parameterKinds: readonly TypeCoreKind[];
}

export interface TypeCoreFunctionParameter {
  readonly name: string;
  readonly kind: TypeCoreKind;
}

export interface TypeCoreFunction {
  readonly name: string;
  readonly parameters: readonly TypeCoreFunctionParameter[];
  readonly resultKind: TypeCoreKind;
  readonly body: TypeCoreExpression;
}

export interface TypeCoreProgram {
  readonly typeConstructors: readonly TypeCoreTypeConstructor[];
  readonly functions: readonly TypeCoreFunction[];
  readonly entry: TypeCoreExpression;
  readonly sourceByteLength?: number;
}

export interface TypeCoreExecutionOptions {
  readonly maximumCompilationSteps?: number;
  readonly maximumExecutionSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly heapSlots?: number;
  readonly stackFrames?: number;
  readonly maximumResultNodes?: number;
  readonly signal?: AbortSignal;
}

export type TypeCoreExecutionResult =
  | {
    readonly ok: true;
    readonly value: TypeCoreValue;
    readonly stats: FunctionalEvaluationStats;
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
  };
