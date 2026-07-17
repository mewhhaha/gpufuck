import type { FunctionalEvaluationProfile, FunctionalSpan } from "./abi.ts";
import type { FunctionalEffectOperation, FunctionalEffectType } from "./effect_contract.ts";
import type {
  FunctionalHostCapabilityDeclaration,
  FunctionalHostScalarType,
} from "./host_contract.ts";
import type {
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_builder.ts";

export type FunctionalEffectCoreExpression =
  | {
    readonly kind: "return";
    readonly value: FunctionalSurfaceExpression;
    readonly valueType: FunctionalHostScalarType;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "host-call";
    readonly capability: string;
    readonly operation: string;
    readonly argument: FunctionalSurfaceExpression;
    readonly argumentType: FunctionalHostScalarType;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "perform";
    readonly effect: string;
    readonly operation: string;
    readonly argument: FunctionalSurfaceExpression;
    readonly argumentType: FunctionalHostScalarType;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "bind";
    readonly name: string;
    readonly computation: FunctionalEffectCoreExpression;
    readonly body: FunctionalEffectCoreExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "branch";
    readonly condition: FunctionalSurfaceExpression;
    readonly conditionType: FunctionalHostScalarType;
    readonly consequent: FunctionalEffectCoreExpression;
    readonly alternate: FunctionalEffectCoreExpression;
    readonly span?: FunctionalSpan;
  }
  | {
    readonly kind: "handle";
    readonly effect: string;
    readonly operation: string;
    readonly implementation: FunctionalSurfaceExpression;
    readonly computation: FunctionalEffectCoreExpression;
    readonly span?: FunctionalSpan;
  };

export interface FunctionalEffectCoreModule {
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly operations: readonly FunctionalEffectOperation[];
  readonly hostCapabilities: readonly FunctionalHostCapabilityDeclaration[];
  readonly expression: FunctionalEffectCoreExpression;
  readonly entryName: string;
  readonly sourceByteLength: number;
  readonly evaluationProfile?: FunctionalEvaluationProfile;
}

export interface LoweredFunctionalEffectCoreModule {
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly hostCapabilities: readonly FunctionalHostCapabilityDeclaration[];
  readonly entryName: string;
  readonly sourceByteLength: number;
  readonly computationType: FunctionalEffectType;
  readonly resultType: FunctionalEffectType;
}
