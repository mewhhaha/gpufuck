import {
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  type FunctionalSpan,
  type FunctionalTypeSchema,
} from "../functional/abi.ts";
import {
  createFunctionalModuleArtifact,
  type FunctionalModuleArtifact,
} from "../functional/module_linker.ts";
import type {
  FunctionalSurfaceCaseArm,
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "../functional/surface_builder.ts";
import type {
  GleamFunctionalExpression,
  GleamFunctionalFunction,
  GleamFunctionalModule,
  GleamFunctionalPattern,
  GleamFunctionalType,
  GleamFunctionalTypeDeclaration,
} from "./ast.ts";
import { GleamFunctionalLoweringError } from "./diagnostic.ts";

export interface GleamFunctionalExportSignature {
  readonly module: string;
  readonly name: string;
  readonly type: FunctionalTypeSchema;
}

export interface LoweredGleamFunctionalModule {
  readonly source: GleamFunctionalModule;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly artifact: FunctionalModuleArtifact;
}

interface ConstructorShape {
  readonly owner: string;
  readonly fields: number;
  readonly span: FunctionalSpan;
}

const GLEAM_LIST_TYPE = "$GleamList";
const GLEAM_LIST_NIL = "$GleamNil";
const GLEAM_LIST_CONS = "$GleamCons";
const TUPLE_OWNER = "$TupleType";

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

export function gleamFunctionalExportSignatures(
  module: GleamFunctionalModule,
): readonly GleamFunctionalExportSignature[] {
  return module.declarations.flatMap((declaration) => {
    if (declaration.kind !== "function" || !declaration.public) return [];
    return [{
      module: module.name,
      name: declaration.name,
      type: declaredFunctionType(module.name, declaration),
    }];
  });
}

export function lowerGleamFunctionalModule(
  module: GleamFunctionalModule,
  availableExports: readonly GleamFunctionalExportSignature[],
): LoweredGleamFunctionalModule {
  return new GleamFunctionalLowering(module, availableExports).lower();
}

class GleamFunctionalLowering {
  readonly #constructors = new Map<string, ConstructorShape>();
  readonly #constructorsByOwner = new Map<string, readonly string[]>();
  readonly #declarations = new Map<string, FunctionalSpan>();
  readonly #typeArities = new Map<string, number>();
  readonly #qualifiedImports = new Map<string, string>();
  #discardIndex = 0;

  constructor(
    private readonly module: GleamFunctionalModule,
    private readonly availableExports: readonly GleamFunctionalExportSignature[],
  ) {}

  lower(): LoweredGleamFunctionalModule {
    this.indexImplicitDeclarations();
    this.indexDeclarations();
    const imports = this.lowerImports();
    const typeDeclarations = [
      ...this.module.declarations.flatMap((declaration) =>
        declaration.kind === "type" ? [this.lowerTypeDeclaration(declaration)] : []
      ),
      gleamListDeclaration(this.module.span.endByte),
    ];
    const definitions = this.module.declarations.flatMap((declaration) =>
      declaration.kind === "function" ? [this.lowerFunction(declaration)] : []
    );
    const exports = this.module.declarations.flatMap((declaration) => {
      if (declaration.kind !== "function" || !declaration.public) return [];
      return [{
        name: declaration.name,
        definition: declaration.name,
        type: declaredFunctionType(this.module.name, declaration),
      }];
    });
    const artifact = createFunctionalModuleArtifact({
      name: this.module.name,
      definitions,
      typeDeclarations,
      imports,
      exports,
      sourceByteLength: this.module.span.endByte,
      options: { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
    });
    return { source: this.module, definitions, typeDeclarations, artifact };
  }

  private indexImplicitDeclarations(): void {
    const span = { startByte: this.module.span.endByte, endByte: this.module.span.endByte };
    this.#typeArities.set("List", 1);
    this.#constructors.set(GLEAM_LIST_NIL, { owner: GLEAM_LIST_TYPE, fields: 0, span });
    this.#constructors.set(GLEAM_LIST_CONS, { owner: GLEAM_LIST_TYPE, fields: 2, span });
    this.#constructorsByOwner.set(GLEAM_LIST_TYPE, [GLEAM_LIST_NIL, GLEAM_LIST_CONS]);
    this.#constructors.set(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, {
      owner: TUPLE_OWNER,
      fields: 2,
      span,
    });
    this.#constructorsByOwner.set(TUPLE_OWNER, [FUNCTIONAL_PAIR_CONSTRUCTOR_NAME]);
    this.#constructors.set(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, {
      owner: "$UnitType",
      fields: 0,
      span,
    });
    this.#constructorsByOwner.set("$UnitType", [FUNCTIONAL_UNIT_CONSTRUCTOR_NAME]);
  }

  private indexDeclarations(): void {
    for (const declaration of this.module.declarations) {
      const existing = this.#declarations.get(declaration.name);
      if (existing !== undefined) {
        throw new GleamFunctionalLoweringError(
          declaration.span,
          `Gleam module ${JSON.stringify(this.module.name)} repeats declaration ${
            JSON.stringify(declaration.name)
          }; the first declaration starts at byte ${existing.startByte}.`,
        );
      }
      this.#declarations.set(declaration.name, declaration.span);
      if (declaration.kind === "function") {
        requireUniqueNames(
          declaration.parameters.map((parameter) => parameter.name),
          declaration.span,
          `function ${JSON.stringify(declaration.name)} parameters`,
        );
        continue;
      }
      this.indexTypeDeclaration(declaration);
    }
  }

  private indexTypeDeclaration(declaration: GleamFunctionalTypeDeclaration): void {
    requireUniqueNames(
      declaration.parameters,
      declaration.span,
      `type ${JSON.stringify(declaration.name)} parameters`,
    );
    this.#typeArities.set(declaration.name, declaration.parameters.length);
    const constructorNames: string[] = [];
    for (const constructor of declaration.constructors) {
      const existing = this.#constructors.get(constructor.name);
      if (existing !== undefined) {
        throw new GleamFunctionalLoweringError(
          constructor.span,
          `Gleam constructor ${
            JSON.stringify(constructor.name)
          } was already declared at byte ${existing.span.startByte}.`,
        );
      }
      requireUniqueNames(
        constructor.fields.flatMap((field) => field.label === null ? [] : [field.label]),
        constructor.span,
        `constructor ${JSON.stringify(constructor.name)} field labels`,
      );
      this.#constructors.set(constructor.name, {
        owner: declaration.name,
        fields: constructor.fields.length,
        span: constructor.span,
      });
      constructorNames.push(constructor.name);
    }
    this.#constructorsByOwner.set(declaration.name, constructorNames);
  }

  private lowerImports(): FunctionalModuleArtifact["imports"] {
    const imports: FunctionalModuleArtifact["imports"][number][] = [];
    const localNames = new Set(this.#declarations.keys());
    for (const declaration of this.module.imports) {
      if (declaration.names.length === 0) {
        const exportedFunctions = this.availableExports.filter((candidate) =>
          candidate.module === declaration.module
        );
        if (exportedFunctions.length === 0) {
          throw new GleamFunctionalLoweringError(
            declaration.span,
            `Gleam module ${JSON.stringify(this.module.name)} imports missing module ${
              JSON.stringify(declaration.module)
            }.`,
          );
        }
        for (const [index, exported] of exportedFunctions.entries()) {
          const alias = `$gleam_qualified_${imports.length}_${index}`;
          imports.push({
            name: alias,
            fromModule: declaration.module,
            exportName: exported.name,
            type: exported.type,
          });
          const qualifier = declaration.module.split("/").at(-1)!;
          const qualifiedName = `${qualifier}.${exported.name}`;
          if (this.#qualifiedImports.has(qualifiedName)) {
            throw new GleamFunctionalLoweringError(
              declaration.span,
              `Gleam module qualifier ${JSON.stringify(qualifier)} is ambiguous in module ${
                JSON.stringify(this.module.name)
              }.`,
            );
          }
          this.#qualifiedImports.set(qualifiedName, alias);
        }
        continue;
      }
      for (const imported of declaration.names) {
        if (
          localNames.has(imported.alias) ||
          imports.some((candidate) => candidate.name === imported.alias)
        ) {
          throw new GleamFunctionalLoweringError(
            imported.span,
            `Gleam import alias ${
              JSON.stringify(imported.alias)
            } conflicts with another value in module ${JSON.stringify(this.module.name)}.`,
          );
        }
        const exported = this.availableExports.find((candidate) =>
          candidate.module === declaration.module && candidate.name === imported.name
        );
        if (exported === undefined) {
          throw new GleamFunctionalLoweringError(
            imported.span,
            `Gleam module ${JSON.stringify(this.module.name)} imports missing public function ${
              JSON.stringify(`${declaration.module}.${imported.name}`)
            }.`,
          );
        }
        imports.push({
          name: imported.alias,
          fromModule: declaration.module,
          exportName: imported.name,
          type: exported.type,
        });
        this.#qualifiedImports.set(`${declaration.module}.${imported.name}`, imported.alias);
      }
    }
    return imports;
  }

  private lowerTypeDeclaration(
    declaration: GleamFunctionalTypeDeclaration,
  ): FunctionalSurfaceTypeDeclaration {
    const parameters = new Set(declaration.parameters);
    return {
      name: declaration.name,
      parameters: declaration.parameters,
      span: declaration.span,
      constructors: declaration.constructors.map((constructor) => ({
        name: constructor.name,
        span: constructor.span,
        fields: constructor.fields.map((field, index) => {
          requireDeclaredTypeParameters(field.type, parameters, declaration.name);
          this.validateType(field.type);
          return {
            name: field.label ?? `field${index}`,
            type: lowerType(field.type),
            span: field.span,
          };
        }),
      })),
    };
  }

  private lowerFunction(declaration: GleamFunctionalFunction): FunctionalSurfaceDefinition {
    const annotations = declaration.parameters.map((parameter) => parameter.annotation);
    const hasAnyAnnotation = annotations.some((annotation) => annotation !== null) ||
      declaration.result !== null;
    const hasCompleteAnnotation = annotations.every((annotation) => annotation !== null) &&
      declaration.result !== null;
    if (hasAnyAnnotation && !hasCompleteAnnotation) {
      throw new GleamFunctionalLoweringError(
        declaration.span,
        `Gleam function ${
          JSON.stringify(declaration.name)
        } must annotate every parameter and its result, or omit all annotations.`,
      );
    }
    for (const annotation of annotations) {
      if (annotation !== null) this.validateType(annotation);
    }
    if (declaration.result !== null) this.validateType(declaration.result);
    return {
      name: declaration.name,
      parameters: declaration.parameters.map((parameter) => parameter.name),
      annotation: hasCompleteAnnotation
        ? declaredFunctionType(this.module.name, declaration)
        : null,
      body: this.lowerExpression(declaration.body),
      span: declaration.span,
    };
  }

  private lowerExpression(expression: GleamFunctionalExpression): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "integer":
      case "boolean":
        return { ...expression };
      case "float":
        return { kind: "float-64", value: expression.value, span: expression.span };
      case "unit":
        return { kind: "name", name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, span: expression.span };
      case "name":
        return {
          kind: "name",
          name: this.#qualifiedImports.get(expression.name) ?? expression.name,
          span: expression.span,
        };
      case "tuple":
        return applyMany(
          { kind: "name", name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, span: expression.span },
          expression.values.map((value) => this.lowerExpression(value)),
          expression.span,
        );
      case "list": {
        let result: FunctionalSurfaceExpression = {
          kind: "name",
          name: GLEAM_LIST_NIL,
          span: expression.span,
        };
        for (let index = expression.values.length - 1; index >= 0; index--) {
          result = applyMany(
            { kind: "name", name: GLEAM_LIST_CONS, span: expression.span },
            [this.lowerExpression(expression.values[index]!), result],
            expression.span,
          );
        }
        return result;
      }
      case "lambda": {
        let result = this.lowerExpression(expression.body);
        for (let index = expression.parameters.length - 1; index >= 0; index--) {
          result = {
            kind: "lambda",
            parameter: expression.parameters[index]!,
            body: result,
            span: expression.span,
          };
        }
        return result;
      }
      case "call":
        return applyMany(
          this.lowerExpression(expression.callee),
          expression.arguments.map((argument) => this.lowerExpression(argument)),
          expression.span,
        );
      case "let":
        return {
          kind: "let",
          name: expression.name,
          value: this.lowerExpression(expression.value),
          body: this.lowerExpression(expression.body),
          span: expression.span,
        };
      case "binary":
        return this.lowerBinary(expression);
      case "case":
        return this.lowerCase(expression);
    }
  }

  private lowerBinary(
    expression: Extract<GleamFunctionalExpression, { readonly kind: "binary" }>,
  ): FunctionalSurfaceExpression {
    const left = this.lowerExpression(expression.left);
    const right = this.lowerExpression(expression.right);
    if (expression.operator === "&&") {
      return {
        kind: "if",
        condition: left,
        consequent: right,
        alternate: { kind: "boolean", value: false, span: expression.span },
        span: expression.span,
      };
    }
    if (expression.operator === "||") {
      return {
        kind: "if",
        condition: left,
        consequent: { kind: "boolean", value: true, span: expression.span },
        alternate: right,
        span: expression.span,
      };
    }
    if (expression.operator === "%") {
      const quotient: FunctionalSurfaceExpression = {
        kind: "binary",
        operator: FunctionalBinaryOperator.Divide,
        left,
        right,
        span: expression.span,
      };
      return {
        kind: "binary",
        operator: FunctionalBinaryOperator.Subtract,
        left,
        right: {
          kind: "binary",
          operator: FunctionalBinaryOperator.Multiply,
          left: quotient,
          right,
          span: expression.span,
        },
        span: expression.span,
      };
    }
    return {
      kind: "binary",
      operator: binaryOperators[expression.operator]!,
      left,
      right,
      span: expression.span,
    };
  }

  private lowerCase(
    expression: Extract<GleamFunctionalExpression, { readonly kind: "case" }>,
  ): FunctionalSurfaceExpression {
    if (expression.subjects.length !== 1) {
      throw new GleamFunctionalLoweringError(
        expression.span,
        `Gleam case expressions currently accept one subject; received ${expression.subjects.length}.`,
      );
    }
    if (expression.arms.length === 0) {
      throw new GleamFunctionalLoweringError(
        expression.span,
        "Gleam case expressions need an arm.",
      );
    }
    const subject = this.lowerExpression(expression.subjects[0]!);
    const patterns = expression.arms.map((arm) => arm.patterns[0]!);
    if (patterns.every((pattern) => isScalarPattern(pattern))) {
      return this.lowerScalarCase(subject, expression.arms, expression.span);
    }
    return {
      kind: "case",
      value: subject,
      arms: this.lowerConstructorArms(expression.arms),
      span: expression.span,
    };
  }

  private lowerScalarCase(
    subject: FunctionalSurfaceExpression,
    arms: Extract<GleamFunctionalExpression, { readonly kind: "case" }>["arms"],
    span: FunctionalSpan,
  ): FunctionalSurfaceExpression {
    const subjectName = `$gleam_case_${this.#discardIndex++}`;
    let fallback: FunctionalSurfaceExpression | null = null;
    for (let index = arms.length - 1; index >= 0; index--) {
      const arm = arms[index]!;
      const pattern = arm.patterns[0]!;
      const body = this.lowerExpression(arm.body);
      if (pattern.kind === "variable" || pattern.kind === "discard") {
        if (fallback !== null) {
          throw new GleamFunctionalLoweringError(
            pattern.span,
            "A scalar Gleam catch-all case arm must be last.",
          );
        }
        fallback = pattern.kind === "variable"
          ? {
            kind: "let",
            name: pattern.name,
            value: name(subjectName, pattern.span),
            body,
            span: arm.span,
          }
          : body;
        continue;
      }
      if (fallback === null) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          "Scalar Gleam case expressions require a final variable or discard arm.",
        );
      }
      if (pattern.kind !== "integer" && pattern.kind !== "boolean") {
        throw new Error(`Gleam scalar case retained unexpected pattern ${pattern.kind}.`);
      }
      fallback = {
        kind: "if",
        condition: {
          kind: "binary",
          operator: FunctionalBinaryOperator.Equal,
          left: name(subjectName, pattern.span),
          right: scalarPatternValue(pattern),
          span: pattern.span,
        },
        consequent: body,
        alternate: fallback,
        span: arm.span,
      };
    }
    if (fallback === null) throw new Error("Gleam scalar case lowering omitted its fallback.");
    return { kind: "let", name: subjectName, value: subject, body: fallback, span };
  }

  private lowerConstructorArms(
    arms: Extract<GleamFunctionalExpression, { readonly kind: "case" }>["arms"],
  ): readonly FunctionalSurfaceCaseArm[] {
    const lowered: FunctionalSurfaceCaseArm[] = [];
    let owner: string | null = null;
    let catchAll: typeof arms[number] | null = null;
    for (const arm of arms) {
      const pattern = arm.patterns[0]!;
      if (pattern.kind === "variable" || pattern.kind === "discard") {
        if (catchAll !== null) {
          throw new GleamFunctionalLoweringError(
            pattern.span,
            "Gleam case repeats a catch-all arm.",
          );
        }
        catchAll = arm;
        continue;
      }
      if (catchAll !== null) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          "A Gleam catch-all case arm must be last.",
        );
      }
      const normalized = normalizeConstructorPattern(pattern);
      const shape = this.#constructors.get(normalized.constructor);
      if (shape === undefined) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          `Gleam case references unknown constructor ${JSON.stringify(normalized.constructor)}.`,
        );
      }
      if (owner !== null && owner !== shape.owner) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          `Gleam case mixes constructors from ${JSON.stringify(owner)} and ${
            JSON.stringify(shape.owner)
          }.`,
        );
      }
      if (normalized.arguments.length !== shape.fields) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          `Gleam constructor ${
            JSON.stringify(normalized.constructor)
          } receives ${normalized.arguments.length} patterns; expected ${shape.fields}.`,
        );
      }
      owner = shape.owner;
      lowered.push({
        constructor: normalized.constructor,
        binders: normalized.arguments.map((argument) => this.lowerPatternBinder(argument)),
        body: this.lowerExpression(arm.body),
        span: arm.span,
      });
    }
    if (owner === null) {
      throw new GleamFunctionalLoweringError(
        arms[0]!.span,
        "A constructor Gleam case needs at least one constructor pattern.",
      );
    }
    const constructors = this.#constructorsByOwner.get(owner);
    if (constructors === undefined) {
      throw new Error(`Gleam lowering omitted constructors for ${owner}.`);
    }
    const covered = new Set(lowered.map((arm) => arm.constructor));
    if (catchAll !== null) {
      const pattern = catchAll.patterns[0]!;
      for (const constructor of constructors) {
        if (covered.has(constructor)) continue;
        const shape = this.#constructors.get(constructor)!;
        const binders = Array.from({ length: shape.fields }, () => this.discardName());
        let body = this.lowerExpression(catchAll!.body);
        if (pattern.kind === "variable") {
          body = {
            kind: "let",
            name: pattern.name,
            value: applyMany(
              name(constructor, pattern.span),
              binders.map((binder) => name(binder, pattern.span)),
              pattern.span,
            ),
            body,
            span: catchAll.span,
          };
        }
        lowered.push({ constructor, binders, body, span: catchAll.span });
      }
    }
    const missing = constructors.filter((constructor) =>
      !lowered.some((arm) => arm.constructor === constructor)
    );
    if (missing.length > 0) {
      throw new GleamFunctionalLoweringError(
        arms[0]!.span,
        `Gleam case is not exhaustive; missing ${
          missing.map((value) => JSON.stringify(value)).join(", ")
        }.`,
      );
    }
    return lowered;
  }

  private lowerPatternBinder(pattern: GleamFunctionalPattern): string {
    if (pattern.kind === "variable") return pattern.name;
    if (pattern.kind === "discard") return this.discardName();
    throw new GleamFunctionalLoweringError(
      pattern.span,
      "Nested Gleam constructor patterns currently accept only variables and discards.",
    );
  }

  private discardName(): string {
    return `$gleam_discard_${this.#discardIndex++}`;
  }

  private validateType(type: GleamFunctionalType): void {
    switch (type.kind) {
      case "integer":
      case "float":
      case "boolean":
      case "unit":
      case "parameter":
        return;
      case "tuple":
        this.validateType(type.values[0]);
        this.validateType(type.values[1]);
        return;
      case "function":
        for (const parameter of type.parameters) this.validateType(parameter);
        this.validateType(type.result);
        return;
      case "named": {
        const arity = this.#typeArities.get(type.name);
        if (arity === undefined) {
          throw new GleamFunctionalLoweringError(
            type.span,
            `Gleam type ${JSON.stringify(type.name)} is not declared in module ${
              JSON.stringify(this.module.name)
            }.`,
          );
        }
        if (type.arguments.length !== arity) {
          throw new GleamFunctionalLoweringError(
            type.span,
            `Gleam type ${
              JSON.stringify(type.name)
            } receives ${type.arguments.length} arguments; expected ${arity}.`,
          );
        }
        for (const argument of type.arguments) this.validateType(argument);
      }
    }
  }
}

