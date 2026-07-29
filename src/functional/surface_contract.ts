import type {
  BinaryOperator,
  EvaluationProfile,
  NumericConversion,
  Span,
  TypeSchema,
  UnaryOperator,
} from "./abi.ts";
import type { EffectSet } from "./effect_set.ts";

export type SurfaceExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span?: Span }
  | { readonly kind: "signed-integer-64"; readonly value: bigint; readonly span?: Span }
  | { readonly kind: "float-32"; readonly value: number; readonly span?: Span }
  | { readonly kind: "float-64"; readonly value: number; readonly span?: Span }
  | { readonly kind: "whole-number-f64"; readonly value: number; readonly span?: Span }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span?: Span }
  | { readonly kind: "text"; readonly value: string; readonly span?: Span }
  | { readonly kind: "bytes"; readonly value: Uint8Array; readonly span?: Span }
  | { readonly kind: "runtime-fault"; readonly message: string; readonly span?: Span }
  | {
    readonly kind: "text-append" | "bytes-append";
    readonly left: SurfaceExpression;
    readonly right: SurfaceExpression;
    readonly span?: Span;
  }
  | { readonly kind: "store-empty"; readonly span?: Span }
  | {
    readonly kind: "store-new";
    readonly length: SurfaceExpression;
    readonly initial: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "store-length";
    readonly store: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "store-read";
    readonly store: SurfaceExpression;
    readonly index: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "store-write";
    readonly store: SurfaceExpression;
    readonly index: SurfaceExpression;
    readonly value: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "store-grow";
    readonly store: SurfaceExpression;
    readonly length: SurfaceExpression;
    readonly initial: SurfaceExpression;
    readonly span?: Span;
  }
  | { readonly kind: "name"; readonly name: string; readonly span?: Span }
  | {
    readonly kind: "lambda";
    readonly parameters: readonly string[];
    readonly body: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly value: SurfaceExpression;
    readonly body: SurfaceExpression;
    readonly valueEvaluation?: EvaluationProfile;
    readonly span?: Span;
  }
  | {
    readonly kind: "let-rec";
    readonly name: string;
    readonly value: SurfaceExpression;
    readonly body: SurfaceExpression;
    readonly span?: Span;
  }
  | SurfaceRecursiveGroup
  | {
    readonly kind: "if";
    readonly condition: SurfaceExpression;
    readonly consequent: SurfaceExpression;
    readonly alternate: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "apply";
    readonly callee: SurfaceExpression;
    readonly arguments: readonly SurfaceExpression[];
    readonly argumentEvaluations?: readonly EvaluationProfile[];
    readonly span?: Span;
  }
  | {
    readonly kind: "unary";
    readonly operator: UnaryOperator;
    readonly value: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "binary";
    readonly operator: BinaryOperator;
    readonly left: SurfaceExpression;
    readonly right: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "numeric-convert";
    readonly conversion: NumericConversion;
    readonly value: SurfaceExpression;
    readonly span?: Span;
  }
  | {
    readonly kind: "case";
    readonly value: SurfaceExpression;
    readonly arms: readonly SurfaceCaseArm[];
    /**
     * Covers every constructor the arms omit. Cases must be exhaustive, so without this a frontend
     * has to enumerate the owner's full constructor list itself and hoist the fallback into a thunk
     * to avoid duplicating it per arm. The scrutinee is evaluated once and passed to `binder`.
     */
    readonly otherwise?: SurfaceCaseDefault;
    readonly span?: Span;
  };

export interface SurfaceCaseDefault {
  readonly binder?: string;
  readonly body: SurfaceExpression;
  readonly span?: Span;
}

export interface SurfaceRecursiveBinding {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly body: SurfaceExpression;
  readonly span?: Span;
}

export interface SurfaceRecursiveGroup {
  readonly kind: "let-rec-group";
  readonly bindings: readonly SurfaceRecursiveBinding[];
  readonly body: SurfaceExpression;
  readonly span?: Span;
}

export interface SurfaceCaseArm {
  readonly constructor: string;
  readonly binders: readonly string[];
  readonly body: SurfaceExpression;
  readonly span?: Span;
}

export interface SurfaceDefinition {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly annotation: TypeSchema | null;
  /**
   * Effects introduced by evaluating or calling this definition. They are unioned with effects
   * inferred from its body and flow through ordinary higher-order calls.
   */
  readonly effects?: EffectSet;
  readonly body: SurfaceExpression;
  readonly span?: Span;
}

export interface SurfaceTypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly span?: Span;
  readonly constructors: readonly {
    readonly name: string;
    readonly span?: Span;
    readonly fields: readonly {
      readonly name: string;
      readonly type: TypeSchema;
      readonly span?: Span;
    }[];
    readonly result?: TypeSchema;
  }[];
}
