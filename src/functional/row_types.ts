import type { FunctionalTypeSchema } from "./abi.ts";
import type { FunctionalEffectOperation } from "./effect_contract.ts";
import type { FunctionalSurfaceTypeDeclaration } from "./surface_builder.ts";

const DEFAULT_MAXIMUM_TRANSITIONS = 100_000;
const HARD_MAXIMUM_TRANSITIONS = 1_000_000;
const MAXIMUM_ROW_FIELDS = 256;
const MAXIMUM_ROW_SUBSTITUTIONS = 256;

export type FunctionalRowKind = "record" | "variant" | "effect";

export interface FunctionalRowField {
  readonly label: string;
  readonly type: FunctionalTypeSchema;
}

export interface FunctionalRow {
  readonly kind: FunctionalRowKind;
  readonly fields: readonly FunctionalRowField[];
  readonly tail: string | null;
}

export interface FunctionalRowSubstitutionEntry {
  readonly variable: string;
  readonly row: FunctionalRow;
}

export interface FunctionalRowUnificationOptions {
  readonly maximumTransitions?: number;
  readonly substitution?: readonly FunctionalRowSubstitutionEntry[];
}

export type FunctionalRowUnification =
  | {
    readonly ok: true;
    readonly row: FunctionalRow;
    readonly substitution: readonly FunctionalRowSubstitutionEntry[];
    readonly transitions: number;
  }
  | {
    readonly ok: false;
    readonly kind:
      | "kind-mismatch"
      | "field-mismatch"
      | "closed-row-mismatch"
      | "recursive-row"
      | "out-of-fuel";
    readonly message: string;
    readonly transitions: number;
  };

interface MutableRowState {
  readonly maximumTransitions: number;
  readonly substitution: Map<string, FunctionalRow>;
  transitions: number;
  nextVariable: number;
}

class RowFuelExhausted extends Error {}

/** Unifies two open rows and returns the explicit tail substitution. */
export function unifyFunctionalRows(
  left: FunctionalRow,
  right: FunctionalRow,
  options: FunctionalRowUnificationOptions = {},
): FunctionalRowUnification {
  const normalizedLeft = normalizeRow(left, "left row");
  const normalizedRight = normalizeRow(right, "right row");
  if (normalizedLeft.kind !== normalizedRight.kind) {
    return {
      ok: false,
      kind: "kind-mismatch",
      message: `cannot unify ${normalizedLeft.kind} row with ${normalizedRight.kind} row`,
      transitions: 0,
    };
  }
  const state: MutableRowState = {
    maximumTransitions: transitionLimit(options.maximumTransitions),
    substitution: substitutionMap(options.substitution ?? [], normalizedLeft.kind),
    transitions: 0,
    nextVariable: 0,
  };
  try {
    const failure = unifyRows(normalizedLeft, normalizedRight, state);
    if (failure !== null) return { ...failure, transitions: state.transitions };
    const row = resolveRow(normalizedLeft, state, new Set());
    return {
      ok: true,
      row,
      substitution: Object.freeze([...state.substitution].map(([variable, row]) => ({
        variable,
        row: resolveRow(row, state, new Set([variable])),
      }))),
      transitions: state.transitions,
    };
  } catch (error) {
    if (!(error instanceof RowFuelExhausted)) throw error;
    return {
      ok: false,
      kind: "out-of-fuel",
      message: `functional row unification exceeded ${state.maximumTransitions} transitions`,
      transitions: state.transitions,
    };
  }
}

/** Applies a previously verified substitution to one row. */
export function resolveFunctionalRow(
  row: FunctionalRow,
  substitution: readonly FunctionalRowSubstitutionEntry[],
): FunctionalRow {
  const normalized = normalizeRow(row, "resolved row");
  const state: MutableRowState = {
    maximumTransitions: HARD_MAXIMUM_TRANSITIONS,
    substitution: substitutionMap(substitution, normalized.kind),
    transitions: 0,
    nextVariable: 0,
  };
  return resolveRow(normalized, state, new Set());
}

