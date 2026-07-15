import {
  type TypeCoreCapabilityEvidence,
  type TypeCoreCapabilityGoal,
  type TypeCoreCapabilityPattern,
  type TypeCoreCapabilityPremise,
  type TypeCoreCapabilityResolution,
  type TypeCoreCapabilityResolutionOptions,
  type TypeCoreCapabilityRule,
  type TypeCoreCapabilityTypePattern,
  type TypeCoreCapabilityVerification,
  type TypeCoreCapabilityWitness,
} from "./capability_contract.ts";
import {
  type TypeCoreKind,
  TypeCoreKind as Kind,
  type TypeCoreType,
  type TypeCoreValue,
} from "./type_core_contract.ts";

const DEFAULT_MAXIMUM_TRANSITIONS = 100_000;
const HARD_MAXIMUM_TRANSITIONS = 1_000_000;
const DEFAULT_MAXIMUM_DEPTH = 128;
const HARD_MAXIMUM_DEPTH = 512;
const MAXIMUM_CAPABILITY_WIDTH = 256;

type PatternBindings = ReadonlyMap<string, TypeCoreValue>;

interface MutableResolutionState {
  readonly maximumTransitions: number;
  readonly maximumDepth: number;
  transitions: number;
}

type SearchResult =
  | { readonly kind: "resolved"; readonly evidence: TypeCoreCapabilityEvidence }
  | { readonly kind: "unresolved" }
  | { readonly kind: "cycle" }
  | { readonly kind: "depth-exhausted" }
  | {
    readonly kind: "ambiguous";
    readonly firstRuleId: string;
    readonly secondRuleId: string;
  };

class CapabilityFuelExhausted extends Error {}

export class TypeCoreCapabilityResolver {
  readonly #rulesByPredicate: ReadonlyMap<string, readonly TypeCoreCapabilityRule[]>;
  readonly #rulesById: ReadonlyMap<string, TypeCoreCapabilityRule>;

  constructor(rules: readonly TypeCoreCapabilityRule[]) {
    const rulesByPredicate = new Map<string, TypeCoreCapabilityRule[]>();
    const rulesById = new Map<string, TypeCoreCapabilityRule>();
    for (const [ruleIndex, rule] of rules.entries()) {
      const normalized = normalizeRule(rule, ruleIndex);
      if (rulesById.has(normalized.id)) {
        throw new Error(`Type Core capability rules repeat id ${JSON.stringify(normalized.id)}`);
      }
      rulesById.set(normalized.id, normalized);
      const predicateRules = rulesByPredicate.get(normalized.predicate) ?? [];
      predicateRules.push(normalized);
      rulesByPredicate.set(normalized.predicate, predicateRules);
    }
    this.#rulesByPredicate = rulesByPredicate;
    this.#rulesById = rulesById;
  }

  resolve(
    goal: TypeCoreCapabilityGoal,
    options: TypeCoreCapabilityResolutionOptions = {},
  ): TypeCoreCapabilityResolution {
    const normalizedGoal = normalizeGoal(goal, "capability goal");
    const state = resolutionState(options);
    try {
      const result = this.#resolveGoal(normalizedGoal, state, new Set(), 0);
      if (result.kind === "resolved") {
        return Object.freeze({
          ok: true,
          outputs: result.evidence.outputs,
          evidence: result.evidence,
          transitions: state.transitions,
        });
      }
      if (result.kind === "ambiguous") {
        return Object.freeze({
          ok: false,
          kind: "ambiguous",
          message: `Type Core capability ${describeGoal(normalizedGoal)} has proofs from rules ${
            JSON.stringify(result.firstRuleId)
          } and ${JSON.stringify(result.secondRuleId)}`,
          transitions: state.transitions,
        });
      }
      return Object.freeze({
        ok: false,
        kind: result.kind,
        message: resolutionFailureMessage(normalizedGoal, result.kind, state.maximumDepth),
        transitions: state.transitions,
      });
    } catch (error) {
      if (!(error instanceof CapabilityFuelExhausted)) throw error;
      return Object.freeze({
        ok: false,
        kind: "out-of-fuel",
        message:
          `Type Core capability resolution exceeded ${state.maximumTransitions} transitions for ${
            describeGoal(normalizedGoal)
          }`,
        transitions: state.transitions,
      });
    }
  }

