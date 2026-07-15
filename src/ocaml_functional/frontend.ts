import type { OcamlFunctionalProgram } from "./ast.ts";
import {
  type OcamlFunctionalDiagnostic,
  OcamlFunctionalLoweringError,
  OcamlFunctionalSyntaxError,
} from "./diagnostic.ts";
import { type LoweredOcamlFunctionalProgram, lowerOcamlFunctionalProgram } from "./lowering.ts";
import { parseOcamlFunctionalProgram } from "./parser.ts";

export type OcamlFunctionalFrontendResult =
  | { readonly ok: true; readonly lowered: LoweredOcamlFunctionalProgram }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [OcamlFunctionalDiagnostic, ...OcamlFunctionalDiagnostic[]];
  };

export function lowerOcamlFunctionalSource(source: string): OcamlFunctionalFrontendResult {
  let program: OcamlFunctionalProgram;
  try {
    program = parseOcamlFunctionalProgram(source);
  } catch (error) {
    if (error instanceof OcamlFunctionalSyntaxError) {
      return {
        ok: false,
        diagnostics: [{ stage: "parse", code: "O1001", message: error.message, span: error.span }],
      };
    }
    throw error;
  }

  try {
    return { ok: true, lowered: lowerOcamlFunctionalProgram(program) };
  } catch (error) {
    if (error instanceof OcamlFunctionalLoweringError) {
      return {
        ok: false,
        diagnostics: [{ stage: "lower", code: "O1002", message: error.message, span: error.span }],
      };
    }
    throw error;
  }
}
