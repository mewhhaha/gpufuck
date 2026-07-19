/** Portable Functional Core contracts, builders, linking, and GPU semantic compilation. */

export * from "./src/functional/abi.ts";
export {
  type FunctionalLocatedDiagnostic,
  type FunctionalSourceSpan,
  locateFunctionalDiagnostic,
  locateFunctionalSpan,
} from "./src/functional/diagnostics.ts";
export {
  type FunctionalCompilationOptions,
  type FunctionalCompileResult,
  type FunctionalCoreNode,
  GpuFunctionalCompiler,
  type GpuFunctionalModule,
} from "./src/functional/compiler.ts";
export type { FunctionalCompiledCoreArtifact } from "./src/functional/core_artifact.ts";
export {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceCaseArm,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  type FunctionalSurfaceRecursiveBinding,
  type FunctionalSurfaceRecursiveGroup,
  type FunctionalSurfaceTypeDeclaration,
  functionalThunkType,
  surface,
} from "./src/functional/surface_builder.ts";
export { elaborateFunctionalRecursiveGroups } from "./src/functional/recursive_groups.ts";
export {
  createFunctionalModuleArtifact,
  type FunctionalLinkDiagnosticCode,
  type FunctionalLinkedSource,
  FunctionalLinkError,
  type FunctionalLinkErrorDetails,
  type FunctionalLinkFaultKind,
  type FunctionalModuleArtifact,
  type FunctionalModuleConstructorExport,
  type FunctionalModuleConstructorImport,
  type FunctionalModuleExport,
  type FunctionalModuleImport,
  type FunctionalModuleTypeExport,
  type FunctionalModuleTypeImport,
  type LinkedFunctionalModule,
  linkFunctionalModules,
} from "./src/functional/module_linker.ts";
export {
  DirectoryFunctionalIncrementalCache,
  type FunctionalIncrementalCache,
  MemoryFunctionalIncrementalCache,
} from "./src/functional/incremental_cache.ts";
export {
  type FunctionalIncrementalCompilationOptions,
  type FunctionalIncrementalCompilationStats,
  type FunctionalIncrementalCompileResult,
  IncrementalGpuFunctionalCompiler,
} from "./src/functional/incremental_compiler.ts";
export {
  buildFunctionalModuleGraph,
  fingerprintFunctionalModuleArtifact,
  FUNCTIONAL_INCREMENTAL_CACHE_FORMAT_VERSION,
  type FunctionalModuleFingerprint,
  type FunctionalModuleGraph,
  type FunctionalModuleScc,
} from "./src/functional/incremental_graph.ts";
export {
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostDefinitionBinding,
  type FunctionalHostFieldDeclaration,
  type FunctionalHostOperationDeclaration,
  FunctionalHostOwnership,
  type FunctionalHostScalarType,
  type FunctionalHostType,
  FunctionalHostTypes,
  type FunctionalHostValueDeclaration,
  type FunctionalSurfaceModuleOptions,
  FunctionalWasmIntrinsic,
  type FunctionalWasmLiteral,
} from "./src/functional/host_contract.ts";
export { requestWebGpuDevice } from "./src/webgpu.ts";
