/**
 * Lowers Sweep to Functional Surface.
 *
 * The lowering is deliberately thin, and that thinness is the point of the language: there is no
 * pattern-match compilation, no arity inference, no scope threading, and no desugaring that can
 * duplicate a body. Each source construct maps to one Core shape.
 *
 * Two rules are enforced here rather than by the grammar, because they are properties of a whole
 * function rather than of any one token: locals must be unique (rule 5), and every definition must
 * carry a complete annotation (rule 1). Both are checked before a node is built, so a violation is
 * a diagnostic rather than a surprise during inference.
 *
 * @module
 */
import {
  BinaryOperator,
  buildSurfaceModule,
  type EncodedModule,
  EvaluationProfile,
  surface,
  type SurfaceDefinition,
  type SurfaceExpression,
  type TypeDeclaration,
  type TypeSchema,
} from "../../functional.ts";
import type {
  SweepArm,
  SweepBinaryOperator,
  SweepExpression,
  SweepFunction,
  SweepModule,
  SweepSpan,
  SweepType,
} from "./ast.ts";
import type { SweepDiagnostic } from "./parser.ts";

export type SweepLowerResult =
  | { readonly ok: true; readonly module: EncodedModule }
  | { readonly ok: false; readonly diagnostics: readonly SweepDiagnostic[] };

const OPERATORS: Record<SweepBinaryOperator, BinaryOperator> = {
  add: BinaryOperator.Add,
  subtract: BinaryOperator.Subtract,
  multiply: BinaryOperator.Multiply,
  less: BinaryOperator.Less,
  "less-equal": BinaryOperator.LessEqual,
  greater: BinaryOperator.Greater,
  "greater-equal": BinaryOperator.GreaterEqual,
  equal: BinaryOperator.Equal,
};

class LowerError extends Error {
  constructor(readonly diagnostic: SweepDiagnostic) {
    super(diagnostic.message);
  }
}

function fail(message: string, span: SweepSpan): never {
  throw new LowerError({ message, span });
}

function lowerType(type: SweepType): TypeSchema {
  switch (type.kind) {
    case "parameter":
      return { kind: "parameter", name: type.name };
    case "function":
      // Rule 3 pays its cost here and nowhere else: Core has only unary arrows, so an n-ary
      // signature folds right. BASELINE.md measures that at +90 inference transitions per
      // parameter, which is the price of the current ABI rather than of the language.
      return type.parameters.reduceRight<TypeSchema>(
        (result, parameter) => ({ kind: "function", parameter: lowerType(parameter), result }),
        lowerType(type.result),
      );
    case "name":
      switch (type.name) {
        case "Int":
          return { kind: "integer" };
        case "Bool":
          return { kind: "boolean" };
        case "Unit":
          return { kind: "unit" };
        default:
          return { kind: "named", name: type.name, arguments: type.arguments.map(lowerType) };
      }
  }
}

/** Rule 5: one flat table per function, so a name resolves without walking a scope chain. */
function collectLocals(fn: SweepFunction): Set<string> {
  const locals = new Set<string>();
  const declare = (name: string, span: SweepSpan) => {
    if (locals.has(name)) {
      fail(
        `local ${JSON.stringify(name)} is already bound in ${
          JSON.stringify(fn.name)
        }; Sweep locals are flat and unique`,
        span,
      );
    }
    locals.add(name);
  };
  for (const parameter of fn.parameters) declare(parameter.name, fn.span);
  const walk = (expression: SweepExpression): void => {
    switch (expression.kind) {
      case "let":
        declare(expression.name, expression.span);
        walk(expression.value);
        walk(expression.body);
        return;
      case "match":
        walk(expression.subject);
        for (const arm of expression.arms) {
          for (const binder of arm.binders) declare(binder, arm.span);
          walk(arm.body);
        }
        return;
      case "if":
        walk(expression.condition);
        walk(expression.consequent);
        walk(expression.alternate);
        return;
      case "binary":
        walk(expression.left);
        walk(expression.right);
        return;
      case "call":
      case "construct":
        for (const argument of expression.arguments) walk(argument);
        return;
      default:
        return;
    }
  };
  walk(fn.body);
  return locals;
}

