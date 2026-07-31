// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Coalescing an inferred type into something readable.
//
// A variable during inference is a bag of bounds. Reading it back means taking
// the variable *together with* the union of its lower bounds where it appears
// positively, and together with the intersection of its upper bounds where it
// appears negatively. Dropping the variable and keeping only the bounds loses
// information: in `case flag of #False => #Off, #True => other end` the result
// is `'a | #Off`, and printing just `#Off` would claim `other` never reaches it.
//
// A variable that occurs in only one polarity across the whole type carries no
// information — nothing on the other side can observe it — so it is omitted and
// its bounds stand alone. That is the one simplification here, and it is what
// keeps ordinary types free of noise.
//
// The inference tests assert these strings. A lattice change that widens an
// inferred type shows up as a diff rather than as "still compiles", so the
// printer has to be canonical: variables are named in the order they are
// reached, never by allocation id.

import type { Bound, SimpleType, Variable } from "./type.ts";

interface Occurrences {
  readonly positive: Set<number>;
  readonly negative: Set<number>;
}

export function show(type: SimpleType): string {
  const occurrences = collect(type);
  const names = new Map<number, string>();
  const recursive = new Set<string>();
  const active = new Map<string, string>();
  const quantifiedNames = new Map<number, string>();
  let nextBinder = 0;

  const nameFor = (variable: Variable): string => {
    const existing = names.get(variable.id);
    if (existing !== undefined) return existing;
    // `e` is reserved for effect-row variables. They are already told apart by
    // the missing `'`, but `'e` next to `e2` in one signature reads badly.
    const letters = "abcdfghijklmnopqrstuvwxyz";
    const index = names.size;
    const suffix = index >= letters.length ? String(Math.floor(index / letters.length)) : "";
    const name = `'${letters[index % letters.length]}${suffix}`;
    names.set(variable.id, name);
    return name;
  };

  // Effect-row variables are named `e`, `e1`, … rather than `'a`. A row is a
  // set, not a structure, so it needs no `'` to be told apart from a label, and
  // the different alphabet is what distinguishes a row from a value type at a
  // glance.
  const rowNames = new Map<number, string>();
  const rowNameFor = (variable: Variable): string => {
    const existing = rowNames.get(variable.id);
    if (existing !== undefined) return existing;
    const name = rowNames.size === 0 ? "e" : `e${rowNames.size}`;
    rowNames.set(variable.id, name);
    return name;
  };

  /**
   * `~ { Console, e }` — the set of effects a function may perform.
   *
   * Braces without a leading `.` on each member: a row is a set of effect names,
   * where a record is a set of `.field = type` pairs, and the two are different
   * enough that they should not look alike. `e` is the rest of the row, shown
   * only where the other polarity can observe it — otherwise every pure-looking
   * function would carry a row variable that says nothing.
   */
  const row = (effects: SimpleType, polarity: boolean): string => {
    const parts = rowParts(effects, polarity, occurrences, rowNameFor);
    return parts.length === 0 ? "" : ` ~ ${braces(parts)}`;
  };

  const go = (current: SimpleType, polarity: boolean): string => {
    switch (current.tag) {
      case "var": {
        const at = `${current.id}${polarity ? "+" : "-"}`;
        const inProgress = active.get(at);
        if (inProgress !== undefined) {
          recursive.add(at);
          return inProgress;
        }
        nextBinder += 1;
        const binder = `'r${nextBinder}`;
        active.set(at, binder);

        const bounds = merge(
          polarity ? current.lower : current.upper,
          polarity,
        );
        const parts = [...new Set(bounds.map((bound) => go(bound, polarity)))];
        // Keep the variable only where the other polarity can observe it.
        const observable = occurrences.positive.has(current.id) &&
          occurrences.negative.has(current.id);
        if (observable || parts.length === 0) parts.unshift(nameFor(current));

        const body = parts.length === 1 ? parts[0] : `(${parts.join(polarity ? " | " : " & ")})`;

        active.delete(at);
        if (recursive.has(at)) {
          recursive.delete(at);
          return `μ${binder}.${body}`;
        }
        return body;
      }

      case "rigid": {
        const name = quantifiedNames.get(current.id);
        if (name !== undefined) return name;
        return `'s${current.id}`;
      }

      case "forall": {
        const names = current.variables.map((variable) => {
          const name = `'q${quantifiedNames.size}`;
          quantifiedNames.set(variable, name);
          return name;
        });
        return `forall ${names.join(" ")}. ${go(current.body, polarity)}`;
      }

      case "range":
        return showRange(current.domain, current.low, current.high);

      case "unit":
        return "()";

      case "fun": {
        const param = go(current.param, !polarity);
        const result = go(current.result, polarity);
        // Whether the parameter is an arrow is only knowable after coalescing —
        // a variable whose bound is a function renders as one — so the check is
        // on the rendered text, not on the node.
        const wrapped = hasTopLevelArrow(param) ? `(${param})` : param;
        return `${wrapped} -> ${result}${row(current.effects, polarity)}`;
      }

      case "record": {
        if (isTuple(current.fields)) {
          const elements = [...current.fields.keys()]
            .sort((a, b) => Number(a) - Number(b))
            .map((name) => go(current.fields.get(name)!, polarity));
          return `(${elements.join(", ")})`;
        }
        const members = [...current.fields].map(([name, member]) =>
          `.${name} = ${go(member, polarity)}`
        );
        if (members.length === 0) return "{}";
        return `{ ${members.join("; ")}; }`;
      }

      case "array":
        return `[${go(current.element, polarity)}]`;

      case "variant": {
        const cases = [...current.cases].map(([name, payload]) =>
          payload.tag === "unit" ? `#${name}` : `#${name} ${go(payload, polarity)}`
        );
        if (current.open) return [...cases, ".."].join(" | ");
        if (cases.length === 0) return "⊥";
        return cases.join(" | ");
      }

      case "effects":
        return braces([...current.labels].map(stripId).sort());

      case "union":
        return current.members.map((member) => go(member, polarity)).join(
          " | ",
        );

      case "opaque":
        return current.name;

      case "top":
        return "⊤";

      case "bottom":
        return "⊥";
    }
  };

  return go(type, true);
}

