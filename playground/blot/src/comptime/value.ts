// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// One value domain.
//
// Types are values here, not a separate universe: `1` is an integer and also
// the singleton type inhabited only by `1`, `#Ready | #Failed Text` is a union
// value, and `I32` is a range. That is what removes the type sublanguage from
// the grammar and lets `struct` be prelude source rather than a compiler
// builtin.

import type { Expr, Pattern } from "../syntax/ast.ts";

export interface Env {
  readonly names: Map<string, Value>;
  readonly parent: Env | null;
}

export type Value =
  | { readonly tag: "int"; readonly value: bigint }
  | { readonly tag: "text"; readonly value: string }
  | { readonly tag: "unit" }
  /** Records and tuples. Tuples use `"0"`, `"1"`, … as labels. */
  | { readonly tag: "shape"; readonly fields: ReadonlyMap<string, Value> }
  | { readonly tag: "array"; readonly elements: readonly Value[] }
  | {
    readonly tag: "tag";
    readonly name: string;
    readonly payload: Value | null;
  }
  | {
    readonly tag: "closure";
    readonly parameter: Pattern;
    readonly body: Expr;
    readonly env: Env;
    readonly self: string | null;
    /**
     * Set only on a module closure. Two files may write the same relative
     * specifier and mean different targets, so the import table belongs to the
     * module, not to the program.
     */
    readonly imports?: ReadonlyMap<string, Value>;
  }
  | {
    readonly tag: "primitive";
    readonly name: string;
    readonly arity: number;
    readonly applied: readonly Value[];
  }
  /**
   * A function the host supplied. Opaque: a program can call it and nothing
   * else. This is the whole of the capability story — authority arrives in the
   * entry module's parameter and cannot be forged, imported, or ambient.
   */
  | {
    readonly tag: "native";
    readonly name: string;
    readonly arity: number;
    readonly applied: readonly Value[];
    readonly run: (args: readonly Value[]) => Value;
  }
  /**
   * An inclusive interval over one ordered domain. `domain` is set only when
   * both ends are open, where the bounds cannot say which domain is meant.
   */
  | {
    readonly tag: "range";
    readonly low: Value;
    readonly high: Value;
    readonly domain?: "int" | "text";
  }
  | { readonly tag: "union"; readonly members: readonly Value[] }
  | { readonly tag: "unbounded" }
  | { readonly tag: "arrow"; readonly domain: Value; readonly codomain: Value }
  | { readonly tag: "type-variable"; readonly id: number }
  | {
    readonly tag: "forall";
    readonly variable: number;
    readonly body: Value;
  }
  | {
    readonly tag: "effect";
    readonly id: number;
    readonly name: string;
    readonly operations: ReadonlyMap<string, Value>;
    /**
     * Whether the host implements it.
     *
     * A blot effect is discharged by a blot handler and specialized away. A
     * host effect's operations become typed WebAssembly imports, so its row is
     * the program's declared interface rather than something left unhandled —
     * which is why it may reach the module boundary and an ordinary one may
     * not.
     */
    readonly host: boolean;
  }
  /** A performable operation: an effect plus one of its operation names. */
  | { readonly tag: "operation"; readonly effect: Value; readonly name: string }
  /**
   * A type value carrying a namespace.
   *
   * This is what makes `struct` return the storage type itself rather than a
   * record beside it. `extended` is *transparent* everywhere that matters —
   * equality, inhabitation, and the bridge into inference all see straight
   * through to `inner`, so `sig p = Point;` means `p` is the tuple `Point`
   * describes. The members are reachable by field access and invisible to
   * typing, which is the only way one binding can be both the type and the
   * namespace of its accessors.
   */
  | {
    readonly tag: "extended";
    readonly inner: Value;
    readonly members: ReadonlyMap<string, Value>;
  }
  /**
   * A nominal wrapper. Invariant, and never confused with its carrier.
   *
   * Identity is the name together with the carrier, not the `seal` call site.
   * A fresh brand per call would make `List I32` a different type every time
   * the constructor ran, which is exactly what a parameterized nominal must
   * not be. Distinctness therefore comes from choosing a distinct name, which
   * is what "nominal" means everywhere else.
   */
  | {
    readonly tag: "sealed";
    readonly name: string;
    readonly inner: Value;
  }
  /**
   * A captured continuation, handed to a handler operation as `resume`. Affine:
   * calling it twice is an error, which is what makes one-shot handlers
   * checkable rather than merely conventional.
   */
  | {
    readonly tag: "continuation";
    readonly resume: (value: Value) => unknown;
    readonly state: { used: boolean };
  };

export const UNIT: Value = { tag: "unit" };
export const TRUE: Value = { tag: "tag", name: "True", payload: null };
export const FALSE: Value = { tag: "tag", name: "False", payload: null };

export function bool(condition: boolean): Value {
  return condition ? TRUE : FALSE;
}

export function shapeOf(entries: readonly (readonly [string, Value])[]): Value {
  return { tag: "shape", fields: new Map(entries) };
}

export function tupleOf(elements: readonly Value[]): Value {
  return shapeOf(
    elements.map((value, index) => [String(index), value] as const),
  );
}

/** Tuples are shapes with `0..n-1` labels; this recovers the positional view. */
export function asTuple(value: Value, arity: number): readonly Value[] | null {
  if (value.tag !== "shape" || value.fields.size !== arity) return null;
  const elements: Value[] = [];
  for (let index = 0; index < arity; index += 1) {
    const element = value.fields.get(String(index));
    if (element === undefined) return null;
    elements.push(element);
  }
  return elements;
}

export function childEnv(parent: Env | null): Env {
  return { names: new Map(), parent };
}

