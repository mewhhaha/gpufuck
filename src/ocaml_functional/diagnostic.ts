import type { FunctionalSpan } from "../functional/abi.ts";

export type OcamlFunctionalDiagnosticCode = "O1001" | "O1002";

export interface OcamlFunctionalDiagnostic {
  readonly stage: "parse" | "lower";
  readonly code: OcamlFunctionalDiagnosticCode;
  readonly message: string;
  readonly span: FunctionalSpan;
}

export class OcamlFunctionalSyntaxError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
  }
}

export class OcamlFunctionalLoweringError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
  }
}