function lowerExpression(expression: SweepExpression): SurfaceExpression {
  const at = surface.at({ startByte: expression.span.startByte, endByte: expression.span.endByte });
  switch (expression.kind) {
    case "integer":
      return at.integer(expression.value);
    case "boolean":
      return at.boolean(expression.value);
    case "name":
      return at.name(expression.name);
    case "binary":
      return at.binary(
        OPERATORS[expression.operator],
        lowerExpression(expression.left),
        lowerExpression(expression.right),
      );
    case "let":
      return at.let(
        expression.name,
        lowerExpression(expression.value),
        lowerExpression(expression.body),
      );
    case "if":
      return at.if(
        lowerExpression(expression.condition),
        lowerExpression(expression.consequent),
        lowerExpression(expression.alternate),
      );
    case "construct":
      // A constructor is applied to its fields left to right, same as any call.
      return expression.arguments.reduce<SurfaceExpression>(
        (callee, argument) => at.apply(callee, lowerExpression(argument)),
        at.name(expression.constructor),
      );
    case "call":
      // Type arguments carry no runtime content; they exist so a checker never has to solve for
      // them. Erasing them here is what makes rule 2 free at runtime.
      return expression.arguments.reduce<SurfaceExpression>(
        (callee, argument) => at.apply(callee, lowerExpression(argument)),
        at.name(expression.callee),
      );
    case "match":
      // Rule 4: one arm in, one arm out. No decision tree, no body duplication, no or-patterns to
      // expand -- which is the whole reason TASKS item 1 cannot happen in this language.
      return at.case(
        lowerExpression(expression.subject),
        expression.arms.map((arm: SweepArm) => ({
          constructor: arm.constructor,
          binders: [...arm.binders],
          body: lowerExpression(arm.body),
          span: { startByte: arm.span.startByte, endByte: arm.span.endByte },
        })),
      );
  }
}

function lowerFunction(fn: SweepFunction): SurfaceDefinition {
  collectLocals(fn);
  // Rule 1: the annotation is total. Type parameters are left free rather than wrapped in a
  // `forall` -- the ABI reserves explicit quantifiers for rank-N parameter positions and rejects one
  // at the top of a definition, so a top-level scheme is written with free parameters and closed by
  // generalization. Rule 2 still holds at the call site, which is where a checker would otherwise
  // have to solve for the arguments.
  const annotation: TypeSchema = fn.parameters.reduceRight<TypeSchema>(
    (result, parameter) => ({ kind: "function", parameter: lowerType(parameter.type), result }),
    lowerType(fn.result),
  );
  return {
    name: fn.name,
    parameters: fn.parameters.map((parameter) => parameter.name),
    annotation,
    body: lowerExpression(fn.body),
    span: { startByte: fn.span.startByte, endByte: fn.span.endByte },
  };
}

export function lowerSweepModule(module: SweepModule, sourceByteLength: number): SweepLowerResult {
  try {
    if (!module.functions.some((fn) => fn.name === "main")) {
      fail(`module ${JSON.stringify(module.name)} declares no "main"`, {
        startByte: 0,
        endByte: 0,
      });
    }
    for (const exported of module.exports) {
      if (!module.functions.some((fn) => fn.name === exported)) {
        fail(`exported name ${JSON.stringify(exported)} is not defined`, {
          startByte: 0,
          endByte: 0,
        });
      }
    }
    const types: TypeDeclaration[] = module.types.map((declaration) => ({
      name: declaration.name,
      parameters: [...declaration.parameters],
      constructors: declaration.constructors.map((constructor) => ({
        name: constructor.name,
        fields: constructor.fields.map((field) => ({
          name: field.name,
          type: lowerType(field.type),
        })),
      })),
    }));
    return {
      ok: true,
      module: buildSurfaceModule(
        module.functions.map(lowerFunction),
        types,
        "main",
        sourceByteLength,
        // Strict, because a checker that never suspends is one less thing for the sweep to model.
        { evaluationProfile: EvaluationProfile.StrictEager },
      ),
    };
  } catch (error) {
    if (error instanceof LowerError) return { ok: false, diagnostics: [error.diagnostic] };
    if (error instanceof Error) {
      return {
        ok: false,
        diagnostics: [{ message: error.message, span: { startByte: 0, endByte: 0 } }],
      };
    }
    throw error;
  }
}