export function lookup(env: Env, name: string): Value | undefined {
  let scope: Env | null = env;
  while (scope !== null) {
    const value = scope.names.get(name);
    if (value !== undefined) return value;
    scope = scope.parent;
  }
  return undefined;
}

export function show(value: Value): string {
  if (value.tag === "int") return value.value.toString();
  if (value.tag === "text") return JSON.stringify(value.value);
  if (value.tag === "unit") return "()";
  if (value.tag === "unbounded") return "@type.unbounded";
  if (value.tag === "type-variable") return `'t${value.id}`;
  if (value.tag === "forall") {
    return `forall 't${value.variable}. ${show(value.body)}`;
  }
  if (value.tag === "closure") return "<function>";
  if (value.tag === "primitive") return `<${value.name}>`;
  if (value.tag === "native") return `<host ${value.name}>`;
  if (value.tag === "continuation") return "<resume>";
  if (value.tag === "effect") {
    return `<${value.host ? "host effect" : "effect"} ${value.name}>`;
  }
  if (value.tag === "operation") return `<operation ${value.name}>`;
  if (value.tag === "extended") return show(value.inner);
  if (value.tag === "sealed") return `${value.name} ${show(value.inner)}`;
  if (value.tag === "range") {
    // The same names the checker's printer uses. A range unbounded at both
    // ends is `Int` or `Str`; anything else shows its bounds. Rendering `Int`
    // as `@type.unbounded..@type.unbounded` was true and unreadable, and it
    // reached the user through every printed type value and every diagnostic
    // that quoted one.
    const open = value.low.tag === "unbounded";
    const shut = value.high.tag === "unbounded";
    const domain = value.domain !== undefined
      ? value.domain
      : value.low.tag === "text" || value.high.tag === "text"
      ? "text"
      : "int";
    if (open && shut) {
      if (domain === "text") return "Str";
      return "Int";
    }
    if (domain === "text" && value.low.tag === "text" && value.low.value === "" && shut) {
      return "Str";
    }
    const left = open ? "" : show(value.low);
    const right = shut ? "" : show(value.high);
    return `${left}..${right}`;
  }
  if (value.tag === "arrow") {
    return `${show(value.domain)} -> ${show(value.codomain)}`;
  }
  if (value.tag === "union") return value.members.map(show).join(" | ");
  if (value.tag === "tag") {
    return value.payload === null ? `#${value.name}` : `#${value.name} ${show(value.payload)}`;
  }
  if (value.tag === "array") {
    return `[${value.elements.map(show).join(", ")}]`;
  }
  const tuple = asTuple(value, value.fields.size);
  if (tuple !== null && value.fields.size > 0) {
    return `(${tuple.map(show).join(", ")})`;
  }
  const members = [...value.fields].map(([name, member]) => `.${name} = ${show(member)}`);
  return `{ ${members.join("; ")}${members.length === 0 ? "" : ";"} }`;
}

/** Structural equality. Closures and primitives are compared by identity. */
/** Which ordered domain a range lives in: its own label, else its bounds. */
export function rangeDomainOf(
  value: Value & { tag: "range" },
): "int" | "text" {
  if (value.domain !== undefined) return value.domain;
  if (value.low.tag === "text" || value.high.tag === "text") return "text";
  return "int";
}

export function equal(left: Value, right: Value): boolean {
  if (left === right) return true;
  if (left.tag === "extended") return equal(left.inner, right);
  if (right.tag === "extended") return equal(left, right.inner);
  if (left.tag !== right.tag) return false;
  if (left.tag === "int" && right.tag === "int") {
    return left.value === right.value;
  }
  if (left.tag === "text" && right.tag === "text") {
    return left.value === right.value;
  }
  if (left.tag === "unit" || left.tag === "unbounded") return true;
  if (left.tag === "tag" && right.tag === "tag") {
    if (left.name !== right.name) return false;
    if (left.payload === null || right.payload === null) {
      return left.payload === right.payload;
    }
    return equal(left.payload, right.payload);
  }
  if (left.tag === "array" && right.tag === "array") {
    return left.elements.length === right.elements.length &&
      left.elements.every((element, index) => equal(element, right.elements[index]));
  }
  if (left.tag === "shape" && right.tag === "shape") {
    if (left.fields.size !== right.fields.size) return false;
    for (const [name, member] of left.fields) {
      const other = right.fields.get(name);
      if (other === undefined || !equal(member, other)) return false;
    }
    return true;
  }
  if (left.tag === "range" && right.tag === "range") {
    // The domain is part of the identity. `Int` and `Str` are both
    // `unbounded..unbounded` and comparing only the bounds made them equal, so
    // `@type.union` deduplicated them and `Int | Str` silently became `Int`.
    if (rangeDomainOf(left) !== rangeDomainOf(right)) return false;
    return equal(left.low, right.low) && equal(left.high, right.high);
  }
  if (left.tag === "arrow" && right.tag === "arrow") {
    return equal(left.domain, right.domain) &&
      equal(left.codomain, right.codomain);
  }
  if (left.tag === "type-variable" && right.tag === "type-variable") {
    return left.id === right.id;
  }
  if (left.tag === "forall" && right.tag === "forall") {
    return left.variable === right.variable && equal(left.body, right.body);
  }
  if (left.tag === "union" && right.tag === "union") {
    return left.members.length === right.members.length &&
      left.members.every((member) => right.members.some((other) => equal(member, other)));
  }
  if (left.tag === "sealed" && right.tag === "sealed") {
    return left.name === right.name && equal(left.inner, right.inner);
  }
  if (left.tag === "effect" && right.tag === "effect") {
    return left.id === right.id;
  }
  return false;
}
