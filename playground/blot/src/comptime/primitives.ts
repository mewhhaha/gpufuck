// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// The `@` namespace: the entire compiler surface.
//
// Everything else — `struct`, `packed`, `Bool`, `Option`, `fold`, `+`, `==` —
// is prelude source in `src/prelude`. A capability earns a primitive only when
// it cannot be written in blot at all.
//
// Primitives are curried, like every other blot function. The readable
// tuple-taking spellings (`range (low, high)`) are prelude wrappers, which is
// where the ergonomics belong.

import type { Span } from "../syntax/ast.ts";
import { fail } from "../diagnostic.ts";
import { asTuple, bool, equal, show, UNIT, type Value } from "./value.ts";

export interface Primitive {
  readonly arity: number;
  readonly run: (
    args: readonly Value[],
    span: Span,
    phase: "comptime" | "runtime",
  ) => Value;
}

const I64_LOW = -0x8000000000000000n;
const I64_HIGH = 0x7fffffffffffffffn;

function integerResult(
  value: bigint,
  span: Span,
  operation: string,
  phase: "comptime" | "runtime",
): Value {
  if (phase === "runtime" && (value < I64_LOW || value > I64_HIGH)) {
    fail(
      "BLOT_INTEGER_OVERFLOW",
      `${operation} produced ${value}, outside signed i64 ${I64_LOW}..${I64_HIGH}.`,
      span,
    );
  }
  return { tag: "int", value };
}

let brands = 0;

function intOf(value: Value, span: Span, what: string): bigint {
  if (value.tag !== "int") {
    fail(
      "BLOT_TYPE",
      `${what} expects an integer, found ${show(value)}.`,
      span,
    );
  }
  return value.value;
}

function textOf(value: Value, span: Span, what: string): string {
  if (value.tag !== "text") {
    fail("BLOT_TYPE", `${what} expects text, found ${show(value)}.`, span);
  }
  return value.value;
}

function shapeFields(
  value: Value,
  span: Span,
  what: string,
): ReadonlyMap<string, Value> {
  if (value.tag !== "shape") {
    fail("BLOT_TYPE", `${what} expects a shape, found ${show(value)}.`, span);
  }
  return value.fields;
}

function arrayElements(
  value: Value,
  span: Span,
  what: string,
): readonly Value[] {
  if (value.tag !== "array") {
    fail("BLOT_TYPE", `${what} expects an array, found ${show(value)}.`, span);
  }
  return value.elements;
}

/** Unions are flat and duplicate-free, so `1 | 1 | 2` and `1 | 2` are one value. */
function union(left: Value, right: Value): Value {
  const members: Value[] = [];
  const add = (value: Value): void => {
    if (value.tag === "union") {
      for (const member of value.members) add(member);
      return;
    }
    if (!members.some((existing) => equal(existing, value))) {
      members.push(value);
    }
  };
  add(left);
  add(right);
  if (members.length === 1) return members[0];
  return { tag: "union", members };
}

function members(value: Value): readonly Value[] {
  return value.tag === "union" ? value.members : [value];
}

/**
 * Set algebra on types, by *containment* rather than by equality.
 *
 * Comparing members with `equal` made `Int & 1` empty and `Int \\ 1` the whole
 * of `Int` — both silently wrong, because `1` and `Int` are different values
 * and one is inside the other. A type is a set, so the question is what it
 * contains.
 */
function intersect(left: Value, right: Value): Value {
  const kept: Value[] = [];
  for (const member of members(left)) {
    for (const other of members(right)) {
      const meet = meetOf(member, other);
      if (meet !== null && !kept.some((seen) => equal(seen, meet))) {
        kept.push(meet);
      }
    }
  }
  if (kept.length === 0) {
    fail("BLOT_EMPTY_TYPE", "The intersection is empty.", { start: 0, end: 0 });
  }
  return kept.reduce(union);
}

