import {
  type EncodedFunctionalModule,
  FUNCTIONAL_MAXIMUM_CONSTRUCTOR_ARITY,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  type FunctionalSpan,
  type FunctionalTypeSchema,
} from "../functional/abi.ts";
import {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  type FunctionalSurfaceTypeDeclaration,
} from "../functional/surface_builder.ts";
import type {
  OneSubmlFunctionalDefinition,
  OneSubmlFunctionalExpression,
  OneSubmlFunctionalPattern,
  OneSubmlFunctionalProgram,
  OneSubmlFunctionalType,
} from "./ast.ts";
import { OneSubmlFunctionalLoweringError } from "./diagnostic.ts";

export interface LoweredOneSubmlFunctionalProgram {
  readonly program: OneSubmlFunctionalProgram;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly module: EncodedFunctionalModule;
}

interface RecordShape {
  readonly signature: string;
  readonly typeName: string;
  readonly constructor: string;
  readonly fields: readonly string[];
}

interface LoweredExpression {
  readonly expression: FunctionalSurfaceExpression;
  readonly shape: RecordShape | null;
}

const binaryOperators: Readonly<Record<string, FunctionalBinaryOperator>> = {
  "==": FunctionalBinaryOperator.Equal,
  "!=": FunctionalBinaryOperator.NotEqual,
  "<": FunctionalBinaryOperator.Less,
  "<=": FunctionalBinaryOperator.LessEqual,
  ">": FunctionalBinaryOperator.Greater,
  ">=": FunctionalBinaryOperator.GreaterEqual,
  "+": FunctionalBinaryOperator.Add,
  "-": FunctionalBinaryOperator.Subtract,
  "*": FunctionalBinaryOperator.Multiply,
  "/": FunctionalBinaryOperator.Divide,
};

const tupleShape: RecordShape = {
  signature: "_0\u0000_1",
  typeName: "$TupleType",
  constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  fields: ["_0", "_1"],
};

export function lowerOneSubmlFunctionalProgram(
  program: OneSubmlFunctionalProgram,
): LoweredOneSubmlFunctionalProgram {
  return new OneSubmlFunctionalLowering(program).lower();
}

class OneSubmlFunctionalLowering {
  readonly #definitionSpans = new Map<string, FunctionalSpan>();
  readonly #globalShapes = new Map<string, RecordShape | null>();
  readonly #recordShapes = new Map<string, RecordShape>();
  readonly #typeDeclarations: FunctionalSurfaceTypeDeclaration[] = [];
  #temporaryIndex = 0;
  #annotatedDefinitionLambda: OneSubmlFunctionalExpression | null = null;

  constructor(private readonly program: OneSubmlFunctionalProgram) {}

