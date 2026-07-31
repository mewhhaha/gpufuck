// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// CST -> AST.
//
// Two jobs beyond shape translation:
//
//   1. fold flat operator chains into trees (delegated to fixity.ts);
//   2. reclassify a lambda's head as a pattern. The grammar parses that head as
//      an ordinary `postfix_expression` because sharing the operand prefix is
//      what lets the parser defer the lambda-versus-expression decision to
//      `=>`. Reclassification happens here, on the lowered tree, rather than as
//      a second walk over the CST.

import type {
  Arm,
  ArrayElement,
  Associativity,
  Branch,
  Decl,
  Expr,
  Fixity,
  Module,
  Pattern,
  Qualifier,
  ShapeMember,
  ShapePatternField,
  Span,
} from "./ast.ts";
import { buildFixityTable, type ChainStep, foldChain, targetExpr } from "./fixity.ts";
import { expect, fail } from "../diagnostic.ts";

// A structural view of baba's cursors. The generated types are a union of one
// interface per rule, which is exactly wrong for generic traversal: every
// helper here walks rules it cannot name in advance. Narrowing happens on
// `name`, so the precise types would be re-widened immediately anyway.

export interface TokenCursor {
  readonly type: "token";
  readonly kind: string;
  readonly text: string;
  readonly span: Span;
}

export interface Rule {
  readonly type: "rule";
  readonly name: string;
  readonly span: Span;
  child(index: number): Cursor | undefined;
  children(): readonly Cursor[];
  field(name: string): unknown;
}

type Cursor = Rule | TokenCursor;

function isRule(cursor: Cursor): cursor is Rule {
  return cursor.type === "rule";
}

function asRule(cursor: Cursor | null | undefined, name: string): Rule {
  expect(cursor !== null && cursor !== undefined, `missing ${name}`);
  expect(isRule(cursor), `expected rule ${name}, found a token`);
  return cursor;
}

function field(rule: Rule, name: string): Cursor | null {
  const value = rule.field(name);
  if (value === undefined || value === null) return null;
  expect(!Array.isArray(value), `field ${name} of ${rule.name} is an array`);
  return value as Cursor;
}

function required(rule: Rule, name: string): Cursor {
  const value = field(rule, name);
  expect(value !== null, `${rule.name} has no ${name}`);
  return value;
}

function fieldList(rule: Rule, name: string): readonly Cursor[] {
  const value = rule.field(name);
  if (value === undefined || value === null) return [];
  expect(Array.isArray(value), `field ${name} of ${rule.name} is not an array`);
  // An optional separated list — `(array_element % ",")?` — yields one empty
  // slot when it matched nothing, rather than no slots. The hole is the
  // information "there were none", so dropping it is reading the field, not
  // defaulting past a missing one. `[]` and `()` are the two forms that hit it.
  return (value as readonly (Cursor | null)[]).filter((entry) =>
    entry !== null && entry !== undefined
  ) as readonly Cursor[];
}

/** Descends through wrapper rules — `value`, `pattern_core`, `field_name` — to a token. */
function tokenOf(cursor: Cursor): TokenCursor {
  let current = cursor;
  while (isRule(current)) {
    const first = current.child(0);
    expect(first !== undefined, `rule ${current.name} has no child`);
    current = first;
  }
  return current;
}

/** Unwraps a rule that exists only to name an alternation. */
function unwrap(cursor: Cursor): Cursor {
  expect(isRule(cursor), "expected a rule to unwrap");
  const first = cursor.child(0);
  expect(first !== undefined, `rule ${cursor.name} has no child`);
  return first;
}

function textOf(source: string, span: Span): string {
  return source.slice(span.start, span.end);
}

function decodeText(literal: string, span: Span): string {
  const body = literal.slice(1, -1);
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== "\\") {
      result += body[index];
      continue;
    }
    index += 1;
    const escape = body[index];
    if (escape === "n") result += "\n";
    else if (escape === "t") result += "\t";
    else if (escape === "r") result += "\r";
    else if (escape === '"') result += '"';
    else if (escape === "\\") result += "\\";
    else fail("BLOT_BAD_ESCAPE", `Unknown escape \`\\${escape}\`.`, span);
  }
  return result;
}

export function lowerModule(root: Rule, source: string): Module {
  expect(root.name === "program", "root is not a program");

  const headerCursor = field(root, "header");
  const parameter = headerCursor === null ? null : lowerPattern(
    asRule(
      field(asRule(headerCursor, "module_header"), "parameter"),
      "parameter",
    ),
  );

  const operatorsCursor = field(root, "operators");
  const fixities = operatorsCursor === null
    ? []
    : fieldList(asRule(operatorsCursor, "operator_section"), "declarations")
      .map((cursor) => lowerFixity(asRule(cursor, "fixity_declaration"), source));

  const table = buildFixityTable(fixities);
  const context: Context = {
    source,
    table,
    loop: null,
    escapeBoundary: "none",
  };

  const declarations = fieldList(root, "declarations")
    .map((cursor) => unwrap(cursor));
  const last = declarations.at(-1);
  if (last === undefined || asRule(last, "declaration").name !== "result") {
    fail(
      "BLOT_MISSING_RESULT",
      "A module ends with `return expr;`.",
      root.span,
    );
  }
  const statements = declarations.slice(0, -1);
  const resultRule = asRule(last, "result");
  let result = lowerValue(
    asRule(field(resultRule, "value"), "value"),
    context,
  );
  let loweredDeclarations: readonly Decl[];
  if (statementsNeedControlLowering(statements)) {
    result = resolveControlSequence(statements, result, context, root.span);
    loweredDeclarations = [];
  } else {
    loweredDeclarations = statements.map((cursor) =>
      lowerDecl(asRule(cursor, "declaration"), context)
    );
  }
  return {
    parameter,
    fixities,
    declarations: loweredDeclarations,
    result,
    span: root.span,
  };
}

interface Context {
  readonly source: string;
  readonly table: ReturnType<typeof buildFixityTable>;
  readonly loop: {
    readonly tag: "control";
    readonly carried: readonly string[];
    readonly breakConstructor: string;
  } | null;
  readonly escapeBoundary: "none" | "value-condition";
}

function statementRule(cursor: Cursor): Rule {
  const rule = asRule(cursor, "statement");
  if (rule.name === "statement" || rule.name === "declaration") {
    return asRule(unwrap(rule), "statement");
  }
  return rule;
}

function conditionalStatementBody(rule: Rule): Rule {
  return asRule(field(rule, "body"), "conditional statement");
}

function nestedStatementLists(rule: Rule): readonly (readonly Cursor[])[] {
  if (rule.name === "iteration") {
    return [fieldList(rule, "body")];
  }
  if (rule.name !== "conditional_statement") return [];

  const body = conditionalStatementBody(rule);
  if (body.name === "conditional_statement_guard") {
    return [fieldList(body, "alternative")];
  }
  expect(
    body.name === "conditional_statement_branches",
    `unknown conditional statement ${body.name}`,
  );
  const nested: (readonly Cursor[])[] = [
    fieldList(body, "consequence"),
  ];
  for (const alternative of fieldList(body, "alternatives")) {
    nested.push(
      fieldList(
        asRule(
          alternative,
          "conditional_statement_else_if_clause",
        ),
        "consequence",
      ),
    );
  }
  const fallback = field(body, "fallback");
  if (fallback !== null) {
    nested.push(
      fieldList(
        asRule(fallback, "conditional_statement_else_clause"),
        "alternative",
      ),
    );
  }
  return nested;
}

