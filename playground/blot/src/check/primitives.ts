// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Type schemes for the `@` namespace.
//
// The table is short because the namespace is. Everything else — `+`, `==`,
// `struct`, `fold` — is prelude source and gets inferred like any other blot
// code.
//
// Three of these are deliberately imprecise, and it is worth saying which and
// why. `@shape.get`, `@shape.set`, and `@shape.remove` project a field named by
// a value, not by a literal. Their result genuinely is not determined until the
// name is known, which happens during comptime specialization. Their result
// type is therefore an unconstrained variable: inference learns nothing and
// rejects nothing. That is the honest answer, and it is different from `⊤`,
// which would claim the result is safe to use anywhere.

import {
  BOTTOM,
  effects,
  freshVar,
  fun,
  INT,
  record,
  type Scheme,
  type SimpleType,
  TEXT,
  UNIT,
  variant,
} from "./type.ts";
import { scheme } from "./constrain.ts";

const BOOL: SimpleType = variant([["True", UNIT], ["False", UNIT]]);
const ORDERING: SimpleType = variant([
  ["Less", UNIT],
  ["Equal", UNIT],
  ["Greater", UNIT],
]);

/** A type value — what `@type.*` produces. Opaque to inference by design. */
const TYPE: SimpleType = { tag: "opaque", name: "Type" };

/**
 * What `@type.reflect` answers with.
 *
 * Every type-valued payload is a *fresh variable*, not the opaque `Type`, and
 * that is deliberate in the same way `@shape.get`'s result is. Types are
 * values, so a record of types is a type and so is `42`; there is no type
 * smaller than "any value" that reflection could honestly promise about a
 * payload. Inference therefore learns which case it has — enough to check the
 * `case` arms — and learns nothing about what is inside, which is the truth.
 */
function reflection(fresh: () => SimpleType): SimpleType {
  return variant([
    ["Int", INT],
    ["Text", TEXT],
    ["Unit", UNIT],
    ["Unbounded", UNIT],
    ["Opaque", UNIT],
    [
      "Tag",
      record([
        ["name", TEXT],
        ["payload", variant([["None", UNIT], ["Some", fresh()]])],
      ]),
    ],
    [
      "Range",
      record([
        ["low", fresh()],
        ["high", fresh()],
        ["domain", variant([["Int", UNIT], ["Text", UNIT]])],
      ]),
    ],
    ["Union", { tag: "array", element: fresh() }],
    ["Shape", fresh()],
    ["Array", { tag: "array", element: fresh() }],
    ["Arrow", record([["domain", fresh()], ["codomain", fresh()]])],
    ["Sealed", record([["name", TEXT], ["inner", fresh()]])],
  ]);
}

const PURE = effects([]);

/** Curried, like every blot function. `a -> b -> c`, not `(a, b) -> c`. */
function curried(
  params: readonly SimpleType[],
  result: SimpleType,
): SimpleType {
  let built = result;
  for (let index = params.length - 1; index >= 0; index -= 1) {
    built = fun(params[index], built, PURE);
  }
  return built;
}

/** Builds a scheme whose quantified variables live one level above ground. */
function poly(build: (fresh: () => SimpleType) => SimpleType): Scheme {
  const fresh = (): SimpleType => freshVar(1);
  return scheme(build(fresh), 0);
}

function mono(type: SimpleType): Scheme {
  return scheme(type, 0);
}

export const PRIMITIVE_TYPES: ReadonlyMap<string, Scheme> = new Map<
  string,
  Scheme
