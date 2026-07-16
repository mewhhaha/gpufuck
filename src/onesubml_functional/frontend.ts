import type { OneSubmlFunctionalProgram } from "./ast.ts";
import {
  type OneSubmlFunctionalDiagnostic,
  OneSubmlFunctionalLoweringError,
  OneSubmlFunctionalSyntaxError,
} from "./diagnostic.ts";
import {
  type LoweredOneSubmlFunctionalProgram,
  lowerOneSubmlFunctionalProgram,
} from "./lowering.ts";
import { parseOneSubmlFunctionalProgram } from "./parser.ts";

export type OneSubmlFunctionalFrontendResult =
  | { readonly ok: true; readonly lowered: LoweredOneSubmlFunctionalProgram }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [
      OneSubmlFunctionalDiagnostic,
      ...OneSubmlFunctionalDiagnostic[],
    ];
  };

export function lowerOneSubmlFunctionalSource(
  source: string,
): OneSubmlFunctionalFrontendResult {
  let program: OneSubmlFunctionalProgram;
  try {
    program = parseOneSubmlFunctionalProgram(source);
  } catch (error) {
    if (error instanceof OneSubmlFunctionalSyntaxError) {
      return {
        ok: false,
        diagnostics: [{ stage: "parse", code: "S1001", message: error.message, span: error.span }],
      };
    }
    throw error;
  }

  try {
    return { ok: true, lowered: lowerOneSubmlFunctionalProgram(program) };
  } catch (error) {
    if (error instanceof OneSubmlFunctionalLoweringError) {
      return {
        ok: false,
        diagnostics: [{ stage: "lower", code: "S1002", message: error.message, span: error.span }],
      };
    }
    throw error;
  }
}
