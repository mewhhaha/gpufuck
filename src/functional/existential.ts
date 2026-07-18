import { FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, type FunctionalTypeSchema } from "./abi.ts";
import type { FunctionalSurfaceExpression } from "./surface_builder.ts";

export interface FunctionalExistentialType {
  readonly parameters: readonly string[];
  readonly payload: FunctionalTypeSchema;
  readonly result: FunctionalTypeSchema;
}

/**
 * Produces the closed eliminator type used by an existential package.
 *
 * The package is represented as `Unit -> result`. Its implementation captures the hidden payload,
 * and only `result` crosses the package boundary. This is the predicative closure encoding of an
 * existential with a fixed eliminator; richer interfaces can place several closed operations in
 * `result`.
 */
export function functionalExistentialType(
  existential: FunctionalExistentialType,
): FunctionalTypeSchema {
  const parameters = validateExistential(existential);
  const resultParameters = freeTypeParameters(existential.result);
  for (const parameter of parameters) {
    if (resultParameters.has(parameter)) {
      throw new Error(
        `functional existential result exposes hidden parameter ${JSON.stringify(parameter)}`,
      );
    }
  }
  return {
    kind: "function",
    parameter: { kind: "unit" },
    result: existential.result,
  };
}

/** Captures one hidden payload and exposes only the closed eliminator body. */
export function packFunctionalExistential(
  payload: FunctionalSurfaceExpression,
  payloadName: string,
  body: FunctionalSurfaceExpression,
): FunctionalSurfaceExpression {
  if (payloadName.length === 0) {
    throw new Error("functional existential payload name must be nonempty");
  }
  return {
    kind: "lambda",
    parameter: "$existentialUnit",
    body: {
      kind: "let",
      name: payloadName,
      value: payload,
      body,
    },
  };
}

/** Runs an existential package's closed eliminator. */
export function unpackFunctionalExistential(
  packageExpression: FunctionalSurfaceExpression,
): FunctionalSurfaceExpression {
  return {
    kind: "apply",
    callee: packageExpression,
    argument: { kind: "name", name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME },
  };
}

function validateExistential(existential: FunctionalExistentialType): readonly string[] {
  if (existential.parameters.length === 0) {
    throw new Error("functional existential must hide at least one type parameter");
  }
  const parameters = new Set<string>();
  for (const parameter of existential.parameters) {
    if (parameter.length === 0) {
      throw new Error("functional existential parameter must be nonempty");
    }
    if (parameters.has(parameter)) {
      throw new Error(`functional existential repeats parameter ${JSON.stringify(parameter)}`);
    }
    parameters.add(parameter);
  }
  const free = freeTypeParameters(existential.payload);
  for (const parameter of parameters) {
    if (!free.has(parameter)) {
      throw new Error(
        `functional existential parameter ${
          JSON.stringify(parameter)
        } does not occur in its payload`,
      );
    }
  }
  return Object.freeze([...parameters]);
}

function freeTypeParameters(schema: FunctionalTypeSchema): Set<string> {
  const free = new Set<string>();
  const visit = (current: FunctionalTypeSchema, bound: ReadonlySet<string>): void => {
    switch (current.kind) {
      case "parameter":
        if (!bound.has(current.name)) free.add(current.name);
        return;
      case "tuple":
        visit(current.values[0], bound);
        visit(current.values[1], bound);
        return;
      case "named":
        for (const argument of current.arguments) visit(argument, bound);
        return;
      case "function":
        visit(current.parameter, bound);
        visit(current.result, bound);
        return;
      case "forall": {
        const nested = new Set(bound);
        for (const parameter of current.parameters) nested.add(parameter);
        visit(current.body, nested);
        return;
      }
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return;
    }
  };
  visit(schema, new Set());
  return free;
}
