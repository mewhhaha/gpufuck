export const MODULE_ABI_VERSION = 7;
export const NO_INDEX = 0xffffffff;
export const UNKNOWN_CONSTRUCTOR_FLAG = 0x80000000;
export const MAXIMUM_SOURCE_BYTE_LENGTH = 1024 * 1024;
export const MAXIMUM_EXPRESSION_NODES = 65_536;
export const MAXIMUM_PARSE_DEPTH = 512;
export const MAXIMUM_CONSTRUCTOR_ARITY = 256;

export const NODE_WORD_LENGTH = 8;
export const NODE_BYTE_LENGTH = NODE_WORD_LENGTH * Uint32Array.BYTES_PER_ELEMENT;
export const DEFINITION_WORD_LENGTH = 4;
export const DEFINITION_BYTE_LENGTH = DEFINITION_WORD_LENGTH *
  Uint32Array.BYTES_PER_ELEMENT;
export const TYPE_WORD_LENGTH = 5;
export const TYPE_BYTE_LENGTH = TYPE_WORD_LENGTH * Uint32Array.BYTES_PER_ELEMENT;
export const CONSTRUCTOR_WORD_LENGTH = 5;
export const CONSTRUCTOR_BYTE_LENGTH = CONSTRUCTOR_WORD_LENGTH *
  Uint32Array.BYTES_PER_ELEMENT;
export const ARGUMENT_WORD_LENGTH = 2;
export const CASE_ALTERNATIVE_WORD_LENGTH = 6;

export const NodeWord = {
  Tag: 0,
  StartByte: 1,
  EndByte: 2,
  Payload: 3,
  Child0: 4,
  Child1: 5,
  Child2: 6,
  Parent: 7,
} as const;

export const DefinitionWord = {
  Symbol: 0,
  RootNode: 1,
  StartByte: 2,
  EndByte: 3,
} as const;

export const AlgebraicTypeWord = {
  Symbol: 0,
  FirstConstructor: 1,
  ConstructorCount: 2,
  StartByte: 3,
  EndByte: 4,
} as const;

export const ConstructorWord = {
  Symbol: 0,
  Type: 1,
  Arity: 2,
  StartByte: 3,
  EndByte: 4,
} as const;

export const ArgumentWord = {
  Node: 0,
  EvaluationMode: 1,
} as const;

export const CaseAlternativeWord = {
  Constructor: 0,
  FirstBinder: 1,
  BinderCount: 2,
  Body: 3,
  StartByte: 4,
  EndByte: 5,
} as const;

export const ExpressionTag = {
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
  StrictLet: 17,
  StrictApply: 18,
  SignedInteger64: 19,
  Float32: 20,
  Float64: 21,
  NumericConvert: 22,
  Text: 23,
  Bytes: 24,
  RuntimeFault: 25,
  WholeNumberF64: 26,
  BufferAppend: 27,
  StoreNew: 28,
  StoreLength: 29,
  StoreRead: 30,
  StoreWrite: 31,
  StoreGrow: 32,
  StoreEmpty: 33,
  Prim: 34,
} as const;

export type ExpressionTag = (typeof ExpressionTag)[keyof typeof ExpressionTag];

