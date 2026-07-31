// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// What a condition proves, derived from the function it calls.
//
// `if n == 1` should leave the then-branch knowing `n : 1`. The obstacle is that
// `==` is not a compiler concept: the fixity table names the binding `Eq.eq`,
// and any module may bind that name to anything. A checker that assumed `==`
// meant equality would prove a false fact the moment someone shadowed it — and
// that program is writable today.
//
// So nothing here is keyed on a name, a spelling, or a module. This module takes
// the *compile-time value* a condition calls and asks whether it is a comparison,
// by interrogating the value itself.
//
// THE FACTORIZATION LEMMA, which is the whole argument
//
// `recognise` accepts a value only when it is `p1 => (p2 => B)` and every free
// occurrence of `p1` and `p2` in `B` sits inside one application
// `@int.cmp p1 p2` — one occurrence each, and no binder in `B` rebinds either
// name. Then `B` cannot observe `p1` or `p2` except through that call, so
//
//     op(a, b) = H(cmp(a, b))
//
// for some `H` this module never has to see. `@int.cmp` is compiler-owned, total
// on pairs of integers, and its codomain is the three constructors `#Less`,
// `#Equal`, `#Greater`. So tabulating `op` at one representative of each ordering
// — `(0,1)`, `(1,1)`, `(1,0)` — determines `op` on *every* pair of integers.
//
// That is the step sampling cannot take, and it is what lets a branch narrow an
// unbounded domain: `if n < 10` proves `..9` without enumerating anything.
//
// WHY THE PROBE IS SAFE TO RUN AT CHECK TIME
//
// It runs with a small fuel budget, so a diverging operator ends the probe rather
// than the compiler. It runs with the default host, which answers no effect, so a
// performed effect fails instead of reaching the outside world. Every error is
// caught — including `BLOT_REFUSED`, which `comptime` in `infer.ts` deliberately
// re-raises so that `expect` speaks at `blot check`. Swallowing it is right here
// and wrong there, and the difference is that a failed probe is not a fact about
// the user's program: it only means this module declines to prove anything.
//
// WHAT IS REFUSED
//
//   * A body containing `open`. Its names come from a compile-time value, not
//     from the syntax, so `open {} = Sneaky;` can rebind `p1` without the name
//     `p1` appearing in any node — defeating the occurrence count. Nothing in the
//     prelude opens inside an operator, so refusing outright costs nothing. The
//     principled version enumerates the names every declaration form binds,
//     computing `open`'s from its value; the blunt refusal is what makes the
//     first landing sound.
//   * A body containing `rec`. `rec` binds a self name that is not written in the
//     AST either, for the same reason.
//   * Anything that is not two nested single-name lambdas, or whose probes do not
//     all answer a nullary `#True` or `#False`.
//
// This module has no opinion about `if`, scopes, or which name gets narrowed.
// It answers one question about one value.

import type { Arm, Decl, Expr, Pattern } from "../syntax/ast.ts";
import { apply, evaluationRuntime, run } from "../comptime/eval.ts";
import type { Value } from "../comptime/value.ts";
import { BOTTOM, type SimpleType, union } from "./type.ts";

/** The three answers `@int.cmp` can give, as an ordering of its arguments. */
export type Ordering = "less" | "equal" | "greater";

/** Least first: `region` relies on this order being the order of the integers. */
const ORDERINGS: readonly Ordering[] = ["less", "equal", "greater"];

/**
 * Enough steps to run a comparison, nowhere near enough to run a program.
 *
 * A recognised body is one application of `@int.cmp` under a decision on its
 * three-constructor result. The prelude's widest, `Ord.ge`, uses 32 steps.
 */
const PROBE_FUEL = 2000;

const NOWHERE = { start: 0, end: 0 };

/**
 * Recognition is a property of the value, so the answer is cached on the value.
 *
 * Every `if` in a module resolves `Eq.eq` to the same closure, so this is what
 * keeps the cost of the feature at one recognition per operator per process
 * rather than one per condition.
 */
const recognised = new WeakMap<
  object,
  { readonly result: ReadonlySet<Ordering> | null }
>();

/**
 * The orderings on which `value` answers `#True`, or `null` when it is not a
 * comparison of two integers.
 *
 * `null` is "this module declines to say", never "the program is wrong". A
 * caller narrows nothing and reports nothing.
 */
export function recognise(value: Value): ReadonlySet<Ordering> | null {
  const cached = recognised.get(value);
  if (cached !== undefined) return cached.result;
  const result = derive(value);
  recognised.set(value, { result });
  return result;
}

