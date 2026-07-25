/**
 * The Lazuli reference frontend on top of the language-neutral GPU compiler.
 *
 * @module
 */

export * from "./functional.ts";
export {
  BinaryOperator,
  CoreTag,
  type EncodedSemanticSurface,
  ExpressionTag,
  type FrontendResult,
  MAXIMUM_CONSTRUCTOR_ARITY,
  MAXIMUM_EXPRESSION_NODES,
  MAXIMUM_PARSE_DEPTH,
  MAXIMUM_SOURCE_BYTE_LENGTH,
  MODULE_ABI_VERSION,
  NO_INDEX,
  type SemanticDiagnostic,
  type SemanticDiagnosticCode,
  type Span,
  type Type,
  type TypeDeclaration,
  type TypeSchema,
  UnaryOperator,
} from "./src/semantic/abi.ts";
export {
  type CoreNode,
  GpuLazuliCompiler,
  type GpuSemanticModule,
  type SemanticCompilationOptions,
  type SemanticCompileResult,
} from "./src/lazuli/compiler.ts";
export {
  GpuSemanticEvaluator,
  type SemanticBatchEvaluationOptions,
  type SemanticDeepBatchEvaluationOptions,
  type SemanticDeepEvaluationOptions,
  type SemanticDeepEvaluationResult,
  type SemanticDeepValue,
  type SemanticEvaluationOptions,
  type SemanticEvaluationResult,
  type SemanticEvaluationStats,
  type SemanticInputValue,
  type SemanticRuntimeFault,
  type SemanticValue,
} from "./src/semantic/evaluator.ts";
export { initializeLazuliParser, parseLazuliSource } from "./src/lazuli/frontend.ts";
export { lazuliSurfaceToModule } from "./src/lazuli/functional_adapter.ts";
export { requestWebGpuDevice } from "./src/webgpu.ts";
