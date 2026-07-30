export type {
  GleamBinaryOperator,
  GleamCallArgument,
  GleamCaseArm,
  GleamConstant,
  GleamConstructor,
  GleamDeclaration,
  GleamExpression,
  GleamFunction,
  GleamImport,
  GleamModule,
  GleamPattern,
  GleamPatternArgument,
  GleamType,
  GleamTypeAlias,
  GleamTypeDeclaration,
} from "./src/gleam/ast.ts";
export type { GleamDiagnostic, GleamDiagnosticCode } from "./src/gleam/diagnostic.ts";
export {
  type GleamFrontendResult,
  type GleamSourceModule,
  type LoweredGleamProgram,
  lowerGleamSource,
  lowerGleamSources,
} from "./src/gleam/frontend.ts";
export {
  GleamFrontendService,
  type GleamFrontendServiceLowerOptions,
} from "./src/gleam/frontend_service.ts";
export type { GleamExportSignature, LoweredGleamModule } from "./src/gleam/lowering.ts";
export {
  ParallelGleamFrontend,
  type ParallelGleamResult,
  type ParallelGleamUnit,
} from "./src/gleam/parallel_frontend.ts";
export { ParallelGleamProjectFrontend } from "./src/gleam/parallel_project_frontend.ts";
export {
  ParallelGleamCompiler,
  type ParallelGleamCompileResult,
} from "./src/gleam/parallel_compiler.ts";
export { initializeGleamParser, parseGleamModule } from "./src/gleam/parser.ts";
export { type GleamTraceInput, renderGleamTrace } from "./src/gleam/trace.ts";
