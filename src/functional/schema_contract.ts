import type {
  LazuliSourceType,
  LazuliSpan,
  LazuliType,
  LazuliTypeDeclaration,
  LazuliTypeSchema,
} from "../semantic/abi.ts";

export const FunctionalEvaluationProfile = {
  LazyCallByNeed: "lazy-call-by-need-v1",
  StrictEager: "strict-eager-v1",
} as const;

export type FunctionalEvaluationProfile =
  (typeof FunctionalEvaluationProfile)[keyof typeof FunctionalEvaluationProfile];

export const FunctionalTypecheckingProfile = {
  HindleyMilnerIndexed: "hindley-milner-indexed-v1",
  PredicativeRankNIndexed: "predicative-rank-n-indexed-v1",
} as const;

export type FunctionalTypecheckingProfile =
  (typeof FunctionalTypecheckingProfile)[keyof typeof FunctionalTypecheckingProfile];

export type FunctionalSpan = LazuliSpan;
export type FunctionalType = LazuliType;
export type FunctionalTypeSchema = LazuliTypeSchema;
export type FunctionalSourceType = LazuliSourceType;
export type FunctionalTypeDeclaration = LazuliTypeDeclaration;