function statementsNeedControlLowering(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "result" || rule.name === "breaking") return true;
    if (
      rule.name === "conditional_statement" &&
      conditionalStatementBody(rule).name === "conditional_statement_guard"
    ) {
      return true;
    }
    if (rule.name === "iteration") {
      if (statementsContainReturn(fieldList(rule, "body"))) return true;
      continue;
    }
    for (const nested of nestedStatementLists(rule)) {
      if (statementsNeedControlLowering(nested)) return true;
    }
  }
  return false;
}

function statementsContainReturn(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "result") return true;
    for (const nested of nestedStatementLists(rule)) {
      if (statementsContainReturn(nested)) return true;
    }
  }
  return false;
}

function statementsContainBreak(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "breaking") return true;
    if (rule.name === "iteration") continue;
    for (const nested of nestedStatementLists(rule)) {
      if (statementsContainBreak(nested)) return true;
    }
  }
  return false;
}

function statementsCanContinue(cursors: readonly Cursor[]): boolean {
  for (const cursor of cursors) {
    const rule = statementRule(cursor);
    if (rule.name === "result" || rule.name === "breaking") return false;
    if (rule.name !== "conditional_statement") continue;

    const body = conditionalStatementBody(rule);
    if (body.name === "conditional_statement_guard") continue;
    expect(
      body.name === "conditional_statement_branches",
      `unknown conditional statement ${body.name}`,
    );
    const fallback = field(body, "fallback");
    if (fallback === null) continue;
    const everyBranchLeaves = nestedStatementLists(rule).every((nested) =>
      !statementsCanContinue(nested)
    );
    if (everyBranchLeaves) return false;
  }
  return true;
}

interface ControlConstructors {
  readonly return: string;
  readonly continue: string;
}

// gpufuck gives each constructor one monomorphic payload type. A boundary-
// specific, source-unspellable name keeps unrelated continuation payloads from
// being unified, and the wrapper keeps `()` distinct from a payloadless tag.
function syntheticConstructor(label: string, span: Span): string {
  return `${label}$${span.start}$${span.end}`;
}

function controlPayload(value: Expr, span: Span): Expr {
  return {
    tag: "shape",
    members: [{ tag: "field", name: "value", value }],
    span,
  };
}

/** Like `controlPayloadPattern`, but binds a whole rebound-name record. */
function controlStatePattern(
  carried: readonly string[],
  span: Span,
): Pattern {
  return {
    tag: "shape",
    fields: [{ name: "value", pattern: loopPattern(carried, span) }],
    span,
  };
}

function controlPayloadPattern(name: string | null, span: Span): Pattern {
  let pattern: Pattern = { tag: "wildcard", span };
  if (name !== null) {
    pattern = {
      tag: "name",
      name,
      qualifier: "none",
      span,
    };
  }
  return {
    tag: "shape",
    fields: [{ name: "value", pattern }],
    span,
  };
}

function controlOutcome(
  constructor: string,
  value: Expr,
  span: Span,
): Expr {
  return {
    tag: "apply",
    fn: { tag: "tag", name: constructor, span },
    arg: controlPayload(value, span),
    span,
  };
}

function resolveControlSequence(
  cursors: readonly Cursor[],
  normalResult: Expr,
  context: Context,
  span: Span,
): Expr {
  const constructors: ControlConstructors = {
    return: syntheticConstructor("FunctionReturn", span),
    continue: syntheticConstructor("FunctionContinue", span),
  };
  const outcome = lowerControlOutcome(
    cursors,
    context,
    span,
    normalResult,
    constructors,
  );
  const arms: Arm[] = [];
  if (statementsContainReturn(cursors)) {
    arms.push({
      pattern: {
        tag: "constructor",
        name: constructors.return,
        payload: controlPayloadPattern("returned$", span),
        span,
      },
      body: { tag: "var", name: "returned$", span },
    });
  }
  if (statementsCanContinue(cursors)) {
    arms.push({
      pattern: {
        tag: "constructor",
        name: constructors.continue,
        payload: controlPayloadPattern("continued$", span),
        span,
      },
      body: { tag: "var", name: "continued$", span },
    });
  }
  return {
    tag: "case",
    target: outcome,
    arms,
    span,
  };
}