  verify(
    goal: TypeCoreCapabilityGoal,
    evidence: TypeCoreCapabilityEvidence,
    options: TypeCoreCapabilityResolutionOptions = {},
  ): TypeCoreCapabilityVerification {
    const normalizedGoal = normalizeGoal(goal, "verified capability goal");
    const state = resolutionState(options);
    try {
      const outputs = this.#verifyEvidence(normalizedGoal, evidence, state, new Set(), 0);
      return Object.freeze({ ok: true, outputs, transitions: state.transitions });
    } catch (error) {
      if (error instanceof CapabilityFuelExhausted) {
        return Object.freeze({
          ok: false,
          message:
            `Type Core capability verification exceeded ${state.maximumTransitions} transitions`,
          transitions: state.transitions,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      return Object.freeze({ ok: false, message, transitions: state.transitions });
    }
  }

  #resolveGoal(
    goal: TypeCoreCapabilityGoal,
    state: MutableResolutionState,
    activeGoals: ReadonlySet<string>,
    depth: number,
  ): SearchResult {
    if (depth > state.maximumDepth) return { kind: "depth-exhausted" };
    const key = goalKey(goal);
    if (activeGoals.has(key)) return { kind: "cycle" };
    const nestedGoals = new Set(activeGoals);
    nestedGoals.add(key);
    const successes: TypeCoreCapabilityEvidence[] = [];
    let observedCycle = false;
    for (const rule of this.#rulesByPredicate.get(goal.predicate) ?? []) {
      consumeTransition(state);
      const candidate = this.#resolveRule(rule, goal, state, nestedGoals, depth);
      if (candidate.kind === "cycle") observedCycle = true;
      if (candidate.kind === "depth-exhausted") return candidate;
      if (candidate.kind === "ambiguous") return candidate;
      if (candidate.kind !== "resolved") continue;
      successes.push(candidate.evidence);
      if (successes.length === 2) {
        return {
          kind: "ambiguous",
          firstRuleId: successes[0]?.ruleId ?? "<missing first proof>",
          secondRuleId: successes[1]?.ruleId ?? "<missing second proof>",
        };
      }
    }
    if (successes[0] !== undefined) return { kind: "resolved", evidence: successes[0] };
    return observedCycle ? { kind: "cycle" } : { kind: "unresolved" };
  }

  #resolveRule(
    rule: TypeCoreCapabilityRule,
    goal: TypeCoreCapabilityGoal,
    state: MutableResolutionState,
    activeGoals: ReadonlySet<string>,
    depth: number,
  ): SearchResult {
    if (rule.inputs.length !== goal.inputs.length) return { kind: "unresolved" };
    const bindings = new Map<string, TypeCoreValue>();
    for (const [inputIndex, pattern] of rule.inputs.entries()) {
      const input = goal.inputs[inputIndex];
      if (input === undefined || !matchPattern(pattern, input, bindings, state)) {
        return { kind: "unresolved" };
      }
    }

    const premiseEvidence: TypeCoreCapabilityEvidence[] = [];
    for (const premise of rule.premises) {
      consumeTransition(state);
      const premiseGoal = instantiatePremise(premise, bindings, state);
      const premiseResult = this.#resolveGoal(premiseGoal, state, activeGoals, depth + 1);
      if (premiseResult.kind !== "resolved") return premiseResult;
      premiseEvidence.push(premiseResult.evidence);
    }
    const outputs = Object.freeze(
      rule.outputs.map((pattern) => instantiatePattern(pattern, bindings, state)),
    );
    return {
      kind: "resolved",
      evidence: Object.freeze({
        ruleId: rule.id,
        goal,
        outputs,
        witness: rule.witness,
        premises: Object.freeze(premiseEvidence),
      }),
    };
  }

  #verifyEvidence(
    goal: TypeCoreCapabilityGoal,
    evidence: TypeCoreCapabilityEvidence,
    state: MutableResolutionState,
    activeEvidence: ReadonlySet<TypeCoreCapabilityEvidence>,
    depth: number,
  ): readonly TypeCoreValue[] {
    consumeTransition(state);
    if (depth > state.maximumDepth) {
      throw new Error(`Type Core capability evidence exceeds depth ${state.maximumDepth}`);
    }
    if (activeEvidence.has(evidence)) {
      throw new Error("Type Core capability evidence contains a cycle");
    }
    const rule = this.#rulesById.get(evidence.ruleId);
    if (rule === undefined) {
      throw new Error(
        `Type Core capability evidence references unknown rule ${JSON.stringify(evidence.ruleId)}`,
      );
    }
    if (!goalsEqual(goal, evidence.goal, state)) {
      throw new Error(
        `Type Core capability evidence rule ${JSON.stringify(rule.id)} proves a different goal`,
      );
    }
    if (rule.predicate !== goal.predicate || rule.inputs.length !== goal.inputs.length) {
      throw new Error(
        `Type Core capability rule ${JSON.stringify(rule.id)} does not conclude ${
          describeGoal(goal)
        }`,
      );
    }
    const bindings = new Map<string, TypeCoreValue>();
    for (const [inputIndex, pattern] of rule.inputs.entries()) {
      const input = goal.inputs[inputIndex];
      if (input === undefined || !matchPattern(pattern, input, bindings, state)) {
        throw new Error(
          `Type Core capability rule ${JSON.stringify(rule.id)} does not match input ${inputIndex}`,
        );
      }
    }
    if (!witnessesEqual(rule.witness, evidence.witness)) {
      throw new Error(
        `Type Core capability evidence changed witness for rule ${JSON.stringify(rule.id)}`,
      );
    }
    if (evidence.premises.length !== rule.premises.length) {
      throw new Error(
        `Type Core capability evidence for rule ${
          JSON.stringify(rule.id)
        } has ${evidence.premises.length} premises; expected ${rule.premises.length}`,
      );
    }
    const nestedEvidence = new Set(activeEvidence);
    nestedEvidence.add(evidence);
    for (const [premiseIndex, premise] of rule.premises.entries()) {
      const childEvidence = evidence.premises[premiseIndex];
      if (childEvidence === undefined) {
        throw new Error(`Type Core capability evidence omitted premise ${premiseIndex}`);
      }
      this.#verifyEvidence(
        instantiatePremise(premise, bindings, state),
        childEvidence,
        state,
        nestedEvidence,
        depth + 1,
      );
    }
    const outputs = Object.freeze(
      rule.outputs.map((pattern) => instantiatePattern(pattern, bindings, state)),
    );
    if (!valueListsEqual(outputs, evidence.outputs, state)) {
      throw new Error(
        `Type Core capability evidence changed outputs for rule ${JSON.stringify(rule.id)}`,
      );
    }
    return outputs;
  }
}

