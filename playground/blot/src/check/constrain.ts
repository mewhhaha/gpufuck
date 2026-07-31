// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Biunification.
//
// `constrain(lhs, rhs)` records that `lhs` flows into `rhs`. It never unifies:
// a variable accumulates lower and upper bounds, and a constraint against a
// variable is propagated to the bounds already recorded. That is what keeps the
// algorithm polynomial and what makes every program have a principal type
// without a single annotation.
//
// Levels and extrusion give `let`-polymorphism. A variable created inside a
// binding lives at a deeper level; when it escapes into a shallower one it is
// copied down rather than captured, so generalization needs no free-variable
// scan.

import {
  boundAbove,
  boundBelow,
  freshRigid,
  freshVar,
  type Level,
  levelOf,
  type Scheme,
  type SimpleType,
  type Typing,
  type Variable,
} from "./type.ts";
import { showRange } from "./print.ts";

export class TypeError_ extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "TypeError_";
  }
}

function mismatch(lhs: SimpleType, rhs: SimpleType): never {
  throw new TypeError_(`${describe(lhs)} is not ${describe(rhs)}`);
}

/** A short shape name, for messages that have not been coalesced yet. */
function describe(type: SimpleType): string {
  switch (type.tag) {
    case "var":
      return "an inferred type";
    case "rigid":
      return `the rigid type 's${type.id}`;
    case "forall":
      return "a polymorphic type";
    case "range":
      // A range is ground, so naming it needs nothing from a finished
      // inference — and naming it is the point: `0..` says which bound `-1`
      // fell outside of, where "an integer" does not.
      return `\`${showRange(type.domain, type.low, type.high)}\``;
    case "unit":
      return "()";
    case "fun":
      return "a function";
    case "record":
      return `a shape with ${[...type.fields.keys()].map((n) => `.${n}`).join(", ")}`;
    case "array":
      return "an array";
    case "variant": {
      const shown = [...type.cases.keys()].map((n) => `#${n}`).join(" | ");
      if (type.open) return `${shown} | ..`;
      return shown;
    }
    case "effects":
      return `<${[...type.labels].join(", ")}>`;
    case "opaque":
      return type.name;
    case "union":
      return type.members.map(describe).join(" | ");
    case "top":
      return "anything";
    case "bottom":
      return "nothing";
  }
}

type Cache = Set<string>;

function key(lhs: SimpleType, rhs: SimpleType): string {
  return `${identity(lhs)}<:${identity(rhs)}`;
}

const identities = new WeakMap<object, number>();
let nextIdentity = 0;

function identity(type: SimpleType): number {
  const existing = identities.get(type);
  if (existing !== undefined) return existing;
  nextIdentity += 1;
  identities.set(type, nextIdentity);
  return nextIdentity;
}

