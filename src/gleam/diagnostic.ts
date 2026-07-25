import type { Span } from "../functional/abi.ts";

export type GleamDiagnosticCode = "G1001" | "G1002" | "G1003";

export interface GleamDiagnostic {
  readonly stage: "parse" | "lower" | "link";
  readonly code: GleamDiagnosticCode;
  readonly message: string;
  readonly span: Span;
  readonly module: string;
}

export class GleamSyntaxError extends Error {
  constructor(readonly span: Span, message: string) {
    super(message);
    this.name = "GleamSyntaxError";
  }
}

export class GleamLoweringError extends Error {
  constructor(readonly span: Span, message: string) {
    super(message);
    this.name = "GleamLoweringError";
  }
}
