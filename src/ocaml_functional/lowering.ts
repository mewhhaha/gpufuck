import {
  type EncodedFunctionalModule,
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
  OcamlFunctionalDefinition,
  OcamlFunctionalExpression,
  OcamlFunctionalPattern,
  OcamlFunctionalPatternBinder,
  OcamlFunctionalProgram,
  OcamlFunctionalType,
  OcamlFunctionalTypeDeclaration,
} from "./ast.ts";
import { OcamlFunctionalLoweringError } from "./diagnostic.ts";

export interface LoweredOcamlFunctionalProgram {
  readonly program: OcamlFunctionalProgram;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly module: EncodedFunctionalModule;
}

interface ConstructorShape {
  readonly fields: number;
  readonly span: FunctionalSpan;
}

const OCAML_LIST_TYPE = "$OcamlList";
const OCAML_LIST_NIL = "$OcamlNil";
const OCAML_LIST_CONS = "$OcamlCons";

const binaryOperators: Readonly<Record<string, FunctionalBinaryOperator>> = {
  "=": FunctionalBinaryOperator.Equal,
  "<>": FunctionalBinaryOperator.NotEqual,
  "<": FunctionalBinaryOperator.Less,
  "<=": FunctionalBinaryOperator.LessEqual,
  ">": FunctionalBinaryOperator.Greater,
  ">=": FunctionalBinaryOperator.GreaterEqual,
  "+": FunctionalBinaryOperator.Add,
  "-": FunctionalBinaryOperator.Subtract,
  "*": FunctionalBinaryOperator.Multiply,
  "/": FunctionalBinaryOperator.Divide,
};

export function lowerOcamlFunctionalProgram(
  program: OcamlFunctionalProgram,
): LoweredOcamlFunctionalProgram {
  return new OcamlFunctionalLowering(program).lower();
}

class OcamlFunctionalLowering {
  readonly #constructors = new Map<string, ConstructorShape>();
  readonly #declarationNames = new Map<string, FunctionalSpan>();
  readonly #typeNames = new Map<string, FunctionalSpan>();
  readonly #typeArities = new Map<string, number>();
  #wildcardIndex = 0;

  constructor(private readonly program: OcamlFunctionalProgram) {}