function declaredFunctionType(
  moduleName: string,
  declaration: GleamFunctionalFunction,
): FunctionalTypeSchema {
  if (
    declaration.parameters.some((parameter) => parameter.annotation === null) ||
    declaration.result === null
  ) {
    throw new GleamFunctionalLoweringError(
      declaration.span,
      `Public Gleam function ${
        JSON.stringify(`${moduleName}.${declaration.name}`)
      } must annotate every parameter and its result so module boundaries have a stable type.`,
    );
  }
  const parameters = declaration.parameters.map((parameter) => lowerType(parameter.annotation!));
  return curryType(parameters, lowerType(declaration.result));
}

function curryType(
  parameters: readonly FunctionalTypeSchema[],
  result: FunctionalTypeSchema,
): FunctionalTypeSchema {
  let current = result;
  for (let index = parameters.length - 1; index >= 0; index--) {
    current = { kind: "function", parameter: parameters[index]!, result: current };
  }
  return current;
}

function lowerType(type: GleamFunctionalType): FunctionalTypeSchema {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return { kind: type.kind };
    case "float":
      return { kind: "float-64" };
    case "parameter":
      return { kind: "parameter", name: type.name };
    case "tuple":
      return { kind: "tuple", values: [lowerType(type.values[0]), lowerType(type.values[1])] };
    case "named":
      return {
        kind: "named",
        name: type.name === "List" ? GLEAM_LIST_TYPE : type.name,
        arguments: type.arguments.map(lowerType),
      };
    case "function":
      return curryType(type.parameters.map(lowerType), lowerType(type.result));
  }
}