function lowerControlOutcome(
  cursors: readonly Cursor[],
  context: Context,
  span: Span,
  continueValue: Expr,
  constructors: ControlConstructors,
): Expr {
  const first = cursors[0];
  if (first === undefined) {
    return controlOutcome(constructors.continue, continueValue, span);
  }
  const rule = statementRule(first);
  if (rule.name === "result") {
    if (context.escapeBoundary === "value-condition") {
      fail(
        "BLOT_RETURN_IN_VALUE_CONDITION",
        "`return` cannot escape a value-producing `if` or `case`.",
        rule.span,
      );
    }
    return controlOutcome(
      constructors.return,
      lowerValue(asRule(field(rule, "value"), "value"), context),
      rule.span,
    );
  }
  if (
    rule.name === "breaking" &&
    context.loop !== null &&
    context.loop.tag === "control"
  ) {
    return controlOutcome(
      context.loop.breakConstructor,
      loopState(context.loop.carried, rule.span),
      rule.span,
    );
  }

  const remaining = cursors.slice(1);
  if (rule.name === "conditional_statement") {
    const body = conditionalStatementBody(rule);
    if (body.name === "conditional_statement_guard") {
      const alternative = fieldList(body, "alternative");
      if (statementsCanContinue(alternative)) {
        fail(
          "BLOT_GUARD_MAY_CONTINUE",
          "The `else` branch of `if let` must `return` or `break`.",
          body.span,
        );
      }
      return {
        tag: "case",
        target: lowerValue(asRule(field(body, "value"), "value"), context),
        arms: [
          {
            pattern: lowerPattern(
              asRule(field(body, "pattern"), "pattern"),
            ),
            body: lowerControlOutcome(
              remaining,
              context,
              span,
              continueValue,
              constructors,
            ),
          },
          {
            pattern: { tag: "wildcard", span: body.span },
            body: lowerControlOutcome(
              alternative,
              context,
              body.span,
              { tag: "unit", span: body.span },
              constructors,
            ),
          },
        ],
        span: rule.span,
      };
    }
    expect(
      body.name === "conditional_statement_branches",
      `unknown conditional statement ${body.name}`,
    );
    // What a branch produces when it falls through. The names it rebound have
    // to ride across the rejoin, or the statements after the conditional read
    // the value from before it — which is how `if c then do n := n + 1; end;`
    // inside a `for` silently counted nothing.
    const rebound = reboundNames(nestedStatementLists(rule).flat());
    let branchContinue: Expr = loopState(rebound, rule.span);
    let branchConstructors = constructors;
    let branchContext = context;
    if (remaining.length === 0) branchContinue = continueValue;
    if (remaining.length > 0) {
      branchConstructors = {
        return: syntheticConstructor("ConditionalReturn", rule.span),
        continue: syntheticConstructor("ConditionalContinue", rule.span),
      };
      if (context.loop !== null && context.loop.tag === "control") {
        branchContext = {
          ...context,
          loop: {
            ...context.loop,
            breakConstructor: syntheticConstructor(
              "ConditionalBreak",
              rule.span,
            ),
          },
        };
      }
    }
    const conditional = lowerControlConditional(
      body,
      branchContext,
      branchContinue,
      branchConstructors,
    );
    if (remaining.length === 0) return conditional;
    const arms: Arm[] = [];
    if (statementsContainReturn([rule])) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: branchConstructors.return,
          payload: controlPayloadPattern("returned$", rule.span),
          span: rule.span,
        },
        body: controlOutcome(
          constructors.return,
          { tag: "var", name: "returned$", span: rule.span },
          rule.span,
        ),
      });
    }
    if (statementsCanContinue([rule])) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: branchConstructors.continue,
          payload: controlStatePattern(rebound, rule.span),
          span: rule.span,
        },
        body: lowerControlOutcome(
          remaining,
          context,
          span,
          continueValue,
          constructors,
        ),
      });
    }
    if (
      context.loop !== null &&
      context.loop.tag === "control" &&
      branchContext.loop !== null &&
      branchContext.loop.tag === "control" &&
      statementsContainBreak([rule])
    ) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: branchContext.loop.breakConstructor,
          payload: controlPayloadPattern("stopped$", rule.span),
          span: rule.span,
        },
        body: controlOutcome(
          context.loop.breakConstructor,
          { tag: "var", name: "stopped$", span: rule.span },
          rule.span,
        ),
      });
    }
    return {
      tag: "case",
      target: conditional,
      arms,
      span: rule.span,
    };
  }
  if (rule.name === "iteration") {
    const loop = lowerControlLoop(rule, context);
    const arms: Arm[] = [];
    if (loop.returns) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: loop.constructors.return,
          payload: controlPayloadPattern("returned$", rule.span),
          span: rule.span,
        },
        body: controlOutcome(
          constructors.return,
          { tag: "var", name: "returned$", span: rule.span },
          rule.span,
        ),
      });
    }
    arms.push({
      pattern: {
        tag: "constructor",
        name: loop.constructors.continue,
        payload: controlPayloadPattern("loopState$", rule.span),
        span: rule.span,
      },
      body: {
        tag: "block",
        declarations: [{
          tag: "binding",
          kind: "let",
          pattern: loop.pattern,
          value: {
            tag: "var",
            name: "loopState$",
            span: rule.span,
          },
          span: rule.span,
        }],
        result: lowerControlOutcome(
          remaining,
          context,
          span,
          continueValue,
          constructors,
        ),
        span: rule.span,
      },
    });
    return {
      tag: "case",
      target: loop.value,
      arms,
      span: rule.span,
    };
  }

  return {
    tag: "block",
    declarations: [lowerDecl(rule, context)],
    result: lowerControlOutcome(
      remaining,
      context,
      span,
      continueValue,
      constructors,
    ),
    span: {
      start: rule.span.start,
      end: span.end,
    },
  };
}

function lowerControlConditional(
  body: Rule,
  context: Context,
  continueValue: Expr,
  constructors: ControlConstructors,
): Expr {
  const branches: Branch[] = [{
    condition: lowerExpression(
      asRule(field(body, "condition"), "condition"),
      context,
    ),
    consequence: lowerControlOutcome(
      fieldList(body, "consequence"),
      context,
      body.span,
      continueValue,
      constructors,
    ),
  }];
  for (const cursor of fieldList(body, "alternatives")) {
    const clause = asRule(
      cursor,
      "conditional_statement_else_if_clause",
    );
    branches.push({
      condition: lowerExpression(
        asRule(field(clause, "condition"), "condition"),
        context,
      ),
      consequence: lowerControlOutcome(
        fieldList(clause, "consequence"),
        context,
        clause.span,
        continueValue,
        constructors,
      ),
    });
  }
  let fallback = controlOutcome(
    constructors.continue,
    continueValue,
    body.span,
  );
  const fallbackCursor = field(body, "fallback");
  if (fallbackCursor !== null) {
    const clause = asRule(
      fallbackCursor,
      "conditional_statement_else_clause",
    );
    fallback = lowerControlOutcome(
      fieldList(clause, "alternative"),
      context,
      clause.span,
      continueValue,
      constructors,
    );
  }
  return { tag: "if", branches, fallback, span: body.span };
}

function lowerFixity(rule: Rule, source: string): Fixity {
  const associativity = readAssociativity(
    tokenOf(required(rule, "associativity")).text,
    rule.span,
  );
  const operator = tokenOf(required(rule, "operator")).text;
  const precedence = Number(tokenOf(required(rule, "precedence")).text);
  const target = lowerQualifiedName(
    asRule(field(rule, "target"), "target"),
    source,
  );
  return { operator, associativity, precedence, target, span: rule.span };
}

function readAssociativity(text: string, span: Span): Associativity {
  if (text === "infixl") return "left";
  if (text === "infixr") return "right";
  if (text === "infix") return "none";
  if (text === "prefix") return "prefix";
  fail("BLOT_BAD_FIXITY", `Unknown associativity \`${text}\`.`, span);
}

function lowerQualifiedName(rule: Rule, _source: string): readonly string[] {
  const root = tokenOf(required(rule, "root")).text;
  const rest = fieldList(rule, "rest").map((part) =>
    tokenOf(required(asRule(part, "qualified_name_part"), "name")).text
  );
  return [root, ...rest];
}

/**
 * `for source do … end;` becomes the recursion behind `iterate`.
 *
 * There is no loop in the AST, no loop in the evaluator, and no loop in the
 * backend, because a loop is a fold and `rec`/`case` already express the fold.
 * The construct emits that recursion directly, so its meaning does not depend
 * on a prelude name being in scope.
 *
 * The names the body rebinds with `:=` are the accumulator. Only a direct `:=`
 * counts: a `let` inside the body is a local the next iteration cannot see,
 * which is what makes the escaping set syntactic.
 *
 *   for let n = src do total := total + n; end;
 *
 * The resulting recursive step destructures `{ .total; }`, visits one item,
 * rebuilds that state, and recurs with the iterator's next state.
 */
/**
 * Can this pattern fail to match?
 *
 * A binder that cannot fail is a `let`; one that can becomes the `case` that
 * makes `for #Some x in src` a filter. Aggregates are refutable exactly when a
 * part of them is — an array pattern also constrains the length, so it always
 * can fail.
 */
function refutable(pattern: Pattern): boolean {
  switch (pattern.tag) {
    case "name":
    case "wildcard":
      return false;
    case "tuple":
      return pattern.elements.some(refutable);
    case "shape":
      return pattern.fields.some((field) => refutable(field.pattern));
    default:
      return true;
  }
}

type LoopBody =
  | {
    readonly tag: "plain";
    readonly declarations: readonly Decl[];
    readonly carried: readonly string[];
  }
  | {
    readonly tag: "control";
    readonly outcome: Expr;
    readonly carried: readonly string[];
    readonly constructors: ControlConstructors;
    readonly resultConstructors: ControlConstructors;
    readonly breakConstructor: string;
    readonly returns: boolean;
    readonly continues: boolean;
    readonly breaks: boolean;
  };

interface LoweredLoop {
  readonly pattern: Pattern;
  readonly value: Expr;
}

