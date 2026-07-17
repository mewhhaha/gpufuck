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
  TypeCoreCapabilityRule,
  TypeCoreCapabilityTypePattern,
} from "../functional/capability_contract.ts";
import { TypeCoreCapabilityResolver } from "../functional/capability_resolver.ts";
import type { TypeCoreType, TypeCoreValue } from "../functional/type_core_contract.ts";
import type {
  HaskellFunctionalClassDeclaration,
  HaskellFunctionalDefinition,
  HaskellFunctionalExpression,
  HaskellFunctionalInstanceDeclaration,
  HaskellFunctionalPattern,
  HaskellFunctionalProgram,
  HaskellFunctionalType,
  HaskellFunctionalTypeDeclaration,
  HaskellFunctionalTypeSignature,
} from "./ast.ts";
import { HaskellFunctionalLoweringError } from "./diagnostic.ts";

export interface LoweredHaskellFunctionalProgram {
  readonly program: HaskellFunctionalProgram;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly module: EncodedFunctionalModule;
}

interface ConstructorShape {
  readonly fields: readonly string[];
  readonly owner: string;
  readonly span: FunctionalSpan;
}

interface PatternRow {
  readonly patterns: readonly HaskellFunctionalPattern[];
  readonly alternatives: HaskellFunctionalDefinition["alternatives"];
  readonly whereDefinitions: readonly HaskellFunctionalDefinition[];
  readonly bindings: readonly {
    readonly name: string;
    readonly value: FunctionalSurfaceExpression;
  }[];
  readonly span: FunctionalSpan;
}

const HASKELL_LIST_TYPE = "$HaskellList";
const HASKELL_LIST_NIL = "$HaskellNil";
const HASKELL_LIST_CONS = "$HaskellCons";

const binaryOperators: Readonly<Record<string, FunctionalBinaryOperator>> = {
  "==": FunctionalBinaryOperator.Equal,
  "/=": FunctionalBinaryOperator.NotEqual,
  "<": FunctionalBinaryOperator.Less,
  "<=": FunctionalBinaryOperator.LessEqual,
  ">": FunctionalBinaryOperator.Greater,
  ">=": FunctionalBinaryOperator.GreaterEqual,
  "+": FunctionalBinaryOperator.Add,
  "-": FunctionalBinaryOperator.Subtract,
  "*": FunctionalBinaryOperator.Multiply,
  "/": FunctionalBinaryOperator.Divide,
};

export function lowerHaskellFunctionalProgram(
  program: HaskellFunctionalProgram,
): LoweredHaskellFunctionalProgram {
  return new HaskellFunctionalLowering(program).lower();
}

class HaskellFunctionalLowering {
  readonly #constructors = new Map<string, ConstructorShape>();
  readonly #constructorsByOwner = new Map<string, readonly string[]>();
  readonly #definitions = new Map<string, HaskellFunctionalDefinition[]>();
  readonly #signatures = new Map<string, HaskellFunctionalTypeSignature>();
  readonly #signatureSpans = new Map<string, FunctionalSpan>();
  readonly #typeNames = new Map<string, FunctionalSpan>();
  readonly #classes = new Map<string, HaskellFunctionalClassDeclaration>();
  readonly #classMethods = new Map<string, HaskellFunctionalClassDeclaration>();
  readonly #instances: HaskellFunctionalInstanceDeclaration[] = [];
  #capabilityResolver: TypeCoreCapabilityResolver | null = null;
  #matchIndex = 0;

  constructor(private readonly program: HaskellFunctionalProgram) {}

  lower(): LoweredHaskellFunctionalProgram {
    this.indexImplicitDeclarations();
    this.indexDeclarations();
    const typeDeclarations = [
      ...this.program.declarations.flatMap((declaration) =>
        declaration.kind === "type" ? [this.lowerTypeDeclaration(declaration)] : []
      ),
      ...this.lowerClassDictionaries(),
      haskellListDeclaration(this.program.span.endByte),
    ];
    const loweredNames = new Set<string>();
    const definitions = [
      ...this.lowerRecordSelectors(),
      ...this.lowerClassMethodSelectors(),
      ...this.lowerInstances(),
      ...this.program.declarations.flatMap((declaration) => {
        if (declaration.kind !== "definition" || loweredNames.has(declaration.name)) return [];
        loweredNames.add(declaration.name);
        const equations = this.#definitions.get(declaration.name);
        if (equations === undefined) {
          throw new Error(`Haskell lowering omitted definition ${declaration.name}.`);
        }
        return [this.lowerDefinition(declaration.name, equations)];
      }),
    ].sort((left, right) => (left.span?.startByte ?? 0) - (right.span?.startByte ?? 0));
    this.rejectOrphanSignatures();

    const entry = this.#definitions.get("gpuMain");
    if (entry === undefined) {
      throw new HaskellFunctionalLoweringError(
        this.program.span,
        "Haskell functional source must declare gpuMain as its GPU entry.",
      );
    }
    const entryArity = entry[0]?.parameters.length;
    if (entryArity === undefined) throw new Error("Haskell entry group is empty.");
    if (entryArity !== 0) {
      throw new HaskellFunctionalLoweringError(
        entry[0]?.span ?? this.program.span,
        `Haskell functional entry gpuMain has ${entryArity} parameters; expected none.`,
      );
    }

    return {
      program: this.program,
      definitions,
      typeDeclarations,
      module: buildFunctionalSurfaceModule(
        definitions,
        typeDeclarations,
        "gpuMain",
        this.program.span.endByte,
        { evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed },
      ),
    };
  }

