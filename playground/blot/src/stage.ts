// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
import { BlotError } from "./diagnostic.ts";
import { bind, evaluate, evaluationRuntime, type Imports, match, run } from "./comptime/eval.ts";
import { childEnv, type Env, type Value } from "./comptime/value.ts";
import type { Decl, Expr, Module, Pattern, ShapeMember, Span } from "./syntax/ast.ts";

export interface StagedExport {
  readonly sourceName: string;
  readonly phase: "runtime" | "comptime";
  /** Present when staging computed the runtime value exactly. */
  readonly value?: Value;
}

export interface StagedModule {
  readonly module: Module;
  readonly exports: readonly StagedExport[];
  /** Shape facts introduced by staging-generated projections. */
  readonly shapes: ReadonlyMap<Expr, readonly string[]>;
}

export function stageModule(
  module: Module,
  values: Env,
  imports: Imports,
  inferredShapes: ReadonlyMap<Expr, readonly string[]> = new Map(),
): StagedModule {
  const stagingValues = childEnv(values);
  const stagedDeclarations = new Set<Decl>();
  let allDeclarationsStaged = true;
  for (const declaration of module.declarations) {
    if (declaration.tag !== "binding" || declaration.kind !== "let") continue;
    try {
      const value = run(
        bind(
          declaration.pattern,
          declaration.value,
          stagingValues,
          evaluationRuntime(imports, "runtime"),
        ),
      );
      match(declaration.pattern, value, stagingValues);
      stagedDeclarations.add(declaration);
    } catch (error) {
      if (!(error instanceof BlotError)) throw error;
      allDeclarationsStaged = false;
      const pending: Pattern[] = [declaration.pattern];
      while (pending.length > 0) {
        const pattern = pending.pop();
        if (pattern === undefined) continue;
        if (pattern.tag === "name") {
          stagingValues.names.delete(pattern.name);
          continue;
        }
        if (pattern.tag === "tuple" || pattern.tag === "array") {
          pending.push(...pattern.elements);
          continue;
        }
        if (pattern.tag === "shape") {
          pending.push(...pattern.fields.map((field) => field.pattern));
          continue;
        }
        if (pattern.tag === "constructor" && pattern.payload !== null) {
          pending.push(pattern.payload);
        }
      }
    }
  }

  if (module.result.tag !== "shape") {
    const staged = stageExpression(module.result, stagingValues, imports);
    if (staged.expression === null) {
      return {
        module: { ...module, result: unit(module.result.span) },
        exports: [{ sourceName: "default", phase: "comptime" }],
        shapes: new Map(),
      };
    }
    let declarations = module.declarations;
    if (staged.folded && allDeclarationsStaged) {
      declarations = module.declarations.filter((declaration) =>
        !stagedDeclarations.has(declaration)
      );
    }
    return {
      module: { ...module, declarations, result: staged.expression },
      exports: [{
        sourceName: "default",
        phase: "runtime",
        value: staged.value,
      }],
      shapes: new Map(),
    };
  }

  const finalFields = new Map<string, Expr | null>();
  const exportedFields = new Map<string, StagedExport>();
  const generatedDeclarations: Decl[] = [];
  const generatedShapes = new Map<Expr, readonly string[]>();
  let nextBinding = 0;
  let fullyStaged = allDeclarationsStaged;
  for (const member of module.result.members) {
    const staged = stageExpression(member.value, stagingValues, imports);
    if (member.tag === "field") {
      let expression = staged.expression;
      if (!staged.folded && expression !== null) {
        const binding = `stage$result$${nextBinding}`;
        nextBinding += 1;
        generatedDeclarations.push(runtimeBinding(binding, expression));
        expression = variable(binding, expression.span);
        fullyStaged = false;
      }
      finalFields.set(member.name, expression);
      let phase: StagedExport["phase"] = "runtime";
      if (expression === null) phase = "comptime";
      exportedFields.set(member.name, {
        sourceName: member.name,
        phase,
        value: staged.value,
      });
      continue;
    }

    if (staged.value !== undefined && staged.value.tag === "shape") {
      let binding: string | null = null;
      for (const [name, value] of staged.value.fields) {
        let expression = expressionOf(value, member.value.span);
        if (expression === null && !compileTimeOnly(value)) {
          if (binding === null) {
            binding = `stage$result$${nextBinding}`;
            nextBinding += 1;
            generatedDeclarations.push(
              runtimeBinding(binding, member.value),
            );
            fullyStaged = false;
          }
          const target = variable(binding, member.value.span);
          expression = {
            tag: "field",
            target,
            name,
            span: member.value.span,
          };
          generatedShapes.set(expression, [...staged.value.fields.keys()]);
        }
        finalFields.set(name, expression);
        let phase: StagedExport["phase"] = "runtime";
        if (expression === null) phase = "comptime";
        exportedFields.set(name, { sourceName: name, phase, value });
      }
      continue;
    }

    const fields = inferredShapes.get(member.value);
    if (fields === undefined) {
      throw new Error(
        "checking omitted the field set of a residual module-result spread",
      );
    }
    const binding = `stage$result$${nextBinding}`;
    nextBinding += 1;
    generatedDeclarations.push(runtimeBinding(binding, member.value));
    fullyStaged = false;
    for (const name of fields) {
      const expression: Expr = {
        tag: "field",
        target: variable(binding, member.value.span),
        name,
        span: member.value.span,
      };
      generatedShapes.set(expression, fields);
      finalFields.set(name, expression);
      exportedFields.set(name, { sourceName: name, phase: "runtime" });
    }
  }

  const members: ShapeMember[] = [];
  for (const [name, value] of finalFields) {
    if (value === null) continue;
    members.push({ tag: "field", name, value });
  }
  let result: Expr = { ...module.result, members };
  if (members.length === 0) {
    result = unit(module.result.span);
  } else if (generatedDeclarations.length > 0) {
    result = {
      tag: "block",
      declarations: generatedDeclarations,
      result,
      span: module.result.span,
    };
  }
  let declarations = module.declarations;
  if (fullyStaged) {
    declarations = module.declarations.filter((declaration) =>
      !stagedDeclarations.has(declaration)
    );
  }
  return {
    module: { ...module, declarations, result },
    exports: [...exportedFields.values()],
    shapes: generatedShapes,
  };
}