  lower(): LoweredOcamlFunctionalProgram {
    this.indexDeclarations();
    this.validateSourceOrder();
    const typeDeclarations = [
      ...this.program.declarations.flatMap((declaration) =>
        declaration.kind === "type" ? [this.lowerTypeDeclaration(declaration)] : []
      ),
      ocamlListDeclaration(this.program.span.endByte),
    ];
    const definitions = this.program.declarations.flatMap((declaration) =>
      declaration.kind === "definition" ? [this.lowerDefinition(declaration)] : []
    );
    const entry = definitions.find((definition) => definition.name === "gpu_main");
    if (entry === undefined) {
      throw new OcamlFunctionalLoweringError(
        this.program.span,
        "OCaml functional source must declare let gpu_main as its GPU entry.",
      );
    }
    if (entry.parameters.length !== 0) {
      throw new OcamlFunctionalLoweringError(
        entry.span ?? this.program.span,
        `OCaml functional entry gpu_main has ${entry.parameters.length} parameters; expected none.`,
      );
    }
    return {
      program: this.program,
      definitions,
      typeDeclarations,
      module: buildFunctionalSurfaceModule(
        definitions,
        typeDeclarations,
        "gpu_main",
        this.program.span.endByte,
        { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
      ),
    };
  }

  private indexDeclarations(): void {
    const implicitSpan = {
      startByte: this.program.span.endByte,
      endByte: this.program.span.endByte,
    };
    this.#typeNames.set("list", implicitSpan);
    this.#typeArities.set("list", 1);
    this.#constructors.set(OCAML_LIST_NIL, { fields: 0, span: implicitSpan });
    this.#constructors.set(OCAML_LIST_CONS, { fields: 2, span: implicitSpan });
    for (const declaration of this.program.declarations) {
      if (declaration.kind === "definition") {
        this.indexDefinition(declaration);
        continue;
      }
      this.indexTypeDeclaration(declaration);
    }
  }

  private indexDefinition(declaration: OcamlFunctionalDefinition): void {
    const existing = this.#declarationNames.get(declaration.name);
    if (existing !== undefined) {
      throw new OcamlFunctionalLoweringError(
        declaration.span,
        `OCaml source repeats value ${JSON.stringify(declaration.name)}; ` +
          `the first declaration starts at byte ${existing.startByte}.`,
      );
    }
    requireUniqueNames(
      declaration.parameters,
      declaration.span,
      `definition ${JSON.stringify(declaration.name)} parameters`,
    );
    if (declaration.recursive && declaration.parameters.length === 0) {
      throw new OcamlFunctionalLoweringError(
        declaration.span,
        `Recursive OCaml definition ${JSON.stringify(declaration.name)} requires a parameter.`,
      );
    }
    this.#declarationNames.set(declaration.name, declaration.span);
  }

  private indexTypeDeclaration(declaration: OcamlFunctionalTypeDeclaration): void {
    const existing = this.#typeNames.get(declaration.name);
    if (existing !== undefined) {
      throw new OcamlFunctionalLoweringError(
        declaration.span,
        `OCaml source repeats type ${JSON.stringify(declaration.name)}; ` +
          `the first declaration starts at byte ${existing.startByte}.`,
      );
    }
    requireUniqueNames(
      declaration.parameters,
      declaration.span,
      `type ${JSON.stringify(declaration.name)} parameters`,
    );
    this.#typeNames.set(declaration.name, declaration.span);
    this.#typeArities.set(declaration.name, declaration.parameters.length);
    const parameters = new Set(declaration.parameters);
    for (const constructor of declaration.constructors) {
      const priorConstructor = this.#constructors.get(constructor.name);
      if (priorConstructor !== undefined) {
        throw new OcamlFunctionalLoweringError(
          constructor.span,
          `OCaml source repeats constructor ${JSON.stringify(constructor.name)}; ` +
            `the first declaration starts at byte ${priorConstructor.span.startByte}.`,
        );
      }
      for (const field of constructor.fields) {
        requireDeclaredTypeParameters(field, parameters, declaration.name);
      }
      this.#constructors.set(constructor.name, {
        fields: constructor.fields.length,
        span: constructor.span,
      });
    }
  }

  private validateSourceOrder(): void {
    const available = new Set<string>();
    const availableTypes = new Set(["list"]);
    for (const declaration of this.program.declarations) {
      if (declaration.kind === "type") {
        const fieldTypes = new Set(availableTypes);
        fieldTypes.add(declaration.name);
        for (const constructor of declaration.constructors) {
          for (const field of constructor.fields) {
            validateTypeNames(field, fieldTypes, this.#typeArities);
          }
        }
        availableTypes.add(declaration.name);
        for (const constructor of declaration.constructors) available.add(constructor.name);
        continue;
      }
      const lexical = new Set(declaration.parameters);
      const globals = new Set(available);
      if (declaration.recursive) globals.add(declaration.name);
      validateExpressionNames(declaration.body, lexical, globals);
      available.add(declaration.name);
    }
  }

  private lowerTypeDeclaration(
    declaration: OcamlFunctionalTypeDeclaration,
  ): FunctionalSurfaceTypeDeclaration {
    return {
      name: declaration.name,
      parameters: declaration.parameters,
      span: declaration.span,
      constructors: declaration.constructors.map((constructor) => ({
        name: constructor.name,
        span: constructor.span,
        fields: constructor.fields.map((field, fieldIndex) => ({
          name: `$${fieldIndex}`,
          type: lowerType(field),
          span: field.span,
        })),
      })),
    };
  }

  private lowerDefinition(declaration: OcamlFunctionalDefinition): FunctionalSurfaceDefinition {
    return {
      name: declaration.name,
      parameters: declaration.parameters,
      annotation: null,
      body: this.lowerExpression(declaration.body),
      span: declaration.span,
    };
  }

  private lowerExpression(expression: OcamlFunctionalExpression): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "integer":
      case "boolean":
      case "name":
        return expression;
      case "unit":
        return { kind: "name", name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, span: expression.span };
      case "tuple":
        return apply(
          { kind: "name", name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, span: expression.span },
          expression.values.map((value) => this.lowerExpression(value)),
          expression.span,
        );
      case "list": {
        let list: FunctionalSurfaceExpression = {
          kind: "name",
          name: OCAML_LIST_NIL,
          span: expression.span,
        };
        for (let valueIndex = expression.values.length - 1; valueIndex >= 0; valueIndex--) {
          const value = expression.values[valueIndex];
          if (value === undefined) throw new Error(`OCaml list omitted value ${valueIndex}.`);
          list = apply(
            { kind: "name", name: OCAML_LIST_CONS, span: expression.span },
            [this.lowerExpression(value), list],
            expression.span,
          );
        }
        return list;
      }
      case "list-cons":
        return apply(
          { kind: "name", name: OCAML_LIST_CONS, span: expression.span },
          [this.lowerExpression(expression.head), this.lowerExpression(expression.tail)],
          expression.span,
        );
      case "lambda": {
        let body = this.lowerExpression(expression.body);
        for (
          let parameterIndex = expression.parameters.length - 1;
          parameterIndex >= 0;
          parameterIndex--
        ) {
          const parameter = expression.parameters[parameterIndex];
          if (parameter === undefined) {
            throw new Error(`OCaml lambda omitted parameter ${parameterIndex}.`);
          }
          body = { kind: "lambda", parameter, body, span: expression.span };
        }
        return body;
      }
      case "apply":
        return this.lowerApplication(expression);
      case "let": {
        let value = this.lowerExpression(expression.value);
        for (
          let parameterIndex = expression.parameters.length - 1;
          parameterIndex >= 0;
          parameterIndex--
        ) {
          const parameter = expression.parameters[parameterIndex];
          if (parameter === undefined) {
            throw new Error(`OCaml local function omitted parameter ${parameterIndex}.`);
          }
          value = { kind: "lambda", parameter, body: value, span: expression.span };
        }
        const body = this.lowerExpression(expression.body);
        return expression.recursive
          ? { kind: "let-rec", name: expression.name, value, body, span: expression.span }
          : { kind: "let", name: expression.name, value, body, span: expression.span };
      }
      case "if":
        return {
          kind: "if",
          condition: this.lowerExpression(expression.condition),
          consequent: this.lowerExpression(expression.consequent),
          alternate: this.lowerExpression(expression.alternate),
          span: expression.span,
        };
      case "binary": {
        const operator = binaryOperators[expression.operator];
        if (operator === undefined) {
          throw new Error(`OCaml lowering omitted binary operator ${expression.operator}.`);
        }
        return {
          kind: "binary",
          operator,
          left: this.lowerExpression(expression.left),
          right: this.lowerExpression(expression.right),
          span: expression.span,
        };
      }
      case "match":
        return {
          kind: "case",
          value: this.lowerExpression(expression.value),
          arms: expression.arms.map((arm) => {
            const pattern = this.lowerPattern(arm.pattern);
            return {
              constructor: pattern.constructor,
              binders: pattern.binders,
              body: this.lowerExpression(arm.body),
              span: arm.span,
            };
          }),
          span: expression.span,
        };
    }
  }

  private lowerApplication(
    expression: Extract<OcamlFunctionalExpression, { readonly kind: "apply" }>,
  ): FunctionalSurfaceExpression {
    if (
      expression.callee.kind === "name" && expression.argument.kind === "tuple" &&
      this.#constructors.get(expression.callee.name)?.fields === 2
    ) {
      return apply(
        this.lowerExpression(expression.callee),
        expression.argument.values.map((value) => this.lowerExpression(value)),
        expression.span,
      );
    }
    return {
      kind: "apply",
      callee: this.lowerExpression(expression.callee),
      argument: this.lowerExpression(expression.argument),
      span: expression.span,
    };
  }

  private lowerPattern(pattern: OcamlFunctionalPattern): {
    readonly constructor: string;
    readonly binders: readonly string[];
  } {
    if (pattern.kind === "list-nil") return { constructor: OCAML_LIST_NIL, binders: [] };
    if (pattern.kind === "list-cons") {
      const binders = [this.binderName(pattern.head), this.binderName(pattern.tail)];
      requireUniqueNames(binders, pattern.span, "list pattern variables");
      return { constructor: OCAML_LIST_CONS, binders };
    }
    if (pattern.kind === "tuple") {
      const binders = pattern.binders.map((binder) => this.binderName(binder));
      requireUniqueNames(binders, pattern.span, "tuple pattern variables");
      return { constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, binders };
    }
    const constructor = this.#constructors.get(pattern.constructor);
    if (constructor === undefined) {
      throw new OcamlFunctionalLoweringError(
        pattern.span,
        `Unknown OCaml constructor ${JSON.stringify(pattern.constructor)}.`,
      );
    }
    if (pattern.binders.length !== constructor.fields) {
      throw new OcamlFunctionalLoweringError(
        pattern.span,
        `Pattern ${JSON.stringify(pattern.constructor)} binds ${pattern.binders.length} fields; ` +
          `the constructor has ${constructor.fields}.`,
      );
    }
    const binders = pattern.binders.map((binder) => this.binderName(binder));
    requireUniqueNames(
      binders,
      pattern.span,
      `pattern ${JSON.stringify(pattern.constructor)} variables`,
    );
    return { constructor: pattern.constructor, binders };
  }

  private binderName(binder: OcamlFunctionalPatternBinder): string {
    if (binder.name !== null) return binder.name;
    return `$ocaml$wildcard${this.#wildcardIndex++}`;
  }
}