/** The overlap of two ground members, or `null` when they are disjoint. */
function meetOf(left: Value, right: Value): Value | null {
  if (equal(left, right)) return left;
  // A literal inside a range is the overlap; this is the case `equal` missed.
  if (right.tag === "range" && inhabits(left, right)) return left;
  if (left.tag === "range" && inhabits(right, left)) return right;
  return null;
}

function difference(left: Value, right: Value, span: Span): Value {
  let kept = members(left);
  for (const other of members(right)) {
    const next: Value[] = [];
    for (const member of kept) next.push(...without(member, other, span));
    kept = next;
  }
  if (kept.length === 0) {
    fail("BLOT_EMPTY_TYPE", "The difference is empty.", span);
  }
  return kept.reduce(union);
}

/**
 * One ground member minus another, as the pieces that remain.
 *
 * Removing a point from an integer range splits it, and that is exact because
 * integers are discrete: `Int \\ 1` is `..0 | 2..`. Text is dense — there is no
 * least string above `"a"` — so removing a point from a text range is refused
 * rather than approximated, which is what returning the range unchanged was.
 */
function without(member: Value, other: Value, span: Span): Value[] {
  if (equal(member, other)) return [];
  if (member.tag !== "range") return [member];
  if (!inhabits(other, member)) return [member];
  if (other.tag === "int") {
    const pieces: Value[] = [];
    const below: Value = { tag: "int", value: other.value - 1n };
    const above: Value = { tag: "int", value: other.value + 1n };
    if (member.low.tag === "unbounded" || compare(member.low, below, span, "@type.diff") <= 0) {
      pieces.push({ tag: "range", low: member.low, high: below, domain: "int" });
    }
    if (member.high.tag === "unbounded" || compare(above, member.high, span, "@type.diff") <= 0) {
      pieces.push({ tag: "range", low: above, high: member.high, domain: "int" });
    }
    return pieces;
  }
  fail(
    "BLOT_UNREPRESENTABLE_DIFFERENCE",
    `Removing ${show(other)} from ${
      show(member)
    } cannot be written as a type: text has no least value above a given one, ` +
      "so the result is not a union of ranges.",
    span,
  );
}

/**
 * The one primitive behind type introspection.
 *
 * Types are values, so "inspect a type" has to mean "inspect a value", and the
 * only thing the evaluator knows that a program cannot already ask is which
 * *shape of representation* it is holding. `reflect` answers exactly that and
 * nothing more: it names the case and hands back the parts. Everything built on
 * top — refinement, `Extract`, `Omit`, matching a parameterized nominal — is
 * ordinary blot over the result, because the result is an ordinary tagged value
 * that `case` already destructures.
 *
 * The cases are split by *domain* rather than lumped into one `#Literal`, so a
 * blot-side comparison can tell an integer bound from a text bound without a
 * second primitive to ask.
 */
/** Which ordered domain a range lives in: its own label, else its bounds. */
function rangeDomain(value: Value & { tag: "range" }): "int" | "text" {
  if (value.domain !== undefined) return value.domain;
  if (value.low.tag === "text" || value.high.tag === "text") return "text";
  return "int";
}

