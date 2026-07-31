// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Which values a ground type enumerates.
//
// Types in blot are sets, and a literal is a range whose bounds coincide — so
// `1 | 2 | 3` is a three-element set and the question "do these arms cover it"
// is ordinary set membership. This module answers only the half of that
// question the lattice can answer exactly: it enumerates a type, or it says it
// cannot.
//
// It says it cannot far more often than it says it can, and that is the point.
// `Int` is a set too, but not one an arm list can exhaust, and a variable is
// not a set yet at all. A `case` over either of those carries no coverage
// requirement rather than a guessed one.
//
// Only two shapes enumerate: a singleton `range`, and a `union` whose members
// are all singleton ranges. A `union` is the one constructor inference never
// builds for itself — it arrives already computed from a type expression (see
// type.ts) — so when one reaches here it *is* the set the program declared.
//
// This is deliberately not `@type.diff` or `Reflect.exclude`. Those compare
// members with the comptime `equal`, which on a range compares exact bounds, so
// `@type.diff Int 1` answers `Int` and silently readmits the value it was asked
// to remove. A coverage check that silently readmits a value is worse than no
// coverage check.

import type { Domain, SimpleType } from "./type.ts";
import { showRange } from "./print.ts";

/** One inhabitant of a ground literal type. */
export interface Literal {
  readonly domain: Domain;
  readonly value: bigint | string;
}

/**
 * The inhabitants of `type`, or `null` when it does not enumerate.
 *
 * `null` is "cannot say", never "no inhabitants": an empty set is `[]`.
 */
/** How many integers are worth listing to decide coverage. */
const LISTABLE = 256n;

function enumerate(type: SimpleType): readonly Literal[] | null {
  if (type.tag === "range") {
    if (type.low === null || type.high === null) return null;
    if (type.low === type.high) {
      return [{ domain: type.domain, value: type.low }];
    }
    // A bounded *integer* range is a finite set, so arms can cover it: two
    // comparisons narrow `i` to `1..2` and `case i of 1 => …, 2 => …` is then
    // complete. Text is dense — `"a".."b"` holds infinitely many strings — so
    // only integers enumerate.
    if (type.domain !== "int") return null;
    if (typeof type.low !== "bigint" || typeof type.high !== "bigint") {
      return null;
    }
    const span = type.high - type.low;
    // Past this, listing is not how a program should be covering the range,
    // and building the list would cost more than the check is worth.
    if (span >= LISTABLE) return null;
    const values: Literal[] = [];
    for (let value = type.low; value <= type.high; value += 1n) {
      values.push({ domain: "int", value });
    }
    return values;
  }
  if (type.tag !== "union") return null;

  const members: Literal[] = [];
  for (const member of type.members) {
    const one = enumerate(member);
    // One member that does not enumerate makes the whole union unenumerable.
    // Widening to the members that do would claim a coverage the type does not
    // have, and the missing member is exactly the value that would trap.
    if (one === null) return null;
    members.push(...one);
  }
  return members;
}

/** Two literals are the same value only within the same domain. */
function sameLiteral(left: Literal, right: Literal): boolean {
  return left.domain === right.domain && left.value === right.value;
}

/**
 * The members of `target` that no arm accepts, or `null` when no requirement
 * can be stated.
 *
 * `null` when the target does not enumerate, and `null` when any arm does not:
 * an arm whose pattern is a constructor, a shape, or a tuple says nothing about
 * a literal set, and a partial answer here would name members a later arm may
 * well cover.
 */
export function uncovered(
  target: SimpleType,
  arms: readonly SimpleType[],
): readonly Literal[] | null {
  const members = enumerate(target);
  if (members === null) return null;
  if (arms.length === 0) return null;

  const covered: Literal[] = [];
  for (const arm of arms) {
    const one = enumerate(arm);
    if (one === null) return null;
    covered.push(...one);
  }

  return members.filter(
    (member) => !covered.some((literal) => sameLiteral(literal, member)),
  );
}

/**
 * Whether a scalar domain is too large for literal arms to cover.
 *
 * A range with an open end holds infinitely many values, so no finite set of
 * literal arms can be exhaustive over it and `uncovered` has nothing to list.
 * Reading that silence as "covered" is how `case n of 1 => …` over `Int` was
 * accepted and then trapped at run time. Saying so instead lets the program
 * choose: widen the type, add the missing arms, or write the `_` arm and say
 * with `@panic` why reaching it is impossible.
 */
export function unlistable(type: SimpleType): boolean {
  if (type.tag === "range") {
    // Only a set no finite arm list could exhaust. A bounded integer range is
    // finite and `enumerate` lists it, so it is not unlistable — saying it was
    // rejected `case i of 1 => …, 2 => …` over the `1..2` a pair of
    // comparisons had just proved.
    if (type.low === null || type.high === null) return true;
    if (type.low === type.high) return false;
    if (type.domain !== "int") return true;
    if (typeof type.low !== "bigint" || typeof type.high !== "bigint") {
      return true;
    }
    return type.high - type.low >= LISTABLE;
  }
  if (type.tag !== "union") return false;
  return type.members.some(unlistable);
}

/** `1 | 2`, spelled the way a `sig` would spell it. */
export function showLiterals(literals: readonly Literal[]): string {
  return literals
    .map((literal) => showRange(literal.domain, literal.value, literal.value))
    .join(" | ");
}
