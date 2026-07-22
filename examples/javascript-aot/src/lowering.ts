import {
  type EncodedFunctionalModule,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  FunctionalUnaryOperator,
} from "../../../src/functional/abi.ts";
import {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  type FunctionalSurfaceTypeDeclaration,
} from "../../../src/functional/surface_builder.ts";
import {
  JAVASCRIPT_ARRAY_ELEMENT,
  JAVASCRIPT_ARRAY_EMPTY,
  JAVASCRIPT_ARRAY_INDEX,
  JAVASCRIPT_ARRAY_LENGTH,
  JAVASCRIPT_ARRAY_MAP,
  JAVASCRIPT_ARRAY_REDUCE,
  javascriptArraySurface,
} from "./array.ts";
import type {
  JavaScriptAotBinaryOperator,
  JavaScriptAotDeclaration,
  JavaScriptAotExpression,
  JavaScriptAotModule,
  JavaScriptAotStatement,
} from "./ast.ts";
import { JavaScriptAotLoweringError } from "./diagnostic.ts";

export interface LoweredJavaScriptAotModule {
  readonly sourceModule: JavaScriptAotModule;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly module: EncodedFunctionalModule;
}

export interface JavaScriptAotLoweringOptions {
  readonly runtimeFaultConstructors?: ReadonlyMap<string, string>;
  readonly exceptionConstructors?: ReadonlySet<string>;
}

interface JavaScriptAotBinding {
  readonly coreName: string;
  readonly functionArity: number | null;
  readonly functionLength: number | null;
  readonly throwsAcrossCalls: boolean;
  readonly zeroArgumentApplication: boolean;
  readonly constantValue: JavaScriptAotExpression | null;
  readonly objectFields: readonly string[] | null;
  readonly mutable: boolean;
  readonly assignable: boolean;
}

interface JavaScriptAotObjectShape {
  readonly typeName: string;
  readonly constructorName: string;
  readonly fields: readonly string[];
}

interface LoweredJavaScriptAotFunction {
  readonly parameters: readonly string[];
  readonly body: FunctionalSurfaceExpression;
}

type JavaScriptPrimitiveConstant =
  | Extract<JavaScriptAotExpression, { readonly kind: "number" | "string" | "boolean" | "null" }>
  | { readonly kind: "undefined" };

const JAVASCRIPT_NULLISH_TYPE = "$JavaScriptNullish";
const JAVASCRIPT_NULL = "$JavaScriptNull";
const JAVASCRIPT_UNDEFINED = "$JavaScriptUndefined";
const JAVASCRIPT_ERROR_TYPE = "$JavaScriptError";
const JAVASCRIPT_OBJECT_GLOBALS = new Set(["Atomics", "Intl", "JSON", "Math", "Reflect"]);
const JAVASCRIPT_NUMBER_CONSTANTS: Readonly<Record<string, number>> = Object.freeze({
  EPSILON: Number.EPSILON,
  MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  MAX_VALUE: Number.MAX_VALUE,
  MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  MIN_VALUE: Number.MIN_VALUE,
  NEGATIVE_INFINITY: Number.NEGATIVE_INFINITY,
  NaN: Number.NaN,
  POSITIVE_INFINITY: Number.POSITIVE_INFINITY,
});
const JAVASCRIPT_ERROR_CONSTRUCTORS = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);
const JAVASCRIPT_BITWISE_OPERATORS = new Set<JavaScriptAotBinaryOperator>([
  "<<",
  ">>",
  ">>>",
  "&",
  "^",
  "|",
]);
const JAVASCRIPT_AOT_MAXIMUM_TRY_CONTINUATION_DEPTH = 128;

type JavaScriptAotEnvironment = ReadonlyMap<string, JavaScriptAotBinding>;
type JavaScriptAotThrowContinuation = (
  value: FunctionalSurfaceExpression,
  environment: JavaScriptAotEnvironment,
  constantValue: JavaScriptAotExpression | null,
) => FunctionalSurfaceExpression;
type JavaScriptAotReturnContinuation = (
  value: FunctionalSurfaceExpression,
  environment: JavaScriptAotEnvironment,
) => FunctionalSurfaceExpression;
type JavaScriptAotControlContinuation = (
  environment: JavaScriptAotEnvironment,
) => FunctionalSurfaceExpression;
type JavaScriptAotValueContinuation = (
  value: FunctionalSurfaceExpression,
) => FunctionalSurfaceExpression;

const binaryOperators: Readonly<Partial<Record<string, FunctionalBinaryOperator>>> = {
  "+": FunctionalBinaryOperator.AddFloat64,
  "-": FunctionalBinaryOperator.SubtractFloat64,
  "*": FunctionalBinaryOperator.MultiplyFloat64,
  "/": FunctionalBinaryOperator.DivideFloat64,
  "%": FunctionalBinaryOperator.RemainderFloat64,
  "<": FunctionalBinaryOperator.LessFloat64,
  "<=": FunctionalBinaryOperator.LessEqualFloat64,
  ">": FunctionalBinaryOperator.GreaterFloat64,
  ">=": FunctionalBinaryOperator.GreaterEqualFloat64,
  "===": FunctionalBinaryOperator.StructuralEqual,
  "!==": FunctionalBinaryOperator.StructuralNotEqual,
};

export function lowerJavaScriptAotModule(
  sourceModule: JavaScriptAotModule,
  entryName = "main",
  options: JavaScriptAotLoweringOptions = {},
): LoweredJavaScriptAotModule {
  const lowering = new JavaScriptAotLowering(sourceModule, entryName, options);
  return lowering.lower();
}

class JavaScriptAotLowering {
  readonly #topLevelBindings = new Map<string, JavaScriptAotBinding>();
  #bindingIndex = 0;
  #usesArrays = false;
  #usesNullish = false;
  readonly #usedExceptionConstructors = new Set<string>();
  readonly #arrayDefinitions = new Set<string>();
  readonly #objectShapes = new Map<string, JavaScriptAotObjectShape>();
  readonly #assignmentIndexes = new WeakMap<
    readonly JavaScriptAotStatement[],
    ReadonlyMap<string, number>
  >();
  #activeTryContinuations = 0;

  constructor(
    private readonly sourceModule: JavaScriptAotModule,
    private readonly entryName: string,
    private readonly options: JavaScriptAotLoweringOptions,
  ) {}

  lower(): LoweredJavaScriptAotModule {
    this.indexTopLevelBindings();
    const entry = this.requireEntry();
    const definitions: FunctionalSurfaceDefinition[] = [];
    const initializedConstants = new Map(
      [...this.#topLevelBindings].filter(([, binding]) => binding.functionArity !== null),
    );
    for (const declaration of this.sourceModule.declarations) {
      const environment = declaration.kind === "function"
        ? this.#topLevelBindings
        : initializedConstants;
      definitions.push(this.lowerDefinition(declaration, environment));
      if (declaration.kind === "constant") {
        initializedConstants.set(declaration.name, this.#topLevelBindings.get(declaration.name)!);
      }
    }
    const arraySurface = this.#usesArrays
      ? javascriptArraySurface(this.sourceModule.span.endByte, this.#arrayDefinitions)
      : { definitions: [], typeDeclarations: [] };
    definitions.push(...arraySurface.definitions);
    const typeDeclarations: FunctionalSurfaceTypeDeclaration[] = [
      ...arraySurface.typeDeclarations,
    ];
    const syntheticSpan = {
      startByte: this.sourceModule.span.endByte,
      endByte: this.sourceModule.span.endByte,
    };
    for (const shape of this.#objectShapes.values()) {
      typeDeclarations.push({
        name: shape.typeName,
        parameters: shape.fields.map((_, index) => `field${index}`),
        span: syntheticSpan,
        constructors: [{
          name: shape.constructorName,
          span: syntheticSpan,
          fields: shape.fields.map((name, index) => ({
            name,
            type: { kind: "parameter", name: `field${index}` },
            span: syntheticSpan,
          })),
        }],
      });
    }
    if (this.#usesNullish) {
      typeDeclarations.push({
        name: JAVASCRIPT_NULLISH_TYPE,
        parameters: [],
        span: syntheticSpan,
        constructors: [
          { name: JAVASCRIPT_UNDEFINED, fields: [], span: syntheticSpan },
          { name: JAVASCRIPT_NULL, fields: [], span: syntheticSpan },
        ],
      });
    }
    if (this.#usedExceptionConstructors.size !== 0) {
      typeDeclarations.push({
        name: JAVASCRIPT_ERROR_TYPE,
        parameters: [],
        span: syntheticSpan,
        constructors: [...this.#usedExceptionConstructors].sort().map((name) => ({
          name: javascriptExceptionConstructorName(name),
          fields: [],
          span: syntheticSpan,
        })),
      });
    }
    return {
      sourceModule: this.sourceModule,
      definitions,
      module: buildFunctionalSurfaceModule(
        definitions,
        typeDeclarations,
        entry.name,
        this.sourceModule.span.endByte,
        { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
      ),
    };
  }

  private indexTopLevelBindings(): void {
    for (const declaration of this.sourceModule.declarations) {
      const previous = this.#topLevelBindings.get(declaration.name);
      if (previous !== undefined) {
        throw new JavaScriptAotLoweringError(
          declaration.span,
          `JavaScript module ${JSON.stringify(this.sourceModule.name)} declares ${
            JSON.stringify(declaration.name)
          } more than once.`,
        );
      }
      this.#topLevelBindings.set(declaration.name, {
        coreName: declaration.name,
        functionArity: declaration.kind === "function" ? declaration.parameters.length : null,
        functionLength: declaration.kind === "function"
          ? declaration.parameterLength ?? declaration.parameters.length
          : null,
        throwsAcrossCalls: declaration.kind === "function" &&
          statementsMayEscapeThrow(declaration.body),
        zeroArgumentApplication: declaration.kind === "function" &&
          declaration.parameters.length === 0 && declaration.name !== this.entryName,
        constantValue: declaration.kind === "constant"
          ? constantExpression(declaration.value)
          : null,
        objectFields: objectFields(declaration.kind === "constant" ? declaration.value : null),
        mutable: false,
        assignable: false,
      });
    }
  }

  private requireEntry(): JavaScriptAotDeclaration {
    const entry = this.sourceModule.declarations.find((declaration) =>
      declaration.name === this.entryName
    );
    if (entry === undefined) {
      throw new JavaScriptAotLoweringError(
        this.sourceModule.span,
        `JavaScript module ${JSON.stringify(this.sourceModule.name)} must export ${
          JSON.stringify(this.entryName)
        } as its AOT entry.`,
      );
    }
    if (!entry.exported) {
      throw new JavaScriptAotLoweringError(
        entry.span,
        `JavaScript AOT entry ${JSON.stringify(this.entryName)} must be exported.`,
      );
    }
    if (entry.kind === "function" && entry.parameters.length !== 0) {
      throw new JavaScriptAotLoweringError(
        entry.span,
        `JavaScript AOT entry ${
          JSON.stringify(this.entryName)
        } has ${entry.parameters.length} parameters; expected none.`,
      );
    }
    return entry;
  }

  private lowerDefinition(
    declaration: JavaScriptAotDeclaration,
    environment: JavaScriptAotEnvironment,
  ): FunctionalSurfaceDefinition {
    if (declaration.kind === "constant") {
      return {
        name: declaration.name,
        parameters: [],
        annotation: null,
        body: this.lowerExpression(declaration.value, environment),
        span: declaration.span,
      };
    }
    const loweredFunction = this.lowerFunction(
      declaration.parameters,
      declaration.body,
      environment,
      declaration.span,
      `JavaScript function ${JSON.stringify(declaration.name)}`,
      declaration.name === this.entryName ? "entry" : "callable",
      declaration.name !== this.entryName &&
        this.#topLevelBindings.get(declaration.name)?.throwsAcrossCalls === true,
    );
    return {
      name: declaration.name,
      parameters: loweredFunction.parameters,
      annotation: null,
      body: loweredFunction.body,
      span: declaration.span,
    };
  }

