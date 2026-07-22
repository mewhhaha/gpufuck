import type {
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceRecursiveBinding,
} from "./surface_contract.ts";

const MAXIMUM_RECURSIVE_GROUP_CAPTURES = 512;

interface RecursiveGroupElaboration {
  readonly definitions: FunctionalSurfaceDefinition[];
  readonly globalNames: Set<string>;
  nextGroupId: number;
}

/**
 * Lambda-lifts local recursive groups into ordinary top-level recursive SCCs.
 *
 * Captured lexical bindings become leading parameters. References to a group member become partial
 * applications of its generated global to those captures. The ordinary GPU dependency analysis
 * then discovers and checks the generated SCC.
 */
export function elaborateFunctionalRecursiveGroups(
  definitions: readonly FunctionalSurfaceDefinition[],
): readonly FunctionalSurfaceDefinition[] {
  const globalNames = new Set(definitions.map((definition) => definition.name));
  const elaboration: RecursiveGroupElaboration = {
    definitions: [],
    globalNames,
    nextGroupId: 0,
  };
  const originals = definitions.map((definition) => ({
    ...definition,
    body: elaborateExpression(
      definition.body,
      new Set(definition.parameters),
      elaboration,
    ),
  }));
  const generated = elaboration.definitions
    .map((definition, index) => ({ definition, index }))
    .sort((left, right) =>
      (left.definition.span?.startByte ?? 0) -
        (right.definition.span?.startByte ?? 0) || left.index - right.index
    )
    .map(({ definition }) => definition);
  const merged: FunctionalSurfaceDefinition[] = [];
  let generatedIndex = 0;
  for (const original of originals) {
    while (
      generatedIndex < generated.length &&
      (generated[generatedIndex]!.span?.startByte ?? 0) < (original.span?.startByte ?? 0)
    ) {
      merged.push(generated[generatedIndex++]!);
    }
    merged.push(original);
  }
  merged.push(...generated.slice(generatedIndex));
  return Object.freeze(merged);
}

function elaborateExpression(
  expression: FunctionalSurfaceExpression,
  lexicalNames: ReadonlySet<string>,
  elaboration: RecursiveGroupElaboration,
): FunctionalSurfaceExpression {
  const elaborate = (
    nested: FunctionalSurfaceExpression,
    scope: ReadonlySet<string> = lexicalNames,
  ): FunctionalSurfaceExpression => elaborateExpression(nested, scope, elaboration);

  switch (expression.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "whole-number-f64":
    case "boolean":
    case "text":
    case "bytes":
    case "runtime-fault":
    case "name":
      return expression;
    case "lambda":
      return {
        ...expression,
        body: elaborate(expression.body, withName(lexicalNames, expression.parameter)),
      };
    case "let":
      return {
        ...expression,
        value: elaborate(expression.value),
        body: elaborate(expression.body, withName(lexicalNames, expression.name)),
      };
    case "let-rec": {
      const recursiveScope = withName(lexicalNames, expression.name);
      return {
        ...expression,
        value: elaborate(expression.value, recursiveScope),
        body: elaborate(expression.body, recursiveScope),
      };
    }
    case "let-rec-group":
      return elaborateRecursiveGroup(
        expression.bindings,
        expression.body,
        lexicalNames,
        elaboration,
      );
    case "if":
      return {
        ...expression,
        condition: elaborate(expression.condition),
        consequent: elaborate(expression.consequent),
        alternate: elaborate(expression.alternate),
      };
    case "apply":
      return {
        ...expression,
        callee: elaborate(expression.callee),
        argument: elaborate(expression.argument),
      };
    case "unary":
    case "numeric-convert":
      return { ...expression, value: elaborate(expression.value) };
    case "binary":
    case "text-append":
    case "bytes-append":
      return {
        ...expression,
        left: elaborate(expression.left),
        right: elaborate(expression.right),
      };
    case "store-new":
      return {
        ...expression,
        length: elaborate(expression.length),
        initial: elaborate(expression.initial),
      };
    case "store-length":
      return { ...expression, store: elaborate(expression.store) };
    case "store-read":
      return {
        ...expression,
        store: elaborate(expression.store),
        index: elaborate(expression.index),
      };
    case "store-write":
      return {
        ...expression,
        store: elaborate(expression.store),
        index: elaborate(expression.index),
        value: elaborate(expression.value),
      };
    case "store-grow":
      return {
        ...expression,
        store: elaborate(expression.store),
        length: elaborate(expression.length),
        initial: elaborate(expression.initial),
      };
    case "case":
      return {
        ...expression,
        value: elaborate(expression.value),
        arms: expression.arms.map((arm) => ({
          ...arm,
          body: elaborate(arm.body, withNames(lexicalNames, arm.binders)),
        })),
      };
  }
}

