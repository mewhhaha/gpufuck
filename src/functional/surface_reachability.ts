import type {
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
} from "./surface_contract.ts";

export interface FunctionalSurfaceReachability {
  readonly definitionNames: ReadonlySet<string>;
  readonly referencedSymbols: ReadonlySet<string>;
}

export function analyzeFunctionalSurfaceReachability(
  definitions: readonly FunctionalSurfaceDefinition[],
  roots: readonly string[],
): FunctionalSurfaceReachability {
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const definitionNames = new Set<string>();
  const referencedSymbols = new Set<string>();
  const pendingDefinitions = [...roots];

  while (pendingDefinitions.length > 0) {
    const definitionName = pendingDefinitions.pop()!;
    if (definitionNames.has(definitionName)) continue;
    const definition = definitionsByName.get(definitionName);
    if (definition === undefined) continue;
    definitionNames.add(definitionName);

    const expressions: FunctionalSurfaceExpression[] = [definition.body];
    while (expressions.length > 0) {
      const expression = expressions.pop()!;
      switch (expression.kind) {
        case "name":
          referencedSymbols.add(expression.name);
          if (definitionsByName.has(expression.name) && !definitionNames.has(expression.name)) {
            pendingDefinitions.push(expression.name);
          }
          break;
        case "text-append":
        case "bytes-append":
        case "binary":
          expressions.push(expression.left, expression.right);
          break;
        case "store-new":
          expressions.push(expression.length, expression.initial);
          break;
        case "store-length":
          expressions.push(expression.store);
          break;
        case "store-read":
          expressions.push(expression.store, expression.index);
          break;
        case "store-write":
          expressions.push(expression.store, expression.index, expression.value);
          break;
        case "store-grow":
          expressions.push(expression.store, expression.length, expression.initial);
          break;
        case "apply":
          expressions.push(expression.callee, expression.argument);
          break;
        case "lambda":
          expressions.push(expression.body);
          break;
        case "let":
        case "let-rec":
          expressions.push(expression.value, expression.body);
          break;
        case "let-rec-group":
          expressions.push(expression.body, ...expression.bindings.map((binding) => binding.body));
          break;
        case "if":
          expressions.push(expression.condition, expression.consequent, expression.alternate);
          break;
        case "unary":
        case "numeric-convert":
          expressions.push(expression.value);
          break;
        case "case":
          expressions.push(expression.value, ...expression.arms.map((arm) => arm.body));
          for (const arm of expression.arms) referencedSymbols.add(arm.constructor);
          break;
        case "integer":
        case "signed-integer-64":
        case "float-32":
        case "float-64":
        case "whole-number-f64":
        case "boolean":
        case "text":
        case "bytes":
        case "runtime-fault":
          break;
      }
    }
  }

  return { definitionNames, referencedSymbols };
}