interface LoweredControlLoop extends LoweredLoop {
  readonly constructors: ControlConstructors;
  readonly returns: boolean;
}

/** The destructuring counterpart of `loopState`. */
function loopPattern(carried: readonly string[], span: Span): Pattern {
  if (carried.length === 0) return { tag: "wildcard", span };
  return {
    tag: "shape",
    fields: carried.map((field) => ({
      name: field,
      pattern: { tag: "name" as const, name: field, qualifier: "none" as const, span },
    })),
    span,
  };
}

function loopState(carried: readonly string[], span: Span): Expr {
  if (carried.length === 0) return { tag: "unit", span };
  return {
    tag: "shape",
    members: carried.map((field) => ({
      tag: "field",
      name: field,
      value: { tag: "var", name: field, span },
    })),
    span,
  };
}

function desugarLoop(
  binder: Pattern | null,
  source: Expr,
  body: LoopBody,
  completion:
    | { readonly tag: "iterate" }
    | { readonly tag: "control" },
  span: Span,
): LoweredLoop {
  // Both shapes name their accumulator the same way: from the `:=` the CST
  // holds. Recovering it from the lowered body instead would miss a rebinding
  // inside a statement conditional, which lowers to a `binding` rather than a
  // `shadow` — by then lowering has erased the distinction.
  const carried = body.carried;

  const name = (text: string): Expr => ({ tag: "var", name: text, span });
  const state = loopState(carried, span);
  const statePattern: Pattern = carried.length === 0 ? { tag: "wildcard", span } : {
    tag: "shape",
    fields: carried.map((field) => ({
      name: field,
      pattern: {
        tag: "name" as const,
        name: field,
        qualifier: "none" as const,
        span,
      },
    })),
    span,
  };

  // Named so they cannot collide with anything a program can write: `$` is in
  // the operator class, so no identifier contains one.
  const carriedIn = "loop$";
  const pairIn = "pair$";

  // The element is `pair$.0`, projected where it is used rather than bound to a
  // name of its own — one fewer synthetic binding for the backend to see.
  const element: Expr = {
    tag: "field",
    target: { tag: "var", name: pairIn, span },
    name: "0",
    span,
  };

  const declarations: Decl[] = [];
  if (carried.length > 0) {
    declarations.push({
      tag: "binding",
      kind: "let",
      pattern: statePattern,
      value: name(carriedIn),
      span,
    });
  }
  // An irrefutable binder is a `let`. A refutable one — `#Some x in src` — is
  // a `case` whose other arm hands the accumulator back untouched, so an
  // element that does not match skips the iteration instead of failing it.
  // That is the filter, and it costs one arm.
  const filtering = binder !== null && refutable(binder);
  if (binder !== null && !filtering) {
    declarations.push({
      tag: "binding",
      kind: "let",
      pattern: binder,
      value: element,
      span,
    });
  }
  if (body.tag === "plain") declarations.push(...body.declarations);

  let stepResult = state;
  if (body.tag === "control") stepResult = body.outcome;
  const step: Expr = {
    tag: "block",
    declarations,
    result: stepResult,
    span,
  };
  let skipped: Expr = { tag: "unit", span };
  if (body.tag === "control") {
    skipped = controlOutcome(
      body.constructors.continue,
      name(carriedIn),
      span,
    );
  }
  if (body.tag === "plain") skipped = name(carriedIn);
  const visited: Expr = filtering && binder !== null
    ? {
      tag: "case",
      target: element,
      arms: [
        { pattern: binder, body: step },
        {
          pattern: { tag: "wildcard", span },
          body: skipped,
        },
      ],
      span,
    }
    : step;

  // The recursion, inline. `for` names nothing: it emits the same `rec`/`case`
  // that `iterate` contains rather than calling it, so a module that loops over
  // an iterator it wrote itself needs nothing in scope. Looping over an *array*
  // still needs `Iter.items`, but that is a call the program writes and can see.
  const iterIn = "iter$";
  const stateIn = "state$";
  const goIn = "go$";
  const at = (target: Expr, field: string): Expr => ({
    tag: "field",
    target,
    name: field,
    span,
  });
  const continueWith = (nextIterator: Expr, nextState: Expr): Expr => ({
    tag: "apply",
    fn: name(goIn),
    arg: {
      tag: "tuple",
      elements: [nextIterator, nextState],
      span,
    },
    span,
  });
  const nextIterator = at(name(pairIn), "1");
  const resolveVisitOutcome = (outcome: Expr): Expr => {
    expect(body.tag === "control", "plain loop used control outcome");
    const arms: Arm[] = [];
    if (body.returns) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: body.constructors.return,
          payload: controlPayloadPattern("returned$", span),
          span,
        },
        body: controlOutcome(
          body.resultConstructors.return,
          name("returned$"),
          span,
        ),
      });
    }
    if (body.continues) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: body.constructors.continue,
          payload: controlPayloadPattern("continued$", span),
          span,
        },
        body: continueWith(nextIterator, name("continued$")),
      });
    }
    if (completion.tag === "control" && body.breaks) {
      arms.push({
        pattern: {
          tag: "constructor",
          name: body.breakConstructor,
          payload: controlPayloadPattern("stopped$", span),
          span,
        },
        body: controlOutcome(
          body.resultConstructors.continue,
          name("stopped$"),
          span,
        ),
      });
    }
    return { tag: "case", target: outcome, arms, span };
  };
  let completedVisit = continueWith(nextIterator, visited);
  if (body.tag === "control") {
    completedVisit = resolveVisitOutcome(visited);
  }

  let exhausted: Expr = name(carriedIn);
  if (body.tag === "control") {
    exhausted = controlOutcome(
      body.resultConstructors.continue,
      name(carriedIn),
      span,
    );
  }
  const go: Expr = {
    tag: "rec",
    lambda: {
      tag: "lambda",
      parameter: {
        tag: "tuple",
        elements: [
          { tag: "name", name: stateIn, qualifier: "none", span },
          { tag: "name", name: carriedIn, qualifier: "none", span },
        ],
        span,
      },
      body: {
        tag: "case",
        target: {
          tag: "apply",
          fn: at(name(iterIn), "step"),
          arg: name(stateIn),
          span,
        },
        arms: [
          {
            pattern: { tag: "constructor", name: "None", payload: null, span },
            body: exhausted,
          },
          {
            pattern: {
              tag: "constructor",
              name: "Some",
              payload: { tag: "name", name: pairIn, qualifier: "none", span },
              span,
            },
            body: completedVisit,
          },
        ],
        span,
      },
      span,
    },
    span,
  };

  return {
    pattern: statePattern,
    value: {
      tag: "block",
      declarations: [
        {
          tag: "binding",
          kind: "let",
          pattern: { tag: "name", name: iterIn, qualifier: "none", span },
          value: source,
          span,
        },
        {
          tag: "binding",
          kind: "let",
          pattern: { tag: "name", name: goIn, qualifier: "none", span },
          value: go,
          span,
        },
      ],
      result: {
        tag: "apply",
        fn: name(goIn),
        arg: {
          tag: "tuple",
          elements: [at(name(iterIn), "state"), state],
          span,
        },
        span,
      },
      span,
    },
  };
}

