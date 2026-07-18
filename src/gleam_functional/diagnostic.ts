import type { FunctionalSpan } from "../functional/abi.ts";

export type GleamFunctionalDiagnosticCode = "G1001" | "G1002" | "G1003";

export interface GleamFunctionalDiagnostic {
  readonly stage: "parse" | "lower" | "link";
  readonly code: GleamFunctionalDiagnosticCode;
  readonly message: string;
  readonly span: FunctionalSpan;
  readonly module: string;
}

export class GleamFunctionalSyntaxError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
    this.name = "GleamFunctionalSyntaxError";
  }
}

export class GleamFunctionalLoweringError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
    this.name = "GleamFunctionalLoweringError";
  }
}
