// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Linearity and ownership.
//
// This is a flow analysis over the AST, deliberately *not* part of the type
// lattice. Biunification stays polynomial only because ownership is checked
// separately: putting `!` into the lattice would make subtyping decide resource
// use, and the algorithm would stop being the thing that pays for itself.
//
// Two qualifiers, and the difference between them is the whole design:
//
//   * `!x` is **linear**. It must be consumed exactly once on every path. Not
//     once-or-fewer — a resource that is never consumed is a leak, and that is
//     the failure the marker exists to catch.
//   * `?x` is **affine**: at most once. Not a weaker linear but a different
//     rule, and the right one for a continuation — a handler that does not
//     resume is aborting, which is legitimate, while resuming twice is not.
//   * `&x` is a **borrow**. It may be read any number of times and may never be
//     moved, so a borrowing function is one you can call without losing what you
//     passed it.
//
// Alongside the check, the pass records the last use of every binding. Nothing
// consumes those facts yet: rewriting a rebuild into an in-place write needs a
// Core to rewrite, which arrives with the backend. They are computed and
// exposed rather than deferred, so the analysis can be tested on its own.

import type { Decl, Expr, Module, Pattern, Qualifier, Span } from "../syntax/ast.ts";
import type { Diagnostic } from "../diagnostic.ts";

interface Binding {
  readonly name: string;
  readonly qualifier: Qualifier;
  readonly span: Span;
  /** Where the binding was consumed, if it has been. */
  moved: Span | null;
  /** How many times it was read without being consumed. */
  borrows: number;
  lastUse: Span | null;
}

interface Scope {
  readonly bindings: Map<string, Binding>;
  readonly parent: Scope | null;
  /** A lambda body. Linear values reached from outside it are captured. */
  readonly lambda: boolean;
  /** Outer linear bindings this lambda captured, if it is one. */
  readonly captures: Set<Binding>;
}

export interface Ownership {
  /** Bindings whose final read is their last use, keyed by name. */
  readonly lastUses: ReadonlyMap<string, Span>;
  /** Linear bindings proved to be consumed exactly once. */
  readonly linear: readonly string[];
}

export interface LinearResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly ownership: Ownership;
}

class Analysis {
  readonly diagnostics: Diagnostic[] = [];
  readonly lastUses = new Map<string, Span>();
  readonly linear: string[] = [];

  report(code: string, message: string, span: Span): void {
    this.diagnostics.push({ code, message, span });
  }

  /**
   * Finds a binding, and reports the outermost lambda crossed on the way — the
   * one that would capture it. Captures chain: a use two lambdas deep is
   * captured by the outer lambda from the defining scope, then by the inner one
   * from the outer, and resolving one link at a time builds that chain.
   */
  lookup(
    scope: Scope,
    name: string,
  ): { binding: Binding; capturedBy: Scope | null } | null {
    let current: Scope | null = scope;
    let capturedBy: Scope | null = null;
    while (current !== null) {
      const found = current.bindings.get(name);
      if (found !== undefined) return { binding: found, capturedBy };
      if (current.lambda) capturedBy = current;
      current = current.parent;
    }
    return null;
  }
}

function childScope(parent: Scope | null, lambda = false): Scope {
  return { bindings: new Map(), parent, lambda, captures: new Set() };
}

/** A snapshot of which linear bindings are consumed, for comparing branches. */
function snapshot(scope: Scope): Map<Binding, Span | null> {
  const state = new Map<Binding, Span | null>();
  let current: Scope | null = scope;
  while (current !== null) {
    for (const binding of current.bindings.values()) {
      if (spendable(binding.qualifier)) state.set(binding, binding.moved);
    }
    current = current.parent;
  }
  return state;
}

function restore(state: Map<Binding, Span | null>): void {
  for (const [binding, moved] of state) binding.moved = moved;
}