/** `orderings` mirrored, for a condition written with the subject on the right. */
export function mirror(
  orderings: ReadonlySet<Ordering>,
): ReadonlySet<Ordering> {
  const flipped = new Set<Ordering>();
  if (orderings.has("greater")) flipped.add("less");
  if (orderings.has("equal")) flipped.add("equal");
  if (orderings.has("less")) flipped.add("greater");
  return flipped;
}

/**
 * The orderings `orderings` does not contain.
 *
 * The complement is taken here, on a three-element set, and never on a type.
 * That is the reason this design needs no difference operation in the lattice
 * and cannot put a complement into either polarity of biunification.
 */
export function complement(
  orderings: ReadonlySet<Ordering>,
): ReadonlySet<Ordering> {
  return new Set(ORDERINGS.filter((one) => !orderings.has(one)));
}

/**
 * The integers standing in one of `orderings` to `k`.
 *
 * At most two disjoint pieces, because the three orderings are contiguous in the
 * order of the integers and only `{less, greater}` has a gap. That bound is why
 * `d` nested conditions give at most `d + 1` pieces rather than `2^d`.
 *
 * Exact, not approximate: integers are discrete and `Bound` is inclusive, so
 * "less than `k`" is the range ending at `k - 1`. The same construction on text
 * would be wrong, and this module never builds one — `@int.cmp` fails on text, so
 * a recognised comparison never sees any.
 */
export function region(
  orderings: ReadonlySet<Ordering>,
  k: bigint,
): SimpleType {
  const pieces: SimpleType[] = [];
  let stretch: Ordering[] = [];

  const flush = (): void => {
    if (stretch.length === 0) return;
    pieces.push({
      tag: "range",
      domain: "int",
      low: lowOf(stretch[0], k),
      high: highOf(stretch[stretch.length - 1], k),
    });
    stretch = [];
  };

  for (const one of ORDERINGS) {
    if (orderings.has(one)) {
      stretch.push(one);
      continue;
    }
    flush();
  }
  flush();

  if (pieces.length === 0) return BOTTOM;
  return union(pieces);
}

function lowOf(first: Ordering, k: bigint): bigint | null {
  if (first === "less") return null;
  if (first === "equal") return k;
  return k + 1n;
}

function highOf(last: Ordering, k: bigint): bigint | null {
  if (last === "less") return k - 1n;
  if (last === "equal") return k;
  return null;
}

function derive(value: Value): ReadonlySet<Ordering> | null {
  if (!factored(value)) return null;
  return tabulate(value);
}

/** Whether `value` is `p1 => (p2 => ... @int.cmp p1 p2 ...)` and nothing more. */
function factored(value: Value): boolean {
  if (value.tag !== "closure") return false;
  // A `rec` closure can reach itself, and its self name is not a binder in the
  // body, so the occurrence count cannot see it shadowing a parameter.
  if (value.self !== null) return false;
  if (value.parameter.tag !== "name") return false;
  const first = value.parameter.name;

  const inner = value.body;
  if (inner.tag !== "lambda") return false;
  if (inner.parameter.tag !== "name") return false;
  const second = inner.parameter.name;
  if (first === second) return false;

  const scan = new Scan(first, second);
  scan.expr(inner.body);
  if (scan.refused) return false;
  if (scan.comparisons !== 1) return false;
  if (scan.uses.get(first) !== 1) return false;
  if (scan.uses.get(second) !== 1) return false;
  return true;
}

/**
 * Counts what the factorization lemma needs and refuses what it cannot count.
 *
 * `refused` is set by a binder that could rebind a parameter and by the two
 * forms whose bound names are not written in the AST at all.
 */
class Scan {
  readonly uses = new Map<string, number>();
  comparisons = 0;
  refused = false;

  constructor(
    private readonly first: string,
    private readonly second: string,
  ) {}

  private binds(pattern: Pattern): void {
    for (const name of patternNames(pattern)) {
      if (name === this.first || name === this.second) this.refused = true;
    }
  }