/** Which variables are reachable in which polarity. */
function collect(type: SimpleType): Occurrences {
  const positive = new Set<number>();
  const negative = new Set<number>();
  const seen = new Set<string>();

  const walk = (current: SimpleType, polarity: boolean): void => {
    switch (current.tag) {
      case "var": {
        const at = `${current.id}${polarity ? "+" : "-"}`;
        if (seen.has(at)) return;
        seen.add(at);
        (polarity ? positive : negative).add(current.id);
        for (const bound of polarity ? current.lower : current.upper) {
          walk(bound, polarity);
        }
        return;
      }
      case "fun":
        walk(current.param, !polarity);
        walk(current.effects, polarity);
        walk(current.result, polarity);
        return;
      case "forall":
        walk(current.body, polarity);
        return;
      case "record":
        for (const member of current.fields.values()) walk(member, polarity);
        return;
      case "variant":
        for (const payload of current.cases.values()) walk(payload, polarity);
        return;
      case "union":
        for (const member of current.members) walk(member, polarity);
        return;
      case "array":
        walk(current.element, polarity);
        return;
      default:
        return;
    }
  };

  walk(type, true);
  return { positive, negative };
}

/**
 * Effect rows join by union, so several `effects` bounds on one variable are one
 * row. Without this every call site would add another `<>` to the printout and
 * the row would be unreadable exactly where it matters.
 */
