import type {
  SurfaceCaseArm,
  SurfaceDefinition,
  SurfaceExpression,
  SurfaceTypeDeclaration,
} from "./surface_contract.ts";

/**
 * Expands `case` default arms into the exhaustive form the Core requires.
 *
 * Inference rejects a non-exhaustive case, so a frontend that wants a fallback has to name every
 * constructor the arms omit and bind the fallback once so it is not duplicated per arm. That is the
 * same expansion for every frontend, so it belongs here.
 */
export function elaborateCaseDefaults(
  definitions: readonly SurfaceDefinition[],
  typeDeclarations: readonly SurfaceTypeDeclaration[],
): readonly SurfaceDefinition[] {
  const owners = constructorOwners(typeDeclarations);
  let counter = 0;
  const nextName = (role: string): string => `$caseDefault${role}${counter++}`;

  const expand = (expression: SurfaceExpression): SurfaceExpression => {
    switch (expression.kind) {
      case "case": {
        const value = expand(expression.value);
        const arms = expression.arms.map((arm) => ({ ...arm, body: expand(arm.body) }));
        const otherwise = expression.otherwise;
        const { otherwise: _default, ...rest } = expression;
        if (otherwise === undefined) return { ...rest, value, arms };

        const missing = missingConstructors(arms, owners);
        const body = expand(otherwise.body);
        // Arms already cover the type, so the default is unreachable and contributes nothing.
        if (missing.length === 0) return { ...rest, value, arms };

        const scrutinee = nextName("Value");
        const fallback = nextName("Arm");
        const binder = otherwise.binder ?? nextName("Ignored");
        const call: SurfaceExpression = {
          kind: "apply",
          callee: { kind: "name", name: fallback },
          arguments: [{ kind: "name", name: scrutinee }],
        };
        const expanded: SurfaceCaseArm[] = [
          ...arms,
          ...missing.map((constructor) => ({
            constructor: constructor.name,
            binders: constructor.fields.map(() => nextName("Field")),
            body: call,
          })),
        ];
        return {
          kind: "let",
          name: scrutinee,
          value,
          body: {
            kind: "let",
            name: fallback,
            value: { kind: "lambda", parameters: [binder], body },
            body: {
              kind: "case",
              value: { kind: "name", name: scrutinee },
              arms: expanded,
              ...(expression.span === undefined ? {} : { span: expression.span }),
            },
          },
          ...(expression.span === undefined ? {} : { span: expression.span }),
        };
      }
      case "let":
        return { ...expression, value: expand(expression.value), body: expand(expression.body) };
      case "let-rec":
        return { ...expression, value: expand(expression.value), body: expand(expression.body) };
      case "let-rec-group":
        return {
          ...expression,
          bindings: expression.bindings.map((binding) => ({
            ...binding,
            body: expand(binding.body),
          })),
          body: expand(expression.body),
        };
      case "lambda":
        return { ...expression, body: expand(expression.body) };
      case "if":
        return {
          ...expression,
          condition: expand(expression.condition),
          consequent: expand(expression.consequent),
          alternate: expand(expression.alternate),
        };
      case "apply":
        return {
          ...expression,
          callee: expand(expression.callee),
          arguments: expression.arguments.map(expand),
        };
      case "binary":
      case "text-append":
      case "bytes-append":
        return { ...expression, left: expand(expression.left), right: expand(expression.right) };
      case "unary":
      case "numeric-convert":
        return { ...expression, value: expand(expression.value) };
      case "store-new":
        return {
          ...expression,
          length: expand(expression.length),
          initial: expand(expression.initial),
        };
      case "store-length":
        return { ...expression, store: expand(expression.store) };
      case "store-read":
        return { ...expression, store: expand(expression.store), index: expand(expression.index) };
      case "store-write":
        return {
          ...expression,
          store: expand(expression.store),
          index: expand(expression.index),
          value: expand(expression.value),
        };
      case "store-grow":
        return {
          ...expression,
          store: expand(expression.store),
          length: expand(expression.length),
          initial: expand(expression.initial),
        };
      default:
        return expression;
    }
  };

  return definitions.map((definition) => ({ ...definition, body: expand(definition.body) }));
}

interface ConstructorShape {
  readonly name: string;
  readonly fields: readonly unknown[];
}

function constructorOwners(
  typeDeclarations: readonly SurfaceTypeDeclaration[],
): ReadonlyMap<string, readonly ConstructorShape[]> {
  const owners = new Map<string, readonly ConstructorShape[]>();
  for (const declaration of typeDeclarations) {
    const shapes = declaration.constructors.map((constructor) => ({
      name: constructor.name,
      fields: constructor.fields,
    }));
    for (const constructor of declaration.constructors) owners.set(constructor.name, shapes);
  }
  return owners;
}

function missingConstructors(
  arms: readonly SurfaceCaseArm[],
  owners: ReadonlyMap<string, readonly ConstructorShape[]>,
): readonly ConstructorShape[] {
  const named = arms.find((arm) => owners.has(arm.constructor));
  if (named === undefined) {
    const listed = arms.map((arm) => JSON.stringify(arm.constructor)).join(", ");
    throw new Error(
      `functional case default cannot find the owning type; no declared constructor among [${listed}]. ` +
        `A case with a default needs at least one arm naming a declared constructor.`,
    );
  }
  const covered = new Set(arms.map((arm) => arm.constructor));
  return owners.get(named.constructor)!.filter((shape) => !covered.has(shape.name));
}
