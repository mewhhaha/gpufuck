import {
  type TypeCoreExpression,
  type TypeCoreFunction,
  type TypeCoreKind,
  TypeCoreKind as Kind,
  type TypeCorePattern,
  type TypeCoreProgram,
  type TypeCoreTypeConstructor,
  type TypeCoreTypeExpression,
  type TypeCoreTypePattern,
} from "./type_core_contract.ts";

const MAXIMUM_TYPE_CORE_DEPTH = 512;
const MAXIMUM_TYPE_CORE_WIDTH = 256;
export const TYPE_CORE_RESERVED_NAME_PREFIX = "$TypeCore";

export interface ValidatedTypeCoreProgram {
  readonly program: TypeCoreProgram;
  readonly constructors: ReadonlyMap<string, TypeCoreTypeConstructor>;
  readonly functions: ReadonlyMap<string, TypeCoreFunction>;
  readonly entryKind: TypeCoreKind;
  readonly sourceByteLength: number;
}

export function validateTypeCoreProgram(program: TypeCoreProgram): ValidatedTypeCoreProgram {
  const sourceByteLength = program.sourceByteLength ?? 0;
  if (!Number.isSafeInteger(sourceByteLength) || sourceByteLength < 0) {
    throw new Error(
      `Type Core source byte length must be a nonnegative integer; received ${sourceByteLength}`,
    );
  }

  const constructors = new Map<string, TypeCoreTypeConstructor>();
  for (const [constructorIndex, constructor] of program.typeConstructors.entries()) {
    validatePublicName(constructor.name, `type constructor ${constructorIndex}`);
    if (constructors.has(constructor.name)) {
      throw new Error(`Type Core repeats type constructor ${JSON.stringify(constructor.name)}`);
    }
    validateWidth(
      constructor.parameterKinds.length,
      `type constructor ${JSON.stringify(constructor.name)} parameters`,
    );
    for (const [parameterIndex, kind] of constructor.parameterKinds.entries()) {
      validateKind(
        kind,
        `type constructor ${JSON.stringify(constructor.name)} parameter ${parameterIndex}`,
      );
    }
    constructors.set(constructor.name, constructor);
  }

  const functions = new Map<string, TypeCoreFunction>();
  for (const [functionIndex, typeFunction] of program.functions.entries()) {
    validatePublicName(typeFunction.name, `type function ${functionIndex}`);
    if (functions.has(typeFunction.name)) {
      throw new Error(`Type Core repeats type function ${JSON.stringify(typeFunction.name)}`);
    }
    validateKind(
      typeFunction.resultKind,
      `type function ${JSON.stringify(typeFunction.name)} result`,
    );
    validateWidth(
      typeFunction.parameters.length,
      `type function ${JSON.stringify(typeFunction.name)} parameters`,
    );
    const parameterNames = new Set<string>();
    for (const [parameterIndex, parameter] of typeFunction.parameters.entries()) {
      validatePublicName(
        parameter.name,
        `type function ${JSON.stringify(typeFunction.name)} parameter ${parameterIndex}`,
      );
      validateKind(
        parameter.kind,
        `type function ${JSON.stringify(typeFunction.name)} parameter ${parameterIndex}`,
      );
      if (parameterNames.has(parameter.name)) {
        throw new Error(
          `Type Core function ${JSON.stringify(typeFunction.name)} repeats parameter ${
            JSON.stringify(parameter.name)
          }`,
        );
      }
      parameterNames.add(parameter.name);
    }
    functions.set(typeFunction.name, typeFunction);
  }

  const context: ValidationContext = { constructors, functions };
  for (const typeFunction of program.functions) {
    const environment = new Map(
      typeFunction.parameters.map((parameter) => [parameter.name, parameter.kind] as const),
    );
    const bodyKind = expressionKind(typeFunction.body, environment, context, 0);
    if (bodyKind !== typeFunction.resultKind) {
      throw new Error(
        `Type Core function ${
          JSON.stringify(typeFunction.name)
        } declares result kind ${typeFunction.resultKind} but its body has kind ${bodyKind}`,
      );
    }
  }
  const entryKind = expressionKind(program.entry, new Map(), context, 0);
  return { program, constructors, functions, entryKind, sourceByteLength };
}