  private lowerFunction(
    parameters: readonly string[],
    statements: readonly JavaScriptAotStatement[],
    capturedEnvironment: JavaScriptAotEnvironment,
    span: { readonly startByte: number; readonly endByte: number },
    description: string,
    zeroParameterConvention: "entry" | "callable",
    throwsAcrossCalls: boolean,
  ): LoweredJavaScriptAotFunction {
    const parameterNames = new Set<string>();
    const functionEnvironment = new Map<string, JavaScriptAotBinding>();
    const assignmentIndexes = this.assignmentIndexes(statements);
    for (const [name, binding] of capturedEnvironment) {
      functionEnvironment.set(name, { ...binding, assignable: false });
    }
    const coreParameters = parameters.map((parameter) => {
      if (parameterNames.has(parameter)) {
        throw new JavaScriptAotLoweringError(
          span,
          `${description} repeats parameter ${JSON.stringify(parameter)}.`,
        );
      }
      parameterNames.add(parameter);
      const coreName = this.freshBindingName(parameter);
      const mayBeAssigned = assignmentIndexes.has(parameter);
      functionEnvironment.set(parameter, {
        coreName,
        functionArity: null,
        functionLength: null,
        throwsAcrossCalls: false,
        zeroArgumentApplication: false,
        constantValue: null,
        objectFields: null,
        mutable: mayBeAssigned,
        assignable: mayBeAssigned,
      });
      return coreName;
    });
    if (parameters.length === 0 && zeroParameterConvention === "callable") {
      coreParameters.push(this.freshBindingName("unit"));
    }
    const returnContinuationName = throwsAcrossCalls
      ? this.freshBindingName("returnContinuation")
      : null;
    const throwContinuationName = throwsAcrossCalls
      ? this.freshBindingName("throwContinuation")
      : null;
    if (returnContinuationName !== null && throwContinuationName !== null) {
      coreParameters.push(returnContinuationName, throwContinuationName);
    }
    const hoistedBindings: JavaScriptAotBinding[] = [];
    for (const name of collectVarNames(statements)) {
      if (parameterNames.has(name)) continue;
      const binding = {
        coreName: this.freshBindingName(name),
        functionArity: null,
        functionLength: null,
        throwsAcrossCalls: false,
        zeroArgumentApplication: false,
        constantValue: null,
        objectFields: null,
        mutable: true,
        assignable: true,
      };
      functionEnvironment.set(name, binding);
      hoistedBindings.push(binding);
    }
    this.validateBlockBindings(statements, parameterNames);
    const completeReturn = (value: FunctionalSurfaceExpression) =>
      returnContinuationName === null ? value : {
        kind: "apply" as const,
        callee: { kind: "name" as const, name: returnContinuationName, span },
        argument: value,
        span,
      };
    const completeThrow = (value: FunctionalSurfaceExpression) =>
      throwContinuationName === null
        ? {
          kind: "let" as const,
          name: this.freshBindingName("uncaughtException"),
          value,
          body: {
            kind: "runtime-fault" as const,
            message: `${description} completed with an uncaught JavaScript exception.`,
            span,
          },
          span,
        }
        : {
          kind: "apply" as const,
          callee: { kind: "name" as const, name: throwContinuationName, span },
          argument: value,
          span,
        };
    let body = this.lowerStatementScope(
      statements,
      functionEnvironment,
      () => completeReturn(this.lowerUndefined(span)),
      (value) => completeThrow(value),
      (value) => completeReturn(value),
      () => {
        throw new JavaScriptAotLoweringError(span, `${description} contains break outside a loop.`);
      },
      () => {
        throw new JavaScriptAotLoweringError(
          span,
          `${description} contains continue outside a loop.`,
        );
      },
    );
    for (let index = hoistedBindings.length - 1; index >= 0; index--) {
      const binding = hoistedBindings[index]!;
      body = {
        kind: "let",
        name: binding.coreName,
        value: this.lowerUndefined(span),
        body,
        span,
      };
    }
    return { parameters: coreParameters, body };
  }

  private lowerStatementScope(
    statements: readonly JavaScriptAotStatement[],
    environment: JavaScriptAotEnvironment,
    onFallthrough: (environment: JavaScriptAotEnvironment) => FunctionalSurfaceExpression,
    onThrow: JavaScriptAotThrowContinuation,
    onReturn: JavaScriptAotReturnContinuation,
    onBreak: JavaScriptAotControlContinuation,
    onContinue: JavaScriptAotControlContinuation,
  ): FunctionalSurfaceExpression {
    const declarations = statements.filter((statement) =>
      statement.kind === "function-declaration"
    );
    if (declarations.length === 0) {
      return this.lowerStatements(
        statements,
        environment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      );
    }
    const declarationEnvironment = new Map(environment);
    const coreNames = new Map<string, string>();
    const assignmentIndexes = this.assignmentIndexes(statements);
    for (const declaration of declarations) {
      const coreName = this.freshBindingName(declaration.name);
      coreNames.set(declaration.name, coreName);
      const mayBeAssigned = assignmentIndexes.has(declaration.name);
      declarationEnvironment.set(declaration.name, {
        coreName,
        functionArity: declaration.parameters.length,
        functionLength: declaration.parameterLength ?? declaration.parameters.length,
        throwsAcrossCalls: statementsMayEscapeThrow(declaration.body),
        zeroArgumentApplication: declaration.parameters.length === 0,
        constantValue: null,
        objectFields: null,
        mutable: mayBeAssigned,
        assignable: mayBeAssigned,
      });
    }
    return {
      kind: "let-rec-group",
      bindings: declarations.map((declaration) => {
        const loweredFunction = this.lowerFunction(
          declaration.parameters,
          declaration.body,
          declarationEnvironment,
          declaration.span,
          `JavaScript function ${JSON.stringify(declaration.name)}`,
          "callable",
          declarationEnvironment.get(declaration.name)!.throwsAcrossCalls,
        );
        return {
          name: coreNames.get(declaration.name)!,
          parameters: loweredFunction.parameters,
          body: loweredFunction.body,
          span: declaration.span,
        };
      }),
      body: this.lowerStatements(
        statements,
        declarationEnvironment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      ),
      span: declarations[0]!.span,
    };
  }

  private lowerStatements(
    statements: readonly JavaScriptAotStatement[],
    environment: JavaScriptAotEnvironment,
    onFallthrough: (environment: JavaScriptAotEnvironment) => FunctionalSurfaceExpression,
    onThrow: JavaScriptAotThrowContinuation,
    onReturn: JavaScriptAotReturnContinuation,
    onBreak: JavaScriptAotControlContinuation,
    onContinue: JavaScriptAotControlContinuation,
    statementIndex = 0,
  ): FunctionalSurfaceExpression {
    const statement = statements[statementIndex];
    if (statement === undefined) return onFallthrough(environment);
    if (statement.kind === "function-declaration") {
      return this.lowerStatements(
        statements,
        environment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
        statementIndex + 1,
      );
    }
    if (statement.kind === "return") {
      return this.lowerExpressionWithCompletion(
        statement.value,
        environment,
        (value) => onReturn(value, environment),
        onThrow,
      );
    }
    if (statement.kind === "throw") {
      const constant = this.resolvePrimitiveConstant(statement.value, environment);
      const constantValue = statement.value.kind === "new" &&
          (JAVASCRIPT_ERROR_CONSTRUCTORS.has(statement.value.constructor) ||
            this.options.exceptionConstructors?.has(statement.value.constructor) === true)
        ? statement.value
        : primitiveConstantExpression(constant, statement.value.span);
      return this.lowerExpressionWithCompletion(
        statement.value,
        environment,
        (value) =>
          onThrow(
            value,
            environment,
            constantValue,
          ),
        onThrow,
      );
    }
    if (statement.kind === "break") return onBreak(environment);
    if (statement.kind === "continue") return onContinue(environment);
    if (statement.kind === "expression") {
      return this.lowerExpressionWithCompletion(
        statement.value,
        environment,
        (value) => ({
          kind: "let",
          name: this.freshBindingName("discarded"),
          value,
          body: this.lowerStatements(
            statements,
            environment,
            onFallthrough,
            onThrow,
            onReturn,
            onBreak,
            onContinue,
            statementIndex + 1,
          ),
          span: statement.span,
        }),
        onThrow,
      );
    }
    if (statement.kind === "var") {
      const assignments = statement.declarations.flatMap((declaration) =>
        declaration.value === null ? [] : [{
          kind: "assignment" as const,
          name: declaration.name,
          operator: "=" as const,
          value: declaration.value,
          span: declaration.span,
        }]
      );
      return this.lowerStatements(
        [...assignments, ...statements.slice(statementIndex + 1)],
        environment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      );
    }
    if (statement.kind === "constant" || statement.kind === "mutable") {
      const bodyEnvironment = new Map(environment);
      const assignmentIndexes = this.assignmentIndexes(statements);
      const loweredDeclarations: {
        readonly name: string;
        readonly value: FunctionalSurfaceExpression;
        readonly span: { readonly startByte: number; readonly endByte: number };
      }[] = [];
      let nextStatementIndex = statementIndex;
      while (true) {
        const declaration = statements[nextStatementIndex];
        if (
          declaration === undefined ||
          declaration.kind !== "constant" && declaration.kind !== "mutable"
        ) break;
        const coreName = this.freshBindingName(declaration.name);
        bodyEnvironment.delete(declaration.name);
        const mayBeAssigned = declaration.kind === "mutable" &&
          (assignmentIndexes.get(declaration.name) ?? -1) > nextStatementIndex;
        const binding: JavaScriptAotBinding = {
          coreName,
          functionArity: declaration.value.kind === "function"
            ? declaration.value.parameters.length
            : null,
          functionLength: declaration.value.kind === "function"
            ? declaration.value.parameterLength ?? declaration.value.parameters.length
            : null,
          throwsAcrossCalls: declaration.value.kind === "function" &&
            statementsMayEscapeThrow(declaration.value.body),
          zeroArgumentApplication: declaration.value.kind === "function" &&
            declaration.value.parameters.length === 0,
          constantValue: isPrimitiveWrapper(declaration.value) &&
              this.resolveCoerciblePrimitive(declaration.value, bodyEnvironment) !== null
            ? declaration.value
            : constantExpression(declaration.value) ?? primitiveConstantExpression(
              this.resolvePrimitiveConstant(declaration.value, bodyEnvironment),
              declaration.value.span,
            ),
          objectFields: objectFields(declaration.value),
          mutable: mayBeAssigned,
          assignable: mayBeAssigned,
        };
        loweredDeclarations.push({
          name: coreName,
          value: this.lowerExpression(declaration.value, bodyEnvironment),
          span: declaration.span,
        });
        bodyEnvironment.set(declaration.name, binding);
        nextStatementIndex++;
      }
      let body = this.lowerStatements(
        statements,
        bodyEnvironment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
        nextStatementIndex,
      );
      for (let index = loweredDeclarations.length - 1; index >= 0; index--) {
        const declaration = loweredDeclarations[index]!;
        body = {
          kind: "let",
          name: declaration.name,
          value: declaration.value,
          body,
          span: declaration.span,
        };
      }
      return body;
    }
    if (statement.kind === "assignment") {
      return this.lowerAssignment(
        statement,
        statements,
        statementIndex,
        environment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      );
    }
    if (statement.kind === "property-assignment") {
      throw new JavaScriptAotLoweringError(
        statement.span,
        "JavaScript property assignment requires runtime-model lowering.",
      );
    }
    if (statement.kind === "while") {
      return this.lowerWhile(
        statement,
        statements,
        statementIndex,
        environment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      );
    }
    const continuation = (nextEnvironment: JavaScriptAotEnvironment) =>
      this.lowerStatements(
        statements,
        nextEnvironment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
        statementIndex + 1,
      );
    if (statement.kind === "block") {
      return this.lowerScopedBlock(
        statement.statements,
        environment,
        continuation,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      );
    }
    if (statement.kind === "try") {
      if (this.#activeTryContinuations === JAVASCRIPT_AOT_MAXIMUM_TRY_CONTINUATION_DEPTH) {
        throw new JavaScriptAotLoweringError(
          statement.span,
          `JavaScript try continuation nesting exceeds the limit of ${JAVASCRIPT_AOT_MAXIMUM_TRY_CONTINUATION_DEPTH}.`,
        );
      }
      this.#activeTryContinuations++;
      try {
        return this.lowerTry(
          statement,
          environment,
          continuation,
          onThrow,
          onReturn,
          onBreak,
          onContinue,
        );
      } finally {
        this.#activeTryContinuations--;
      }
    }
    const truthiness = this.constantTruthiness(statement.condition, environment);
    if (truthiness !== null) {
      const selected = truthiness ? statement.consequent : statement.alternate ?? [];
      return this.lowerScopedBlock(
        selected,
        environment,
        continuation,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      );
    }
    return {
      kind: "if",
      condition: this.lowerCondition(statement.condition, environment),
      consequent: this.lowerScopedBlock(
        statement.consequent,
        environment,
        continuation,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      ),
      alternate: statement.alternate === null ? continuation(environment) : this.lowerScopedBlock(
        statement.alternate,
        environment,
        continuation,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      ),
      span: statement.span,
    };
  }

