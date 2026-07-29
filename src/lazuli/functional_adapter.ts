import type { EncodedSemanticSurface, SemanticDiagnostic } from "../semantic/abi.ts";
import {
  CORE_V1_PRIMITIVE_CAPABILITIES,
  type Diagnostic,
  type EncodedModule,
  EvaluationProfile,
  MODULE_ABI_VERSION,
  TypecheckingProfile,
} from "../functional/abi.ts";
import { effectSet } from "../functional/effect_set.ts";

export function lazuliSurfaceToModule(
  surface: EncodedSemanticSurface,
  sourceByteLength: number,
): EncodedModule {
  return {
    abiVersion: MODULE_ABI_VERSION,
    sourceByteLength,
    evaluationProfile: EvaluationProfile.LazyCallByNeed,
    typecheckingProfile: TypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities: [],
    declaredDefinitionEffects: Object.freeze(
      Array.from({ length: surface.definitionCount }, () => effectSet()),
    ),
    nodeWords: surface.nodeWords,
    definitionWords: surface.definitionWords,
    typeWords: surface.typeWords,
    constructorWords: surface.constructorWords,
    nodeCount: surface.nodeCount,
    definitionCount: surface.definitionCount,
    typeCount: surface.typeCount,
    constructorCount: surface.constructorCount,
    entrySymbol: surface.entrySymbol,
    symbolNames: surface.symbolNames,
    definitionTypes: surface.definitionTypes,
    typeDeclarations: surface.typeDeclarations,
  };
}

export function lazuliDiagnosticFromFunctional(
  diagnostic: Diagnostic,
): SemanticDiagnostic {
  return {
    stage: "compile",
    code: diagnostic.code,
    message: diagnostic.message,
    span: diagnostic.span,
  };
}