export function checkLinearity(module: Module): LinearResult {
  const analysis = new Analysis();
  const scope = childScope(null);

  if (module.parameter !== null) {
    declare(module.parameter, scope, analysis);
  }
  walkDeclarations(module.declarations, scope, analysis);
  walk(module.result, scope, analysis, "move");
  closeScope(scope, analysis);

  return {
    diagnostics: analysis.diagnostics,
    ownership: {
      lastUses: analysis.lastUses,
      // A captured value is shadowed inside the closure that took it, so it is
      // proved twice — once in each scope. That is bookkeeping, not two values.
      linear: [...new Set(analysis.linear)],
    },
  };
}

/** Every linear binding in a scope must be consumed before the scope ends. */
function closeScope(scope: Scope, analysis: Analysis): void {
  for (const binding of scope.bindings.values()) {
    if (!spendable(binding.qualifier)) continue;
    // Affine owes nothing: not resuming is an abort, not a leak.
    if (binding.qualifier === "affine") {
      if (binding.moved !== null) analysis.linear.push(binding.name);
      continue;
    }
    if (binding.moved === null) {
      analysis.report(
        "BLOT_LINEAR_NOT_CONSUMED",
        `\`${binding.name}\` is linear and is never consumed. A linear value must be used exactly once; drop the \`!\` if it need not be.`,
        binding.span,
      );
      continue;
    }
    analysis.linear.push(binding.name);
  }
}

function declare(pattern: Pattern, scope: Scope, analysis: Analysis): void {
  switch (pattern.tag) {
    case "name":
      scope.bindings.set(pattern.name, {
        name: pattern.name,
        qualifier: pattern.qualifier,
        span: pattern.span,
        moved: null,
        borrows: 0,
        lastUse: null,
      });
      return;
    case "tuple":
    case "array":
      for (const inner of pattern.elements) declare(inner, scope, analysis);
      return;
    case "constructor":
      if (pattern.payload !== null) declare(pattern.payload, scope, analysis);
      return;
    case "shape":
      for (const field of pattern.fields) {
        declare(field.pattern, scope, analysis);
      }
      return;
    default:
      return;
  }
}

/**
 * How a name is reached.
 *
 *   * `move` — the value travels somewhere that keeps it: an argument, a shape
 *     member, a result. A linear value is spent; a borrowed one may not go.
 *   * `project` — the value's structure is read, as in `p.x`. A linear value is
 *     still spent, because what is left of it cannot be used again; a borrowed
 *     one is fine, since reading is what a borrow is for.
 *   * `borrow` — written `&x`, and the only thing that does not spend a linear
 *     value.
 */
type Use = "move" | "borrow" | "project";

function use(
  name: string,
  span: Span,
  scope: Scope,
  analysis: Analysis,
  kind: Use,
): void {
  const found = analysis.lookup(scope, name);
  if (found === null) return;
  const { binding, capturedBy } = found;

  analysis.lastUses.set(name, span);
  binding.lastUse = span;

  if (binding.qualifier === "borrow" && kind === "move") {
    analysis.report(
      "BLOT_BORROW_MOVED",
      `\`${name}\` is borrowed and cannot be moved. A borrowing function is one its caller can still use afterwards.`,
      span,
    );
    return;
  }

  if (!spendable(binding.qualifier) || kind === "borrow") {
    binding.borrows += 1;
    return;
  }

  // Capturing a linear value does not refuse it and does not spend it here.
  // The obligation *moves into the closure*: the closure becomes linear, and
  // whoever holds it owes exactly one call. Inside the body the captured value
  // is an ordinary linear binding, so using it twice per call is still caught.
  if (capturedBy !== null) {
    capturedBy.captures.add(binding);
    capturedBy.bindings.set(name, {
      name,
      qualifier: binding.qualifier,
      span: binding.span,
      moved: null,
      borrows: 0,
      lastUse: null,
    });
    use(name, span, scope, analysis, kind);
    return;
  }

  consume(binding, span, analysis);
}