  private lowerScopedBlock(
    statements: readonly JavaScriptAotStatement[],
    environment: JavaScriptAotEnvironment,
    onFallthrough: (environment: JavaScriptAotEnvironment) => FunctionalSurfaceExpression,
    onThrow: JavaScriptAotThrowContinuation,
    onReturn: JavaScriptAotReturnContinuation,
    onBreak: JavaScriptAotControlContinuation,
    onContinue: JavaScriptAotControlContinuation,
  ): FunctionalSurfaceExpression {
    const localNames = new Set(
      statements.flatMap((statement) =>
        statement.kind === "constant" || statement.kind === "mutable" ||
          statement.kind === "function-declaration"
          ? [statement.name]
          : []
      ),
    );
    const restoreOuterEnvironment = (blockEnvironment: JavaScriptAotEnvironment) => {
      const outerEnvironment = new Map<string, JavaScriptAotBinding>();
      for (const [name, binding] of environment) {
        outerEnvironment.set(
          name,
          localNames.has(name) ? binding : blockEnvironment.get(name) ?? binding,
        );
      }
      return outerEnvironment;
    };
    return this.lowerStatementScope(
      statements,
      environment,
      (blockEnvironment) => onFallthrough(restoreOuterEnvironment(blockEnvironment)),
      (value, blockEnvironment, constantValue) =>
        onThrow(value, restoreOuterEnvironment(blockEnvironment), constantValue),
      (value, blockEnvironment) => onReturn(value, restoreOuterEnvironment(blockEnvironment)),
      (blockEnvironment) => onBreak(restoreOuterEnvironment(blockEnvironment)),
      (blockEnvironment) => onContinue(restoreOuterEnvironment(blockEnvironment)),
    );
  }

  private lowerTry(
    statement: Extract<JavaScriptAotStatement, { readonly kind: "try" }>,
    environment: JavaScriptAotEnvironment,
    onFallthrough: (environment: JavaScriptAotEnvironment) => FunctionalSurfaceExpression,
    onThrow: JavaScriptAotThrowContinuation,
    onReturn: JavaScriptAotReturnContinuation,
    onBreak: JavaScriptAotControlContinuation,
    onContinue: JavaScriptAotControlContinuation,
  ): FunctionalSurfaceExpression {
    const runFinally = (
      currentEnvironment: JavaScriptAotEnvironment,
      resume: (environment: JavaScriptAotEnvironment) => FunctionalSurfaceExpression,
    ) =>
      statement.finallyBody === null ? resume(currentEnvironment) : this.lowerScopedBlock(
        statement.finallyBody,
        currentEnvironment,
        resume,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
      );
    const completeNormally = (currentEnvironment: JavaScriptAotEnvironment) =>
      runFinally(currentEnvironment, onFallthrough);
    const completeThrow: JavaScriptAotThrowContinuation = (
      value,
      currentEnvironment,
      constantValue,
    ) =>
      runFinally(
        currentEnvironment,
        (finalEnvironment) => onThrow(value, finalEnvironment, constantValue),
      );
    const completeReturn: JavaScriptAotReturnContinuation = (
      value,
      currentEnvironment,
    ) =>
      runFinally(
        currentEnvironment,
        (finalEnvironment) => onReturn(value, finalEnvironment),
      );
    const completeBreak: JavaScriptAotControlContinuation = (currentEnvironment) =>
      runFinally(currentEnvironment, onBreak);
    const completeContinue: JavaScriptAotControlContinuation = (currentEnvironment) =>
      runFinally(currentEnvironment, onContinue);
    const catchException = (
      value: FunctionalSurfaceExpression,
      thrownEnvironment: JavaScriptAotEnvironment,
      constantValue: JavaScriptAotExpression | null,
    ) => {
      if (statement.catchBody === null) {
        return completeThrow(value, thrownEnvironment, constantValue);
      }
      if (statement.catchName === null) {
        return {
          kind: "let" as const,
          name: this.freshBindingName("caughtException"),
          value,
          body: this.lowerScopedBlock(
            statement.catchBody,
            thrownEnvironment,
            completeNormally,
            completeThrow,
            completeReturn,
            completeBreak,
            completeContinue,
          ),
          span: statement.span,
        };
      }
      const coreName = this.freshBindingName(statement.catchName);
      const catchEnvironment = new Map(thrownEnvironment);
      catchEnvironment.set(statement.catchName, {
        coreName,
        functionArity: null,
        functionLength: null,
        throwsAcrossCalls: false,
        zeroArgumentApplication: false,
        constantValue,
        objectFields: null,
        mutable: false,
        assignable: false,
      });
      const restoreCaughtEnvironment = (blockEnvironment: JavaScriptAotEnvironment) => {
        const outerEnvironment = new Map<string, JavaScriptAotBinding>();
        for (const [name, binding] of thrownEnvironment) {
          outerEnvironment.set(
            name,
            name === statement.catchName ? binding : blockEnvironment.get(name) ?? binding,
          );
        }
        return outerEnvironment;
      };
      return {
        kind: "let" as const,
        name: coreName,
        value,
        body: this.lowerScopedBlock(
          statement.catchBody,
          catchEnvironment,
          (blockEnvironment) => completeNormally(restoreCaughtEnvironment(blockEnvironment)),
          (thrownValue, blockEnvironment, thrownConstant) =>
            completeThrow(
              thrownValue,
              restoreCaughtEnvironment(blockEnvironment),
              thrownConstant,
            ),
          (returnedValue, blockEnvironment) =>
            completeReturn(returnedValue, restoreCaughtEnvironment(blockEnvironment)),
          (blockEnvironment) => completeBreak(restoreCaughtEnvironment(blockEnvironment)),
          (blockEnvironment) => completeContinue(restoreCaughtEnvironment(blockEnvironment)),
        ),
        span: statement.span,
      };
    };
    return this.lowerScopedBlock(
      statement.body,
      environment,
      completeNormally,
      catchException,
      completeReturn,
      completeBreak,
      completeContinue,
    );
  }

  private lowerAssignment(
    statement: Extract<JavaScriptAotStatement, { readonly kind: "assignment" }>,
    statements: readonly JavaScriptAotStatement[],
    statementIndex: number,
    environment: JavaScriptAotEnvironment,
    onFallthrough: (environment: JavaScriptAotEnvironment) => FunctionalSurfaceExpression,
    onThrow: JavaScriptAotThrowContinuation,
    onReturn: JavaScriptAotReturnContinuation,
    onBreak: JavaScriptAotControlContinuation,
    onContinue: JavaScriptAotControlContinuation,
  ): FunctionalSurfaceExpression {
    const binding = environment.get(statement.name);
    if (binding === undefined) {
      throw new JavaScriptAotLoweringError(
        statement.span,
        `JavaScript assignment target ${JSON.stringify(statement.name)} is not declared.`,
      );
    }
    if (!binding.mutable) {
      throw new JavaScriptAotLoweringError(
        statement.span,
        `JavaScript assignment cannot replace immutable binding ${JSON.stringify(statement.name)}.`,
      );
    }
    if (!binding.assignable) {
      throw new JavaScriptAotLoweringError(
        statement.span,
        `JavaScript closure assignment to captured binding ${
          JSON.stringify(statement.name)
        } requires mutable cells, which are not available in this AOT slice.`,
      );
    }
    const assignedValue = this.lowerExpression(statement.value, environment);
    let compoundOperator: JavaScriptAotBinaryOperator | null = null;
    switch (statement.operator) {
      case "=":
        break;
      case "+=":
        compoundOperator = "+";
        break;
      case "-=":
        compoundOperator = "-";
        break;
      case "*=":
        compoundOperator = "*";
        break;
      case "/=":
        compoundOperator = "/";
        break;
      case "%=":
        compoundOperator = "%";
        break;
      case "<<=":
        compoundOperator = "<<";
        break;
      case ">>=":
        compoundOperator = ">>";
        break;
      case ">>>=":
        compoundOperator = ">>>";
        break;
      case "&=":
        compoundOperator = "&";
        break;
      case "^=":
        compoundOperator = "^";
        break;
      case "|=":
        compoundOperator = "|";
        break;
    }
    const compoundConstant = compoundOperator === null ? null : this.resolvePrimitiveConstant({
      kind: "binary",
      operator: compoundOperator,
      left: { kind: "name", name: statement.name, span: statement.span },
      right: statement.value,
      span: statement.span,
    }, environment);
    if (
      compoundOperator !== null && JAVASCRIPT_BITWISE_OPERATORS.has(compoundOperator) &&
      compoundConstant === null
    ) {
      throw new JavaScriptAotLoweringError(
        statement.span,
        `JavaScript ${statement.operator} requires statically known primitive operands in this AOT profile.`,
      );
    }
    const assignmentTarget: FunctionalSurfaceExpression = {
      kind: "name",
      name: binding.coreName,
      span: statement.span,
    };
    const assignedPrimitive = this.resolveCoerciblePrimitive(statement.value, environment);
    const value: FunctionalSurfaceExpression = statement.operator === "="
      ? assignedValue
      : compoundConstant !== null
      ? this.lowerExpression(
        primitiveConstantExpression(compoundConstant, statement.span)!,
        environment,
      )
      : statement.operator === "+=" && assignedPrimitive?.kind === "string"
      ? {
        kind: "text-append",
        left: assignmentTarget,
        right: assignedValue,
        span: statement.span,
      }
      : {
        kind: "binary",
        operator: assignmentBinaryOperator(statement.operator),
        left: assignmentTarget,
        right: assignedValue,
        span: statement.span,
      };
    const coreName = this.freshBindingName(statement.name);
    const bodyEnvironment = new Map(environment);
    bodyEnvironment.set(statement.name, {
      coreName,
      functionArity: statement.value.kind === "function" ? statement.value.parameters.length : null,
      functionLength: statement.value.kind === "function"
        ? statement.value.parameterLength ?? statement.value.parameters.length
        : null,
      throwsAcrossCalls: statement.value.kind === "function" &&
        statementsMayEscapeThrow(statement.value.body),
      zeroArgumentApplication: statement.value.kind === "function" &&
        statement.value.parameters.length === 0,
      constantValue: statement.operator === "="
        ? isPrimitiveWrapper(statement.value) &&
            this.resolveCoerciblePrimitive(statement.value, environment) !== null
          ? statement.value
          : constantExpression(statement.value) ?? primitiveConstantExpression(
            this.resolvePrimitiveConstant(statement.value, environment),
            statement.value.span,
          )
        : primitiveConstantExpression(compoundConstant, statement.value.span),
      objectFields: statement.operator === "=" ? objectFields(statement.value) : null,
      mutable: true,
      assignable: true,
    });
    return {
      kind: "let",
      name: coreName,
      value,
      body: this.lowerStatements(
        statements,
        bodyEnvironment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
        statementIndex + 1,
      ),
      span: statement.span,
    };
  }

  private lowerWhile(
    statement: Extract<JavaScriptAotStatement, { readonly kind: "while" }>,
    statements: readonly JavaScriptAotStatement[],
    statementIndex: number,
    environment: JavaScriptAotEnvironment,
    onFallthrough: (environment: JavaScriptAotEnvironment) => FunctionalSurfaceExpression,
    onThrow: JavaScriptAotThrowContinuation,
    onReturn: JavaScriptAotReturnContinuation,
    onBreak: JavaScriptAotControlContinuation,
    onContinue: JavaScriptAotControlContinuation,
  ): FunctionalSurfaceExpression {
    if (this.constantTruthiness(statement.condition, environment) === false) {
      return this.lowerStatements(
        statements,
        environment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
        statementIndex + 1,
      );
    }
    const loopName = this.freshBindingName("loop");
    const tokenName = this.freshBindingName("loopToken");
    const loopAssignments = assignedNamesInStatements([
      ...statement.body,
      ...statement.continueBody,
    ]);
    const mutableNames = [...environment]
      .filter(([name, binding]) => binding.assignable && loopAssignments.has(name))
      .map(([name]) => name);
    const loopEnvironment = new Map(environment);
    const stateParameters = mutableNames.map((name) => {
      const coreName = this.freshBindingName(name);
      loopEnvironment.set(name, {
        coreName,
        functionArity: null,
        functionLength: null,
        throwsAcrossCalls: false,
        zeroArgumentApplication: false,
        constantValue: null,
        objectFields: null,
        mutable: true,
        assignable: true,
      });
      return coreName;
    });
    const invariantConditionTruthiness = this.constantTruthiness(
      statement.condition,
      loopEnvironment,
    );
    const callLoop = (currentEnvironment: JavaScriptAotEnvironment) => {
      let call: FunctionalSurfaceExpression = {
        kind: "name",
        name: loopName,
        span: statement.span,
      };
      const arguments_: FunctionalSurfaceExpression[] = [
        { kind: "boolean", value: true, span: statement.span },
        ...mutableNames.map((name) => ({
          kind: "name" as const,
          name: currentEnvironment.get(name)!.coreName,
          span: statement.span,
        })),
      ];
      for (const argument of arguments_) {
        call = { kind: "apply", callee: call, argument, span: statement.span };
      }
      return call;
    };
    const continueAfterLoop = (currentEnvironment: JavaScriptAotEnvironment) =>
      this.lowerStatements(
        statements,
        currentEnvironment,
        onFallthrough,
        onThrow,
        onReturn,
        onBreak,
        onContinue,
        statementIndex + 1,
      );
    const continueLoop = (currentEnvironment: JavaScriptAotEnvironment) =>
      this.lowerScopedBlock(
        statement.continueBody,
        currentEnvironment,
        callLoop,
        onThrow,
        onReturn,
        continueAfterLoop,
        callLoop,
      );
    const iteration = this.lowerScopedBlock(
      statement.body,
      loopEnvironment,
      continueLoop,
      onThrow,
      onReturn,
      continueAfterLoop,
      continueLoop,
    );
    const loopBody: FunctionalSurfaceExpression = invariantConditionTruthiness === true
      ? iteration
      : {
        kind: "if",
        condition: this.lowerCondition(statement.condition, loopEnvironment),
        consequent: iteration,
        alternate: continueAfterLoop(loopEnvironment),
        span: statement.span,
      };
    return {
      kind: "let-rec-group",
      bindings: [{
        name: loopName,
        parameters: [tokenName, ...stateParameters],
        body: loopBody,
        span: statement.span,
      }],
      body: callLoop(environment),
      span: statement.span,
    };
  }

