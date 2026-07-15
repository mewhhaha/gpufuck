import type { FunctionalSpan } from "../functional/abi.ts";

export type RustFunctionalDiagnosticCode = "R1001" | "R1002";

export interface RustFunctionalDiagnostic {
  readonly stage: "parse" | "lower";
  readonly code: RustFunctionalDiagnosticCode;
  readonly message: string;
  readonly span: FunctionalSpan;
}

export class RustFunctionalSyntaxError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
  }
}

export class RustFunctionalLoweringError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
  }
}