/**
 * The names a statement stream rebinds with `:=`.
 *
 * Recursive through nested statement lists, because a statement conditional is
 * part of the same stream: `if c then do n := n + 1; end;` rebinds `n` for
 * everything after it, and a loop containing that rebinds `n` per iteration.
 *
 * `:=` is the only form collected, and that is what makes this well defined.
 * A rebinding requires the name to be in scope already and to keep its type
 * (LANGUAGE.md 4.3), so there is always an outer binding to hand the value back
 * to and both paths agree on what it holds. A `let` introduces a new name with
 * a possibly new type and must not escape its branch — a name bound only when a
 * condition happened to hold is exactly what must not leak.
 */
function reboundNames(statements: readonly Cursor[]): readonly string[] {
  const rebound: string[] = [];
  const visit = (cursors: readonly Cursor[]): void => {
    for (const cursor of cursors) {
      const declaration = statementRule(cursor);
      if (
        declaration.name === "rebinding" &&
        tokenOf(required(declaration, "arrow")).text === ":="
      ) {
        const name = tokenOf(required(declaration, "name")).text;
        if (!rebound.includes(name)) rebound.push(name);
        continue;
      }
      // Not into a nested `for`. Its own desugaring already threads what it
      // rebinds into this stream as a `let`, and the names it introduces for
      // itself are not this scope's to carry.
      if (declaration.name === "iteration") continue;
      for (const nested of nestedStatementLists(declaration)) visit(nested);
    }
  };
  visit(statements);
  return rebound;
}

const carriedNames = reboundNames;

function lowerControlLoop(
  rule: Rule,
  context: Context,
): LoweredControlLoop {
  const statements = fieldList(rule, "body");
  const carried = carriedNames(statements);
  const constructors: ControlConstructors = {
    return: syntheticConstructor("LoopReturn", rule.span),
    continue: syntheticConstructor("LoopContinue", rule.span),
  };
  const bodyConstructors: ControlConstructors = {
    return: syntheticConstructor("LoopBodyReturn", rule.span),
    continue: syntheticConstructor("LoopBodyContinue", rule.span),
  };
  const breakConstructor = syntheticConstructor("LoopBreak", rule.span);
  const returns = statementsContainReturn(statements);
  const continues = statementsCanContinue(statements);
  const breaks = statementsContainBreak(statements);
  const bodyContext: Context = {
    ...context,
    loop: { tag: "control", carried, breakConstructor },
  };
  const outcome = lowerControlOutcome(
    statements,
    bodyContext,
    rule.span,
    loopState(carried, rule.span),
    bodyConstructors,
  );

  expect(rule.name === "iteration", `expected a loop, got ${rule.name}`);
  const head = lowerValue(asRule(field(rule, "head"), "value"), context);
  const drawn = field(rule, "drawn");
  if (drawn === null) {
    const loop = desugarLoop(
      null,
      head,
      {
        tag: "control",
        outcome,
        carried,
        constructors: bodyConstructors,
        resultConstructors: constructors,
        breakConstructor,
        returns,
        continues,
        breaks,
      },
      { tag: "control" },
      rule.span,
    );
    return { ...loop, constructors, returns };
  }
  const loop = desugarLoop(
    patternFromExpr(head),
    lowerValue(
      asRule(
        required(asRule(drawn, "iteration_source"), "source"),
        "value",
      ),
      context,
    ),
    {
      tag: "control",
      outcome,
      carried,
      constructors: bodyConstructors,
      resultConstructors: constructors,
      breakConstructor,
      returns,
      continues,
      breaks,
    },
    { tag: "control" },
    rule.span,
  );
  return { ...loop, constructors, returns };
}

function lowerDecl(rule: Rule, context: Context): Decl {
  if (rule.name === "binding") {
    const kind = tokenOf(required(rule, "kind")).text;
    expect(
      kind === "let" || kind === "const" || kind === "sig",
      `unknown binding kind ${kind}`,
    );
    return {
      tag: "binding",
      kind,
      pattern: lowerPattern(asRule(field(rule, "pattern"), "pattern")),
      value: lowerValue(asRule(field(rule, "value"), "value"), context),
      span: rule.span,
    };
  }
  if (rule.name === "iteration") {
    const statements = fieldList(rule, "body");
    if (statementsNeedControlLowering(statements)) {
      const loop = lowerControlLoop(rule, context);
      expect(!loop.returns, "a local control loop contains a return");
      return {
        tag: "binding",
        kind: "let",
        pattern: loop.pattern,
        value: {
          tag: "case",
          target: loop.value,
          arms: [{
            pattern: {
              tag: "constructor",
              name: loop.constructors.continue,
              payload: controlPayloadPattern("loopState$", rule.span),
              span: rule.span,
            },
            body: { tag: "var", name: "loopState$", span: rule.span },
          }],
          span: rule.span,
        },
        span: rule.span,
      };
    }
    const carried = carriedNames(statements);
    const head = lowerValue(asRule(field(rule, "head"), "value"), context);
    const drawn = field(rule, "drawn");
    const body = statements.map((statement) => {
      const inner = asRule(unwrap(statement), "statement");
      return lowerDecl(inner, { ...context, loop: null });
    });
    let loop: LoweredLoop;
    if (drawn === null) {
      loop = desugarLoop(
        null,
        head,
        { tag: "plain", declarations: body, carried },
        { tag: "iterate" },
        rule.span,
      );
    } else {
      loop = desugarLoop(
        patternFromExpr(head),
        lowerValue(
          asRule(
            required(asRule(drawn, "iteration_source"), "source"),
            "value",
          ),
          context,
        ),
        { tag: "plain", declarations: body, carried },
        { tag: "iterate" },
        rule.span,
      );
    }
    return {
      tag: "binding",
      kind: "let",
      pattern: loop.pattern,
      value: loop.value,
      span: rule.span,
    };
  }
  if (rule.name === "breaking") {
    if (context.loop === null) {
      if (context.escapeBoundary === "value-condition") {
        fail(
          "BLOT_BREAK_IN_VALUE_CONDITION",
          "`break` cannot escape a value-producing `if` or `case`.",
          rule.span,
        );
      }
      fail(
        "BLOT_BREAK_OUTSIDE_LOOP",
        "`break` has no enclosing `for`.",
        rule.span,
      );
    }
    throw new Error("control break reached declaration lowering");
  }
  if (rule.name === "conditional_statement") {
    const body = conditionalStatementBody(rule);
    expect(
      body.name === "conditional_statement_branches",
      "`if let` reached declaration lowering",
    );
    // Names the branches rebind escape the conditional. A branch is a scope for
    // `let`, which introduces a name, but not for `:=`, which hands an existing
    // one back — so a statement conditional can compute, and a `:=` inside one
    // is not silently dropped.
    const rebound = reboundNames(nestedStatementLists(rule).flat());
    const branches: Branch[] = [{
      condition: lowerExpression(
        asRule(field(body, "condition"), "condition"),
        context,
      ),
      consequence: {
        tag: "block",
        declarations: fieldList(body, "consequence").map((statement) =>
          lowerDecl(asRule(unwrap(statement), "statement"), context)
        ),
        result: loopState(rebound, rule.span),
        span: rule.span,
      },
    }];
    for (const cursor of fieldList(body, "alternatives")) {
      const clause = asRule(
        cursor,
        "conditional_statement_else_if_clause",
      );
      branches.push({
        condition: lowerExpression(
          asRule(field(clause, "condition"), "condition"),
          context,
        ),
        consequence: {
          tag: "block",
          declarations: fieldList(clause, "consequence").map((statement) =>
            lowerDecl(asRule(unwrap(statement), "statement"), context)
          ),
          result: loopState(rebound, clause.span),
          span: clause.span,
        },
      });
    }
    // A missing `else` is the pass-through arm: it hands back the names as
    // they already are, which is what makes a one-branch rebinding mean what it
    // reads as.
    let fallback: Expr = loopState(rebound, rule.span);
    const fallbackCursor = field(body, "fallback");
    if (fallbackCursor !== null) {
      const clause = asRule(
        fallbackCursor,
        "conditional_statement_else_clause",
      );
      fallback = {
        tag: "block",
        declarations: fieldList(clause, "alternative").map((statement) =>
          lowerDecl(asRule(unwrap(statement), "statement"), context)
        ),
        result: loopState(rebound, clause.span),
        span: clause.span,
      };
    }
    return {
      tag: "binding",
      kind: "let",
      pattern: loopPattern(rebound, rule.span),
      value: {
        tag: "if",
        branches,
        fallback,
        span: rule.span,
      },
      span: rule.span,
    };
  }
  if (rule.name === "result") {
    if (context.escapeBoundary === "value-condition") {
      fail(
        "BLOT_RETURN_IN_VALUE_CONDITION",
        "`return` cannot escape a value-producing `if` or `case`.",
        rule.span,
      );
    }
    fail(
      "BLOT_RETURN_OUTSIDE_BODY",
      "`return` has no enclosing body.",
      rule.span,
    );
  }
  if (rule.name === "opening") {
    const mask = asRule(required(rule, "mask"), "open_mask");
    const mappings = fieldList(mask, "entries").map((cursor) => {
      const mapping = asRule(cursor, "open_mapping");
      const target = tokenOf(required(mapping, "target")).text;
      let loweredTarget: string | null = target;
      if (target === "_") loweredTarget = null;
      return {
        source: tokenOf(required(mapping, "source")).text,
        target: loweredTarget,
        span: mapping.span,
      };
    });
    return {
      tag: "open",
      mappings,
      value: lowerValue(asRule(field(rule, "value"), "value"), context),
      span: rule.span,
    };
  }
  if (rule.name === "rebinding") {
    const name = tokenOf(required(rule, "name")).text;
    const value = lowerValue(asRule(field(rule, "value"), "value"), context);
    if (tokenOf(required(rule, "arrow")).text === ":=") {
      return { tag: "shadow", name, value, span: rule.span };
    }
    // `x <- computation;` is `let x = computation ();`.
    //
    // Performing is an ordinary call in blot — the row is inferred, so there is
    // nothing for a `perform` form to declare — which leaves `<-` one honest
    // job: naming the result of a computation without spelling the `()`. That
    // is what "get input from an effect" needs and all it needs, so it is
    // surface syntax over application rather than a construct of its own.
    // Requiring the value to be nullary is the type system's business, and it
    // is what stops `<-` from being a second spelling for `let`.
    return {
      tag: "binding",
      kind: "let",
      pattern: { tag: "name", name, qualifier: "none", span: rule.span },
      value: {
        tag: "apply",
        fn: value,
        arg: { tag: "unit", span: rule.span },
        span: rule.span,
      },
      span: rule.span,
    };
  }
  fail(
    "BLOT_UNKNOWN_DECLARATION",
    `Unknown declaration \`${rule.name}\`.`,
    rule.span,
  );
}