  private assignmentIndexes(
    statements: readonly JavaScriptAotStatement[],
  ): ReadonlyMap<string, number> {
    const cached = this.#assignmentIndexes.get(statements);
    if (cached !== undefined) return cached;
    const indexes = new Map<string, number>();
    for (let index = 0; index < statements.length; index++) {
      for (const name of assignedNamesInStatement(statements[index]!)) {
        indexes.set(name, index);
      }
    }
    this.#assignmentIndexes.set(statements, indexes);
    return indexes;
  }

  private lowerExpression(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "number":
        return { kind: "float-64", value: expression.value, span: expression.span };
      case "string":
        return { kind: "text", value: expression.value, span: expression.span };
      case "boolean":
        return { kind: "boolean", value: expression.value, span: expression.span };
      case "null":
        this.#usesNullish = true;
        return { kind: "name", name: JAVASCRIPT_NULL, span: expression.span };
      case "name": {
        const binding = environment.get(expression.name);
        if (binding === undefined) {
          if (expression.name === "Infinity") {
            return { kind: "float-64", value: Infinity, span: expression.span };
          }
          if (expression.name === "NaN") {
            return { kind: "float-64", value: NaN, span: expression.span };
          }
          if (expression.name === "undefined") return this.lowerUndefined(expression.span);
          throw new JavaScriptAotLoweringError(
            expression.span,
            `JavaScript AOT name ${
              JSON.stringify(expression.name)
            } is not lexically declared in module ${
              JSON.stringify(this.sourceModule.name)
            }; runtime globals are not implicit.`,
          );
        }
        if (binding.mutable && !binding.assignable) {
          throw new JavaScriptAotLoweringError(
            expression.span,
            `JavaScript closure reads captured mutable binding ${
              JSON.stringify(expression.name)
            }; mutable closure cells are not available in this AOT slice.`,
          );
        }
        return { kind: "name", name: binding.coreName, span: expression.span };
      }
      case "array": {
        this.#usesArrays = true;
        let array: FunctionalSurfaceExpression = {
          kind: "name",
          name: JAVASCRIPT_ARRAY_EMPTY,
          span: expression.span,
        };
        for (let index = expression.values.length - 1; index >= 0; index--) {
          array = applyExpressions(
            { kind: "name", name: JAVASCRIPT_ARRAY_ELEMENT, span: expression.span },
            [this.lowerExpression(expression.values[index]!, environment), array],
            expression.span,
          );
        }
        return array;
      }
      case "object": {
        const shape = this.requireObjectShape(expression);
        const properties = new Map(
          expression.properties.map((property) => [property.name, property]),
        );
        return applyExpressions(
          { kind: "name", name: shape.constructorName, span: expression.span },
          shape.fields.map((name) =>
            this.lowerExpression(properties.get(name)!.value, environment)
          ),
          expression.span,
        );
      }
      case "function":
        return this.lowerFunctionExpression(expression, environment);
      case "unary":
        if (expression.operator === "typeof") {
          return {
            kind: "text",
            value: this.staticTypeof(expression.value, environment),
            span: expression.span,
          };
        }
        if (expression.operator === "void") {
          return {
            kind: "let",
            name: this.freshBindingName("discarded"),
            value: this.lowerExpression(expression.value, environment),
            body: this.lowerUndefined(expression.span),
            span: expression.span,
          };
        }
        if (expression.operator === "+") {
          const constant = this.resolveCoerciblePrimitive(expression.value, environment);
          if (constant !== null) {
            return {
              kind: "float-64",
              value: primitiveConstantToRelationalNumber(constant),
              span: expression.span,
            };
          }
          return this.lowerExpression(expression.value, environment);
        }
        if (expression.operator === "~") {
          const constant = this.resolveCoerciblePrimitive(expression.value, environment);
          if (constant === null) {
            throw new JavaScriptAotLoweringError(
              expression.span,
              "JavaScript bitwise not requires a statically known primitive operand in this AOT profile.",
            );
          }
          return {
            kind: "float-64",
            value: ~primitiveConstantToRelationalNumber(constant),
            span: expression.span,
          };
        }
        if (expression.operator === "!") {
          const truthiness = this.constantTruthiness(expression.value, environment);
          if (truthiness !== null) {
            return {
              kind: "boolean",
              value: !truthiness,
              span: expression.span,
            };
          }
          return {
            kind: "if",
            condition: this.lowerExpression(expression.value, environment),
            consequent: { kind: "boolean", value: false, span: expression.span },
            alternate: { kind: "boolean", value: true, span: expression.span },
            span: expression.span,
          };
        }
        if (expression.value.kind === "string") {
          return {
            kind: "float-64",
            value: -Number(expression.value.value),
            span: expression.span,
          };
        }
        return {
          kind: "unary",
          operator: FunctionalUnaryOperator.NegateFloat64,
          value: this.lowerExpression(expression.value, environment),
          span: expression.span,
        };
      case "conditional": {
        const truthiness = literalTruthiness(expression.condition);
        if (truthiness !== null) {
          return this.lowerExpression(
            truthiness ? expression.consequent : expression.alternate,
            environment,
          );
        }
        return {
          kind: "if",
          condition: this.lowerCondition(expression.condition, environment),
          consequent: this.lowerExpression(expression.consequent, environment),
          alternate: this.lowerExpression(expression.alternate, environment),
          span: expression.span,
        };
      }
      case "call":
        return this.lowerCall(expression, environment);
      case "new":
        if (isPrimitiveWrapper(expression)) {
          const primitive = this.resolveCoerciblePrimitive(expression, environment);
          if (primitive === null) {
            throw new JavaScriptAotLoweringError(
              expression.span,
              `JavaScript new ${expression.constructor} requires a statically coercible argument in this AOT profile.`,
            );
          }
          const shape = this.objectShape([`$${expression.constructor}Value`]);
          return applyExpressions(
            { kind: "name", name: shape.constructorName, span: expression.span },
            [this.lowerExpression(
              primitiveConstantExpression(primitive, expression.span)!,
              environment,
            )],
            expression.span,
          );
        }
        if (this.options.runtimeFaultConstructors?.has(expression.constructor)) {
          return {
            kind: "runtime-fault",
            message: this.options.runtimeFaultConstructors.get(expression.constructor)!,
            span: expression.span,
          };
        }
        if (
          JAVASCRIPT_ERROR_CONSTRUCTORS.has(expression.constructor) ||
          this.options.exceptionConstructors?.has(expression.constructor) === true
        ) {
          this.#usedExceptionConstructors.add(expression.constructor);
          let constructed: FunctionalSurfaceExpression = {
            kind: "name",
            name: javascriptExceptionConstructorName(expression.constructor),
            span: expression.span,
          };
          for (let index = expression.arguments.length - 1; index >= 0; index--) {
            constructed = {
              kind: "let",
              name: this.freshBindingName("errorArgument"),
              value: this.lowerExpression(expression.arguments[index]!, environment),
              body: constructed,
              span: expression.span,
            };
          }
          return constructed;
        }
        throw new JavaScriptAotLoweringError(
          expression.span,
          expression.constructor === "Function"
            ? "JavaScript AOT compilation forbids dynamic code generation through new Function."
            : `JavaScript AOT construction with new ${expression.constructor} is not supported.`,
        );
      case "property":
        if (expression.value.kind === "name" && expression.value.name === "Number") {
          const value = JAVASCRIPT_NUMBER_CONSTANTS[expression.name];
          if (value !== undefined) {
            return { kind: "float-64", value, span: expression.span };
          }
        }
        if (expression.name === "length") {
          const receiver = this.resolveConstant(expression.value, environment);
          if (receiver?.kind === "string") {
            return { kind: "float-64", value: receiver.value.length, span: expression.span };
          }
          if (expression.value.kind === "name") {
            const functionLength = environment.get(expression.value.name)?.functionLength ?? null;
            if (functionLength !== null) {
              return { kind: "float-64", value: functionLength, span: expression.span };
            }
          }
        }
        {
          const shape = this.resolveObjectShape(expression.value, environment);
          if (shape !== null) {
            const fieldIndex = shape.fields.indexOf(expression.name);
            if (fieldIndex < 0) return this.lowerUndefined(expression.span);
            const binders = shape.fields.map((name) => this.freshBindingName(name));
            return {
              kind: "case",
              value: this.lowerExpression(expression.value, environment),
              arms: [{
                constructor: shape.constructorName,
                binders,
                body: { kind: "name", name: binders[fieldIndex]!, span: expression.span },
                span: expression.span,
              }],
              span: expression.span,
            };
          }
        }
        if (expression.name !== "length") {
          throw new JavaScriptAotLoweringError(
            expression.span,
            `JavaScript AOT arrays expose only property "length" in this slice; received ${
              JSON.stringify(expression.name)
            }.`,
          );
        }
        this.#usesArrays = true;
        this.#arrayDefinitions.add(JAVASCRIPT_ARRAY_LENGTH);
        return applyExpressions(
          { kind: "name", name: JAVASCRIPT_ARRAY_LENGTH, span: expression.span },
          [this.lowerExpression(expression.value, environment)],
          expression.span,
        );
      case "index":
        {
          const receiver = this.resolveConstant(expression.value, environment);
          const index = this.resolveConstant(expression.index, environment);
          if (receiver?.kind === "string" && index?.kind === "number") {
            const value = receiver.value[index.value];
            return value === undefined
              ? this.lowerUndefined(expression.span)
              : { kind: "text", value, span: expression.span };
          }
          if (
            (index?.kind === "string" || index?.kind === "number") &&
            this.resolveObjectShape(expression.value, environment) !== null
          ) {
            return this.lowerExpression({
              kind: "property",
              value: expression.value,
              name: String(index.value),
              span: expression.span,
            }, environment);
          }
        }
        this.#usesArrays = true;
        this.#arrayDefinitions.add(JAVASCRIPT_ARRAY_INDEX);
        return applyExpressions(
          { kind: "name", name: JAVASCRIPT_ARRAY_INDEX, span: expression.span },
          [
            this.lowerExpression(expression.value, environment),
            this.lowerExpression(expression.index, environment),
          ],
          expression.span,
        );
      case "binary":
        return this.lowerBinary(expression, environment);
    }
  }

  private lowerExpressionWithCompletion(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
    onValue: JavaScriptAotValueContinuation,
    onThrow: JavaScriptAotThrowContinuation,
  ): FunctionalSurfaceExpression {
    if (!this.expressionThrowsAcrossBoundary(expression, environment)) {
      return onValue(this.lowerExpression(expression, environment));
    }
    if (expression.kind === "binary") {
      if (expression.operator === "&&" || expression.operator === "||") {
        throw new JavaScriptAotLoweringError(
          expression.span,
          "JavaScript exceptions inside logical operands require short-circuit completion lowering.",
        );
      }
      return this.lowerExpressionWithCompletion(
        expression.left,
        environment,
        (leftValue) => {
          const leftName = this.freshBindingName("completedLeft");
          const rightEnvironment = new Map(environment);
          rightEnvironment.set(leftName, {
            coreName: leftName,
            functionArity: null,
            functionLength: null,
            throwsAcrossCalls: false,
            zeroArgumentApplication: false,
            constantValue: null,
            objectFields: null,
            mutable: false,
            assignable: false,
          });
          return {
            kind: "let",
            name: leftName,
            value: leftValue,
            body: this.lowerExpressionWithCompletion(
              expression.right,
              rightEnvironment,
              (rightValue) => {
                const rightName = this.freshBindingName("completedRight");
                const completedEnvironment = new Map(rightEnvironment);
                completedEnvironment.set(rightName, {
                  coreName: rightName,
                  functionArity: null,
                  functionLength: null,
                  throwsAcrossCalls: false,
                  zeroArgumentApplication: false,
                  constantValue: null,
                  objectFields: null,
                  mutable: false,
                  assignable: false,
                });
                return {
                  kind: "let",
                  name: rightName,
                  value: rightValue,
                  body: onValue(this.lowerBinary({
                    ...expression,
                    left: { kind: "name", name: leftName, span: expression.left.span },
                    right: { kind: "name", name: rightName, span: expression.right.span },
                  }, completedEnvironment)),
                  span: expression.span,
                };
              },
              onThrow,
            ),
            span: expression.span,
          };
        },
        onThrow,
      );
    }
    if (expression.kind === "new") {
      return this.lowerExpressionListWithCompletion(
        expression.arguments,
        environment,
        (arguments_, completedEnvironment) =>
          onValue(
            this.lowerExpression({ ...expression, arguments: arguments_ }, completedEnvironment),
          ),
        onThrow,
      );
    }
    if (expression.kind === "array") {
      return this.lowerExpressionListWithCompletion(
        expression.values,
        environment,
        (values, completedEnvironment) =>
          onValue(this.lowerExpression({ ...expression, values }, completedEnvironment)),
        onThrow,
      );
    }
    if (expression.kind === "object") {
      return this.lowerExpressionListWithCompletion(
        expression.properties.map((property) => property.value),
        environment,
        (values, completedEnvironment) =>
          onValue(this.lowerExpression({
            ...expression,
            properties: expression.properties.map((property, index) => ({
              ...property,
              value: values[index]!,
            })),
          }, completedEnvironment)),
        onThrow,
      );
    }
    if (expression.kind !== "call") {
      throw new JavaScriptAotLoweringError(
        expression.span,
        "JavaScript exceptions in this expression require completion-aware evaluation.",
      );
    }
    if (
      expression.arguments.some((argument) =>
        this.expressionThrowsAcrossBoundary(argument, environment)
      )
    ) {
      return this.lowerExpressionListWithCompletion(
        expression.arguments,
        environment,
        (arguments_, completedEnvironment) =>
          this.lowerExpressionWithCompletion(
            { ...expression, arguments: arguments_ },
            completedEnvironment,
            onValue,
            onThrow,
          ),
        onThrow,
      );
    }
    if (!this.callThrowsAcrossBoundary(expression, environment)) {
      throw new JavaScriptAotLoweringError(
        expression.callee.span,
        "JavaScript exceptions while evaluating a callee require callee completion lowering.",
      );
    }
    if (expression.callee.kind === "property") {
      throw new JavaScriptAotLoweringError(
        expression.span,
        "JavaScript exceptions from method calls require method completion lowering.",
      );
    }
    const functionArity = expression.callee.kind === "function"
      ? expression.callee.parameters.length
      : expression.callee.kind === "name"
      ? environment.get(expression.callee.name)?.functionArity ?? null
      : null;
    if (functionArity !== null && functionArity !== expression.arguments.length) {
      throw new JavaScriptAotLoweringError(
        expression.span,
        `JavaScript function expects ${functionArity} arguments but this call supplies ${expression.arguments.length}.`,
      );
    }

    let call = this.lowerExpression(expression.callee, environment);
    const zeroArgumentApplication = expression.arguments.length === 0 && functionArity === 0;
    if (zeroArgumentApplication) {
      call = {
        kind: "apply",
        callee: call,
        argument: this.lowerUndefined(expression.span),
        span: expression.span,
      };
    }
    for (const argument of expression.arguments) {
      call = {
        kind: "apply",
        callee: call,
        argument: this.lowerExpression(argument, environment),
        span: expression.span,
      };
    }
    const returnedName = this.freshBindingName("returnedValue");
    call = {
      kind: "apply",
      callee: call,
      argument: {
        kind: "lambda",
        parameter: returnedName,
        body: onValue({ kind: "name", name: returnedName, span: expression.span }),
        span: expression.span,
      },
      span: expression.span,
    };
    const thrownName = this.freshBindingName("thrownValue");
    return {
      kind: "apply",
      callee: call,
      argument: {
        kind: "lambda",
        parameter: thrownName,
        body: onThrow(
          { kind: "name", name: thrownName, span: expression.span },
          environment,
          null,
        ),
        span: expression.span,
      },
      span: expression.span,
    };
  }

  private callThrowsAcrossBoundary(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
    environment: JavaScriptAotEnvironment,
  ): boolean {
    return expression.callee.kind === "function"
      ? statementsMayEscapeThrow(expression.callee.body)
      : expression.callee.kind === "name" &&
        environment.get(expression.callee.name)?.throwsAcrossCalls === true;
  }

  private lowerExpressionListWithCompletion(
    expressions: readonly JavaScriptAotExpression[],
    environment: JavaScriptAotEnvironment,
    onValues: (
      expressions: readonly JavaScriptAotExpression[],
      environment: JavaScriptAotEnvironment,
    ) => FunctionalSurfaceExpression,
    onThrow: JavaScriptAotThrowContinuation,
    expressionIndex = 0,
    completedExpressions: readonly JavaScriptAotExpression[] = [],
  ): FunctionalSurfaceExpression {
    const expression = expressions[expressionIndex];
    if (expression === undefined) return onValues(completedExpressions, environment);
    return this.lowerExpressionWithCompletion(
      expression,
      environment,
      (value) => {
        const coreName = this.freshBindingName("completedExpression");
        const completedEnvironment = new Map(environment);
        completedEnvironment.set(coreName, {
          coreName,
          functionArity: expression.kind === "function" ? expression.parameters.length : null,
          functionLength: expression.kind === "function"
            ? expression.parameterLength ?? expression.parameters.length
            : null,
          throwsAcrossCalls: expression.kind === "function" &&
            statementsMayEscapeThrow(expression.body),
          zeroArgumentApplication: expression.kind === "function" &&
            expression.parameters.length === 0,
          constantValue: null,
          objectFields: objectFields(expression),
          mutable: false,
          assignable: false,
        });
        return {
          kind: "let",
          name: coreName,
          value,
          body: this.lowerExpressionListWithCompletion(
            expressions,
            completedEnvironment,
            onValues,
            onThrow,
            expressionIndex + 1,
            [...completedExpressions, { kind: "name", name: coreName, span: expression.span }],
          ),
          span: expression.span,
        };
      },
      onThrow,
    );
  }

  private expressionThrowsAcrossBoundary(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): boolean {
    switch (expression.kind) {
      case "call":
        return this.callThrowsAcrossBoundary(expression, environment) ||
          this.expressionThrowsAcrossBoundary(expression.callee, environment) ||
          expression.arguments.some((argument) =>
            this.expressionThrowsAcrossBoundary(argument, environment)
          );
      case "array":
        return expression.values.some((value) =>
          this.expressionThrowsAcrossBoundary(value, environment)
        );
      case "object":
        return expression.properties.some((property) =>
          this.expressionThrowsAcrossBoundary(property.value, environment)
        );
      case "unary":
      case "property":
        return this.expressionThrowsAcrossBoundary(expression.value, environment);
      case "binary":
        return this.expressionThrowsAcrossBoundary(expression.left, environment) ||
          this.expressionThrowsAcrossBoundary(expression.right, environment);
      case "conditional":
        return this.expressionThrowsAcrossBoundary(expression.condition, environment) ||
          this.expressionThrowsAcrossBoundary(expression.consequent, environment) ||
          this.expressionThrowsAcrossBoundary(expression.alternate, environment);
      case "new":
        return expression.arguments.some((argument) =>
          this.expressionThrowsAcrossBoundary(argument, environment)
        );
      case "index":
        return this.expressionThrowsAcrossBoundary(expression.value, environment) ||
          this.expressionThrowsAcrossBoundary(expression.index, environment);
      case "function":
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "name":
        return false;
    }
  }

  private resolveConstant(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): JavaScriptAotExpression | null {
    if (expression.kind === "name") {
      return environment.get(expression.name)?.constantValue ?? null;
    }
    if (expression.kind === "conditional") {
      const truthiness = this.constantTruthiness(expression.condition, environment);
      return truthiness === null ? null : this.resolveConstant(
        truthiness ? expression.consequent : expression.alternate,
        environment,
      );
    }
    if (
      expression.kind === "binary" &&
      (expression.operator === "&&" || expression.operator === "||")
    ) {
      const truthiness = this.constantTruthiness(expression.left, environment);
      if (truthiness === null) return null;
      const useRight = expression.operator === "&&" ? truthiness : !truthiness;
      return this.resolveConstant(useRight ? expression.right : expression.left, environment);
    }
    return constantExpression(expression);
  }

  private lowerCondition(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): FunctionalSurfaceExpression {
    const truthiness = this.constantTruthiness(expression, environment);
    return truthiness === null ? this.lowerExpression(expression, environment) : {
      kind: "boolean",
      value: truthiness,
      span: expression.span,
    };
  }

  private staticTypeof(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): "undefined" | "boolean" | "number" | "string" | "function" | "object" {
    if (expression.kind === "name") {
      const binding = environment.get(expression.name);
      if (binding === undefined) {
        if (expression.name === "Infinity" || expression.name === "NaN") return "number";
        if (JAVASCRIPT_OBJECT_GLOBALS.has(expression.name)) return "object";
        return "undefined";
      }
      if (binding.functionArity !== null) return "function";
      if (binding.objectFields !== null) return "object";
      if (binding.constantValue !== null) {
        return this.staticTypeof(binding.constantValue, environment);
      }
      throw new JavaScriptAotLoweringError(
        expression.span,
        `JavaScript typeof cannot determine the runtime type of ${
          JSON.stringify(expression.name)
        } before Functional Core inference.`,
      );
    }
    switch (expression.kind) {
      case "number":
        return "number";
      case "string":
        return "string";
      case "boolean":
        return "boolean";
      case "null":
      case "array":
      case "object":
        return "object";
      case "function":
        return "function";
      case "new":
        if (isPrimitiveWrapper(expression)) return "object";
        throw new JavaScriptAotLoweringError(
          expression.span,
          "JavaScript typeof requires a supported constructed value.",
        );
      case "unary":
        if (expression.operator === "typeof") return "string";
        if (expression.operator === "!") return "boolean";
        if (expression.operator === "void") return "undefined";
        return "number";
      case "binary":
        if (expression.operator === "&&" || expression.operator === "||") {
          throw new JavaScriptAotLoweringError(
            expression.span,
            "JavaScript typeof requires a statically known logical-expression result.",
          );
        }
        return expression.operator === "<" || expression.operator === "<=" ||
            expression.operator === ">" || expression.operator === ">=" ||
            expression.operator === "===" || expression.operator === "!==" ||
            expression.operator === "same-value" ||
            expression.operator === "not-same-value" ||
            expression.operator === "==" || expression.operator === "!=" ||
            expression.operator === "instanceof"
          ? "boolean"
          : "number";
      default:
        throw new JavaScriptAotLoweringError(
          expression.span,
          "JavaScript typeof requires a statically known operand in this AOT profile.",
        );
    }
  }

  private resolveObjectShape(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): JavaScriptAotObjectShape | null {
    const fields = expression.kind === "name"
      ? environment.get(expression.name)?.objectFields ?? null
      : objectFields(expression);
    return fields === null ? null : this.objectShape(fields);
  }

  private requireObjectShape(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "object" }>,
  ): JavaScriptAotObjectShape {
    const fields = new Set(expression.properties.map((property) => property.name));
    return this.objectShape([...fields].sort());
  }

  private objectShape(fields: readonly string[]): JavaScriptAotObjectShape {
    const signature = JSON.stringify(fields);
    const existing = this.#objectShapes.get(signature);
    if (existing !== undefined) return existing;
    const index = this.#objectShapes.size;
    const shape = {
      typeName: `$javascript#Object${index}`,
      constructorName: `$javascript#Object${index}Value`,
      fields: [...fields],
    };
    this.#objectShapes.set(signature, shape);
    return shape;
  }

  private lowerCall(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
    environment: JavaScriptAotEnvironment,
  ): FunctionalSurfaceExpression {
    if (expression.callee.kind === "name" && expression.callee.name === "isNaN") {
      if (expression.arguments.length !== 1) {
        throw new JavaScriptAotLoweringError(
          expression.span,
          `JavaScript isNaN expects 1 argument but this call supplies ${expression.arguments.length}.`,
        );
      }
      const argument = this.resolveCoerciblePrimitive(expression.arguments[0]!, environment);
      if (argument === null) {
        throw new JavaScriptAotLoweringError(
          expression.span,
          "JavaScript isNaN requires a statically known primitive argument in this AOT profile.",
        );
      }
      return {
        kind: "boolean",
        value: Number.isNaN(primitiveConstantToRelationalNumber(argument)),
        span: expression.span,
      };
    }
    if (expression.callee.kind === "property") {
      return this.lowerArrayMethodCall(expression, environment);
    }
    if (
      expression.callee.kind === "function" &&
      expression.callee.parameters.length !== expression.arguments.length
    ) {
      throw new JavaScriptAotLoweringError(
        expression.span,
        `JavaScript function expression expects ${expression.callee.parameters.length} arguments but this call supplies ${expression.arguments.length}.`,
      );
    }
    if (this.callThrowsAcrossBoundary(expression, environment)) {
      throw new JavaScriptAotLoweringError(
        expression.span,
        "JavaScript exceptions from a nested call require expression completion lowering.",
      );
    }
    if (expression.callee.kind === "name") {
      const binding = environment.get(expression.callee.name);
      if (
        binding === undefined &&
        (expression.callee.name === "eval" || expression.callee.name === "Function")
      ) {
        throw new JavaScriptAotLoweringError(
          expression.span,
          `JavaScript AOT compilation forbids dynamic code generation through ${
            JSON.stringify(expression.callee.name)
          }.`,
        );
      }
      if (
        binding?.functionArity !== null && binding?.functionArity !== undefined &&
        binding.functionArity !== expression.arguments.length
      ) {
        throw new JavaScriptAotLoweringError(
          expression.span,
          `JavaScript function ${
            JSON.stringify(expression.callee.name)
          } expects ${binding.functionArity} arguments but this call supplies ${expression.arguments.length}.`,
        );
      }
    }
    let result = this.lowerExpression(expression.callee, environment);
    const zeroArgumentApplication = expression.arguments.length === 0 && (
      expression.callee.kind === "function" && expression.callee.parameters.length === 0 ||
      expression.callee.kind === "name" &&
        environment.get(expression.callee.name)?.zeroArgumentApplication === true
    );
    if (zeroArgumentApplication) {
      result = {
        kind: "apply",
        callee: result,
        argument: this.lowerUndefined(expression.span),
        span: expression.span,
      };
    }
    for (const argument of expression.arguments) {
      result = {
        kind: "apply",
        callee: result,
        argument: this.lowerExpression(argument, environment),
        span: expression.span,
      };
    }
    return result;
  }

  private lowerArrayMethodCall(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
    environment: JavaScriptAotEnvironment,
  ): FunctionalSurfaceExpression {
    if (expression.callee.kind !== "property") {
      throw new Error("JavaScript array method lowering requires a property callee.");
    }
    const method = expression.callee.name;
    const expectedArguments = method === "map" ? 1 : method === "reduce" ? 2 : null;
    if (expectedArguments === null) {
      throw new JavaScriptAotLoweringError(
        expression.callee.span,
        `JavaScript AOT arrays do not provide method ${JSON.stringify(method)}.`,
      );
    }
    if (expression.arguments.length !== expectedArguments) {
      throw new JavaScriptAotLoweringError(
        expression.span,
        `JavaScript Array.${method} expects ${expectedArguments} arguments in this AOT profile but this call supplies ${expression.arguments.length}.`,
      );
    }
    const callback = expression.arguments[0]!;
    const expectedCallbackArity = method === "map" ? 1 : 2;
    const callbackArity = callback.kind === "function"
      ? callback.parameters.length
      : callback.kind === "name"
      ? environment.get(callback.name)?.functionArity ?? null
      : null;
    if (callbackArity !== null && callbackArity !== expectedCallbackArity) {
      throw new JavaScriptAotLoweringError(
        callback.span,
        `JavaScript Array.${method} callback expects ${expectedCallbackArity} ${
          expectedCallbackArity === 1 ? "parameter" : "parameters"
        } in this AOT profile but the supplied function declares ${callbackArity}.`,
      );
    }
    this.#usesArrays = true;
    this.#arrayDefinitions.add(
      method === "map" ? JAVASCRIPT_ARRAY_MAP : JAVASCRIPT_ARRAY_REDUCE,
    );
    const receiver = this.lowerExpression(expression.callee.value, environment);
    const arguments_ = expression.arguments.map((argument) =>
      this.lowerExpression(argument, environment)
    );
    return method === "map"
      ? applyExpressions(
        { kind: "name", name: JAVASCRIPT_ARRAY_MAP, span: expression.span },
        [arguments_[0]!, receiver],
        expression.span,
      )
      : applyExpressions(
        { kind: "name", name: JAVASCRIPT_ARRAY_REDUCE, span: expression.span },
        [arguments_[0]!, arguments_[1]!, receiver],
        expression.span,
      );
  }

  private lowerFunctionExpression(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "function" }>,
    environment: JavaScriptAotEnvironment,
  ): FunctionalSurfaceExpression {
    if (expression.name !== null) {
      const coreName = this.freshBindingName(expression.name);
      const functionEnvironment = new Map(environment);
      functionEnvironment.set(expression.name, {
        coreName,
        functionArity: expression.parameters.length,
        functionLength: expression.parameterLength ?? expression.parameters.length,
        throwsAcrossCalls: statementsMayEscapeThrow(expression.body),
        zeroArgumentApplication: expression.parameters.length === 0,
        constantValue: null,
        objectFields: null,
        mutable: false,
        assignable: false,
      });
      const loweredFunction = this.lowerFunction(
        expression.parameters,
        expression.body,
        functionEnvironment,
        expression.span,
        `JavaScript function ${JSON.stringify(expression.name)}`,
        "callable",
        statementsMayEscapeThrow(expression.body),
      );
      return {
        kind: "let-rec-group",
        bindings: [{
          name: coreName,
          parameters: loweredFunction.parameters,
          body: loweredFunction.body,
          span: expression.span,
        }],
        body: { kind: "name", name: coreName, span: expression.span },
        span: expression.span,
      };
    }
    const loweredFunction = this.lowerFunction(
      expression.parameters,
      expression.body,
      environment,
      expression.span,
      "JavaScript function expression",
      "callable",
      statementsMayEscapeThrow(expression.body),
    );
    let body = loweredFunction.body;
    for (let index = loweredFunction.parameters.length - 1; index >= 0; index--) {
      body = {
        kind: "lambda",
        parameter: loweredFunction.parameters[index]!,
        body,
        span: expression.span,
      };
    }
    return body;
  }

  private lowerUndefined(
    span: { readonly startByte: number; readonly endByte: number },
  ): FunctionalSurfaceExpression {
    this.#usesNullish = true;
    return { kind: "name", name: JAVASCRIPT_UNDEFINED, span };
  }

  private lowerBinary(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "binary" }>,
    environment: JavaScriptAotEnvironment,
  ): FunctionalSurfaceExpression {
    if (JAVASCRIPT_BITWISE_OPERATORS.has(expression.operator)) {
      const constant = this.resolvePrimitiveConstant(expression, environment);
      if (constant?.kind !== "number") {
        throw new JavaScriptAotLoweringError(
          expression.span,
          `JavaScript ${expression.operator} requires statically known primitive operands in this AOT profile.`,
        );
      }
      return { kind: "float-64", value: constant.value, span: expression.span };
    }
    if (
      expression.operator === "same-value" || expression.operator === "not-same-value"
    ) {
      const equality = this.sameValueConstantEquality(
        expression.left,
        expression.right,
        environment,
      );
      if (equality === null) {
        throw new JavaScriptAotLoweringError(
          expression.span,
          "Test262 SameValue requires statically known primitive operands in this AOT profile.",
        );
      }
      return {
        kind: "boolean",
        value: expression.operator === "same-value" ? equality : !equality,
        span: expression.span,
      };
    }
    if (expression.operator === "instanceof") {
      if (expression.right.kind !== "name") {
        throw new JavaScriptAotLoweringError(
          expression.right.span,
          "JavaScript instanceof requires a statically named constructor in this AOT profile.",
        );
      }
      const target = expression.right.name;
      const exceptionConstructors = new Set([
        ...JAVASCRIPT_ERROR_CONSTRUCTORS,
        ...(this.options.exceptionConstructors ?? []),
      ]);
      if (target !== "Error" && !exceptionConstructors.has(target)) {
        throw new JavaScriptAotLoweringError(
          expression.right.span,
          `JavaScript instanceof constructor ${JSON.stringify(target)} is not supported.`,
        );
      }
      const leftConstant = this.resolveConstant(expression.left, environment);
      if (leftConstant?.kind === "new") {
        const matches = target === "Error"
          ? JAVASCRIPT_ERROR_CONSTRUCTORS.has(leftConstant.constructor)
          : leftConstant.constructor === target;
        return { kind: "boolean", value: matches, span: expression.span };
      }
      if (
        this.resolvePrimitiveConstant(expression.left, environment) !== null ||
        leftConstant !== null && isPrimitiveWrapper(leftConstant)
      ) {
        return { kind: "boolean", value: false, span: expression.span };
      }
      for (const constructor of exceptionConstructors) {
        this.#usedExceptionConstructors.add(constructor);
      }
      return {
        kind: "case",
        value: this.lowerExpression(expression.left, environment),
        arms: [...exceptionConstructors].sort().map((constructor) => ({
          constructor: javascriptExceptionConstructorName(constructor),
          binders: [],
          body: {
            kind: "boolean",
            value: target === "Error"
              ? JAVASCRIPT_ERROR_CONSTRUCTORS.has(constructor)
              : constructor === target,
            span: expression.span,
          },
          span: expression.span,
        })),
        span: expression.span,
      };
    }
    if (expression.operator === "&&" || expression.operator === "||") {
      const truthiness = this.constantTruthiness(expression.left, environment);
      if (truthiness !== null) {
        const useRight = expression.operator === "&&" ? truthiness : !truthiness;
        return this.lowerExpression(useRight ? expression.right : expression.left, environment);
      }
      const left = this.lowerExpression(expression.left, environment);
      const right = this.lowerExpression(expression.right, environment);
      const leftName = this.freshBindingName("logicalLeft");
      const leftReference: FunctionalSurfaceExpression = {
        kind: "name",
        name: leftName,
        span: expression.left.span,
      };
      return expression.operator === "&&"
        ? {
          kind: "let",
          name: leftName,
          value: left,
          body: {
            kind: "if",
            condition: leftReference,
            consequent: right,
            alternate: leftReference,
            span: expression.span,
          },
          span: expression.span,
        }
        : {
          kind: "let",
          name: leftName,
          value: left,
          body: {
            kind: "if",
            condition: leftReference,
            consequent: leftReference,
            alternate: right,
            span: expression.span,
          },
          span: expression.span,
        };
    }
    if (expression.operator === "==" || expression.operator === "!=") {
      const equality = this.looseConstantEquality(expression.left, expression.right, environment);
      if (equality === null) {
        throw new JavaScriptAotLoweringError(
          expression.span,
          "JavaScript loose equality requires statically known primitive operands in this AOT profile.",
        );
      }
      return {
        kind: "boolean",
        value: expression.operator === "==" ? equality : !equality,
        span: expression.span,
      };
    }
    if (expression.operator === "===" || expression.operator === "!==") {
      const equality = this.strictConstantEquality(expression.left, expression.right, environment);
      if (equality !== null) {
        return {
          kind: "boolean",
          value: expression.operator === "===" ? equality : !equality,
          span: expression.span,
        };
      }
    }
    if (expression.operator === "+") {
      const left = this.resolveCoerciblePrimitive(expression.left, environment);
      const right = this.resolveCoerciblePrimitive(expression.right, environment);
      if (left?.kind === "string" || right?.kind === "string") {
        if (left === null || right === null) {
          throw new JavaScriptAotLoweringError(
            expression.span,
            "JavaScript string concatenation requires statically known primitive operands in this AOT profile.",
          );
        }
        return {
          kind: "text",
          value: primitiveConstantToString(left) + primitiveConstantToString(right),
          span: expression.span,
        };
      }
      if (left !== null && right !== null) {
        return {
          kind: "float-64",
          value: primitiveConstantToRelationalNumber(left) +
            primitiveConstantToRelationalNumber(right),
          span: expression.span,
        };
      }
    }
    if (
      expression.operator === "<" || expression.operator === "<=" ||
      expression.operator === ">" || expression.operator === ">="
    ) {
      const comparison = this.constantRelationalComparison(
        expression.operator,
        expression.left,
        expression.right,
        environment,
      );
      if (comparison !== null) {
        return { kind: "boolean", value: comparison, span: expression.span };
      }
    }
    const operator = binaryOperators[expression.operator];
    if (operator === undefined) {
      throw new Error(`Missing JavaScript AOT operator lowering for ${expression.operator}.`);
    }
    const numericOrRelational = expression.operator !== "+" &&
      expression.operator !== "===" && expression.operator !== "!==";
    const left = numericOrRelational && expression.left.kind === "object" &&
        expression.left.properties.length === 0
      ? { kind: "float-64" as const, value: NaN, span: expression.left.span }
      : this.lowerExpression(expression.left, environment);
    const right = numericOrRelational && expression.right.kind === "object" &&
        expression.right.properties.length === 0
      ? { kind: "float-64" as const, value: NaN, span: expression.right.span }
      : this.lowerExpression(expression.right, environment);
    return {
      kind: "binary",
      operator,
      left,
      right,
      span: expression.span,
    };
  }

  private resolvePrimitiveConstant(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): JavaScriptPrimitiveConstant | null {
    if (
      expression.kind === "call" && expression.arguments.length === 0 &&
      expression.callee.kind === "function" && expression.callee.parameters.length === 0 &&
      expression.callee.body.length === 1 && expression.callee.body[0]?.kind === "return"
    ) {
      return this.resolvePrimitiveConstant(
        expression.callee.body[0].value,
        new Map(),
      );
    }
    if (
      expression.kind === "property" && expression.value.kind === "name" &&
      expression.value.name === "Number"
    ) {
      const value = JAVASCRIPT_NUMBER_CONSTANTS[expression.name];
      return value === undefined ? null : { kind: "number", value, span: expression.span };
    }
    if (expression.kind === "name") {
      if (expression.name === "undefined") return { kind: "undefined" };
      if (expression.name === "Infinity") {
        return { kind: "number", value: Infinity, span: expression.span };
      }
      if (expression.name === "NaN") {
        return { kind: "number", value: NaN, span: expression.span };
      }
      const constant = environment.get(expression.name)?.constantValue ?? null;
      return constant === null ? null : this.resolvePrimitiveConstant(constant, environment);
    }
    if (expression.kind === "unary") {
      if (expression.operator === "!") {
        const truthiness = this.constantTruthiness(expression.value, environment);
        return truthiness === null
          ? null
          : { kind: "boolean", value: !truthiness, span: expression.span };
      }
      const value = this.resolveCoerciblePrimitive(expression.value, environment);
      if (value === null) return null;
      switch (expression.operator) {
        case "+":
          return {
            kind: "number",
            value: primitiveConstantToRelationalNumber(value),
            span: expression.span,
          };
        case "-":
          return {
            kind: "number",
            value: -primitiveConstantToRelationalNumber(value),
            span: expression.span,
          };
        case "void":
          return { kind: "undefined" };
        case "typeof":
          return null;
        case "~":
          return {
            kind: "number",
            value: ~primitiveConstantToRelationalNumber(value),
            span: expression.span,
          };
      }
    }
    if (expression.kind === "binary" && expression.operator === "+") {
      const left = this.resolveCoerciblePrimitive(expression.left, environment);
      const right = this.resolveCoerciblePrimitive(expression.right, environment);
      if (left === null || right === null) return null;
      if (left.kind === "string" || right.kind === "string") {
        return {
          kind: "string",
          value: primitiveConstantToString(left) + primitiveConstantToString(right),
          raw: null,
          span: expression.span,
        };
      }
      return {
        kind: "number",
        value: primitiveConstantToRelationalNumber(left) +
          primitiveConstantToRelationalNumber(right),
        span: expression.span,
      };
    }
    if (expression.kind === "binary") {
      if (
        expression.operator === "same-value" || expression.operator === "not-same-value"
      ) {
        const equality = this.sameValueConstantEquality(
          expression.left,
          expression.right,
          environment,
        );
        return equality === null ? null : {
          kind: "boolean",
          value: expression.operator === "same-value" ? equality : !equality,
          span: expression.span,
        };
      }
      if (expression.operator === "instanceof") return null;
      if (JAVASCRIPT_BITWISE_OPERATORS.has(expression.operator)) {
        const left = this.resolveCoerciblePrimitive(expression.left, environment);
        const right = this.resolveCoerciblePrimitive(expression.right, environment);
        if (left === null || right === null) return null;
        const leftNumber = primitiveConstantToRelationalNumber(left);
        const rightNumber = primitiveConstantToRelationalNumber(right);
        const value = expression.operator === "<<"
          ? leftNumber << rightNumber
          : expression.operator === ">>"
          ? leftNumber >> rightNumber
          : expression.operator === ">>>"
          ? leftNumber >>> rightNumber
          : expression.operator === "&"
          ? leftNumber & rightNumber
          : expression.operator === "^"
          ? leftNumber ^ rightNumber
          : leftNumber | rightNumber;
        return { kind: "number", value, span: expression.span };
      }
      if (
        expression.operator === "<" || expression.operator === "<=" ||
        expression.operator === ">" || expression.operator === ">="
      ) {
        const value = this.constantRelationalComparison(
          expression.operator,
          expression.left,
          expression.right,
          environment,
        );
        return value === null ? null : { kind: "boolean", value, span: expression.span };
      }
      if (
        expression.operator === "===" || expression.operator === "!==" ||
        expression.operator === "==" || expression.operator === "!="
      ) {
        const strict = expression.operator === "===" || expression.operator === "!==";
        const value = strict
          ? this.strictConstantEquality(expression.left, expression.right, environment)
          : this.looseConstantEquality(expression.left, expression.right, environment);
        if (value === null) return null;
        const negated = expression.operator === "!==" || expression.operator === "!=";
        return { kind: "boolean", value: negated ? !value : value, span: expression.span };
      }
      if (expression.operator === "&&" || expression.operator === "||") {
        const left = this.resolvePrimitiveConstant(expression.left, environment);
        if (left === null) return null;
        const useRight = expression.operator === "&&"
          ? primitiveConstantTruthiness(left)
          : !primitiveConstantTruthiness(left);
        return useRight ? this.resolvePrimitiveConstant(expression.right, environment) : left;
      }
      const left = this.resolveCoerciblePrimitive(expression.left, environment);
      const right = this.resolveCoerciblePrimitive(expression.right, environment);
      if (left === null || right === null) return null;
      const leftNumber = primitiveConstantToRelationalNumber(left);
      const rightNumber = primitiveConstantToRelationalNumber(right);
      const value = expression.operator === "-"
        ? leftNumber - rightNumber
        : expression.operator === "*"
        ? leftNumber * rightNumber
        : expression.operator === "/"
        ? leftNumber / rightNumber
        : leftNumber % rightNumber;
      return { kind: "number", value, span: expression.span };
    }
    if (expression.kind === "conditional") {
      const condition = this.resolvePrimitiveConstant(expression.condition, environment);
      if (condition === null) return null;
      return this.resolvePrimitiveConstant(
        primitiveConstantTruthiness(condition) ? expression.consequent : expression.alternate,
        environment,
      );
    }
    return expression.kind === "number" || expression.kind === "string" ||
        expression.kind === "boolean" || expression.kind === "null"
      ? expression
      : null;
  }

  private resolveCoerciblePrimitive(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): JavaScriptPrimitiveConstant | null {
    if (expression.kind === "name") {
      const constant = environment.get(expression.name)?.constantValue ?? null;
      if (constant !== null) return this.resolveCoerciblePrimitive(constant, environment);
    }
    const primitive = this.resolvePrimitiveConstant(expression, environment);
    if (primitive !== null) return primitive;
    if (
      expression.kind !== "new" || expression.arguments.length > 1 ||
      expression.constructor !== "Boolean" && expression.constructor !== "Number" &&
        expression.constructor !== "String"
    ) return null;
    const argument = expression.arguments[0] === undefined
      ? null
      : this.resolveCoerciblePrimitive(expression.arguments[0], environment);
    if (expression.arguments.length === 1 && argument === null) return null;
    if (expression.constructor === "Boolean") {
      return {
        kind: "boolean",
        value: argument === null ? false : primitiveConstantTruthiness(argument),
        span: expression.span,
      };
    }
    if (expression.constructor === "Number") {
      return {
        kind: "number",
        value: argument === null ? 0 : primitiveConstantToRelationalNumber(argument),
        span: expression.span,
      };
    }
    return {
      kind: "string",
      value: argument === null ? "" : primitiveConstantToString(argument),
      raw: null,
      span: expression.span,
    };
  }

  private constantTruthiness(
    expression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): boolean | null {
    const primitive = this.resolvePrimitiveConstant(expression, environment);
    if (primitive !== null) return primitiveConstantTruthiness(primitive);
    const constant = expression.kind === "name"
      ? environment.get(expression.name)?.constantValue ?? expression
      : expression;
    if (
      constant.kind === "function" || constant.kind === "array" ||
      constant.kind === "object"
    ) return true;
    if (expression.kind === "name") {
      const binding = environment.get(expression.name);
      if (
        binding !== undefined &&
        (binding.functionArity !== null || binding.objectFields !== null)
      ) return true;
    }
    if (constant.kind === "new" && !isPrimitiveWrapper(constant)) return true;
    if (!isPrimitiveWrapper(constant)) return null;
    return constant.arguments.every((argument) =>
        this.resolveCoerciblePrimitive(argument, environment) !== null
      )
      ? true
      : null;
  }

  private sameValueConstantEquality(
    leftExpression: JavaScriptAotExpression,
    rightExpression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): boolean | null {
    const left = this.resolvePrimitiveConstant(leftExpression, environment);
    const right = this.resolvePrimitiveConstant(rightExpression, environment);
    if (left === null || right === null) return null;
    if (left.kind !== right.kind) return false;
    if (left.kind === "number") {
      return Object.is(
        left.value,
        (right as Extract<JavaScriptPrimitiveConstant, { readonly kind: "number" }>).value,
      );
    }
    return this.strictConstantEquality(leftExpression, rightExpression, environment);
  }

  private looseConstantEquality(
    leftExpression: JavaScriptAotExpression,
    rightExpression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): boolean | null {
    const leftConstant = this.resolveConstant(leftExpression, environment) ?? leftExpression;
    const rightConstant = this.resolveConstant(rightExpression, environment) ?? rightExpression;
    if (leftConstant === rightConstant && isPrimitiveWrapper(leftConstant)) return true;
    if (isPrimitiveWrapper(leftConstant) && isPrimitiveWrapper(rightConstant)) return false;
    const left = this.resolveCoerciblePrimitive(leftExpression, environment);
    const right = this.resolveCoerciblePrimitive(rightExpression, environment);
    if (left === null || right === null) return null;
    if (left.kind === "null" || left.kind === "undefined") {
      return right.kind === "null" || right.kind === "undefined";
    }
    if (right.kind === "null" || right.kind === "undefined") return false;
    if (left.kind === right.kind) {
      switch (left.kind) {
        case "number":
          return left.value === (right as Extract<JavaScriptPrimitiveConstant, {
            readonly kind: "number";
          }>).value;
        case "string":
          return left.value === (right as Extract<JavaScriptPrimitiveConstant, {
            readonly kind: "string";
          }>).value;
        case "boolean":
          return left.value === (right as Extract<JavaScriptPrimitiveConstant, {
            readonly kind: "boolean";
          }>).value;
      }
    }
    const leftNumber = primitiveConstantToLooseNumber(left);
    const rightNumber = primitiveConstantToLooseNumber(right);
    return leftNumber !== null && rightNumber !== null ? leftNumber === rightNumber : false;
  }

  private strictConstantEquality(
    leftExpression: JavaScriptAotExpression,
    rightExpression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): boolean | null {
    const leftConstant = this.resolveConstant(leftExpression, environment) ?? leftExpression;
    const rightConstant = this.resolveConstant(rightExpression, environment) ?? rightExpression;
    if (leftConstant === rightConstant && isPrimitiveWrapper(leftConstant)) return true;
    if (isPrimitiveWrapper(leftConstant) || isPrimitiveWrapper(rightConstant)) return false;
    const left = this.resolvePrimitiveConstant(leftExpression, environment);
    const right = this.resolvePrimitiveConstant(rightExpression, environment);
    if (left === null || right === null) return null;
    if (left.kind !== right.kind) return false;
    switch (left.kind) {
      case "number":
        return left.value === (right as Extract<JavaScriptPrimitiveConstant, {
          readonly kind: "number";
        }>).value;
      case "string":
        return left.value === (right as Extract<JavaScriptPrimitiveConstant, {
          readonly kind: "string";
        }>).value;
      case "boolean":
        return left.value === (right as Extract<JavaScriptPrimitiveConstant, {
          readonly kind: "boolean";
        }>).value;
      case "null":
      case "undefined":
        return true;
    }
  }

  private constantRelationalComparison(
    operator: "<" | "<=" | ">" | ">=",
    leftExpression: JavaScriptAotExpression,
    rightExpression: JavaScriptAotExpression,
    environment: JavaScriptAotEnvironment,
  ): boolean | null {
    const left = this.resolveCoerciblePrimitive(leftExpression, environment);
    const right = this.resolveCoerciblePrimitive(rightExpression, environment);
    if (left === null || right === null) return null;
    const leftValue = left.kind === "string" && right.kind === "string"
      ? left.value
      : primitiveConstantToRelationalNumber(left);
    const rightValue = left.kind === "string" && right.kind === "string"
      ? right.value
      : primitiveConstantToRelationalNumber(right);
    switch (operator) {
      case "<":
        return leftValue < rightValue;
      case "<=":
        return leftValue <= rightValue;
      case ">":
        return leftValue > rightValue;
      case ">=":
        return leftValue >= rightValue;
    }
  }

  private validateBlockBindings(
    statements: readonly JavaScriptAotStatement[],
    existingNames: ReadonlySet<string> = new Set(),
  ): void {
    const names = new Set(existingNames);
    for (const statement of statements) {
      if (
        statement.kind !== "constant" && statement.kind !== "mutable" &&
        statement.kind !== "function-declaration"
      ) continue;
      if (names.has(statement.name)) {
        throw new JavaScriptAotLoweringError(
          statement.span,
          `JavaScript lexical scope declares ${JSON.stringify(statement.name)} more than once.`,
        );
      }
      names.add(statement.name);
    }
    for (const statement of statements) {
      if (statement.kind === "function-declaration") {
        this.validateBlockBindings(statement.body, new Set(statement.parameters));
        continue;
      }
      if (statement.kind === "block") {
        this.validateBlockBindings(statement.statements);
        continue;
      }
      if (statement.kind === "while") {
        this.validateBlockBindings(statement.body);
        this.validateBlockBindings(statement.continueBody);
        continue;
      }
      if (statement.kind === "try") {
        this.validateBlockBindings(statement.body);
        if (statement.catchBody !== null) {
          this.validateBlockBindings(
            statement.catchBody,
            statement.catchName === null ? new Set() : new Set([statement.catchName]),
          );
        }
        if (statement.finallyBody !== null) this.validateBlockBindings(statement.finallyBody);
        continue;
      }
      if (statement.kind === "if") {
        this.validateBlockBindings(statement.consequent);
        if (statement.alternate !== null) this.validateBlockBindings(statement.alternate);
      }
    }
  }

  private freshBindingName(sourceName: string): string {
    return `$javascript#${this.#bindingIndex++}#${sourceName}`;
  }
}

