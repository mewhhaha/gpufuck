/**
 * GPU-backed semantic compilation and WASM emission for functional-language frontends.
 *
 * Frontends lower their syntax into the portable surface module, compile it through WebGPU, and
 * emit ordinary WebAssembly that no longer depends on this package or a GPU.
 *
 * @module
 */

export {
  type EncodedFunctionalDefinitionType,
  type EncodedFunctionalModule,
  type EncodedFunctionalTypeDeclaration,
  FUNCTIONAL_CONSTRUCTOR_BYTE_LENGTH,
  FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_DEFINITION_BYTE_LENGTH,
  FUNCTIONAL_DEFINITION_WORD_LENGTH,
  FUNCTIONAL_MAXIMUM_CONSTRUCTOR_ARITY,
  FUNCTIONAL_MAXIMUM_EXPRESSION_NODES,
  FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_NODE_BYTE_LENGTH,
  FUNCTIONAL_NODE_WORD_LENGTH,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_TYPE_BYTE_LENGTH,
  FUNCTIONAL_TYPE_WORD_LENGTH,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalAlgebraicTypeWord,
  FunctionalBinaryOperator,
  FunctionalConstructorWord,
  FunctionalCoreTag,
  FunctionalDefinitionWord,
  type FunctionalDiagnostic,
  type FunctionalDiagnosticCode,
  FunctionalEvaluationMode,
  FunctionalEvaluationProfile,
  FunctionalExpressionTag,
  FunctionalNodeWord,
  FunctionalNumericConversion,
  FunctionalPrimitiveCapability,
  type FunctionalRelatedDiagnostic,
  type FunctionalSourceRange,
  type FunctionalSourceType,
  type FunctionalSpan,
  type FunctionalType,
  FunctionalTypecheckingProfile,
  type FunctionalTypeDeclaration,
  type FunctionalTypeSchema,
  FunctionalUnaryOperator,
} from "./src/functional/abi.ts";
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
export { GpuFunctionalComptimeExecutor } from "./src/functional/comptime.ts";
export {
  decodeFunctionalConstant,
  encodeFunctionalConstant,
  FUNCTIONAL_COMPTIME_DESCRIPTOR_SCHEMA,
  FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPE_NAME,
  FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPES,
  FUNCTIONAL_COMPTIME_TYPE_TREE_NAME,
  FUNCTIONAL_CONSTANT_ABI_VERSION,
  functionalComptimeStringFromConstant,
  functionalConstantExpression,
  functionalConstantFromComptimeString,
  functionalConstantFromTypeCoreValue,
  type FunctionalConstantMeasurements,
  measureFunctionalConstant,
  validateFunctionalConstant,
} from "./src/functional/comptime_constant.ts";
export {
  FUNCTIONAL_COMPTIME_IR_DEFINITION_LIST_NAME,
  FUNCTIONAL_COMPTIME_IR_EXPRESSION_NAME,
  FUNCTIONAL_COMPTIME_IR_SCHEMA,
  FUNCTIONAL_COMPTIME_IR_TYPES,
  functionalConstantFromGeneratedDefinitions,
  functionalConstantFromSurfaceExpression,
  type FunctionalGeneratedDefinition,
  functionalGeneratedDefinitionsFromConstant,
  functionalSurfaceExpressionFromConstant,
  spliceFunctionalGeneratedDefinitions,
} from "./src/functional/comptime_ir.ts";
export type {
  CompiledFunctionalComptimeFunction,
  FunctionalComptimeDiagnostic,
  FunctionalComptimeDiagnosticCode,
  FunctionalComptimeExecutionOptions,
  FunctionalComptimeExecutionResult,
  FunctionalComptimeExportSelection,
  FunctionalComptimeExportValue,
  FunctionalComptimeFaultKind,
  FunctionalComptimeFunctionCompilationOptions,
  FunctionalComptimeFunctionCompilationResult,
  FunctionalComptimeInvocationOptions,
  FunctionalComptimeInvocationResult,
  FunctionalComptimeInvocationStats,
  FunctionalComptimeModuleArtifact,
  FunctionalComptimeStats,
  FunctionalConstant,
  FunctionalPartialEvaluationResult,
} from "./src/functional/comptime_contract.ts";
export {
  type FunctionalIncrementalComptimeResult,
  type FunctionalIncrementalComptimeStats,
  IncrementalGpuFunctionalComptimeExecutor,
} from "./src/functional/comptime_incremental.ts";
export { partiallyEvaluateFunctionalModule } from "./src/functional/partial_evaluation.ts";
export type {
  FunctionalEffectCoreExpression,
  FunctionalEffectCoreModule,
  LoweredFunctionalEffectCoreModule,
} from "./src/functional/effect_core_contract.ts";
export { compileFunctionalModuleToWasm } from "./src/functional/wasm_artifacts.ts";
export {
  type FunctionalWasmAsyncRunOptions,
  type FunctionalWasmExecution,
  type FunctionalWasmRunOptions,
  type FunctionalWasmStats,
  type FunctionalWasmValue,
  runFunctionalWasmModule,
  runFunctionalWasmModuleAsync,
} from "./src/functional/wasm_execution.ts";
export {
  FunctionalWasmBoundaryError,
  FunctionalWasmRuntimeError,
} from "./src/functional/wasm_host_boundary.ts";
export {
  FUNCTIONAL_WASM_VALUE_ABI_VERSION,
  FunctionalWasmValueAbi,
  type FunctionalWasmValueAbiLayout,
} from "./src/functional/wasm_abi.ts";
export {
  markFunctionalWasmScratch,
  resetFunctionalWasmScratch,
} from "./src/functional/wasm_value_codec.ts";
export {
  FUNCTIONAL_ARRAY_TYPE_NAME,
  FUNCTIONAL_BYTES_TYPE_NAME,
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  FUNCTIONAL_RESOURCE_TYPE_PREFIX,
  FUNCTIONAL_SLICE_TYPE_NAME,
  FUNCTIONAL_TEXT_TYPE_NAME,
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostFieldDeclaration,
  type FunctionalHostOperationDeclaration,
  FunctionalHostOwnership,
  type FunctionalHostScalarType,
  type FunctionalHostType,
  FunctionalHostTypes,
  type FunctionalHostValueDeclaration,
  type FunctionalSurfaceModuleOptions,
} from "./src/functional/host_contract.ts";
export type {
  FunctionalWasmAsyncHostOperation,
  FunctionalWasmAsyncInit,
  FunctionalWasmBoundaryDiagnosticCode,
  FunctionalWasmBoundaryErrorDetails,
  FunctionalWasmBoundaryFaultKind,
  FunctionalWasmExportDeclaration,
  FunctionalWasmHostOperation,
  FunctionalWasmHostValue,
  FunctionalWasmInit,
  FunctionalWasmInitBinding,
  FunctionalWasmRuntimeDiagnosticCode,
  FunctionalWasmRuntimeErrorDetails,
  FunctionalWasmRuntimeFaultKind,
} from "./src/functional/wasm_contract.ts";
export {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceCaseArm,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  type FunctionalSurfaceTypeDeclaration,
  surface,
} from "./src/functional/surface_builder.ts";
export {
  createFunctionalModuleArtifact,
  type FunctionalLinkDiagnosticCode,
  type FunctionalLinkedSource,
  FunctionalLinkError,
  type FunctionalLinkErrorDetails,
  type FunctionalLinkFaultKind,
  type FunctionalModuleArtifact,
  type FunctionalModuleExport,
  type FunctionalModuleImport,
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
  type FunctionalBatchEvaluationOptions,
  type FunctionalDeepBatchEvaluationOptions,
  type FunctionalDeepEvaluationOptions,
  type FunctionalDeepEvaluationResult,
  type FunctionalDeepValue,
  type FunctionalEvaluationOptions,
  type FunctionalEvaluationResult,
  type FunctionalEvaluationStats,
  type FunctionalInputValue,
  type FunctionalRuntimeFault,
  type FunctionalValue,
  GpuFunctionalEvaluator,
} from "./src/functional/evaluator.ts";
export {
  type TypeCoreCapabilityEvidence,
  type TypeCoreCapabilityGoal,
  type TypeCoreCapabilityPattern,
  type TypeCoreCapabilityPremise,
  type TypeCoreCapabilityResolution,
  type TypeCoreCapabilityResolutionOptions,
  type TypeCoreCapabilityRule,
  type TypeCoreCapabilityTypePattern,
  type TypeCoreCapabilityVerification,
  type TypeCoreCapabilityWitness,
} from "./src/functional/capability_contract.ts";
export { TypeCoreCapabilityResolver } from "./src/functional/capability_resolver.ts";
export type {
  FunctionalEffectExpression,
  FunctionalEffectHandler,
  FunctionalEffectOperation,
  FunctionalEffectProgram,
  FunctionalEffectType,
  LoweredFunctionalEffectProgram,
} from "./src/functional/effect_contract.ts";
export { lowerFunctionalEffectProgram } from "./src/functional/effect_lowering.ts";
export {
  type TypeCoreExecutionOptions,
  type TypeCoreExecutionResult,
  type TypeCoreExpression,
  type TypeCoreFunction,
  type TypeCoreFunctionParameter,
  TypeCoreKind,
  type TypeCoreMatchArm,
  type TypeCorePattern,
  type TypeCoreProgram,
  type TypeCoreType,
  type TypeCoreTypeConstructor,
  type TypeCoreTypeExpression,
  type TypeCoreTypePattern,
  type TypeCoreValue,
} from "./src/functional/type_core_contract.ts";
export { GpuTypeCoreExecutor } from "./src/functional/type_core.ts";
export type {
  FunctionalTypeConstructorDeclaration,
  FunctionalTypeExpression,
  FunctionalTypeFunctionDeclaration,
  FunctionalTypeFunctionParameter,
  FunctionalTypeKind,
  FunctionalTypeNormalization,
  FunctionalTypeNormalizationOptions,
  FunctionalTypeProgram,
} from "./src/functional/type_program_contract.ts";
export {
  functionalSchemaFromTypeCoreType,
  FunctionalTypeNormalizer,
} from "./src/functional/type_program.ts";
export { requestWebGpuDevice } from "./src/webgpu.ts";
