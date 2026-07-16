export const LAZULI_ABI_VERSION = 5;
export const LAZULI_NO_INDEX = 0xffffffff;
export const LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH = 1024 * 1024;
export const LAZULI_MAXIMUM_SURFACE_NODES = 65_536;
export const LAZULI_MAXIMUM_PARSE_DEPTH = 512;
export const LAZULI_MAXIMUM_CONSTRUCTOR_ARITY = 64;

export const LAZULI_NODE_WORD_LENGTH = 8;
export const LAZULI_NODE_BYTE_LENGTH = LAZULI_NODE_WORD_LENGTH * Uint32Array.BYTES_PER_ELEMENT;
export const LAZULI_DEFINITION_WORD_LENGTH = 4;
export const LAZULI_DEFINITION_BYTE_LENGTH = LAZULI_DEFINITION_WORD_LENGTH *
  Uint32Array.BYTES_PER_ELEMENT;
export const LAZULI_TYPE_WORD_LENGTH = 5;
export const LAZULI_TYPE_BYTE_LENGTH = LAZULI_TYPE_WORD_LENGTH * Uint32Array.BYTES_PER_ELEMENT;
export const LAZULI_CONSTRUCTOR_WORD_LENGTH = 5;
export const LAZULI_CONSTRUCTOR_BYTE_LENGTH = LAZULI_CONSTRUCTOR_WORD_LENGTH *
  Uint32Array.BYTES_PER_ELEMENT;

export const LazuliSurfaceWord = {
  Tag: 0,
  StartByte: 1,
  EndByte: 2,
  Payload: 3,
  Child0: 4,
  Child1: 5,
  Child2: 6,
  Parent: 7,
} as const;

export const LazuliDefinitionWord = {
  Symbol: 0,
  RootNode: 1,
  StartByte: 2,
  EndByte: 3,
} as const;

export const LazuliTypeWord = {
  Symbol: 0,
  FirstConstructor: 1,
  ConstructorCount: 2,
  StartByte: 3,
  EndByte: 4,
} as const;

export const LazuliConstructorWord = {
  Symbol: 0,
  Type: 1,
  Arity: 2,
  StartByte: 3,
  EndByte: 4,
} as const;

export const LazuliSurfaceTag = {
  Integer: 1,
  Boolean: 2,
  Name: 3,
  Let: 4,
  If: 5,
  Lambda: 6,
  Apply: 7,
  Unary: 8,
  Binary: 9,
  Case: 10,
  CaseArm: 11,
  PatternBind: 12,
  LetRec: 16,
} as const;

export type LazuliSurfaceTag = (typeof LazuliSurfaceTag)[keyof typeof LazuliSurfaceTag];

export const LazuliCoreTag = {
  Integer: LazuliSurfaceTag.Integer,
  Boolean: LazuliSurfaceTag.Boolean,
  Let: LazuliSurfaceTag.Let,
  If: LazuliSurfaceTag.If,
  Lambda: LazuliSurfaceTag.Lambda,
  Apply: LazuliSurfaceTag.Apply,
  Unary: LazuliSurfaceTag.Unary,
  Binary: LazuliSurfaceTag.Binary,
  Case: LazuliSurfaceTag.Case,
  CaseArm: LazuliSurfaceTag.CaseArm,
  PatternBind: LazuliSurfaceTag.PatternBind,
  Local: 13,
  Global: 14,
  Constructor: 15,
  LetRec: LazuliSurfaceTag.LetRec,
} as const;

export type LazuliCoreTag = (typeof LazuliCoreTag)[keyof typeof LazuliCoreTag];

export const LazuliUnaryOperator = {
  Negate: 1,
} as const;

export type LazuliUnaryOperator = (typeof LazuliUnaryOperator)[keyof typeof LazuliUnaryOperator];

export const LazuliBinaryOperator = {
  Equal: 1,
  NotEqual: 2,
  Less: 3,
  LessEqual: 4,
  Greater: 5,
  GreaterEqual: 6,
  Add: 7,
  Subtract: 8,
  Multiply: 9,
  Divide: 10,
} as const;

export type LazuliBinaryOperator = (typeof LazuliBinaryOperator)[keyof typeof LazuliBinaryOperator];

export interface LazuliSpan {
  readonly startByte: number;
  readonly endByte: number;
}

export type LazuliDiagnosticCode =
  | "L1001"
  | "L1002"
  | "L1003"
  | "L2001"
  | "L2002"
  | "L2003"
  | "L2004"
  | "L2005"
  | "L2006"
  | "L2007"
  | "L2008"
  | "L2009"
  | "L2010"
  | "L2101"
  | "L2102"
  | "L2103"
  | "L2104";

export type LazuliType =
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | { readonly kind: "tuple"; readonly values: readonly [LazuliType, LazuliType] }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly LazuliType[];
  }
  | { readonly kind: "function"; readonly parameter: LazuliType; readonly result: LazuliType };

export type LazuliTypeSchema =
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | { readonly kind: "parameter"; readonly name: string }
  | {
    readonly kind: "tuple";
    readonly values: readonly [LazuliTypeSchema, LazuliTypeSchema];
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly LazuliTypeSchema[];
  }
  | {
    readonly kind: "function";
    readonly parameter: LazuliTypeSchema;
    readonly result: LazuliTypeSchema;
  }
  | {
    readonly kind: "forall";
    readonly parameters: readonly string[];
    readonly body: LazuliTypeSchema;
  };

export interface LazuliConstructorFieldDeclaration {
  readonly name: string;
  readonly type: LazuliTypeSchema;
}

export interface LazuliConstructorDeclaration {
  readonly name: string;
  readonly fields: readonly LazuliConstructorFieldDeclaration[];
  readonly result?: LazuliTypeSchema;
}

export interface LazuliTypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly LazuliConstructorDeclaration[];
}

export type LazuliSourceType = LazuliTypeSchema & LazuliSpan;

export interface EncodedLazuliDefinitionType {
  readonly annotation: LazuliSourceType | null;
}

export interface EncodedLazuliTypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly {
    readonly name: string;
    readonly fields: readonly {
      readonly name: string;
      readonly type: LazuliSourceType;
    }[];
    readonly result?: LazuliSourceType;
  }[];
}

export interface LazuliDiagnostic {
  readonly stage: "parse" | "compile";
  readonly code: LazuliDiagnosticCode;
  readonly message: string;
  readonly span: LazuliSpan;
}

export interface EncodedLazuliSurface {
  readonly nodeWords: Uint32Array;
  readonly definitionWords: Uint32Array;
  readonly typeWords: Uint32Array;
  readonly constructorWords: Uint32Array;
  readonly nodeCount: number;
  readonly definitionCount: number;
  readonly typeCount: number;
  readonly constructorCount: number;
  readonly mainSymbol: number;
  readonly symbolNames: readonly string[];
  readonly definitionTypes: readonly EncodedLazuliDefinitionType[];
  readonly typeDeclarations: readonly EncodedLazuliTypeDeclaration[];
}

export type LazuliFrontendResult =
  | { readonly ok: true; readonly surface: EncodedLazuliSurface }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [LazuliDiagnostic, ...LazuliDiagnostic[]];
  };
