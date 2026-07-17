import type { FunctionalTypeSchema } from "./abi.ts";
import type { TypeCoreCapabilityEvidence, TypeCoreCapabilityRule } from "./capability_contract.ts";
import { TypeCoreCapabilityResolver } from "./capability_resolver.ts";
import type { TypeCoreType, TypeCoreValue } from "./type_core_contract.ts";
import type {
  FunctionalTypeConstructorDeclaration,
  FunctionalTypeExpression,
  FunctionalTypeFunctionDeclaration,
  FunctionalTypeKind,
  FunctionalTypeNormalization,
  FunctionalTypeNormalizationOptions,
  FunctionalTypeProgram,
} from "./type_program_contract.ts";

const TYPE_KIND = Object.freeze({ kind: "type" } as const);
const DEFAULT_MAXIMUM_TRANSITIONS = 100_000;
const HARD_MAXIMUM_TRANSITIONS = 1_000_000;
const MAXIMUM_STRUCTURAL_DEPTH = 512;
const MAXIMUM_WIDTH = 256;

type NormalizedTypeValue =
  | { readonly kind: "schema"; readonly schema: FunctionalTypeSchema }
  | {
    readonly kind: "constructor";
    readonly declaration: FunctionalTypeConstructorDeclaration;
    readonly arguments: readonly FunctionalTypeSchema[];
  }
  | {
    readonly kind: "function";
    readonly declaration: FunctionalTypeFunctionDeclaration;
    readonly arguments: readonly NormalizedTypeValue[];
  };

interface MutableNormalizationState {
  readonly maximumTransitions: number;
  readonly evidence: TypeCoreCapabilityEvidence[];
  transitions: number;
}

export class FunctionalTypeNormalizer {
  readonly #constructors: ReadonlyMap<string, FunctionalTypeConstructorDeclaration>;
  readonly #functions: ReadonlyMap<string, FunctionalTypeFunctionDeclaration>;
  readonly #capabilities: TypeCoreCapabilityResolver;

  constructor(
    program: FunctionalTypeProgram,
    capabilityRules: readonly TypeCoreCapabilityRule[] = [],
  ) {
    this.#constructors = indexConstructors(program.constructors);
    this.#functions = indexFunctions(program.functions, this.#constructors);
    this.#capabilities = new TypeCoreCapabilityResolver(capabilityRules);
    const globals: KindEnvironment = {
      constructors: this.#constructors,
      functions: this.#functions,
    };
    for (const declaration of this.#functions.values()) {
      const environment = new Map(
        declaration.parameters.map((parameter) => [parameter.name, parameter.kind] as const),
      );
      const bodyKind = inferExpressionKind(declaration.body, environment, globals, 0);
      if (!kindsEqual(bodyKind, declaration.resultKind)) {
        throw new Error(
          `Functional type function ${JSON.stringify(declaration.name)} declares result kind ${
            describeKind(declaration.resultKind)
          } but its body has kind ${describeKind(bodyKind)}`,
        );
      }
    }
  }

  normalize(
    expression: FunctionalTypeExpression,
    options: FunctionalTypeNormalizationOptions = {},
  ): FunctionalTypeNormalization {
    const globals: KindEnvironment = {
      constructors: this.#constructors,
      functions: this.#functions,
    };
    const expressionKind = inferExpressionKind(expression, new Map(), globals, 0);
    if (!kindsEqual(expressionKind, TYPE_KIND)) {
      throw new Error(
        `Functional type normalization requires kind type; received ${
          describeKind(expressionKind)
        }`,
      );
    }
    const state = normalizationState(options);
    const value = this.#evaluate(expression, new Map(), state);
    if (value.kind !== "schema") {
      throw new Error("Functional type normalization produced an unsaturated type constructor");
    }
    return Object.freeze({
      schema: value.schema,
      evidence: Object.freeze(state.evidence),
      transitions: state.transitions,
    });
  }

