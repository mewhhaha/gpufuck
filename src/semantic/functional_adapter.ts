import type { EncodedLazuliSurface, LazuliDiagnostic, LazuliDiagnosticCode } from "./abi.ts";
import {
  type EncodedFunctionalModule,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_MODULE_ABI_VERSION,
  type FunctionalDiagnostic,
  FunctionalEvaluationProfile,
  FunctionalTypecheckingProfile,
} from "../functional/abi.ts";

export function lazuliSurfaceToFunctionalModule(
  surface: EncodedLazuliSurface,
  sourceByteLength: number,
): EncodedFunctionalModule {
  return {
    abiVersion: FUNCTIONAL_MODULE_ABI_VERSION,
    sourceByteLength,
    evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed,
    typecheckingProfile: FunctionalTypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities: [],
    nodeWords: surface.nodeWords,
    definitionWords: surface.definitionWords,
    typeWords: surface.typeWords,
    constructorWords: surface.constructorWords,
    nodeCount: surface.nodeCount,
    definitionCount: surface.definitionCount,
    typeCount: surface.typeCount,
    constructorCount: surface.constructorCount,
    entrySymbol: surface.mainSymbol,
    symbolNames: surface.symbolNames,
    definitionTypes: surface.definitionTypes,
    typeDeclarations: surface.typeDeclarations,
  };
}

export function lazuliDiagnosticFromFunctional(
  diagnostic: FunctionalDiagnostic,
): LazuliDiagnostic {
  return {
    stage: "compile",
    code: `L${diagnostic.code.slice(1)}` as LazuliDiagnosticCode,
    message: diagnostic.message,
    span: diagnostic.span,
  };
}
