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
  type FunctionalSourceType,
  type FunctionalSpan,
  type FunctionalType,
  FunctionalTypecheckingProfile,
  type FunctionalTypeDeclaration,
  type FunctionalTypeSchema,
  FunctionalUnaryOperator,
} from "./src/functional/abi.ts";
export {
  type FunctionalCompilationOptions,
  type FunctionalCompileResult,
  type FunctionalCoreNode,
  GpuFunctionalCompiler,
  type GpuFunctionalModule,
} from "./src/functional/compiler.ts";
export type {
  FunctionalEffectCoreExpression,
  FunctionalEffectCoreModule,
  LoweredFunctionalEffectCoreModule,
} from "./src/functional/effect_core_contract.ts";
export {
  compileFunctionalModuleToWasm,
  type FunctionalWasmExecution,
  type FunctionalWasmRunOptions,
  FunctionalWasmRuntimeError,
  type FunctionalWasmStats,
  type FunctionalWasmValue,
  runFunctionalWasmModule,
} from "./src/functional/wasm_codegen.ts";
export {
  FUNCTIONAL_WASM_VALUE_ABI_VERSION,
  FunctionalWasmValueAbi,
  type FunctionalWasmValueAbiLayout,
} from "./src/functional/wasm_abi.ts";
export {
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostFieldDeclaration,
  type FunctionalHostOperationDeclaration,
  type FunctionalHostScalarType,
  type FunctionalHostType,
  type FunctionalHostValueDeclaration,
  type FunctionalSurfaceModuleOptions,
  type FunctionalWasmHostOperation,
  type FunctionalWasmHostValue,
  type FunctionalWasmInit,
  type FunctionalWasmInitBinding,
} from "./src/functional/host_contract.ts";
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
  type FunctionalLinkedSource,
  type FunctionalModuleArtifact,
  type FunctionalModuleExport,
  type FunctionalModuleImport,
  type LinkedFunctionalModule,
  linkFunctionalModules,
} from "./src/functional/module_linker.ts";
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