/** Lowers a closed record or variant row to nominal Functional Surface declarations. */
export function functionalRowTypeDeclaration(
  name: string,
  row: FunctionalRow,
): FunctionalSurfaceTypeDeclaration {
  requireName(name, "functional row type name");
  const normalized = requireClosedRow(row);
  if (normalized.kind === "effect") {
    throw new Error("functional effect rows lower to operations, not nominal type declarations");
  }
  const parameters = rowTypeParameters(normalized);
  if (normalized.kind === "record") {
    return {
      name,
      parameters,
      constructors: [{
        name: functionalRecordConstructorName(name),
        fields: normalized.fields.map((field) => ({ name: field.label, type: field.type })),
      }],
    };
  }
  return {
    name,
    parameters,
    constructors: normalized.fields.map((field) => ({
      name: functionalVariantConstructorName(name, field.label),
      fields: [{ name: "value", type: field.type }],
    })),
  };
}

/** Lowers a closed effect row to the ordinary Effect Core operation contract. */
export function functionalEffectOperationsFromRow(
  effect: string,
  row: FunctionalRow,
): readonly FunctionalEffectOperation[] {
  requireName(effect, "functional effect row name");
  const normalized = requireClosedRow(row);
  if (normalized.kind !== "effect") {
    throw new Error(
      `functional effect operation lowering requires an effect row; received ${normalized.kind}`,
    );
  }
  return Object.freeze(normalized.fields.map((field) => {
    if (field.type.kind !== "function") {
      throw new Error(
        `functional effect row field ${JSON.stringify(field.label)} must have a function type`,
      );
    }
    return {
      effect,
      name: field.label,
      parameter: field.type.parameter,
      result: field.type.result,
    };
  }));
}

export function functionalRecordConstructorName(typeName: string): string {
  requireName(typeName, "functional record type name");
  return `${typeName}$Record`;
}

export function functionalVariantConstructorName(typeName: string, label: string): string {
  requireName(typeName, "functional variant type name");
  requireName(label, "functional variant label");
  return `${typeName}$${label}`;
}

function unifyRows(
  leftInput: FunctionalRow,
  rightInput: FunctionalRow,
  state: MutableRowState,
): Extract<FunctionalRowUnification, { readonly ok: false }> | null {
  consumeTransition(state);
  const left = resolveRow(leftInput, state, new Set());
  const right = resolveRow(rightInput, state, new Set());
  const leftFields = new Map(left.fields.map((field) => [field.label, field]));
  const rightFields = new Map(right.fields.map((field) => [field.label, field]));
  for (const [label, leftField] of leftFields) {
    const rightField = rightFields.get(label);
    if (rightField === undefined) continue;
    consumeTransition(state);
    if (!schemasEqual(leftField.type, rightField.type, state)) {
      return {
        ok: false,
        kind: "field-mismatch",
        message: `functional ${left.kind} row field ${
          JSON.stringify(label)
        } has incompatible types`,
        transitions: 0,
      };
    }
  }
  const leftOnly = left.fields.filter((field) => !rightFields.has(field.label));
  const rightOnly = right.fields.filter((field) => !leftFields.has(field.label));
  if (left.tail === null && rightOnly.length > 0 || right.tail === null && leftOnly.length > 0) {
    return {
      ok: false,
      kind: "closed-row-mismatch",
      message: `closed functional ${left.kind} rows differ at labels ${
        JSON.stringify([...leftOnly, ...rightOnly].map((field) => field.label).sort())
      }`,
      transitions: 0,
    };
  }
  if (left.tail !== null && right.tail === null) {
    return bindRow(left.tail, row(left.kind, rightOnly, null), state);
  }
  if (right.tail !== null && left.tail === null) {
    return bindRow(right.tail, row(left.kind, leftOnly, null), state);
  }
  if (left.tail !== null && right.tail !== null) {
    if (left.tail === right.tail) {
      if (leftOnly.length === 0 && rightOnly.length === 0) return null;
      return {
        ok: false,
        kind: "recursive-row",
        message: `functional row variable ${JSON.stringify(left.tail)} would contain itself`,
        transitions: 0,
      };
    }
    const shared = freshRowVariable(left, right, state);
    const leftFailure = bindRow(left.tail, row(left.kind, rightOnly, shared), state);
    if (leftFailure !== null) return leftFailure;
    return bindRow(right.tail, row(left.kind, leftOnly, shared), state);
  }
  return null;
}

