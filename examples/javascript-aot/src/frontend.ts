import type { JavaScriptAotModule } from "./ast.ts";
import {
  type JavaScriptAotDiagnostic,
  JavaScriptAotLoweringError,
  JavaScriptAotSyntaxError,
} from "./diagnostic.ts";
import { type LoweredJavaScriptAotModule, lowerJavaScriptAotModule } from "./lowering.ts";
import { parseJavaScriptAotModule } from "./parser.ts";
import {
  lowerJavaScriptRuntimeModule,
  requiresJavaScriptRuntimeModel,
} from "./runtime_lowering.ts";

export type JavaScriptAotFrontendResult =
  | { readonly ok: true; readonly lowered: LoweredJavaScriptAotModule }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [JavaScriptAotDiagnostic, ...JavaScriptAotDiagnostic[]];
  };

export function lowerJavaScriptAotSource(
  name: string,
  source: string,
  entryName = "main",
): JavaScriptAotFrontendResult {
  let sourceModule: JavaScriptAotModule;
  try {
    sourceModule = parseJavaScriptAotModule(name, source);
  } catch (error) {
    if (error instanceof JavaScriptAotSyntaxError) {
      return {
        ok: false,
        diagnostics: [{
          stage: "parse",
          code: "J1001",
          module: name,
          span: error.span,
          message: error.message,
        }],
      };
    }
    throw error;
  }

  try {
    const lowered = requiresJavaScriptRuntimeModel(sourceModule)
      ? lowerJavaScriptRuntimeModule(sourceModule, entryName)
      : lowerJavaScriptAotModule(sourceModule, entryName);
    return { ok: true, lowered };
  } catch (error) {
    if (error instanceof JavaScriptAotLoweringError) {
      return {
        ok: false,
        diagnostics: [{
          stage: "lower",
          code: "J1002",
          module: name,
          span: error.span,
          message: error.message,
        }],
      };
    }
    throw error;
  }
}