function merge(
  bounds: readonly SimpleType[],
  polarity: boolean,
): readonly SimpleType[] {
  const labels = new Set<string>();
  const fields = new Map<string, SimpleType>();
  const rest: SimpleType[] = [];
  let sawRow = false;
  let sawRecord = false;
  let overlapping = false;

  for (const bound of bounds) {
    if (bound.tag === "effects") {
      sawRow = true;
      for (const label of bound.labels) labels.add(label);
      continue;
    }
    // An intersection of records with disjoint fields *is* one record. Two
    // projections off the same parameter produce exactly that, and printing
    // `{ .w = Int; } & { .h = Int; }` for `s.w` and `s.h` is noise.
    if (!polarity && bound.tag === "record") {
      sawRecord = true;
      for (const [name, member] of bound.fields) {
        if (fields.has(name)) overlapping = true;
        fields.set(name, member);
      }
      continue;
    }
    rest.push(bound);
  }

  const merged = [...rest];
  if (sawRecord) {
    if (overlapping) {
      // Distinct constraints on one field are a genuine intersection; keep them.
      for (const bound of bounds) {
        if (bound.tag === "record") merged.push(bound);
      }
    } else {
      merged.push({ tag: "record", fields });
    }
  }
  if (!sawRow) return merged;
  if (labels.size === 0 && merged.length > 0) return merged;
  return [...merged, { tag: "effects", labels }];
}

function hasTopLevelArrow(rendered: string): boolean {
  let depth = 0;
  for (let index = 0; index < rendered.length; index += 1) {
    const character = rendered[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") {
      depth -= 1;
    } else if (
      depth === 0 && character === "-" && rendered[index + 1] === ">"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The labels a row carries, plus its tail variable when one is observable.
 *
 * A row variable accumulates `effects` bounds rather than being a structural
 * tail, so the labels are the union of those bounds and the variable stands for
 * whatever else may join later.
 */
function rowParts(
  effects: SimpleType,
  polarity: boolean,
  occurrences?: Occurrences,
  nameFor?: (variable: Variable) => string,
): string[] {
  const labels = new Set<string>();
  const tails: string[] = [];

  const walk = (current: SimpleType, seen: Set<number>): void => {
    if (current.tag === "effects") {
      for (const label of current.labels) labels.add(stripId(label));
      return;
    }
    if (current.tag !== "var" || seen.has(current.id)) return;
    seen.add(current.id);
    const observable = occurrences === undefined ||
      (occurrences.positive.has(current.id) &&
        occurrences.negative.has(current.id));
    if (observable && nameFor !== undefined) tails.push(nameFor(current));
    for (const bound of polarity ? current.lower : current.upper) {
      walk(bound, seen);
    }
  };

  walk(effects, new Set());
  return [...[...labels].sort(), ...tails];
}

/** An effect's identity is `Name#id`; the id is for the checker, not the reader. */
function stripId(label: string): string {
  return label.replace(/#\d+$/, "");
}

function braces(parts: readonly string[]): string {
  return parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`;
}

function isTuple(fields: ReadonlyMap<string, SimpleType>): boolean {
  if (fields.size === 0) return false;
  for (let index = 0; index < fields.size; index += 1) {
    if (!fields.has(String(index))) return false;
  }
  return true;
}

export function showRange(
  domain: "int" | "text",
  low: Bound,
  high: Bound,
): string {
  if (low !== null && low === high) {
    return domain === "text" ? JSON.stringify(low) : String(low);
  }
  // `Str`, not `Text`: `Text` is the prelude's namespace record, so the name
  // this printer gives a type has to be the name a `sig` accepts.
  if (low === null && high === null) return domain === "int" ? "Int" : "Str";
  // `""` is the bottom of the lexicographic order, so `""..` is every text.
  if (domain === "text" && low === "" && high === null) return "Str";
  const left = low === null ? "" : domain === "text" ? JSON.stringify(low) : String(low);
  const right = high === null ? "" : domain === "text" ? JSON.stringify(high) : String(high);
  return `${left}..${right}`;
}

/** The module-level row: empty means nothing escaped unhandled. */
export function showModuleRow(effects: SimpleType): string {
  const parts = rowParts(effects, true);
  return parts.length === 0 ? "" : braces(parts);
}
