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
  type LazuliSourceType,
  type LazuliSpan,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
  type LazuliType,
  type LazuliTypeDeclaration,
  type LazuliTypeSchema,
  LazuliTypeWord,
  LazuliUnaryOperator,
} from "../lazuli/abi.ts";
import type { FunctionalHostCapabilityDeclaration } from "./host_contract.ts";

export const FUNCTIONAL_MODULE_ABI_VERSION = LAZULI_ABI_VERSION;
export const FUNCTIONAL_NO_INDEX = LAZULI_NO_INDEX;
export const FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH = LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH;
export const FUNCTIONAL_MAXIMUM_EXPRESSION_NODES = LAZULI_MAXIMUM_SURFACE_NODES;
export const FUNCTIONAL_MAXIMUM_CONSTRUCTOR_ARITY = LAZULI_MAXIMUM_CONSTRUCTOR_ARITY;
export const FUNCTIONAL_UNIT_CONSTRUCTOR_NAME = "$Unit";
export const FUNCTIONAL_PAIR_CONSTRUCTOR_NAME = "$Tuple";

export const FUNCTIONAL_NODE_WORD_LENGTH = LAZULI_NODE_WORD_LENGTH;
export const FUNCTIONAL_NODE_BYTE_LENGTH = LAZULI_NODE_BYTE_LENGTH;
export const FUNCTIONAL_DEFINITION_WORD_LENGTH = LAZULI_DEFINITION_WORD_LENGTH;
export const FUNCTIONAL_DEFINITION_BYTE_LENGTH = LAZULI_DEFINITION_BYTE_LENGTH;
export const FUNCTIONAL_TYPE_WORD_LENGTH = LAZULI_TYPE_WORD_LENGTH;
export const FUNCTIONAL_TYPE_BYTE_LENGTH = LAZULI_TYPE_BYTE_LENGTH;
export const FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH = LAZULI_CONSTRUCTOR_WORD_LENGTH;
export const FUNCTIONAL_CONSTRUCTOR_BYTE_LENGTH = LAZULI_CONSTRUCTOR_BYTE_LENGTH;

export const FunctionalNodeWord = LazuliSurfaceWord;
export const FunctionalDefinitionWord = LazuliDefinitionWord;
export const FunctionalAlgebraicTypeWord = LazuliTypeWord;
export const FunctionalConstructorWord = LazuliConstructorWord;
export const FunctionalExpressionTag = LazuliSurfaceTag;
export const FunctionalCoreTag = LazuliCoreTag;
export const FunctionalUnaryOperator = LazuliUnaryOperator;
export const FunctionalBinaryOperator = LazuliBinaryOperator;

export type FunctionalExpressionTag =
  (typeof FunctionalExpressionTag)[keyof typeof FunctionalExpressionTag];
export type FunctionalCoreTag = (typeof FunctionalCoreTag)[keyof typeof FunctionalCoreTag];
export type FunctionalUnaryOperator =
  (typeof FunctionalUnaryOperator)[keyof typeof FunctionalUnaryOperator];
export type FunctionalBinaryOperator =
  (typeof FunctionalBinaryOperator)[keyof typeof FunctionalBinaryOperator];

export const FunctionalEvaluationProfile = {
  LazyCallByNeed: "lazy-call-by-need-v1",
} as const;

export type FunctionalEvaluationProfile =
  (typeof FunctionalEvaluationProfile)[keyof typeof FunctionalEvaluationProfile];

export const FunctionalTypecheckingProfile = {
  HindleyMilnerIndexed: "hindley-milner-indexed-v1",
  PredicativeRankNIndexed: "predicative-rank-n-indexed-v1",
} as const;

export type FunctionalTypecheckingProfile =
  (typeof FunctionalTypecheckingProfile)[keyof typeof FunctionalTypecheckingProfile];

export const FunctionalPrimitiveCapability = {
  SignedInteger32: "signed-integer-i32",
  Boolean: "boolean",
  Unit: "unit",
  Pair: "pair",
  Function: "function",
  AlgebraicData: "algebraic-data",
} as const;

export type FunctionalPrimitiveCapability =
  (typeof FunctionalPrimitiveCapability)[keyof typeof FunctionalPrimitiveCapability];

export const FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES: readonly FunctionalPrimitiveCapability[] =
  Object.freeze(
    [
      FunctionalPrimitiveCapability.SignedInteger32,
      FunctionalPrimitiveCapability.Boolean,
      FunctionalPrimitiveCapability.Unit,
      FunctionalPrimitiveCapability.Pair,
      FunctionalPrimitiveCapability.Function,
      FunctionalPrimitiveCapability.AlgebraicData,
    ] as const,
  );

export type FunctionalSpan = LazuliSpan;
export type FunctionalType = LazuliType;
export type FunctionalTypeSchema = LazuliTypeSchema;
export type FunctionalSourceType = LazuliSourceType;
export type FunctionalTypeDeclaration = LazuliTypeDeclaration;
export type EncodedFunctionalDefinitionType = EncodedLazuliDefinitionType;
export type EncodedFunctionalTypeDeclaration = EncodedLazuliTypeDeclaration;

type FunctionalCode<Code extends string> = Code extends `L${infer Suffix}` ? `F${Suffix}`
  : never;

export type FunctionalDiagnosticCode = FunctionalCode<LazuliDiagnosticCode>;

export interface FunctionalDiagnostic {
  readonly stage: "compile";
  readonly code: FunctionalDiagnosticCode;
  readonly message: string;
  readonly span: FunctionalSpan;
}

export interface EncodedFunctionalModule {
  readonly abiVersion: number;
  readonly sourceByteLength: number;
  readonly evaluationProfile: FunctionalEvaluationProfile;
  readonly typecheckingProfile: FunctionalTypecheckingProfile;
  readonly primitiveCapabilities: readonly FunctionalPrimitiveCapability[];
  readonly hostCapabilities?: readonly FunctionalHostCapabilityDeclaration[];
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
