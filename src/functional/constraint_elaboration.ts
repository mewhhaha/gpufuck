import type {
  TypeCoreCapabilityEvidence,
  TypeCoreCapabilityResolution,
  TypeCoreCapabilityRule,
} from "./capability_contract.ts";
import { TypeCoreCapabilityResolver } from "./capability_resolver.ts";
import type { FunctionalSurfaceExpression } from "./surface_builder.ts";
import { FunctionalTypeNormalizer } from "./type_program.ts";
import type { TypeCoreType, TypeCoreValue } from "./type_core_contract.ts";
import type {
  FunctionalTypeExpression,
  FunctionalTypeNormalization,
  FunctionalTypeProgram,
} from "./type_program_contract.ts";
import type { FunctionalTypeSchema } from "./abi.ts";

const DEFAULT_MAXIMUM_TRANSITIONS = 100_000;
const HARD_MAXIMUM_TRANSITIONS = 1_000_000;

export interface FunctionalConstraintGoal {
  readonly predicate: string;
  readonly inputs: readonly FunctionalTypeExpression[];
}

export interface FunctionalConstraintElaborationOptions {
  readonly maximumTransitions?: number;
  readonly maximumDepth?: number;
}

export type FunctionalConstraintElaboration =
  | {
    readonly ok: true;
    readonly evidence: TypeCoreCapabilityEvidence;
    readonly normalizedInputs: readonly FunctionalTypeSchema[];
    readonly runtimeWitness: FunctionalSurfaceExpression | null;
    readonly transitions: number;
  }
  | {
    readonly ok: false;
    readonly failure: Extract<TypeCoreCapabilityResolution, { readonly ok: false }>;
    readonly transitions: number;
  };

export type FunctionalConstraintCallElaboration =
  | {
    readonly ok: true;
    readonly expression: FunctionalSurfaceExpression;
    readonly constraints: readonly Extract<
      FunctionalConstraintElaboration,
      { readonly ok: true }
    >[];
    readonly transitions: number;
  }
  | {
    readonly ok: false;
    readonly goalIndex: number;
    readonly failure: Extract<TypeCoreCapabilityResolution, { readonly ok: false }>;
    readonly transitions: number;
  };

/** Normalizes higher-kinded goals, resolves evidence, and inserts runtime dictionaries. */
export class FunctionalConstraintElaborator {
  readonly #normalizer: FunctionalTypeNormalizer;
  readonly #resolver: TypeCoreCapabilityResolver;

  constructor(program: FunctionalTypeProgram, rules: readonly TypeCoreCapabilityRule[]) {
    this.#normalizer = new FunctionalTypeNormalizer(program, rules);
    this.#resolver = new TypeCoreCapabilityResolver(rules);
  }

  resolve(
    goal: FunctionalConstraintGoal,
    options: FunctionalConstraintElaborationOptions = {},
  ): FunctionalConstraintElaboration {
    requirePredicate(goal.predicate);
    const maximumTransitions = transitionLimit(options.maximumTransitions);
    const normalizedInputs: FunctionalTypeSchema[] = [];
    let transitions = 0;
    for (const input of goal.inputs) {
      const remainingTransitions = maximumTransitions - transitions;
      if (remainingTransitions === 0) {
        return constraintFuelFailure(goal.predicate, maximumTransitions);
      }
      let normalized: FunctionalTypeNormalization;
      try {
        normalized = this.#normalizer.normalize(input, {
          maximumTransitions: remainingTransitions,
        });
      } catch (error) {
        if (!isNormalizationFuelError(error)) throw error;
        return constraintFuelFailure(goal.predicate, maximumTransitions);
      }
      transitions += normalized.transitions;
      normalizedInputs.push(normalized.schema);
    }
    if (transitions === maximumTransitions) {
      return constraintFuelFailure(goal.predicate, maximumTransitions);
    }
    const resolution = this.#resolver.resolve(
      {
        predicate: goal.predicate,
        inputs: normalizedInputs.map(functionalTypeCoreValue),
      },
      {
        maximumTransitions: maximumTransitions - transitions,
        ...(options.maximumDepth === undefined ? {} : { maximumDepth: options.maximumDepth }),
      },
    );
    transitions += resolution.transitions;
    if (!resolution.ok) return { ok: false, failure: resolution, transitions };
    return {
      ok: true,
      evidence: resolution.evidence,
      normalizedInputs: Object.freeze(normalizedInputs),
      runtimeWitness: functionalRuntimeEvidenceExpression(resolution.evidence),
      transitions,
    };
  }

  elaborateCall(
    callee: FunctionalSurfaceExpression,
    arguments_: readonly FunctionalSurfaceExpression[],
    goals: readonly FunctionalConstraintGoal[],
    options: FunctionalConstraintElaborationOptions = {},
  ): FunctionalConstraintCallElaboration {
    const maximumTransitions = transitionLimit(options.maximumTransitions);
    const constraints: Extract<FunctionalConstraintElaboration, { readonly ok: true }>[] = [];
    let transitions = 0;
    let expression = callee;
    for (const [goalIndex, goal] of goals.entries()) {
      if (transitions === maximumTransitions) {
        const exhausted = constraintFuelFailure(goal.predicate, maximumTransitions);
        return {
          ok: false,
          goalIndex,
          failure: exhausted.failure,
          transitions,
        };
      }
      const constraint = this.resolve(goal, {
        maximumTransitions: maximumTransitions - transitions,
        ...(options.maximumDepth === undefined ? {} : { maximumDepth: options.maximumDepth }),
      });
      transitions += constraint.transitions;
      if (!constraint.ok) {
        return { ok: false, goalIndex, failure: constraint.failure, transitions };
      }
      constraints.push(constraint);
      if (constraint.runtimeWitness !== null) {
        expression = { kind: "apply", callee: expression, argument: constraint.runtimeWitness };
      }
    }
    for (const argument of arguments_) {
      expression = { kind: "apply", callee: expression, argument };
    }
    return {
      ok: true,
      expression,
      constraints: Object.freeze(constraints),
      transitions,
    };
  }
}