// --- patterns ---------------------------------------------------------------

function readQualifier(text: string, span: Span): Qualifier {
  if (text === "!") return "linear";
  if (text === "?") return "affine";
  if (text === "&") return "borrow";
  fail(
    "BLOT_BAD_PATTERN_QUALIFIER",
    `\`${text}\` is not a pattern qualifier. Only \`!\`, \`?\`, and \`&\` are, and \`-\` before an integer literal.`,
    span,
  );
}

function lowerPattern(rule: Rule): Pattern {
  expect(
    rule.name === "binding_pattern",
    `expected binding_pattern, got ${rule.name}`,
  );
  const qualifierCursor = field(rule, "qualifier");
  const core = unwrap(asRule(field(rule, "value"), "pattern_core"));
  const qualifierText = qualifierCursor === null ? null : tokenOf(qualifierCursor).text;

  // `-` folds into the literal it negates rather than surviving as a qualifier.
  if (qualifierText === "-") {
    const token = core.type === "token" ? core : null;
    if (token === null || token.kind !== "INTEGER") {
      fail(
        "BLOT_BAD_NEGATION",
        "`-` in a pattern applies only to an integer literal.",
        rule.span,
      );
    }
    return { tag: "int", value: -BigInt(token.text), span: rule.span };
  }

  const qualifier: Qualifier = qualifierText === null
    ? "none"
    : readQualifier(qualifierText, rule.span);

  if (core.type === "token") {
    if (core.kind === "IDENT" || core.kind === "TYPE_IDENT") {
      // `_` is a name the grammar cannot distinguish from any other, so the
      // wildcard is recognized here instead of in the lexer.
      if (core.text === "_") return { tag: "wildcard", span: rule.span };
      return { tag: "name", name: core.text, qualifier, span: rule.span };
    }
    if (core.kind === "INTEGER") {
      return { tag: "int", value: BigInt(core.text), span: rule.span };
    }
    if (core.kind === "TEXT") {
      return {
        tag: "text",
        value: decodeText(core.text, rule.span),
        span: rule.span,
      };
    }
    fail("BLOT_BAD_PATTERN", `\`${core.text}\` is not a pattern.`, rule.span);
  }

  if (core.name === "unit_pattern") return { tag: "unit", span: rule.span };

  if (core.name === "tuple_pattern") {
    const first = lowerPattern(asRule(field(core, "first"), "first"));
    const rest = fieldList(core, "rest").map((c) => lowerPattern(asRule(c, "rest")));
    return { tag: "tuple", elements: [first, ...rest], span: rule.span };
  }

  if (core.name === "array_pattern") {
    return {
      tag: "array",
      elements: fieldList(core, "elements").map((c) => lowerPattern(asRule(c, "element"))),
      span: rule.span,
    };
  }

  if (core.name === "constructor_pattern") {
    const payloadCursor = field(core, "payload");
    return {
      tag: "constructor",
      name: tokenOf(required(core, "constructor")).text,
      payload: payloadCursor === null ? null : lowerPattern(asRule(payloadCursor, "payload")),
      span: rule.span,
    };
  }

  if (core.name === "shape_pattern") {
    const fields: ShapePatternField[] = fieldList(core, "fields").map((c) => {
      const member = asRule(c, "shape_pattern_field");
      const name = tokenOf(required(member, "name")).text;
      const valuePair = member.field("value");
      if (valuePair === null || valuePair === undefined) {
        // `{ .x; }` puns: the field binds a name of the same spelling.
        return {
          name,
          pattern: { tag: "name", name, qualifier: "none", span: member.span },
        };
      }
      expect(Array.isArray(valuePair), "shape pattern value is not a pair");
      const [, patternCursor] = valuePair as readonly Cursor[];
      return { name, pattern: lowerPattern(asRule(patternCursor, "pattern")) };
    });
    return { tag: "shape", fields, span: rule.span };
  }

  fail("BLOT_BAD_PATTERN", `\`${core.name}\` is not a pattern.`, rule.span);
}