interface ValidationContext {
  readonly constructors: ReadonlyMap<string, TypeCoreTypeConstructor>;
  readonly functions: ReadonlyMap<string, TypeCoreFunction>;
}

function expressionKind(
  expression: TypeCoreExpression,
  environment: ReadonlyMap<string, TypeCoreKind>,
  context: ValidationContext,
  depth: number,
): TypeCoreKind {
  validateDepth(depth);
  switch (expression.kind) {
    case "type":
      validateTypeExpression(expression.type, environment, context, depth + 1);
      return Kind.Type;
    case "integer":
      validateI32(expression.value, "Type Core integer literal");
      return Kind.Integer;
    case "boolean":
      return Kind.Boolean;
    case "symbol":
      validateSymbolValue(expression.value, "Type Core symbol literal");
      return Kind.Symbol;
    case "reference": {
      const kind = environment.get(expression.name);
      if (kind === undefined) {
        throw new Error(`Type Core references unknown value ${JSON.stringify(expression.name)}`);
      }
      return kind;
    }
    case "call": {
      const typeFunction = context.functions.get(expression.function);
      if (typeFunction === undefined) {
        throw new Error(`Type Core calls unknown function ${JSON.stringify(expression.function)}`);
      }
      if (expression.arguments.length !== typeFunction.parameters.length) {
        throw new Error(
          `Type Core function ${
            JSON.stringify(expression.function)
          } expects ${typeFunction.parameters.length} arguments; received ${expression.arguments.length}`,
        );
      }
      for (const [argumentIndex, argument] of expression.arguments.entries()) {
        const expectedKind = typeFunction.parameters[argumentIndex]?.kind;
        if (expectedKind === undefined) {
          throw new Error(
            `Type Core function ${
              JSON.stringify(expression.function)
            } omitted parameter ${argumentIndex}`,
          );
        }
        requireExpressionKind(
          argument,
          expectedKind,
          environment,
          context,
          depth + 1,
          `argument ${argumentIndex} to ${JSON.stringify(expression.function)}`,
        );
      }
      return typeFunction.resultKind;
    }
    case "if": {
      requireExpressionKind(
        expression.condition,
        Kind.Boolean,
        environment,
        context,
        depth + 1,
        "if condition",
      );
      const consequentKind = expressionKind(
        expression.consequent,
        environment,
        context,
        depth + 1,
      );
      const alternateKind = expressionKind(
        expression.alternate,
        environment,
        context,
        depth + 1,
      );
      if (consequentKind !== alternateKind) {
        throw new Error(
          `Type Core if branches have different kinds: consequent=${consequentKind}, alternate=${alternateKind}`,
        );
      }
      return consequentKind;
    }
    case "integer-operation":
    case "integer-equal":
      requireExpressionKind(
        expression.left,
        Kind.Integer,
        environment,
        context,
        depth + 1,
        `${expression.kind} left operand`,
      );
      requireExpressionKind(
        expression.right,
        Kind.Integer,
        environment,
        context,
        depth + 1,
        `${expression.kind} right operand`,
      );
      return expression.kind === "integer-operation" ? Kind.Integer : Kind.Boolean;
    case "symbol-equal":
      requireExpressionKind(
        expression.left,
        Kind.Symbol,
        environment,
        context,
        depth + 1,
        "symbol equality left operand",
      );
      requireExpressionKind(
        expression.right,
        Kind.Symbol,
        environment,
        context,
        depth + 1,
        "symbol equality right operand",
      );
      return Kind.Boolean;
    case "match": {
      validateWidth(expression.arms.length, "match arms");
      const valueKind = expressionKind(expression.value, environment, context, depth + 1);
      const resultKind = expressionKind(expression.fallback, environment, context, depth + 1);
      for (const [armIndex, arm] of expression.arms.entries()) {
        const bindings = new Map<string, TypeCoreKind>();
        validatePattern(arm.pattern, valueKind, bindings, context, depth + 1);
        const armEnvironment = new Map(environment);
        for (const [name, kind] of bindings) {
          if (armEnvironment.has(name)) {
            throw new Error(
              `Type Core match arm ${armIndex} binder ${
                JSON.stringify(name)
              } shadows an existing value`,
            );
          }
          armEnvironment.set(name, kind);
        }
        requireExpressionKind(
          arm.result,
          resultKind,
          armEnvironment,
          context,
          depth + 1,
          `match arm ${armIndex}`,
        );
      }
      return resultKind;
    }
  }
}