function elaborateRecursiveGroup(
  bindings: readonly FunctionalSurfaceRecursiveBinding[],
  body: FunctionalSurfaceExpression,
  lexicalNames: ReadonlySet<string>,
  elaboration: RecursiveGroupElaboration,
): FunctionalSurfaceExpression {
  if (bindings.length === 0) {
    throw new Error("functional recursive group must contain at least one binding");
  }
  const bindingNames = new Set<string>();
  for (const binding of bindings) {
    requireUniqueName(binding.name, bindingNames, "functional recursive group binding");
    const parameterNames = new Set<string>();
    for (const parameter of binding.parameters) {
      requireUniqueName(
        parameter,
        parameterNames,
        `functional recursive binding ${JSON.stringify(binding.name)} parameter`,
      );
    }
  }

  const captures = new Set<string>();
  for (const binding of bindings) {
    const locallyBound = withNames(bindingNames, binding.parameters);
    for (const name of freeNames(binding.body, locallyBound)) {
      if (lexicalNames.has(name)) captures.add(name);
    }
  }
  const captureNames = [...captures].sort();
  if (captureNames.length > MAXIMUM_RECURSIVE_GROUP_CAPTURES) {
    throw new RangeError(
      `functional recursive group captures ${captureNames.length} lexical names; maximum is ${MAXIMUM_RECURSIVE_GROUP_CAPTURES}`,
    );
  }
  const generatedNames = new Map<string, string>();
  const groupId = elaboration.nextGroupId++;
  for (const binding of bindings) {
    generatedNames.set(
      binding.name,
      allocateGeneratedName(`$recursiveGroup${groupId}$${binding.name}`, elaboration.globalNames),
    );
  }

  const replacements = new Map<string, FunctionalSurfaceExpression>();
  for (const binding of bindings) {
    const generatedName = requiredMapValue(generatedNames, binding.name);
    replacements.set(binding.name, applyNames(generatedName, captureNames));
  }

  for (const binding of bindings) {
    const shadowedReplacements = new Set(
      binding.parameters.filter((parameter) => replacements.has(parameter)),
    );
    const rewritten = rewriteNames(binding.body, replacements, shadowedReplacements);
    const parameters = [...captureNames, ...binding.parameters];
    elaboration.definitions.push({
      name: requiredMapValue(generatedNames, binding.name),
      parameters,
      annotation: null,
      body: elaborateExpression(rewritten, new Set(parameters), elaboration),
      ...(binding.span === undefined ? {} : { span: binding.span }),
    });
  }

  return elaborateExpression(
    rewriteNames(body, replacements, new Set()),
    lexicalNames,
    elaboration,
  );
}

function rewriteNames(
  expression: FunctionalSurfaceExpression,
  replacements: ReadonlyMap<string, FunctionalSurfaceExpression>,
  boundNames: ReadonlySet<string>,
): FunctionalSurfaceExpression {
  const rewrite = (
    nested: FunctionalSurfaceExpression,
    scope: ReadonlySet<string> = boundNames,
  ): FunctionalSurfaceExpression => rewriteNames(nested, replacements, scope);
  switch (expression.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "whole-number-f64":
    case "boolean":
    case "text":
    case "bytes":
    case "runtime-fault":
      return expression;
    case "name":
      return boundNames.has(expression.name)
        ? expression
        : replacements.get(expression.name) ?? expression;
    case "lambda":
      return {
        ...expression,
        body: rewrite(
          expression.body,
          withReplacementNames(boundNames, [expression.parameter], replacements),
        ),
      };
    case "let":
      return {
        ...expression,
        value: rewrite(expression.value),
        body: rewrite(
          expression.body,
          withReplacementNames(boundNames, [expression.name], replacements),
        ),
      };
    case "let-rec": {
      const recursiveScope = withReplacementNames(
        boundNames,
        [expression.name],
        replacements,
      );
      return {
        ...expression,
        value: rewrite(expression.value, recursiveScope),
        body: rewrite(expression.body, recursiveScope),
      };
    }
    case "let-rec-group": {
      const groupScope = withReplacementNames(
        boundNames,
        expression.bindings.map((binding) => binding.name),
        replacements,
      );
      return {
        ...expression,
        bindings: expression.bindings.map((binding) => ({
          ...binding,
          body: rewrite(
            binding.body,
            withReplacementNames(groupScope, binding.parameters, replacements),
          ),
        })),
        body: rewrite(expression.body, groupScope),
      };
    }
    case "if":
      return {
        ...expression,
        condition: rewrite(expression.condition),
        consequent: rewrite(expression.consequent),
        alternate: rewrite(expression.alternate),
      };
    case "apply":
      return {
        ...expression,
        callee: rewrite(expression.callee),
        argument: rewrite(expression.argument),
      };
    case "unary":
    case "numeric-convert":
      return { ...expression, value: rewrite(expression.value) };
    case "binary":
    case "text-append":
    case "bytes-append":
      return { ...expression, left: rewrite(expression.left), right: rewrite(expression.right) };
    case "store-new":
      return {
        ...expression,
        length: rewrite(expression.length),
        initial: rewrite(expression.initial),
      };
    case "store-length":
      return { ...expression, store: rewrite(expression.store) };
    case "store-read":
      return { ...expression, store: rewrite(expression.store), index: rewrite(expression.index) };
    case "store-write":
      return {
        ...expression,
        store: rewrite(expression.store),
        index: rewrite(expression.index),
        value: rewrite(expression.value),
      };
    case "store-grow":
      return {
        ...expression,
        store: rewrite(expression.store),
        length: rewrite(expression.length),
        initial: rewrite(expression.initial),
      };
    case "case":
      return {
        ...expression,
        value: rewrite(expression.value),
        arms: expression.arms.map((arm) => ({
          ...arm,
          body: rewrite(
            arm.body,
            withReplacementNames(boundNames, arm.binders, replacements),
          ),
        })),
      };
  }
}

