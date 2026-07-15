import type { RustFunctionalProgram } from "./ast.ts";
import {
  type RustFunctionalDiagnostic,
  RustFunctionalLoweringError,
  RustFunctionalSyntaxError,
} from "./diagnostic.ts";
import { type LoweredRustFunctionalProgram, lowerRustFunctionalProgram } from "./lowering.ts";
import { parseRustFunctionalProgram } from "./parser.ts";

export type RustFunctionalFrontendResult =
  | { readonly ok: true; readonly lowered: LoweredRustFunctionalProgram }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [RustFunctionalDiagnostic, ...RustFunctionalDiagnostic[]];
  };

export function lowerRustFunctionalSource(source: string): RustFunctionalFrontendResult {
  let program: RustFunctionalProgram;
  try {
    program = parseRustFunctionalProgram(source);
  } catch (error) {
    if (error instanceof RustFunctionalSyntaxError) {
      return {
        ok: false,
        diagnostics: [{ stage: "parse", code: "R1001", message: error.message, span: error.span }],
      };
    }
    throw error;
  }

  try {
    return { ok: true, lowered: lowerRustFunctionalProgram(program) };
  } catch (error) {
    if (error instanceof RustFunctionalLoweringError) {
      return {
        ok: false,
        diagnostics: [{ stage: "lower", code: "R1002", message: error.message, span: error.span }],
      };
    }
    throw error;
  }
}
