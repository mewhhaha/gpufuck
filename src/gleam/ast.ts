import type { Span } from "../functional/abi.ts";

export interface GleamModule {
  readonly name: string;
  readonly imports: readonly GleamImport[];
  readonly declarations: readonly GleamDeclaration[];
  readonly span: Span;
}

export interface GleamImport {
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

export type GleamDeclaration =
  | GleamTypeDeclaration
  | GleamTypeAlias
  | GleamConstant
  | GleamFunction;

export interface GleamTypeAlias {
  readonly kind: "type-alias";
  readonly public: boolean;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly type: GleamType;
  readonly span: Span;
}

export interface GleamConstant {
  readonly kind: "constant";
  readonly public: boolean;
  readonly name: string;
  readonly annotation: GleamType | null;
  readonly value: GleamExpression;
  readonly span: Span;
}

export interface GleamTypeDeclaration {
  readonly kind: "type";
  readonly public: boolean;
  readonly opaque: boolean;
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly GleamConstructor[];
  readonly span: Span;
}

export interface GleamConstructor {
  readonly name: string;
  readonly fields: readonly {
    readonly label: string | null;
    readonly type: GleamType;
    readonly span: Span;
  }[];
  readonly span: Span;
}

export type GleamTupleValues<Value> = readonly Value[];

export interface GleamFunction {
  readonly kind: "function";
  readonly public: boolean;
  readonly name: string;
  readonly parameters: readonly {
    readonly label: string | null;
    readonly name: string;
    readonly annotation: GleamType | null;
    readonly span: Span;
  }[];
  readonly result: GleamType | null;
  readonly body: GleamExpression | null;
  readonly external: {
    readonly target: string;
    readonly module: string;
    readonly name: string;
  } | null;
  readonly span: Span;
}

export type GleamType =
  | { readonly kind: "integer"; readonly span: Span }
  | { readonly kind: "float"; readonly span: Span }
  | { readonly kind: "boolean"; readonly span: Span }
  | { readonly kind: "unit"; readonly span: Span }
  | { readonly kind: "parameter"; readonly name: string; readonly span: Span }
  | {
    readonly kind: "tuple";
    readonly values: GleamTupleValues<GleamType>;
    readonly span: Span;
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly GleamType[];
    readonly span: Span;
  }
  | {
    readonly kind: "function";
    readonly parameters: readonly GleamType[];
    readonly result: GleamType;
    readonly span: Span;
  };

export type GleamExpression =
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
    readonly segments: readonly GleamBitArraySegment<GleamExpression>[];
    readonly span: Span;
  }
  | {
    readonly kind: "panic";
    readonly message: GleamExpression | null;
    readonly span: Span;
  }
  | { readonly kind: "unit"; readonly span: Span }
  | { readonly kind: "name"; readonly name: string; readonly span: Span }
  | {
    readonly kind: "field-access";
    readonly value: GleamExpression;
    readonly field: string;
    readonly span: Span;
  }
  | {
    readonly kind: "tuple-index";
    readonly value: GleamExpression;
    readonly index: number;
    readonly span: Span;
  }
  | { readonly kind: "capture"; readonly span: Span }
  | {
    readonly kind: "tuple";
    readonly values: GleamTupleValues<GleamExpression>;
    readonly span: Span;
  }
  | {
    readonly kind: "list";
    readonly values: readonly GleamExpression[];
    readonly tail: GleamExpression | null;
    readonly span: Span;
  }
  | {
    readonly kind: "lambda";
    readonly parameters: readonly string[];
    readonly body: GleamExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "call";
    readonly callee: GleamExpression;
    readonly arguments: readonly GleamCallArgument[];
    readonly span: Span;
  }
  | {
    readonly kind: "let";
    readonly pattern: GleamPattern;
    readonly value: GleamExpression;
    readonly body: GleamExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "binary";
    readonly operator: GleamBinaryOperator;
    readonly left: GleamExpression;
    readonly right: GleamExpression;
    readonly span: Span;
  }
  | {
    readonly kind: "case";
    readonly subjects: readonly GleamExpression[];
    readonly arms: readonly GleamCaseArm[];
    readonly span: Span;
  };

export interface GleamCallArgument {
  readonly label: string | null;
  readonly spread: boolean;
  readonly value: GleamExpression;
  readonly span: Span;
}

export interface GleamCaseArm {
  readonly patterns: readonly GleamPattern[];
  readonly guard: GleamExpression | null;
  readonly body: GleamExpression;
  readonly span: Span;
}

export type GleamPattern =
  | { readonly kind: "variable"; readonly name: string; readonly span: Span }
  | { readonly kind: "discard"; readonly span: Span }
  | {
    readonly kind: "alias";
    readonly pattern: GleamPattern;
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
    readonly rest: GleamPattern;
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
    readonly segments: readonly GleamBitArraySegment<GleamPattern>[];
    readonly span: Span;
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly arguments: readonly GleamPatternArgument[];
    readonly discardRemaining: boolean;
    readonly span: Span;
  }
  | {
    readonly kind: "tuple";
    readonly values: GleamTupleValues<GleamPattern>;
    readonly span: Span;
  }
  | { readonly kind: "list-nil"; readonly span: Span }
  | {
    readonly kind: "list-cons";
    readonly head: GleamPattern;
    readonly tail: GleamPattern;
    readonly span: Span;
  };

export interface GleamBitArraySegment<Value> {
  readonly value: Value;
  readonly options: readonly {
    readonly name: string;
    readonly arguments: readonly GleamExpression[];
    readonly span: Span;
  }[];
  readonly span: Span;
}

export interface GleamPatternArgument {
  readonly label: string | null;
  readonly value: GleamPattern;
  readonly span: Span;
}

export type GleamBinaryOperator =
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
