import type { Span } from "../functional/abi.ts";

/**
 * `G1004` is a capacity failure: the linked program exceeds a packed-ABI limit, most often the
 * 65,536-node cap on a surface module. It exists because that condition used to escape as a bare
 * `RangeError`, which ended a batch run and reported nothing about the remaining modules.
 */
export type GleamDiagnosticCode = "G1001" | "G1002" | "G1003" | "G1004";

export interface GleamDiagnostic {
  readonly stage: "parse" | "lower" | "link" | "limit";
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
