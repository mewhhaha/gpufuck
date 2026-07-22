export type {
  JavaScriptAotBinaryOperator,
  JavaScriptAotConstantDeclaration,
  JavaScriptAotDeclaration,
  JavaScriptAotExpression,
  JavaScriptAotFunctionDeclaration,
  JavaScriptAotModule,
  JavaScriptAotStatement,
} from "./src/ast.ts";
export type { JavaScriptAotDiagnostic, JavaScriptAotDiagnosticCode } from "./src/diagnostic.ts";
export { type JavaScriptAotFrontendResult, lowerJavaScriptAotSource } from "./src/frontend.ts";
export type { LoweredJavaScriptAotModule } from "./src/lowering.ts";