function normalizeRule(rule: TypeCoreCapabilityRule, ruleIndex: number): TypeCoreCapabilityRule {
  requireName(rule.id, `capability rule ${ruleIndex} id`);
  requireName(rule.predicate, `capability rule ${JSON.stringify(rule.id)} predicate`);
  validateWidth(rule.inputs.length, `capability rule ${JSON.stringify(rule.id)} inputs`);
  validateWidth(rule.outputs.length, `capability rule ${JSON.stringify(rule.id)} outputs`);
  validateWidth(rule.premises.length, `capability rule ${JSON.stringify(rule.id)} premises`);
  const variables = new Map<string, TypeCoreKind>();
  const inputs = Object.freeze(
    rule.inputs.map((pattern, inputIndex) =>
      normalizePattern(
        pattern,
        variables,
        true,
        `rule ${JSON.stringify(rule.id)} input ${inputIndex}`,
      )
    ),
  );
  const outputs = Object.freeze(
    rule.outputs.map((pattern, outputIndex) =>
      normalizePattern(
        pattern,
        variables,
        false,
        `rule ${JSON.stringify(rule.id)} output ${outputIndex}`,
      )
    ),
  );
  const premises = Object.freeze(rule.premises.map((premise, premiseIndex) => {
    requireName(
      premise.predicate,
      `rule ${JSON.stringify(rule.id)} premise ${premiseIndex} predicate`,
    );
    validateWidth(
      premise.inputs.length,
      `rule ${JSON.stringify(rule.id)} premise ${premiseIndex} inputs`,
    );
    return Object.freeze({
      predicate: premise.predicate,
      inputs: Object.freeze(premise.inputs.map((pattern, inputIndex) =>
        normalizePattern(
          pattern,
          variables,
          false,
          `rule ${JSON.stringify(rule.id)} premise ${premiseIndex} input ${inputIndex}`,
        )
      )),
    });
  }));
  return Object.freeze({
    id: rule.id,
    predicate: rule.predicate,
    inputs,
    outputs,
    premises,
    witness: normalizeWitness(rule.witness, rule.id),
  });
}

