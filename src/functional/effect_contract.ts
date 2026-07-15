import type { FunctionalSpan, FunctionalTypeSchema } from "./abi.ts";
import type {
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
} from "./surface_builder.ts";

export interface FunctionalEffectOperation {
  readonly effect: string;
  readonly name: string;
  readonly parameter: FunctionalTypeSchema;
  readonly result: FunctionalTypeSchema;
}

export type FunctionalEffectExpression =
  | {
    readonly kind: "pure";
    readonly value: FunctionalSurfaceExpression;
    readonly valueType: FunctionalTypeSchema;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "perform";
    readonly effect: string;
    readonly operation: string;
    readonly argument: FunctionalSurfaceExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "bind";
    readonly name: string;
    readonly computation: FunctionalEffectExpression;
    readonly body: FunctionalEffectExpression;
    readonly span?: FunctionalSpan;
  };

export interface FunctionalEffectHandler {
  readonly effect: string;
  readonly operation: string;
  readonly implementation: FunctionalSurfaceExpression;
}

export interface FunctionalEffectProgram {
  readonly operations: readonly FunctionalEffectOperation[];
  readonly handlers: readonly FunctionalEffectHandler[];
  readonly expression: FunctionalEffectExpression;
}

export interface FunctionalEffectType {
  readonly value: FunctionalTypeSchema;
  readonly effects: readonly string[];
}

export interface LoweredFunctionalEffectProgram {
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly expression: FunctionalSurfaceExpression;
  readonly computationType: FunctionalEffectType;
  readonly resultType: FunctionalEffectType;
}