function reflect(value: Value): Value {
  // Transparent here too: reflecting a struct reports its storage, because
  // that is what the type is. `@type.members` asks the other question.
  if (value.tag === "extended") return reflect(value.inner);
  const tagged = (name: string, payload: Value): Value => ({
    tag: "tag",
    name,
    payload,
  });
  const bare = (name: string): Value => ({ tag: "tag", name, payload: null });
  const record = (fields: Record<string, Value>): Value => ({
    tag: "shape",
    fields: new Map(Object.entries(fields)),
  });
  switch (value.tag) {
    case "int":
      return tagged("Int", value);
    case "text":
      return tagged("Text", value);
    case "unit":
      return bare("Unit");
    case "unbounded":
      return bare("Unbounded");
    case "tag":
      return tagged(
        "Tag",
        record({
          name: { tag: "text", value: value.name },
          payload: value.payload === null ? bare("None") : tagged("Some", value.payload),
        }),
      );
    case "range": {
      // The domain travels with the bounds. Without it `Int` and `Str` are both
      // "a range from unbounded to unbounded" and blot code cannot tell them
      // apart — which made `refines (Str, Int)` answer `#True`.
      const domain = rangeDomain(value);
      return tagged(
        "Range",
        record({
          low: value.low,
          high: value.high,
          domain: bare(domain === "text" ? "Text" : "Int"),
        }),
      );
    }
    case "union":
      return tagged("Union", { tag: "array", elements: [...value.members] });
    case "shape":
      return tagged("Shape", value);
    case "array":
      return tagged("Array", value);
    case "arrow":
      return tagged(
        "Arrow",
        record({ domain: value.domain, codomain: value.codomain }),
      );
    case "sealed":
      return tagged(
        "Sealed",
        record({
          name: { tag: "text", value: value.name },
          inner: value.inner,
        }),
      );
    default:
      // Closures, primitives, host functions, effects. A program can call these
      // but has no business taking them apart, and saying so is more honest
      // than inventing a case per callable kind.
      return bare("Opaque");
  }
}

/** A literal's type is the literal: `@type.of 1` is `1`, never `I32`. */
function typeOf(value: Value): Value {
  if (value.tag === "extended") return typeOf(value.inner);
  if (value.tag === "shape") {
    return {
      tag: "shape",
      fields: new Map(
        [...value.fields].map(([name, member]) => [name, typeOf(member)]),
      ),
    };
  }
  if (value.tag === "array") {
    return { tag: "array", elements: value.elements.map(typeOf) };
  }
  if (value.tag === "tag" && value.payload !== null) {
    return { tag: "tag", name: value.name, payload: typeOf(value.payload) };
  }
  return value;
}

function compare(left: Value, right: Value, span: Span, what: string): number {
  if (left.tag === "int" && right.tag === "int") {
    if (left.value < right.value) return -1;
    return left.value > right.value ? 1 : 0;
  }
  if (left.tag === "text" && right.tag === "text") {
    const leftScalars = [...left.value];
    const rightScalars = [...right.value];
    const length = Math.min(leftScalars.length, rightScalars.length);
    for (let index = 0; index < length; index += 1) {
      const leftScalar = leftScalars[index]!.codePointAt(0)!;
      const rightScalar = rightScalars[index]!.codePointAt(0)!;
      if (leftScalar < rightScalar) return -1;
      if (leftScalar > rightScalar) return 1;
    }
    if (leftScalars.length < rightScalars.length) return -1;
    if (leftScalars.length > rightScalars.length) return 1;
    return 0;
  }
  fail(
    "BLOT_TYPE",
    `${what} compares two integers or two texts, found ${show(left)} and ${show(right)}.`,
    span,
  );
}

function ordering(sign: number): Value {
  if (sign < 0) return { tag: "tag", name: "Less", payload: null };
  if (sign > 0) return { tag: "tag", name: "Greater", payload: null };
  return { tag: "tag", name: "Equal", payload: null };
}

/** Does `value` inhabit `type`? Structural, and total over the value domain. */
export function inhabits(value: Value, type: Value): boolean {
  // Members are invisible to typing: a struct's type is its storage.
  if (type.tag === "extended") return inhabits(value, type.inner);
  if (value.tag === "extended") return inhabits(value.inner, type);
  if (type.tag === "unbounded") return true;
  if (type.tag === "union") {
    return type.members.some((member) => inhabits(value, member));
  }
  if (type.tag === "range") {
    const aboveLow = type.low.tag === "unbounded" ||
      compare(value, type.low, { start: 0, end: 0 }, "@type.range") >= 0;
    const belowHigh = type.high.tag === "unbounded" ||
      compare(value, type.high, { start: 0, end: 0 }, "@type.range") <= 0;
    return aboveLow && belowHigh;
  }
  if (type.tag === "shape" && value.tag === "shape") {
    // Width subtyping: a wider value inhabits a narrower shape type.
    for (const [name, member] of type.fields) {
      const found = value.fields.get(name);
      if (found === undefined || !inhabits(found, member)) return false;
    }
    return true;
  }
  if (type.tag === "array" && value.tag === "array") {
    return value.elements.every((element) => type.elements.some((m) => inhabits(element, m)));
  }
  if (type.tag === "tag" && value.tag === "tag") {
    if (type.name !== value.name) return false;
    if (type.payload === null) return value.payload === null;
    return value.payload !== null && inhabits(value.payload, type.payload);
  }
  return equal(value, type);
}