function normalizePattern(
  pattern: TypeCoreCapabilityPattern,
  variables: Map<string, TypeCoreKind>,
  declareVariables: boolean,
  location: string,
  depth = 0,
  activePatterns: Set<object> = new Set(),
): TypeCoreCapabilityPattern {
  validatePatternDepth(depth, location);
  if (activePatterns.has(pattern)) throw new Error(`${location} contains a pattern cycle`);
  activePatterns.add(pattern);
  try {
    switch (pattern.kind) {
      case "variable":
        validateKind(pattern.valueKind, `${location} variable ${JSON.stringify(pattern.name)}`);
        registerVariable(pattern.name, pattern.valueKind, variables, declareVariables, location);
        return Object.freeze({ ...pattern });
      case "integer":
        validateI32(pattern.value, `${location} integer`);
        return Object.freeze({ ...pattern });
      case "boolean":
        return Object.freeze({ ...pattern });
      case "symbol":
        if (typeof (pattern as { readonly value: unknown }).value !== "string") {
          throw new Error(
            `${location} symbol must be a string; received ${
              String((pattern as { readonly value: unknown }).value)
            }`,
          );
        }
        return Object.freeze({ ...pattern });
      case "type":
        return Object.freeze({
          kind: "type",
          type: normalizeTypePattern(
            pattern.type,
            variables,
            declareVariables,
            `${location} type`,
            depth + 1,
            activePatterns,
          ),
        });
    }
  } finally {
    activePatterns.delete(pattern);
  }
}

