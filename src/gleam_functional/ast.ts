import type { FunctionalSpan } from "../functional/abi.ts";

export interface GleamFunctionalModule {
  readonly name: string;
  readonly imports: readonly GleamFunctionalImport[];
  readonly declarations: readonly GleamFunctionalDeclaration[];
  readonly span: FunctionalSpan;
}

export interface GleamFunctionalImport {
  readonly module: string;
  readonly names: readonly {
    readonly name: string;
    readonly alias: string;
    readonly span: FunctionalSpan;
  }[];
  readonly span: FunctionalSpan;
}

export type GleamFunctionalDeclaration =
  | GleamFunctionalTypeDeclaration
  | GleamFunctionalFunction;

export interface GleamFunctionalTypeDeclaration {
  readonly kind: "type";
  readonly public: boolean;
  readonly opaque: boolean;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly GleamFunctionalConstructor[];
  readonly span: FunctionalSpan;
}

export interface GleamFunctionalConstructor {
  readonly name: string;
  readonly fields: readonly {
    readonly label: string | null;
    readonly type: GleamFunctionalType;
    readonly span: FunctionalSpan;
  }[];
  readonly span: FunctionalSpan;
}

export interface GleamFunctionalFunction {
  readonly kind: "function";
  readonly public: boolean;
  readonly name: string;
  readonly parameters: readonly {
    readonly name: string;
    readonly annotation: GleamFunctionalType | null;
    readonly span: FunctionalSpan;
  }[];
  readonly result: GleamFunctionalType | null;
  readonly body: GleamFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type GleamFunctionalType =
  | { readonly kind: "integer"; readonly span: FunctionalSpan }
  | { readonly kind: "float"; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "parameter"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [GleamFunctionalType, GleamFunctionalType];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly GleamFunctionalType[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "function";
    readonly parameters: readonly GleamFunctionalType[];
    readonly result: GleamFunctionalType;
    readonly span: FunctionalSpan;
  };

export type GleamFunctionalExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "float"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "name"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [GleamFunctionalExpression, GleamFunctionalExpression];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "list";
    readonly values: readonly GleamFunctionalExpression[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "lambda";
    readonly parameters: readonly string[];
    readonly body: GleamFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "call";
    readonly callee: GleamFunctionalExpression;
    readonly arguments: readonly GleamFunctionalExpression[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "let";
    readonly name: string;
    readonly value: GleamFunctionalExpression;
    readonly body: GleamFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "binary";
    readonly operator: GleamFunctionalBinaryOperator;
    readonly left: GleamFunctionalExpression;
    readonly right: GleamFunctionalExpression;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "case";
    readonly subjects: readonly GleamFunctionalExpression[];
    readonly arms: readonly GleamFunctionalCaseArm[];
    readonly span: FunctionalSpan;
  };

export interface GleamFunctionalCaseArm {
  readonly patterns: readonly GleamFunctionalPattern[];
  readonly body: GleamFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type GleamFunctionalPattern =
  | { readonly kind: "variable"; readonly name: string; readonly span: FunctionalSpan }
  | { readonly kind: "discard"; readonly span: FunctionalSpan }
  | { readonly kind: "integer"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: FunctionalSpan }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly arguments: readonly GleamFunctionalPattern[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [GleamFunctionalPattern, GleamFunctionalPattern];
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "list-nil"; readonly span: FunctionalSpan }
  | {
    readonly kind: "list-cons";
    readonly head: GleamFunctionalPattern;
    readonly tail: GleamFunctionalPattern;
    readonly span: FunctionalSpan;
  };

export type GleamFunctionalBinaryOperator =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "&&"
  | "||";