export const PRIMITIVE_VALUES: ReadonlyMap<string, Value> = new Map<
  string,
  Value
>([
  ["@type.unbounded", { tag: "unbounded" }],
  // The unit type is the unit value. A singleton type is its inhabitant.
  ["@type.unit", UNIT],
  // The unbounded domains. A range with two open ends cannot say which domain
  // it means, so these name it.
  ["@type.int", {
    tag: "range",
    low: { tag: "unbounded" },
    high: { tag: "unbounded" },
    domain: "int",
  }],
  ["@type.text", {
    tag: "range",
    low: { tag: "unbounded" },
    high: { tag: "unbounded" },
    domain: "text",
  }],
  ["@shape.empty", { tag: "shape", fields: new Map() }],
  ["@array.empty", { tag: "array", elements: [] }],
]);

export const PRIMITIVES: ReadonlyMap<string, Primitive> = new Map<
  string,
  Primitive
>([
  // --- type algebra ---
  ["@type.range", {
    arity: 2,
    run: ([low, high]) => ({ tag: "range", low, high }),
  }],
  ["@type.union", { arity: 2, run: ([left, right]) => union(left, right) }],
  ["@type.intersect", {
    arity: 2,
    run: ([left, right]) => intersect(left, right),
  }],
  ["@type.diff", {
    arity: 2,
    run: ([left, right], span) => difference(left, right, span),
  }],
  ["@type.arrow", {
    arity: 2,
    run: ([domain, codomain]) => ({ tag: "arrow", domain, codomain }),
  }],
  ["@type.of", { arity: 1, run: ([value]) => typeOf(value) }],
  ["@type.seal", {
    arity: 2,
    run: ([name, inner], span) => ({
      tag: "sealed",
      name: textOf(name, span, "@type.seal"),
      inner,
    }),
  }],
  ["@type.open", {
    arity: 1,
    run: ([value], span) => {
      if (value.tag !== "sealed") {
        fail(
          "BLOT_TYPE",
          `@type.open expects a sealed value, found ${show(value)}.`,
          span,
        );
      }
      return value.inner;
    },
  }],
  // Refusing. The one thing a program cannot express itself: every other
  // primitive computes something, and a diagnostic is the absence of a value.
  // `expect` in the prelude is this plus a condition.
  ["@fail", {
    arity: 1,
    run: ([message], span) => {
      fail(
        "BLOT_REFUSED",
        message.tag === "text" ? message.value : show(message),
        span,
      );
    },
  }],
  ["@type.reflect", { arity: 1, run: ([value]) => reflect(value) }],
  // Attaching a member to a type value. This is what lets `struct` hand back
  // the storage type itself with its constructor and accessors reachable on
  // it, rather than a record beside the type. A duplicate is refused, so a
  // field named `new` collides loudly instead of shadowing the constructor.
  ["@type.attach", {
    arity: 3,
    run: ([target, name, member], span) => {
      const key = textOf(name, span, "@type.attach");
      const members = new Map(
        target.tag === "extended" ? target.members : [],
      );
      if (members.has(key)) {
        fail(
          "BLOT_DUPLICATE_MEMBER",
          `\`${key}\` is already a member of ${show(target)}.`,
          span,
        );
      }
      members.set(key, member);
      return {
        tag: "extended",
        inner: target.tag === "extended" ? target.inner : target,
        members,
      };
    },
  }],
  ["@type.members", {
    arity: 1,
    run: ([target]) => ({
      tag: "shape",
      fields: new Map(target.tag === "extended" ? target.members : []),
    }),
  }],
  ["@type.union_of", {
    arity: 1,
    run: ([values], span) => {
      const elements = arrayElements(values, span, "@type.union_of");
      if (elements.length === 0) {
        fail(
          "BLOT_EMPTY_TYPE",
          "@type.union_of has nothing to union: union has no identity element, " +
            "so an empty array is not the empty type.",
          span,
        );
      }
      return elements.reduce(union);
    },
  }],

  ["@satisfies", {
    arity: 2,
    run: ([value, type], span) => {
      if (!inhabits(value, type)) {
        fail(
          "BLOT_DOES_NOT_SATISFY",
          `${show(value)} does not inhabit ${show(type)}.`,
          span,
        );
      }
      return value;
    },
  }],

  // --- shapes ---
  ["@shape.get", {
    arity: 2,
    run: ([shape, name], span) => {
      const key = textOf(name, span, "@shape.get");
      const found = shapeFields(shape, span, "@shape.get").get(key);
      if (found === undefined) {
        fail("BLOT_NO_FIELD", `No field \`${key}\` on ${show(shape)}.`, span);
      }
      return found;
    },
  }],
  ["@shape.set", {
    arity: 3,
    run: ([shape, name, value], span) => {
      const fields = new Map(shapeFields(shape, span, "@shape.set"));
      fields.set(textOf(name, span, "@shape.set"), value);
      return { tag: "shape", fields };
    },
  }],
  ["@shape.remove", {
    arity: 2,
    run: ([shape, name], span) => {
      const fields = new Map(shapeFields(shape, span, "@shape.remove"));
      fields.delete(textOf(name, span, "@shape.remove"));
      return { tag: "shape", fields };
    },
  }],
  ["@shape.names", {
    arity: 1,
    run: ([shape], span) => ({
      tag: "array",
      elements: [...shapeFields(shape, span, "@shape.names").keys()].map((
        name,
      ) => ({
        tag: "text" as const,
        value: name,
      })),
    }),
  }],
  ["@shape.has", {
    arity: 2,
    run: ([shape, name], span) =>
      bool(
        shapeFields(shape, span, "@shape.has").has(
          textOf(name, span, "@shape.has"),
        ),
      ),
  }],

  // --- arrays ---
  ["@array.len", {
    arity: 1,
    run: ([array], span) => ({
      tag: "int",
      value: BigInt(arrayElements(array, span, "@array.len").length),
    }),
  }],
  ["@array.get", {
    arity: 2,
    run: ([array, index], span) => {
      const elements = arrayElements(array, span, "@array.get");
      const position = Number(intOf(index, span, "@array.get"));
      if (position < 0 || position >= elements.length) {
        fail(
          "BLOT_OUT_OF_BOUNDS",
          `Index ${position} is outside an array of ${elements.length}.`,
          span,
        );
      }
      return elements[position];
    },
  }],
  ["@array.set", {
    arity: 3,
    run: ([array, index, value], span) => {
      const elements = [...arrayElements(array, span, "@array.set")];
      const position = Number(intOf(index, span, "@array.set"));
      if (position < 0 || position >= elements.length) {
        fail(
          "BLOT_OUT_OF_BOUNDS",
          `Index ${position} is outside an array of ${elements.length}.`,
          span,
        );
      }
      elements[position] = value;
      return { tag: "array", elements };
    },
  }],
  ["@array.push", {
    arity: 2,
    run: ([array, value], span) => ({
      tag: "array",
      elements: [...arrayElements(array, span, "@array.push"), value],
    }),
  }],

  // --- integers ---
  ["@int.add", {
    arity: 2,
    run: ([l, r], span, phase) =>
      integerResult(
        intOf(l, span, "@int.add") + intOf(r, span, "@int.add"),
        span,
        "@int.add",
        phase,
      ),
  }],
  ["@int.sub", {
    arity: 2,
    run: ([l, r], span, phase) =>
      integerResult(
        intOf(l, span, "@int.sub") - intOf(r, span, "@int.sub"),
        span,
        "@int.sub",
        phase,
      ),
  }],
  ["@int.mul", {
    arity: 2,
    run: ([l, r], span, phase) =>
      integerResult(
        intOf(l, span, "@int.mul") * intOf(r, span, "@int.mul"),
        span,
        "@int.mul",
        phase,
      ),
  }],
  ["@int.div", {
    arity: 2,
    run: ([l, r], span, phase) => {
      const divisor = intOf(r, span, "@int.div");
      if (divisor === 0n) {
        fail("BLOT_DIVIDE_BY_ZERO", "Division by zero.", span);
      }
      return integerResult(
        intOf(l, span, "@int.div") / divisor,
        span,
        "@int.div",
        phase,
      );
    },
  }],
  ["@int.rem", {
    arity: 2,
    run: ([l, r], s) => {
      const divisor = intOf(r, s, "@int.rem");
      if (divisor === 0n) fail("BLOT_DIVIDE_BY_ZERO", "Remainder by zero.", s);
      return { tag: "int", value: intOf(l, s, "@int.rem") % divisor };
    },
  }],
  ["@int.neg", {
    arity: 1,
    run: ([value], span, phase) =>
      integerResult(
        -intOf(value, span, "@int.neg"),
        span,
        "@int.neg",
        phase,
      ),
  }],
  // One comparison primitive. `Eq` and `Ord` are prelude source over it.
  //
  // Integers only, which is what its name and its declared type both say.
  // `compare` is more general because a range bound may be text, but reaching
  // that generality through here let `"a" == "b"` run while failing to check —
  // the two executions have to agree, and `Text.cmp` is the one for text.
  ["@int.cmp", {
    arity: 2,
    run: ([l, r], s) => {
      if (l.tag !== "int" || r.tag !== "int") {
        fail(
          "BLOT_TYPE",
          `@int.cmp compares two integers, found ${show(l)} and ${
            show(r)
          }. \`Text.cmp\` compares text.`,
          s,
        );
      }
      return ordering(compare(l, r, s, "@int.cmp"));
    },
  }],

  // --- text ---
  ["@text.concat", {
    arity: 2,
    run: ([l, r], s) => ({
      tag: "text",
      value: textOf(l, s, "@text.concat") + textOf(r, s, "@text.concat"),
    }),
  }],
  ["@text.len", {
    arity: 1,
    run: ([v], s) => ({
      tag: "int",
      value: BigInt([...textOf(v, s, "@text.len")].length),
    }),
  }],
  ["@text.cmp", {
    arity: 2,
    run: ([l, r], s) => ordering(compare(l, r, s, "@text.cmp")),
  }],
  ["@text.contains", {
    arity: 2,
    run: ([text, query], span) =>
      bool(
        textOf(text, span, "@text.contains").includes(
          textOf(query, span, "@text.contains"),
        ),
      ),
  }],
  ["@text.of_int", {
    arity: 1,
    run: ([v], s) => ({
      tag: "text",
      value: intOf(v, s, "@text.of_int").toString(),
    }),
  }],

  // --- ownership (given meaning by the linearity pass; identity when running) ---
  ["@linear.own", { arity: 1, run: ([value]) => value }],
  ["@linear.maybe", { arity: 1, run: ([value]) => value }],
  ["@linear.borrow", { arity: 1, run: ([value]) => value }],

  ["@panic", {
    arity: 1,
    run: ([message], span) => fail("BLOT_PANIC", textOf(message, span, "@panic"), span),
  }],
]);

/** `@effect` needs a fresh identity per call, so it is built rather than tabled. */
export function makeEffect(
  name: string,
  operations: ReadonlyMap<string, Value>,
  host: boolean,
): Value {
  return { tag: "effect", id: brands += 1, name, operations, host };
}

export { asTuple };
