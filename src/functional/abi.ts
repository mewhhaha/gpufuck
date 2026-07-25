import {
  type EncodedLazuliDefinitionType,
  type EncodedLazuliTypeDeclaration,
  LAZULI_ABI_VERSION,
  LAZULI_CONSTRUCTOR_BYTE_LENGTH,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_BYTE_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_MAXIMUM_CONSTRUCTOR_ARITY,
  LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH,
  LAZULI_MAXIMUM_SURFACE_NODES,
  LAZULI_NO_INDEX,
  LAZULI_NODE_BYTE_LENGTH,
  LAZULI_NODE_WORD_LENGTH,
  LAZULI_TYPE_BYTE_LENGTH,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliBinaryOperator,
  LazuliConstructorWord,
  LazuliCoreTag,
  LazuliDefinitionWord,
  type LazuliDiagnosticCode,
  LazuliEvaluationMode,
  LazuliNumericConversion,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
  LazuliTypeWord,
  LazuliUnaryOperator,
} from "../semantic/abi.ts";
import type { HostCapabilityDeclaration, HostDefinitionBinding } from "./host_contract.ts";
import type { SourceRange, WasmExportDeclaration } from "./module_contract.ts";
import type { EvaluationProfile, Span, TypecheckingProfile } from "./schema_contract.ts";

export { type SourceRange, type WasmExportDeclaration } from "./module_contract.ts";
export {
  type SourceType,
  type Span,
  type Type,
  type TypeDeclaration,
  type TypeSchema,
} from "./schema_contract.ts";

export const MODULE_ABI_VERSION = LAZULI_ABI_VERSION;
export const NO_INDEX = LAZULI_NO_INDEX;
export const MAXIMUM_SOURCE_BYTE_LENGTH = LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH;
export const MAXIMUM_EXPRESSION_NODES = LAZULI_MAXIMUM_SURFACE_NODES;
export const MAXIMUM_CONSTRUCTOR_ARITY = LAZULI_MAXIMUM_CONSTRUCTOR_ARITY;
export const UNIT_CONSTRUCTOR_NAME = "$Unit";
export const PAIR_CONSTRUCTOR_NAME = "$Tuple";
export const THUNK_TYPE_NAME = "$ThunkType";
export const THUNK_CONSTRUCTOR_NAME = "$Thunk";

export const NODE_WORD_LENGTH = LAZULI_NODE_WORD_LENGTH;
export const NODE_BYTE_LENGTH = LAZULI_NODE_BYTE_LENGTH;
export const DEFINITION_WORD_LENGTH = LAZULI_DEFINITION_WORD_LENGTH;
export const DEFINITION_BYTE_LENGTH = LAZULI_DEFINITION_BYTE_LENGTH;
export const TYPE_WORD_LENGTH = LAZULI_TYPE_WORD_LENGTH;
export const TYPE_BYTE_LENGTH = LAZULI_TYPE_BYTE_LENGTH;
export const CONSTRUCTOR_WORD_LENGTH = LAZULI_CONSTRUCTOR_WORD_LENGTH;
export const CONSTRUCTOR_BYTE_LENGTH = LAZULI_CONSTRUCTOR_BYTE_LENGTH;

export const NodeWord = LazuliSurfaceWord;
export const DefinitionWord = LazuliDefinitionWord;
export const AlgebraicTypeWord = LazuliTypeWord;
export const ConstructorWord = LazuliConstructorWord;
export const ExpressionTag = LazuliSurfaceTag;
export const CoreTag = LazuliCoreTag;
export const UnaryOperator = LazuliUnaryOperator;
export const BinaryOperator = LazuliBinaryOperator;
export const EvaluationMode = LazuliEvaluationMode;
export const NumericConversion = LazuliNumericConversion;