>([
  // --- integers ---
  ["@int.add", mono(curried([INT, INT], INT))],
  ["@int.sub", mono(curried([INT, INT], INT))],
  ["@int.mul", mono(curried([INT, INT], INT))],
  ["@int.div", mono(curried([INT, INT], INT))],
  ["@int.rem", mono(curried([INT, INT], INT))],
  ["@int.neg", mono(curried([INT], INT))],
  // One comparison primitive; `Eq` and `Ord` are prelude source over it.
  ["@int.cmp", mono(curried([INT, INT], ORDERING))],

  // --- text ---
  ["@text.concat", mono(curried([TEXT, TEXT], TEXT))],
  ["@text.len", mono(curried([TEXT], INT))],
  ["@text.cmp", mono(curried([TEXT, TEXT], ORDERING))],
  ["@text.contains", mono(curried([TEXT, TEXT], BOOL))],
  ["@text.of_int", mono(curried([INT], TEXT))],

  // --- arrays ---
  ["@array.empty", poly((fresh) => ({ tag: "array", element: fresh() }))],
  [
    "@array.len",
    poly((fresh) => curried([{ tag: "array", element: fresh() }], INT)),
  ],
  [
    "@array.get",
    poly((fresh) => {
      const element = fresh();
      return curried([{ tag: "array", element }, INT], element);
    }),
  ],
  [
    "@array.set",
    poly((fresh) => {
      const element = fresh();
      const array: SimpleType = { tag: "array", element };
      return curried([array, INT, element], array);
    }),
  ],
  [
    "@array.push",
    poly((fresh) => {
      const element = fresh();
      const array: SimpleType = { tag: "array", element };
      return curried([array, element], array);
    }),
  ],

  // --- shapes ---
  //
  // The field name is a value, so the result is not determined until
  // specialization. An unconstrained variable says exactly that.
  ["@shape.empty", mono(record([]))],
  ["@shape.get", poly((fresh) => curried([fresh(), TEXT], fresh()))],
  ["@shape.set", poly((fresh) => curried([fresh(), TEXT, fresh()], fresh()))],
  ["@shape.remove", poly((fresh) => curried([fresh(), TEXT], fresh()))],
  [
    "@shape.names",
    poly((fresh) => curried([fresh()], { tag: "array", element: TEXT })),
  ],
  ["@shape.has", poly((fresh) => curried([fresh(), TEXT], BOOL))],

  // --- types are values, and a type value is opaque to inference ---
  ["@type.unbounded", mono(TYPE)],
  ["@type.int", mono(TYPE)],
  ["@type.text", mono(TYPE)],
  ["@type.unit", mono(UNIT)],
  // Type algebra operates on values, because types *are* values: `1 | 2` unions
  // two integers and `#Ready | #Failed Text` unions two constructors. Requiring
  // `Type` on the operands would reject exactly the programs the design exists
  // to allow. Precision comes from bridging the computed value at the `sig`,
  // not from constraining the operands here.
  ["@type.range", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.union", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.intersect", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.diff", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.arrow", poly((fresh) => curried([fresh(), fresh()], TYPE))],
  ["@type.of", poly((fresh) => curried([fresh()], TYPE))],
  ["@type.seal", poly((fresh) => curried([TEXT, fresh()], TYPE))],
  ["@type.open", poly((fresh) => curried([fresh()], fresh()))],
  // `@fail` never returns, so its result is whatever the context needs.
  ["@fail", poly((fresh) => curried([TEXT], fresh()))],
  ["@type.reflect", poly((fresh) => curried([fresh()], reflection(fresh)))],
  // Attaching a member returns the same type value. Inference sees straight
  // through the namespace, so the result is the target unchanged.
  ["@type.attach", poly((fresh) => curried([fresh(), TEXT, fresh()], TYPE))],
  ["@type.members", poly((fresh) => curried([fresh()], fresh()))],
  [
    "@type.union_of",
    poly((fresh) => curried([{ tag: "array", element: fresh() }], TYPE)),
  ],
  [
    "@forall",
    poly((fresh) => {
      const body = fresh();
      return curried([body], body);
    }),
  ],
  // `@satisfies` returns its value unchanged; the check is against a comptime
  // type, so it constrains nothing here.
  [
    "@satisfies",
    poly((fresh) => {
      const value = fresh();
      return curried([value, fresh()], value);
    }),
  ],

  // --- ownership; the linearity pass gives these meaning ---
  [
    "@linear.own",
    poly((fresh) => {
      const value = fresh();
      return curried([value], value);
    }),
  ],
  [
    "@linear.borrow",
    poly((fresh) => {
      const value = fresh();
      return curried([value], value);
    }),
  ],

  ["@panic", mono(curried([TEXT], BOTTOM))],
  ["@import", poly((fresh) => curried([TEXT], fresh()))],
]);

export { BOOL, ORDERING, TYPE };