function normalizeTypePattern(
  pattern: TypeCoreCapabilityTypePattern,
  variables: Map<string, TypeCoreKind>,
  declareVariables: boolean,
  location: string,
  depth: number,
  activePatterns: Set<object>,
): TypeCoreCapabilityTypePattern {
  validatePatternDepth(depth, location);
  if (activePatterns.has(pattern)) throw new Error(`${location} contains a pattern cycle`);
  activePatterns.add(pattern);
  try {
    switch (pattern.kind) {
      case "variable":
        registerVariable(pattern.name, Kind.Type, variables, declareVariables, location);
        return Object.freeze({ ...pattern });
      case "integer":
      case "boolean":
      case "unit":
        return Object.freeze({ ...pattern });
      case "named":
        requireName(pattern.name, `${location} named type`);
        validateWidth(pattern.arguments.length, `${location} named type arguments`);
        return Object.freeze({
          kind: "named",
          name: pattern.name,
          arguments: Object.freeze(
            pattern.arguments.map((argument, argumentIndex) =>
              normalizePattern(
                argument,
                variables,
                declareVariables,
                `${location} argument ${argumentIndex}`,
                depth + 1,
                activePatterns,
              )
            ),
          ),
        });
      case "tuple":
        return Object.freeze({
          kind: "tuple",
          values: Object.freeze([
            normalizeTypePattern(
              pattern.values[0],
              variables,
              declareVariables,
              `${location} first`,
              depth + 1,
              activePatterns,
            ),
            normalizeTypePattern(
              pattern.values[1],
              variables,
              declareVariables,
              `${location} second`,
              depth + 1,
              activePatterns,
            ),
          ]) as readonly [TypeCoreCapabilityTypePattern, TypeCoreCapabilityTypePattern],
        });
      case "function":
        return Object.freeze({
          kind: "function",
          parameter: normalizeTypePattern(
            pattern.parameter,
            variables,
            declareVariables,
            `${location} parameter`,
            depth + 1,
            activePatterns,
          ),
          result: normalizeTypePattern(
            pattern.result,
            variables,
            declareVariables,
            `${location} result`,
            depth + 1,
            activePatterns,
          ),
        });
    }
  } finally {
    activePatterns.delete(pattern);
  }
}

function matchPattern(
  pattern: TypeCoreCapabilityPattern,
  value: TypeCoreValue,
  bindings: Map<string, TypeCoreValue>,
  state: MutableResolutionState,
): boolean {
  consumeTransition(state);
  if (pattern.kind === "variable") {
    if (pattern.valueKind !== value.kind) return false;
    return bindPatternVariable(pattern.name, value, bindings, state);
  }
  switch (pattern.kind) {
    case "integer":
    case "boolean":
    case "symbol":
      if (value.kind !== pattern.kind) return false;
      return pattern.value === value.value;
    case "type":
      if (value.kind !== "type") return false;
      return matchTypePattern(pattern.type, value.type, bindings, state);
  }
}

function matchTypePattern(
  pattern: TypeCoreCapabilityTypePattern,
  type: TypeCoreType,
  bindings: Map<string, TypeCoreValue>,
  state: MutableResolutionState,
): boolean {
  consumeTransition(state);
  if (pattern.kind === "variable") {
    return bindPatternVariable(
      pattern.name,
      Object.freeze({ kind: "type", type }),
      bindings,
      state,
    );
  }
  switch (pattern.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return pattern.kind === type.kind;
    case "named":
      if (type.kind !== "named") return false;
      if (pattern.name !== type.name || pattern.arguments.length !== type.arguments.length) {
        return false;
      }
      return pattern.arguments.every((argument, argumentIndex) => {
        const value = type.arguments[argumentIndex];
        return value !== undefined && matchPattern(argument, value, bindings, state);
      });
    case "tuple":
      if (type.kind !== "tuple") return false;
      return matchTypePattern(pattern.values[0], type.values[0], bindings, state) &&
        matchTypePattern(pattern.values[1], type.values[1], bindings, state);
    case "function":
      if (type.kind !== "function") return false;
      return matchTypePattern(pattern.parameter, type.parameter, bindings, state) &&
        matchTypePattern(pattern.result, type.result, bindings, state);
  }
}

function instantiatePremise(
  premise: TypeCoreCapabilityPremise,
  bindings: PatternBindings,
  state: MutableResolutionState,
): TypeCoreCapabilityGoal {
  return Object.freeze({
    predicate: premise.predicate,
    inputs: Object.freeze(
      premise.inputs.map((pattern) => instantiatePattern(pattern, bindings, state)),
    ),
  });
}