export const CoreTag = {
  Integer: ExpressionTag.Integer,
  Boolean: ExpressionTag.Boolean,
  Let: ExpressionTag.Let,
  If: ExpressionTag.If,
  Lambda: ExpressionTag.Lambda,
  Apply: ExpressionTag.Apply,
  Unary: ExpressionTag.Unary,
  Binary: ExpressionTag.Binary,
  Case: ExpressionTag.Case,
  CaseArm: ExpressionTag.CaseArm,
  PatternBind: ExpressionTag.PatternBind,
  Local: 13,
  Global: 14,
  Constructor: 15,
  LetRec: ExpressionTag.LetRec,
  SignedInteger64: ExpressionTag.SignedInteger64,
  Float32: ExpressionTag.Float32,
  Float64: ExpressionTag.Float64,
  NumericConvert: ExpressionTag.NumericConvert,
  Text: ExpressionTag.Text,
  Bytes: ExpressionTag.Bytes,
  RuntimeFault: ExpressionTag.RuntimeFault,
  WholeNumberF64: ExpressionTag.WholeNumberF64,
  BufferAppend: ExpressionTag.BufferAppend,
  StoreNew: ExpressionTag.StoreNew,
  StoreLength: ExpressionTag.StoreLength,
  StoreRead: ExpressionTag.StoreRead,
  StoreWrite: ExpressionTag.StoreWrite,
  StoreGrow: ExpressionTag.StoreGrow,
  StoreEmpty: ExpressionTag.StoreEmpty,
  Prim: ExpressionTag.Prim,
} as const;

export type CoreTag = (typeof CoreTag)[keyof typeof CoreTag];

export const EvaluationMode = {
  LazyCallByNeed: 0,
  StrictEager: 1,
} as const;

export type EvaluationMode = (typeof EvaluationMode)[keyof typeof EvaluationMode];

export const UnaryOperator = {
  Negate: 1,
  NegateSignedInteger64: 2,
  NegateFloat32: 3,
  NegateFloat64: 4,
  SquareRootFloat32: 5,
  NegateWholeNumberF64: 6,
} as const;

export type UnaryOperator = (typeof UnaryOperator)[keyof typeof UnaryOperator];

export const BinaryOperator = {
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
  EqualSignedInteger64: 11,
  NotEqualSignedInteger64: 12,
  LessSignedInteger64: 13,
  LessEqualSignedInteger64: 14,
  GreaterSignedInteger64: 15,
  GreaterEqualSignedInteger64: 16,
  AddSignedInteger64: 17,
  SubtractSignedInteger64: 18,
  MultiplySignedInteger64: 19,
  DivideSignedInteger64: 20,
  EqualFloat32: 21,
  NotEqualFloat32: 22,
  LessFloat32: 23,
  LessEqualFloat32: 24,
  GreaterFloat32: 25,
  GreaterEqualFloat32: 26,
  AddFloat32: 27,
  SubtractFloat32: 28,
  MultiplyFloat32: 29,
  DivideFloat32: 30,
  EqualFloat64: 31,
  NotEqualFloat64: 32,
  LessFloat64: 33,
  LessEqualFloat64: 34,
  GreaterFloat64: 35,
  GreaterEqualFloat64: 36,
  AddFloat64: 37,
  SubtractFloat64: 38,
  MultiplyFloat64: 39,
  DivideFloat64: 40,
  Remainder: 41,
  BitwiseAnd: 42,
  BitwiseOr: 43,
  BitwiseXor: 44,
  ShiftLeft: 45,
  ShiftRightUnsigned: 46,
  RemainderSignedInteger64: 47,
  BitwiseAndSignedInteger64: 48,
  BitwiseOrSignedInteger64: 49,
  BitwiseXorSignedInteger64: 50,
  ShiftLeftSignedInteger64: 51,
  ShiftRightUnsignedSignedInteger64: 52,
  StructuralEqual: 53,
  StructuralNotEqual: 54,
  EqualWholeNumberF64: 55,
  NotEqualWholeNumberF64: 56,
  LessWholeNumberF64: 57,
  LessEqualWholeNumberF64: 58,
  GreaterWholeNumberF64: 59,
  GreaterEqualWholeNumberF64: 60,
  AddWholeNumberF64: 61,
  SubtractWholeNumberF64: 62,
  MultiplyWholeNumberF64: 63,
  DivideWholeNumberF64: 64,
  RemainderWholeNumberF64: 65,
  RemainderFloat64: 66,
} as const;

export type BinaryOperator = (typeof BinaryOperator)[keyof typeof BinaryOperator];

