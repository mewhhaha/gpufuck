import type { FunctionalSpan } from "../functional/abi.ts";

export interface RustFunctionalProgram {
  readonly declarations: readonly RustFunctionalDeclaration[];
  readonly span: FunctionalSpan;
}

export type RustFunctionalDeclaration =
  | RustFunctionalEnumDeclaration
  | RustFunctionalStructDeclaration
  | RustFunctionalFunctionDeclaration;

export interface RustFunctionalEnumDeclaration {
  readonly kind: "enum";
  readonly name: string;
  readonly parameters: readonly string[];
  readonly variants: readonly RustFunctionalVariant[];
  readonly span: FunctionalSpan;
}

export interface RustFunctionalVariant {
  readonly name: string;
  readonly fields: readonly RustFunctionalType[];
  readonly span: FunctionalSpan;
}

export interface RustFunctionalStructDeclaration {
  readonly kind: "struct";
  readonly name: string;
  readonly parameters: readonly string[];
  readonly fields: readonly RustFunctionalField[];
  readonly span: FunctionalSpan;
}

export interface RustFunctionalField {
  readonly name: string;
  readonly type: RustFunctionalType;
  readonly span: FunctionalSpan;
}

export interface RustFunctionalFunctionDeclaration {
  readonly kind: "function";
  readonly name: string;
  readonly typeParameters: readonly string[];
  readonly parameters: readonly RustFunctionalFunctionParameter[];
  readonly result: RustFunctionalType;
  readonly body: RustFunctionalExpression;
  readonly span: FunctionalSpan;
}

export interface RustFunctionalFunctionParameter {
  readonly name: string;
  readonly type: RustFunctionalType;
  readonly span: FunctionalSpan;
}

export type RustFunctionalType =
  | { readonly kind: "integer"; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "parameter"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [RustFunctionalType, RustFunctionalType];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly RustFunctionalType[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "function";
    readonly parameter: RustFunctionalType;
    readonly result: RustFunctionalType;
    readonly span: FunctionalSpan;
  };

export type RustFunctionalExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [RustFunctionalExpression, RustFunctionalExpression];
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "name"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "borrow";
    readonly value: RustFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "call";
    readonly callee: RustFunctionalExpression;
    readonly arguments: readonly RustFunctionalExpression[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "record";
    readonly constructor: string;
    readonly fields: readonly RustFunctionalExpressionField[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly value: RustFunctionalExpression;
    readonly body: RustFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "if";
    readonly condition: RustFunctionalExpression;
    readonly consequent: RustFunctionalExpression;
    readonly alternate: RustFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: RustFunctionalBinaryOperator;
    readonly left: RustFunctionalExpression;
    readonly right: RustFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "match";
    readonly value: RustFunctionalExpression;
    readonly arms: readonly RustFunctionalMatchArm[];
    readonly span: FunctionalSpan;
  };

export interface RustFunctionalExpressionField {
  readonly name: string;
  readonly value: RustFunctionalExpression;
  readonly span: FunctionalSpan;
}

export interface RustFunctionalMatchArm {
  readonly pattern: RustFunctionalPattern;
  readonly body: RustFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type RustFunctionalPattern =
  | {
    readonly kind: "tuple";
    readonly binders: readonly [RustFunctionalPatternBinder, RustFunctionalPatternBinder];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "constructor";
    readonly constructor: string;
    readonly binders: readonly RustFunctionalPatternBinder[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "record";
    readonly constructor: string;
    readonly fields: readonly RustFunctionalPatternField[];
    readonly span: FunctionalSpan;
  };

export interface RustFunctionalPatternBinder {
  readonly name: string | null;
  readonly span: FunctionalSpan;
}

export interface RustFunctionalPatternField {
  readonly name: string;
  readonly binder: RustFunctionalPatternBinder;
  readonly span: FunctionalSpan;
}

export type RustFunctionalBinaryOperator =
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
