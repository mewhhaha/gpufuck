import {
  type EncodedFunctionalModule,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
} from "./abi.ts";
import {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceCaseArm,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  surface,
} from "./surface_builder.ts";
import type {
  TypeCoreExpression,
  TypeCoreKind,
  TypeCorePattern,
  TypeCoreTypeExpression,
  TypeCoreTypePattern,
} from "./type_core_contract.ts";
import {
  compileValueFunctionType,
  namedType,
  TYPE_CORE_ENTRY_DEFINITION,
  TYPE_CORE_VALUE,
  TypeCoreRuntimeConstructor,
  typeCoreRuntimeDeclarations,
} from "./type_core_runtime.ts";
import type { ValidatedTypeCoreProgram } from "./type_core_validation.ts";

export interface LoweredTypeCoreProgram {
  readonly module: EncodedFunctionalModule;
  readonly symbolValues: readonly string[];
  readonly entryKind: TypeCoreKind;
}

export function lowerTypeCoreProgram(
  validated: ValidatedTypeCoreProgram,
): LoweredTypeCoreProgram {
  const symbols = new CompileTimeSymbolTable();
  for (const constructor of validated.program.typeConstructors) symbols.intern(constructor.name);
  const functionNames = new Map<string, string>();
  for (const [functionIndex, typeFunction] of validated.program.functions.entries()) {
    functionNames.set(typeFunction.name, `$TypeCoreFunction${functionIndex}`);
  }
  const lowering = new TypeCoreLowering(symbols, functionNames);
  const definitions: FunctionalSurfaceDefinition[] = validated.program.functions.map(
    (typeFunction) => ({
      name: requiredFunctionName(functionNames, typeFunction.name),
      parameters: typeFunction.parameters.map((parameter) => parameter.name),
      annotation: compileValueFunctionType(typeFunction.parameters.length),
      body: lowering.expression(
        typeFunction.body,
        new Map(
          typeFunction.parameters.map((parameter) =>
            [
              parameter.name,
              surface.name(parameter.name),
            ] as const
          ),
        ),
      ),
    }),
  );
  definitions.push({
    name: TYPE_CORE_ENTRY_DEFINITION,
    parameters: [],
    annotation: namedType(TYPE_CORE_VALUE),
    body: lowering.expression(validated.program.entry, new Map()),
  });

  return {
    module: buildFunctionalSurfaceModule(
      definitions,
      typeCoreRuntimeDeclarations(),
      TYPE_CORE_ENTRY_DEFINITION,
      validated.sourceByteLength,
      { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
    ),
    symbolValues: symbols.values,
    entryKind: validated.entryKind,
  };
}

class TypeCoreLowering {
  #temporaryIndex = 0;

  constructor(
    private readonly symbols: CompileTimeSymbolTable,
    private readonly functionNames: ReadonlyMap<string, string>,
  ) {}

  expression(
    expression: TypeCoreExpression,
    environment: ReadonlyMap<string, FunctionalSurfaceExpression>,
  ): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "type":
        return this.wrapType(this.typeExpression(expression.type, environment));
      case "integer":
        return this.construct(
          TypeCoreRuntimeConstructor.ValueInteger,
          surface.integer(expression.value),
        );
      case "boolean":
        return this.construct(
          TypeCoreRuntimeConstructor.ValueBoolean,
          surface.boolean(expression.value),
        );
      case "symbol":
        return this.construct(
          TypeCoreRuntimeConstructor.ValueSymbol,
          surface.integer(this.symbols.intern(expression.value)),
        );
      case "reference": {
        const value = environment.get(expression.name);
        if (value === undefined) {
          throw new Error(
            `validated Type Core expression omitted reference ${JSON.stringify(expression.name)}`,
          );
        }
        return value;
      }
      case "call": {
        let call = surface.name(requiredFunctionName(this.functionNames, expression.function));
        for (const argument of expression.arguments) {
          call = surface.apply(call, this.expression(argument, environment));
        }
        return call;
      }
      case "if":
        return {
          kind: "if",
          condition: this.unwrapBoolean(this.expression(expression.condition, environment)),
          consequent: this.expression(expression.consequent, environment),
          alternate: this.expression(expression.alternate, environment),
        };
      case "integer-operation": {
        const operator = {
          add: FunctionalBinaryOperator.Add,
          subtract: FunctionalBinaryOperator.Subtract,
          multiply: FunctionalBinaryOperator.Multiply,
        }[expression.operator];
        return this.construct(
          TypeCoreRuntimeConstructor.ValueInteger,
          surface.binary(
            operator,
            this.unwrapInteger(this.expression(expression.left, environment)),
            this.unwrapInteger(this.expression(expression.right, environment)),
          ),
        );
      }
      case "integer-equal":
        return this.wrapBoolean(surface.equal(
          this.unwrapInteger(this.expression(expression.left, environment)),
          this.unwrapInteger(this.expression(expression.right, environment)),
        ));
      case "symbol-equal":
        return this.wrapBoolean(surface.equal(
          this.unwrapSymbol(this.expression(expression.left, environment)),
          this.unwrapSymbol(this.expression(expression.right, environment)),
        ));
      case "match": {
        const temporary = this.temporary("matchValue");
        const value = surface.name(temporary);
        let result = this.expression(expression.fallback, environment);
        for (let armIndex = expression.arms.length - 1; armIndex >= 0; armIndex--) {
          const arm = expression.arms[armIndex];
          if (arm === undefined) {
            throw new Error(`validated Type Core match omitted arm ${armIndex}`);
          }
          const armEnvironment = new Map(environment);
          const projections: PatternProjection[] = [];
          this.collectPatternBindings(arm.pattern, value, armEnvironment, projections);
          result = {
            kind: "if",
            condition: this.patternCondition(arm.pattern, value),
            consequent: this.bindPatternProjections(
              projections,
              this.expression(arm.result, armEnvironment),
            ),
            alternate: result,
          };
        }
        return {
          kind: "let",
          name: temporary,
          value: this.expression(expression.value, environment),
          body: result,
        };
      }
    }
  }

  private typeExpression(
    expression: TypeCoreTypeExpression,
    environment: ReadonlyMap<string, FunctionalSurfaceExpression>,
  ): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "integer":
        return this.construct(TypeCoreRuntimeConstructor.TypeInteger);
      case "boolean":
        return this.construct(TypeCoreRuntimeConstructor.TypeBoolean);
      case "unit":
        return this.construct(TypeCoreRuntimeConstructor.TypeUnit);
      case "named":
        return this.construct(
          TypeCoreRuntimeConstructor.TypeNamed,
          surface.integer(this.symbols.intern(expression.name)),
          this.valueList(
            expression.arguments.map((argument) => this.expression(argument, environment)),
          ),
        );
      case "tuple":
        return this.construct(
          TypeCoreRuntimeConstructor.TypeTuple,
          this.unwrapType(this.expression(expression.values[0], environment)),
          this.unwrapType(this.expression(expression.values[1], environment)),
        );
      case "function":
        return this.construct(
          TypeCoreRuntimeConstructor.TypeFunction,
          this.unwrapType(this.expression(expression.parameter, environment)),
          this.unwrapType(this.expression(expression.result, environment)),
        );
    }
  }

  private patternCondition(
    pattern: TypeCorePattern,
    value: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    switch (pattern.kind) {
      case "bind":
        return surface.boolean(true);
      case "integer":
        return this.caseCompileValue(value, {
          integer: (integer) => surface.equal(integer, surface.integer(pattern.value)),
        }, surface.boolean(false));
      case "boolean":
        return this.caseCompileValue(value, {
          boolean: (boolean) => this.booleanEquals(boolean, pattern.value),
        }, surface.boolean(false));
      case "symbol":
        return this.caseCompileValue(value, {
          symbol: (symbol) =>
            surface.equal(
              symbol,
              surface.integer(this.symbols.intern(pattern.value)),
            ),
        }, surface.boolean(false));
      case "type":
        return this.caseCompileValue(value, {
          type: (type) => this.typePatternCondition(pattern.type, type),
        }, surface.boolean(false));
    }
  }

  private typePatternCondition(
    pattern: TypeCoreTypePattern,
    type: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    switch (pattern.kind) {
      case "integer":
        return this.caseType(type, {
          integer: () => surface.boolean(true),
        }, surface.boolean(false));
      case "boolean":
        return this.caseType(type, {
          boolean: () => surface.boolean(true),
        }, surface.boolean(false));
      case "unit":
        return this.caseType(type, {
          unit: () => surface.boolean(true),
        }, surface.boolean(false));
      case "named":
        return this.caseType(type, {
          named: (name, arguments_) =>
            this.and(
              surface.equal(name, surface.integer(this.symbols.intern(pattern.name))),
              this.listPatternCondition(arguments_, pattern.arguments),
            ),
        }, surface.boolean(false));
      case "tuple":
        return this.caseType(type, {
          tuple: (first, second) =>
            this.and(
              this.patternCondition(pattern.values[0], this.wrapType(first)),
              this.patternCondition(pattern.values[1], this.wrapType(second)),
            ),
        }, surface.boolean(false));
      case "function":
        return this.caseType(type, {
          function: (parameter, result) =>
            this.and(
              this.patternCondition(pattern.parameter, this.wrapType(parameter)),
              this.patternCondition(pattern.result, this.wrapType(result)),
            ),
        }, surface.boolean(false));
    }
  }

  private listPatternCondition(
    list: FunctionalSurfaceExpression,
    patterns: readonly TypeCorePattern[],
  ): FunctionalSurfaceExpression {
    if (patterns.length === 0) {
      return this.caseList(list, {
        nil: () => surface.boolean(true),
        cons: () => surface.boolean(false),
      });
    }

    const heads = patterns.map(() => this.temporary("patternHead"));
    const tails = patterns.map(() => this.temporary("patternTail"));
    const finalTail = tails[tails.length - 1];
    if (finalTail === undefined) throw new Error("Type Core pattern list omitted its final tail");
    let condition = this.caseList(surface.name(finalTail), {
      nil: () => surface.boolean(true),
      cons: () => surface.boolean(false),
    });
    for (let patternIndex = patterns.length - 1; patternIndex >= 0; patternIndex--) {
      const pattern = patterns[patternIndex];
      const head = heads[patternIndex];
      const tail = tails[patternIndex];
      if (pattern === undefined || head === undefined || tail === undefined) {
        throw new Error(`Type Core pattern list omitted index ${patternIndex}`);
      }
      const previousTail = tails[patternIndex - 1];
      if (patternIndex > 0 && previousTail === undefined) {
        throw new Error(`Type Core pattern list omitted tail ${patternIndex - 1}`);
      }
      let remainingList = list;
      if (previousTail !== undefined) remainingList = surface.name(previousTail);
      const remainingCondition = condition;
      condition = this.caseListWithBindings(remainingList, head, tail, {
        nil: () => surface.boolean(false),
        cons: (value) => this.and(this.patternCondition(pattern, value), remainingCondition),
      });
    }
    return condition;
  }

  private collectPatternBindings(
    pattern: TypeCorePattern,
    value: FunctionalSurfaceExpression,
    environment: Map<string, FunctionalSurfaceExpression>,
    projections: PatternProjection[],
  ): void {
    switch (pattern.kind) {
      case "bind": {
        const name = this.temporary("patternBinding");
        projections.push({ name, value });
        environment.set(pattern.name, surface.name(name));
        return;
      }
      case "integer":
      case "boolean":
      case "symbol":
        return;
      case "type":
        this.collectTypePatternBindings(
          pattern.type,
          this.unwrapType(value),
          environment,
          projections,
        );
        return;
    }
  }

  private collectTypePatternBindings(
    pattern: TypeCoreTypePattern,
    type: FunctionalSurfaceExpression,
    environment: Map<string, FunctionalSurfaceExpression>,
    projections: PatternProjection[],
  ): void {
    switch (pattern.kind) {
      case "integer":
      case "boolean":
      case "unit":
        return;
      case "named": {
        if (pattern.arguments.length === 0) return;
        const argumentsName = this.temporary("patternArguments");
        projections.push({
          name: argumentsName,
          value: this.caseType(type, {
            named: (_name, values) => values,
          }, this.emptyValueList()),
        });
        let remainingArguments = surface.name(argumentsName);
        for (const [argumentIndex, argumentPattern] of pattern.arguments.entries()) {
          const valueName = this.temporary("patternArgument");
          projections.push({
            name: valueName,
            value: this.caseList(remainingArguments, {
              nil: () => this.wrapType(this.unitType()),
              cons: (head) => head,
            }),
          });
          this.collectPatternBindings(
            argumentPattern,
            surface.name(valueName),
            environment,
            projections,
          );
          if (argumentIndex === pattern.arguments.length - 1) continue;
          const tailName = this.temporary("patternArgumentsTail");
          projections.push({
            name: tailName,
            value: this.caseList(remainingArguments, {
              nil: () => this.emptyValueList(),
              cons: (_head, tail) => tail,
            }),
          });
          remainingArguments = surface.name(tailName);
        }
        return;
      }
      case "tuple": {
        const first = this.caseType(type, {
          tuple: (value) => value,
        }, this.unitType());
        const second = this.caseType(type, {
          tuple: (_first, value) => value,
        }, this.unitType());
        this.collectPatternBindings(
          pattern.values[0],
          this.wrapType(first),
          environment,
          projections,
        );
        this.collectPatternBindings(
          pattern.values[1],
          this.wrapType(second),
          environment,
          projections,
        );
        return;
      }
      case "function": {
        const parameter = this.caseType(type, {
          function: (value) => value,
        }, this.unitType());
        const result = this.caseType(type, {
          function: (_parameter, value) => value,
        }, this.unitType());
        this.collectPatternBindings(
          pattern.parameter,
          this.wrapType(parameter),
          environment,
          projections,
        );
        this.collectPatternBindings(
          pattern.result,
          this.wrapType(result),
          environment,
          projections,
        );
        return;
      }
    }
  }

  private bindPatternProjections(
    projections: readonly PatternProjection[],
    body: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    let expression = body;
    for (let projectionIndex = projections.length - 1; projectionIndex >= 0; projectionIndex--) {
      const projection = projections[projectionIndex];
      if (projection === undefined) {
        throw new Error(`Type Core pattern omitted projection ${projectionIndex}`);
      }
      expression = {
        kind: "let",
        name: projection.name,
        value: projection.value,
        body: expression,
      };
    }
    return expression;
  }

  private unwrapType(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
    return this.caseCompileValue(value, {
      type: (type) => type,
    }, this.unitType());
  }

  private unwrapInteger(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
    return this.caseCompileValue(value, {
      integer: (integer) => integer,
    }, surface.integer(0));
  }

  private unwrapBoolean(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
    return this.caseCompileValue(value, {
      boolean: (boolean) => boolean,
    }, surface.boolean(false));
  }

  private unwrapSymbol(value: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
    return this.caseCompileValue(value, {
      symbol: (symbol) => symbol,
    }, surface.integer(0));
  }

  private wrapType(type: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
    return this.construct(TypeCoreRuntimeConstructor.ValueType, type);
  }

  private wrapBoolean(boolean: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
    return this.construct(TypeCoreRuntimeConstructor.ValueBoolean, boolean);
  }

  private unitType(): FunctionalSurfaceExpression {
    return this.construct(TypeCoreRuntimeConstructor.TypeUnit);
  }

  private valueList(values: readonly FunctionalSurfaceExpression[]): FunctionalSurfaceExpression {
    let list = this.emptyValueList();
    for (let valueIndex = values.length - 1; valueIndex >= 0; valueIndex--) {
      const value = values[valueIndex];
      if (value === undefined) throw new Error(`Type Core value list omitted index ${valueIndex}`);
      list = this.construct(TypeCoreRuntimeConstructor.ListCons, value, list);
    }
    return list;
  }

  private emptyValueList(): FunctionalSurfaceExpression {
    return this.construct(TypeCoreRuntimeConstructor.ListNil);
  }

  private booleanEquals(
    boolean: FunctionalSurfaceExpression,
    expected: boolean,
  ): FunctionalSurfaceExpression {
    if (expected) return boolean;
    return {
      kind: "if",
      condition: boolean,
      consequent: surface.boolean(false),
      alternate: surface.boolean(true),
    };
  }

  private and(
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    return {
      kind: "if",
      condition: left,
      consequent: right,
      alternate: surface.boolean(false),
    };
  }

  private construct(
    constructor: string,
    ...fields: readonly FunctionalSurfaceExpression[]
  ): FunctionalSurfaceExpression {
    return surface.apply(surface.name(constructor), ...fields);
  }

  private caseCompileValue(
    value: FunctionalSurfaceExpression,
    branches: CompileValueCaseBranches,
    fallback: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const type = this.temporary("valueType");
    const integer = this.temporary("valueInteger");
    const boolean = this.temporary("valueBoolean");
    const symbol = this.temporary("valueSymbol");
    return {
      kind: "case",
      value,
      arms: [
        this.caseArm(
          TypeCoreRuntimeConstructor.ValueType,
          [type],
          branches.type?.(surface.name(type)) ?? fallback,
        ),
        this.caseArm(
          TypeCoreRuntimeConstructor.ValueInteger,
          [integer],
          branches.integer?.(surface.name(integer)) ?? fallback,
        ),
        this.caseArm(
          TypeCoreRuntimeConstructor.ValueBoolean,
          [boolean],
          branches.boolean?.(surface.name(boolean)) ?? fallback,
        ),
        this.caseArm(
          TypeCoreRuntimeConstructor.ValueSymbol,
          [symbol],
          branches.symbol?.(surface.name(symbol)) ?? fallback,
        ),
      ],
    };
  }

  private caseType(
    type: FunctionalSurfaceExpression,
    branches: TypeCaseBranches,
    fallback: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const name = this.temporary("typeName");
    const arguments_ = this.temporary("typeArguments");
    const first = this.temporary("typeFirst");
    const second = this.temporary("typeSecond");
    const parameter = this.temporary("typeParameter");
    const result = this.temporary("typeResult");
    return {
      kind: "case",
      value: type,
      arms: [
        this.caseArm(TypeCoreRuntimeConstructor.TypeInteger, [], branches.integer?.() ?? fallback),
        this.caseArm(TypeCoreRuntimeConstructor.TypeBoolean, [], branches.boolean?.() ?? fallback),
        this.caseArm(TypeCoreRuntimeConstructor.TypeUnit, [], branches.unit?.() ?? fallback),
        this.caseArm(
          TypeCoreRuntimeConstructor.TypeNamed,
          [name, arguments_],
          branches.named?.(surface.name(name), surface.name(arguments_)) ?? fallback,
        ),
        this.caseArm(
          TypeCoreRuntimeConstructor.TypeTuple,
          [first, second],
          branches.tuple?.(surface.name(first), surface.name(second)) ?? fallback,
        ),
        this.caseArm(
          TypeCoreRuntimeConstructor.TypeFunction,
          [parameter, result],
          branches.function?.(surface.name(parameter), surface.name(result)) ?? fallback,
        ),
      ],
    };
  }

  private caseList(
    list: FunctionalSurfaceExpression,
    branches: ListCaseBranches,
  ): FunctionalSurfaceExpression {
    const head = this.temporary("listHead");
    const tail = this.temporary("listTail");
    return this.caseListWithBindings(list, head, tail, branches);
  }

  private caseListWithBindings(
    list: FunctionalSurfaceExpression,
    head: string,
    tail: string,
    branches: ListCaseBranches,
  ): FunctionalSurfaceExpression {
    return {
      kind: "case",
      value: list,
      arms: [
        this.caseArm(TypeCoreRuntimeConstructor.ListNil, [], branches.nil()),
        this.caseArm(
          TypeCoreRuntimeConstructor.ListCons,
          [head, tail],
          branches.cons(surface.name(head), surface.name(tail)),
        ),
      ],
    };
  }

  private caseArm(
    constructor: string,
    binders: readonly string[],
    body: FunctionalSurfaceExpression,
  ): FunctionalSurfaceCaseArm {
    return { constructor, binders, body };
  }

  private temporary(purpose: string): string {
    return `$TypeCore${purpose}${this.#temporaryIndex++}`;
  }
}