function freeNames(
  expression: FunctionalSurfaceExpression,
  boundNames: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (nested: FunctionalSurfaceExpression, scope: ReadonlySet<string>): void => {
    switch (nested.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "whole-number-f64":
      case "boolean":
      case "text":
      case "bytes":
      case "runtime-fault":
        return;
      case "name":
        if (!scope.has(nested.name)) names.add(nested.name);
        return;
      case "lambda":
        visit(nested.body, withName(scope, nested.parameter));
        return;
      case "let":
        visit(nested.value, scope);
        visit(nested.body, withName(scope, nested.name));
        return;
      case "let-rec": {
        const recursiveScope = withName(scope, nested.name);
        visit(nested.value, recursiveScope);
        visit(nested.body, recursiveScope);
        return;
      }
      case "let-rec-group": {
        const groupScope = withNames(scope, nested.bindings.map((binding) => binding.name));
        for (const binding of nested.bindings) {
          visit(binding.body, withNames(groupScope, binding.parameters));
        }
        visit(nested.body, groupScope);
        return;
      }
      case "if":
        visit(nested.condition, scope);
        visit(nested.consequent, scope);
        visit(nested.alternate, scope);
        return;
      case "apply":
        visit(nested.callee, scope);
        visit(nested.argument, scope);
        return;
      case "unary":
      case "numeric-convert":
        visit(nested.value, scope);
        return;
      case "store-length":
        visit(nested.store, scope);
        return;
      case "binary":
      case "text-append":
      case "bytes-append":
        visit(nested.left, scope);
        visit(nested.right, scope);
        return;
      case "store-new":
        visit(nested.length, scope);
        visit(nested.initial, scope);
        return;
      case "store-read":
        visit(nested.store, scope);
        visit(nested.index, scope);
        return;
      case "store-write":
        visit(nested.store, scope);
        visit(nested.index, scope);
        visit(nested.value, scope);
        return;
      case "store-grow":
        visit(nested.store, scope);
        visit(nested.length, scope);
        visit(nested.initial, scope);
        return;
      case "case":
        visit(nested.value, scope);
        for (const arm of nested.arms) visit(arm.body, withNames(scope, arm.binders));
        return;
    }
  };
  visit(expression, boundNames);
  return names;
}

function applyNames(name: string, arguments_: readonly string[]): FunctionalSurfaceExpression {
  let expression: FunctionalSurfaceExpression = { kind: "name", name };
  for (const argument of arguments_) {
    expression = { kind: "apply", callee: expression, argument: { kind: "name", name: argument } };
  }
  return expression;
}

function withName(names: ReadonlySet<string>, name: string): Set<string> {
  return withNames(names, [name]);
}

function withNames(names: ReadonlySet<string>, additions: Iterable<string>): Set<string> {
  const result = new Set(names);
  for (const name of additions) result.add(name);
  return result;
}

function withReplacementNames(
  names: ReadonlySet<string>,
  additions: Iterable<string>,
  replacements: ReadonlyMap<string, FunctionalSurfaceExpression>,
): ReadonlySet<string> {
  let result: Set<string> | undefined;
  for (const name of additions) {
    if (!replacements.has(name) || names.has(name)) continue;
    if (result === undefined) result = new Set(names);
    result.add(name);
  }
  return result ?? names;
}

function requireUniqueName(name: string, names: Set<string>, location: string): void {
  if (name.length === 0) throw new Error(`${location} name must be nonempty`);
  if (names.has(name)) throw new Error(`${location} repeats name ${JSON.stringify(name)}`);
  names.add(name);
}

function allocateGeneratedName(candidate: string, globalNames: Set<string>): string {
  let name = candidate;
  let suffix = 0;
  while (globalNames.has(name)) name = `${candidate}$${++suffix}`;
  globalNames.add(name);
  return name;
}

function requiredMapValue<Key, Value>(values: ReadonlyMap<Key, Value>, key: Key): Value {
  const value = values.get(key);
  if (value === undefined) throw new Error(`functional recursive group omitted ${String(key)}`);
  return value;
}
