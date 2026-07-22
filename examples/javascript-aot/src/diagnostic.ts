import type { FunctionalSpan } from "../../../src/functional/abi.ts";

export type JavaScriptAotDiagnosticCode = "J1001" | "J1002";

export interface JavaScriptAotDiagnostic {
  readonly stage: "parse" | "lower";
  readonly code: JavaScriptAotDiagnosticCode;
  readonly message: string;
  readonly span: FunctionalSpan;
  readonly module: string;
}

export class JavaScriptAotSyntaxError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
    this.name = "JavaScriptAotSyntaxError";
  }
}

export class JavaScriptAotLoweringError extends Error {
  constructor(readonly span: FunctionalSpan, message: string) {
    super(message);
    this.name = "JavaScriptAotLoweringError";
  }
}
