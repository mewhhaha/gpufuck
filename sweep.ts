/**
 * Sweep: a language designed so that compiling it is a bottom-up sweep rather than a global solve.
 * See DESIGN.md for the argument and BASELINE.md for the measurements it is built on.
 *
 * A repository sample, not part of the published package.
 *
 * @module
 */
export type {
  SweepArm,
  SweepBinaryOperator,
  SweepConstructor,
  SweepExpression,
  SweepFunction,
  SweepModule,
  SweepParameter,
  SweepSpan,
  SweepType,
  SweepTypeDeclaration,
} from "./src/sweep/ast.ts";
export {
  parseSweepModule,
  type SweepDiagnostic,
  type SweepParseResult,
} from "./src/sweep/parser.ts";
export { lowerSweepModule, type SweepLowerResult } from "./src/sweep/lowering.ts";

import { parseSweepModule } from "./src/sweep/parser.ts";
import { lowerSweepModule, type SweepLowerResult } from "./src/sweep/lowering.ts";

/** Parse and lower in one step, the way every caller actually wants it. */
export function compileSweepSource(name: string, source: string): SweepLowerResult {
  const parsed = parseSweepModule(name, source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
  return lowerSweepModule(parsed.module, new TextEncoder().encode(source).byteLength);
}
