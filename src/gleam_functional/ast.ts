import type { FunctionalSpan } from "../functional/abi.ts";

export interface GleamFunctionalModule {
  readonly name: string;
  readonly imports: readonly GleamFunctionalImport[];
  readonly declarations: readonly GleamFunctionalDeclaration[];
  readonly span: FunctionalSpan;
}

export interface GleamFunctionalImport {
  readonly module: string;
  readonly alias: string | null;
  readonly names: readonly {
    readonly kind: "type" | "value";
    readonly name: string;
    readonly alias: string;
    readonly span: FunctionalSpan;
  }[];
  readonly span: FunctionalSpan;
}

export type GleamFunctionalDeclaration =
  | GleamFunctionalTypeDeclaration
  | GleamFunctionalTypeAlias
  | GleamFunctionalConstant
  | GleamFunctionalFunction;

export interface GleamFunctionalTypeAlias {
  readonly kind: "type-alias";
  readonly public: boolean;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly type: GleamFunctionalType;
  readonly span: FunctionalSpan;
}

export interface GleamFunctionalConstant {
  readonly kind: "constant";
  readonly public: boolean;
  readonly name: string;
  readonly annotation: GleamFunctionalType | null;
  readonly value: GleamFunctionalExpression;
  readonly span: FunctionalSpan;
}

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
    readonly label: string | null;
    readonly name: string;
    readonly annotation: GleamFunctionalType | null;
    readonly span: FunctionalSpan;
  }[];
  readonly result: GleamFunctionalType | null;
  readonly body: GleamFunctionalExpression | null;
  readonly external: {
    readonly target: string;
    readonly module: string;
    readonly name: string;
  } | null;
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
    readonly values: readonly [GleamFunctionalType, GleamFunctionalType, ...GleamFunctionalType[]];
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
  | { readonly kind: "string"; readonly value: string; readonly span: FunctionalSpan }
  | { readonly kind: "bit-array"; readonly bytes: Uint8Array; readonly span: FunctionalSpan }
  | {
    readonly kind: "bit-array-build";
    readonly segments: readonly GleamFunctionalBitArraySegment<GleamFunctionalExpression>[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "panic";
    readonly message: GleamFunctionalExpression | null;
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "name"; readonly name: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "field-access";
    readonly value: GleamFunctionalExpression;
    readonly field: string;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "tuple-index";
    readonly value: GleamFunctionalExpression;
    readonly index: number;
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "capture"; readonly span: FunctionalSpan }
  | {
    readonly kind: "tuple";
    readonly values: readonly [
      GleamFunctionalExpression,
      GleamFunctionalExpression,
      ...GleamFunctionalExpression[],
    ];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "list";
    readonly values: readonly GleamFunctionalExpression[];
    readonly tail: GleamFunctionalExpression | null;
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
    readonly arguments: readonly GleamFunctionalCallArgument[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "let";
    readonly pattern: GleamFunctionalPattern;
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

export interface GleamFunctionalCallArgument {
  readonly label: string | null;
  readonly spread: boolean;
  readonly value: GleamFunctionalExpression;
  readonly span: FunctionalSpan;
}

export interface GleamFunctionalCaseArm {
  readonly patterns: readonly GleamFunctionalPattern[];
  readonly guard: GleamFunctionalExpression | null;
  readonly body: GleamFunctionalExpression;
  readonly span: FunctionalSpan;
}

export type GleamFunctionalPattern =
  | { readonly kind: "variable"; readonly name: string; readonly span: FunctionalSpan }
  | { readonly kind: "discard"; readonly span: FunctionalSpan }
  | {
    readonly kind: "alias";
    readonly pattern: GleamFunctionalPattern;
    readonly name: string;
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "integer"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "float"; readonly value: number; readonly span: FunctionalSpan }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: FunctionalSpan }
  | { readonly kind: "string"; readonly value: string; readonly span: FunctionalSpan }
  | {
    readonly kind: "string-prefix";
    readonly prefix: string;
    readonly rest: GleamFunctionalPattern;
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "unit"; readonly span: FunctionalSpan }
  | { readonly kind: "bit-array"; readonly bytes: Uint8Array; readonly span: FunctionalSpan }
  | {
    readonly kind: "bit-array-segments";
    readonly segments: readonly GleamFunctionalBitArraySegment<GleamFunctionalPattern>[];
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly arguments: readonly GleamFunctionalPatternArgument[];
    readonly discardRemaining: boolean;
    readonly span: FunctionalSpan;
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [
      GleamFunctionalPattern,
      GleamFunctionalPattern,
      ...GleamFunctionalPattern[],
    ];
    readonly span: FunctionalSpan;
  }
  | { readonly kind: "list-nil"; readonly span: FunctionalSpan }
  | {
    readonly kind: "list-cons";
    readonly head: GleamFunctionalPattern;
    readonly tail: GleamFunctionalPattern;
    readonly span: FunctionalSpan;
  };

export interface GleamFunctionalBitArraySegment<Value> {
  readonly value: Value;
  readonly options: readonly {
    readonly name: string;
    readonly arguments: readonly GleamFunctionalExpression[];
    readonly span: FunctionalSpan;
  }[];
  readonly span: FunctionalSpan;
}

export interface GleamFunctionalPatternArgument {
  readonly label: string | null;
  readonly value: GleamFunctionalPattern;
  readonly span: FunctionalSpan;
}

export type GleamFunctionalBinaryOperator =
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "<."
  | "<=."
  | ">."
  | ">=."
  | "+"
  | "-"
  | "*"
  | "/"
  | "+."
  | "-."
  | "*."
  | "/."
  | "%"
  | "<>"
  | "&&"
  | "||";