  expr(node: Expr): void {
    if (this.refused) return;

    switch (node.tag) {
      case "var": {
        const seen = this.uses.get(node.name);
        if (seen === undefined) this.uses.set(node.name, 1);
        else this.uses.set(node.name, seen + 1);
        return;
      }
      case "int":
      case "text":
      case "unit":
      case "intrinsic":
      case "tag":
        return;

      case "apply":
        if (this.comparison(node)) return;
        this.expr(node.fn);
        this.expr(node.arg);
        return;

      case "field":
        this.expr(node.target);
        return;

      case "lambda":
        this.binds(node.parameter);
        this.expr(node.body);
        return;

      case "array":
        for (const element of node.elements) this.expr(element.value);
        return;

      case "tuple":
        for (const element of node.elements) this.expr(element);
        return;

      case "shape":
        for (const member of node.members) this.expr(member.value);
        return;

      case "if":
        for (const branch of node.branches) {
          this.expr(branch.condition);
          this.expr(branch.consequence);
        }
        if (node.fallback !== null) this.expr(node.fallback);
        return;

      case "case":
        this.expr(node.target);
        for (const arm of node.arms) this.arm(arm);
        return;

      case "block":
        for (const declaration of node.declarations) this.decl(declaration);
        this.expr(node.result);
        return;

      case "rec":
        // `rec` binds a self name that appears in no node, so a parameter could
        // be shadowed without the scan seeing it.
        this.refused = true;
        return;

      case "comptime":
        this.expr(node.body);
        return;
    }
  }

  private arm(arm: Arm): void {
    this.binds(arm.pattern);
    this.expr(arm.body);
  }

  private decl(declaration: Decl): void {
    if (declaration.tag === "open") {
      // The names `open` binds come from a compile-time value, not the syntax.
      this.refused = true;
      return;
    }
    if (declaration.tag === "shadow") {
      if (
        declaration.name === this.first || declaration.name === this.second
      ) {
        this.refused = true;
      }
      this.expr(declaration.value);
      return;
    }
    this.binds(declaration.pattern);
    this.expr(declaration.value);
  }

  /** `@int.cmp p1 p2` in either argument order, counted and not descended into. */
  private comparison(node: Expr & { tag: "apply" }): boolean {
    if (node.fn.tag !== "apply") return false;
    if (node.fn.fn.tag !== "intrinsic") return false;
    if (node.fn.fn.name !== "@int.cmp") return false;
    const left = node.fn.arg;
    const right = node.arg;
    if (left.tag !== "var" || right.tag !== "var") return false;
    const pair = new Set([left.name, right.name]);
    if (pair.size !== 2) return false;
    if (!pair.has(this.first) || !pair.has(this.second)) return false;
    this.comparisons += 1;
    this.expr(left);
    this.expr(right);
    return true;
  }
}

function patternNames(pattern: Pattern): readonly string[] {
  switch (pattern.tag) {
    case "name":
      return [pattern.name];
    case "wildcard":
    case "int":
    case "text":
    case "unit":
      return [];
    case "tuple":
    case "array":
      return pattern.elements.flatMap(patternNames);
    case "constructor":
      if (pattern.payload === null) return [];
      return patternNames(pattern.payload);
    case "shape":
      return pattern.fields.flatMap((field) => patternNames(field.pattern));
  }
}

/** The three probes. One representative of each ordering determines the rest. */
function tabulate(value: Value): ReadonlySet<Ordering> | null {
  const answers = new Set<Ordering>();
  const probes: readonly (readonly [Ordering, bigint, bigint])[] = [
    ["less", 0n, 1n],
    ["equal", 1n, 1n],
    ["greater", 1n, 0n],
  ];

  for (const [ordering, left, right] of probes) {
    const answer = probe(value, left, right);
    if (answer === null) return null;
    if (answer) answers.add(ordering);
  }
  return answers;
}

/**
 * `value left right`, or `null` if it did anything other than answer a boolean.
 *
 * Every failure is swallowed. A probe that diverges runs out of fuel, a probe
 * that performs an effect finds no host, and a probe that refuses raises
 * `BLOT_REFUSED` — none of which is a diagnosis of the user's program.
 */
function probe(value: Value, left: bigint, right: bigint): boolean | null {
  try {
    const runtime = evaluationRuntime(new Map(), "comptime", PROBE_FUEL);
    const answer = run((function* () {
      const partial = yield* apply(
        value,
        { tag: "int", value: left },
        NOWHERE,
        runtime,
      );
      return yield* apply(
        partial,
        { tag: "int", value: right },
        NOWHERE,
        runtime,
      );
    })());
    if (answer.tag !== "tag") return null;
    if (answer.payload !== null) return null;
    if (answer.name === "True") return true;
    if (answer.name === "False") return false;
    return null;
  } catch {
    return null;
  }
}