export const NumericConversion = {
  SignedInteger32ToSignedInteger64: 1,
  SignedInteger64ToSignedInteger32: 2,
  SignedInteger32ToFloat32: 3,
  SignedInteger32ToFloat64: 4,
  SignedInteger64ToFloat32: 5,
  SignedInteger64ToFloat64: 6,
  Float32ToSignedInteger32: 7,
  Float32ToSignedInteger64: 8,
  Float32ToFloat64: 9,
  Float64ToSignedInteger32: 10,
  Float64ToSignedInteger64: 11,
  Float64ToFloat32: 12,
  ReinterpretFloat32AsSignedInteger32: 13,
  ReinterpretSignedInteger32AsFloat32: 14,
} as const;

export type NumericConversion = (typeof NumericConversion)[keyof typeof NumericConversion];

export interface Span {
  readonly startByte: number;
  readonly endByte: number;
}

export type SemanticDiagnosticCode =
  | "F1001"
  | "F1002"
  | "F1003"
  | "F2001"
  | "F2002"
  | "F2003"
  | "F2004"
  | "F2005"
  | "F2006"
  | "F2007"
  | "F2008"
  | "F2009"
  | "F2010"
  | "F2101"
  | "F2102"
  | "F2103"
  | "F2104";

export type Type =
  | { readonly kind: "integer" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | { readonly kind: "tuple"; readonly values: readonly [Type, Type] }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly Type[];
  }
  | { readonly kind: "function"; readonly parameter: Type; readonly result: Type };

export type TypeSchema =
  | { readonly kind: "integer" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" }
  | { readonly kind: "parameter"; readonly name: string }
  | {
    readonly kind: "tuple";
    readonly values: readonly [TypeSchema, TypeSchema];
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly TypeSchema[];
  }
  | {
    readonly kind: "function";
    readonly parameter: TypeSchema;
    readonly result: TypeSchema;
  }
  | {
    readonly kind: "forall";
    readonly parameters: readonly string[];
    readonly body: TypeSchema;
  };

export interface ConstructorFieldDeclaration {
  readonly name: string;
  readonly type: TypeSchema;
}

export interface ConstructorDeclaration {
  readonly name: string;
  readonly fields: readonly ConstructorFieldDeclaration[];
  readonly result?: TypeSchema;
}

export interface TypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly ConstructorDeclaration[];
}

export type SourceType = TypeSchema & Span;

export interface EncodedDefinitionType {
  readonly annotation: SourceType | null;
}

export interface EncodedTypeDeclaration {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly constructors: readonly {
    readonly name: string;
    readonly fields: readonly {
      readonly name: string;
      readonly type: SourceType;
    }[];
    readonly result?: SourceType;
  }[];
}

export interface SemanticDiagnostic {
  readonly stage: "parse" | "compile";
  readonly code: SemanticDiagnosticCode;
  readonly message: string;
  readonly span: Span;
  readonly related?: readonly {
    readonly message: string;
    readonly span: Span;
  }[];
}

export interface EncodedSemanticSurface {
  readonly nodeWords: Uint32Array;
  readonly parameterWords: Uint32Array;
  readonly argumentWords: Uint32Array;
  readonly caseAlternativeWords: Uint32Array;
  readonly caseBinderWords: Uint32Array;
  readonly definitionWords: Uint32Array;
  readonly typeWords: Uint32Array;
  readonly constructorWords: Uint32Array;
  readonly nodeCount: number;
  readonly argumentCount: number;
  readonly caseAlternativeCount: number;
  readonly definitionCount: number;
  readonly typeCount: number;
  readonly constructorCount: number;
  readonly entrySymbol: number;
  readonly symbolNames: readonly string[];
  readonly definitionTypes: readonly EncodedDefinitionType[];
  readonly typeDeclarations: readonly EncodedTypeDeclaration[];
}

export type FrontendResult =
  | { readonly ok: true; readonly surface: EncodedSemanticSurface }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [SemanticDiagnostic, ...SemanticDiagnostic[]];
  };