/** Linear and affine both spend; they differ only in whether spending is owed. */
function spendable(qualifier: Qualifier): boolean {
  return qualifier === "linear" || qualifier === "affine";
}

function walkDeclarations(
  declarations: readonly Decl[],
  scope: Scope,
  analysis: Analysis,
): void {
  for (const declaration of declarations) {
    // `open` spreads a compile-time record, and a compile-time record cannot
    // hold a linear value — there is no run time for it to be consumed in. So
    // the expression is walked for what *it* consumes and nothing is declared.
    if (declaration.tag === "open") {
      if (walk(declaration.value, scope, analysis, "move") !== "none") {
        escapes(declaration.span, analysis);
      }
      continue;
    }
    if (declaration.tag === "shadow") {
      if (walk(declaration.value, scope, analysis, "move") !== "none") {
        escapes(declaration.span, analysis);
      }
      continue;
    }
    // A `sig` computes nothing at run time and consumes nothing.
    if (declaration.kind === "sig") continue;
    const linear = walk(declaration.value, scope, analysis, "move");
    declare(declaration.pattern, scope, analysis);
    // A closure that captured a linear value is linear itself, whether or not
    // anyone wrote `!`. The obligation was not created here, only relocated,
    // so it would be wrong to make the programmer restate it.
    if (linear !== "none" && declaration.pattern.tag === "name") {
      const binding = scope.bindings.get(declaration.pattern.name);
      if (binding !== undefined) {
        scope.bindings.set(declaration.pattern.name, {
          ...binding,
          qualifier: linear,
        });
      }
    }
  }
}

/**
 * What obligation, if any, an expression *produced*. Only a closure that
 * captured one does, and the answer has to travel outward: the binding it lands
 * in inherits it whether or not anyone wrote a marker. A closure that captured
 * a linear value owes exactly one call; one that captured only affine values
 * owes at most one.
 */
type Produced = "none" | "affine" | "linear";

function walk(
  expr: Expr,
  scope: Scope,
  analysis: Analysis,
  kind: Use,
): Produced {
  switch (expr.tag) {
    case "var":
      use(expr.name, expr.span, scope, analysis, kind);
      return "none";

    case "apply": {
      // `&x` and `!x` reach here as prefix-operator applications, and they are
      // the two places the intent is written down rather than inferred.
      if (expr.fn.tag === "intrinsic" && expr.fn.name === "@linear.borrow") {
        walk(expr.arg, scope, analysis, "borrow");
        return "none";
      }
      if (expr.fn.tag === "intrinsic" && expr.fn.name === "@linear.own") {
        return walk(expr.arg, scope, analysis, "move");
      }
      // Applying a linear closure right where it was built discharges it: the
      // one call it owed is this one.
      walk(expr.fn, scope, analysis, "project");
      // An argument is moved into the call unless it was explicitly borrowed.
      const argument = walk(expr.arg, scope, analysis, "move");
      if (argument !== "none") escapes(expr.arg.span, analysis);
      return "none";
    }

    case "field":
      walk(expr.target, scope, analysis, "project");
      return "none";

    case "lambda": {
      const inner = childScope(scope, true);
      declare(expr.parameter, inner, analysis);
      walk(expr.body, inner, analysis, "move");
      closeScope(inner, analysis);
      // Each captured value is spent once, here, into the closure. What the
      // closure owes from now on is one call.
      let produced: Produced = "none";
      for (const captured of inner.captures) {
        consume(captured, expr.span, analysis);
        if (captured.qualifier === "linear") produced = "linear";
        else if (produced === "none") produced = "affine";
      }
      return produced;
    }

    case "rec":
      return walk(expr.lambda, scope, analysis, kind);

    case "comptime":
      return walk(expr.body, scope, analysis, kind);

    case "tuple":
      for (const element of expr.elements) {
        if (walk(element, scope, analysis, "move") !== "none") {
          escapes(element.span, analysis);
        }
      }
      return "none";

    case "array":
      for (const element of expr.elements) {
        if (walk(element.value, scope, analysis, "move") !== "none") {
          escapes(element.value.span, analysis);
        }
      }
      return "none";

    case "shape":
      for (const member of expr.members) {
        if (walk(member.value, scope, analysis, "move") !== "none") {
          escapes(member.value.span, analysis);
        }
      }
      return "none";

    case "if": {
      // Every branch starts from the same state and must end in the same one:
      // a value consumed on one path and not another is consumed neither
      // exactly once nor never.
      const before = snapshot(scope);
      const outcomes: Map<Binding, Span | null>[] = [];
      for (const branch of expr.branches) {
        walk(branch.condition, scope, analysis, "project");
      }
      for (const branch of expr.branches) {
        restore(before);
        walk(branch.consequence, scope, analysis, kind);
        outcomes.push(snapshot(scope));
      }
      if (expr.fallback !== null) {
        restore(before);
        walk(expr.fallback, scope, analysis, kind);
        outcomes.push(snapshot(scope));
      }
      agree(outcomes, before, expr.span, analysis);
      return "none";
    }

    case "case": {
      walk(expr.target, scope, analysis, "project");
      const before = snapshot(scope);
      const outcomes: Map<Binding, Span | null>[] = [];
      for (const arm of expr.arms) {
        restore(before);
        const inner = childScope(scope);
        declare(arm.pattern, inner, analysis);
        walk(arm.body, inner, analysis, kind);
        closeScope(inner, analysis);
        outcomes.push(snapshot(scope));
      }
      agree(outcomes, before, expr.span, analysis);
      return "none";
    }

    case "block": {
      const inner = childScope(scope);
      walkDeclarations(expr.declarations, inner, analysis);
      const result = walk(expr.result, inner, analysis, kind);
      closeScope(inner, analysis);
      return result;
    }

    default:
      return "none";
  }
}

