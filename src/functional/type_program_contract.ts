import type { FunctionalTypeSchema } from "./abi.ts";
import type { TypeCoreCapabilityEvidence } from "./capability_contract.ts";

export type FunctionalTypeKind =
  | { readonly kind: "type" }
  | {
    readonly kind: "constructor";
    readonly parameter: FunctionalTypeKind;
    readonly result: FunctionalTypeKind;
  };

export type FunctionalTypeExpression =
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | { readonly kind: "reference"; readonly name: string }
  | {
    readonly kind: "apply";
    readonly constructor: FunctionalTypeExpression;
    readonly argument: FunctionalTypeExpression;
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [FunctionalTypeExpression, FunctionalTypeExpression];
  }
  | {
    readonly kind: "function";
    readonly parameter: FunctionalTypeExpression;
    readonly result: FunctionalTypeExpression;
  }
  | {
    readonly kind: "associated";
    readonly predicate: string;
    readonly inputs: readonly FunctionalTypeExpression[];
    readonly output: number;
  };

export interface FunctionalTypeConstructorDeclaration {
  readonly name: string;
  readonly parameterKinds: readonly FunctionalTypeKind[];
}

export interface FunctionalTypeFunctionParameter {
  readonly name: string;
  readonly kind: FunctionalTypeKind;
}

export interface FunctionalTypeFunctionDeclaration {
  readonly name: string;
  readonly parameters: readonly FunctionalTypeFunctionParameter[];
  readonly resultKind: FunctionalTypeKind;
  readonly body: FunctionalTypeExpression;
}

export interface FunctionalTypeProgram {
  readonly constructors: readonly FunctionalTypeConstructorDeclaration[];
  readonly functions: readonly FunctionalTypeFunctionDeclaration[];
}

export interface FunctionalTypeNormalizationOptions {
  readonly maximumTransitions?: number;
}

export interface FunctionalTypeNormalization {
  readonly schema: FunctionalTypeSchema;
  readonly evidence: readonly TypeCoreCapabilityEvidence[];
  readonly transitions: number;
}
