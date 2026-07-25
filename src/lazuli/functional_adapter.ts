import type {
  EncodedLazuliSurface,
  LazuliDiagnostic,
  LazuliDiagnosticCode,
} from "../semantic/abi.ts";
import {
  CORE_V1_PRIMITIVE_CAPABILITIES,
  type Diagnostic,
  type EncodedFunctionalModule,
  EvaluationProfile,
  MODULE_ABI_VERSION,
  TypecheckingProfile,
} from "../functional/abi.ts";

export function lazuliSurfaceToFunctionalModule(
  surface: EncodedLazuliSurface,
  sourceByteLength: number,
): EncodedFunctionalModule {
  return {
    abiVersion: MODULE_ABI_VERSION,
    sourceByteLength,
    evaluationProfile: EvaluationProfile.LazyCallByNeed,
    typecheckingProfile: TypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities: [],
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
): LazuliDiagnostic {
  return {
    stage: "compile",
    code: `L${diagnostic.code.slice(1)}` as LazuliDiagnosticCode,
    message: diagnostic.message,
    span: diagnostic.span,
  };
}