/**
 * Reclassifies a lambda head. The grammar could not commit to "pattern" before
 * seeing `=>`, so the head arrives as an expression and is converted here.
 */
function patternFromExpr(expr: Expr): Pattern {
  if (expr.tag === "var") {
    if (expr.name === "_") return { tag: "wildcard", span: expr.span };
    return { tag: "name", name: expr.name, qualifier: "none", span: expr.span };
  }
  if (expr.tag === "unit") return { tag: "unit", span: expr.span };
  if (expr.tag === "int") {
    return { tag: "int", value: expr.value, span: expr.span };
  }
  if (expr.tag === "text") {
    return { tag: "text", value: expr.value, span: expr.span };
  }
  if (expr.tag === "tuple") {
    return {
      tag: "tuple",
      elements: expr.elements.map(patternFromExpr),
      span: expr.span,
    };
  }
  if (expr.tag === "array") {
    for (const element of expr.elements) {
      if (element.spread) {
        fail("BLOT_BAD_PARAMETER", "A parameter cannot spread.", expr.span);
      }
    }
    return {
      tag: "array",
      elements: expr.elements.map((element) => patternFromExpr(element.value)),
      span: expr.span,
    };
  }
  if (expr.tag === "shape") {
    const fields: ShapePatternField[] = expr.members.map((member) => {
      if (member.tag === "spread") {
        fail("BLOT_BAD_PARAMETER", "A parameter cannot spread.", expr.span);
      }
      return { name: member.name, pattern: patternFromExpr(member.value) };
    });
    return { tag: "shape", fields, span: expr.span };
  }
  if (expr.tag === "tag") {
    return {
      tag: "constructor",
      name: expr.name,
      payload: null,
      span: expr.span,
    };
  }
  if (expr.tag === "apply") {
    if (expr.fn.tag === "tag") {
      return {
        tag: "constructor",
        name: expr.fn.name,
        payload: patternFromExpr(expr.arg),
        span: expr.span,
      };
    }
    // `!x` and `&x` reach here as prefix-operator applications.
    if (expr.fn.tag === "intrinsic") {
      const qualifier = expr.fn.name === "@linear.own"
        ? "linear"
        : expr.fn.name === "@linear.maybe"
        ? "affine"
        : expr.fn.name === "@linear.borrow"
        ? "borrow"
        : null;
      if (qualifier !== null) {
        const inner = patternFromExpr(expr.arg);
        if (inner.tag !== "name") {
          fail(
            "BLOT_BAD_PARAMETER",
            "`!`, `?`, and `&` qualify a name, not a compound pattern.",
            expr.span,
          );
        }
        return { tag: "name", name: inner.name, qualifier, span: expr.span };
      }
    }
  }
  fail(
    "BLOT_BAD_PARAMETER",
    "This is not a valid parameter pattern.",
    expr.span,
  );
}

// --- expressions ------------------------------------------------------------

function lowerValue(rule: Rule, context: Context): Expr {
  const inner = unwrap(rule);
  const target = asRule(inner, "value alternative");
  if (target.name === "lambda") return lowerLambda(target, context);
  return lowerExpression(target, context);
}

function lowerLambda(rule: Rule, context: Context): Expr {
  const head = lowerPostfix(
    asRule(field(rule, "parameter"), "parameter"),
    context,
  );
  return {
    tag: "lambda",
    parameter: patternFromExpr(head),
    body: lowerExpression(
      asRule(field(rule, "body"), "body"),
      {
        ...context,
        loop: null,
        escapeBoundary: "none",
      },
    ),
    span: rule.span,
  };
}

function lowerExpression(rule: Rule, context: Context): Expr {
  expect(rule.name === "expression", `expected expression, got ${rule.name}`);
  const first = lowerOperand(asRule(field(rule, "first"), "first"), context);
  const steps: ChainStep[] = fieldList(rule, "rest").map((cursor) => {
    const step = asRule(cursor, "infix_operation");
    return {
      operator: tokenOf(required(step, "operator")).text,
      right: lowerOperand(asRule(field(step, "right"), "right"), context),
      span: step.span,
    };
  });
  return foldChain(first, steps, context.table);
}

function lowerOperand(rule: Rule, context: Context): Expr {
  const valueCursor = field(rule, "value");
  if (valueCursor === null) {
    // The bare `postfix_expression` alternative binds no fields.
    return lowerPostfix(asRule(rule.child(0), "postfix_expression"), context);
  }

  let result = lowerPostfix(asRule(valueCursor, "postfix_expression"), context);
  const prefixes = fieldList(rule, "prefixes")
    .map((cursor) => tokenOf(cursor))
    .reverse();

  for (const prefix of prefixes) {
    const span = { start: rule.span.start, end: result.span.end };
    // A negated literal folds here rather than dispatching to `Num.negate`,
    // so writing `-1` does not require the prelude to be in scope.
    if (prefix.text === "-" && result.tag === "int") {
      result = { tag: "int", value: -result.value, span };
      continue;
    }
    if (prefix.text === "rec") {
      result = { tag: "rec", lambda: result, span };
      continue;
    }
    if (prefix.text === "comptime") {
      result = { tag: "comptime", body: result, span };
      continue;
    }
    const fixity = context.table.prefix(prefix.text);
    if (fixity === undefined) {
      fail(
        "BLOT_UNKNOWN_OPERATOR",
        `No fixity is declared for the prefix operator \`${prefix.text}\`.`,
        rule.span,
      );
    }
    result = { tag: "apply", fn: targetExpr(fixity, span), arg: result, span };
  }
  return result;
}

function lowerPostfix(rule: Rule, context: Context): Expr {
  let result = lowerPrimary(
    unwrap(asRule(field(rule, "value"), "value")),
    context,
  );
  result = applySuffixes(result, fieldList(rule, "suffixes"));

  for (const cursor of fieldList(rule, "arguments")) {
    const argumentRule = asRule(cursor, "application_argument");
    let argument = lowerPrimary(
      unwrap(asRule(field(argumentRule, "value"), "value")),
      context,
    );
    argument = applySuffixes(argument, fieldList(argumentRule, "suffixes"));
    result = {
      tag: "apply",
      fn: result,
      arg: argument,
      span: { start: result.span.start, end: argument.span.end },
    };
  }
  return result;
}

function applySuffixes(target: Expr, suffixes: readonly Cursor[]): Expr {
  let result = target;
  for (const cursor of suffixes) {
    const suffix = asRule(cursor, "field_suffix");
    result = {
      tag: "field",
      target: result,
      name: tokenOf(required(suffix, "field")).text,
      span: { start: result.span.start, end: suffix.span.end },
    };
  }
  return result;
}

