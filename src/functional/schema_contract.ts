import type { Type, TypeSchema } from "../semantic/abi.ts";

export type { SourceType, Span, Type, TypeDeclaration, TypeSchema } from "../semantic/abi.ts";

export const TypecheckingProfile = {
  HindleyMilnerIndexed: "hindley-milner-indexed-v1",
  PredicativeRankNIndexed: "predicative-rank-n-indexed-v1",
} as const;

export type TypecheckingProfile = (typeof TypecheckingProfile)[keyof typeof TypecheckingProfile];

/**
 * Instantiates a closed schema into a concrete type. Schemas reaching a public boundary carry no
 * free parameters, so an unresolved parameter or a retained `forall` is a packing defect.
 */
export function concreteType(schema: TypeSchema): Type {
  return instantiateSchema(schema, new Map());
}

export function instantiateSchema(
  schema: TypeSchema,
  parameters: ReadonlyMap<string, Type>,
): Type {
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