function bindRow(
  variable: string,
  value: FunctionalRow,
  state: MutableRowState,
): Extract<FunctionalRowUnification, { readonly ok: false }> | null {
  consumeTransition(state);
  const existing = state.substitution.get(variable);
  if (existing !== undefined) return unifyRows(existing, value, state);
  if (rowContainsVariable(value, variable, state, new Set())) {
    return {
      ok: false,
      kind: "recursive-row",
      message: `functional row variable ${JSON.stringify(variable)} occurs in its own substitution`,
      transitions: 0,
    };
  }
  state.substitution.set(variable, value);
  return null;
}

function resolveRow(
  input: FunctionalRow,
  state: MutableRowState,
  active: Set<string>,
): FunctionalRow {
  let fields = [...input.fields];
  let tail = input.tail;
  while (tail !== null) {
    const replacement = state.substitution.get(tail);
    if (replacement === undefined) break;
    consumeTransition(state);
    if (active.has(tail)) {
      throw new Error(`functional row substitution contains cycle at ${JSON.stringify(tail)}`);
    }
    active.add(tail);
    const resolved = resolveRow(replacement, state, active);
    active.delete(tail);
    fields = mergeFields(input.kind, fields, resolved.fields, state);
    tail = resolved.tail;
  }
  return row(input.kind, fields, tail);
}

function rowContainsVariable(
  row: FunctionalRow,
  variable: string,
  state: MutableRowState,
  active: Set<string>,
): boolean {
  if (row.tail === null) return false;
  consumeTransition(state);
  if (row.tail === variable) return true;
  if (active.has(row.tail)) return false;
  active.add(row.tail);
  const replacement = state.substitution.get(row.tail);
  const contains = replacement !== undefined &&
    rowContainsVariable(replacement, variable, state, active);
  active.delete(row.tail);
  return contains;
}

function normalizeRow(input: FunctionalRow, location: string): FunctionalRow {
  if (input.kind !== "record" && input.kind !== "variant" && input.kind !== "effect") {
    throw new Error(`${location} has invalid kind ${JSON.stringify(input.kind)}`);
  }
  if (input.fields.length > MAXIMUM_ROW_FIELDS) {
    throw new Error(
      `${location} has ${input.fields.length} fields; maximum is ${MAXIMUM_ROW_FIELDS}`,
    );
  }
  if (input.tail !== null) requireName(input.tail, `${location} tail`);
  const fields = new Map<string, FunctionalRowField>();
  for (const field of input.fields) {
    requireName(field.label, `${location} field label`);
    if (fields.has(field.label)) {
      throw new Error(`${location} repeats field ${JSON.stringify(field.label)}`);
    }
    fields.set(field.label, Object.freeze({ ...field }));
  }
  return row(input.kind, [...fields.values()], input.tail);
}

function requireClosedRow(input: FunctionalRow): FunctionalRow {
  const normalized = normalizeRow(input, "functional lowered row");
  if (normalized.tail !== null) {
    throw new Error(
      `functional ${normalized.kind} row retains open tail ${JSON.stringify(normalized.tail)}`,
    );
  }
  return normalized;
}

function mergeFields(
  kind: FunctionalRowKind,
  first: readonly FunctionalRowField[],
  second: readonly FunctionalRowField[],
  state: MutableRowState,
): FunctionalRowField[] {
  const fields = new Map(first.map((field) => [field.label, field]));
  for (const field of second) {
    const existing = fields.get(field.label);
    if (existing !== undefined && !schemasEqual(existing.type, field.type, state)) {
      throw new Error(
        `functional ${kind} row substitution conflicts at field ${JSON.stringify(field.label)}`,
      );
    }
    fields.set(field.label, field);
  }
  return [...fields.values()];
}

function row(
  kind: FunctionalRowKind,
  fields: readonly FunctionalRowField[],
  tail: string | null,
): FunctionalRow {
  return Object.freeze({
    kind,
    fields: Object.freeze([...fields].sort((left, right) => left.label.localeCompare(right.label))),
    tail,
  });
}