function validateExpressionNames(
  expression: OcamlFunctionalExpression,
  lexicalNames: ReadonlySet<string>,
  globalNames: ReadonlySet<string>,
): void {
  switch (expression.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return;
    case "list":
      for (const value of expression.values) {
        validateExpressionNames(value, lexicalNames, globalNames);
      }
      return;
    case "name":
      if (lexicalNames.has(expression.name) || globalNames.has(expression.name)) return;
      throw new OcamlFunctionalLoweringError(
        expression.span,
        `OCaml value ${JSON.stringify(expression.name)} is not in sequential scope.`,
      );
    case "tuple":
      validateExpressionNames(expression.values[0], lexicalNames, globalNames);
      validateExpressionNames(expression.values[1], lexicalNames, globalNames);
      return;
    case "list-cons":
      validateExpressionNames(expression.head, lexicalNames, globalNames);
      validateExpressionNames(expression.tail, lexicalNames, globalNames);
      return;
    case "lambda": {
      const nested = new Set(lexicalNames);
      for (const parameter of expression.parameters) nested.add(parameter);
      validateExpressionNames(expression.body, nested, globalNames);
      return;
    }
    case "apply":
      validateExpressionNames(expression.callee, lexicalNames, globalNames);
      validateExpressionNames(expression.argument, lexicalNames, globalNames);
      return;
    case "let": {
      const valueNames = new Set(lexicalNames);
      if (expression.recursive) valueNames.add(expression.name);
      for (const parameter of expression.parameters) valueNames.add(parameter);
      validateExpressionNames(expression.value, valueNames, globalNames);
      const bodyNames = new Set(lexicalNames);
      bodyNames.add(expression.name);
      validateExpressionNames(expression.body, bodyNames, globalNames);
      return;
    }
    case "if":
      validateExpressionNames(expression.condition, lexicalNames, globalNames);
      validateExpressionNames(expression.consequent, lexicalNames, globalNames);
      validateExpressionNames(expression.alternate, lexicalNames, globalNames);
      return;
    case "binary":
      validateExpressionNames(expression.left, lexicalNames, globalNames);
      validateExpressionNames(expression.right, lexicalNames, globalNames);
      return;
    case "match":
      validateExpressionNames(expression.value, lexicalNames, globalNames);
      for (const arm of expression.arms) {
        validatePatternConstructor(arm.pattern, globalNames);
        const armNames = new Set(lexicalNames);
        for (const name of patternNames(arm.pattern)) armNames.add(name);
        validateExpressionNames(arm.body, armNames, globalNames);
      }
      return;
  }
}