  private indexImplicitDeclarations(): void {
    const span = { startByte: this.program.span.endByte, endByte: this.program.span.endByte };
    this.#constructors.set(HASKELL_LIST_NIL, { fields: [], owner: HASKELL_LIST_TYPE, span });
    this.#constructors.set(HASKELL_LIST_CONS, {
      fields: ["head", "tail"],
      owner: HASKELL_LIST_TYPE,
      span,
    });
    this.#constructorsByOwner.set(HASKELL_LIST_TYPE, [HASKELL_LIST_NIL, HASKELL_LIST_CONS]);
    this.#constructorsByOwner.set("$TupleType", [FUNCTIONAL_PAIR_CONSTRUCTOR_NAME]);
    this.#constructors.set(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, {
      fields: ["first", "second"],
      owner: "$TupleType",
      span,
    });
  }

  private indexClassDeclaration(declaration: HaskellFunctionalClassDeclaration): void {
    const existing = this.#classes.get(declaration.name);
    if (existing !== undefined) {
      throw new HaskellFunctionalLoweringError(
        declaration.span,
        `Haskell source repeats class ${JSON.stringify(declaration.name)}; ` +
          `the first declaration starts at byte ${existing.span.startByte}.`,
      );
    }
    requireUniqueNames(
      declaration.methods.map((method) => method.name),
      declaration.span,
      `class ${JSON.stringify(declaration.name)} methods`,
    );
    for (const method of declaration.methods) {
      if (method.constraints.length > 0) {
        throw new HaskellFunctionalLoweringError(
          method.span,
          `Class method ${JSON.stringify(method.name)} cannot declare nested constraints yet.`,
        );
      }
      const methodOwner = this.#classMethods.get(method.name);
      if (methodOwner !== undefined) {
        throw new HaskellFunctionalLoweringError(
          method.span,
          `Class method ${JSON.stringify(method.name)} is already declared by ${
            JSON.stringify(methodOwner.name)
          }.`,
        );
      }
      this.#classMethods.set(method.name, declaration);
    }
    this.#classes.set(declaration.name, declaration);
    const dictionaryType = classDictionaryTypeName(declaration.name);
    const dictionaryConstructor = classDictionaryConstructorName(declaration.name);
    this.#constructorsByOwner.set(dictionaryType, [dictionaryConstructor]);
    this.#constructors.set(dictionaryConstructor, {
      fields: declaration.methods.map((method) => method.name),
      owner: dictionaryType,
      span: declaration.span,
    });
  }

  private indexInstanceDeclaration(declaration: HaskellFunctionalInstanceDeclaration): void {
    const classDeclaration = this.#classes.get(declaration.className);
    if (classDeclaration === undefined) {
      throw new HaskellFunctionalLoweringError(
        declaration.span,
        `Instance references unknown class ${JSON.stringify(declaration.className)}.`,
      );
    }
    if (containsTypeParameter(declaration.type)) {
      throw new HaskellFunctionalLoweringError(
        declaration.type.span,
        `Instance ${
          JSON.stringify(declaration.className)
        } must target a concrete first-order type.`,
      );
    }
    const key = instanceKey(declaration.className, declaration.type);
    const existing = this.#instances.find((instance) =>
      instanceKey(instance.className, instance.type) === key
    );
    if (existing !== undefined) {
      throw new HaskellFunctionalLoweringError(
        declaration.span,
        `Haskell source repeats instance ${key}; the first starts at byte ${existing.span.startByte}.`,
      );
    }
    const methodNames = new Set(declaration.methods.map((method) => method.name));
    for (const method of classDeclaration.methods) {
      if (methodNames.has(method.name)) continue;
      throw new HaskellFunctionalLoweringError(
        declaration.span,
        `Instance ${key} is missing method ${JSON.stringify(method.name)}.`,
      );
    }
    for (const method of declaration.methods) {
      if (classDeclaration.methods.some((declared) => declared.name === method.name)) continue;
      throw new HaskellFunctionalLoweringError(
        method.span,
        `Instance ${key} defines unknown method ${JSON.stringify(method.name)}.`,
      );
    }
    this.#instances.push(declaration);
  }

  private capabilityRules(): TypeCoreCapabilityRule[] {
    return this.#instances.map((instance) => ({
      id: instanceKey(instance.className, instance.type),
      predicate: classPredicate(instance.className),
      inputs: [{ kind: "type", type: capabilityTypePattern(instance.type) }],
      outputs: [],
      premises: [],
      witness: {
        kind: "runtime-dictionary",
        symbol: instanceDictionaryName(instance.className, instance.type),
      },
    }));
  }

  private indexDeclarations(): void {
    for (const declaration of this.program.declarations) {
      if (declaration.kind === "class") this.indexClassDeclaration(declaration);
    }
    for (const declaration of this.program.declarations) {
      switch (declaration.kind) {
        case "type":
          this.indexTypeDeclaration(declaration);
          break;
        case "signature":
          this.indexSignature(declaration);
          break;
        case "definition":
          this.indexDefinition(declaration);
          break;
        case "instance":
          this.indexInstanceDeclaration(declaration);
          break;
        case "class":
          break;
      }
    }
    this.#capabilityResolver = new TypeCoreCapabilityResolver(this.capabilityRules());
  }

  private indexTypeDeclaration(declaration: HaskellFunctionalTypeDeclaration): void {
    const existing = this.#typeNames.get(declaration.name);
    if (existing !== undefined) {
      throw new HaskellFunctionalLoweringError(
        declaration.span,
        `Haskell source repeats type ${JSON.stringify(declaration.name)}; ` +
          `the first declaration starts at byte ${existing.startByte}.`,
      );
    }
    this.#typeNames.set(declaration.name, declaration.span);
    requireUniqueNames(
      declaration.parameters,
      declaration.span,
      `type ${JSON.stringify(declaration.name)} parameters`,
    );
    const parameters = new Set(declaration.parameters);
    const recordConstructors = declaration.constructors.filter((constructor) => constructor.record);
    if (recordConstructors.length > 0 && declaration.constructors.length !== 1) {
      throw new HaskellFunctionalLoweringError(
        declaration.span,
        `Record type ${
          JSON.stringify(declaration.name)
        } must have exactly one constructor in this profile.`,
      );
    }
    this.#constructorsByOwner.set(
      declaration.name,
      declaration.constructors.map((constructor) => constructor.name),
    );
    for (const constructor of declaration.constructors) {
      const existingConstructor = this.#constructors.get(constructor.name);
      if (existingConstructor !== undefined) {
        throw new HaskellFunctionalLoweringError(
          constructor.span,
          `Haskell source repeats constructor ${JSON.stringify(constructor.name)}; ` +
            `the first declaration starts at byte ${existingConstructor.span.startByte}.`,
        );
      }
      requireUniqueNames(
        constructor.fields.flatMap((field) => field.name === null ? [] : [field.name]),
        constructor.span,
        `constructor ${JSON.stringify(constructor.name)} record fields`,
      );
      for (const field of constructor.fields) {
        requireDeclaredTypeParameters(field.type, parameters, declaration.name);
      }
      if (constructor.result !== undefined) {
        requireDeclaredTypeParameters(constructor.result, parameters, declaration.name);
      }
      this.#constructors.set(constructor.name, {
        fields: constructor.fields.map((field, index) => field.name ?? `$${index}`),
        owner: declaration.name,
        span: constructor.span,
      });
    }
  }

  private indexSignature(signature: HaskellFunctionalTypeSignature): void {
    const existing = this.#signatureSpans.get(signature.name);
    if (existing !== undefined) {
      throw new HaskellFunctionalLoweringError(
        signature.span,
        `Haskell source repeats the signature for ${JSON.stringify(signature.name)}; ` +
          `the first signature starts at byte ${existing.startByte}.`,
      );
    }
    for (const constraint of signature.constraints) {
      if (!this.#classes.has(constraint.className)) {
        throw new HaskellFunctionalLoweringError(
          constraint.span,
          `Unknown Haskell class ${JSON.stringify(constraint.className)} in a constraint.`,
        );
      }
    }
    this.#signatures.set(signature.name, signature);
    this.#signatureSpans.set(signature.name, signature.span);
  }

  private indexDefinition(declaration: HaskellFunctionalDefinition): void {
    const equations = this.#definitions.get(declaration.name) ?? [];
    const arity = equations[0]?.parameters.length;
    if (arity !== undefined && arity !== declaration.parameters.length) {
      throw new HaskellFunctionalLoweringError(
        declaration.span,
        `Definition ${
          JSON.stringify(declaration.name)
        } equation has ${declaration.parameters.length} patterns; expected ${arity}.`,
      );
    }
    requireUniquePatternBindings(
      declaration.parameters,
      declaration.span,
      `definition ${JSON.stringify(declaration.name)} patterns`,
    );
    equations.push(declaration);
    this.#definitions.set(declaration.name, equations);
  }

  private rejectOrphanSignatures(): void {
    for (const [name, span] of this.#signatureSpans) {
      if (this.#definitions.has(name)) continue;
      throw new HaskellFunctionalLoweringError(
        span,
        `Haskell signature ${JSON.stringify(name)} has no definition.`,
      );
    }
  }

  private lowerTypeDeclaration(
    declaration: HaskellFunctionalTypeDeclaration,
  ): FunctionalSurfaceTypeDeclaration {
    return {
      name: declaration.name,
      parameters: declaration.parameters,
      span: declaration.span,
      constructors: declaration.constructors.map((constructor) => ({
        name: constructor.name,
        span: constructor.span,
        fields: constructor.fields.map((field, index) => ({
          name: field.name ?? `$${index}`,
          type: lowerType(field.type),
          span: field.span,
        })),
        ...(constructor.result === undefined ? {} : { result: lowerType(constructor.result) }),
      })),
    };
  }

  private lowerClassDictionaries(): FunctionalSurfaceTypeDeclaration[] {
    return [...this.#classes.values()].map((declaration) => ({
      name: classDictionaryTypeName(declaration.name),
      parameters: [declaration.parameter],
      span: declaration.span,
      constructors: [{
        name: classDictionaryConstructorName(declaration.name),
        span: declaration.span,
        fields: declaration.methods.map((method) => ({
          name: method.name,
          type: lowerType(method.type),
          span: method.span,
        })),
      }],
    }));
  }

  private lowerClassMethodSelectors(): FunctionalSurfaceDefinition[] {
    return [...this.#classes.values()].flatMap((declaration) => {
      const methodNames = declaration.methods.map((method) => method.name);
      const dictionaryType: FunctionalTypeSchema = {
        kind: "named",
        name: classDictionaryTypeName(declaration.name),
        arguments: [{ kind: "parameter", name: declaration.parameter }],
      };
      return declaration.methods.map((method) => ({
        name: classMethodSelectorName(declaration.name, method.name),
        parameters: ["$dictionary"],
        annotation: {
          kind: "function",
          parameter: dictionaryType,
          result: lowerType(method.type),
        },
        body: {
          kind: "case",
          value: { kind: "name", name: "$dictionary", span: method.span },
          arms: [{
            constructor: classDictionaryConstructorName(declaration.name),
            binders: methodNames,
            body: { kind: "name", name: method.name, span: method.span },
            span: declaration.span,
          }],
          span: declaration.span,
        },
        span: method.span,
      }));
    });
  }

  private lowerInstances(): FunctionalSurfaceDefinition[] {
    return this.#instances.flatMap((instance) => {
      const classDeclaration = this.#classes.get(instance.className);
      if (classDeclaration === undefined) {
        throw new Error(`Haskell class ${instance.className} disappeared.`);
      }
      const methods = classDeclaration.methods.map((method) => {
        const equations = instance.methods.filter((definition) => definition.name === method.name);
        if (equations.length === 0) {
          throw new Error(`Haskell instance omitted method ${method.name}.`);
        }
        return this.lowerDefinition(
          instanceMethodName(instance.className, instance.type, method.name),
          equations,
          lowerType(
            substituteTypeParameter(method.type, classDeclaration.parameter, instance.type),
          ),
        );
      });
      const dictionaryType: FunctionalTypeSchema = {
        kind: "named",
        name: classDictionaryTypeName(instance.className),
        arguments: [lowerType(instance.type)],
      };
      const dictionary: FunctionalSurfaceDefinition = {
        name: instanceDictionaryName(instance.className, instance.type),
        parameters: [],
        annotation: dictionaryType,
        body: apply(
          {
            kind: "name",
            name: classDictionaryConstructorName(instance.className),
            span: instance.span,
          },
          classDeclaration.methods.map((method) => ({
            kind: "name" as const,
            name: instanceMethodName(instance.className, instance.type, method.name),
            span: method.span,
          })),
          instance.span,
        ),
        span: instance.span,
      };
      return [...methods, dictionary];
    });
  }

  private lowerRecordSelectors(): FunctionalSurfaceDefinition[] {
    const selectors: FunctionalSurfaceDefinition[] = [];
    const selectorNames = new Map<string, FunctionalSpan>();
    for (const declaration of this.program.declarations) {
      if (declaration.kind !== "type") continue;
      const constructor = declaration.constructors[0];
      if (constructor === undefined || !constructor.record) continue;
      const owner: FunctionalTypeSchema = {
        kind: "named",
        name: declaration.name,
        arguments: declaration.parameters.map((name) => ({ kind: "parameter", name })),
      };
      const binders = constructor.fields.map((field, index) => field.name ?? `$${index}`);
      for (const field of constructor.fields) {
        if (field.name === null) continue;
        const existing = selectorNames.get(field.name) ??
          this.#definitions.get(field.name)?.[0]?.span ?? this.#signatureSpans.get(field.name);
        if (existing !== undefined) {
          throw new HaskellFunctionalLoweringError(
            field.span,
            `Record selector ${
              JSON.stringify(field.name)
            } conflicts with a value declared at byte ${existing.startByte}.`,
          );
        }
        selectorNames.set(field.name, field.span);
        selectors.push({
          name: field.name,
          parameters: ["$record"],
          annotation: {
            kind: "function",
            parameter: owner,
            result: lowerType(field.type),
          },
          body: {
            kind: "case",
            value: { kind: "name", name: "$record", span: field.span },
            arms: [{
              constructor: constructor.name,
              binders,
              body: { kind: "name", name: field.name, span: field.span },
              span: constructor.span,
            }],
            span: constructor.span,
          },
          span: field.span,
        });
      }
    }
    return selectors;
  }

  private lowerDefinition(
    name: string,
    equations: readonly HaskellFunctionalDefinition[],
    annotationOverride?: FunctionalTypeSchema,
  ): FunctionalSurfaceDefinition {
    const first = equations[0];
    const last = equations.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error(`Haskell definition ${name} has no equations.`);
    }
    const valueParameters = first.parameters.map((_, index) => `$argument${index}`);
    let body = this.compilePatternRows(
      equations.map((equation) => ({
        patterns: equation.parameters,
        alternatives: equation.alternatives,
        whereDefinitions: equation.whereDefinitions,
        bindings: [],
        span: equation.span,
      })),
      valueParameters.map((parameter) => ({
        kind: "name" as const,
        name: parameter,
        span: first.span,
      })),
    );
    if (body === null) {
      throw new HaskellFunctionalLoweringError(
        first.span,
        `Definition ${JSON.stringify(name)} has no reachable equation.`,
      );
    }
    const signature = this.#signatures.get(name);
    const constraints = annotationOverride === undefined ? signature?.constraints ?? [] : [];
    const dictionaryParameters = constraints.map((constraint, index) =>
      `$dictionary${index}_${constraint.className}`
    );
    for (let index = constraints.length - 1; index >= 0; index--) {
      const constraint = constraints[index];
      const dictionaryParameter = dictionaryParameters[index];
      if (constraint === undefined || dictionaryParameter === undefined) {
        throw new Error(`Haskell constraint ${index} is absent.`);
      }
      const classDeclaration = this.#classes.get(constraint.className);
      if (classDeclaration === undefined) {
        throw new Error(`Haskell class ${constraint.className} disappeared.`);
      }
      body = {
        kind: "case",
        value: { kind: "name", name: dictionaryParameter, span: constraint.span },
        arms: [{
          constructor: classDictionaryConstructorName(constraint.className),
          binders: classDeclaration.methods.map((method) => method.name),
          body,
          span: classDeclaration.span,
        }],
        span: constraint.span,
      };
    }
    let annotation = annotationOverride ??
      (signature === undefined ? null : lowerType(signature.type));
    for (let index = constraints.length - 1; index >= 0; index--) {
      const constraint = constraints[index];
      if (constraint === undefined || annotation === null) continue;
      annotation = {
        kind: "function",
        parameter: {
          kind: "named",
          name: classDictionaryTypeName(constraint.className),
          arguments: [lowerType(constraint.type)],
        },
        result: annotation,
      };
    }
    return {
      name,
      parameters: [...dictionaryParameters, ...valueParameters],
      annotation,
      body,
      span: combine(first.span, last.span),
    };
  }

  private lowerExpression(expression: HaskellFunctionalExpression): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "integer":
      case "boolean":
      case "name":
        return expression;
      case "record":
        return this.lowerRecordExpression(expression);
      case "lambda": {
        let body = this.lowerExpression(expression.body);
        for (let index = expression.parameters.length - 1; index >= 0; index--) {
          const parameter = expression.parameters[index];
          if (parameter === undefined) {
            throw new Error(`Haskell lambda omitted parameter ${index}.`);
          }
          body = { kind: "lambda", parameter, body, span: expression.span };
        }
        return body;
      }
      case "list": {
        let list: FunctionalSurfaceExpression = {
          kind: "name",
          name: HASKELL_LIST_NIL,
          span: expression.span,
        };
        for (let index = expression.values.length - 1; index >= 0; index--) {
          const value = expression.values[index];
          if (value === undefined) throw new Error(`Haskell list omitted value ${index}.`);
          list = apply(
            { kind: "name", name: HASKELL_LIST_CONS, span: expression.span },
            [this.lowerExpression(value), list],
            expression.span,
          );
        }
        return list;
      }
      case "list-cons":
        return apply(
          { kind: "name", name: HASKELL_LIST_CONS, span: expression.span },
          [this.lowerExpression(expression.head), this.lowerExpression(expression.tail)],
          expression.span,
        );
      case "unit":
        return { kind: "name", name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, span: expression.span };
      case "tuple":
        return apply(
          { kind: "name", name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, span: expression.span },
          expression.values.map((value) => this.lowerExpression(value)),
          expression.span,
        );
      case "apply":
        return {
          kind: "apply",
          callee: this.lowerCalleeWithEvidence(expression.callee, expression.argument),
          argument: this.lowerExpression(expression.argument),
          span: expression.span,
        };
      case "let": {
        let body = this.lowerExpression(expression.body);
        for (let index = expression.bindings.length - 1; index >= 0; index--) {
          const binding = expression.bindings[index];
          if (binding === undefined) throw new Error(`Haskell let omitted binding ${index}.`);
          body = {
            kind: "let",
            name: binding.name,
            value: this.lowerExpression(binding.value),
            body,
            span: combine(binding.span, expression.span),
          };
        }
        return body;
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
          throw new Error(`Haskell lowering omitted binary operator ${expression.operator}.`);
        }
        return {
          kind: "binary",
          operator,
          left: this.lowerExpression(expression.left),
          right: this.lowerExpression(expression.right),
          span: expression.span,
        };
      }
      case "case":
        return this.lowerCaseExpression(expression);
    }
  }

  private lowerCalleeWithEvidence(
    callee: HaskellFunctionalExpression,
    firstArgument: HaskellFunctionalExpression,
  ): FunctionalSurfaceExpression {
    if (callee.kind !== "name") return this.lowerExpression(callee);
    const methodClass = this.#classMethods.get(callee.name);
    if (methodClass !== undefined) {
      const type = inferConcreteExpressionType(
        firstArgument,
        this.#constructors,
        this.#signatures,
      );
      if (type === null) return this.lowerExpression(callee);
      const dictionary = this.resolveDictionary(methodClass.name, type, firstArgument.span);
      return {
        kind: "apply",
        callee: {
          kind: "name",
          name: classMethodSelectorName(methodClass.name, callee.name),
          span: callee.span,
        },
        argument: { kind: "name", name: dictionary, span: firstArgument.span },
        span: callee.span,
      };
    }

    const signature = this.#signatures.get(callee.name);
    if (signature === undefined || signature.constraints.length === 0) {
      return this.lowerExpression(callee);
    }
    const firstParameter = firstFunctionParameter(signature.type);
    const type = inferConcreteExpressionType(
      firstArgument,
      this.#constructors,
      this.#signatures,
    );
    if (
      signature.constraints.length !== 1 || firstParameter?.kind !== "parameter" || type === null ||
      signature.constraints[0]?.type.kind !== "parameter" ||
      signature.constraints[0]?.type.name !== firstParameter.name
    ) {
      throw new HaskellFunctionalLoweringError(
        firstArgument.span,
        `Call to constrained function ${
          JSON.stringify(callee.name)
        } needs a concrete first argument matching its class parameter.`,
      );
    }
    const constraint = signature.constraints[0];
    if (constraint === undefined) {
      throw new Error("Haskell constrained call omitted its constraint.");
    }
    return {
      kind: "apply",
      callee: this.lowerExpression(callee),
      argument: {
        kind: "name",
        name: this.resolveDictionary(constraint.className, type, firstArgument.span),
        span: firstArgument.span,
      },
      span: callee.span,
    };
  }

  private resolveDictionary(
    className: string,
    type: HaskellFunctionalType,
    span: FunctionalSpan,
  ): string {
    if (this.#capabilityResolver === null) {
      throw new Error("Haskell capability resolver is absent.");
    }
    const resolution = this.#capabilityResolver.resolve({
      predicate: classPredicate(className),
      inputs: [typeCoreTypeValue(type)],
    });
    if (!resolution.ok) {
      throw new HaskellFunctionalLoweringError(
        span,
        `Cannot resolve ${className} for ${describeHaskellType(type)}: ${resolution.message}.`,
      );
    }
    if (resolution.evidence.witness.kind !== "runtime-dictionary") {
      throw new Error(`Haskell class ${className} resolved without a runtime dictionary.`);
    }
    return resolution.evidence.witness.symbol;
  }

  private lowerCaseExpression(
    expression: Extract<HaskellFunctionalExpression, { readonly kind: "case" }>,
  ): FunctionalSurfaceExpression {
    const lowered = this.compilePatternRows(
      expression.arms.map((arm) => ({
        patterns: [arm.pattern],
        alternatives: [{ condition: null, body: arm.body, span: arm.body.span }],
        whereDefinitions: [],
        bindings: [],
        span: arm.span,
      })),
      [this.lowerExpression(expression.value)],
    );
    if (lowered !== null) return lowered;
    throw new HaskellFunctionalLoweringError(
      expression.span,
      "Case expression has no reachable arm.",
    );
  }

  private lowerRecordExpression(
    expression: Extract<HaskellFunctionalExpression, { readonly kind: "record" }>,
  ): FunctionalSurfaceExpression {
    const constructor = this.requireConstructor(expression.constructor, expression.span);
    const supplied = new Map<string, HaskellFunctionalExpression>();
    for (const field of expression.fields) {
      if (supplied.has(field.name)) {
        throw new HaskellFunctionalLoweringError(
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
        throw new HaskellFunctionalLoweringError(
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

  private compilePatternRows(
    rows: readonly PatternRow[],
    scrutinees: readonly FunctionalSurfaceExpression[],
  ): FunctionalSurfaceExpression | null {
    if (rows.length === 0) return null;
    if (scrutinees.length === 0) return this.compilePatternLeaf(rows);

    const scrutinee = scrutinees[0];
    if (scrutinee === undefined) throw new Error("Haskell pattern compiler omitted its scrutinee.");
    const firstPatterns = rows.map((row) => row.patterns[0]);
    if (firstPatterns.some((pattern) => pattern === undefined)) {
      throw new Error("Haskell pattern row omitted a pattern.");
    }
    if (
      firstPatterns.every((pattern) => pattern?.kind === "variable" || pattern?.kind === "wildcard")
    ) {
      return this.compilePatternRows(
        rows.map((row) => {
          const pattern = row.patterns[0];
          if (pattern === undefined) throw new Error("Haskell pattern row is empty.");
          return {
            ...row,
            patterns: row.patterns.slice(1),
            bindings: pattern.kind === "variable"
              ? [...row.bindings, { name: pattern.name, value: scrutinee }]
              : row.bindings,
          };
        }),
        scrutinees.slice(1),
      );
    }

    let owner: string | undefined;
    for (const pattern of firstPatterns) {
      if (pattern === undefined || pattern.kind === "variable" || pattern.kind === "wildcard") {
        continue;
      }
      const constructor = this.constructorPattern(pattern);
      const shape = this.requireConstructor(constructor.name, pattern.span);
      if (owner !== undefined && owner !== shape.owner) {
        throw new HaskellFunctionalLoweringError(
          pattern.span,
          `Pattern column mixes constructors from ${JSON.stringify(owner)} and ${
            JSON.stringify(shape.owner)
          }.`,
        );
      }
      owner = shape.owner;
    }
    if (owner === undefined) {
      throw new Error("Haskell pattern column omitted its constructor owner.");
    }
    const constructors = this.#constructorsByOwner.get(owner);
    if (constructors === undefined) {
      throw new Error(`Haskell pattern compiler omitted constructors for ${owner}.`);
    }

    const arms = constructors.flatMap((constructorName) => {
      const shape = this.requireConstructor(constructorName, rows[0]?.span ?? this.program.span);
      const binders = shape.fields.map(() => this.freshMatchName());
      const constructorRows: PatternRow[] = [];
      for (const row of rows) {
        const pattern = row.patterns[0];
        if (pattern === undefined) throw new Error("Haskell pattern row is empty.");
        if (pattern.kind === "variable" || pattern.kind === "wildcard") {
          constructorRows.push({
            ...row,
            patterns: [
              ...shape.fields.map(() => ({ kind: "wildcard" as const, span: pattern.span })),
              ...row.patterns.slice(1),
            ],
            bindings: pattern.kind === "variable"
              ? [...row.bindings, { name: pattern.name, value: scrutinee }]
              : row.bindings,
          });
          continue;
        }
        const constructor = this.constructorPattern(pattern);
        if (constructor.name !== constructorName) continue;
        constructorRows.push({
          ...row,
          patterns: [...constructor.arguments, ...row.patterns.slice(1)],
        });
      }
      if (constructorRows.length === 0) return [];
      const body = this.compilePatternRows(
        constructorRows,
        [
          ...binders.map((name) => ({ kind: "name" as const, name, span: shape.span })),
          ...scrutinees.slice(1),
        ],
      );
      if (body === null) return [];
      return [{ constructor: constructorName, binders, body, span: shape.span }];
    });
    return { kind: "case", value: scrutinee, arms, span: rows[0]?.span ?? this.program.span };
  }

  private compilePatternLeaf(rows: readonly PatternRow[]): FunctionalSurfaceExpression | null {
    const row = rows[0];
    if (row === undefined) return null;
    let result: FunctionalSurfaceExpression | null = null;
    for (let index = row.alternatives.length - 1; index >= 0; index--) {
      const alternative = row.alternatives[index];
      if (alternative === undefined) throw new Error(`Haskell guard omitted alternative ${index}.`);
      const body = this.lowerExpression(alternative.body);
      if (
        alternative.condition === null ||
        alternative.condition.kind === "name" && alternative.condition.name === "otherwise"
      ) {
        result = body;
        continue;
      }
      result ??= this.compilePatternLeaf(rows.slice(1));
      if (result === null) {
        throw new HaskellFunctionalLoweringError(
          alternative.span,
          "Guarded equations require an otherwise guard or a following equation.",
        );
      }
      result = {
        kind: "if",
        condition: this.lowerExpression(alternative.condition),
        consequent: body,
        alternate: result,
        span: alternative.span,
      };
    }
    if (result === null) return this.compilePatternLeaf(rows.slice(1));
    result = this.lowerWhereDefinitions(row.whereDefinitions, result);
    for (let index = row.bindings.length - 1; index >= 0; index--) {
      const binding = row.bindings[index];
      if (binding === undefined) throw new Error(`Haskell pattern omitted binding ${index}.`);
      result = {
        kind: "let",
        name: binding.name,
        value: binding.value,
        body: result,
        span: row.span,
      };
    }
    return result;
  }

  private lowerWhereDefinitions(
    definitions: readonly HaskellFunctionalDefinition[],
    expression: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const groups = new Map<string, HaskellFunctionalDefinition[]>();
    for (const definition of definitions) {
      const equations = groups.get(definition.name) ?? [];
      const arity = equations[0]?.parameters.length;
      if (arity !== undefined && arity !== definition.parameters.length) {
        throw new HaskellFunctionalLoweringError(
          definition.span,
          `Local definition ${JSON.stringify(definition.name)} has inconsistent equation arity.`,
        );
      }
      requireUniquePatternBindings(
        definition.parameters,
        definition.span,
        `local definition ${JSON.stringify(definition.name)} patterns`,
      );
      equations.push(definition);
      groups.set(definition.name, equations);
    }
    let body = expression;
    const entries = [...groups.entries()];
    for (let groupIndex = entries.length - 1; groupIndex >= 0; groupIndex--) {
      const entry = entries[groupIndex];
      if (entry === undefined) throw new Error(`Haskell where block omitted group ${groupIndex}.`);
      const [name, equations] = entry;
      const first = equations[0];
      if (first === undefined) throw new Error(`Haskell where definition ${name} has no equation.`);
      const parameters = first.parameters.map((_, index) => `$whereArgument${groupIndex}_${index}`);
      let value = this.compilePatternRows(
        equations.map((equation) => ({
          patterns: equation.parameters,
          alternatives: equation.alternatives,
          whereDefinitions: equation.whereDefinitions,
          bindings: [],
          span: equation.span,
        })),
        parameters.map((parameter) => ({
          kind: "name" as const,
          name: parameter,
          span: first.span,
        })),
      );
      if (value === null) {
        throw new HaskellFunctionalLoweringError(
          first.span,
          `Local definition ${name} is unreachable.`,
        );
      }
      for (let index = parameters.length - 1; index >= 0; index--) {
        const parameter = parameters[index];
        if (parameter === undefined) throw new Error(`Haskell where parameter ${index} is absent.`);
        value = { kind: "lambda", parameter, body: value, span: first.span };
      }
      body = parameters.length === 0
        ? { kind: "let", name, value, body, span: first.span }
        : { kind: "let-rec", name, value, body, span: first.span };
    }
    return body;
  }

  private constructorPattern(pattern: HaskellFunctionalPattern): {
    readonly name: string;
    readonly arguments: readonly HaskellFunctionalPattern[];
  } {
    switch (pattern.kind) {
      case "variable":
      case "wildcard":
        throw new Error("Variable pattern reached constructor normalization.");
      case "list-nil":
        return { name: HASKELL_LIST_NIL, arguments: [] };
      case "list-cons":
        return { name: HASKELL_LIST_CONS, arguments: [pattern.head, pattern.tail] };
      case "tuple":
        return { name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, arguments: pattern.values };
      case "constructor": {
        const shape = this.requireConstructor(pattern.constructor, pattern.span);
        if (shape.fields.length !== pattern.arguments.length) {
          throw new HaskellFunctionalLoweringError(
            pattern.span,
            `Pattern ${
              JSON.stringify(pattern.constructor)
            } supplies ${pattern.arguments.length} fields; ` +
              `the constructor has ${shape.fields.length}.`,
          );
        }
        return { name: pattern.constructor, arguments: pattern.arguments };
      }
      case "record": {
        const shape = this.requireConstructor(pattern.constructor, pattern.span);
        const supplied = new Map<string, HaskellFunctionalPattern>();
        for (const field of pattern.fields) {
          if (supplied.has(field.name)) {
            throw new HaskellFunctionalLoweringError(
              field.span,
              `Pattern ${JSON.stringify(pattern.constructor)} repeats field ${
                JSON.stringify(field.name)
              }.`,
            );
          }
          supplied.set(field.name, field.pattern);
        }
        const arguments_ = shape.fields.map((name) => {
          const field = supplied.get(name);
          supplied.delete(name);
          return field ?? { kind: "wildcard" as const, span: pattern.span };
        });
        this.rejectUnknownField(pattern.constructor, supplied, pattern.span);
        return { name: pattern.constructor, arguments: arguments_ };
      }
    }
  }

  private freshMatchName(): string {
    const name = `$match${this.#matchIndex}`;
    this.#matchIndex++;
    return name;
  }

  private requireConstructor(name: string, span: FunctionalSpan): ConstructorShape {
    const constructor = this.#constructors.get(name);
    if (constructor !== undefined) return constructor;
    throw new HaskellFunctionalLoweringError(
      span,
      `Unknown Haskell constructor ${JSON.stringify(name)}.`,
    );
  }

  private rejectUnknownField(
    constructor: string,
    fields: ReadonlyMap<string, unknown>,
    span: FunctionalSpan,
  ): void {
    const unknown = fields.keys().next().value;
    if (typeof unknown !== "string") return;
    throw new HaskellFunctionalLoweringError(
      span,
      `Record ${JSON.stringify(constructor)} has unknown field ${JSON.stringify(unknown)}.`,
    );
  }
}

function lowerType(type: HaskellFunctionalType): FunctionalTypeSchema {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
    case "list":
    case "parameter":
      if (type.kind === "parameter") return { kind: "parameter", name: type.name };
      if (type.kind === "list") {
        return { kind: "named", name: HASKELL_LIST_TYPE, arguments: [lowerType(type.value)] };
      }
      return { kind: type.kind };
    case "tuple":
      return {
        kind: "tuple",
        values: [lowerType(type.values[0]), lowerType(type.values[1])],
      };
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

function requireDeclaredTypeParameters(
  type: HaskellFunctionalType,
  parameters: ReadonlySet<string>,
  declarationName: string,
): void {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return;
    case "list":
      requireDeclaredTypeParameters(type.value, parameters, declarationName);
      return;
    case "parameter":
      if (parameters.has(type.name)) return;
      throw new HaskellFunctionalLoweringError(
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
  }
}

function haskellListDeclaration(sourceByteLength: number): FunctionalSurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  const parameter: FunctionalTypeSchema = { kind: "parameter", name: "value" };
  return {
    name: HASKELL_LIST_TYPE,
    parameters: ["value"],
    span,
    constructors: [
      { name: HASKELL_LIST_NIL, fields: [], span },
      {
        name: HASKELL_LIST_CONS,
        span,
        fields: [
          { name: "head", type: parameter, span },
          {
            name: "tail",
            type: { kind: "named", name: HASKELL_LIST_TYPE, arguments: [parameter] },
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
  const received = new Set<string>();
  for (const name of names) {
    if (!received.has(name)) {
      received.add(name);
      continue;
    }
    throw new HaskellFunctionalLoweringError(
      span,
      `${location} repeat ${JSON.stringify(name)}.`,
    );
  }
}

function requireUniquePatternBindings(
  patterns: readonly HaskellFunctionalPattern[],
  span: FunctionalSpan,
  location: string,
): void {
  const names: string[] = [];
  for (const pattern of patterns) collectPatternBindings(pattern, names);
  requireUniqueNames(names, span, location);
}

function collectPatternBindings(pattern: HaskellFunctionalPattern, names: string[]): void {
  switch (pattern.kind) {
    case "variable":
      names.push(pattern.name);
      return;
    case "wildcard":
    case "list-nil":
      return;
    case "constructor":
      for (const argument of pattern.arguments) collectPatternBindings(argument, names);
      return;
    case "tuple":
      collectPatternBindings(pattern.values[0], names);
      collectPatternBindings(pattern.values[1], names);
      return;
    case "list-cons":
      collectPatternBindings(pattern.head, names);
      collectPatternBindings(pattern.tail, names);
      return;
    case "record":
      for (const field of pattern.fields) collectPatternBindings(field.pattern, names);
  }
}

function classDictionaryTypeName(className: string): string {
  return `$class$${className}`;
}

function classDictionaryConstructorName(className: string): string {
  return `$class$${className}$dictionary`;
}

function classMethodSelectorName(className: string, methodName: string): string {
  return `$class$${className}$method$${methodName}`;
}

function instanceDictionaryName(className: string, type: HaskellFunctionalType): string {
  return `$instance$${className}$${typeKey(type)}`;
}

function instanceMethodName(
  className: string,
  type: HaskellFunctionalType,
  methodName: string,
): string {
  return `${instanceDictionaryName(className, type)}$method$${methodName}`;
}

function instanceKey(className: string, type: HaskellFunctionalType): string {
  return `${className} ${describeHaskellType(type)}`;
}

function classPredicate(className: string): string {
  return `$haskell-class:${className}`;
}

function typeKey(type: HaskellFunctionalType): string {
  return describeHaskellType(type).replaceAll(/[^A-Za-z0-9]+/g, "_");
}

function describeHaskellType(type: HaskellFunctionalType): string {
  switch (type.kind) {
    case "integer":
      return "Int";
    case "boolean":
      return "Bool";
    case "unit":
      return "()";
    case "parameter":
      return type.name;
    case "list":
      return `[${describeHaskellType(type.value)}]`;
    case "tuple":
      return `(${describeHaskellType(type.values[0])},${describeHaskellType(type.values[1])})`;
    case "named":
      return type.arguments.length === 0
        ? type.name
        : `${type.name} ${type.arguments.map(describeHaskellType).join(" ")}`;
    case "function":
      return `(${describeHaskellType(type.parameter)} -> ${describeHaskellType(type.result)})`;
  }
}

function containsTypeParameter(type: HaskellFunctionalType): boolean {
  switch (type.kind) {
    case "parameter":
      return true;
    case "integer":
    case "boolean":
    case "unit":
      return false;
    case "list":
      return containsTypeParameter(type.value);
    case "tuple":
      return containsTypeParameter(type.values[0]) || containsTypeParameter(type.values[1]);
    case "named":
      return type.arguments.some(containsTypeParameter);
    case "function":
      return containsTypeParameter(type.parameter) || containsTypeParameter(type.result);
  }
}

function substituteTypeParameter(
  type: HaskellFunctionalType,
  parameter: string,
  replacement: HaskellFunctionalType,
): HaskellFunctionalType {
  switch (type.kind) {
    case "parameter":
      return type.name === parameter ? { ...replacement, span: type.span } : type;
    case "integer":
    case "boolean":
    case "unit":
      return type;
    case "list":
      return { ...type, value: substituteTypeParameter(type.value, parameter, replacement) };
    case "tuple":
      return {
        ...type,
        values: [
          substituteTypeParameter(type.values[0], parameter, replacement),
          substituteTypeParameter(type.values[1], parameter, replacement),
        ],
      };
    case "named":
      return {
        ...type,
        arguments: type.arguments.map((argument) =>
          substituteTypeParameter(argument, parameter, replacement)
        ),
      };
    case "function":
      return {
        ...type,
        parameter: substituteTypeParameter(type.parameter, parameter, replacement),
        result: substituteTypeParameter(type.result, parameter, replacement),
      };
  }
}

function capabilityTypePattern(type: HaskellFunctionalType): TypeCoreCapabilityTypePattern {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return { kind: type.kind };
    case "parameter":
      return { kind: "variable", name: type.name };
    case "list":
      return {
        kind: "named",
        name: HASKELL_LIST_TYPE,
        arguments: [{ kind: "type", type: capabilityTypePattern(type.value) }],
      };
    case "tuple":
      return {
        kind: "tuple",
        values: [capabilityTypePattern(type.values[0]), capabilityTypePattern(type.values[1])],
      };
    case "named":
      return {
        kind: "named",
        name: type.name,
        arguments: type.arguments.map((argument) => ({
          kind: "type",
          type: capabilityTypePattern(argument),
        })),
      };
    case "function":
      return {
        kind: "function",
        parameter: capabilityTypePattern(type.parameter),
        result: capabilityTypePattern(type.result),
      };
  }
}

function typeCoreTypeValue(type: HaskellFunctionalType): TypeCoreValue {
  return { kind: "type", type: typeCoreType(type) };
}

function typeCoreType(type: HaskellFunctionalType): TypeCoreType {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return { kind: type.kind };
    case "parameter":
      throw new Error(`Cannot convert type parameter ${type.name} to a closed Type Core value.`);
    case "list":
      return {
        kind: "named",
        name: HASKELL_LIST_TYPE,
        arguments: [typeCoreTypeValue(type.value)],
      };
    case "tuple":
      return {
        kind: "tuple",
        values: [typeCoreType(type.values[0]), typeCoreType(type.values[1])],
      };
    case "named":
      return {
        kind: "named",
        name: type.name,
        arguments: type.arguments.map(typeCoreTypeValue),
      };
    case "function":
      return {
        kind: "function",
        parameter: typeCoreType(type.parameter),
        result: typeCoreType(type.result),
      };
  }
}

function firstFunctionParameter(type: HaskellFunctionalType): HaskellFunctionalType | null {
  return type.kind === "function" ? type.parameter : null;
}

function inferConcreteExpressionType(
  expression: HaskellFunctionalExpression,
  constructors: ReadonlyMap<string, ConstructorShape>,
  signatures: ReadonlyMap<string, HaskellFunctionalTypeSignature>,
): HaskellFunctionalType | null {
  switch (expression.kind) {
    case "integer":
      return { kind: "integer", span: expression.span };
    case "boolean":
      return { kind: "boolean", span: expression.span };
    case "unit":
      return { kind: "unit", span: expression.span };
    case "name": {
      const signature = signatures.get(expression.name);
      return signature === undefined || signature.constraints.length > 0 ||
          containsTypeParameter(signature.type)
        ? null
        : signature.type;
    }
    case "tuple": {
      const first = inferConcreteExpressionType(expression.values[0], constructors, signatures);
      const second = inferConcreteExpressionType(expression.values[1], constructors, signatures);
      return first === null || second === null
        ? null
        : { kind: "tuple", values: [first, second], span: expression.span };
    }
    case "record": {
      const shape = constructors.get(expression.constructor);
      return shape === undefined
        ? null
        : { kind: "named", name: shape.owner, arguments: [], span: expression.span };
    }
    default:
      return null;
  }
}

function combine(start: FunctionalSpan, end: FunctionalSpan): FunctionalSpan {
  return { startByte: start.startByte, endByte: end.endByte };
}
