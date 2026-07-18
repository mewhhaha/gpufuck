import type { FunctionalSpan } from "../functional/abi.ts";
import type {
  RustFunctionalExpression,
  RustFunctionalFunctionDeclaration,
  RustFunctionalPattern,
  RustFunctionalProgram,
  RustFunctionalType,
} from "./ast.ts";
import { RustFunctionalLoweringError } from "./diagnostic.ts";

interface RustOwnershipBinding {
  readonly copy: boolean;
  readonly declaration: FunctionalSpan;
  moved: boolean;
}

type RustOwnershipScope = Map<string, RustOwnershipBinding>;

export function validateRustFunctionalOwnership(program: RustFunctionalProgram): void {
  const copyResultByFunction = new Map(
    program.declarations.flatMap((declaration) =>
      declaration.kind === "function"
        ? [[declaration.name, rustTypeIsCopy(declaration.result)] as const]
        : []
    ),
  );
  for (const declaration of program.declarations) {
    if (declaration.kind === "function") {
      validateFunctionOwnership(declaration, copyResultByFunction);
    }
  }
}

function validateFunctionOwnership(
  declaration: RustFunctionalFunctionDeclaration,
  copyResultByFunction: ReadonlyMap<string, boolean>,
): void {
  const scope: RustOwnershipScope = new Map();
  for (const parameter of declaration.parameters) {
    scope.set(parameter.name, {
      copy: rustTypeIsCopy(parameter.type),
      declaration: parameter.span,
      moved: false,
    });
  }
  validateExpressionOwnership(declaration.body, scope, "move", copyResultByFunction);
}

function validateExpressionOwnership(
  expression: RustFunctionalExpression,
  scope: RustOwnershipScope,
  use: "borrow" | "move",
  copyResultByFunction: ReadonlyMap<string, boolean>,
): boolean {
  switch (expression.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return true;
    case "name": {
      const binding = scope.get(expression.name);
      if (binding === undefined) return true;
      if (binding.moved) {
        throw new RustFunctionalLoweringError(
          expression.span,
          `Rust functional ownership uses moved value ${JSON.stringify(expression.name)}; ` +
            `its binding starts at byte ${binding.declaration.startByte}.`,
        );
      }
      if (use === "move" && !binding.copy) binding.moved = true;
      return binding.copy;
    }
    case "borrow":
      validateExpressionOwnership(expression.value, scope, "borrow", copyResultByFunction);
      return false;
    case "tuple":
      validateExpressionOwnership(expression.values[0], scope, "move", copyResultByFunction);
      validateExpressionOwnership(expression.values[1], scope, "move", copyResultByFunction);
      return false;
    case "call": {
      validateExpressionOwnership(expression.callee, scope, "borrow", copyResultByFunction);
      for (const argument of expression.arguments) {
        validateExpressionOwnership(argument, scope, "move", copyResultByFunction);
      }
      return expression.callee.kind === "name" &&
        copyResultByFunction.get(expression.callee.name) === true;
    }
    case "record":
      for (const field of expression.fields) {
        validateExpressionOwnership(field.value, scope, "move", copyResultByFunction);
      }
      return false;
    case "let": {
      const copy = validateExpressionOwnership(
        expression.value,
        scope,
        "move",
        copyResultByFunction,
      );
      const bodyScope = cloneOwnershipScope(scope);
      bodyScope.set(expression.name, {
        copy,
        declaration: expression.span,
        moved: false,
      });
      return validateExpressionOwnership(expression.body, bodyScope, use, copyResultByFunction);
    }
    case "if": {
      validateExpressionOwnership(expression.condition, scope, "move", copyResultByFunction);
      const consequentScope = cloneOwnershipScope(scope);
      const alternateScope = cloneOwnershipScope(scope);
      const consequentCopy = validateExpressionOwnership(
        expression.consequent,
        consequentScope,
        use,
        copyResultByFunction,
      );
      const alternateCopy = validateExpressionOwnership(
        expression.alternate,
        alternateScope,
        use,
        copyResultByFunction,
      );
      mergeMovedBindings(scope, [consequentScope, alternateScope]);
      return consequentCopy && alternateCopy;
    }
    case "binary":
      validateExpressionOwnership(expression.left, scope, "move", copyResultByFunction);
      validateExpressionOwnership(expression.right, scope, "move", copyResultByFunction);
      return true;
    case "match": {
      validateExpressionOwnership(expression.value, scope, "move", copyResultByFunction);
      const armScopes: RustOwnershipScope[] = [];
      let copy = true;
      for (const arm of expression.arms) {
        const armScope = cloneOwnershipScope(scope);
        declarePatternBindings(arm.pattern, armScope);
        copy = validateExpressionOwnership(arm.body, armScope, use, copyResultByFunction) && copy;
        armScopes.push(armScope);
      }
      mergeMovedBindings(scope, armScopes);
      return copy;
    }
  }
}

function declarePatternBindings(pattern: RustFunctionalPattern, scope: RustOwnershipScope): void {
  const binders = pattern.kind === "record"
    ? pattern.fields.map((field) => field.binder)
    : pattern.binders;
  for (const binder of binders) {
    if (binder.name === null) continue;
    scope.set(binder.name, {
      copy: false,
      declaration: binder.span,
      moved: false,
    });
  }
}

function rustTypeIsCopy(type: RustFunctionalType): boolean {
  return type.kind === "integer" || type.kind === "boolean" || type.kind === "unit" ||
    type.kind === "function";
}

function cloneOwnershipScope(scope: RustOwnershipScope): RustOwnershipScope {
  return new Map(
    [...scope].map(([name, binding]) => [name, { ...binding }]),
  );
}

function mergeMovedBindings(
  destination: RustOwnershipScope,
  branches: readonly RustOwnershipScope[],
): void {
  for (const [name, binding] of destination) {
    if (branches.some((branch) => branch.get(name)?.moved === true)) binding.moved = true;
  }
}