function instantiatePattern(
  pattern: TypeCoreCapabilityPattern,
  bindings: PatternBindings,
  state: MutableResolutionState,
): TypeCoreValue {
  consumeTransition(state);
  if (pattern.kind === "variable") return requiredBinding(bindings, pattern.name);
  switch (pattern.kind) {
    case "integer":
    case "boolean":
    case "symbol":
      return pattern;
    case "type":
      return Object.freeze({
        kind: "type",
        type: instantiateTypePattern(pattern.type, bindings, state),
      });
  }
}

function instantiateTypePattern(
  pattern: TypeCoreCapabilityTypePattern,
  bindings: PatternBindings,
  state: MutableResolutionState,
): TypeCoreType {
  consumeTransition(state);
  if (pattern.kind === "variable") {
    const value = requiredBinding(bindings, pattern.name);
    if (value.kind !== "type") {
      throw new Error(
        `Type Core capability variable ${JSON.stringify(pattern.name)} is not a type`,
      );
    }
    return value.type;
  }
  switch (pattern.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return pattern;
    case "named":
      return Object.freeze({
        kind: "named",
        name: pattern.name,
        arguments: Object.freeze(
          pattern.arguments.map((argument) => instantiatePattern(argument, bindings, state)),
        ),
      });
    case "tuple":
      return Object.freeze({
        kind: "tuple",
        values: Object.freeze([
          instantiateTypePattern(pattern.values[0], bindings, state),
          instantiateTypePattern(pattern.values[1], bindings, state),
        ]) as readonly [TypeCoreType, TypeCoreType],
      });
    case "function":
      return Object.freeze({
        kind: "function",
        parameter: instantiateTypePattern(pattern.parameter, bindings, state),
        result: instantiateTypePattern(pattern.result, bindings, state),
      });
  }
}

function normalizeGoal(goal: TypeCoreCapabilityGoal, location: string): TypeCoreCapabilityGoal {
  requireName(goal.predicate, `${location} predicate`);
  validateWidth(goal.inputs.length, `${location} inputs`);
  return Object.freeze({
    predicate: goal.predicate,
    inputs: Object.freeze(
      goal.inputs.map((value, inputIndex) =>
        normalizeValue(value, `${location} input ${inputIndex}`, 0, new Set())
      ),
    ),
  });
}

function normalizeValue(
  value: TypeCoreValue,
  location: string,
  depth: number,
  activeValues: Set<object>,
): TypeCoreValue {
  if (depth > HARD_MAXIMUM_DEPTH) {
    throw new Error(`${location} exceeds structural depth ${HARD_MAXIMUM_DEPTH}`);
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`${location} is not a Type Core value`);
  }
  if (activeValues.has(value)) throw new Error(`${location} contains a cycle`);
  activeValues.add(value);
  try {
    switch (value.kind) {
      case "integer":
        validateI32(value.value, location);
        return Object.freeze({ ...value });
      case "boolean":
        if (typeof (value as { readonly value: unknown }).value !== "boolean") {
          throw new Error(
            `${location} Boolean must be true or false; received ${
              String((value as { readonly value: unknown }).value)
            }`,
          );
        }
        return Object.freeze({ ...value });
      case "symbol":
        if (typeof (value as { readonly value: unknown }).value !== "string") {
          throw new Error(
            `${location} symbol must be a string; received ${
              String((value as { readonly value: unknown }).value)
            }`,
          );
        }
        return Object.freeze({ ...value });
      case "type":
        return Object.freeze({
          kind: "type",
          type: normalizeType(value.type, `${location} type`, depth + 1, activeValues),
        });
      default:
        throw new Error(
          `${location} has unsupported kind ${JSON.stringify((value as { kind?: unknown }).kind)}`,
        );
    }
  } finally {
    activeValues.delete(value);
  }
}

