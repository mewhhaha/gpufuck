import type { FunctionalSpan } from "../functional/abi.ts";

export type OneSubmlFunctionalDiagnosticCode = "S1001" | "S1002";

export interface OneSubmlFunctionalDiagnostic {
  readonly stage: "parse" | "lower";
  readonly code: OneSubmlFunctionalDiagnosticCode;
  readonly message: string;
  readonly span: FunctionalSpan;
}

export class OneSubmlFunctionalSyntaxError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
  }
}

export class OneSubmlFunctionalLoweringError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
  }
}
