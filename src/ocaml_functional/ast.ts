import type { FunctionalSpan } from "../functional/abi.ts";

export interface OcamlFunctionalProgram {
  readonly declarations: readonly OcamlFunctionalDeclaration[];
  readonly span: FunctionalSpan;
}

export type OcamlFunctionalDeclaration =
  | OcamlFunctionalTypeDeclaration
  | OcamlFunctionalDefinition;

export interface OcamlFunctionalTypeDeclaration {
  readonly kind: "type";
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly OcamlFunctionalConstructor[];
  readonly span: FunctionalSpan;
}

export interface OcamlFunctionalConstructor {
  readonly name: string;
  readonly fields: readonly OcamlFunctionalType[];
  readonly span: FunctionalSpan;
}

export interface OcamlFunctionalDefinition {
  readonly kind: "definition";
  readonly name: string;
  readonly recursive: boolean;
  readonly parameters: readonly string[];
  readonly body: OcamlFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type OcamlFunctionalType =
  | { readonly kind: "integer"; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "parameter"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [OcamlFunctionalType, OcamlFunctionalType];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly OcamlFunctionalType[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "function";
    readonly parameter: OcamlFunctionalType;
    readonly result: OcamlFunctionalType;
    readonly span: FunctionalSpan;
  };

export type OcamlFunctionalExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "name"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [OcamlFunctionalExpression, OcamlFunctionalExpression];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "list";
    readonly values: readonly OcamlFunctionalExpression[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "list-cons";
    readonly head: OcamlFunctionalExpression;
    readonly tail: OcamlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "lambda";
    readonly parameters: readonly string[];
    readonly body: OcamlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "apply";
    readonly callee: OcamlFunctionalExpression;
    readonly argument: OcamlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly recursive: boolean;
    readonly parameters: readonly string[];
    readonly value: OcamlFunctionalExpression;
    readonly body: OcamlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: OcamlFunctionalExpression;
    readonly consequent: OcamlFunctionalExpression;
    readonly alternate: OcamlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: OcamlFunctionalBinaryOperator;
    readonly left: OcamlFunctionalExpression;
    readonly right: OcamlFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "match";
    readonly value: OcamlFunctionalExpression;
    readonly arms: readonly OcamlFunctionalMatchArm[];
    readonly span: FunctionalSpan;
  };

export interface OcamlFunctionalMatchArm {
  readonly pattern: OcamlFunctionalPattern;
  readonly body: OcamlFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type OcamlFunctionalPattern =
  | {
    readonly kind: "constructor";
    readonly constructor: string;
    readonly binders: readonly OcamlFunctionalPatternBinder[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "tuple";
    readonly binders: readonly [OcamlFunctionalPatternBinder, OcamlFunctionalPatternBinder];
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "list-nil"; readonly span: FunctionalSpan }
  | {
    readonly kind: "list-cons";
    readonly head: OcamlFunctionalPatternBinder;
    readonly tail: OcamlFunctionalPatternBinder;
    readonly span: FunctionalSpan;
  };

export interface OcamlFunctionalPatternBinder {
  readonly name: string | null;
  readonly span: FunctionalSpan;
}

export type OcamlFunctionalBinaryOperator =
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/";