interface CompileValueCaseBranches {
  readonly type?: (type: FunctionalSurfaceExpression) => FunctionalSurfaceExpression;
  readonly integer?: (integer: FunctionalSurfaceExpression) => FunctionalSurfaceExpression;
  readonly boolean?: (boolean: FunctionalSurfaceExpression) => FunctionalSurfaceExpression;
  readonly symbol?: (symbol: FunctionalSurfaceExpression) => FunctionalSurfaceExpression;
}

interface TypeCaseBranches {
  readonly integer?: () => FunctionalSurfaceExpression;
  readonly boolean?: () => FunctionalSurfaceExpression;
  readonly unit?: () => FunctionalSurfaceExpression;
  readonly named?: (
    name: FunctionalSurfaceExpression,
    arguments_: FunctionalSurfaceExpression,
  ) => FunctionalSurfaceExpression;
  readonly tuple?: (
    first: FunctionalSurfaceExpression,
    second: FunctionalSurfaceExpression,
  ) => FunctionalSurfaceExpression;
  readonly function?: (
    parameter: FunctionalSurfaceExpression,
    result: FunctionalSurfaceExpression,
  ) => FunctionalSurfaceExpression;
}

interface ListCaseBranches {
  readonly nil: () => FunctionalSurfaceExpression;
  readonly cons: (
    head: FunctionalSurfaceExpression,
    tail: FunctionalSurfaceExpression,
  ) => FunctionalSurfaceExpression;
}

interface PatternProjection {
  readonly name: string;
  readonly value: FunctionalSurfaceExpression;
}

class CompileTimeSymbolTable {
  readonly #symbols = new Map<string, number>();
  readonly #values: string[] = [];

  get values(): readonly string[] {
    return this.#values;
  }

  intern(value: string): number {
    const existing = this.#symbols.get(value);
    if (existing !== undefined) return existing;
    const symbol = this.#values.length;
    this.#symbols.set(value, symbol);
    this.#values.push(value);
    return symbol;
  }
}

function requiredFunctionName(names: ReadonlyMap<string, string>, name: string): string {
  const encoded = names.get(name);
  if (encoded === undefined) {
    throw new Error(`validated Type Core program omitted function ${JSON.stringify(name)}`);
  }
  return encoded;
}