function validateTypeExpression(
  expression: TypeCoreTypeExpression,
  environment: ReadonlyMap<string, TypeCoreKind>,
  context: ValidationContext,
  depth: number,
): void {
  validateDepth(depth);
  switch (expression.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return;
    case "named": {
      const constructor = context.constructors.get(expression.name);
      if (constructor === undefined) {
        throw new Error(
          `Type Core constructs undeclared type ${JSON.stringify(expression.name)}`,
        );
      }
      if (expression.arguments.length !== constructor.parameterKinds.length) {
        throw new Error(
          `Type Core type ${
            JSON.stringify(expression.name)
          } expects ${constructor.parameterKinds.length} arguments; received ${expression.arguments.length}`,
        );
      }
      for (const [argumentIndex, argument] of expression.arguments.entries()) {
        const expectedKind = constructor.parameterKinds[argumentIndex];
        if (expectedKind === undefined) {
          throw new Error(
            `Type Core type ${
              JSON.stringify(expression.name)
            } omitted parameter kind ${argumentIndex}`,
          );
        }
        requireExpressionKind(
          argument,
          expectedKind,
          environment,
          context,
          depth + 1,
          `argument ${argumentIndex} to type ${JSON.stringify(expression.name)}`,
        );
      }
      return;
    }
    case "tuple":
      requireExpressionKind(
        expression.values[0],
        Kind.Type,
        environment,
        context,
        depth + 1,
        "tuple first type",
      );
      requireExpressionKind(
        expression.values[1],
        Kind.Type,
        environment,
        context,
        depth + 1,
        "tuple second type",
      );
      return;
    case "function":
      requireExpressionKind(
        expression.parameter,
        Kind.Type,
        environment,
        context,
        depth + 1,
        "function parameter type",
      );
      requireExpressionKind(
        expression.result,
        Kind.Type,
        environment,
        context,
        depth + 1,
        "function result type",
      );
      return;
  }
}

function validatePattern(
  pattern: TypeCorePattern,
  expectedKind: TypeCoreKind,
  bindings: Map<string, TypeCoreKind>,
  context: ValidationContext,
  depth: number,
): void {
  validateDepth(depth);
  switch (pattern.kind) {
    case "bind":
      validatePublicName(pattern.name, "match binder");
      if (bindings.has(pattern.name)) {
        throw new Error(`Type Core pattern repeats binder ${JSON.stringify(pattern.name)}`);
      }
      bindings.set(pattern.name, expectedKind);
      return;
    case "type":
      requireKind(expectedKind, Kind.Type, "type pattern");
      validateTypePattern(pattern.type, bindings, context, depth + 1);
      return;
    case "integer":
      requireKind(expectedKind, Kind.Integer, "integer pattern");
      validateI32(pattern.value, "Type Core integer pattern");
      return;
    case "boolean":
      requireKind(expectedKind, Kind.Boolean, "Boolean pattern");
      return;
    case "symbol":
      requireKind(expectedKind, Kind.Symbol, "symbol pattern");
      validateSymbolValue(pattern.value, "Type Core symbol pattern");
      return;
  }
}