function javascriptExceptionConstructorName(name: string): string {
  return `$JavaScriptError#${name}`;
}

function isPrimitiveWrapper(
  expression: JavaScriptAotExpression,
): expression is Extract<JavaScriptAotExpression, { readonly kind: "new" }> & {
  readonly constructor: "Boolean" | "Number" | "String";
} {
  return expression.kind === "new" && (
    expression.constructor === "Boolean" || expression.constructor === "Number" ||
    expression.constructor === "String"
  );
}

function primitiveConstantToString(expression: JavaScriptPrimitiveConstant): string {
  switch (expression.kind) {
    case "number":
      return String(expression.value);
    case "string":
      return expression.value;
    case "boolean":
      return expression.value ? "true" : "false";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
  }
}

function primitiveConstantExpression(
  constant: JavaScriptPrimitiveConstant | null,
  span: JavaScriptAotExpression["span"],
): JavaScriptAotExpression | null {
  if (constant === null) return null;
  if (constant.kind === "undefined") return { kind: "name", name: "undefined", span };
  return { ...constant, span };
}

function primitiveConstantToLooseNumber(expression: JavaScriptPrimitiveConstant): number | null {
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "string":
      return Number(expression.value);
    case "boolean":
      return expression.value ? 1 : 0;
    case "null":
    case "undefined":
      return null;
  }
}

