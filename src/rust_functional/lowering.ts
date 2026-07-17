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
  RustFunctionalDeclaration,
  RustFunctionalExpression,
  RustFunctionalPattern,
  RustFunctionalProgram,
  RustFunctionalType,
} from "./ast.ts";
import { RustFunctionalLoweringError } from "./diagnostic.ts";

export interface LoweredRustFunctionalProgram {
  readonly program: RustFunctionalProgram;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly module: EncodedFunctionalModule;
}

interface ConstructorShape {
  readonly name: string;
  readonly fields: readonly string[];
  readonly span: FunctionalSpan;
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

export function lowerRustFunctionalProgram(
  program: RustFunctionalProgram,
): LoweredRustFunctionalProgram {
  const lowering = new RustFunctionalLowering(program);
  return lowering.lower();
}

class RustFunctionalLowering {
  readonly #constructors = new Map<string, ConstructorShape>();
  readonly #declarationNames = new Map<string, FunctionalSpan>();
  #wildcardIndex = 0;

  constructor(private readonly program: RustFunctionalProgram) {}

  lower(): LoweredRustFunctionalProgram {
    this.indexDeclarations();
    const typeDeclarations = this.program.declarations.flatMap((declaration) =>
      declaration.kind === "function" ? [] : [this.lowerTypeDeclaration(declaration)]
    );
    const definitions = this.program.declarations.flatMap((declaration) =>
      declaration.kind === "function" ? [this.lowerDefinition(declaration)] : []
    );
    const entry = definitions.find((definition) => definition.name === "gpu_main");
    if (entry === undefined) {
      throw new RustFunctionalLoweringError(
        this.program.span,
        "Rust functional source must declare fn gpu_main() as its GPU entry.",
      );
    }
    if (entry.parameters.length !== 0) {
      throw new RustFunctionalLoweringError(
        entry.span ?? this.program.span,
        `Rust functional entry gpu_main has ${entry.parameters.length} parameters; expected none.`,
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
    for (const declaration of this.program.declarations) {
      this.requireUniqueDeclaration(declaration);
      if (declaration.kind === "function") {
        requireUniqueNames(
          declaration.typeParameters,
          declaration.span,
          `function ${JSON.stringify(declaration.name)} type parameters`,
        );
        requireUniqueNames(
          declaration.parameters.map((parameter) => parameter.name),
          declaration.span,
          `function ${JSON.stringify(declaration.name)} parameters`,
        );
        continue;
      }
      requireUniqueNames(
        declaration.parameters,
        declaration.span,
        `${declaration.kind} ${JSON.stringify(declaration.name)} type parameters`,
      );
      if (declaration.kind === "enum") {
        requireUniqueNames(
          declaration.variants.map((variant) => variant.name),
          declaration.span,
          `enum ${JSON.stringify(declaration.name)} variants`,
        );
        for (const variant of declaration.variants) {
          this.addConstructor({
            name: variant.name,
            fields: variant.fields.map((_, index) => `$${index}`),
            span: variant.span,
          });
        }
        continue;
      }
      requireUniqueNames(
        declaration.fields.map((field) => field.name),
        declaration.span,
        `struct ${JSON.stringify(declaration.name)} fields`,
      );
      this.addConstructor({
        name: declaration.name,
        fields: declaration.fields.map((field) => field.name),
        span: declaration.span,
      });
    }
  }

  private requireUniqueDeclaration(declaration: RustFunctionalDeclaration): void {
    const existing = this.#declarationNames.get(declaration.name);
    if (existing !== undefined) {
      throw new RustFunctionalLoweringError(
        declaration.span,
        `Rust functional source repeats declaration ${JSON.stringify(declaration.name)}; ` +
          `the first declaration starts at byte ${existing.startByte}.`,
      );
    }
    this.#declarationNames.set(declaration.name, declaration.span);
  }

  private addConstructor(constructor: ConstructorShape): void {
    const existing = this.#constructors.get(constructor.name);
    if (existing !== undefined) {
      throw new RustFunctionalLoweringError(
        constructor.span,
        `Rust constructors repeat ${JSON.stringify(constructor.name)}; ` +
          `the first declaration starts at byte ${existing.span.startByte}.`,
      );
    }
    this.#constructors.set(constructor.name, constructor);
  }

  private lowerTypeDeclaration(
    declaration: Exclude<RustFunctionalDeclaration, { readonly kind: "function" }>,
  ): FunctionalSurfaceTypeDeclaration {
    if (declaration.kind === "enum") {
      return {
        name: declaration.name,
        parameters: declaration.parameters,
        span: declaration.span,
        constructors: declaration.variants.map((variant) => ({
          name: variant.name,
          span: variant.span,
          fields: variant.fields.map((type, index) => ({
            name: `$${index}`,
            type: lowerType(type),
            span: type.span,
          })),
        })),
      };
    }
    return {
      name: declaration.name,
      parameters: declaration.parameters,
      span: declaration.span,
      constructors: [{
        name: declaration.name,
        span: declaration.span,
        fields: declaration.fields.map((field) => ({
          name: field.name,
          type: lowerType(field.type),
          span: field.span,
        })),
      }],
    };
  }

  private lowerDefinition(
    declaration: Extract<RustFunctionalDeclaration, { readonly kind: "function" }>,
  ): FunctionalSurfaceDefinition {
    let annotation = lowerType(declaration.result);
    for (let index = declaration.parameters.length - 1; index >= 0; index--) {
      const parameter = declaration.parameters[index];
      if (parameter === undefined) throw new Error(`Function omitted parameter ${index}.`);
      annotation = {
        kind: "function",
        parameter: lowerType(parameter.type),
        result: annotation,
      };
    }
    return {
      name: declaration.name,
      parameters: declaration.parameters.map((parameter) => parameter.name),
      annotation,
      body: this.lowerExpression(declaration.body),
      span: declaration.span,
    };
  }

  private lowerExpression(expression: RustFunctionalExpression): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "integer":
      case "boolean":
        return expression;
      case "unit":
        return { kind: "name", name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, span: expression.span };
      case "tuple":
        return apply(
          { kind: "name", name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, span: expression.span },
          expression.values.map((value) => this.lowerExpression(value)),
          expression.span,
        );
      case "name":
        return expression;
      case "call":
        return apply(
          this.lowerExpression(expression.callee),
          expression.arguments.map((argument) => this.lowerExpression(argument)),
          expression.span,
        );
      case "record":
        return this.lowerRecordExpression(expression);
      case "let":
        return {
          kind: "let",
          name: expression.name,
          value: this.lowerExpression(expression.value),
          body: this.lowerExpression(expression.body),
          span: expression.span,
        };
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
          throw new Error(`Rust lowering omitted binary operator ${expression.operator}.`);
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

  private lowerRecordExpression(
    expression: Extract<RustFunctionalExpression, { readonly kind: "record" }>,
  ): FunctionalSurfaceExpression {
    const constructor = this.requireConstructor(expression.constructor, expression.span);
    const supplied = new Map<string, RustFunctionalExpression>();
    for (const field of expression.fields) {
      if (supplied.has(field.name)) {
        throw new RustFunctionalLoweringError(
          field.span,
          `Record ${JSON.stringify(expression.constructor)} repeats field ${
            JSON.stringify(field.name)
          }.`,
        );
      }
      supplied.set(field.name, field.value);
    }
    const arguments_ = constructor.fields.map((name) => {
      const value = supplied.get(name);
      if (value === undefined) {
        throw new RustFunctionalLoweringError(
          expression.span,
          `Record ${JSON.stringify(expression.constructor)} is missing field ${
            JSON.stringify(name)
          }.`,
        );
      }
      supplied.delete(name);
      return this.lowerExpression(value);
    });
    this.rejectUnknownField(expression.constructor, supplied, expression.span);
    return apply(
      { kind: "name", name: expression.constructor, span: expression.span },
      arguments_,
      expression.span,
    );
  }

  private lowerPattern(pattern: RustFunctionalPattern): {
    readonly constructor: string;
    readonly binders: readonly string[];
  } {
    if (pattern.kind === "tuple") {
      const binders = pattern.binders.map((binder) => this.binderName(binder.name));
      requireUniqueNames(binders, pattern.span, "tuple pattern bindings");
      return { constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, binders };
    }
    const constructor = this.requireConstructor(pattern.constructor, pattern.span);
    if (pattern.kind === "constructor") {
      if (pattern.binders.length !== constructor.fields.length) {
        throw new RustFunctionalLoweringError(
          pattern.span,
          `Pattern ${
            JSON.stringify(pattern.constructor)
          } binds ${pattern.binders.length} fields; ` +
            `the constructor has ${constructor.fields.length}.`,
        );
      }
      const binders = pattern.binders.map((binder) => this.binderName(binder.name));
      requireUniqueNames(
        binders,
        pattern.span,
        `pattern ${JSON.stringify(pattern.constructor)} bindings`,
      );
      return { constructor: pattern.constructor, binders };
    }

    const supplied = new Map<string, string>();
    for (const field of pattern.fields) {
      if (supplied.has(field.name)) {
        throw new RustFunctionalLoweringError(
          field.span,
          `Pattern ${JSON.stringify(pattern.constructor)} repeats field ${
            JSON.stringify(field.name)
          }.`,
        );
      }
      supplied.set(field.name, this.binderName(field.binder.name));
    }
    const binders = constructor.fields.map((name) => {
      const binder = supplied.get(name);
      if (binder === undefined) {
        throw new RustFunctionalLoweringError(
          pattern.span,
          `Pattern ${JSON.stringify(pattern.constructor)} is missing field ${
            JSON.stringify(name)
          }.`,
        );
      }
      supplied.delete(name);
      return binder;
    });
    this.rejectUnknownField(pattern.constructor, supplied, pattern.span);
    requireUniqueNames(
      binders,
      pattern.span,
      `pattern ${JSON.stringify(pattern.constructor)} bindings`,
    );
    return { constructor: pattern.constructor, binders };
  }

  private requireConstructor(name: string, span: FunctionalSpan): ConstructorShape {
    const constructor = this.#constructors.get(name);
    if (constructor === undefined) {
      throw new RustFunctionalLoweringError(
        span,
        `Unknown Rust constructor ${JSON.stringify(name)}.`,
      );
    }
    return constructor;
  }

  private rejectUnknownField(
    constructor: string,
    fields: ReadonlyMap<string, unknown>,
    span: FunctionalSpan,
  ): void {
    const unknown = fields.keys().next().value;
    if (typeof unknown !== "string") return;
    throw new RustFunctionalLoweringError(
      span,
      `Record ${JSON.stringify(constructor)} has unknown field ${JSON.stringify(unknown)}.`,
    );
  }

  private binderName(name: string | null): string {
    if (name !== null) return name;
    return `$rust$wildcard${this.#wildcardIndex++}`;
  }
}

function lowerType(type: RustFunctionalType): FunctionalTypeSchema {
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
        name: type.name,
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
      throw new RustFunctionalLoweringError(
        span,
        `${location} repeat ${JSON.stringify(name)}.`,
      );
    }
    seen.add(name);
  }
}