/** Spends a binding once, with the same checks an ordinary use gets. */
function consume(binding: Binding, span: Span, analysis: Analysis): void {
  if (binding.moved !== null) {
    analysis.report(
      "BLOT_LINEAR_CONSUMED_TWICE",
      `\`${binding.name}\` is ${
        binding.qualifier === "affine" ? "at-most-once" : "linear"
      } and was already consumed.`,
      span,
    );
    return;
  }
  binding.moved = span;
}

/**
 * A linear closure put somewhere blot cannot follow.
 *
 * Binding it to a name works — the binding becomes linear and is checked. So
 * does calling it immediately. Storing it in a shape or an array would make
 * that structure linear, and blot does not track linear structures yet, so it
 * says so rather than losing the obligation quietly.
 */
function escapes(span: Span, analysis: Analysis): void {
  analysis.report(
    "BLOT_LINEAR_CLOSURE_ESCAPES",
    "This closure captured a linear value, so it is linear itself. blot does not yet track a structure that owns one — bind it to a name or call it here.",
    span,
  );
}

/** Branches must agree about what they consumed. */
function agree(
  outcomes: readonly Map<Binding, Span | null>[],
  before: Map<Binding, Span | null>,
  span: Span,
  analysis: Analysis,
): void {
  if (outcomes.length === 0) return;
  const merged = new Map<Binding, Span | null>();

  for (const [binding] of before) {
    const consumed = outcomes.map((outcome) => outcome.get(binding) ?? null);
    const some = consumed.some((moved) => moved !== null);
    const every = consumed.every((moved) => moved !== null);
    // Affine branches need not agree: spending on one path and not another is
    // still at most once.
    if (some && !every && binding.qualifier === "linear") {
      analysis.report(
        "BLOT_LINEAR_BRANCH_DISAGREEMENT",
        `\`${binding.name}\` is linear and is consumed on some branches but not others.`,
        span,
      );
    }
    merged.set(
      binding,
      some ? consumed.find((moved) => moved !== null) ?? null : null,
    );
  }

  restore(merged);
}