interface StagedExpression {
  readonly expression: Expr | null;
  readonly folded: boolean;
  readonly value?: Value;
}

function stageExpression(
  expr: Expr,
  values: Env,
  imports: Imports,
): StagedExpression {
  try {
    const value = run(
      evaluate(
        expr,
        values,
        evaluationRuntime(imports, "runtime"),
      ),
    );
    const expression = expressionOf(value, expr.span);
    if (expression !== null) return { expression, folded: true, value };
    if (compileTimeOnly(value)) {
      return { expression: null, folded: true, value };
    }
    return { expression: expr, folded: false, value };
  } catch (error) {
    if (error instanceof BlotError) {
      return { expression: expr, folded: false };
    }
    throw error;
  }
}

function compileTimeOnly(value: Value): boolean {
  switch (value.tag) {
    case "range":
    case "union":
    case "unbounded":
    case "arrow":
    case "type-variable":
    case "forall":
    case "effect":
    case "extended":
      return true;
    case "sealed":
      return compileTimeOnly(value.inner);
    case "shape":
      return [...value.fields.values()].every(compileTimeOnly);
    case "array":
      return value.elements.every(compileTimeOnly);
    default:
      return false;
  }
}

function expressionOf(value: Value, span: Span): Expr | null {
  switch (value.tag) {
    case "int":
      if (
        value.value < -0x8000000000000000n ||
        value.value > 0x7fffffffffffffffn
      ) {
        return null;
      }
      return { tag: "int", value: value.value, span };
    case "text":
      return { tag: "text", value: value.value, span };
    case "unit":
      return unit(span);
    case "tag": {
      const tag: Expr = { tag: "tag", name: value.name, span };
      if (value.payload === null) return tag;
      const payload = expressionOf(value.payload, span);
      if (payload === null) return null;
      return { tag: "apply", fn: tag, arg: payload, span };
    }
    case "array": {
      const elements: { spread: boolean; value: Expr }[] = [];
      for (const element of value.elements) {
        const expression = expressionOf(element, span);
        if (expression === null) return null;
        elements.push({ spread: false, value: expression });
      }
      return { tag: "array", elements, span };
    }
    case "shape": {
      const members: ShapeMember[] = [];
      for (const [name, member] of value.fields) {
        const expression = expressionOf(member, span);
        if (expression === null) return null;
        members.push({ tag: "field", name, value: expression });
      }
      return { tag: "shape", members, span };
    }
    default:
      return null;
  }
}

function unit(span: Span): Expr {
  return { tag: "unit", span };
}

function runtimeBinding(name: string, value: Expr): Decl {
  return {
    tag: "binding",
    kind: "let",
    pattern: {
      tag: "name",
      name,
      qualifier: "none",
      span: value.span,
    },
    value,
    span: value.span,
  };
}

function variable(name: string, span: Span): Expr {
  return { tag: "var", name, span };
}
