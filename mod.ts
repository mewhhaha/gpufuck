/**
 * The Lazuli reference frontend on top of the language-neutral GPU compiler.
 *
 * @module
 */

export * from "./functional.ts";
export {
  type EncodedLazuliSurface,
  LAZULI_ABI_VERSION,
  LAZULI_MAXIMUM_CONSTRUCTOR_ARITY,
  LAZULI_MAXIMUM_PARSE_DEPTH,
  LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH,
  LAZULI_MAXIMUM_SURFACE_NODES,
  LAZULI_NO_INDEX,
  LazuliBinaryOperator,
  LazuliCoreTag,
  type LazuliDiagnostic,
  type LazuliDiagnosticCode,
  type LazuliFrontendResult,
  type LazuliSpan,
  LazuliSurfaceTag,
  type LazuliType,
  type LazuliTypeDeclaration,
  type LazuliTypeSchema,
  LazuliUnaryOperator,
} from "./src/semantic/abi.ts";
export {
  GpuLazuliCompiler,
  type GpuLazuliModule,
  type LazuliCompilationOptions,
  type LazuliCompileResult,
  type LazuliCoreNode,
} from "./src/lazuli/compiler.ts";
export {
  GpuLazuliEvaluator,
  type LazuliBatchEvaluationOptions,
  type LazuliDeepBatchEvaluationOptions,
  type LazuliDeepEvaluationOptions,
  type LazuliDeepEvaluationResult,
  type LazuliDeepValue,
  type LazuliEvaluationOptions,
  type LazuliEvaluationResult,
  type LazuliEvaluationStats,
  type LazuliInputValue,
  type LazuliRuntimeFault,
  type LazuliValue,
} from "./src/semantic/evaluator.ts";
export { initializeLazuliParser, parseLazuliSource } from "./src/lazuli/frontend.ts";
export { lazuliSurfaceToFunctionalModule } from "./src/lazuli/functional_adapter.ts";
export { requestWebGpuDevice } from "./src/webgpu.ts";