function schemasEqual(
  left: FunctionalTypeSchema,
  right: FunctionalTypeSchema,
  state?: MutableRowState,
): boolean {
  if (state !== undefined) consumeTransition(state);
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return true;
    case "parameter":
      return right.kind === "parameter" && left.name === right.name;
    case "tuple":
      return right.kind === "tuple" && schemasEqual(left.values[0], right.values[0], state) &&
        schemasEqual(left.values[1], right.values[1], state);
    case "named":
      return right.kind === "named" && left.name === right.name &&
        left.arguments.length === right.arguments.length &&
        left.arguments.every((argument, index) =>
          schemasEqual(argument, right.arguments[index]!, state)
        );
    case "function":
      return right.kind === "function" && schemasEqual(left.parameter, right.parameter, state) &&
        schemasEqual(left.result, right.result, state);
    case "forall":
      return right.kind === "forall" && left.parameters.length === right.parameters.length &&
        left.parameters.every((parameter, index) => parameter === right.parameters[index]) &&
        schemasEqual(left.body, right.body, state);
  }
}

function substitutionMap(
  entries: readonly FunctionalRowSubstitutionEntry[],
  kind: FunctionalRowKind,
): Map<string, FunctionalRow> {
  if (entries.length > MAXIMUM_ROW_SUBSTITUTIONS) {
    throw new Error(
      `functional row substitution has ${entries.length} entries; maximum is ${MAXIMUM_ROW_SUBSTITUTIONS}`,
    );
  }
  const substitution = new Map<string, FunctionalRow>();
  for (const entry of entries) {
    requireName(entry.variable, "functional row substitution variable");
    if (substitution.has(entry.variable)) {
      throw new Error(`functional row substitution repeats ${JSON.stringify(entry.variable)}`);
    }
    const value = normalizeRow(
      entry.row,
      `functional row substitution ${JSON.stringify(entry.variable)}`,
    );
    if (value.kind !== kind) {
      throw new Error(
        `functional row substitution ${JSON.stringify(entry.variable)} changes row kind`,
      );
    }
    substitution.set(entry.variable, value);
  }
  return substitution;
}

function freshRowVariable(
  left: FunctionalRow,
  right: FunctionalRow,
  state: MutableRowState,
): string {
  const unavailable = new Set<string>([...state.substitution.keys()]);
  for (const value of state.substitution.values()) {
    if (value.tail !== null) unavailable.add(value.tail);
  }
  if (left.tail !== null) unavailable.add(left.tail);
  if (right.tail !== null) unavailable.add(right.tail);
  let variable: string;
  do variable = `$row${state.nextVariable++}`; while (unavailable.has(variable));
  return variable;
}

function consumeTransition(state: MutableRowState): void {
  if (state.transitions >= state.maximumTransitions) throw new RowFuelExhausted();
  state.transitions += 1;
}

function transitionLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAXIMUM_TRANSITIONS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_MAXIMUM_TRANSITIONS) {
    throw new RangeError(
      `functional row maximumTransitions must be within [1, ${HARD_MAXIMUM_TRANSITIONS}]; received ${limit}`,
    );
  }
  return limit;
}

function requireName(name: string, location: string): void {
  if (name.length === 0) throw new Error(`${location} must be nonempty`);
}

function rowTypeParameters(row: FunctionalRow): readonly string[] {
  const parameters = new Set<string>();
  const visit = (schema: FunctionalTypeSchema, bound: ReadonlySet<string>): void => {
    switch (schema.kind) {
      case "parameter":
        if (!bound.has(schema.name)) parameters.add(schema.name);
        return;
      case "tuple":
        visit(schema.values[0], bound);
        visit(schema.values[1], bound);
        return;
      case "named":
        for (const argument of schema.arguments) visit(argument, bound);
        return;
      case "function":
        visit(schema.parameter, bound);
        visit(schema.result, bound);
        return;
      case "forall": {
        const nestedBound = new Set(bound);
        for (const parameter of schema.parameters) nestedBound.add(parameter);
        visit(schema.body, nestedBound);
        return;
      }
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return;
    }
  };
  for (const field of row.fields) visit(field.type, new Set());
  return Object.freeze([...parameters].sort());
}