function validateTypePattern(
  pattern: TypeCoreTypePattern,
  bindings: Map<string, TypeCoreKind>,
  context: ValidationContext,
  depth: number,
): void {
  validateDepth(depth);
  switch (pattern.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return;
    case "named": {
      const constructor = context.constructors.get(pattern.name);
      if (constructor === undefined) {
        throw new Error(
          `Type Core pattern references undeclared type ${JSON.stringify(pattern.name)}`,
        );
      }
      if (pattern.arguments.length !== constructor.parameterKinds.length) {
        throw new Error(
          `Type Core pattern for ${
            JSON.stringify(pattern.name)
          } expects ${constructor.parameterKinds.length} arguments; received ${pattern.arguments.length}`,
        );
      }
      for (const [argumentIndex, argument] of pattern.arguments.entries()) {
        const expectedKind = constructor.parameterKinds[argumentIndex];
        if (expectedKind === undefined) {
          throw new Error(
            `Type Core pattern for ${
              JSON.stringify(pattern.name)
            } omitted parameter kind ${argumentIndex}`,
          );
        }
        validatePattern(argument, expectedKind, bindings, context, depth + 1);
      }
      return;
    }
    case "tuple":
      validatePattern(pattern.values[0], Kind.Type, bindings, context, depth + 1);
      validatePattern(pattern.values[1], Kind.Type, bindings, context, depth + 1);
      return;
    case "function":
      validatePattern(pattern.parameter, Kind.Type, bindings, context, depth + 1);
      validatePattern(pattern.result, Kind.Type, bindings, context, depth + 1);
      return;
  }
}

function requireExpressionKind(
  expression: TypeCoreExpression,
  expectedKind: TypeCoreKind,
  environment: ReadonlyMap<string, TypeCoreKind>,
  context: ValidationContext,
  depth: number,
  location: string,
): void {
  const actualKind = expressionKind(expression, environment, context, depth);
  requireKind(actualKind, expectedKind, location);
}

function requireKind(actualKind: TypeCoreKind, expectedKind: TypeCoreKind, location: string): void {
  if (actualKind !== expectedKind) {
    throw new Error(
      `Type Core ${location} requires kind ${expectedKind}; received ${actualKind}`,
    );
  }
}

function validateKind(kind: TypeCoreKind, location: string): void {
  switch (kind) {
    case Kind.Type:
    case Kind.Integer:
    case Kind.Boolean:
    case Kind.Symbol:
      return;
    default:
      throw new Error(`Type Core ${location} has unsupported kind ${JSON.stringify(kind)}`);
  }
}

function validatePublicName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `Type Core ${location} must have a nonempty name; received ${JSON.stringify(name)}`,
    );
  }
  if (name.startsWith(TYPE_CORE_RESERVED_NAME_PREFIX)) {
    throw new Error(
      `Type Core ${location} name ${JSON.stringify(name)} uses reserved prefix ${
        JSON.stringify(TYPE_CORE_RESERVED_NAME_PREFIX)
      }`,
    );
  }
}

function validateSymbolValue(value: string, location: string): void {
  if (typeof value !== "string") {
    throw new Error(`${location} must be a string; received ${value}`);
  }
}

function validateI32(value: number, location: string): void {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error(`${location} must be a signed i32; received ${value}`);
  }
}

function validateDepth(depth: number): void {
  if (depth > MAXIMUM_TYPE_CORE_DEPTH) {
    throw new Error(`Type Core exceeds the maximum structural depth of ${MAXIMUM_TYPE_CORE_DEPTH}`);
  }
}

function validateWidth(width: number, location: string): void {
  if (width > MAXIMUM_TYPE_CORE_WIDTH) {
    throw new Error(
      `Type Core ${location} exceed the maximum width of ${MAXIMUM_TYPE_CORE_WIDTH}; received ${width}`,
    );
  }
}
