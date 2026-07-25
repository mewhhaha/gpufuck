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

/**
 * Instantiates a closed schema into a concrete type. Schemas reaching a public boundary carry no
 * free parameters, so an unresolved parameter or a retained `forall` is a packing defect.
 */
export function concreteFunctionalType(schema: FunctionalTypeSchema): FunctionalType {
  return instantiateSchema(schema, new Map());
}

export function instantiateSchema(
  schema: FunctionalTypeSchema,
  parameters: ReadonlyMap<string, FunctionalType>,
): FunctionalType {
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return { kind: schema.kind };
    case "parameter": {
      const type = parameters.get(schema.name);
      if (type === undefined) {
        throw new Error(
          `type schema contains unresolved parameter ${JSON.stringify(schema.name)}`,
        );
      }
      return type;
    }
    case "tuple":
      return {
        kind: "tuple",
        values: [
          instantiateSchema(schema.values[0], parameters),
          instantiateSchema(schema.values[1], parameters),
        ],
      };
    case "named":
      return {
        kind: "named",
        name: schema.name,
        arguments: schema.arguments.map((argument) => instantiateSchema(argument, parameters)),
      };
    case "function":
      return {
        kind: "function",
        parameter: instantiateSchema(schema.parameter, parameters),
        result: instantiateSchema(schema.result, parameters),
      };
    case "forall":
      throw new TypeError("a concrete type cannot retain a forall schema");
  }
}