function validateTypeNames(
  type: OcamlFunctionalType,
  availableTypes: ReadonlySet<string>,
  typeArities: ReadonlyMap<string, number>,
): void {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
    case "parameter":
      return;
    case "tuple":
      validateTypeNames(type.values[0], availableTypes, typeArities);
      validateTypeNames(type.values[1], availableTypes, typeArities);
      return;
    case "function":
      validateTypeNames(type.parameter, availableTypes, typeArities);
      validateTypeNames(type.result, availableTypes, typeArities);
      return;
    case "named": {
      if (!availableTypes.has(type.name)) {
        throw new OcamlFunctionalLoweringError(
          type.span,
          `OCaml type ${JSON.stringify(type.name)} is not in sequential scope.`,
        );
      }
      const arity = typeArities.get(type.name);
      if (arity === undefined) {
        throw new Error(`OCaml lowering omitted arity for type ${JSON.stringify(type.name)}.`);
      }
      if (type.arguments.length !== arity) {
        throw new OcamlFunctionalLoweringError(
          type.span,
          `OCaml type ${
            JSON.stringify(type.name)
          } receives ${type.arguments.length} arguments; expected ${arity}.`,
        );
      }
      for (const argument of type.arguments) {
        validateTypeNames(argument, availableTypes, typeArities);
      }
      return;
    }
  }
}