function normalizeType(
  type: TypeCoreType,
  location: string,
  depth: number,
  activeValues: Set<object>,
): TypeCoreType {
  if (depth > HARD_MAXIMUM_DEPTH) {
    throw new Error(`${location} exceeds structural depth ${HARD_MAXIMUM_DEPTH}`);
  }
  if (type === null || typeof type !== "object") throw new Error(`${location} is not a type`);
  if (activeValues.has(type)) throw new Error(`${location} contains a cycle`);
  activeValues.add(type);
  try {
    switch (type.kind) {
      case "integer":
      case "boolean":
      case "unit":
        return Object.freeze({ ...type });
      case "named":
        requireName(type.name, `${location} name`);
        validateWidth(type.arguments.length, `${location} arguments`);
        return Object.freeze({
          kind: "named",
          name: type.name,
          arguments: Object.freeze(type.arguments.map((argument, argumentIndex) =>
            normalizeValue(
              argument,
              `${location} argument ${argumentIndex}`,
              depth + 1,
              activeValues,
            )
          )),
        });
      case "tuple":
        return Object.freeze({
          kind: "tuple",
          values: Object.freeze([
            normalizeType(type.values[0], `${location} first`, depth + 1, activeValues),
            normalizeType(type.values[1], `${location} second`, depth + 1, activeValues),
          ]) as readonly [TypeCoreType, TypeCoreType],
        });
      case "function":
        return Object.freeze({
          kind: "function",
          parameter: normalizeType(
            type.parameter,
            `${location} parameter`,
            depth + 1,
            activeValues,
          ),
          result: normalizeType(type.result, `${location} result`, depth + 1, activeValues),
        });
      default:
        throw new Error(
          `${location} has unsupported kind ${JSON.stringify((type as { kind?: unknown }).kind)}`,
        );
    }
  } finally {
    activeValues.delete(type);
  }
}

function bindPatternVariable(
  name: string,
  value: TypeCoreValue,
  bindings: Map<string, TypeCoreValue>,
  state: MutableResolutionState,
): boolean {
  const existing = bindings.get(name);
  if (existing !== undefined) return valuesEqual(existing, value, state);
  bindings.set(name, value);
  return true;
}

function requiredBinding(bindings: PatternBindings, name: string): TypeCoreValue {
  const value = bindings.get(name);
  if (value === undefined) {
    throw new Error(`Type Core capability rule omitted binding ${JSON.stringify(name)}`);
  }
  return value;
}

function goalsEqual(
  left: TypeCoreCapabilityGoal,
  right: TypeCoreCapabilityGoal,
  state: MutableResolutionState,
): boolean {
  return left.predicate === right.predicate && valueListsEqual(left.inputs, right.inputs, state);
}

function valueListsEqual(
  left: readonly TypeCoreValue[],
  right: readonly TypeCoreValue[],
  state: MutableResolutionState,
): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => {
    const other = right[index];
    return other !== undefined && valuesEqual(value, other, state);
  });
}

function valuesEqual(
  left: TypeCoreValue,
  right: TypeCoreValue,
  state: MutableResolutionState,
): boolean {
  consumeTransition(state);
  switch (left.kind) {
    case "integer":
    case "boolean":
    case "symbol":
      if (right.kind !== left.kind) return false;
      return left.value === right.value;
    case "type":
      return right.kind === "type" && typesEqual(left.type, right.type, state);
  }
}

function typesEqual(
  left: TypeCoreType,
  right: TypeCoreType,
  state: MutableResolutionState,
): boolean {
  consumeTransition(state);
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return true;
    case "named":
      return right.kind === "named" && left.name === right.name &&
        valueListsEqual(left.arguments, right.arguments, state);
    case "tuple":
      return right.kind === "tuple" && typesEqual(left.values[0], right.values[0], state) &&
        typesEqual(left.values[1], right.values[1], state);
    case "function":
      return right.kind === "function" && typesEqual(left.parameter, right.parameter, state) &&
        typesEqual(left.result, right.result, state);
  }
}

function goalKey(goal: TypeCoreCapabilityGoal): string {
  return JSON.stringify(goal);
}

function describeGoal(goal: TypeCoreCapabilityGoal): string {
  return `${JSON.stringify(goal.predicate)}(${
    goal.inputs.map((input) => JSON.stringify(input)).join(", ")
  })`;
}

