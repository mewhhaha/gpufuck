import type { TypeCoreKind, TypeCoreValue } from "./type_core_contract.ts";

export type TypeCoreCapabilityTypePattern =
  | { readonly kind: "variable"; readonly name: string }
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly TypeCoreCapabilityPattern[];
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [
      TypeCoreCapabilityTypePattern,
      TypeCoreCapabilityTypePattern,
    ];
  }
  | {
    readonly kind: "function";
    readonly parameter: TypeCoreCapabilityTypePattern;
    readonly result: TypeCoreCapabilityTypePattern;
  };

export type TypeCoreCapabilityPattern =
  | {
    readonly kind: "variable";
    readonly name: string;
    readonly valueKind: TypeCoreKind;
  }
  | { readonly kind: "type"; readonly type: TypeCoreCapabilityTypePattern }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "symbol"; readonly value: string };

export interface TypeCoreCapabilityGoal {
  readonly predicate: string;
  readonly inputs: readonly TypeCoreValue[];
}

export interface TypeCoreCapabilityPremise {
  readonly predicate: string;
  readonly inputs: readonly TypeCoreCapabilityPattern[];
}

export type TypeCoreCapabilityWitness =
  | { readonly kind: "erased-proof" }
  | { readonly kind: "compile-time"; readonly symbol: string }
  | { readonly kind: "runtime-dictionary"; readonly symbol: string };

export interface TypeCoreCapabilityRule {
  readonly id: string;
  readonly predicate: string;
  readonly inputs: readonly TypeCoreCapabilityPattern[];
  readonly outputs: readonly TypeCoreCapabilityPattern[];
  readonly premises: readonly TypeCoreCapabilityPremise[];
  readonly witness: TypeCoreCapabilityWitness;
}

export interface TypeCoreCapabilityEvidence {
  readonly ruleId: string;
  readonly goal: TypeCoreCapabilityGoal;
  readonly outputs: readonly TypeCoreValue[];
  readonly witness: TypeCoreCapabilityWitness;
  readonly premises: readonly TypeCoreCapabilityEvidence[];
}

export interface TypeCoreCapabilityResolutionOptions {
  readonly maximumTransitions?: number;
  readonly maximumDepth?: number;
}

export type TypeCoreCapabilityResolution =
  | {
    readonly ok: true;
    readonly outputs: readonly TypeCoreValue[];
    readonly evidence: TypeCoreCapabilityEvidence;
    readonly transitions: number;
  }
  | {
    readonly ok: false;
    readonly kind:
      | "unresolved"
      | "ambiguous"
      | "cycle"
      | "depth-exhausted"
      | "out-of-fuel";
    readonly message: string;
    readonly transitions: number;
  };

export type TypeCoreCapabilityVerification =
  | {
    readonly ok: true;
    readonly outputs: readonly TypeCoreValue[];
    readonly transitions: number;
  }
  | {
    readonly ok: false;
    readonly message: string;
    readonly transitions: number;
  };