export type ExpressionTag = (typeof ExpressionTag)[keyof typeof ExpressionTag];
export type CoreTag = (typeof CoreTag)[keyof typeof CoreTag];
export type UnaryOperator = (typeof UnaryOperator)[keyof typeof UnaryOperator];
export type BinaryOperator = (typeof BinaryOperator)[keyof typeof BinaryOperator];
export type EvaluationMode = (typeof EvaluationMode)[keyof typeof EvaluationMode];
export type NumericConversion = (typeof NumericConversion)[keyof typeof NumericConversion];

export { EvaluationProfile, TypecheckingProfile } from "./schema_contract.ts";

export const PrimitiveCapability = {
  SignedInteger32: "signed-integer-i32",
  SignedInteger64: "signed-integer-i64",
  Float32: "float-f32",
  Float64: "float-f64",
  WholeNumberF64: "whole-number-f64",
  Boolean: "boolean",
  Unit: "unit",
  Pair: "pair",
  Function: "function",
  AlgebraicData: "algebraic-data",
  StaticText: "static-text",
  StaticBytes: "static-bytes",
  ExplicitFault: "explicit-fault",
  StructuralEquality: "structural-equality",
  BufferAppend: "buffer-append",
  Store: "store",
} as const;

export type PrimitiveCapability = (typeof PrimitiveCapability)[keyof typeof PrimitiveCapability];

export const CORE_V1_PRIMITIVE_CAPABILITIES: readonly PrimitiveCapability[] = Object.freeze(
  [
    PrimitiveCapability.SignedInteger32,
    PrimitiveCapability.SignedInteger64,
    PrimitiveCapability.Float32,
    PrimitiveCapability.Float64,
    PrimitiveCapability.WholeNumberF64,
    PrimitiveCapability.Boolean,
    PrimitiveCapability.Unit,
    PrimitiveCapability.Pair,
    PrimitiveCapability.Function,
    PrimitiveCapability.AlgebraicData,
    PrimitiveCapability.StaticText,
    PrimitiveCapability.StaticBytes,
    PrimitiveCapability.ExplicitFault,
    PrimitiveCapability.StructuralEquality,
    PrimitiveCapability.BufferAppend,
    PrimitiveCapability.Store,
  ] as const,
);

export type EncodedFunctionalDefinitionType = EncodedLazuliDefinitionType;
export type EncodedFunctionalTypeDeclaration = EncodedLazuliTypeDeclaration;

type DiagnosticCodeOf<Code extends string> = Code extends `L${infer Suffix}` ? `F${Suffix}`
  : never;

export type DiagnosticCode = DiagnosticCodeOf<LazuliDiagnosticCode>;

export interface RelatedDiagnostic {
  readonly message: string;
  readonly span: Span;
}

export interface Diagnostic {
  readonly stage: "compile";
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly span: Span;
  readonly related?: readonly RelatedDiagnostic[];
}

export interface EncodedFunctionalModule {
  readonly abiVersion: number;
  readonly sourceByteLength: number;
  readonly evaluationProfile: EvaluationProfile;
  readonly typecheckingProfile: TypecheckingProfile;
  readonly primitiveCapabilities: readonly PrimitiveCapability[];
  readonly hostCapabilities?: readonly HostCapabilityDeclaration[];
  readonly hostDefinitions?: readonly HostDefinitionBinding[];
  readonly wasmExports?: readonly WasmExportDeclaration[];
  readonly sources?: readonly SourceRange[];
  readonly nodeWords: Uint32Array;
  readonly definitionWords: Uint32Array;
  readonly typeWords: Uint32Array;
  readonly constructorWords: Uint32Array;
  readonly nodeCount: number;
  readonly definitionCount: number;
  readonly typeCount: number;
  readonly constructorCount: number;
  readonly entrySymbol: number;
  readonly symbolNames: readonly string[];
  readonly definitionTypes: readonly EncodedFunctionalDefinitionType[];
  readonly typeDeclarations: readonly EncodedFunctionalTypeDeclaration[];
}