function validatePatternConstructor(
  pattern: OcamlFunctionalPattern,
  globalNames: ReadonlySet<string>,
): void {
  if (pattern.kind !== "constructor" || globalNames.has(pattern.constructor)) return;
  throw new OcamlFunctionalLoweringError(
    pattern.span,
    `OCaml constructor ${JSON.stringify(pattern.constructor)} is not in sequential scope.`,
  );
}

function patternNames(pattern: OcamlFunctionalPattern): readonly string[] {
  switch (pattern.kind) {
    case "list-nil":
      return [];
    case "list-cons":
      return [pattern.head.name, pattern.tail.name].filter((name): name is string => name !== null);
    case "tuple":
    case "constructor":
      return pattern.binders.flatMap((binder) => binder.name === null ? [] : [binder.name]);
  }
}

function lowerType(type: OcamlFunctionalType): FunctionalTypeSchema {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return { kind: type.kind };
    case "parameter":
      return { kind: "parameter", name: type.name };
    case "tuple":
      return { kind: "tuple", values: [lowerType(type.values[0]), lowerType(type.values[1])] };
    case "named":
      return {
        kind: "named",
        name: type.name === "list" ? OCAML_LIST_TYPE : type.name,
        arguments: type.arguments.map(lowerType),
      };
    case "function":
      return {
        kind: "function",
        parameter: lowerType(type.parameter),
        result: lowerType(type.result),
      };
  }
}

function requireDeclaredTypeParameters(
  type: OcamlFunctionalType,
  parameters: ReadonlySet<string>,
  declarationName: string,
): void {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return;
    case "parameter":
      if (parameters.has(type.name)) return;
      throw new OcamlFunctionalLoweringError(
        type.span,
        `Type ${JSON.stringify(declarationName)} uses undeclared parameter ${
          JSON.stringify(type.name)
        }.`,
      );
    case "tuple":
      requireDeclaredTypeParameters(type.values[0], parameters, declarationName);
      requireDeclaredTypeParameters(type.values[1], parameters, declarationName);
      return;
    case "named":
      for (const argument of type.arguments) {
        requireDeclaredTypeParameters(argument, parameters, declarationName);
      }
      return;
    case "function":
      requireDeclaredTypeParameters(type.parameter, parameters, declarationName);
      requireDeclaredTypeParameters(type.result, parameters, declarationName);
      return;
  }
}

function ocamlListDeclaration(sourceByteLength: number): FunctionalSurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: OCAML_LIST_TYPE,
    parameters: ["value"],
    span,
    constructors: [
      { name: OCAML_LIST_NIL, fields: [], span },
      {
        name: OCAML_LIST_CONS,
        span,
        fields: [
          { name: "head", type: { kind: "parameter", name: "value" }, span },
          {
            name: "tail",
            type: {
              kind: "named",
              name: OCAML_LIST_TYPE,
              arguments: [{ kind: "parameter", name: "value" }],
            },
            span,
          },
        ],
      },
    ],
  };
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

function requireUniqueNames(
  names: readonly string[],
  span: FunctionalSpan,
  location: string,
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new OcamlFunctionalLoweringError(
        span,
        `${location} repeat ${JSON.stringify(name)}.`,
      );
    }
    seen.add(name);
  }
}
