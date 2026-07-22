import type {
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  FunctionalNumericConversion,
  FunctionalSpan,
  FunctionalTypeSchema,
  FunctionalUnaryOperator,
} from "./abi.ts";

export type FunctionalSurfaceExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span?: FunctionalSpan }
  | { readonly kind: "signed-integer-64"; readonly value: bigint; readonly span?: FunctionalSpan }
  | { readonly kind: "float-32"; readonly value: number; readonly span?: FunctionalSpan }
  | { readonly kind: "float-64"; readonly value: number; readonly span?: FunctionalSpan }
  | { readonly kind: "whole-number-f64"; readonly value: number; readonly span?: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span?: FunctionalSpan }
  | { readonly kind: "text"; readonly value: string; readonly span?: FunctionalSpan }
  | { readonly kind: "bytes"; readonly value: Uint8Array; readonly span?: FunctionalSpan }
  | { readonly kind: "runtime-fault"; readonly message: string; readonly span?: FunctionalSpan }
  | {
    readonly kind: "text-append" | "bytes-append";
    readonly left: FunctionalSurfaceExpression;
    readonly right: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "store-new";
    readonly length: FunctionalSurfaceExpression;
    readonly initial: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "store-length";
    readonly store: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "store-read";
    readonly store: FunctionalSurfaceExpression;
    readonly index: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "store-write";
    readonly store: FunctionalSurfaceExpression;
    readonly index: FunctionalSurfaceExpression;
    readonly value: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "store-grow";
    readonly store: FunctionalSurfaceExpression;
    readonly length: FunctionalSurfaceExpression;
    readonly initial: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | { readonly kind: "name"; readonly name: string; readonly span?: FunctionalSpan }
  | {
    readonly kind: "lambda";
    readonly parameter: string;
    readonly body: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly value: FunctionalSurfaceExpression;
    readonly body: FunctionalSurfaceExpression;
    readonly valueEvaluation?: FunctionalEvaluationProfile;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "let-rec";
    readonly name: string;
    readonly value: FunctionalSurfaceExpression;
    readonly body: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | FunctionalSurfaceRecursiveGroup
  | {
    readonly kind: "if";
    readonly condition: FunctionalSurfaceExpression;
    readonly consequent: FunctionalSurfaceExpression;
    readonly alternate: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "apply";
    readonly callee: FunctionalSurfaceExpression;
    readonly argument: FunctionalSurfaceExpression;
    readonly argumentEvaluation?: FunctionalEvaluationProfile;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "unary";
    readonly operator: FunctionalUnaryOperator;
    readonly value: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: FunctionalBinaryOperator;
    readonly left: FunctionalSurfaceExpression;
    readonly right: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "numeric-convert";
    readonly conversion: FunctionalNumericConversion;
    readonly value: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "case";
    readonly value: FunctionalSurfaceExpression;
    readonly arms: readonly FunctionalSurfaceCaseArm[];
    readonly span?: FunctionalSpan;
  };

export interface FunctionalSurfaceRecursiveBinding {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: FunctionalSurfaceExpression;
  readonly span?: FunctionalSpan;
}

export interface FunctionalSurfaceRecursiveGroup {
  readonly kind: "let-rec-group";
  readonly bindings: readonly FunctionalSurfaceRecursiveBinding[];
  readonly body: FunctionalSurfaceExpression;
  readonly span?: FunctionalSpan;
}

export interface FunctionalSurfaceCaseArm {
  readonly constructor: string;
  readonly binders: readonly string[];
  readonly body: FunctionalSurfaceExpression;
  readonly span?: FunctionalSpan;
}

export interface FunctionalSurfaceDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly annotation: FunctionalTypeSchema | null;
  readonly body: FunctionalSurfaceExpression;
  readonly span?: FunctionalSpan;
}

export interface FunctionalSurfaceTypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly span?: FunctionalSpan;
  readonly constructors: readonly {
    readonly name: string;
    readonly span?: FunctionalSpan;
    readonly fields: readonly {
      readonly name: string;
      readonly type: FunctionalTypeSchema;
      readonly span?: FunctionalSpan;
    }[];
    readonly result?: FunctionalTypeSchema;
  }[];
}