function primitiveConstantToRelationalNumber(expression: JavaScriptPrimitiveConstant): number {
  switch (expression.kind) {
    case "number":
      return expression.value;
    case "string":
      return Number(expression.value);
    case "boolean":
      return expression.value ? 1 : 0;
    case "null":
      return 0;
    case "undefined":
      return NaN;
  }
}

function primitiveConstantTruthiness(expression: JavaScriptPrimitiveConstant): boolean {
  switch (expression.kind) {
    case "number":
      return expression.value !== 0 && !Number.isNaN(expression.value);
    case "string":
      return expression.value.length !== 0;
    case "boolean":
      return expression.value;
    case "null":
    case "undefined":
      return false;
  }
}

function literalTruthiness(expression: JavaScriptAotExpression): boolean | null {
  switch (expression.kind) {
    case "boolean":
      return expression.value;
    case "null":
      return false;
    case "number":
      return expression.value !== 0 && !Number.isNaN(expression.value);
    case "string":
      return expression.value.length !== 0;
    default:
      return null;
  }
}

function constantExpression(expression: JavaScriptAotExpression): JavaScriptAotExpression | null {
  switch (expression.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
      return expression;
    case "new":
      return isPrimitiveWrapper(expression) &&
          expression.arguments.every((argument) =>
            constantExpression(argument) !== null ||
            argument.kind === "name" &&
              (argument.name === "undefined" || argument.name === "NaN" ||
                argument.name === "Infinity")
          )
        ? expression
        : null;
    default:
      return null;
  }
}