export function constrain(
  lhs: SimpleType,
  rhs: SimpleType,
  cache: Cache = new Set(),
): void {
  if (lhs === rhs) return;
  const seen = key(lhs, rhs);
  if (cache.has(seen)) return;
  // Recursion is admitted rather than rejected: revisiting a pair means the
  // constraint is already being proved, which is what makes recursive types
  // fall out instead of tripping an occurs check.
  if (lhs.tag === "var" || rhs.tag === "var") cache.add(seen);

  if (rhs.tag === "top" || lhs.tag === "bottom") return;

  if (lhs.tag === "forall") {
    constrain(instantiateForall(lhs, levelOf(rhs)), rhs, cache);
    return;
  }

  if (rhs.tag === "forall") {
    constrain(lhs, skolemize(rhs), cache);
    return;
  }

  if (lhs.tag === "rigid" && rhs.tag === "rigid" && lhs.id === rhs.id) {
    return;
  }

  if (lhs.tag === "fun" && rhs.tag === "fun") {
    constrain(rhs.param, lhs.param, cache);
    constrain(lhs.result, rhs.result, cache);
    constrain(lhs.effects, rhs.effects, cache);
    return;
  }

  if (lhs.tag === "record" && rhs.tag === "record") {
    // Width subtyping: a wider value satisfies a narrower requirement. This is
    // the whole of what a `duck` contract needed to be.
    for (const [name, required] of rhs.fields) {
      const present = lhs.fields.get(name);
      if (present === undefined) {
        throw new TypeError_(
          `no field \`.${name}\` on ${describe(lhs)}`,
        );
      }
      constrain(present, required, cache);
    }
    return;
  }

  if (lhs.tag === "array" && rhs.tag === "array") {
    constrain(lhs.element, rhs.element, cache);
    return;
  }

  if (lhs.tag === "variant" && rhs.tag === "variant") {
    // Fewer cases is a subtype: `#Ready` fits wherever `#Ready | #Failed` does.
    for (const [name, payload] of lhs.cases) {
      const accepted = rhs.cases.get(name);
      if (accepted === undefined) {
        // An open requirement names the constructors it reads and admits the
        // rest, which is exactly what an arm matching everything leaves behind.
        if (rhs.open) continue;
        throw new TypeError_(
          `\`#${name}\` is not one of ${describe(rhs)}`,
        );
      }
      constrain(payload, accepted, cache);
    }
    if (lhs.open && !rhs.open) {
      throw new TypeError_(
        `${describe(lhs)} may carry a constructor outside ${describe(rhs)}`,
      );
    }
    return;
  }

  if (lhs.tag === "effects" && rhs.tag === "effects") {
    // Fewer effects is a subtype, by the same reasoning as variants. This one
    // line is the entirety of effect-row inference.
    for (const label of lhs.labels) {
      if (!rhs.labels.has(label)) {
        throw new TypeError_(`effect \`${label}\` is not handled`);
      }
    }
    return;
  }

  if (lhs.tag === "range" && rhs.tag === "range") {
    if (lhs.domain !== rhs.domain) mismatch(lhs, rhs);
    if (!boundBelow(rhs.low, lhs.low) || !boundAbove(lhs.high, rhs.high)) {
      throw new TypeError_(
        `${describe(lhs)} is outside ${describe(rhs)}`,
      );
    }
    return;
  }

  if (lhs.tag === "union") {
    for (const member of lhs.members) constrain(member, rhs, cache);
    return;
  }

  if (rhs.tag === "union") {
    // Members are ground by construction, so trying each is decidable and
    // needs no backtracking through variable bounds.
    for (const member of rhs.members) {
      try {
        constrain(lhs, member, new Set(cache));
        return;
      } catch (error) {
        if (!(error instanceof TypeError_)) throw error;
      }
    }
    throw new TypeError_(`${describe(lhs)} is not one of ${describe(rhs)}`);
  }

  if (lhs.tag === "unit" && rhs.tag === "unit") return;
  if (lhs.tag === "opaque" && rhs.tag === "opaque" && lhs.name === rhs.name) {
    return;
  }

  if (lhs.tag === "var" && levelOf(rhs) <= lhs.level) {
    lhs.upper.push(rhs);
    for (const bound of [...lhs.lower]) constrain(bound, rhs, cache);
    return;
  }

  if (rhs.tag === "var" && levelOf(lhs) <= rhs.level) {
    rhs.lower.push(lhs);
    for (const bound of [...rhs.upper]) constrain(lhs, bound, cache);
    return;
  }

  // One side is a variable from a deeper level. Copy the other side down so the
  // constraint is recorded where the variable can see it.
  if (lhs.tag === "var") {
    constrain(lhs, extrude(rhs, false, lhs.level, new Map()), cache);
    return;
  }
  if (rhs.tag === "var") {
    constrain(extrude(lhs, true, rhs.level, new Map()), rhs, cache);
    return;
  }

  mismatch(lhs, rhs);
}

/** Copies a type down to `level`, freshening the variables that were deeper. */
function extrude(
  type: SimpleType,
  polarity: boolean,
  level: Level,
  seen: Map<Variable, Variable>,
): SimpleType {
  if (levelBelow(type, level)) return type;

  switch (type.tag) {
    case "var": {
      const existing = seen.get(type);
      if (existing !== undefined) return existing;
      const copy = freshVar(level);
      seen.set(type, copy);
      if (polarity) {
        type.upper.push(copy);
        copy.lower.push(
          ...type.lower.map((b) => extrude(b, polarity, level, seen)),
        );
      } else {
        type.lower.push(copy);
        copy.upper.push(
          ...type.upper.map((b) => extrude(b, polarity, level, seen)),
        );
      }
      return copy;
    }
    case "fun":
      return {
        tag: "fun",
        param: extrude(type.param, !polarity, level, seen),
        effects: extrude(type.effects, polarity, level, seen),
        result: extrude(type.result, polarity, level, seen),
      };
    case "forall":
      return {
        tag: "forall",
        variables: type.variables,
        body: extrude(type.body, polarity, level, seen),
      };
    case "record":
      return {
        tag: "record",
        fields: new Map(
          [...type.fields].map((
            [n, t],
          ) => [n, extrude(t, polarity, level, seen)]),
        ),
      };
    case "variant":
      return {
        tag: "variant",
        open: type.open,
        cases: new Map(
          [...type.cases].map((
            [n, t],
          ) => [n, extrude(t, polarity, level, seen)]),
        ),
      };
    case "array":
      return {
        tag: "array",
        element: extrude(type.element, polarity, level, seen),
      };
    default:
      return type;
  }
}

