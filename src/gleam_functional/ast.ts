import type { Span } from "../functional/abi.ts";

export interface GleamFunctionalModule {
  readonly name: string;
  readonly imports: readonly GleamFunctionalImport[];
  readonly declarations: readonly GleamFunctionalDeclaration[];
  readonly span: Span;
}

export interface GleamFunctionalImport {
  readonly module: string;
  readonly alias: string | null;
  readonly names: readonly {
    readonly kind: "type" | "value";
    readonly name: string;
    readonly alias: string;
    readonly span: Span;
  }[];
  readonly span: Span;
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
  readonly span: Span;
}

export interface GleamFunctionalConstant {
  readonly kind: "constant";
  readonly public: boolean;
  readonly name: string;
  readonly annotation: GleamFunctionalType | null;
  readonly value: GleamFunctionalExpression;
  readonly span: Span;
}

export interface GleamFunctionalTypeDeclaration {
  readonly kind: "type";
  readonly public: boolean;
  readonly opaque: boolean;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly GleamFunctionalConstructor[];
  readonly span: Span;
}

export interface GleamFunctionalConstructor {
  readonly name: string;
  readonly fields: readonly {
    readonly label: string | null;
    readonly type: GleamFunctionalType;
    readonly span: Span;
  }[];
  readonly span: Span;
}

export type GleamFunctionalTupleValues<Value> = readonly Value[];

export interface GleamFunctionalFunction {
  readonly kind: "function";
  readonly public: boolean;
  readonly name: string;
  readonly parameters: readonly {
    readonly label: string | null;
    readonly name: string;
    readonly annotation: GleamFunctionalType | null;
    readonly span: Span;
  }[];
  readonly result: GleamFunctionalType | null;
  readonly body: GleamFunctionalExpression | null;
  readonly external: {
    readonly target: string;
    readonly module: string;
    readonly name: string;
  } | null;
  readonly span: Span;
}

export type GleamFunctionalType =
  | { readonly kind: "integer"; readonly span: Span }
  | { readonly kind: "float"; readonly span: Span }
  | { readonly kind: "boolean"; readonly span: Span }
  | { readonly kind: "unit"; readonly span: Span }
  | { readonly kind: "parameter"; readonly name: string; readonly span: Span }
  | {
    readonly kind: "tuple";
    readonly values: GleamFunctionalTupleValues<GleamFunctionalType>;
    readonly span: Span;
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly GleamFunctionalType[];
    readonly span: Span;
  }
  | {
    readonly kind: "function";
    readonly parameters: readonly GleamFunctionalType[];
    readonly result: GleamFunctionalType;
    readonly span: Span;
  };

export type GleamFunctionalExpression =
  | { readonly kind: "integer"; readonly value: number; readonly span: Span }
  | { readonly kind: "float"; readonly value: number; readonly span: Span }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: Span }
  | { readonly kind: "string"; readonly value: string; readonly span: Span }
  | {
    readonly kind: "bit-array";
    readonly bytes: Uint8Array;
    readonly bitLength: number;
    readonly span: Span;
  }
  | {
    readonly kind: "bit-array-build";
    readonly segments: readonly GleamFunctionalBitArraySegment<GleamFunctionalExpression>[];
    readonly span: Span;
  }
  | {
    readonly kind: "panic";
    readonly message: GleamFunctionalExpression | null;
    readonly span: Span;
  }
  | { readonly kind: "unit"; readonly span: Span }
  | { readonly kind: "name"; readonly name: string; readonly span: Span }
  | {
    readonly kind: "field-access";
    readonly value: GleamFunctionalExpression;
    readonly field: string;
    readonly span: Span;
  }
  | {
    readonly kind: "tuple-index";
    readonly value: GleamFunctionalExpression;
    readonly index: number;
    readonly span: Span;
  }
  | { readonly kind: "capture"; readonly span: Span }
  | {
    readonly kind: "tuple";
    readonly values: GleamFunctionalTupleValues<GleamFunctionalExpression>;
    readonly span: Span;
  }
  | {
    readonly kind: "list";
    readonly values: readonly GleamFunctionalExpression[];
    readonly tail: GleamFunctionalExpression | null;
    readonly span: Span;
  }
  | {
    readonly kind: "lambda";
    readonly parameters: readonly string[];
    readonly body: GleamFunctionalExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "call";
    readonly callee: GleamFunctionalExpression;
    readonly arguments: readonly GleamFunctionalCallArgument[];
    readonly span: Span;
  }
  | {
    readonly kind: "let";
    readonly pattern: GleamFunctionalPattern;
    readonly value: GleamFunctionalExpression;
    readonly body: GleamFunctionalExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "binary";
    readonly operator: GleamFunctionalBinaryOperator;
    readonly left: GleamFunctionalExpression;
    readonly right: GleamFunctionalExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "case";
    readonly subjects: readonly GleamFunctionalExpression[];
    readonly arms: readonly GleamFunctionalCaseArm[];
    readonly span: Span;
  };

export interface GleamFunctionalCallArgument {
  readonly label: string | null;
  readonly spread: boolean;
  readonly value: GleamFunctionalExpression;
  readonly span: Span;
}

export interface GleamFunctionalCaseArm {
  readonly patterns: readonly GleamFunctionalPattern[];
  readonly guard: GleamFunctionalExpression | null;
  readonly body: GleamFunctionalExpression;
  readonly span: Span;
}

export type GleamFunctionalPattern =
  | { readonly kind: "variable"; readonly name: string; readonly span: Span }
  | { readonly kind: "discard"; readonly span: Span }
  | {
    readonly kind: "alias";
    readonly pattern: GleamFunctionalPattern;
    readonly name: string;
    readonly span: Span;
  }
  | { readonly kind: "integer"; readonly value: number; readonly span: Span }
  | { readonly kind: "float"; readonly value: number; readonly span: Span }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: Span }
  | { readonly kind: "string"; readonly value: string; readonly span: Span }
  | {
    readonly kind: "string-prefix";
    readonly prefix: string;
    readonly rest: GleamFunctionalPattern;
    readonly span: Span;
  }
  | { readonly kind: "unit"; readonly span: Span }
  | {
    readonly kind: "bit-array";
    readonly bytes: Uint8Array;
    readonly bitLength: number;
    readonly span: Span;
  }
  | {
    readonly kind: "bit-array-segments";
    readonly segments: readonly GleamFunctionalBitArraySegment<GleamFunctionalPattern>[];
    readonly span: Span;
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly arguments: readonly GleamFunctionalPatternArgument[];
    readonly discardRemaining: boolean;
    readonly span: Span;
  }
  | {
    readonly kind: "tuple";
    readonly values: GleamFunctionalTupleValues<GleamFunctionalPattern>;
    readonly span: Span;
  }
  | { readonly kind: "list-nil"; readonly span: Span }
  | {
    readonly kind: "list-cons";
    readonly head: GleamFunctionalPattern;
    readonly tail: GleamFunctionalPattern;
    readonly span: Span;
  };

export interface GleamFunctionalBitArraySegment<Value> {
  readonly value: Value;
  readonly options: readonly {
    readonly name: string;
    readonly arguments: readonly GleamFunctionalExpression[];
    readonly span: Span;
  }[];
  readonly span: Span;
}

export interface GleamFunctionalPatternArgument {
  readonly label: string | null;
  readonly value: GleamFunctionalPattern;
  readonly span: Span;
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
