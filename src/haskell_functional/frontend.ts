import type { HaskellFunctionalProgram } from "./ast.ts";
import {
  type HaskellFunctionalDiagnostic,
  HaskellFunctionalLoweringError,
  HaskellFunctionalSyntaxError,
} from "./diagnostic.ts";
import { type LoweredHaskellFunctionalProgram, lowerHaskellFunctionalProgram } from "./lowering.ts";
import { parseHaskellFunctionalProgram } from "./parser.ts";

export type HaskellFunctionalFrontendResult =
  | { readonly ok: true; readonly lowered: LoweredHaskellFunctionalProgram }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [HaskellFunctionalDiagnostic, ...HaskellFunctionalDiagnostic[]];
  };

export function lowerHaskellFunctionalSource(source: string): HaskellFunctionalFrontendResult {
  let program: HaskellFunctionalProgram;
  try {
    program = parseHaskellFunctionalProgram(source);
  } catch (error) {
    if (error instanceof HaskellFunctionalSyntaxError) {
      return {
        ok: false,
        diagnostics: [{ stage: "parse", code: "H1001", message: error.message, span: error.span }],
      };
    }
    throw error;
  }

  try {
    return { ok: true, lowered: lowerHaskellFunctionalProgram(program) };
  } catch (error) {
    if (error instanceof HaskellFunctionalLoweringError) {
      return {
        ok: false,
        diagnostics: [{ stage: "lower", code: "H1002", message: error.message, span: error.span }],
      };
    }
    throw error;
  }
}