function lowerPrimary(cursor: Cursor, context: Context): Expr {
  if (cursor.type === "token") {
    const span = cursor.span;
    if (cursor.kind === "IDENT" || cursor.kind === "TYPE_IDENT") {
      return { tag: "var", name: cursor.text, span };
    }
    if (cursor.kind === "INTEGER") {
      return { tag: "int", value: BigInt(cursor.text), span };
    }
    if (cursor.kind === "TEXT") {
      return { tag: "text", value: decodeText(cursor.text, span), span };
    }
    if (cursor.kind === "INTRINSIC") {
      return { tag: "intrinsic", name: cursor.text, span };
    }
    fail(
      "BLOT_BAD_EXPRESSION",
      `\`${cursor.text}\` is not an expression.`,
      span,
    );
  }

  const rule = cursor;
  if (rule.name === "constructor_expression") {
    return {
      tag: "tag",
      name: tokenOf(required(rule, "constructor")).text,
      span: rule.span,
    };
  }
  if (rule.name === "unit") return { tag: "unit", span: rule.span };

  if (rule.name === "parenthesized_or_tuple") {
    const first = lowerValue(asRule(field(rule, "first"), "first"), context);
    // The remaining elements live inside the optional `("," rest:...)` group,
    // so they are reached through `tail`; the flattened `rest` field is empty.
    const tail = rule.field("tail");
    if (tail === null || tail === undefined) return first;
    expect(Array.isArray(tail), "tuple tail is not a group");
    const rest = (tail[1] as readonly Cursor[]).map((c) =>
      lowerValue(asRule(c, "tuple element"), context)
    );
    if (rest.length === 0) return first;
    return { tag: "tuple", elements: [first, ...rest], span: rule.span };
  }

  if (rule.name === "array") {
    const elements: ArrayElement[] = fieldList(rule, "elements").map((c) => {
      const element = asRule(c, "array_element");
      return {
        spread: field(element, "spread") !== null,
        value: lowerValue(asRule(field(element, "value"), "value"), context),
      };
    });
    return { tag: "array", elements, span: rule.span };
  }

  if (rule.name === "shape") {
    const members: ShapeMember[] = fieldList(rule, "members").map((c) => {
      const member = asRule(unwrap(asRule(c, "shape_member")), "shape member");
      if (member.name === "shape_spread") {
        return {
          tag: "spread",
          value: lowerExpression(
            asRule(field(member, "value"), "value"),
            context,
          ),
        };
      }
      return {
        tag: "field",
        name: tokenOf(required(member, "name")).text,
        value: lowerValue(asRule(field(member, "value"), "value"), context),
      };
    });
    return { tag: "shape", members, span: rule.span };
  }

  if (rule.name === "conditional") {
    const closed: Context = {
      ...context,
      loop: null,
      escapeBoundary: "value-condition",
    };
    const branches: Branch[] = [{
      condition: lowerExpression(
        asRule(field(rule, "condition"), "condition"),
        closed,
      ),
      consequence: lowerValue(
        asRule(field(rule, "consequence"), "consequence"),
        closed,
      ),
    }];
    for (const cursor of fieldList(rule, "alternatives")) {
      const clause = asRule(cursor, "else_if_clause");
      branches.push({
        condition: lowerExpression(
          asRule(field(clause, "condition"), "condition"),
          closed,
        ),
        consequence: lowerValue(
          asRule(field(clause, "consequence"), "consequence"),
          closed,
        ),
      });
    }
    const fallbackCursor = asRule(
      required(rule, "fallback"),
      "else_clause",
    );
    const fallback = lowerValue(
      asRule(
        field(fallbackCursor, "alternative"),
        "alternative",
      ),
      closed,
    );
    return { tag: "if", branches, fallback, span: rule.span };
  }

  if (rule.name === "case_expression") {
    const closed: Context = {
      ...context,
      loop: null,
      escapeBoundary: "value-condition",
    };
    const arms: Arm[] = [
      lowerArm(asRule(field(rule, "first"), "first"), closed),
    ];
    for (const cursor of fieldList(rule, "rest")) {
      // Each entry is the `,` token paired with the arm.
      const pair = cursor as unknown as readonly Cursor[];
      arms.push(lowerArm(asRule(pair[1], "case_arm"), closed));
    }
    return {
      tag: "case",
      target: lowerExpression(asRule(field(rule, "target"), "target"), closed),
      arms,
      span: rule.span,
    };
  }

  if (rule.name === "handler_composition") {
    let current = lowerValue(
      asRule(field(rule, "program"), "program"),
      context,
    );
    const declarations: Decl[] = [];

    for (const cursor of fieldList(rule, "steps")) {
      const step = asRule(cursor, "handler_composition_step");
      const action = lowerHandlerCompositionAction(
        asRule(field(step, "action"), "action"),
        context,
      );
      const handled: Expr = {
        tag: "lambda",
        parameter: { tag: "unit", span: step.span },
        body: {
          tag: "apply",
          fn: { tag: "intrinsic", name: "@handle", span: step.span },
          arg: {
            tag: "tuple",
            elements: [action.effect, current, action.handler],
            span: step.span,
          },
          span: step.span,
        },
        span: step.span,
      };
      const name = tokenOf(required(step, "name")).text;
      if (name === "_") {
        current = handled;
        continue;
      }
      declarations.push({
        tag: "binding",
        kind: "let",
        pattern: {
          tag: "name",
          name,
          qualifier: "none",
          span: step.span,
        },
        value: handled,
        span: step.span,
      });
      current = { tag: "var", name, span: step.span };
    }

    const action = lowerHandlerCompositionAction(
      asRule(field(rule, "result"), "result"),
      context,
    );
    return {
      tag: "block",
      declarations,
      result: {
        tag: "apply",
        fn: { tag: "intrinsic", name: "@handle", span: action.span },
        arg: {
          tag: "tuple",
          elements: [action.effect, current, action.handler],
          span: action.span,
        },
        span: action.span,
      },
      span: rule.span,
    };
  }

  if (rule.name === "block") {
    const statements = fieldList(rule, "statements");
    let result: Expr = { tag: "unit", span: rule.span };
    const resultPair = rule.field("result");
    if (resultPair !== null && resultPair !== undefined) {
      expect(Array.isArray(resultPair), "block result is not an `in` pair");
      const valueCursor = resultPair[1] as Cursor;
      result = lowerValue(asRule(valueCursor, "block result"), context);
    }
    if (statementsNeedControlLowering(statements)) {
      return resolveControlSequence(statements, result, context, rule.span);
    }
    const declarations = statements.map((statement) =>
      lowerDecl(asRule(unwrap(statement), "statement"), context)
    );
    return { tag: "block", declarations, result, span: rule.span };
  }

  fail(
    "BLOT_BAD_EXPRESSION",
    `\`${rule.name}\` is not an expression.`,
    rule.span,
  );
}

interface HandlerCompositionAction {
  readonly effect: Expr;
  readonly handler: Expr;
  readonly span: Span;
}

function lowerHandlerCompositionAction(
  rule: Rule,
  context: Context,
): HandlerCompositionAction {
  const intrinsic = tokenOf(required(rule, "intrinsic"));
  if (intrinsic.text !== "@handle") {
    fail(
      "BLOT_BAD_HANDLER_COMPOSITION",
      `A \`try\` step uses \`@handle (effect, handler)\`, found \`${intrinsic.text}\`.`,
      intrinsic.span,
    );
  }
  return {
    effect: lowerValue(asRule(field(rule, "effect"), "effect"), context),
    handler: lowerValue(asRule(field(rule, "handler"), "handler"), context),
    span: rule.span,
  };
}

function lowerArm(rule: Rule, context: Context): Arm {
  return {
    pattern: lowerPattern(asRule(field(rule, "pattern"), "pattern")),
    body: lowerValue(asRule(field(rule, "body"), "body"), context),
  };
}

export { textOf };