function constraintFuelFailure(
  predicate: string,
  maximumTransitions: number,
): Extract<FunctionalConstraintElaboration, { readonly ok: false }> {
  return {
    ok: false,
    failure: {
      ok: false,
      kind: "out-of-fuel",
      message: `functional constraint ${
        JSON.stringify(predicate)
      } exceeded ${maximumTransitions} transitions`,
      transitions: maximumTransitions,
    },
    transitions: maximumTransitions,
  };
}

function isNormalizationFuelError(error: unknown): boolean {
  return error instanceof Error &&
    error.message.startsWith("Functional type normalization exceeded ");
}

/** Converts verified runtime-dictionary evidence into an ordinary surface expression. */
export function functionalRuntimeEvidenceExpression(
  evidence: TypeCoreCapabilityEvidence,
): FunctionalSurfaceExpression | null {
  if (evidence.witness.kind !== "runtime-dictionary") return null;
  let expression: FunctionalSurfaceExpression = {
    kind: "name",
    name: evidence.witness.symbol,
  };
  for (const premise of evidence.premises) {
    const argument = functionalRuntimeEvidenceExpression(premise);
    if (argument !== null) expression = { kind: "apply", callee: expression, argument };
  }
  return expression;
}

function functionalTypeCoreValue(schema: FunctionalTypeSchema): TypeCoreValue {
  return { kind: "type", type: functionalTypeCoreType(schema) };
}

function functionalTypeCoreType(schema: FunctionalTypeSchema): TypeCoreType {
  switch (schema.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return schema;
    case "signed-integer-64":
    case "float-32":
    case "float-64":
      return { kind: "named", name: schema.kind, arguments: [] };
    case "tuple":
      return {
        kind: "tuple",
        values: [
          functionalTypeCoreType(schema.values[0]),
          functionalTypeCoreType(schema.values[1]),
        ],
      };
    case "named":
      return {
        kind: "named",
        name: schema.name,
        arguments: schema.arguments.map((argument) => ({
          kind: "type",
          type: functionalTypeCoreType(argument),
        })),
      };
    case "function":
      return {
        kind: "function",
        parameter: functionalTypeCoreType(schema.parameter),
        result: functionalTypeCoreType(schema.result),
      };
    case "parameter":
      throw new Error(
        `functional constraint goal contains unresolved type parameter ${
          JSON.stringify(schema.name)
        }`,
      );
    case "forall":
      throw new Error("functional constraint goal cannot contain a higher-rank forall");
  }
}

function requirePredicate(predicate: string): void {
  if (predicate.length === 0) throw new Error("functional constraint predicate must be nonempty");
}

function transitionLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MAXIMUM_TRANSITIONS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > HARD_MAXIMUM_TRANSITIONS) {
    throw new RangeError(
      `functional constraint maximumTransitions must be within [1, ${HARD_MAXIMUM_TRANSITIONS}]; received ${limit}`,
    );
  }
  return limit;
}
