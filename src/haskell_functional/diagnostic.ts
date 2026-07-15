import type { FunctionalSpan } from "../functional/abi.ts";

export type HaskellFunctionalDiagnosticCode = "H1001" | "H1002";

export interface HaskellFunctionalDiagnostic {
  readonly stage: "parse" | "lower";
  readonly code: HaskellFunctionalDiagnosticCode;
  readonly message: string;
  readonly span: FunctionalSpan;
}

export class HaskellFunctionalSyntaxError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
  }
}

export class HaskellFunctionalLoweringError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
  }
}