function requireDeclaredTypeParameters(
  type: GleamFunctionalType,
  parameters: ReadonlySet<string>,
  declarationName: string,
): void {
  switch (type.kind) {
    case "integer":
    case "float":
    case "boolean":
    case "unit":
      return;
    case "parameter":
      if (parameters.has(type.name)) return;
      throw new GleamFunctionalLoweringError(
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
      for (const parameter of type.parameters) {
        requireDeclaredTypeParameters(parameter, parameters, declarationName);
      }
      requireDeclaredTypeParameters(type.result, parameters, declarationName);
  }
}

function normalizeConstructorPattern(pattern: GleamFunctionalPattern): {
  readonly constructor: string;
  readonly arguments: readonly GleamFunctionalPattern[];
} {
  switch (pattern.kind) {
    case "constructor":
      return { constructor: pattern.name, arguments: pattern.arguments };
    case "list-nil":
      return { constructor: GLEAM_LIST_NIL, arguments: [] };
    case "list-cons":
      return { constructor: GLEAM_LIST_CONS, arguments: [pattern.head, pattern.tail] };
    case "tuple":
      return { constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, arguments: pattern.values };
    case "unit":
      return { constructor: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, arguments: [] };
    default:
      throw new GleamFunctionalLoweringError(
        pattern.span,
        `Gleam pattern ${JSON.stringify(pattern.kind)} cannot select an algebraic constructor.`,
      );
  }
}

function isScalarPattern(pattern: GleamFunctionalPattern): boolean {
  return pattern.kind === "integer" || pattern.kind === "boolean" ||
    pattern.kind === "variable" || pattern.kind === "discard";
}

function scalarPatternValue(
  pattern: Extract<GleamFunctionalPattern, { readonly kind: "integer" | "boolean" }>,
): FunctionalSurfaceExpression {
  return pattern.kind === "integer"
    ? { kind: "integer", value: pattern.value, span: pattern.span }
    : { kind: "boolean", value: pattern.value, span: pattern.span };
}

function applyMany(
  callee: FunctionalSurfaceExpression,
  arguments_: readonly FunctionalSurfaceExpression[],
  span: FunctionalSpan,
): FunctionalSurfaceExpression {
  let result = callee;
  for (const argument of arguments_) {
    result = { kind: "apply", callee: result, argument, span };
  }
  return result;
}

function name(value: string, span: FunctionalSpan): FunctionalSurfaceExpression {
  return { kind: "name", name: value, span };
}

function gleamListDeclaration(sourceByteLength: number): FunctionalSurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: GLEAM_LIST_TYPE,
    parameters: ["value"],
    span,
    constructors: [
      { name: GLEAM_LIST_NIL, fields: [], span },
      {
        name: GLEAM_LIST_CONS,
        span,
        fields: [
          { name: "head", type: { kind: "parameter", name: "value" }, span },
          {
            name: "tail",
            type: {
              kind: "named",
              name: GLEAM_LIST_TYPE,
              arguments: [{ kind: "parameter", name: "value" }],
            },
            span,
          },
        ],
      },
    ],
  };
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
    throw new GleamFunctionalLoweringError(
      span,
      `Gleam ${location} repeat ${JSON.stringify(name)}.`,
    );
  }
}
