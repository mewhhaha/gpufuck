import type { SweepDiagnostic } from "./parser.ts";
import type {
  SweepExpression,
  SweepFunction,
  SweepModule,
  SweepSpan,
  SweepType,
  SweepTypeDeclaration,
} from "./ast.ts";

type PrimitiveType =
  | { readonly kind: "integer" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" };

interface ParameterType {
  readonly kind: "parameter";
  readonly identity: string;
  readonly name: string;
}

interface NamedType {
  readonly kind: "named";
  readonly declaration: TypeDeclaration;
  readonly arguments: readonly CheckedType[];
}

interface FunctionType {
  readonly kind: "function";
  readonly parameters: readonly CheckedType[];
  readonly result: CheckedType;
}

type CheckedType = PrimitiveType | ParameterType | NamedType | FunctionType;

interface TypeDeclaration {
  readonly source: SweepTypeDeclaration;
  readonly parameters: readonly ParameterType[];
}

interface ConstructorDeclaration {
  readonly name: string;
  readonly owner: TypeDeclaration;
  readonly fields: readonly CheckedType[];
}

interface FunctionDeclaration {
  readonly source: SweepFunction;
  readonly parameters: readonly ParameterType[];
  readonly arguments: readonly CheckedType[];
  readonly result: CheckedType;
}

export interface SweepCheckingConstraint {
  readonly expected: number;
  readonly received: number;
  readonly diagnostic: SweepDiagnostic;
}

export interface SweepCheckingPlan {
  readonly constraintWords: Uint32Array<ArrayBuffer>;
  readonly constraints: readonly SweepCheckingConstraint[];
}

export type SweepCheckingPlanResult =
  | { readonly ok: true; readonly plan: SweepCheckingPlan }
  | { readonly ok: false; readonly diagnostics: readonly SweepDiagnostic[] };

class CheckingPlanError extends Error {
  constructor(readonly diagnostic: SweepDiagnostic) {
    super(diagnostic.message);
  }
}

class SweepCheckingPlanner {
  readonly #module: SweepModule;
  readonly #types = new Map<string, TypeDeclaration>();
  readonly #constructors = new Map<string, ConstructorDeclaration>();
  readonly #functions = new Map<string, FunctionDeclaration>();
  readonly #constraints: SweepCheckingConstraint[] = [];
  readonly #typeIds = new Map<string, number>();

  constructor(module: SweepModule) {
    this.#module = module;
  }

  plan(): SweepCheckingPlan {
    this.#declareTypes();
    this.#declareFunctions();
    for (const fn of this.#module.functions) this.#planFunction(fn);
    const constraintWords = new Uint32Array(this.#constraints.length * 2);
    for (const [index, constraint] of this.#constraints.entries()) {
      constraintWords[index * 2] = constraint.expected;
      constraintWords[index * 2 + 1] = constraint.received;
    }
    return Object.freeze({
      constraintWords,
      constraints: Object.freeze([...this.#constraints]),
    });
  }

  #declareTypes(): void {
    for (const source of this.#module.types) {
      if (this.#types.has(source.name)) {
        this.#fail(`type ${JSON.stringify(source.name)} is declared more than once`, source.span);
      }
      const parameterNames = new Set<string>();
      const parameters = source.parameters.map((name, index): ParameterType => {
        if (parameterNames.has(name)) {
          this.#fail(
            `type ${JSON.stringify(source.name)} declares type parameter ${
              JSON.stringify(name)
            } more than once`,
            source.span,
          );
        }
        parameterNames.add(name);
        return {
          kind: "parameter",
          identity: `type:${index}:${source.name}:${name}`,
          name,
        };
      });
      this.#types.set(source.name, { source, parameters });
    }

    for (const declaration of this.#types.values()) {
      const parameterScope = new Map(
        declaration.parameters.map((parameter) => [parameter.name, parameter]),
      );
      for (const constructor of declaration.source.constructors) {
        if (this.#constructors.has(constructor.name)) {
          this.#fail(
            `constructor ${JSON.stringify(constructor.name)} is declared more than once`,
            constructor.span,
          );
        }
        this.#constructors.set(constructor.name, {
          name: constructor.name,
          owner: declaration,
          fields: constructor.fields.map((field) =>
            this.#resolveType(field.type, parameterScope, constructor.span)
          ),
        });
      }
    }
  }

  #declareFunctions(): void {
    for (const source of this.#module.functions) {
      if (this.#functions.has(source.name)) {
        this.#fail(
          `function ${JSON.stringify(source.name)} is declared more than once`,
          source.span,
        );
      }
      const parameterNames = new Set<string>();
      const parameters = source.typeParameters.map((name, index): ParameterType => {
        if (parameterNames.has(name)) {
          this.#fail(
            `function ${JSON.stringify(source.name)} declares type parameter ${
              JSON.stringify(name)
            } more than once`,
            source.span,
          );
        }
        parameterNames.add(name);
        return {
          kind: "parameter",
          identity: `function:${index}:${source.name}:${name}`,
          name,
        };
      });
      if (source.name === "main" && parameters.length !== 0) {
        this.#fail('entry function "main" cannot declare type parameters', source.span);
      }
      const parameterScope = new Map(parameters.map((parameter) => [parameter.name, parameter]));
      this.#functions.set(source.name, {
        source,
        parameters,
        arguments: source.parameters.map((parameter) =>
          this.#resolveType(parameter.type, parameterScope, source.span)
        ),
        result: this.#resolveType(source.result, parameterScope, source.span),
      });
    }
  }

  #planFunction(fn: SweepFunction): void {
    const declaration = this.#functions.get(fn.name);
    if (declaration === undefined) {
      throw new Error(`Sweep checking plan omitted function ${JSON.stringify(fn.name)}`);
    }
    const environment = new Map<string, CheckedType>();
    for (const [index, parameter] of fn.parameters.entries()) {
      if (environment.has(parameter.name)) {
        this.#fail(
          `parameter ${JSON.stringify(parameter.name)} is declared more than once in ${
            JSON.stringify(fn.name)
          }`,
          fn.span,
        );
      }
      environment.set(parameter.name, declaration.arguments[index]!);
    }
    this.#planExpression(
      fn.body,
      declaration.result,
      environment,
      new Map(declaration.parameters.map((parameter) => [parameter.name, parameter])),
      `function ${JSON.stringify(fn.name)} result`,
    );
  }

  #planExpression(
    expression: SweepExpression,
    expected: CheckedType | undefined,
    environment: ReadonlyMap<string, CheckedType>,
    typeParameters: ReadonlyMap<string, ParameterType>,
    context: string,
  ): CheckedType {
    let received: CheckedType;
    switch (expression.kind) {
      case "integer":
        received = INTEGER_TYPE;
        break;
      case "boolean":
        received = BOOLEAN_TYPE;
        break;
      case "name":
        received = this.#nameType(expression.name, environment, expression.span);
        break;
      case "binary": {
        if (expression.operator === "equal") {
          const operand = this.#planExpression(
            expression.left,
            undefined,
            environment,
            typeParameters,
            "equality left operand",
          );
          this.#planExpression(
            expression.right,
            operand,
            environment,
            typeParameters,
            "equality right operand",
          );
          received = BOOLEAN_TYPE;
          break;
        }
        this.#planExpression(
          expression.left,
          INTEGER_TYPE,
          environment,
          typeParameters,
          `${expression.operator} left operand`,
        );
        this.#planExpression(
          expression.right,
          INTEGER_TYPE,
          environment,
          typeParameters,
          `${expression.operator} right operand`,
        );
        received = expression.operator === "add" || expression.operator === "subtract" ||
            expression.operator === "multiply"
          ? INTEGER_TYPE
          : BOOLEAN_TYPE;
        break;
      }
      case "let": {
        const bindingType = this.#resolveType(expression.type, typeParameters, expression.span);
        this.#planExpression(
          expression.value,
          bindingType,
          environment,
          typeParameters,
          `let ${JSON.stringify(expression.name)} value`,
        );
        const bodyEnvironment = new Map(environment);
        bodyEnvironment.set(expression.name, bindingType);
        received = this.#planExpression(
          expression.body,
          expected,
          bodyEnvironment,
          typeParameters,
          context,
        );
        expected = undefined;
        break;
      }
      case "if": {
        this.#planExpression(
          expression.condition,
          BOOLEAN_TYPE,
          environment,
          typeParameters,
          "if condition",
        );
        const consequent = this.#planExpression(
          expression.consequent,
          expected,
          environment,
          typeParameters,
          "if consequent",
        );
        this.#planExpression(
          expression.alternate,
          expected ?? consequent,
          environment,
          typeParameters,
          "if alternate",
        );
        received = consequent;
        break;
      }
      case "call":
        received = this.#planCall(expression, environment, typeParameters);
        break;
      case "construct":
        received = this.#planConstruction(expression, expected, environment, typeParameters);
        break;
      case "match":
        received = this.#planMatch(expression, expected, environment, typeParameters);
        break;
    }
    if (expected !== undefined) this.#constrain(expected, received, expression.span, context);
    return received;
  }

  #planCall(
    expression: Extract<SweepExpression, { readonly kind: "call" }>,
    environment: ReadonlyMap<string, CheckedType>,
    typeParameters: ReadonlyMap<string, ParameterType>,
  ): CheckedType {
    const local = environment.get(expression.callee);
    let callable: FunctionType;
    if (local !== undefined) {
      if (expression.typeArguments.length !== 0) {
        this.#fail(
          `local function ${JSON.stringify(expression.callee)} cannot receive type arguments`,
          expression.span,
        );
      }
      if (local.kind !== "function") {
        this.#fail(
          `${JSON.stringify(expression.callee)} has type ${
            this.#formatType(local)
          } and is not callable`,
          expression.span,
        );
      }
      callable = local;
    } else {
      const declaration = this.#functions.get(expression.callee);
      if (declaration === undefined) {
        this.#fail(`unknown function ${JSON.stringify(expression.callee)}`, expression.span);
      }
      if (expression.typeArguments.length !== declaration.parameters.length) {
        this.#fail(
          `function ${
            JSON.stringify(expression.callee)
          } expects ${declaration.parameters.length} type arguments; received ${expression.typeArguments.length}`,
          expression.span,
        );
      }
      const substitutions = new Map<string, CheckedType>();
      for (const [index, parameter] of declaration.parameters.entries()) {
        substitutions.set(
          parameter.identity,
          this.#resolveType(expression.typeArguments[index]!, typeParameters, expression.span),
        );
      }
      callable = {
        kind: "function",
        parameters: declaration.arguments.map((argument) =>
          this.#substitute(argument, substitutions)
        ),
        result: this.#substitute(declaration.result, substitutions),
      };
    }
    if (expression.arguments.length !== callable.parameters.length) {
      this.#fail(
        `call to ${
          JSON.stringify(expression.callee)
        } expects ${callable.parameters.length} arguments; received ${expression.arguments.length}`,
        expression.span,
      );
    }
    for (const [index, argument] of expression.arguments.entries()) {
      this.#planExpression(
        argument,
        callable.parameters[index],
        environment,
        typeParameters,
        `argument ${index + 1} of ${JSON.stringify(expression.callee)}`,
      );
    }
    return callable.result;
  }

  #planConstruction(
    expression: Extract<SweepExpression, { readonly kind: "construct" }>,
    expected: CheckedType | undefined,
    environment: ReadonlyMap<string, CheckedType>,
    typeParameters: ReadonlyMap<string, ParameterType>,
  ): CheckedType {
    const constructor = this.#constructors.get(expression.constructor);
    if (constructor === undefined) {
      this.#fail(`unknown constructor ${JSON.stringify(expression.constructor)}`, expression.span);
    }
    let arguments_: readonly CheckedType[];
    if (expression.typeArguments.length !== 0) {
      if (expression.typeArguments.length !== constructor.owner.parameters.length) {
        this.#fail(
          `constructor ${
            JSON.stringify(expression.constructor)
          } expects ${constructor.owner.parameters.length} type arguments; received ${expression.typeArguments.length}`,
          expression.span,
        );
      }
      arguments_ = expression.typeArguments.map((argument) =>
        this.#resolveType(argument, typeParameters, expression.span)
      );
    } else if (constructor.owner.parameters.length === 0) {
      arguments_ = [];
    } else if (expected?.kind === "named" && expected.declaration === constructor.owner) {
      arguments_ = expected.arguments;
    } else {
      this.#fail(
        `constructor ${
          JSON.stringify(expression.constructor)
        } needs ${constructor.owner.parameters.length} explicit type arguments or an expected ${constructor.owner.source.name} type`,
        expression.span,
      );
    }
    const substitutions = new Map(
      constructor.owner.parameters.map((parameter, index) => [
        parameter.identity,
        arguments_[index]!,
      ]),
    );
    const fields = constructor.fields.map((field) => this.#substitute(field, substitutions));
    if (expression.arguments.length !== fields.length) {
      this.#fail(
        `constructor ${
          JSON.stringify(expression.constructor)
        } expects ${fields.length} fields; received ${expression.arguments.length}`,
        expression.span,
      );
    }
    for (const [index, argument] of expression.arguments.entries()) {
      this.#planExpression(
        argument,
        fields[index],
        environment,
        typeParameters,
        `field ${index + 1} of ${JSON.stringify(expression.constructor)}`,
      );
    }
    return { kind: "named", declaration: constructor.owner, arguments: arguments_ };
  }

  #planMatch(
    expression: Extract<SweepExpression, { readonly kind: "match" }>,
    expected: CheckedType | undefined,
    environment: ReadonlyMap<string, CheckedType>,
    typeParameters: ReadonlyMap<string, ParameterType>,
  ): CheckedType {
    const subject = this.#planExpression(
      expression.subject,
      undefined,
      environment,
      typeParameters,
      "match subject",
    );
    if (subject.kind !== "named") {
      this.#fail(
        `match subject has type ${this.#formatType(subject)}; expected a nominal type`,
        expression.subject.span,
      );
    }
    if (expression.arms.length === 0) {
      this.#fail("match expression has no arms", expression.span);
    }
    const substitutions = new Map(
      subject.declaration.parameters.map((parameter, index) => [
        parameter.identity,
        subject.arguments[index]!,
      ]),
    );
    const remaining = new Set(
      subject.declaration.source.constructors.map((constructor) => constructor.name),
    );
    let result: CheckedType | undefined;
    for (const arm of expression.arms) {
      const constructor = this.#constructors.get(arm.constructor);
      if (constructor === undefined || constructor.owner !== subject.declaration) {
        this.#fail(
          `constructor ${
            JSON.stringify(arm.constructor)
          } does not belong to ${subject.declaration.source.name}`,
          arm.span,
        );
      }
      if (!remaining.delete(arm.constructor)) {
        this.#fail(
          `match contains constructor ${JSON.stringify(arm.constructor)} more than once`,
          arm.span,
        );
      }
      if (arm.binders.length !== constructor.fields.length) {
        this.#fail(
          `constructor ${
            JSON.stringify(arm.constructor)
          } binds ${arm.binders.length} fields; expected ${constructor.fields.length}`,
          arm.span,
        );
      }
      const armEnvironment = new Map(environment);
      for (const [index, binder] of arm.binders.entries()) {
        armEnvironment.set(
          binder,
          this.#substitute(constructor.fields[index]!, substitutions),
        );
      }
      const body = this.#planExpression(
        arm.body,
        expected ?? result,
        armEnvironment,
        typeParameters,
        `match arm ${JSON.stringify(arm.constructor)}`,
      );
      result ??= body;
    }
    if (remaining.size !== 0) {
      this.#fail(
        `match on ${subject.declaration.source.name} omits ${
          [...remaining].map((name) => JSON.stringify(name)).join(", ")
        }`,
        expression.span,
      );
    }
    if (result === undefined) throw new Error("non-empty Sweep match omitted its result type");
    return result;
  }

  #nameType(
    name: string,
    environment: ReadonlyMap<string, CheckedType>,
    span: SweepSpan,
  ): CheckedType {
    const local = environment.get(name);
    if (local !== undefined) return local;
    const fn = this.#functions.get(name);
    if (fn === undefined) this.#fail(`unknown name ${JSON.stringify(name)}`, span);
    if (fn.parameters.length !== 0) {
      this.#fail(
        `generic function ${JSON.stringify(name)} requires an explicit call with type arguments`,
        span,
      );
    }
    return { kind: "function", parameters: fn.arguments, result: fn.result };
  }

  #resolveType(
    type: SweepType,
    parameters: ReadonlyMap<string, ParameterType>,
    span: SweepSpan,
  ): CheckedType {
    if (type.kind === "parameter") {
      const parameter = parameters.get(type.name);
      if (parameter === undefined) {
        this.#fail(`type parameter ${JSON.stringify(type.name)} is not in scope`, span);
      }
      return parameter;
    }
    if (type.kind === "function") {
      return {
        kind: "function",
        parameters: type.parameters.map((parameter) =>
          this.#resolveType(parameter, parameters, span)
        ),
        result: this.#resolveType(type.result, parameters, span),
      };
    }
    if (type.name === "Int" || type.name === "Bool" || type.name === "Unit") {
      if (type.arguments.length !== 0) {
        this.#fail(`primitive type ${type.name} does not accept type arguments`, span);
      }
      return type.name === "Int" ? INTEGER_TYPE : type.name === "Bool" ? BOOLEAN_TYPE : UNIT_TYPE;
    }
    const declaration = this.#types.get(type.name);
    if (declaration === undefined) this.#fail(`unknown type ${JSON.stringify(type.name)}`, span);
    if (type.arguments.length !== declaration.parameters.length) {
      this.#fail(
        `type ${
          JSON.stringify(type.name)
        } expects ${declaration.parameters.length} arguments; received ${type.arguments.length}`,
        span,
      );
    }
    return {
      kind: "named",
      declaration,
      arguments: type.arguments.map((argument) => this.#resolveType(argument, parameters, span)),
    };
  }

  #substitute(type: CheckedType, substitutions: ReadonlyMap<string, CheckedType>): CheckedType {
    if (type.kind === "parameter") return substitutions.get(type.identity) ?? type;
    if (type.kind === "named") {
      return {
        ...type,
        arguments: type.arguments.map((argument) => this.#substitute(argument, substitutions)),
      };
    }
    if (type.kind === "function") {
      return {
        kind: "function",
        parameters: type.parameters.map((parameter) => this.#substitute(parameter, substitutions)),
        result: this.#substitute(type.result, substitutions),
      };
    }
    return type;
  }

  #constrain(
    expected: CheckedType,
    received: CheckedType,
    span: SweepSpan,
    context: string,
  ): void {
    this.#constraints.push({
      expected: this.#typeId(expected),
      received: this.#typeId(received),
      diagnostic: {
        message: `${context} has type ${this.#formatType(received)}; expected ${
          this.#formatType(expected)
        }`,
        span,
      },
    });
  }

  #typeId(type: CheckedType): number {
    const key = this.#typeKey(type);
    const existing = this.#typeIds.get(key);
    if (existing !== undefined) return existing;
    const id = this.#typeIds.size;
    this.#typeIds.set(key, id);
    return id;
  }

  #typeKey(type: CheckedType): string {
    if (type.kind === "parameter") return `p:${type.identity}`;
    if (type.kind === "named") {
      return `n:${type.declaration.source.name}[${
        type.arguments.map((argument) => this.#typeKey(argument)).join(",")
      }]`;
    }
    if (type.kind === "function") {
      return `f:(${type.parameters.map((parameter) => this.#typeKey(parameter)).join(",")})=>${
        this.#typeKey(type.result)
      }`;
    }
    return type.kind;
  }

  #formatType(type: CheckedType): string {
    if (type.kind === "integer") return "Int";
    if (type.kind === "boolean") return "Bool";
    if (type.kind === "unit") return "Unit";
    if (type.kind === "parameter") return type.name;
    if (type.kind === "function") {
      return `(${type.parameters.map((parameter) => this.#formatType(parameter)).join(", ")}) -> ${
        this.#formatType(type.result)
      }`;
    }
    return type.arguments.length === 0
      ? type.declaration.source.name
      : `${type.declaration.source.name}[${
        type.arguments.map((argument) => this.#formatType(argument)).join(", ")
      }]`;
  }

  #fail(message: string, span: SweepSpan): never {
    throw new CheckingPlanError({ message, span });
  }
}

const INTEGER_TYPE: PrimitiveType = Object.freeze({ kind: "integer" });
const BOOLEAN_TYPE: PrimitiveType = Object.freeze({ kind: "boolean" });
const UNIT_TYPE: PrimitiveType = Object.freeze({ kind: "unit" });

export function createSweepCheckingPlan(module: SweepModule): SweepCheckingPlanResult {
  try {
    return { ok: true, plan: new SweepCheckingPlanner(module).plan() };
  } catch (error) {
    if (error instanceof CheckingPlanError) {
      return { ok: false, diagnostics: [error.diagnostic] };
    }
    throw error;
  }
}