function resolutionFailureMessage(
  goal: TypeCoreCapabilityGoal,
  kind: "unresolved" | "cycle" | "depth-exhausted",
  maximumDepth: number,
): string {
  switch (kind) {
    case "unresolved":
      return `Type Core capability ${describeGoal(goal)} has no matching proof rule`;
    case "cycle":
      return `Type Core capability ${describeGoal(goal)} depends on itself`;
    case "depth-exhausted":
      return `Type Core capability ${describeGoal(goal)} exceeded proof depth ${maximumDepth}`;
  }
}

function normalizeWitness(
  witness: TypeCoreCapabilityWitness,
  ruleId: string,
): TypeCoreCapabilityWitness {
  switch (witness.kind) {
    case "erased-proof":
      return Object.freeze({ kind: "erased-proof" });
    case "compile-time":
    case "runtime-dictionary":
      requireName(witness.symbol, `capability rule ${JSON.stringify(ruleId)} witness symbol`);
      return Object.freeze({ ...witness });
  }
}

function witnessesEqual(
  left: TypeCoreCapabilityWitness,
  right: TypeCoreCapabilityWitness,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "erased-proof") return true;
  return right.kind !== "erased-proof" && left.symbol === right.symbol;
}

function registerVariable(
  name: string,
  kind: TypeCoreKind,
  variables: Map<string, TypeCoreKind>,
  declare: boolean,
  location: string,
): void {
  requireName(name, `${location} variable`);
  const existing = variables.get(name);
  if (existing === undefined) {
    if (!declare) {
      throw new Error(`${location} references unbound variable ${JSON.stringify(name)}`);
    }
    variables.set(name, kind);
    return;
  }
  if (existing !== kind) {
    throw new Error(
      `${location} uses variable ${
        JSON.stringify(name)
      } at kind ${kind}; it was declared at ${existing}`,
    );
  }
}

function resolutionState(
  options: TypeCoreCapabilityResolutionOptions,
): MutableResolutionState {
  return {
    maximumTransitions: boundedOption(
      "maximumTransitions",
      options.maximumTransitions,
      DEFAULT_MAXIMUM_TRANSITIONS,
      HARD_MAXIMUM_TRANSITIONS,
    ),
    maximumDepth: boundedOption(
      "maximumDepth",
      options.maximumDepth,
      DEFAULT_MAXIMUM_DEPTH,
      HARD_MAXIMUM_DEPTH,
    ),
    transitions: 0,
  };
}

function boundedOption(
  name: string,
  value: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(
      `${name} must be an integer from 1 through ${maximum}; received ${resolved}`,
    );
  }
  return resolved;
}

function consumeTransition(state: MutableResolutionState): void {
  if (state.transitions >= state.maximumTransitions) throw new CapabilityFuelExhausted();
  state.transitions++;
}

function requireName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${location} must be a nonempty string; received ${JSON.stringify(name)}`);
  }
}

function validateKind(kind: TypeCoreKind, location: string): void {
  if (
    kind !== Kind.Type && kind !== Kind.Integer && kind !== Kind.Boolean && kind !== Kind.Symbol
  ) {
    throw new Error(`${location} has unsupported kind ${JSON.stringify(kind)}`);
  }
}

function validateI32(value: number, location: string): void {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error(`${location} must be a signed i32; received ${value}`);
  }
}

function validateWidth(width: number, location: string): void {
  if (width > MAXIMUM_CAPABILITY_WIDTH) {
    throw new Error(
      `${location} exceed the maximum width of ${MAXIMUM_CAPABILITY_WIDTH}; received ${width}`,
    );
  }
}

function validatePatternDepth(depth: number, location: string): void {
  if (depth > HARD_MAXIMUM_DEPTH) {
    throw new Error(`${location} exceeds structural depth ${HARD_MAXIMUM_DEPTH}`);
  }
}