function objectFields(expression: JavaScriptAotExpression | null): readonly string[] | null {
  return expression?.kind === "object"
    ? [...new Set(expression.properties.map((property) => property.name))].sort()
    : null;
}

function assignmentBinaryOperator(
  operator: Extract<JavaScriptAotStatement, { readonly kind: "assignment" }>["operator"],
): FunctionalBinaryOperator {
  switch (operator) {
    case "+=":
      return FunctionalBinaryOperator.AddFloat64;
    case "-=":
      return FunctionalBinaryOperator.SubtractFloat64;
    case "*=":
      return FunctionalBinaryOperator.MultiplyFloat64;
    case "/=":
      return FunctionalBinaryOperator.DivideFloat64;
    case "%=":
      return FunctionalBinaryOperator.RemainderFloat64;
    case "=":
    case "<<=":
    case ">>=":
    case ">>>=":
    case "&=":
    case "^=":
    case "|=":
      throw new Error(
        `JavaScript assignment ${operator} reached runtime operator lowering unexpectedly.`,
      );
  }
}

function applyExpressions(
  callee: FunctionalSurfaceExpression,
  arguments_: readonly FunctionalSurfaceExpression[],
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  let expression = callee;
  for (const argument of arguments_) {
    expression = { kind: "apply", callee: expression, argument, span };
  }
  return expression;
}

