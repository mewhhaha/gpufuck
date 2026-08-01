import type { EncodedSemanticSurface, SemanticDiagnostic } from "../semantic/abi.ts";
import {
  CORE_V1_PRIMITIVE_CAPABILITIES,
  type Diagnostic,
  type EncodedModule,
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
    typecheckingProfile: TypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities: [],
    declaredDefinitionEffects: Object.freeze(
      Array.from({ length: surface.definitionCount }, () => effectSet()),
    ),
    nodeWords: surface.nodeWords,
    parameterWords: surface.parameterWords,
    argumentWords: surface.argumentWords,
    caseAlternativeWords: surface.caseAlternativeWords,
    caseBinderWords: surface.caseBinderWords,
    definitionWords: surface.definitionWords,
    typeWords: surface.typeWords,
    constructorWords: surface.constructorWords,
    nodeCount: surface.nodeCount,
    argumentCount: surface.argumentCount,
    caseAlternativeCount: surface.caseAlternativeCount,
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
