import type { FunctionalSpan } from "../functional/abi.ts";

export interface OneSubmlFunctionalProgram {
  readonly definitions: readonly OneSubmlFunctionalDefinition[];
  readonly span: FunctionalSpan;
}

export interface OneSubmlFunctionalDefinition {
  readonly name: string;
  readonly recursive: boolean;
  readonly value: OneSubmlFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type OneSubmlFunctionalPattern =
  | { readonly kind: "name"; readonly name: string | null; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [OneSubmlFunctionalPattern, OneSubmlFunctionalPattern];
    readonly span: FunctionalSpan;
  };

export interface OneSubmlFunctionalRecordField {
  readonly name: string;
  readonly value: OneSubmlFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type OneSubmlFunctionalType =
  | { readonly kind: "integer"; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "parameter"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [OneSubmlFunctionalType, OneSubmlFunctionalType];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "function";
    readonly parameter: OneSubmlFunctionalType;
    readonly result: OneSubmlFunctionalType;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "forall";
    readonly parameters: readonly string[];
    readonly body: OneSubmlFunctionalType;
    readonly span: FunctionalSpan;
  };

export type OneSubmlFunctionalExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "name"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [OneSubmlFunctionalExpression, OneSubmlFunctionalExpression];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "record";
    readonly fields: readonly OneSubmlFunctionalRecordField[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "field";
    readonly value: OneSubmlFunctionalExpression;
    readonly field: string;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "lambda";
    readonly typeParameters: readonly string[];
    readonly parameter: OneSubmlFunctionalPattern;
    readonly parameterType: OneSubmlFunctionalType | null;
    readonly resultType: OneSubmlFunctionalType | null;
    readonly body: OneSubmlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "apply";
    readonly callee: OneSubmlFunctionalExpression;
    readonly argument: OneSubmlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "let";
    readonly pattern: OneSubmlFunctionalPattern;
    readonly recursive: boolean;
    readonly value: OneSubmlFunctionalExpression;
    readonly body: OneSubmlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: OneSubmlFunctionalExpression;
    readonly consequent: OneSubmlFunctionalExpression;
    readonly alternate: OneSubmlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: OneSubmlFunctionalBinaryOperator;
    readonly left: OneSubmlFunctionalExpression;
    readonly right: OneSubmlFunctionalExpression;
    readonly span: FunctionalSpan;
  };

export type OneSubmlFunctionalBinaryOperator =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/";