function assignedNamesInStatements(
  statements: readonly JavaScriptAotStatement[],
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    for (const name of assignedNamesInStatement(statement)) names.add(name);
  }
  return names;
}

function assignedNamesInStatement(statement: JavaScriptAotStatement): ReadonlySet<string> {
  const names = new Set<string>();
  const includeExpression = (expression: JavaScriptAotExpression): void => {
    for (const name of assignedNamesInExpression(expression)) names.add(name);
  };
  const includeBlock = (statements: readonly JavaScriptAotStatement[]): void => {
    for (const name of assignedNamesEscapingBlock(statements)) names.add(name);
  };
  switch (statement.kind) {
    case "function-declaration": {
      for (const name of assignedNamesInStatements(statement.body)) names.add(name);
      for (const parameter of statement.parameters) names.delete(parameter);
      for (const name of collectVarNames(statement.body)) names.delete(name);
      for (const declaration of statement.body) {
        if (
          declaration.kind === "constant" || declaration.kind === "mutable" ||
          declaration.kind === "function-declaration"
        ) names.delete(declaration.name);
      }
      return names;
    }
    case "assignment":
      names.add(statement.name);
      includeExpression(statement.value);
      return names;
    case "property-assignment":
      includeExpression(statement.target);
      includeExpression(statement.value);
      return names;
    case "var":
      for (const declaration of statement.declarations) {
        if (declaration.value !== null) includeExpression(declaration.value);
      }
      return names;
    case "constant":
    case "mutable":
    case "return":
    case "throw":
    case "expression":
      includeExpression(statement.value);
      return names;
    case "block":
      includeBlock(statement.statements);
      return names;
    case "while":
      includeExpression(statement.condition);
      includeBlock(statement.body);
      includeBlock(statement.continueBody);
      return names;
    case "try":
      includeBlock(statement.body);
      if (statement.catchBody !== null) {
        const catchAssignments = new Set(assignedNamesEscapingBlock(statement.catchBody));
        if (statement.catchName !== null) catchAssignments.delete(statement.catchName);
        for (const name of catchAssignments) names.add(name);
      }
      if (statement.finallyBody !== null) includeBlock(statement.finallyBody);
      return names;
    case "if":
      includeExpression(statement.condition);
      includeBlock(statement.consequent);
      if (statement.alternate !== null) includeBlock(statement.alternate);
      return names;
    case "break":
    case "continue":
      return names;
  }
}

function assignedNamesEscapingBlock(
  statements: readonly JavaScriptAotStatement[],
): ReadonlySet<string> {
  const names = new Set(assignedNamesInStatements(statements));
  for (const statement of statements) {
    if (
      statement.kind === "constant" || statement.kind === "mutable" ||
      statement.kind === "function-declaration"
    ) names.delete(statement.name);
  }
  return names;
}

function statementsMayEscapeThrow(statements: readonly JavaScriptAotStatement[]): boolean {
  return statements.some((statement) => {
    switch (statement.kind) {
      case "throw":
        return true;
      case "function-declaration":
        return false;
      case "block":
        return statementsMayEscapeThrow(statement.statements);
      case "while":
        return statementsMayEscapeThrow(statement.body) ||
          statementsMayEscapeThrow(statement.continueBody);
      case "if":
        return statementsMayEscapeThrow(statement.consequent) ||
          statement.alternate !== null && statementsMayEscapeThrow(statement.alternate);
      case "try":
        return statement.catchBody === null && statementsMayEscapeThrow(statement.body) ||
          statement.catchBody !== null && statementsMayEscapeThrow(statement.catchBody) ||
          statement.finallyBody !== null && statementsMayEscapeThrow(statement.finallyBody);
      default:
        return false;
    }
  });
}

function collectVarNames(statements: readonly JavaScriptAotStatement[]): ReadonlySet<string> {
  const names = new Set<string>();
  const pending = [...statements];
  while (pending.length !== 0) {
    const statement = pending.pop()!;
    if (statement.kind === "function-declaration") continue;
    if (statement.kind === "var") {
      for (const declaration of statement.declarations) names.add(declaration.name);
      continue;
    }
    if (statement.kind === "block" || statement.kind === "while") {
      if (statement.kind === "block") {
        pending.push(...statement.statements);
      } else {
        pending.push(...statement.body, ...statement.continueBody);
      }
      continue;
    }
    if (statement.kind === "try") {
      pending.push(...statement.body);
      if (statement.catchBody !== null) pending.push(...statement.catchBody);
      if (statement.finallyBody !== null) pending.push(...statement.finallyBody);
      continue;
    }
    if (statement.kind === "if") {
      pending.push(...statement.consequent);
      if (statement.alternate !== null) pending.push(...statement.alternate);
    }
  }
  return names;
}

function assignedNamesInExpression(expression: JavaScriptAotExpression): ReadonlySet<string> {
  const names = new Set<string>();
  const include = (nested: JavaScriptAotExpression): void => {
    for (const name of assignedNamesInExpression(nested)) names.add(name);
  };
  switch (expression.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "name":
      return names;
    case "array":
      for (const value of expression.values) include(value);
      return names;
    case "object":
      for (const property of expression.properties) include(property.value);
      return names;
    case "function": {
      for (const name of assignedNamesInStatements(expression.body)) names.add(name);
      if (expression.name !== null) names.delete(expression.name);
      for (const parameter of expression.parameters) names.delete(parameter);
      for (const name of collectVarNames(expression.body)) names.delete(name);
      for (const statement of expression.body) {
        if (
          statement.kind === "constant" || statement.kind === "mutable" ||
          statement.kind === "function-declaration"
        ) names.delete(statement.name);
      }
      return names;
    }
    case "unary":
      include(expression.value);
      return names;
    case "binary":
      include(expression.left);
      include(expression.right);
      return names;
    case "conditional":
      include(expression.condition);
      include(expression.consequent);
      include(expression.alternate);
      return names;
    case "call":
      include(expression.callee);
      for (const argument of expression.arguments) include(argument);
      return names;
    case "new":
      for (const argument of expression.arguments) include(argument);
      return names;
    case "property":
      include(expression.value);
      return names;
    case "index":
      include(expression.value);
      include(expression.index);
      return names;
  }
}