  lower(): LoweredOneSubmlFunctionalProgram {
    const definitions: FunctionalSurfaceDefinition[] = [];
    for (const definition of this.program.definitions) {
      this.rejectDuplicateDefinition(definition);
      const lowered = this.lowerDefinition(definition);
      definitions.push(lowered.definition);
      this.#globalShapes.set(definition.name, lowered.shape);
      this.#definitionSpans.set(definition.name, definition.span);
    }

    const entry = definitions.find((definition) => definition.name === "gpu_main");
    if (entry === undefined) {
      throw new OneSubmlFunctionalLoweringError(
        this.program.span,
        "1SubML functional source must declare let gpu_main as its GPU entry.",
      );
    }
    const typeDeclarations = Object.freeze([...this.#typeDeclarations]);
    const frozenDefinitions = Object.freeze(definitions);
    return {
      program: this.program,
      definitions: frozenDefinitions,
      typeDeclarations,
      module: buildFunctionalSurfaceModule(
        frozenDefinitions,
        typeDeclarations,
        "gpu_main",
        this.program.span.endByte,
        { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
      ),
    };
  }

  private rejectDuplicateDefinition(definition: OneSubmlFunctionalDefinition): void {
    const previous = this.#definitionSpans.get(definition.name);
    if (previous === undefined) return;
    throw new OneSubmlFunctionalLoweringError(
      definition.span,
      `1SubML source repeats value ${
        JSON.stringify(definition.name)
      }; the first declaration starts at byte ${previous.startByte}.`,
    );
  }

  private lowerDefinition(definition: OneSubmlFunctionalDefinition): {
    readonly definition: FunctionalSurfaceDefinition;
    readonly shape: RecordShape | null;
  } {
    if (definition.recursive && definition.value.kind !== "lambda") {
      throw new OneSubmlFunctionalLoweringError(
        definition.span,
        `Recursive 1SubML definition ${JSON.stringify(definition.name)} must bind a function.`,
      );
    }
    const globals = new Map(this.#globalShapes);
    if (definition.recursive) globals.set(definition.name, null);
    let annotation: FunctionalTypeSchema | null = null;
    if (definition.value.kind === "lambda") {
      requireUniqueNames(
        definition.value.typeParameters,
        definition.value.span,
        `function ${JSON.stringify(definition.name)} type parameters`,
      );
      const parameterType = definition.value.parameterType;
      const resultType = definition.value.resultType;
      if ((parameterType === null) !== (resultType === null)) {
        throw new OneSubmlFunctionalLoweringError(
          definition.value.span,
          `Annotated 1SubML function ${
            JSON.stringify(definition.name)
          } requires both parameter and result types.`,
        );
      }
      if (definition.value.typeParameters.length !== 0 && parameterType === null) {
        throw new OneSubmlFunctionalLoweringError(
          definition.value.span,
          `Generic 1SubML function ${
            JSON.stringify(definition.name)
          } requires parameter and result types.`,
        );
      }
      if (parameterType !== null && resultType !== null) {
        const declaredParameters = new Set(definition.value.typeParameters);
        const validateType = (
          type: OneSubmlFunctionalType,
          boundParameters: ReadonlySet<string>,
        ): void => {
          switch (type.kind) {
            case "integer":
            case "boolean":
            case "unit":
              return;
            case "parameter":
              if (!declaredParameters.has(type.name) && !boundParameters.has(type.name)) {
                throw new OneSubmlFunctionalLoweringError(
                  type.span,
                  `1SubML type parameter ${
                    JSON.stringify(type.name)
                  } is not declared by fun[...] or forall.`,
                );
              }
              return;
            case "tuple":
              validateType(type.values[0], boundParameters);
              validateType(type.values[1], boundParameters);
              return;
            case "function":
              validateType(type.parameter, boundParameters);
              validateType(type.result, boundParameters);
              return;
            case "forall": {
              const nested = new Set(boundParameters);
              for (const parameter of type.parameters) {
                if (declaredParameters.has(parameter) || nested.has(parameter)) {
                  throw new OneSubmlFunctionalLoweringError(
                    type.span,
                    `1SubML forall parameter ${
                      JSON.stringify(parameter)
                    } conflicts with an enclosing parameter.`,
                  );
                }
                nested.add(parameter);
              }
              validateType(type.body, nested);
              return;
            }
          }
        };
        validateType(parameterType, new Set());
        validateType(resultType, new Set());
        annotation = {
          kind: "function",
          parameter: lowerType(parameterType),
          result: lowerType(resultType),
        };
        this.#annotatedDefinitionLambda = definition.value;
      }
    }
    let lowered: LoweredExpression;
    try {
      lowered = this.lowerExpression(definition.value, new Map(), globals);
    } finally {
      this.#annotatedDefinitionLambda = null;
    }
    return {
      definition: {
        name: definition.name,
        parameters: [],
        annotation,
        body: lowered.expression,
        span: definition.span,
      },
      shape: lowered.shape,
    };
  }

  private lowerExpression(
    expression: OneSubmlFunctionalExpression,
    lexicalShapes: ReadonlyMap<string, RecordShape | null>,
    globalShapes: ReadonlyMap<string, RecordShape | null>,
  ): LoweredExpression {
    switch (expression.kind) {
      case "integer":
      case "boolean":
        return { expression, shape: null };
      case "unit":
        return {
          expression: {
            kind: "name",
            name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
            span: expression.span,
          },
          shape: null,
        };
      case "name":
        return this.lowerName(expression, lexicalShapes, globalShapes);
      case "tuple": {
        const first = this.lowerExpression(expression.values[0], lexicalShapes, globalShapes);
        const second = this.lowerExpression(expression.values[1], lexicalShapes, globalShapes);
        return {
          expression: apply(
            { kind: "name", name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, span: expression.span },
            [first.expression, second.expression],
            expression.span,
          ),
          shape: tupleShape,
        };
      }
      case "record":
        return this.lowerRecord(expression, lexicalShapes, globalShapes);
      case "field":
        return this.lowerField(expression, lexicalShapes, globalShapes);
      case "lambda":
        return this.lowerLambda(expression, lexicalShapes, globalShapes);
      case "apply": {
        const callee = this.lowerExpression(expression.callee, lexicalShapes, globalShapes);
        const argument = this.lowerExpression(expression.argument, lexicalShapes, globalShapes);
        return {
          expression: {
            kind: "apply",
            callee: callee.expression,
            argument: argument.expression,
            span: expression.span,
          },
          shape: null,
        };
      }
      case "let":
        return this.lowerLet(expression, lexicalShapes, globalShapes);
      case "if": {
        const condition = this.lowerExpression(expression.condition, lexicalShapes, globalShapes);
        const consequent = this.lowerExpression(expression.consequent, lexicalShapes, globalShapes);
        const alternate = this.lowerExpression(expression.alternate, lexicalShapes, globalShapes);
        return {
          expression: {
            kind: "if",
            condition: condition.expression,
            consequent: consequent.expression,
            alternate: alternate.expression,
            span: expression.span,
          },
          shape: consequent.shape?.signature === alternate.shape?.signature
            ? consequent.shape
            : null,
        };
      }
      case "binary": {
        const operator = binaryOperators[expression.operator];
        if (operator === undefined) {
          throw new Error(`1SubML lowering omitted binary operator ${expression.operator}.`);
        }
        const left = this.lowerExpression(expression.left, lexicalShapes, globalShapes);
        const right = this.lowerExpression(expression.right, lexicalShapes, globalShapes);
        return {
          expression: {
            kind: "binary",
            operator,
            left: left.expression,
            right: right.expression,
            span: expression.span,
          },
          shape: null,
        };
      }
    }
  }

  private lowerName(
    expression: Extract<OneSubmlFunctionalExpression, { readonly kind: "name" }>,
    lexicalShapes: ReadonlyMap<string, RecordShape | null>,
    globalShapes: ReadonlyMap<string, RecordShape | null>,
  ): LoweredExpression {
    if (lexicalShapes.has(expression.name)) {
      return {
        expression,
        shape: lexicalShapes.get(expression.name) ?? null,
      };
    }
    if (globalShapes.has(expression.name)) {
      return {
        expression,
        shape: globalShapes.get(expression.name) ?? null,
      };
    }
    throw new OneSubmlFunctionalLoweringError(
      expression.span,
      `1SubML value ${JSON.stringify(expression.name)} is not in sequential scope.`,
    );
  }

  private lowerRecord(
    expression: Extract<OneSubmlFunctionalExpression, { readonly kind: "record" }>,
    lexicalShapes: ReadonlyMap<string, RecordShape | null>,
    globalShapes: ReadonlyMap<string, RecordShape | null>,
  ): LoweredExpression {
    const byName = new Map<string, OneSubmlFunctionalExpression>();
    for (const field of expression.fields) {
      if (byName.has(field.name)) {
        throw new OneSubmlFunctionalLoweringError(
          field.span,
          `1SubML record repeats field ${JSON.stringify(field.name)}.`,
        );
      }
      byName.set(field.name, field.value);
    }
    const fields = [...byName.keys()].sort();
    const shape = this.recordShape(fields, expression.span);
    const values = fields.map((field) => {
      const value = byName.get(field);
      if (value === undefined) {
        throw new Error(`1SubML record omitted field ${JSON.stringify(field)}.`);
      }
      return this.lowerExpression(value, lexicalShapes, globalShapes).expression;
    });
    return {
      expression: apply(
        { kind: "name", name: shape.constructor, span: expression.span },
        values,
        expression.span,
      ),
      shape,
    };
  }

  private lowerField(
    expression: Extract<OneSubmlFunctionalExpression, { readonly kind: "field" }>,
    lexicalShapes: ReadonlyMap<string, RecordShape | null>,
    globalShapes: ReadonlyMap<string, RecordShape | null>,
  ): LoweredExpression {
    const value = this.lowerExpression(expression.value, lexicalShapes, globalShapes);
    if (value.shape === null) {
      throw new OneSubmlFunctionalLoweringError(
        expression.span,
        `1SubML functional profile cannot determine the record shape required for field ${
          JSON.stringify(expression.field)
        }.`,
      );
    }
    const fieldIndex = value.shape.fields.indexOf(expression.field);
    if (fieldIndex < 0) {
      throw new OneSubmlFunctionalLoweringError(
        expression.span,
        `1SubML record ${value.shape.typeName} has no field ${
          JSON.stringify(expression.field)
        }; available fields are ${JSON.stringify(value.shape.fields)}.`,
      );
    }
    const binders = value.shape.fields.map(() => this.temporary("field"));
    const selected = binders[fieldIndex];
    if (selected === undefined) {
      throw new Error(`1SubML record omitted field binder ${fieldIndex}.`);
    }
    return {
      expression: {
        kind: "case",
        value: value.expression,
        arms: [{
          constructor: value.shape.constructor,
          binders,
          body: { kind: "name", name: selected, span: expression.span },
          span: expression.span,
        }],
        span: expression.span,
      },
      shape: null,
    };
  }

  private lowerLambda(
    expression: Extract<OneSubmlFunctionalExpression, { readonly kind: "lambda" }>,
    lexicalShapes: ReadonlyMap<string, RecordShape | null>,
    globalShapes: ReadonlyMap<string, RecordShape | null>,
  ): LoweredExpression {
    if (
      (expression.parameterType !== null || expression.resultType !== null) &&
      expression !== this.#annotatedDefinitionLambda
    ) {
      throw new OneSubmlFunctionalLoweringError(
        expression.span,
        "Higher-rank annotations currently belong on a top-level 1SubML function definition.",
      );
    }
    if (expression.typeParameters.length !== 0 && expression !== this.#annotatedDefinitionLambda) {
      throw new OneSubmlFunctionalLoweringError(
        expression.span,
        "Generic 1SubML functions currently belong on a top-level definition.",
      );
    }
    const names = patternNames(expression.parameter);
    requireUniqueNames(names, expression.parameter.span, "function parameter pattern");
    const bodyShapes = new Map(lexicalShapes);
    for (const name of names) bodyShapes.set(name, null);
    const body = this.lowerExpression(expression.body, bodyShapes, globalShapes);
    if (expression.parameter.kind === "name") {
      const parameter = expression.parameter.name ?? this.temporary("ignored");
      return {
        expression: { kind: "lambda", parameter, body: body.expression, span: expression.span },
        shape: null,
      };
    }
    const parameter = this.temporary("parameter");
    return {
      expression: {
        kind: "lambda",
        parameter,
        body: this.bindTuplePattern(
          expression.parameter,
          { kind: "name", name: parameter, span: expression.parameter.span },
          body.expression,
        ),
        span: expression.span,
      },
      shape: null,
    };
  }

  private lowerLet(
    expression: Extract<OneSubmlFunctionalExpression, { readonly kind: "let" }>,
    lexicalShapes: ReadonlyMap<string, RecordShape | null>,
    globalShapes: ReadonlyMap<string, RecordShape | null>,
  ): LoweredExpression {
    if (expression.recursive && expression.value.kind !== "lambda") {
      throw new OneSubmlFunctionalLoweringError(
        expression.span,
        "Recursive local 1SubML bindings must bind a function.",
      );
    }
    const names = patternNames(expression.pattern);
    requireUniqueNames(names, expression.pattern.span, "local binding pattern");
    const valueShapes = new Map(lexicalShapes);
    if (expression.recursive) {
      const recursiveName = names[0];
      if (recursiveName === undefined) {
        throw new OneSubmlFunctionalLoweringError(
          expression.pattern.span,
          "Recursive local 1SubML bindings cannot use a wildcard.",
        );
      }
      valueShapes.set(recursiveName, null);
    }
    const value = this.lowerExpression(expression.value, valueShapes, globalShapes);
    const bodyShapes = new Map(lexicalShapes);
    if (expression.pattern.kind === "name" && expression.pattern.name !== null) {
      bodyShapes.set(expression.pattern.name, value.shape);
    } else {
      for (const name of names) bodyShapes.set(name, null);
    }
    const body = this.lowerExpression(expression.body, bodyShapes, globalShapes);
    if (expression.pattern.kind === "name") {
      const name = expression.pattern.name ?? this.temporary("ignored");
      const binding: FunctionalSurfaceExpression = expression.recursive
        ? {
          kind: "let-rec",
          name,
          value: value.expression,
          body: body.expression,
          span: expression.span,
        }
        : {
          kind: "let",
          name,
          value: value.expression,
          body: body.expression,
          span: expression.span,
        };
      return {
        expression: binding,
        shape: body.shape,
      };
    }
    return {
      expression: this.bindTuplePattern(expression.pattern, value.expression, body.expression),
      shape: body.shape,
    };
  }

  private bindTuplePattern(
    pattern: Extract<OneSubmlFunctionalPattern, { readonly kind: "tuple" }>,
    value: FunctionalSurfaceExpression,
    body: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const first = this.patternBinder(pattern.values[0]);
    const second = this.patternBinder(pattern.values[1]);
    let armBody = body;
    if (pattern.values[1].kind === "tuple") {
      armBody = this.bindTuplePattern(
        pattern.values[1],
        { kind: "name", name: second, span: pattern.values[1].span },
        armBody,
      );
    }
    if (pattern.values[0].kind === "tuple") {
      armBody = this.bindTuplePattern(
        pattern.values[0],
        { kind: "name", name: first, span: pattern.values[0].span },
        armBody,
      );
    }
    return {
      kind: "case",
      value,
      arms: [{
        constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
        binders: [first, second],
        body: armBody,
        span: pattern.span,
      }],
      span: pattern.span,
    };
  }

  private patternBinder(pattern: OneSubmlFunctionalPattern): string {
    if (pattern.kind === "name" && pattern.name !== null) return pattern.name;
    return this.temporary(pattern.kind === "tuple" ? "tuple" : "ignored");
  }

  private recordShape(fields: readonly string[], span: FunctionalSpan): RecordShape {
    if (fields.length > FUNCTIONAL_MAXIMUM_CONSTRUCTOR_ARITY) {
      throw new OneSubmlFunctionalLoweringError(
        span,
        `1SubML record has ${fields.length} fields; the functional core accepts at most ${FUNCTIONAL_MAXIMUM_CONSTRUCTOR_ARITY}.`,
      );
    }
    const signature = fields.join("\u0000");
    const existing = this.#recordShapes.get(signature);
    if (existing !== undefined) return existing;
    const index = this.#recordShapes.size;
    const typeName = `$OneSubmlRecord${index}`;
    const constructor = `$OneSubmlRecordValue${index}`;
    const shape = { signature, typeName, constructor, fields: Object.freeze([...fields]) };
    this.#recordShapes.set(signature, shape);
    const parameters = fields.map((_, fieldIndex) => `Field${fieldIndex}`);
    this.#typeDeclarations.push({
      name: typeName,
      parameters,
      span,
      constructors: [{
        name: constructor,
        span,
        fields: fields.map((name, fieldIndex) => ({
          name,
          type: { kind: "parameter", name: parameters[fieldIndex] ?? `Field${fieldIndex}` },
          span,
        })),
      }],
    });
    return shape;
  }

  private temporary(purpose: string): string {
    const name = `$onesubml$${purpose}${this.#temporaryIndex}`;
    this.#temporaryIndex += 1;
    return name;
  }
}

function lowerType(type: OneSubmlFunctionalType): FunctionalTypeSchema {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return { kind: type.kind };
    case "parameter":
      return { kind: "parameter", name: type.name };
    case "tuple":
      return {
        kind: "tuple",
        values: [lowerType(type.values[0]), lowerType(type.values[1])],
      };
    case "function":
      return {
        kind: "function",
        parameter: lowerType(type.parameter),
        result: lowerType(type.result),
      };
    case "forall":
      requireUniqueNames(type.parameters, type.span, "forall parameters");
      return {
        kind: "forall",
        parameters: [...type.parameters],
        body: lowerType(type.body),
      };
  }
}

function patternNames(pattern: OneSubmlFunctionalPattern): readonly string[] {
  if (pattern.kind === "name") return pattern.name === null ? [] : [pattern.name];
  return [...patternNames(pattern.values[0]), ...patternNames(pattern.values[1])];
}

function requireUniqueNames(
  names: readonly string[],
  span: FunctionalSpan,
  location: string,
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      continue;
    }
    throw new OneSubmlFunctionalLoweringError(
      span,
      `1SubML ${location} repeats name ${JSON.stringify(name)}.`,
    );
  }
}

function apply(
  callee: FunctionalSurfaceExpression,
  arguments_: readonly FunctionalSurfaceExpression[],
  span: FunctionalSpan,
): FunctionalSurfaceExpression {
  let expression = callee;
  for (const argument of arguments_) {
    expression = { kind: "apply", callee: expression, argument, span };
  }
  return expression;
}
