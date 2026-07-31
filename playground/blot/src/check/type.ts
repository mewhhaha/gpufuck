// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// The inference lattice.
//
// One lattice, no type-level sublanguage. Everything blot infers is an element
// here, and the pieces that look like separate features elsewhere are the same
// piece seen twice:
//
//   * a literal is a range whose bounds coincide, so "literals are singleton
//     types" needs no separate constructor;
//   * an effect row is a set ordered by inclusion — fewer effects is a subtype,
//     exactly like a variant with fewer cases. Effect inference is therefore
//     not a separate pass, it is the join the algorithm already computes;
//   * a `duck` contract is a record constraint, so width subtyping is the whole
//     of what a typeclass would have been.
//
// Inference follows Parreaux's Simple-sub: mutable variables carrying lower and
// upper bounds, levels for let-polymorphism, and biunification by propagating
// bounds rather than by unifying. It is polynomial, which is what pays for
// keeping ownership and linearity out of the lattice entirely.

export type Level = number;

/** `null` is an open end: the domain is unbounded in that direction. */
export type Bound = bigint | string | null;

export interface Variable {
  readonly tag: "var";
  readonly id: number;
  level: Level;
  /** Types that flow into this variable. Its meaning when read positively. */
  readonly lower: SimpleType[];
  /** Types this variable must flow into. Its obligations when read negatively. */
  readonly upper: SimpleType[];
}

export interface RigidVariable {
  readonly tag: "rigid";
  readonly id: number;
}

export type Domain = "int" | "text";

export type SimpleType =
  | Variable
  | RigidVariable
  | {
    readonly tag: "forall";
    readonly variables: readonly number[];
    readonly body: SimpleType;
  }
  | {
    readonly tag: "range";
    readonly domain: Domain;
    readonly low: Bound;
    readonly high: Bound;
  }
  | { readonly tag: "unit" }
  | {
    readonly tag: "fun";
    readonly param: SimpleType;
    readonly effects: SimpleType;
    readonly result: SimpleType;
  }
  | { readonly tag: "record"; readonly fields: ReadonlyMap<string, SimpleType> }
  | { readonly tag: "array"; readonly element: SimpleType }
  /**
   * A union of constructors. Payload is `unit` when the tag carries none.
   *
   * `open` means "these constructors, and possibly others". It is what a `case`
   * with a wildcard or name arm proves about its scrutinee: the constructor
   * arms still say what their payloads carry, but the arm that matches
   * everything leaves the set of constructors unbounded. Inference only ever
   * builds one as an upper bound.
   */
  | {
    readonly tag: "variant";
    readonly cases: ReadonlyMap<string, SimpleType>;
    readonly open: boolean;
  }
  /** An effect row: a set ordered by inclusion. */
  | { readonly tag: "effects"; readonly labels: ReadonlySet<string> }
  /**
   * A declared union of ground types, as written in a `sig`: `1 | 2 | "three"`.
   *
   * Inference itself never builds one — a variable's several lower bounds are
   * how it represents a join. This constructor exists only for unions that
   * arrive already computed from a type expression, and its members are
   * required to be ground. That restriction is what keeps `T <: union`
   * decidable by trying each member instead of backtracking through variables.
   */
  | { readonly tag: "union"; readonly members: readonly SimpleType[] }
  /** An opaque value the checker knows nothing about — a host capability. */
  | { readonly tag: "opaque"; readonly name: string }
  | { readonly tag: "top" }
  | { readonly tag: "bottom" };

/** A `let`-bound scheme. Instantiating it freshens everything above `level`. */
export interface Scheme {
  readonly tag: "scheme";
  readonly level: Level;
  readonly body: SimpleType;
}

export type Typing = SimpleType | Scheme;

let nextId = 0;
let nextRigidId = 0;

export function freshVar(level: Level): Variable {
  nextId += 1;
  return { tag: "var", id: nextId, level, lower: [], upper: [] };
}

export function freshRigid(): RigidVariable {
  nextRigidId += 1;
  return { tag: "rigid", id: nextRigidId };
}

export const UNIT: SimpleType = { tag: "unit" };
export const TOP: SimpleType = { tag: "top" };
export const BOTTOM: SimpleType = { tag: "bottom" };
export const PURE: SimpleType = { tag: "effects", labels: new Set() };

export function intLiteral(value: bigint): SimpleType {
  return { tag: "range", domain: "int", low: value, high: value };
}

export function textLiteral(value: string): SimpleType {
  return { tag: "range", domain: "text", low: value, high: value };
}

export const INT: SimpleType = {
  tag: "range",
  domain: "int",
  low: null,
  high: null,
};
export const TEXT: SimpleType = {
  tag: "range",
  domain: "text",
  low: null,
  high: null,
};

export function fun(
  param: SimpleType,
  result: SimpleType,
  effects: SimpleType,
): SimpleType {
  return { tag: "fun", param, effects, result };
}

export function record(
  fields: Iterable<readonly [string, SimpleType]>,
): SimpleType {
  return { tag: "record", fields: new Map(fields) };
}

export function variant(
  cases: Iterable<readonly [string, SimpleType]>,
): SimpleType {
  return { tag: "variant", cases: new Map(cases), open: false };
}

/** `#A | #B | ..` — those constructors, and possibly others. */
export function openVariant(
  cases: Iterable<readonly [string, SimpleType]>,
): SimpleType {
  return { tag: "variant", cases: new Map(cases), open: true };
}

export function union(members: readonly SimpleType[]): SimpleType {
  if (members.length === 1) return members[0];
  return { tag: "union", members };
}

export function effects(labels: Iterable<string>): SimpleType {
  return { tag: "effects", labels: new Set(labels) };
}

export function tupleType(elements: readonly SimpleType[]): SimpleType {
  return record(
    elements.map((element, index) => [String(index), element] as const),
  );
}

/** `-Infinity <= x` and `x <= Infinity`, spelled for `null` bounds. */
export function boundBelow(outer: Bound, inner: Bound): boolean {
  if (outer === null) return true;
  if (inner === null) return false;
  return outer <= inner;
}

export function boundAbove(inner: Bound, outer: Bound): boolean {
  if (outer === null) return true;
  if (inner === null) return false;
  return inner <= outer;
}

export function levelOf(type: SimpleType): Level {
  switch (type.tag) {
    case "var":
      return type.level;
    case "forall":
      return levelOf(type.body);
    case "fun":
      return Math.max(
        levelOf(type.param),
        levelOf(type.effects),
        levelOf(type.result),
      );
    case "record":
      return maxLevel([...type.fields.values()]);
    case "variant":
      return maxLevel([...type.cases.values()]);
    case "array":
      return levelOf(type.element);
    default:
      return 0;
  }
}

function maxLevel(types: readonly SimpleType[]): Level {
  let level = 0;
  for (const type of types) level = Math.max(level, levelOf(type));
  return level;
}