function levelBelow(type: SimpleType, level: Level): boolean {
  switch (type.tag) {
    case "var":
      return type.level <= level;
    case "fun":
      return levelBelow(type.param, level) && levelBelow(type.effects, level) &&
        levelBelow(type.result, level);
    case "forall":
      return levelBelow(type.body, level);
    case "record":
      return [...type.fields.values()].every((t) => levelBelow(t, level));
    case "variant":
      return [...type.cases.values()].every((t) => levelBelow(t, level));
    case "array":
      return levelBelow(type.element, level);
    default:
      return true;
  }
}

export function instantiate(typing: Typing, level: Level): SimpleType {
  if (typing.tag !== "scheme") return typing;
  return freshenAbove(typing.body, typing.level, level, new Map());
}

export function scheme(body: SimpleType, level: Level): Scheme {
  return { tag: "scheme", level, body };
}

function freshenAbove(
  type: SimpleType,
  limit: Level,
  level: Level,
  seen: Map<Variable, Variable>,
): SimpleType {
  if (levelBelow(type, limit)) return type;

  switch (type.tag) {
    case "var": {
      const existing = seen.get(type);
      if (existing !== undefined) return existing;
      const copy = freshVar(level);
      seen.set(type, copy);
      copy.lower.push(
        ...type.lower.map((b) => freshenAbove(b, limit, level, seen)),
      );
      copy.upper.push(
        ...type.upper.map((b) => freshenAbove(b, limit, level, seen)),
      );
      return copy;
    }
    case "fun":
      return {
        tag: "fun",
        param: freshenAbove(type.param, limit, level, seen),
        effects: freshenAbove(type.effects, limit, level, seen),
        result: freshenAbove(type.result, limit, level, seen),
      };
    case "forall":
      return {
        tag: "forall",
        variables: type.variables,
        body: freshenAbove(type.body, limit, level, seen),
      };
    case "record":
      return {
        tag: "record",
        fields: new Map(
          [...type.fields].map((
            [n, t],
          ) => [n, freshenAbove(t, limit, level, seen)]),
        ),
      };
    case "variant":
      return {
        tag: "variant",
        open: type.open,
        cases: new Map(
          [...type.cases].map((
            [n, t],
          ) => [n, freshenAbove(t, limit, level, seen)]),
        ),
      };
    case "array":
      return {
        tag: "array",
        element: freshenAbove(type.element, limit, level, seen),
      };
    default:
      return type;
  }
}

export function instantiateForall(
  type: SimpleType & { tag: "forall" },
  level: Level,
): SimpleType {
  const replacements = new Map<number, SimpleType>();
  for (const variable of type.variables) {
    replacements.set(variable, freshVar(level));
  }
  return substituteRigid(type.body, replacements);
}

function skolemize(
  type: SimpleType & { tag: "forall" },
): SimpleType {
  const replacements = new Map<number, SimpleType>();
  for (const variable of type.variables) {
    replacements.set(variable, freshRigid());
  }
  return substituteRigid(type.body, replacements);
}

function substituteRigid(
  type: SimpleType,
  replacements: ReadonlyMap<number, SimpleType>,
): SimpleType {
  switch (type.tag) {
    case "rigid": {
      const replacement = replacements.get(type.id);
      if (replacement === undefined) return type;
      return replacement;
    }
    case "forall": {
      const innerReplacements = new Map(replacements);
      for (const variable of type.variables) innerReplacements.delete(variable);
      return {
        tag: "forall",
        variables: type.variables,
        body: substituteRigid(type.body, innerReplacements),
      };
    }
    case "fun":
      return {
        tag: "fun",
        param: substituteRigid(type.param, replacements),
        effects: substituteRigid(type.effects, replacements),
        result: substituteRigid(type.result, replacements),
      };
    case "record":
      return {
        tag: "record",
        fields: new Map(
          [...type.fields].map(([name, member]) => [
            name,
            substituteRigid(member, replacements),
          ]),
        ),
      };
    case "array":
      return {
        tag: "array",
        element: substituteRigid(type.element, replacements),
      };
    case "variant":
      return {
        tag: "variant",
        open: type.open,
        cases: new Map(
          [...type.cases].map(([name, payload]) => [
            name,
            substituteRigid(payload, replacements),
          ]),
        ),
      };
    case "union":
      return {
        tag: "union",
        members: type.members.map((member) => substituteRigid(member, replacements)),
      };
    default:
      return type;
  }
}