  #evaluate(
    expression: FunctionalTypeExpression,
    environment: ReadonlyMap<string, NormalizedTypeValue>,
    state: MutableNormalizationState,
  ): NormalizedTypeValue {
    consumeTransition(state);
    switch (expression.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return Object.freeze({ kind: "schema", schema: Object.freeze({ kind: expression.kind }) });
      case "reference":
        return this.#referenceValue(expression.name, environment, state);
      case "apply": {
        const constructor = this.#evaluate(expression.constructor, environment, state);
        const argument = this.#evaluate(expression.argument, environment, state);
        return this.#apply(constructor, argument, state);
      }
      case "tuple": {
        const first = requireSchema(this.#evaluate(expression.values[0], environment, state));
        const second = requireSchema(this.#evaluate(expression.values[1], environment, state));
        return Object.freeze({
          kind: "schema",
          schema: Object.freeze({
            kind: "tuple",
            values: Object.freeze([first, second]) as readonly [
              FunctionalTypeSchema,
              FunctionalTypeSchema,
            ],
          }),
        });
      }
      case "function": {
        const parameter = requireSchema(this.#evaluate(expression.parameter, environment, state));
        const result = requireSchema(this.#evaluate(expression.result, environment, state));
        return Object.freeze({
          kind: "schema",
          schema: Object.freeze({ kind: "function", parameter, result }),
        });
      }
      case "associated": {
        const inputs = expression.inputs.map((input) =>
          schemaTypeCoreValue(requireSchema(this.#evaluate(input, environment, state)))
        );
        const resolution = this.#capabilities.resolve(
          { predicate: expression.predicate, inputs },
          { maximumTransitions: state.maximumTransitions - state.transitions },
        );
        state.transitions += resolution.transitions;
        if (!resolution.ok) throw new Error(resolution.message);
        state.evidence.push(resolution.evidence);
        const output = resolution.outputs[expression.output];
        if (output === undefined) {
          throw new Error(
            `Functional associated type ${
              JSON.stringify(expression.predicate)
            } requested output ${expression.output}; proof ${
              JSON.stringify(resolution.evidence.ruleId)
            } produced ${resolution.outputs.length} outputs`,
          );
        }
        if (output.kind !== "type") {
          throw new Error(
            `Functional associated type ${
              JSON.stringify(expression.predicate)
            } output ${expression.output} has kind ${output.kind}; expected type`,
          );
        }
        return Object.freeze({
          kind: "schema",
          schema: functionalSchemaFromTypeCoreType(output.type),
        });
      }
    }
  }

  #referenceValue(
    name: string,
    environment: ReadonlyMap<string, NormalizedTypeValue>,
    state: MutableNormalizationState,
  ): NormalizedTypeValue {
    const bound = environment.get(name);
    if (bound !== undefined) return bound;
    const constructor = this.#constructors.get(name);
    if (constructor !== undefined) {
      if (constructor.parameterKinds.length === 0) {
        return Object.freeze({
          kind: "schema",
          schema: Object.freeze({ kind: "named", name, arguments: Object.freeze([]) }),
        });
      }
      return Object.freeze({ kind: "constructor", declaration: constructor, arguments: [] });
    }
    const declaration = this.#functions.get(name);
    if (declaration === undefined) {
      throw new Error(
        `Functional type normalization references unknown name ${JSON.stringify(name)}`,
      );
    }
    if (declaration.parameters.length > 0) {
      return Object.freeze({ kind: "function", declaration, arguments: [] });
    }
    return this.#evaluate(declaration.body, new Map(), state);
  }

  #apply(
    constructor: NormalizedTypeValue,
    argument: NormalizedTypeValue,
    state: MutableNormalizationState,
  ): NormalizedTypeValue {
    if (constructor.kind === "schema") {
      throw new Error("Functional type normalization attempted to apply a saturated type");
    }
    if (constructor.kind === "constructor") {
      const schema = requireSchema(argument);
      const arguments_ = Object.freeze([...constructor.arguments, schema]);
      if (arguments_.length < constructor.declaration.parameterKinds.length) {
        return Object.freeze({ ...constructor, arguments: arguments_ });
      }
      return Object.freeze({
        kind: "schema",
        schema: Object.freeze({
          kind: "named",
          name: constructor.declaration.name,
          arguments: arguments_,
        }),
      });
    }

    const arguments_ = Object.freeze([...constructor.arguments, argument]);
    if (arguments_.length < constructor.declaration.parameters.length) {
      return Object.freeze({ ...constructor, arguments: arguments_ });
    }
    const environment = new Map<string, NormalizedTypeValue>();
    for (const [parameterIndex, parameter] of constructor.declaration.parameters.entries()) {
      const value = arguments_[parameterIndex];
      if (value === undefined) {
        throw new Error(
          `Functional type function ${
            JSON.stringify(constructor.declaration.name)
          } omitted argument ${parameterIndex}`,
        );
      }
      environment.set(parameter.name, value);
    }
    return this.#evaluate(constructor.declaration.body, environment, state);
  }
}

interface KindEnvironment {
  readonly constructors: ReadonlyMap<string, FunctionalTypeConstructorDeclaration>;
  readonly functions: ReadonlyMap<string, FunctionalTypeFunctionDeclaration>;
}

function indexConstructors(
  declarations: readonly FunctionalTypeConstructorDeclaration[],
): ReadonlyMap<string, FunctionalTypeConstructorDeclaration> {
  requireWidth(declarations.length, "constructor declarations");
  const constructors = new Map<string, FunctionalTypeConstructorDeclaration>();
  for (const [declarationIndex, declaration] of declarations.entries()) {
    requireName(declaration.name, `constructor ${declarationIndex}`);
    if (constructors.has(declaration.name)) {
      throw new Error(
        `Functional type program repeats constructor ${JSON.stringify(declaration.name)}`,
      );
    }
    requireWidth(
      declaration.parameterKinds.length,
      `constructor ${JSON.stringify(declaration.name)} parameters`,
    );
    for (const [parameterIndex, kind] of declaration.parameterKinds.entries()) {
      validateKind(
        kind,
        `constructor ${JSON.stringify(declaration.name)} parameter ${parameterIndex}`,
        0,
        new Set(),
      );
      if (!kindsEqual(kind, TYPE_KIND)) {
        throw new Error(
          `Functional ABI constructor ${
            JSON.stringify(declaration.name)
          } parameter ${parameterIndex} requires kind type; received ${describeKind(kind)}`,
        );
      }
    }
    constructors.set(declaration.name, Object.freeze({ ...declaration }));
  }
  return constructors;
}

function indexFunctions(
  declarations: readonly FunctionalTypeFunctionDeclaration[],
  constructors: ReadonlyMap<string, FunctionalTypeConstructorDeclaration>,
): ReadonlyMap<string, FunctionalTypeFunctionDeclaration> {
  requireWidth(declarations.length, "function declarations");
  const functions = new Map<string, FunctionalTypeFunctionDeclaration>();
  for (const [declarationIndex, declaration] of declarations.entries()) {
    requireName(declaration.name, `function ${declarationIndex}`);
    if (constructors.has(declaration.name) || functions.has(declaration.name)) {
      throw new Error(`Functional type program repeats name ${JSON.stringify(declaration.name)}`);
    }
    requireWidth(
      declaration.parameters.length,
      `function ${JSON.stringify(declaration.name)} parameters`,
    );
    const parameterNames = new Set<string>();
    for (const [parameterIndex, parameter] of declaration.parameters.entries()) {
      requireName(
        parameter.name,
        `function ${JSON.stringify(declaration.name)} parameter ${parameterIndex}`,
      );
      validateKind(
        parameter.kind,
        `function ${JSON.stringify(declaration.name)} parameter ${parameterIndex}`,
        0,
        new Set(),
      );
      if (parameterNames.has(parameter.name)) {
        throw new Error(
          `Functional type function ${JSON.stringify(declaration.name)} repeats parameter ${
            JSON.stringify(parameter.name)
          }`,
        );
      }
      parameterNames.add(parameter.name);
    }
    validateKind(
      declaration.resultKind,
      `function ${JSON.stringify(declaration.name)} result`,
      0,
      new Set(),
    );
    functions.set(declaration.name, Object.freeze({ ...declaration }));
  }
  return functions;
}

function inferExpressionKind(
  expression: FunctionalTypeExpression,
  environment: ReadonlyMap<string, FunctionalTypeKind>,
  globals: KindEnvironment,
  depth: number,
): FunctionalTypeKind {
  requireDepth(depth);
  switch (expression.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return TYPE_KIND;
    case "reference": {
      const bound = environment.get(expression.name);
      if (bound !== undefined) return bound;
      const constructor = globals.constructors.get(expression.name);
      if (constructor !== undefined) {
        return constructor.parameterKinds.reduceRight(
          (result, parameter) => ({ kind: "constructor", parameter, result }),
          TYPE_KIND as FunctionalTypeKind,
        );
      }
      const declaration = globals.functions.get(expression.name);
      if (declaration === undefined) {
        throw new Error(
          `Functional type expression references unknown name ${JSON.stringify(expression.name)}`,
        );
      }
      return declaration.parameters.reduceRight(
        (result, parameter) => ({ kind: "constructor", parameter: parameter.kind, result }),
        declaration.resultKind,
      );
    }
    case "apply": {
      const constructorKind = inferExpressionKind(
        expression.constructor,
        environment,
        globals,
        depth + 1,
      );
      if (constructorKind.kind !== "constructor") {
        throw new Error(
          `Functional type application requires a constructor; received ${
            describeKind(constructorKind)
          }`,
        );
      }
      const argumentKind = inferExpressionKind(
        expression.argument,
        environment,
        globals,
        depth + 1,
      );
      if (!kindsEqual(argumentKind, constructorKind.parameter)) {
        throw new Error(
          `Functional type application requires argument kind ${
            describeKind(constructorKind.parameter)
          }; received ${describeKind(argumentKind)}`,
        );
      }
      return constructorKind.result;
    }
    case "tuple":
      requireTypeKind(expression.values[0], environment, globals, depth + 1, "tuple first value");
      requireTypeKind(expression.values[1], environment, globals, depth + 1, "tuple second value");
      return TYPE_KIND;
    case "function":
      requireTypeKind(expression.parameter, environment, globals, depth + 1, "function parameter");
      requireTypeKind(expression.result, environment, globals, depth + 1, "function result");
      return TYPE_KIND;
    case "associated":
      requireName(expression.predicate, "associated type predicate");
      requireWidth(
        expression.inputs.length,
        `associated type ${JSON.stringify(expression.predicate)} inputs`,
      );
      if (!Number.isSafeInteger(expression.output) || expression.output < 0) {
        throw new Error(
          `Functional associated type ${
            JSON.stringify(expression.predicate)
          } output must be a nonnegative integer; received ${expression.output}`,
        );
      }
      for (const [inputIndex, input] of expression.inputs.entries()) {
        requireTypeKind(
          input,
          environment,
          globals,
          depth + 1,
          `associated type input ${inputIndex}`,
        );
      }
      return TYPE_KIND;
  }
}

function requireTypeKind(
  expression: FunctionalTypeExpression,
  environment: ReadonlyMap<string, FunctionalTypeKind>,
  globals: KindEnvironment,
  depth: number,
  location: string,
): void {
  const kind = inferExpressionKind(expression, environment, globals, depth);
  if (!kindsEqual(kind, TYPE_KIND)) {
    throw new Error(`Functional ${location} requires kind type; received ${describeKind(kind)}`);
  }
}

function validateKind(
  kind: FunctionalTypeKind,
  location: string,
  depth: number,
  activeKinds: Set<object>,
): void {
  requireDepth(depth);
  if (kind === null || typeof kind !== "object") {
    throw new Error(`Functional ${location} is not a type kind`);
  }
  if (activeKinds.has(kind)) throw new Error(`Functional ${location} contains a kind cycle`);
  activeKinds.add(kind);
  try {
    if (kind.kind === "type") return;
    if (kind.kind !== "constructor") {
      throw new Error(
        `Functional ${location} has unsupported kind ${
          JSON.stringify((kind as { readonly kind?: unknown }).kind)
        }`,
      );
    }
    validateKind(kind.parameter, `${location} parameter`, depth + 1, activeKinds);
    validateKind(kind.result, `${location} result`, depth + 1, activeKinds);
  } finally {
    activeKinds.delete(kind);
  }
}

function kindsEqual(left: FunctionalTypeKind, right: FunctionalTypeKind): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "type" || right.kind === "type" ||
    kindsEqual(left.parameter, right.parameter) && kindsEqual(left.result, right.result);
}

function describeKind(kind: FunctionalTypeKind): string {
  return kind.kind === "type"
    ? "type"
    : `(${describeKind(kind.parameter)} -> ${describeKind(kind.result)})`;
}

function requireSchema(value: NormalizedTypeValue): FunctionalTypeSchema {
  if (value.kind !== "schema") {
    throw new Error(
      "Functional type expression used an unsaturated constructor where a type was required",
    );
  }
  return value.schema;
}

function schemaTypeCoreValue(schema: FunctionalTypeSchema): TypeCoreValue {
  return { kind: "type", type: schemaTypeCoreType(schema) };
}

function schemaTypeCoreType(schema: FunctionalTypeSchema): TypeCoreType {
  switch (schema.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return { kind: schema.kind };
    case "signed-integer-64":
    case "float-32":
    case "float-64":
      return { kind: "named", name: schema.kind, arguments: [] };
    case "parameter":
      throw new Error(
        `Functional associated type input contains unresolved parameter ${
          JSON.stringify(schema.name)
        }`,
      );
    case "named":
      return {
        kind: "named",
        name: schema.name,
        arguments: schema.arguments.map(schemaTypeCoreValue),
      };
    case "tuple":
      return {
        kind: "tuple",
        values: [
          schemaTypeCoreType(schema.values[0]),
          schemaTypeCoreType(schema.values[1]),
        ],
      };
    case "function":
      return {
        kind: "function",
        parameter: schemaTypeCoreType(schema.parameter),
        result: schemaTypeCoreType(schema.result),
      };
    case "forall":
      throw new Error("Functional Type Core inputs must be monotypes; received forall");
  }
}

export function functionalSchemaFromTypeCoreType(type: TypeCoreType): FunctionalTypeSchema {
  return functionalSchemaAtDepth(type, 0, new Set());
}

function functionalSchemaAtDepth(
  type: TypeCoreType,
  depth: number,
  active: Set<object>,
): FunctionalTypeSchema {
  if (depth > MAXIMUM_STRUCTURAL_DEPTH) {
    throw new Error(
      `Functional Type Core result exceeds the maximum structural depth of ${MAXIMUM_STRUCTURAL_DEPTH}`,
    );
  }
  if (type === null || typeof type !== "object") {
    throw new Error(`Functional Type Core result is not a type object; received ${String(type)}`);
  }
  if (active.has(type)) throw new Error("Functional Type Core result contains a type cycle");
  active.add(type);
  try {
    switch (type.kind) {
      case "integer":
      case "boolean":
      case "unit":
        return Object.freeze({ kind: type.kind });
      case "named":
        if (typeof type.name !== "string" || type.name.length === 0) {
          throw new Error(
            `Functional Type Core result has invalid named type ${JSON.stringify(type.name)}`,
          );
        }
        if (!Array.isArray(type.arguments)) {
          throw new Error(
            `Functional Type Core result ${JSON.stringify(type.name)} has non-array arguments`,
          );
        }
        if (type.arguments.length > MAXIMUM_WIDTH) {
          throw new Error(
            `Functional Type Core result ${
              JSON.stringify(type.name)
            } exceeds the maximum width of ${MAXIMUM_WIDTH}; received ${type.arguments.length} arguments`,
          );
        }
        if (type.arguments.length === 0 && type.name === "signed-integer-64") {
          return Object.freeze({ kind: "signed-integer-64" });
        }
        if (type.arguments.length === 0 && type.name === "float-32") {
          return Object.freeze({ kind: "float-32" });
        }
        if (type.arguments.length === 0 && type.name === "float-64") {
          return Object.freeze({ kind: "float-64" });
        }
        return Object.freeze({
          kind: "named",
          name: type.name,
          arguments: Object.freeze(type.arguments.map((argument, argumentIndex) => {
            if (argument === null || typeof argument !== "object") {
              throw new Error(
                `Functional Type Core result ${
                  JSON.stringify(type.name)
                } argument ${argumentIndex} is not a value object; received ${String(argument)}`,
              );
            }
            if (argument.kind !== "type") {
              throw new Error(
                `Functional Type Core result ${
                  JSON.stringify(type.name)
                } argument ${argumentIndex} has kind ${argument.kind}; the functional ABI accepts type arguments only`,
              );
            }
            return functionalSchemaAtDepth(argument.type, depth + 1, active);
          })),
        });
      case "tuple": {
        if (!Array.isArray(type.values) || type.values.length !== 2) {
          throw new Error("Functional Type Core tuple result must contain exactly two types");
        }
        return Object.freeze({
          kind: "tuple",
          values: Object.freeze([
            functionalSchemaAtDepth(type.values[0], depth + 1, active),
            functionalSchemaAtDepth(type.values[1], depth + 1, active),
          ]) as readonly [FunctionalTypeSchema, FunctionalTypeSchema],
        });
      }
      case "function":
        if (type.parameter === undefined || type.result === undefined) {
          throw new Error(
            "Functional Type Core function result must contain parameter and result types",
          );
        }
        return Object.freeze({
          kind: "function",
          parameter: functionalSchemaAtDepth(type.parameter, depth + 1, active),
          result: functionalSchemaAtDepth(type.result, depth + 1, active),
        });
      default:
        throw new Error(
          `Functional Type Core result has unsupported type kind ${
            JSON.stringify((type as { readonly kind?: unknown }).kind)
          }`,
        );
    }
  } finally {
    active.delete(type);
  }
}

function normalizationState(
  options: FunctionalTypeNormalizationOptions,
): MutableNormalizationState {
  const maximumTransitions = options.maximumTransitions ?? DEFAULT_MAXIMUM_TRANSITIONS;
  if (
    !Number.isSafeInteger(maximumTransitions) || maximumTransitions < 1 ||
    maximumTransitions > HARD_MAXIMUM_TRANSITIONS
  ) {
    throw new RangeError(
      `maximumTransitions must be an integer from 1 through ${HARD_MAXIMUM_TRANSITIONS}; received ${maximumTransitions}`,
    );
  }
  return { maximumTransitions, evidence: [], transitions: 0 };
}

function consumeTransition(state: MutableNormalizationState): void {
  if (state.transitions >= state.maximumTransitions) {
    throw new Error(
      `Functional type normalization exceeded ${state.maximumTransitions} transitions`,
    );
  }
  state.transitions++;
}

function requireName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `Functional type ${location} must have a nonempty name; received ${JSON.stringify(name)}`,
    );
  }
}

function requireWidth(width: number, location: string): void {
  if (width > MAXIMUM_WIDTH) {
    throw new Error(
      `Functional type ${location} exceed the maximum width of ${MAXIMUM_WIDTH}; received ${width}`,
    );
  }
}

function requireDepth(depth: number): void {
  if (depth > MAXIMUM_STRUCTURAL_DEPTH) {
    throw new Error(
      `Functional type program exceeds structural depth ${MAXIMUM_STRUCTURAL_DEPTH}`,
    );
  }
}
