import {
  type EncodedFunctionalModule,
  FunctionalBinaryOperator,
  FunctionalNumericConversion,
  type FunctionalSourceType,
  type FunctionalTypeSchema,
  FunctionalUnaryOperator,
} from "../../../src/functional/abi.ts";
import {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceCaseArm,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
} from "../../../src/functional/surface_builder.ts";
import { analyzeFunctionalSurfaceReachability } from "../../../src/functional/surface_reachability.ts";
import type {
  JavaScriptAotClassMethod,
  JavaScriptAotExpression,
  JavaScriptAotFunctionDeclaration,
  JavaScriptAotModule,
  JavaScriptAotStatement,
} from "./ast.ts";
import { JavaScriptAotLoweringError } from "./diagnostic.ts";
import {
  JAVASCRIPT_RUNTIME_ADD,
  JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT,
  JAVASCRIPT_RUNTIME_DEFINE_BINDING,
  JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED,
  JAVASCRIPT_RUNTIME_EMPTY_STATE,
  JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE,
  JAVASCRIPT_RUNTIME_HAS_PROTOTYPE,
  JAVASCRIPT_RUNTIME_INITIALIZE_BINDING,
  JAVASCRIPT_RUNTIME_IS_CALLABLE,
  JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT,
  JAVASCRIPT_RUNTIME_LOOKUP_BINDING,
  JAVASCRIPT_RUNTIME_LOOKUP_OWN_PROPERTY,
  JAVASCRIPT_RUNTIME_OBJECT_KIND,
  JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE,
  JAVASCRIPT_RUNTIME_REALM,
  JAVASCRIPT_RUNTIME_SAME_VALUE,
  JAVASCRIPT_RUNTIME_SET_BINDING,
  JAVASCRIPT_RUNTIME_STRICT_EQUAL,
  JAVASCRIPT_RUNTIME_THIS_VALUE,
  JAVASCRIPT_RUNTIME_TO_BOOLEAN,
  JAVASCRIPT_RUNTIME_TO_NUMBER,
  JAVASCRIPT_RUNTIME_TYPEOF,
  JAVASCRIPT_RUNTIME_WITH_GLOBAL_THIS,
  javascriptRuntimeSurface,
} from "./runtime.ts";
import * as Runtime from "./runtime_contract.ts";

export interface LoweredJavaScriptRuntimeModule {
  readonly sourceModule: JavaScriptAotModule;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly module: EncodedFunctionalModule;
}

export interface JavaScriptRuntimeLoweringOptions {
  readonly runtimeFaultConstructors?: ReadonlyMap<string, string>;
  readonly callThisMode?: "strict" | "sloppy";
  readonly entryThisMode?: "undefined" | "global";
  readonly allowUnresolvedReferences?: true;
}

type RuntimeExpressionContinuation = (
  state: FunctionalSurfaceExpression,
  value: FunctionalSurfaceExpression,
) => FunctionalSurfaceExpression;

type RuntimeStatementContinuation = (
  state: FunctionalSurfaceExpression,
) => FunctionalSurfaceExpression;

type RuntimeEntryResultKind = "boolean" | "number" | "string";
type RuntimeExpressionResultKind = RuntimeEntryResultKind | "never";

interface RuntimeFunction {
  readonly id: number;
  readonly name: string;
  readonly thisMode: "dynamic" | "lexical";
  readonly strict: boolean;
  readonly usesArguments: boolean;
  readonly parameters: readonly string[];
  readonly functionLength: number;
  readonly classMethods: readonly JavaScriptAotClassMethod[] | null;
  readonly body: readonly JavaScriptAotStatement[];
  readonly span: JavaScriptAotExpression["span"];
}

type RuntimeFunctionSyntax =
  | Extract<JavaScriptAotStatement, { readonly kind: "function-declaration" }>
  | Extract<JavaScriptAotExpression, { readonly kind: "function" }>;

interface RuntimeAccessorDescriptor {
  readonly getter: FunctionalSurfaceExpression;
  readonly setter: FunctionalSurfaceExpression;
  readonly enumerable: boolean;
  readonly configurable: boolean;
}

const runtimeNumericOperators: Readonly<Partial<Record<string, FunctionalBinaryOperator>>> = {
  "+": FunctionalBinaryOperator.AddFloat64,
  "-": FunctionalBinaryOperator.SubtractFloat64,
  "*": FunctionalBinaryOperator.MultiplyFloat64,
  "/": FunctionalBinaryOperator.DivideFloat64,
  "%": FunctionalBinaryOperator.RemainderFloat64,
  "<": FunctionalBinaryOperator.LessFloat64,
  "<=": FunctionalBinaryOperator.LessEqualFloat64,
  ">": FunctionalBinaryOperator.GreaterFloat64,
  ">=": FunctionalBinaryOperator.GreaterEqualFloat64,
};
const JAVASCRIPT_RUNTIME_ERROR_CONSTRUCTORS = new Set([
  "Error",
  "AggregateError",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "Test262Error",
  "TypeError",
  "URIError",
]);
const JAVASCRIPT_RUNTIME_CALL_DISPATCH = "$javascript#dispatchCall";
const JAVASCRIPT_RUNTIME_TO_PRIMITIVE = "$javascript#toPrimitive";
export function requiresJavaScriptRuntimeModel(sourceModule: JavaScriptAotModule): boolean {
  return sourceModule.declarations.some((declaration) =>
    declaration.kind === "constant"
      ? expressionRequiresRuntimeModel(declaration.value)
      : declaration.requiresRuntimeModel === true ||
        runtimeStatementsRequireModel(declaration.body)
  );
}

export function lowerJavaScriptRuntimeModule(
  sourceModule: JavaScriptAotModule,
  entryName: string,
  options: JavaScriptRuntimeLoweringOptions = {},
): LoweredJavaScriptRuntimeModule {
  const lowering = new JavaScriptRuntimeLowering(sourceModule, entryName, options);
  return lowering.lower();
}

export function validateJavaScriptRuntimeResolution(
  sourceModule: JavaScriptAotModule,
  entryName: string,
): void {
  new JavaScriptRuntimeLowering(sourceModule, entryName, {}).validateResolution();
}

class JavaScriptRuntimeLowering {
  #bindingIndex = 0;
  readonly #functions: RuntimeFunction[] = [];
  readonly #functionsBySyntax = new WeakMap<RuntimeFunctionSyntax, RuntimeFunction>();
  readonly #usesSharedCallDispatcher: boolean;
  readonly #usesFunctionLength: boolean;
  readonly #maximumSourceCallArgumentCount: number;

  constructor(
    private readonly sourceModule: JavaScriptAotModule,
    private readonly entryName: string,
    private readonly options: JavaScriptRuntimeLoweringOptions,
  ) {
    this.#usesSharedCallDispatcher = sourceModule.declarations.some((declaration) =>
      declaration.kind === "constant"
        ? runtimeExpressionNeedsSharedCallDispatcher(declaration.value)
        : runtimeStatementsNeedSharedCallDispatcher(declaration.body) ||
          (declaration.classMethods ?? []).some((method) =>
            runtimeExpressionNeedsSharedCallDispatcher(method.value)
          )
    );
    this.#usesFunctionLength = sourceModule.declarations.some((declaration) =>
      declaration.kind === "constant"
        ? runtimeExpressionReadsProperty(declaration.value, "length")
        : runtimeStatementsReadProperty(declaration.body, "length") ||
          (declaration.classMethods ?? []).some((method) =>
            runtimeExpressionReadsProperty(method.value, "length")
          )
    );
    this.#maximumSourceCallArgumentCount = sourceModule.declarations.reduce(
      (maximum, declaration) =>
        Math.max(
          maximum,
          declaration.kind === "constant"
            ? runtimeExpressionMaximumCallArgumentCount(declaration.value)
            : Math.max(
              runtimeStatementsMaximumCallArgumentCount(declaration.body),
              ...Array.from(
                declaration.classMethods ?? [],
                (method) => runtimeExpressionMaximumCallArgumentCount(method.value),
              ),
            ),
        ),
      0,
    );
  }

  validateResolution(): void {
    this.validateEntryResolution(this.requireEntry());
  }

  private validateEntryResolution(entry: JavaScriptAotFunctionDeclaration): void {
    if (this.options.allowUnresolvedReferences === true) return;
    const unresolvedName = firstRuntimeUnresolvedName(entry);
    if (unresolvedName !== null) {
      throw new JavaScriptAotLoweringError(
        unresolvedName.span,
        `JavaScript runtime-model name ${JSON.stringify(unresolvedName.name)} is not declared.`,
      );
    }
  }

  lower(): LoweredJavaScriptRuntimeModule {
    const entry = this.requireEntry();
    this.validateEntryResolution(entry);
    this.prepareRuntimeProgram(entry.body);
    const entryResultKind = runtimeEntryResultKind(entry);
    const runtime = javascriptRuntimeSurface(this.sourceModule.span.endByte);
    const emptyState = reference(JAVASCRIPT_RUNTIME_EMPTY_STATE, entry.span);
    const initialState = this.extendFunctionStateWithDeclarations(
      (this.options.entryThisMode ??
          ((this.options.callThisMode ?? "strict") === "sloppy" ? "global" : "undefined")) ===
          "global"
        ? call(JAVASCRIPT_RUNTIME_WITH_GLOBAL_THIS, [emptyState], entry.span)
        : emptyState,
      entry.body,
    );
    const entryDefinition: FunctionalSurfaceDefinition = {
      name: entry.name,
      parameters: [],
      annotation: null,
      body: this.unwrapEntryCompletion(
        this.initializeHoistedFunctions(
          entry.body,
          0,
          initialState,
          (readyState) => this.lowerStatements(entry.body, 0, readyState),
        ),
        entry.span,
        entryResultKind,
      ),
      span: entry.span,
    };
    const functionDefinitions: FunctionalSurfaceDefinition[] = [];
    for (let index = 0; index < this.#functions.length; index++) {
      functionDefinitions.push(this.lowerFunctionDefinition(this.#functions[index]!));
    }
    functionDefinitions.sort((left, right) =>
      (left.span?.startByte ?? 0) - (right.span?.startByte ?? 0)
    );
    const dispatcherDefinitions = this.#usesSharedCallDispatcher
      ? [this.lowerRuntimeCallDispatcher({
        startByte: this.sourceModule.span.endByte,
        endByte: this.sourceModule.span.endByte,
      })]
      : [];
    const primitiveConversionDefinitions = this.#usesSharedCallDispatcher
      ? [this.lowerRuntimePrimitiveDefinition({
        startByte: this.sourceModule.span.endByte,
        endByte: this.sourceModule.span.endByte,
      })]
      : [];
    const sourceDefinitions = [entryDefinition, ...functionDefinitions];
    sourceDefinitions.sort((left, right) =>
      (left.span?.startByte ?? 0) - (right.span?.startByte ?? 0)
    );
    const candidateDefinitions = [
      ...sourceDefinitions,
      ...dispatcherDefinitions,
      ...primitiveConversionDefinitions,
      ...runtime.definitions,
    ];
    const reachability = analyzeFunctionalSurfaceReachability(candidateDefinitions, [entry.name]);
    const definitions = candidateDefinitions.filter((definition) =>
      reachability.definitionNames.has(definition.name)
    );
    return {
      sourceModule: this.sourceModule,
      definitions,
      module: buildFunctionalSurfaceModule(
        definitions,
        runtime.typeDeclarations,
        entry.name,
        this.sourceModule.span.endByte,
      ),
    };
  }

  private lowerFunctionDefinition(
    runtimeFunction: RuntimeFunction,
  ): FunctionalSurfaceDefinition {
    const heapName = this.freshName("functionHeap");
    const realmName = this.freshName("functionRealm");
    const environmentName = this.freshName("capturedEnvironment");
    const bindingsName = this.freshName("functionBindings");
    const thisValueName = this.freshName("thisValue");
    const calleeName = this.freshName("callee");
    const argumentCountName = this.freshName("argumentCount");
    const argumentNames = Array.from(
      { length: this.maximumRuntimeArgumentCount() },
      () => this.freshName("argument"),
    );
    let state = call(Runtime.JAVASCRIPT_STATE, [
      reference(heapName, runtimeFunction.span),
      call(Runtime.JAVASCRIPT_EXECUTION_CONTEXT, [
        reference(realmName, runtimeFunction.span),
        reference(environmentName, runtimeFunction.span),
        reference(environmentName, runtimeFunction.span),
        reference(thisValueName, runtimeFunction.span),
      ], runtimeFunction.span),
      reference(bindingsName, runtimeFunction.span),
    ], runtimeFunction.span);
    state = this.defineRuntimeArgumentsBinding(
      state,
      runtimeFunction,
      reference(calleeName, runtimeFunction.span),
      reference(argumentCountName, runtimeFunction.span),
      argumentNames.map((name) => reference(name, runtimeFunction.span)),
    );
    for (let index = 0; index < runtimeFunction.parameters.length; index++) {
      state = call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
        state,
        text(runtimeFunction.parameters[index]!, runtimeFunction.span),
        call(Runtime.JAVASCRIPT_BINDING_MUTABLE, [
          reference(argumentNames[index]!, runtimeFunction.span),
        ], runtimeFunction.span),
      ], runtimeFunction.span);
    }
    state = this.extendFunctionStateWithDeclarations(
      state,
      runtimeFunction.body,
    );
    return {
      name: runtimeFunction.name,
      parameters: [
        heapName,
        realmName,
        environmentName,
        bindingsName,
        thisValueName,
        calleeName,
        argumentCountName,
        ...argumentNames,
      ],
      annotation: this.#usesSharedCallDispatcher
        ? runtimeFunctionType(this.maximumRuntimeArgumentCount(), runtimeFunction.span)
        : null,
      body: this.initializeHoistedFunctions(
        runtimeFunction.body,
        0,
        state,
        (readyState) => this.lowerStatements(runtimeFunction.body, 0, readyState),
      ),
      span: runtimeFunction.span,
    };
  }

  private defineRuntimeArgumentsBinding(
    state: FunctionalSurfaceExpression,
    runtimeFunction: RuntimeFunction,
    callee: FunctionalSurfaceExpression,
    argumentCount: FunctionalSurfaceExpression,
    arguments_: readonly FunctionalSurfaceExpression[],
  ): FunctionalSurfaceExpression {
    if (!runtimeFunction.usesArguments || runtimeFunction.parameters.includes("arguments")) {
      return state;
    }
    const span = runtimeFunction.span;
    const stateName = this.freshName("argumentsState");
    const heapName = this.freshName("argumentsHeap");
    const contextName = this.freshName("argumentsContext");
    const bindingsName = this.freshName("argumentsBindings");
    const allocatedHeapName = this.freshName("allocatedArgumentsHeap");
    const argumentsValueName = this.freshName("argumentsValue");
    return letExpression(
      stateName,
      state,
      match(reference(stateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, contextName, bindingsName],
        body: match(
          call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
            reference(heapName, span),
            reference(Runtime.JAVASCRIPT_VALUE_NULL, span),
            reference(Runtime.JAVASCRIPT_OBJECT_ORDINARY, span),
          ], span),
          [{
            constructor: Runtime.JAVASCRIPT_HEAP_ALLOCATION,
            binders: [allocatedHeapName, argumentsValueName],
            body: match(
              reference(argumentsValueName, span),
              this.expectObjectArms(span, (identity) => {
                let argumentsHeap = call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
                  reference(allocatedHeapName, span),
                  identity,
                  call(Runtime.JAVASCRIPT_PROPERTY_KEY_STRING, [text("length", span)], span),
                  call(Runtime.JAVASCRIPT_DATA_DESCRIPTOR, [
                    call(Runtime.JAVASCRIPT_VALUE_NUMBER, [
                      {
                        kind: "numeric-convert",
                        conversion: FunctionalNumericConversion.SignedInteger32ToFloat64,
                        value: argumentCount,
                        span,
                      },
                    ], span),
                    boolean(true, span),
                    boolean(false, span),
                    boolean(true, span),
                  ], span),
                ], span);
                argumentsHeap = call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
                  argumentsHeap,
                  identity,
                  call(Runtime.JAVASCRIPT_PROPERTY_KEY_STRING, [text("callee", span)], span),
                  runtimeFunction.strict
                    ? call(Runtime.JAVASCRIPT_ACCESSOR_DESCRIPTOR, [
                      reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, span),
                      reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, span),
                      boolean(false, span),
                      boolean(false, span),
                    ], span)
                    : call(Runtime.JAVASCRIPT_DATA_DESCRIPTOR, [
                      callee,
                      boolean(true, span),
                      boolean(false, span),
                      boolean(true, span),
                    ], span),
                ], span);
                for (let index = 0; index < arguments_.length; index++) {
                  argumentsHeap = conditional(
                    binary(
                      FunctionalBinaryOperator.Less,
                      integer(index, span),
                      argumentCount,
                      span,
                    ),
                    call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
                      argumentsHeap,
                      identity,
                      call(
                        Runtime.JAVASCRIPT_PROPERTY_KEY_STRING,
                        [text(String(index), span)],
                        span,
                      ),
                      call(Runtime.JAVASCRIPT_DATA_DESCRIPTOR, [
                        arguments_[index]!,
                        boolean(true, span),
                        boolean(true, span),
                        boolean(true, span),
                      ], span),
                    ], span),
                    argumentsHeap,
                    span,
                  );
                }
                return call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
                  call(Runtime.JAVASCRIPT_STATE, [
                    argumentsHeap,
                    reference(contextName, span),
                    reference(bindingsName, span),
                  ], span),
                  text("arguments", span),
                  call(Runtime.JAVASCRIPT_BINDING_MUTABLE, [
                    reference(argumentsValueName, span),
                  ], span),
                ], span);
              }),
              span,
            ),
            span,
          }],
          span,
        ),
        span,
      }], span),
      span,
    );
  }

  private requireEntry(): JavaScriptAotFunctionDeclaration {
    const entry = this.sourceModule.declarations.find((declaration) =>
      declaration.name === this.entryName
    );
    if (entry === undefined) {
      throw new JavaScriptAotLoweringError(
        this.sourceModule.span,
        `JavaScript module ${JSON.stringify(this.sourceModule.name)} has no entry ${
          JSON.stringify(this.entryName)
        }.`,
      );
    }
    if (entry.kind !== "function") {
      throw new JavaScriptAotLoweringError(
        entry.span,
        `JavaScript runtime entry ${JSON.stringify(this.entryName)} must be a function.`,
      );
    }
    if (entry.parameters.length !== 0) {
      throw new JavaScriptAotLoweringError(
        entry.span,
        `JavaScript runtime entry ${JSON.stringify(this.entryName)} cannot require arguments.`,
      );
    }
    const linkedStatements = this.sourceModule.declarations.flatMap(
      (declaration): readonly JavaScriptAotStatement[] => {
        if (declaration === entry) return [];
        return declaration.kind === "function"
          ? [{
            kind: "function-declaration",
            name: declaration.name,
            parameters: declaration.parameters,
            parameterLength: declaration.parameterLength ?? declaration.parameters.length,
            ...(declaration.requiresRuntimeModel === true
              ? { requiresRuntimeModel: true as const }
              : {}),
            ...(declaration.classMethods === undefined
              ? {}
              : { classMethods: declaration.classMethods }),
            body: declaration.body,
            span: declaration.span,
          }]
          : [{
            kind: "constant",
            name: declaration.name,
            value: declaration.value,
            span: declaration.span,
          }];
      },
    );
    return { ...entry, body: [...linkedStatements, ...entry.body] };
  }

  private extendFunctionStateWithDeclarations(
    base: FunctionalSurfaceExpression,
    statements: readonly JavaScriptAotStatement[],
  ): FunctionalSurfaceExpression {
    let state = base;
    const names = new Set<string>();
    for (const declaration of runtimeVarDeclarations(statements)) {
      if (names.has(declaration.name)) continue;
      names.add(declaration.name);
      state = call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
        state,
        text(declaration.name, declaration.span),
        call(Runtime.JAVASCRIPT_BINDING_MUTABLE, [
          reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, declaration.span),
        ], declaration.span),
      ], declaration.span);
    }
    return this.extendLexicalStateWithDeclarations(state, statements, names);
  }

  private extendLexicalStateWithDeclarations(
    base: FunctionalSurfaceExpression,
    statements: readonly JavaScriptAotStatement[],
    existingNames: ReadonlySet<string> = new Set(),
  ): FunctionalSurfaceExpression {
    let state = base;
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
      state = call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
        state,
        text(statement.name, statement.span),
        call(Runtime.JAVASCRIPT_BINDING_UNINITIALIZED, [
          boolean(statement.kind !== "constant", statement.span),
        ], statement.span),
      ], statement.span);
    }
    return state;
  }

  private initializeHoistedFunctions(
    statements: readonly JavaScriptAotStatement[],
    index: number,
    state: FunctionalSurfaceExpression,
    onReady: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    const statement = statements[index];
    if (statement === undefined) return onReady(state);
    if (statement.kind !== "function-declaration" || statement.classMethods !== undefined) {
      return this.initializeHoistedFunctions(statements, index + 1, state, onReady);
    }
    const runtimeFunction = this.preparedRuntimeFunction(statement);
    return this.allocateRuntimeFunction(
      runtimeFunction,
      state,
      (allocatedState, value) =>
        this.initializeBinding(
          allocatedState,
          statement.name,
          value,
          (initializedState) =>
            this.initializeHoistedFunctions(statements, index + 1, initializedState, onReady),
          statement.span,
        ),
    );
  }

  private lowerStatements(
    statements: readonly JavaScriptAotStatement[],
    index: number,
    state: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const statement = statements[index];
    if (statement === undefined) {
      return call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
        state,
        reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, this.sourceModule.span),
      ], this.sourceModule.span);
    }
    const nextStatement = statements[index + 1];
    if (nextStatement === undefined) {
      return this.lowerStatement(
        statement,
        state,
        (nextState) => this.lowerStatements(statements, index + 1, nextState),
      );
    }
    const continuationName = this.freshName("statementContinuation");
    const continuationStateName = this.freshName("statementContinuationState");
    return {
      kind: "let-rec-group",
      bindings: [{
        name: continuationName,
        parameters: [continuationStateName],
        body: this.lowerStatements(
          statements,
          index + 1,
          reference(continuationStateName, nextStatement.span),
        ),
        span: nextStatement.span,
      }],
      body: this.lowerStatement(
        statement,
        state,
        (nextState) => call(continuationName, [nextState], statement.span),
      ),
      span: statement.span,
    };
  }

  private lowerStatement(
    statement: JavaScriptAotStatement,
    state: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    switch (statement.kind) {
      case "function-declaration": {
        if (statement.classMethods === undefined) return onNormal(state);
        return this.allocateRuntimeFunction(
          this.preparedRuntimeFunction(statement),
          state,
          (allocatedState, value) =>
            this.initializeBinding(
              allocatedState,
              statement.name,
              value,
              onNormal,
              statement.span,
            ),
        );
      }
      case "constant":
      case "mutable":
        return this.lowerExpression(
          statement.value,
          state,
          (valueState, value) =>
            this.initializeBinding(valueState, statement.name, value, onNormal, statement.span),
        );
      case "assignment":
        if (statement.operator !== "=") {
          throw new JavaScriptAotLoweringError(
            statement.span,
            `JavaScript runtime-model assignment ${
              JSON.stringify(statement.operator)
            } is not yet supported.`,
          );
        }
        return this.lowerExpression(
          statement.value,
          state,
          (valueState, value) =>
            this.setBinding(valueState, statement.name, value, onNormal, statement.span),
        );
      case "property-assignment":
        return this.lowerPropertyAssignment(statement, state, onNormal);
      case "var":
        return this.lowerVarDeclarations(statement, 0, state, onNormal);
      case "return":
        return this.lowerExpression(
          statement.value,
          state,
          (valueState, value) =>
            call(Runtime.JAVASCRIPT_COMPLETION_RETURN, [valueState, value], statement.span),
        );
      case "throw":
        return this.lowerExpression(
          statement.value,
          state,
          (valueState, value) =>
            call(Runtime.JAVASCRIPT_COMPLETION_THROW, [valueState, value], statement.span),
        );
      case "expression":
        return this.lowerExpressionStatement(statement.value, state, onNormal);
      case "if":
        return this.lowerExpression(
          statement.condition,
          state,
          (conditionState, conditionValue) =>
            this.resumeNormalCompletion(
              conditional(
                call(JAVASCRIPT_RUNTIME_TO_BOOLEAN, [conditionValue], statement.condition.span),
                this.lowerStatementBranch(
                  statement.consequent,
                  conditionState,
                  (branchState) =>
                    call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                      branchState,
                      reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, statement.span),
                    ], statement.span),
                ),
                statement.alternate === null
                  ? call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                    conditionState,
                    reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, statement.span),
                  ], statement.span)
                  : this.lowerStatementBranch(
                    statement.alternate,
                    conditionState,
                    (branchState) =>
                      call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                        branchState,
                        reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, statement.span),
                      ], statement.span),
                  ),
                statement.span,
              ),
              onNormal,
              statement.span,
            ),
        );
      case "block":
        return this.lowerStatementBranch(statement.statements, state, onNormal);
      case "try":
        return this.lowerTryCatch(statement, state, onNormal);
      default:
        throw new JavaScriptAotLoweringError(
          statement.span,
          `JavaScript ${statement.kind} statement is not yet supported by runtime-model lowering.`,
        );
    }
  }

  private lowerExpressionStatement(
    expression: JavaScriptAotExpression,
    state: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    return this.lowerExpression(expression, state, (nextState) => onNormal(nextState));
  }

  private lowerStatementBranch(
    statements: readonly JavaScriptAotStatement[],
    state: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    const span = statements[0]?.span ?? this.sourceModule.span;
    const stateName = this.freshName("blockState");
    const heapName = this.freshName("blockHeap");
    const outerContextName = this.freshName("blockOuterContext");
    const bindingsName = this.freshName("blockBindings");
    return letExpression(
      stateName,
      state,
      match(reference(stateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, outerContextName, bindingsName],
        body: this.resumeNormalCompletion(
          this.restoreCompletionContext(
            this.initializeHoistedFunctions(
              statements,
              0,
              this.extendLexicalStateWithDeclarations(reference(stateName, span), statements),
              (readyState) => this.lowerStatements(statements, 0, readyState),
            ),
            reference(outerContextName, span),
            span,
          ),
          onNormal,
          span,
        ),
        span,
      }], span),
      span,
    );
  }

  private lowerVarDeclarations(
    statement: Extract<JavaScriptAotStatement, { readonly kind: "var" }>,
    index: number,
    state: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    const declaration = statement.declarations[index];
    if (declaration === undefined) return onNormal(state);
    if (declaration.value === null) {
      return this.lowerVarDeclarations(statement, index + 1, state, onNormal);
    }
    return this.lowerExpression(declaration.value, state, (valueState, value) =>
      this.setBinding(
        valueState,
        declaration.name,
        value,
        (nextState) => this.lowerVarDeclarations(statement, index + 1, nextState, onNormal),
        declaration.span,
      ));
  }

  private lowerTryCatch(
    statement: Extract<JavaScriptAotStatement, { readonly kind: "try" }>,
    state: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    if (statement.finallyBody !== null) {
      throw new JavaScriptAotLoweringError(
        statement.span,
        "JavaScript runtime-model finally completion replacement is not yet supported.",
      );
    }
    if (statement.catchBody === null) {
      throw new JavaScriptAotLoweringError(
        statement.span,
        "JavaScript runtime-model try requires a catch clause.",
      );
    }
    const bodyCompletion = this.lowerStatementBranch(
      statement.body,
      state,
      (bodyState) =>
        call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
          bodyState,
          reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, statement.span),
        ], statement.span),
    );
    const normalStateName = this.freshName("tryNormalState");
    const normalValueName = this.freshName("tryNormalValue");
    const returnStateName = this.freshName("tryReturnState");
    const returnValueName = this.freshName("tryReturnValue");
    const throwStateName = this.freshName("tryThrowState");
    const throwValueName = this.freshName("tryThrowValue");
    const breakStateName = this.freshName("tryBreakState");
    const breakTargetName = this.freshName("tryBreakTarget");
    const continueStateName = this.freshName("tryContinueState");
    const continueTargetName = this.freshName("tryContinueTarget");
    const completion = match(bodyCompletion, [{
      constructor: Runtime.JAVASCRIPT_COMPLETION_NORMAL,
      binders: [normalStateName, normalValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
        reference(normalStateName, statement.span),
        reference(normalValueName, statement.span),
      ], statement.span),
      span: statement.span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_RETURN,
      binders: [returnStateName, returnValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_RETURN, [
        reference(returnStateName, statement.span),
        reference(returnValueName, statement.span),
      ], statement.span),
      span: statement.span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_THROW,
      binders: [throwStateName, throwValueName],
      body: this.lowerCatch(
        statement,
        reference(throwStateName, statement.span),
        reference(throwValueName, statement.span),
        (catchState) =>
          call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
            catchState,
            reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, statement.span),
          ], statement.span),
      ),
      span: statement.span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_BREAK,
      binders: [breakStateName, breakTargetName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_BREAK, [
        reference(breakStateName, statement.span),
        reference(breakTargetName, statement.span),
      ], statement.span),
      span: statement.span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_CONTINUE,
      binders: [continueStateName, continueTargetName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_CONTINUE, [
        reference(continueStateName, statement.span),
        reference(continueTargetName, statement.span),
      ], statement.span),
      span: statement.span,
    }], statement.span);
    return this.resumeNormalCompletion(completion, onNormal, statement.span);
  }

  private lowerCatch(
    statement: Extract<JavaScriptAotStatement, { readonly kind: "try" }>,
    thrownState: FunctionalSurfaceExpression,
    thrownValue: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    const stateName = this.freshName("caughtState");
    const heapName = this.freshName("caughtHeap");
    const outerContextName = this.freshName("catchOuterContext");
    const bindingsName = this.freshName("catchBindings");
    return letExpression(
      stateName,
      thrownState,
      match(reference(stateName, statement.span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, outerContextName, bindingsName],
        body: this.resumeNormalCompletion(
          this.restoreCompletionContext(
            this.lowerStatementBranch(
              statement.catchBody!,
              statement.catchName === null
                ? call(Runtime.JAVASCRIPT_STATE, [
                  reference(heapName, statement.span),
                  reference(outerContextName, statement.span),
                  reference(bindingsName, statement.span),
                ], statement.span)
                : call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
                  call(Runtime.JAVASCRIPT_STATE, [
                    reference(heapName, statement.span),
                    reference(outerContextName, statement.span),
                    reference(bindingsName, statement.span),
                  ], statement.span),
                  text(statement.catchName, statement.span),
                  call(Runtime.JAVASCRIPT_BINDING_MUTABLE, [thrownValue], statement.span),
                ], statement.span),
              (catchState) =>
                call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                  catchState,
                  reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, statement.span),
                ], statement.span),
            ),
            reference(outerContextName, statement.span),
            statement.span,
          ),
          onNormal,
          statement.span,
        ),
        span: statement.span,
      }], statement.span),
      statement.span,
    );
  }

  private restoreCompletionContext(
    completion: FunctionalSurfaceExpression,
    context: FunctionalSurfaceExpression,
    span: JavaScriptAotStatement["span"],
  ): FunctionalSurfaceExpression {
    const restoredState = (stateName: string): FunctionalSurfaceExpression => {
      const heapName = this.freshName("restoredHeap");
      const discardedContextName = this.freshName("discardedContext");
      const bindingsName = this.freshName("restoredBindings");
      return match(reference(stateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, discardedContextName, bindingsName],
        body: call(Runtime.JAVASCRIPT_STATE, [
          reference(heapName, span),
          context,
          reference(bindingsName, span),
        ], span),
        span,
      }], span);
    };
    const normalStateName = this.freshName("caughtNormalState");
    const normalValueName = this.freshName("caughtNormalValue");
    const returnStateName = this.freshName("caughtReturnState");
    const returnValueName = this.freshName("caughtReturnValue");
    const throwStateName = this.freshName("caughtThrowState");
    const throwValueName = this.freshName("caughtThrowValue");
    const breakStateName = this.freshName("caughtBreakState");
    const breakTargetName = this.freshName("caughtBreakTarget");
    const continueStateName = this.freshName("caughtContinueState");
    const continueTargetName = this.freshName("caughtContinueTarget");
    return match(completion, [{
      constructor: Runtime.JAVASCRIPT_COMPLETION_NORMAL,
      binders: [normalStateName, normalValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
        restoredState(normalStateName),
        reference(normalValueName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_RETURN,
      binders: [returnStateName, returnValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_RETURN, [
        restoredState(returnStateName),
        reference(returnValueName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_THROW,
      binders: [throwStateName, throwValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_THROW, [
        restoredState(throwStateName),
        reference(throwValueName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_BREAK,
      binders: [breakStateName, breakTargetName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_BREAK, [
        restoredState(breakStateName),
        reference(breakTargetName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_CONTINUE,
      binders: [continueStateName, continueTargetName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_CONTINUE, [
        restoredState(continueStateName),
        reference(continueTargetName, span),
      ], span),
      span,
    }], span);
  }

  private resumeNormalCompletion(
    completion: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
    span: JavaScriptAotStatement["span"],
  ): FunctionalSurfaceExpression {
    const normalStateName = this.freshName("resumedCatchState");
    const normalValueName = this.freshName("resumedCatchValue");
    const returnStateName = this.freshName("resumedReturnState");
    const returnValueName = this.freshName("resumedReturnValue");
    const throwStateName = this.freshName("resumedThrowState");
    const throwValueName = this.freshName("resumedThrowValue");
    const breakStateName = this.freshName("resumedBreakState");
    const breakTargetName = this.freshName("resumedBreakTarget");
    const continueStateName = this.freshName("resumedContinueState");
    const continueTargetName = this.freshName("resumedContinueTarget");
    return match(completion, [{
      constructor: Runtime.JAVASCRIPT_COMPLETION_NORMAL,
      binders: [normalStateName, normalValueName],
      body: onNormal(reference(normalStateName, span)),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_RETURN,
      binders: [returnStateName, returnValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_RETURN, [
        reference(returnStateName, span),
        reference(returnValueName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_THROW,
      binders: [throwStateName, throwValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_THROW, [
        reference(throwStateName, span),
        reference(throwValueName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_BREAK,
      binders: [breakStateName, breakTargetName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_BREAK, [
        reference(breakStateName, span),
        reference(breakTargetName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_CONTINUE,
      binders: [continueStateName, continueTargetName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_CONTINUE, [
        reference(continueStateName, span),
        reference(continueTargetName, span),
      ], span),
      span,
    }], span);
  }

  private resumeExpressionCompletion(
    completion: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    const normalStateName = this.freshName("expressionState");
    const normalValueName = this.freshName("expressionValue");
    const returnStateName = this.freshName("expressionReturnState");
    const returnValueName = this.freshName("expressionReturnValue");
    const throwStateName = this.freshName("expressionThrowState");
    const throwValueName = this.freshName("expressionThrowValue");
    const breakStateName = this.freshName("expressionBreakState");
    const breakTargetName = this.freshName("expressionBreakTarget");
    const continueStateName = this.freshName("expressionContinueState");
    const continueTargetName = this.freshName("expressionContinueTarget");
    return match(completion, [{
      constructor: Runtime.JAVASCRIPT_COMPLETION_NORMAL,
      binders: [normalStateName, normalValueName],
      body: onValue(reference(normalStateName, span), reference(normalValueName, span)),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_RETURN,
      binders: [returnStateName, returnValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_RETURN, [
        reference(returnStateName, span),
        reference(returnValueName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_THROW,
      binders: [throwStateName, throwValueName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_THROW, [
        reference(throwStateName, span),
        reference(throwValueName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_BREAK,
      binders: [breakStateName, breakTargetName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_BREAK, [
        reference(breakStateName, span),
        reference(breakTargetName, span),
      ], span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_CONTINUE,
      binders: [continueStateName, continueTargetName],
      body: call(Runtime.JAVASCRIPT_COMPLETION_CONTINUE, [
        reference(continueStateName, span),
        reference(continueTargetName, span),
      ], span),
      span,
    }], span);
  }

  private lowerPropertyAssignment(
    statement: Extract<JavaScriptAotStatement, { readonly kind: "property-assignment" }>,
    state: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    if (statement.operator !== "=") {
      throw new JavaScriptAotLoweringError(
        statement.span,
        `JavaScript runtime-model property assignment ${
          JSON.stringify(statement.operator)
        } is not yet supported.`,
      );
    }
    const propertyName = statement.target.kind === "property"
      ? statement.target.name
      : literalPropertyName(statement.target.index);
    if (propertyName === null) {
      throw new JavaScriptAotLoweringError(
        statement.target.span,
        "JavaScript runtime-model computed assignment currently requires a string or number literal key.",
      );
    }
    return this.lowerExpression(
      statement.target.value,
      state,
      (receiverState, receiver) =>
        match(
          receiver,
          this.expectObjectArms(statement.target.span, (identity) =>
            this.lowerExpression(statement.value, receiverState, (valueState, value) => {
              const stateName = this.freshName("propertyWriteState");
              const updatedStateName = this.freshName("propertyWriteUpdatedState");
              const setterStateName = this.freshName("setterState");
              const setterName = this.freshName("setter");
              const setterReceiverName = this.freshName("setterReceiver");
              const setterValueName = this.freshName("setterValue");
              const rejectedWrite = runtimeFault(
                `JavaScript property ${JSON.stringify(propertyName)} is not writable`,
                statement.span,
              );
              const objectValue = call(Runtime.JAVASCRIPT_VALUE_OBJECT, [
                identity,
              ], statement.target.span);
              const complete = (completedState: FunctionalSurfaceExpression) =>
                call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                  completedState,
                  reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, statement.span),
                ], statement.span);
              return letExpression(
                stateName,
                valueState,
                this.resumeNormalCompletion(
                  match(
                    call(JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE, [
                      reference(stateName, statement.span),
                      call(Runtime.JAVASCRIPT_PROPERTY_REFERENCE, [
                        objectValue,
                        call(Runtime.JAVASCRIPT_PROPERTY_KEY_STRING, [
                          text(propertyName, statement.target.span),
                        ], statement.target.span),
                        objectValue,
                        boolean(true, statement.span),
                      ], statement.span),
                      value,
                    ], statement.span),
                    [{
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_UPDATED,
                      binders: [updatedStateName],
                      body: complete(reference(updatedStateName, statement.span)),
                      span: statement.span,
                    }, {
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_ACCESSOR,
                      binders: [
                        setterStateName,
                        setterName,
                        setterReceiverName,
                        setterValueName,
                      ],
                      body: this.invokeRuntimeCallable(
                        reference(setterName, statement.span),
                        reference(setterStateName, statement.span),
                        reference(setterReceiverName, statement.span),
                        [reference(setterValueName, statement.span)],
                        (completedState) =>
                          complete(completedState),
                        statement.span,
                      ),
                      span: statement.span,
                    }, {
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_UNRESOLVABLE,
                      binders: [],
                      body: runtimeFault(
                        "JavaScript property Reference was unresolvable",
                        statement.span,
                      ),
                      span: statement.span,
                    }, {
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_UNINITIALIZED,
                      binders: [],
                      body: runtimeFault(
                        "JavaScript property Reference was uninitialized",
                        statement.span,
                      ),
                      span: statement.span,
                    }, {
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_IMMUTABLE,
                      binders: [],
                      body: rejectedWrite,
                      span: statement.span,
                    }, {
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_NON_WRITABLE,
                      binders: [],
                      body: rejectedWrite,
                      span: statement.span,
                    }, {
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_MISSING_SETTER,
                      binders: [],
                      body: runtimeFault(
                        `JavaScript property ${JSON.stringify(propertyName)} has no setter`,
                        statement.span,
                      ),
                      span: statement.span,
                    }, {
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_NON_EXTENSIBLE,
                      binders: [],
                      body: runtimeFault(
                        `JavaScript property ${
                          JSON.stringify(propertyName)
                        } cannot be added to a non-extensible object`,
                        statement.span,
                      ),
                      span: statement.span,
                    }, {
                      constructor: Runtime.JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE,
                      binders: [],
                      body: runtimeFault(
                        "JavaScript property Reference has an invalid base",
                        statement.span,
                      ),
                      span: statement.span,
                    }],
                    statement.span,
                  ),
                  onNormal,
                  statement.span,
                ),
                statement.span,
              );
            })),
          statement.target.span,
        ),
    );
  }

  private lowerExpression(
    expression: JavaScriptAotExpression,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "number":
        return onValue(
          state,
          call(
            Runtime.JAVASCRIPT_VALUE_NUMBER,
            [float64(expression.value, expression.span)],
            expression.span,
          ),
        );
      case "string":
        return onValue(
          state,
          call(
            Runtime.JAVASCRIPT_VALUE_STRING,
            [text(expression.value, expression.span)],
            expression.span,
          ),
        );
      case "boolean":
        return onValue(
          state,
          call(
            Runtime.JAVASCRIPT_VALUE_BOOLEAN,
            [boolean(expression.value, expression.span)],
            expression.span,
          ),
        );
      case "null":
        return onValue(state, reference(Runtime.JAVASCRIPT_VALUE_NULL, expression.span));
      case "name":
        if (expression.name === "undefined") {
          return onValue(state, reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, expression.span));
        }
        if (expression.name === "NaN" || expression.name === "Infinity") {
          const value = expression.name === "NaN" ? Number.NaN : Number.POSITIVE_INFINITY;
          return onValue(
            state,
            call(
              Runtime.JAVASCRIPT_VALUE_NUMBER,
              [float64(value, expression.span)],
              expression.span,
            ),
          );
        }
        if (expression.name === "this") {
          const contextName = this.freshName("thisContext");
          return match(state, [{
            constructor: Runtime.JAVASCRIPT_STATE,
            binders: [this.freshName("thisHeap"), contextName, this.freshName("thisBindings")],
            body: onValue(
              state,
              call(JAVASCRIPT_RUNTIME_THIS_VALUE, [
                reference(contextName, expression.span),
              ], expression.span),
            ),
            span: expression.span,
          }], expression.span);
        }
        return this.lookupBinding(state, expression.name, onValue, expression.span);
      case "array":
        return this.lowerObject(
          {
            kind: "object",
            properties: [
              ...expression.values.map((value, index) => ({
                name: String(index),
                value,
                span: value.span,
              })),
              {
                name: "length",
                value: { kind: "number", value: expression.values.length, span: expression.span },
                span: expression.span,
              },
            ],
            span: expression.span,
          },
          state,
          onValue,
        );
      case "object":
        return this.lowerObject(expression, state, onValue);
      case "function":
        return this.lowerFunctionValue(expression, state, onValue);
      case "call":
        return this.lowerCall(expression, state, onValue);
      case "new": {
        const faultMessage = this.options.runtimeFaultConstructors?.get(expression.constructor);
        if (faultMessage !== undefined) {
          return this.lowerArguments(
            expression.arguments,
            0,
            state,
            [],
            () => runtimeFault(faultMessage, expression.span),
          );
        }
        if (JAVASCRIPT_RUNTIME_ERROR_CONSTRUCTORS.has(expression.constructor)) {
          return this.lowerArguments(
            expression.arguments,
            0,
            state,
            [],
            (argumentState) =>
              this.allocateRuntimeError(
                expression.constructor,
                argumentState,
                onValue,
                expression.span,
              ),
          );
        }
        if (expression.constructor === "Object" && expression.arguments.length === 0) {
          return this.lowerObject(
            {
              kind: "object",
              properties: [],
              span: expression.span,
            },
            state,
            onValue,
          );
        }
        return this.lookupBinding(
          state,
          expression.constructor,
          (constructorState, constructor) =>
            this.lowerArguments(
              expression.arguments,
              0,
              constructorState,
              [],
              (argumentState, arguments_) => {
                const emptyObject: Extract<JavaScriptAotExpression, { readonly kind: "object" }> = {
                  kind: "object",
                  properties: [],
                  span: expression.span,
                };
                return this.readProperty(
                  argumentState,
                  constructor,
                  "prototype",
                  (prototypeState, prototype) =>
                    this.lowerObjectWithPrototype(
                      emptyObject,
                      prototypeState,
                      match(
                        prototype,
                        primitiveOrObjectValueArms(
                          this.freshName("constructorPrototype"),
                          expression.span,
                          () => reference(Runtime.JAVASCRIPT_VALUE_NULL, expression.span),
                          (prototypeIdentity) =>
                            call(
                              Runtime.JAVASCRIPT_VALUE_OBJECT,
                              [prototypeIdentity],
                              expression.span,
                            ),
                        ),
                        expression.span,
                      ),
                      (objectState, objectValue) =>
                        this.invokeRuntimeCallable(
                          constructor,
                          objectState,
                          objectValue,
                          arguments_,
                          (returnState, returnValue) =>
                            this.withSharedExpressionContinuation(
                              onValue,
                              expression.span,
                              (resume) =>
                                match(
                                  returnValue,
                                  primitiveOrObjectValueArms(
                                    this.freshName("constructorResult"),
                                    expression.span,
                                    () => resume(returnState, objectValue),
                                    (identity) =>
                                      resume(
                                        returnState,
                                        call(
                                          Runtime.JAVASCRIPT_VALUE_OBJECT,
                                          [identity],
                                          expression.span,
                                        ),
                                      ),
                                  ),
                                  expression.span,
                                ),
                            ),
                          expression.span,
                        ),
                    ),
                  expression.span,
                );
              },
            ),
          expression.span,
        );
      }
      case "property":
        return this.lowerExpression(
          expression.value,
          state,
          (receiverState, receiver) =>
            this.readProperty(receiverState, receiver, expression.name, onValue, expression.span),
        );
      case "index": {
        const propertyName = literalPropertyName(expression.index);
        if (propertyName === null) {
          throw new JavaScriptAotLoweringError(
            expression.index.span,
            "JavaScript runtime-model computed properties currently require a string or number literal key.",
          );
        }
        return this.lowerExpression(
          expression.value,
          state,
          (receiverState, receiver) =>
            this.readProperty(
              receiverState,
              receiver,
              propertyName,
              onValue,
              expression.span,
            ),
        );
      }
      case "conditional":
        return this.lowerExpression(
          expression.condition,
          state,
          (conditionState, conditionValue) =>
            this.resumeExpressionCompletion(
              conditional(
                call(JAVASCRIPT_RUNTIME_TO_BOOLEAN, [conditionValue], expression.condition.span),
                this.lowerExpression(
                  expression.consequent,
                  conditionState,
                  (branchState, branchValue) =>
                    call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                      branchState,
                      branchValue,
                    ], expression.consequent.span),
                ),
                this.lowerExpression(
                  expression.alternate,
                  conditionState,
                  (branchState, branchValue) =>
                    call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                      branchState,
                      branchValue,
                    ], expression.alternate.span),
                ),
                expression.span,
              ),
              onValue,
              expression.span,
            ),
        );
      case "unary":
        return this.lowerUnary(expression, state, onValue);
      case "binary":
        return this.lowerBinary(expression, state, onValue);
    }
  }

  private allocateRuntimeError(
    name: string,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    const stateName = this.freshName("errorState");
    const heapName = this.freshName("errorHeap");
    const contextName = this.freshName("errorContext");
    const bindingsName = this.freshName("errorBindings");
    const allocatedHeapName = this.freshName("allocatedErrorHeap");
    const allocatedValueName = this.freshName("allocatedErrorValue");
    return letExpression(
      stateName,
      state,
      match(reference(stateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, contextName, bindingsName],
        body: match(
          call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
            reference(heapName, span),
            reference(Runtime.JAVASCRIPT_VALUE_NULL, span),
            call(Runtime.JAVASCRIPT_OBJECT_ERROR, [text(name, span)], span),
          ], span),
          [{
            constructor: Runtime.JAVASCRIPT_HEAP_ALLOCATION,
            binders: [allocatedHeapName, allocatedValueName],
            body: onValue(
              call(Runtime.JAVASCRIPT_STATE, [
                reference(allocatedHeapName, span),
                reference(contextName, span),
                reference(bindingsName, span),
              ], span),
              reference(allocatedValueName, span),
            ),
            span,
          }],
          span,
        ),
        span,
      }], span),
      span,
    );
  }

  private lowerFunctionValue(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "function" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    const runtimeFunction = this.preparedRuntimeFunction(expression);
    if (expression.name !== null) {
      return this.allocateNamedRuntimeFunction(expression.name, runtimeFunction, state, onValue);
    }
    return this.allocateRuntimeFunction(runtimeFunction, state, onValue);
  }

  private allocateNamedRuntimeFunction(
    name: string,
    runtimeFunction: RuntimeFunction,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    const span = runtimeFunction.span;
    const stateName = this.freshName("namedFunctionState");
    const heapName = this.freshName("namedFunctionHeap");
    const outerContextName = this.freshName("namedFunctionOuterContext");
    const bindingsName = this.freshName("namedFunctionBindings");
    return letExpression(
      stateName,
      state,
      match(reference(stateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, outerContextName, bindingsName],
        body: this.allocateRuntimeFunction(
          runtimeFunction,
          call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
            reference(stateName, span),
            text(name, span),
            call(Runtime.JAVASCRIPT_BINDING_UNINITIALIZED, [boolean(false, span)], span),
          ], span),
          (allocatedState, value) =>
            this.initializeBinding(
              allocatedState,
              name,
              value,
              (initializedState) => {
                const initializedStateName = this.freshName("initializedNamedFunctionState");
                const initializedHeapName = this.freshName("initializedNamedFunctionHeap");
                const innerContextName = this.freshName("namedFunctionInnerContext");
                const initializedBindingsName = this.freshName(
                  "initializedNamedFunctionBindings",
                );
                return letExpression(
                  initializedStateName,
                  initializedState,
                  match(reference(initializedStateName, span), [{
                    constructor: Runtime.JAVASCRIPT_STATE,
                    binders: [
                      initializedHeapName,
                      innerContextName,
                      initializedBindingsName,
                    ],
                    body: onValue(
                      call(Runtime.JAVASCRIPT_STATE, [
                        reference(initializedHeapName, span),
                        reference(outerContextName, span),
                        reference(initializedBindingsName, span),
                      ], span),
                      value,
                    ),
                    span,
                  }], span),
                  span,
                );
              },
              span,
            ),
        ),
        span,
      }], span),
      span,
    );
  }

  private registerRuntimeFunction(
    syntax: RuntimeFunctionSyntax,
    parameters: readonly string[],
    body: readonly JavaScriptAotStatement[],
    span: JavaScriptAotExpression["span"],
    thisMode: "dynamic" | "lexical",
    strict: boolean,
  ): RuntimeFunction {
    const registered = this.#functionsBySyntax.get(syntax);
    if (registered !== undefined) return registered;
    const parameterNames = new Set<string>();
    for (const parameter of parameters) {
      if (parameterNames.has(parameter)) {
        throw new JavaScriptAotLoweringError(
          span,
          `JavaScript runtime function declares parameter ${
            JSON.stringify(parameter)
          } more than once.`,
        );
      }
      parameterNames.add(parameter);
    }
    const runtimeFunction: RuntimeFunction = {
      id: this.#functions.length,
      name: `$javascript#runtimeFunction#${this.#functions.length}`,
      thisMode,
      strict,
      usesArguments: runtimeStatementsReferenceName(body, "arguments"),
      parameters,
      functionLength: syntax.parameterLength ?? parameters.length,
      classMethods: syntax.kind === "function-declaration" ? syntax.classMethods ?? null : null,
      body: strict ? body : rewriteMappedArguments(body, parameters),
      span,
    };
    this.#functions.push(runtimeFunction);
    this.#functionsBySyntax.set(syntax, runtimeFunction);
    return runtimeFunction;
  }

  private preparedRuntimeFunction(syntax: RuntimeFunctionSyntax): RuntimeFunction {
    const runtimeFunction = this.#functionsBySyntax.get(syntax);
    if (runtimeFunction !== undefined) return runtimeFunction;
    throw new Error(
      `JavaScript runtime function at bytes ${syntax.span.startByte}-${syntax.span.endByte} was not prepared.`,
    );
  }

  private prepareRuntimeProgram(statements: readonly JavaScriptAotStatement[]): void {
    const visitExpression = (expression: JavaScriptAotExpression, strict: boolean): void => {
      switch (expression.kind) {
        case "array":
          for (const value of expression.values) visitExpression(value, strict);
          return;
        case "object":
          for (const property of expression.properties) visitExpression(property.value, strict);
          return;
        case "function": {
          const functionStrict = strict || statementsUseStrictMode(expression.body);
          this.registerRuntimeFunction(
            expression,
            expression.parameters,
            expression.body,
            expression.span,
            expression.thisMode,
            functionStrict,
          );
          visitStatements(expression.body, functionStrict);
          return;
        }
        case "unary":
        case "property":
          visitExpression(expression.value, strict);
          return;
        case "binary":
          visitExpression(expression.left, strict);
          visitExpression(expression.right, strict);
          return;
        case "conditional":
          visitExpression(expression.condition, strict);
          visitExpression(expression.consequent, strict);
          visitExpression(expression.alternate, strict);
          return;
        case "call":
          visitExpression(expression.callee, strict);
          for (const argument of expression.arguments) visitExpression(argument, strict);
          return;
        case "new":
          for (const argument of expression.arguments) visitExpression(argument, strict);
          return;
        case "index":
          visitExpression(expression.value, strict);
          visitExpression(expression.index, strict);
          return;
        default:
          return;
      }
    };
    const visitStatements = (
      nested: readonly JavaScriptAotStatement[],
      strict: boolean,
    ): void => {
      for (const statement of nested) {
        switch (statement.kind) {
          case "function-declaration": {
            const functionStrict = statement.classMethods !== undefined || strict ||
              statementsUseStrictMode(statement.body);
            this.registerRuntimeFunction(
              statement,
              statement.parameters,
              statement.body,
              statement.span,
              "dynamic",
              functionStrict,
            );
            visitStatements(statement.body, functionStrict);
            for (const method of statement.classMethods ?? []) {
              visitExpression(method.value, true);
            }
            break;
          }
          case "constant":
          case "mutable":
          case "assignment":
          case "return":
          case "throw":
          case "expression":
            visitExpression(statement.value, strict);
            break;
          case "property-assignment":
            visitExpression(statement.target, strict);
            visitExpression(statement.value, strict);
            break;
          case "var":
            for (const declaration of statement.declarations) {
              if (declaration.value !== null) visitExpression(declaration.value, strict);
            }
            break;
          case "if":
            visitExpression(statement.condition, strict);
            visitStatements(statement.consequent, strict);
            if (statement.alternate !== null) visitStatements(statement.alternate, strict);
            break;
          case "while":
            visitExpression(statement.condition, strict);
            visitStatements(statement.body, strict);
            visitStatements(statement.continueBody, strict);
            break;
          case "block":
            visitStatements(statement.statements, strict);
            break;
          case "try":
            if (statement.finallyBody !== null) {
              throw new JavaScriptAotLoweringError(
                statement.span,
                "JavaScript runtime-model finally completion replacement is not yet supported.",
              );
            }
            if (statement.catchBody === null) {
              throw new JavaScriptAotLoweringError(
                statement.span,
                "JavaScript runtime-model try requires a catch clause.",
              );
            }
            visitStatements(statement.body, strict);
            visitStatements(statement.catchBody, strict);
            break;
          case "break":
          case "continue":
            break;
        }
      }
    };
    visitStatements(statements, (this.options.callThisMode ?? "strict") === "strict");
  }

  private allocateRuntimeFunction(
    runtimeFunction: RuntimeFunction,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    const span = runtimeFunction.span;
    const stateName = this.freshName("functionValueState");
    const heapName = this.freshName("functionValueHeap");
    const contextName = this.freshName("functionValueContext");
    const bindingsName = this.freshName("functionValueBindings");
    const allocatedHeapName = this.freshName("functionObjectHeap");
    const allocatedValueName = this.freshName("functionObjectValue");
    return letExpression(
      stateName,
      state,
      match(reference(stateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, contextName, bindingsName],
        body: match(
          call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
            reference(heapName, span),
            reference(Runtime.JAVASCRIPT_VALUE_NULL, span),
            call(Runtime.JAVASCRIPT_OBJECT_CALLABLE, [
              integer(runtimeFunction.id, span),
              call(JAVASCRIPT_RUNTIME_REALM, [reference(contextName, span)], span),
              call(JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT, [
                reference(contextName, span),
              ], span),
              runtimeFunction.thisMode === "lexical"
                ? call(Runtime.JAVASCRIPT_THIS_LEXICAL, [
                  call(JAVASCRIPT_RUNTIME_THIS_VALUE, [
                    reference(contextName, span),
                  ], span),
                ], span)
                : reference(Runtime.JAVASCRIPT_THIS_DYNAMIC, span),
            ], span),
          ], span),
          [{
            constructor: Runtime.JAVASCRIPT_HEAP_ALLOCATION,
            binders: [allocatedHeapName, allocatedValueName],
            body: match(
              reference(allocatedValueName, span),
              this.expectObjectArms(span, (functionIdentity) => {
                const functionHeap = this.#usesFunctionLength
                  ? call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
                    reference(allocatedHeapName, span),
                    functionIdentity,
                    call(Runtime.JAVASCRIPT_PROPERTY_KEY_STRING, [text("length", span)], span),
                    call(Runtime.JAVASCRIPT_DATA_DESCRIPTOR, [
                      call(Runtime.JAVASCRIPT_VALUE_NUMBER, [
                        float64(runtimeFunction.functionLength, span),
                      ], span),
                      boolean(false, span),
                      boolean(false, span),
                      boolean(true, span),
                    ], span),
                  ], span)
                  : reference(allocatedHeapName, span);
                const functionState = call(Runtime.JAVASCRIPT_STATE, [
                  functionHeap,
                  reference(contextName, span),
                  reference(bindingsName, span),
                ], span);
                if (runtimeFunction.classMethods === null) {
                  return onValue(functionState, reference(allocatedValueName, span));
                }
                return this.allocateClassPrototype(
                  runtimeFunction.classMethods,
                  functionState,
                  reference(allocatedValueName, span),
                  functionIdentity,
                  onValue,
                  span,
                );
              }),
              span,
            ),
            span,
          }],
          span,
        ),
        span,
      }], span),
      span,
    );
  }

  private allocateClassPrototype(
    methods: readonly JavaScriptAotClassMethod[],
    state: FunctionalSurfaceExpression,
    constructorValue: FunctionalSurfaceExpression,
    constructorIdentity: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    const stateName = this.freshName("classState");
    const heapName = this.freshName("classHeap");
    const contextName = this.freshName("classContext");
    const bindingsName = this.freshName("classBindings");
    const prototypeHeapName = this.freshName("classPrototypeHeap");
    const prototypeValueName = this.freshName("classPrototypeValue");
    return letExpression(
      stateName,
      state,
      match(reference(stateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, contextName, bindingsName],
        body: match(
          call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
            reference(heapName, span),
            reference(Runtime.JAVASCRIPT_VALUE_NULL, span),
            reference(Runtime.JAVASCRIPT_OBJECT_ORDINARY, span),
          ], span),
          [{
            constructor: Runtime.JAVASCRIPT_HEAP_ALLOCATION,
            binders: [prototypeHeapName, prototypeValueName],
            body: match(
              reference(prototypeValueName, span),
              this.expectObjectArms(span, (prototypeIdentity) => {
                const heapWithConstructor = call(
                  JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED,
                  [
                    reference(prototypeHeapName, span),
                    prototypeIdentity,
                    call(
                      Runtime.JAVASCRIPT_PROPERTY_KEY_STRING,
                      [text("constructor", span)],
                      span,
                    ),
                    call(Runtime.JAVASCRIPT_DATA_DESCRIPTOR, [
                      constructorValue,
                      boolean(true, span),
                      boolean(false, span),
                      boolean(true, span),
                    ], span),
                  ],
                  span,
                );
                const heapWithPrototype = call(
                  JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED,
                  [
                    heapWithConstructor,
                    constructorIdentity,
                    call(
                      Runtime.JAVASCRIPT_PROPERTY_KEY_STRING,
                      [text("prototype", span)],
                      span,
                    ),
                    call(Runtime.JAVASCRIPT_DATA_DESCRIPTOR, [
                      reference(prototypeValueName, span),
                      boolean(false, span),
                      boolean(false, span),
                      boolean(false, span),
                    ], span),
                  ],
                  span,
                );
                return this.defineClassMethods(
                  methods,
                  0,
                  call(Runtime.JAVASCRIPT_STATE, [
                    heapWithPrototype,
                    reference(contextName, span),
                    reference(bindingsName, span),
                  ], span),
                  prototypeIdentity,
                  (completedState) => onValue(completedState, constructorValue),
                );
              }),
              span,
            ),
            span,
          }],
          span,
        ),
        span,
      }], span),
      span,
    );
  }

  private defineClassMethods(
    methods: readonly JavaScriptAotClassMethod[],
    index: number,
    state: FunctionalSurfaceExpression,
    prototypeIdentity: FunctionalSurfaceExpression,
    onReady: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    const method = methods[index];
    if (method === undefined) return onReady(state);
    return this.lowerExpression(method.value, state, (methodState, methodValue) => {
      const stateName = this.freshName("classMethodState");
      const heapName = this.freshName("classMethodHeap");
      const contextName = this.freshName("classMethodContext");
      const bindingsName = this.freshName("classMethodBindings");
      return letExpression(
        stateName,
        methodState,
        match(reference(stateName, method.span), [{
          constructor: Runtime.JAVASCRIPT_STATE,
          binders: [heapName, contextName, bindingsName],
          body: this.defineClassMethods(
            methods,
            index + 1,
            call(Runtime.JAVASCRIPT_STATE, [
              call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
                reference(heapName, method.span),
                prototypeIdentity,
                call(
                  Runtime.JAVASCRIPT_PROPERTY_KEY_STRING,
                  [text(method.name, method.span)],
                  method.span,
                ),
                call(Runtime.JAVASCRIPT_DATA_DESCRIPTOR, [
                  methodValue,
                  boolean(true, method.span),
                  boolean(false, method.span),
                  boolean(true, method.span),
                ], method.span),
              ], method.span),
              reference(contextName, method.span),
              reference(bindingsName, method.span),
            ], method.span),
            prototypeIdentity,
            onReady,
          ),
          span: method.span,
        }], method.span),
        method.span,
      );
    });
  }

  private lowerCall(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    if (isRuntimeDefinePropertyCall(expression)) {
      return this.lowerDefinePropertyCall(expression, state, onValue);
    }
    if (
      expression.callee.kind === "property" &&
      expression.callee.name === "hasOwnProperty"
    ) {
      if (expression.arguments.length !== 1) {
        throw new JavaScriptAotLoweringError(
          expression.span,
          `JavaScript Object.prototype.hasOwnProperty expects 1 argument but this call supplies ${expression.arguments.length}.`,
        );
      }
      const receiverExpression = expression.callee.value;
      return this.lowerExpression(
        receiverExpression,
        state,
        (receiverState, receiver) =>
          this.lowerArguments(
            expression.arguments,
            0,
            receiverState,
            [],
            (argumentState, arguments_) =>
              match(
                receiver,
                this.expectObjectArms(receiverExpression.span, (identity) => {
                  const stateName = this.freshName("hasOwnPropertyState");
                  const heapName = this.freshName("hasOwnPropertyHeap");
                  const contextName = this.freshName("hasOwnPropertyContext");
                  const bindingsName = this.freshName("hasOwnPropertyBindings");
                  const nextIdentityName = this.freshName("hasOwnPropertyNextIdentity");
                  const objectsName = this.freshName("hasOwnPropertyObjects");
                  const propertyName = this.freshName("hasOwnPropertyName");
                  const descriptorName = this.freshName("hasOwnPropertyDescriptor");
                  return letExpression(
                    stateName,
                    argumentState,
                    match(reference(stateName, expression.span), [{
                      constructor: Runtime.JAVASCRIPT_STATE,
                      binders: [heapName, contextName, bindingsName],
                      body: match(reference(heapName, expression.span), [{
                        constructor: Runtime.JAVASCRIPT_HEAP,
                        binders: [nextIdentityName, objectsName],
                        body: match(
                          arguments_[0]!,
                          valueCaseArms(
                            Runtime.JAVASCRIPT_VALUE_STRING,
                            propertyName,
                            expression.span,
                            (name) =>
                              match(
                                call(JAVASCRIPT_RUNTIME_LOOKUP_OWN_PROPERTY, [
                                  reference(objectsName, expression.span),
                                  identity,
                                  call(
                                    Runtime.JAVASCRIPT_PROPERTY_KEY_STRING,
                                    [name],
                                    expression.span,
                                  ),
                                ], expression.span),
                                [{
                                  constructor: Runtime.JAVASCRIPT_DESCRIPTOR_MISSING,
                                  binders: [],
                                  body: onValue(
                                    reference(stateName, expression.span),
                                    call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
                                      boolean(false, expression.span),
                                    ], expression.span),
                                  ),
                                  span: expression.span,
                                }, {
                                  constructor: Runtime.JAVASCRIPT_DESCRIPTOR_FOUND,
                                  binders: [descriptorName],
                                  body: onValue(
                                    reference(stateName, expression.span),
                                    call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
                                      boolean(true, expression.span),
                                    ], expression.span),
                                  ),
                                  span: expression.span,
                                }],
                                expression.span,
                              ),
                            "TypeError: JavaScript Object.prototype.hasOwnProperty currently requires a string key",
                          ),
                          expression.span,
                        ),
                        span: expression.span,
                      }], expression.span),
                      span: expression.span,
                    }], expression.span),
                    expression.span,
                  );
                }),
                expression.span,
              ),
          ),
      );
    }
    if (expression.callee.kind === "property" && expression.callee.name === "bind") {
      if (expression.arguments.length > 1) {
        throw new JavaScriptAotLoweringError(
          expression.span,
          "JavaScript runtime-model Function.prototype.bind does not yet support bound arguments.",
        );
      }
      return this.lowerExpression(
        expression.callee.value,
        state,
        (calleeState, callee) =>
          this.lowerArguments(
            expression.arguments,
            0,
            calleeState,
            [],
            (argumentState, arguments_) =>
              match(
                callee,
                this.expectObjectArms(expression.span, (identity) => {
                  const stateName = this.freshName("bindState");
                  const heapName = this.freshName("bindHeap");
                  const contextName = this.freshName("bindContext");
                  const bindingsName = this.freshName("bindBindings");
                  const nextIdentityName = this.freshName("bindNextIdentity");
                  const objectsName = this.freshName("bindObjects");
                  const targetName = this.freshName("boundTarget");
                  const realmName = this.freshName("boundRealm");
                  const environmentName = this.freshName("boundEnvironment");
                  const thisBindingName = this.freshName("boundThisBinding");
                  const lexicalThisName = this.freshName("existingLexicalThis");
                  const allocatedHeapName = this.freshName("boundCallableHeap");
                  const allocatedValueName = this.freshName("boundCallableValue");
                  const boundThis = arguments_[0] ??
                    reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, expression.span);
                  return letExpression(
                    stateName,
                    argumentState,
                    match(reference(stateName, expression.span), [{
                      constructor: Runtime.JAVASCRIPT_STATE,
                      binders: [heapName, contextName, bindingsName],
                      body: match(reference(heapName, expression.span), [{
                        constructor: Runtime.JAVASCRIPT_HEAP,
                        binders: [nextIdentityName, objectsName],
                        body: match(
                          call(JAVASCRIPT_RUNTIME_OBJECT_KIND, [
                            reference(objectsName, expression.span),
                            identity,
                          ], expression.span),
                          [{
                            constructor: Runtime.JAVASCRIPT_OBJECT_ORDINARY,
                            binders: [],
                            body: runtimeFault(
                              "JavaScript Function.prototype.bind receiver is not callable",
                              expression.span,
                            ),
                            span: expression.span,
                          }, {
                            constructor: Runtime.JAVASCRIPT_OBJECT_CALLABLE,
                            binders: [
                              targetName,
                              realmName,
                              environmentName,
                              thisBindingName,
                            ],
                            body: match(
                              call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
                                reference(heapName, expression.span),
                                reference(Runtime.JAVASCRIPT_VALUE_NULL, expression.span),
                                call(Runtime.JAVASCRIPT_OBJECT_CALLABLE, [
                                  reference(targetName, expression.span),
                                  reference(realmName, expression.span),
                                  reference(environmentName, expression.span),
                                  match(reference(thisBindingName, expression.span), [{
                                    constructor: Runtime.JAVASCRIPT_THIS_DYNAMIC,
                                    binders: [],
                                    body: call(
                                      Runtime.JAVASCRIPT_THIS_LEXICAL,
                                      [boundThis],
                                      expression.span,
                                    ),
                                    span: expression.span,
                                  }, {
                                    constructor: Runtime.JAVASCRIPT_THIS_LEXICAL,
                                    binders: [lexicalThisName],
                                    body: call(Runtime.JAVASCRIPT_THIS_LEXICAL, [
                                      reference(lexicalThisName, expression.span),
                                    ], expression.span),
                                    span: expression.span,
                                  }], expression.span),
                                ], expression.span),
                              ], expression.span),
                              [{
                                constructor: Runtime.JAVASCRIPT_HEAP_ALLOCATION,
                                binders: [allocatedHeapName, allocatedValueName],
                                body: onValue(
                                  call(Runtime.JAVASCRIPT_STATE, [
                                    reference(allocatedHeapName, expression.span),
                                    reference(contextName, expression.span),
                                    reference(bindingsName, expression.span),
                                  ], expression.span),
                                  reference(allocatedValueName, expression.span),
                                ),
                                span: expression.span,
                              }],
                              expression.span,
                            ),
                            span: expression.span,
                          }, {
                            constructor: Runtime.JAVASCRIPT_OBJECT_ERROR,
                            binders: [this.freshName("bindErrorName")],
                            body: runtimeFault(
                              "TypeError: JavaScript Function.prototype.bind receiver is not callable",
                              expression.span,
                            ),
                            span: expression.span,
                          }],
                          expression.span,
                        ),
                        span: expression.span,
                      }], expression.span),
                      span: expression.span,
                    }], expression.span),
                    expression.span,
                  );
                }),
                expression.span,
              ),
          ),
      );
    }
    if (
      expression.callee.kind === "property" &&
      (expression.callee.name === "call" || expression.callee.name === "apply")
    ) {
      const method = expression.callee.name;
      if (
        method === "apply" && expression.arguments.length >= 2 &&
        expression.arguments[1]!.kind !== "null" &&
        !(expression.arguments[1]!.kind === "name" &&
          expression.arguments[1]!.name === "undefined")
      ) {
        throw new JavaScriptAotLoweringError(
          expression.arguments[1]!.span,
          "JavaScript runtime-model Function.prototype.apply currently requires a nullish argument list.",
        );
      }
      return this.lowerExpression(
        expression.callee.value,
        state,
        (calleeState, callee) =>
          this.lowerArguments(
            expression.arguments,
            0,
            calleeState,
            [],
            (argumentState, arguments_) =>
              this.invokeRuntimeCallable(
                callee,
                argumentState,
                arguments_[0] ?? reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, expression.span),
                method === "call" ? arguments_.slice(1) : [],
                onValue,
                expression.span,
              ),
          ),
      );
    }
    if (
      expression.callee.kind === "property" && expression.callee.name === "replace" &&
      expression.callee.value.kind === "string"
    ) {
      if (expression.arguments.length !== 2 || expression.arguments[0]!.kind !== "string") {
        throw new JavaScriptAotLoweringError(
          expression.span,
          "JavaScript runtime-model String.prototype.replace currently requires one literal search string and one replacement.",
        );
      }
      const source = expression.callee.value.value;
      const search = expression.arguments[0]!.value;
      const matchIndex = source.indexOf(search);
      return this.lowerExpression(
        expression.callee.value,
        state,
        (receiverState, receiver) =>
          this.lowerArguments(
            expression.arguments,
            0,
            receiverState,
            [],
            (argumentState, arguments_) => {
              if (matchIndex < 0) return onValue(argumentState, receiver);
              const replacement = arguments_[1]!;
              const prefix = source.slice(0, matchIndex);
              const suffix = source.slice(matchIndex + search.length);
              const replacedValue = (
                nextState: FunctionalSurfaceExpression,
                replacementText: FunctionalSurfaceExpression,
              ) =>
                onValue(
                  nextState,
                  call(Runtime.JAVASCRIPT_VALUE_STRING, [{
                    kind: "text-append",
                    left: text(prefix, expression.span),
                    right: {
                      kind: "text-append",
                      left: replacementText,
                      right: text(suffix, expression.span),
                      span: expression.span,
                    },
                    span: expression.span,
                  }], expression.span),
                );
              const replacementTextName = this.freshName("replacementText");
              const replacementIdentityName = this.freshName("replacementFunction");
              const invalidReplacement = runtimeFault(
                "JavaScript String.prototype.replace replacement is neither callable nor a string",
                expression.arguments[1]!.span,
              );
              return match(replacement, [{
                constructor: Runtime.JAVASCRIPT_VALUE_STRING,
                binders: [replacementTextName],
                body: replacedValue(
                  argumentState,
                  reference(replacementTextName, expression.span),
                ),
                span: expression.span,
              }, {
                constructor: Runtime.JAVASCRIPT_VALUE_OBJECT,
                binders: [replacementIdentityName],
                body: this.invokeRuntimeCallable(
                  call(Runtime.JAVASCRIPT_VALUE_OBJECT, [
                    reference(replacementIdentityName, expression.span),
                  ], expression.span),
                  argumentState,
                  reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, expression.span),
                  [
                    call(
                      Runtime.JAVASCRIPT_VALUE_STRING,
                      [text(search, expression.span)],
                      expression.span,
                    ),
                    call(Runtime.JAVASCRIPT_VALUE_NUMBER, [
                      float64(matchIndex, expression.span),
                    ], expression.span),
                    call(
                      Runtime.JAVASCRIPT_VALUE_STRING,
                      [text(source, expression.span)],
                      expression.span,
                    ),
                  ],
                  (callbackState, callbackValue) => {
                    const callbackTextName = this.freshName("replacementCallbackText");
                    return match(
                      callbackValue,
                      valueCaseArms(
                        Runtime.JAVASCRIPT_VALUE_STRING,
                        callbackTextName,
                        expression.span,
                        (callbackText) => replacedValue(callbackState, callbackText),
                        "JavaScript String.prototype.replace callback returned a non-string value",
                      ),
                      expression.span,
                    );
                  },
                  expression.span,
                ),
                span: expression.span,
              }, {
                constructor: Runtime.JAVASCRIPT_VALUE_UNDEFINED,
                binders: [],
                body: invalidReplacement,
                span: expression.span,
              }, {
                constructor: Runtime.JAVASCRIPT_VALUE_NULL,
                binders: [],
                body: invalidReplacement,
                span: expression.span,
              }, {
                constructor: Runtime.JAVASCRIPT_VALUE_BOOLEAN,
                binders: [this.freshName("replacementBoolean")],
                body: invalidReplacement,
                span: expression.span,
              }, {
                constructor: Runtime.JAVASCRIPT_VALUE_NUMBER,
                binders: [this.freshName("replacementNumber")],
                body: invalidReplacement,
                span: expression.span,
              }, {
                constructor: Runtime.JAVASCRIPT_VALUE_SYMBOL,
                binders: [this.freshName("replacementSymbol")],
                body: invalidReplacement,
                span: expression.span,
              }], expression.span);
            },
          ),
      );
    }
    if (expression.callee.kind === "property") {
      const callee = expression.callee;
      return this.lowerExpression(
        callee.value,
        state,
        (receiverState, receiver) =>
          this.readProperty(
            receiverState,
            receiver,
            callee.name,
            (calleeState, callee) =>
              this.lowerCallArguments(
                expression,
                calleeState,
                callee,
                receiver,
                onValue,
              ),
            callee.span,
          ),
      );
    }
    if (expression.callee.kind === "index") {
      const callee = expression.callee;
      const propertyName = literalPropertyName(callee.index);
      if (propertyName === null) {
        throw new JavaScriptAotLoweringError(
          callee.index.span,
          "JavaScript runtime-model computed method calls currently require a string or number literal key.",
        );
      }
      return this.lowerExpression(
        callee.value,
        state,
        (receiverState, receiver) =>
          this.readProperty(
            receiverState,
            receiver,
            propertyName,
            (calleeState, callee) =>
              this.lowerCallArguments(
                expression,
                calleeState,
                callee,
                receiver,
                onValue,
              ),
            callee.span,
          ),
      );
    }
    return this.lowerExpression(
      expression.callee,
      state,
      (calleeState, callee) =>
        this.lowerCallArguments(
          expression,
          calleeState,
          callee,
          reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, expression.span),
          onValue,
        ),
    );
  }

  private lowerCallArguments(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
    state: FunctionalSurfaceExpression,
    callee: FunctionalSurfaceExpression,
    thisValue: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    return this.lowerArguments(
      expression.arguments,
      0,
      state,
      [],
      (argumentState, arguments_) =>
        this.invokeRuntimeCallable(
          callee,
          argumentState,
          thisValue,
          arguments_,
          onValue,
          expression.span,
        ),
    );
  }

  private lowerDefinePropertyCall(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    if (expression.arguments.length !== 3) {
      throw new JavaScriptAotLoweringError(
        expression.span,
        `JavaScript Object.defineProperty expects 3 arguments; received ${expression.arguments.length}.`,
      );
    }
    const target = expression.arguments[0]!;
    const key = expression.arguments[1]!;
    const descriptor = expression.arguments[2]!;
    if (key.kind !== "string") {
      throw new JavaScriptAotLoweringError(
        key.span,
        "JavaScript runtime-model Object.defineProperty currently requires a string literal key.",
      );
    }
    if (descriptor.kind !== "object") {
      throw new JavaScriptAotLoweringError(
        descriptor.span,
        "JavaScript runtime-model Object.defineProperty currently requires an object-literal descriptor.",
      );
    }
    const initialDescriptor: RuntimeAccessorDescriptor = {
      getter: reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, descriptor.span),
      setter: reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, descriptor.span),
      enumerable: false,
      configurable: false,
    };
    return this.lowerExpression(target, state, (targetState, targetValue) =>
      match(
        targetValue,
        this.expectObjectArms(target.span, (targetIdentity) =>
          this.lowerAccessorDescriptor(
            descriptor.properties,
            0,
            targetState,
            initialDescriptor,
            (descriptorState, resolvedDescriptor) => {
              const stateName = this.freshName("definePropertyState");
              const heapName = this.freshName("definePropertyHeap");
              const contextName = this.freshName("definePropertyContext");
              const bindingsName = this.freshName("definePropertyBindings");
              return letExpression(
                stateName,
                descriptorState,
                match(reference(stateName, expression.span), [{
                  constructor: Runtime.JAVASCRIPT_STATE,
                  binders: [heapName, contextName, bindingsName],
                  body: onValue(
                    call(Runtime.JAVASCRIPT_STATE, [
                      call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
                        reference(heapName, expression.span),
                        targetIdentity,
                        call(Runtime.JAVASCRIPT_PROPERTY_KEY_STRING, [
                          text(key.value, key.span),
                        ], key.span),
                        call(Runtime.JAVASCRIPT_ACCESSOR_DESCRIPTOR, [
                          resolvedDescriptor.getter,
                          resolvedDescriptor.setter,
                          boolean(resolvedDescriptor.enumerable, descriptor.span),
                          boolean(resolvedDescriptor.configurable, descriptor.span),
                        ], descriptor.span),
                      ], expression.span),
                      reference(contextName, expression.span),
                      reference(bindingsName, expression.span),
                    ], expression.span),
                    targetValue,
                  ),
                  span: expression.span,
                }], expression.span),
                expression.span,
              );
            },
          )),
        target.span,
      ));
  }

  private lowerAccessorDescriptor(
    properties: Extract<JavaScriptAotExpression, { readonly kind: "object" }>["properties"],
    index: number,
    state: FunctionalSurfaceExpression,
    descriptor: RuntimeAccessorDescriptor,
    onDescriptor: (
      state: FunctionalSurfaceExpression,
      descriptor: RuntimeAccessorDescriptor,
    ) => FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const property = properties[index];
    if (property === undefined) return onDescriptor(state, descriptor);
    if (property.name === "get" || property.name === "set") {
      return this.lowerExpression(
        property.value,
        state,
        (nextState, value) => {
          const nextDescriptor = property.name === "get"
            ? { ...descriptor, getter: value }
            : { ...descriptor, setter: value };
          const continuationName = this.freshName("accessorContinuation");
          const continuationStateName = this.freshName("accessorContinuationState");
          const invalidAccessor = runtimeFault(
            `JavaScript accessor descriptor ${
              JSON.stringify(property.name)
            } must be callable or undefined`,
            property.value.span,
          );
          return {
            kind: "let-rec-group",
            bindings: [{
              name: continuationName,
              parameters: [continuationStateName],
              body: this.lowerAccessorDescriptor(
                properties,
                index + 1,
                reference(continuationStateName, property.value.span),
                nextDescriptor,
                onDescriptor,
              ),
              span: property.value.span,
            }],
            body: match(value, [{
              constructor: Runtime.JAVASCRIPT_VALUE_UNDEFINED,
              binders: [],
              body: call(continuationName, [nextState], property.value.span),
              span: property.value.span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_OBJECT,
              binders: [this.freshName("accessorIdentity")],
              body: call(continuationName, [nextState], property.value.span),
              span: property.value.span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_NULL,
              binders: [],
              body: invalidAccessor,
              span: property.value.span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_BOOLEAN,
              binders: [this.freshName("accessorBoolean")],
              body: invalidAccessor,
              span: property.value.span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_NUMBER,
              binders: [this.freshName("accessorNumber")],
              body: invalidAccessor,
              span: property.value.span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_STRING,
              binders: [this.freshName("accessorString")],
              body: invalidAccessor,
              span: property.value.span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_SYMBOL,
              binders: [this.freshName("accessorSymbol")],
              body: invalidAccessor,
              span: property.value.span,
            }], property.value.span),
            span: property.value.span,
          };
        },
      );
    }
    if (property.name === "enumerable" || property.name === "configurable") {
      if (property.value.kind !== "boolean") {
        throw new JavaScriptAotLoweringError(
          property.value.span,
          `JavaScript accessor descriptor ${
            JSON.stringify(property.name)
          } must be a Boolean literal in this AOT profile.`,
        );
      }
      return this.lowerAccessorDescriptor(
        properties,
        index + 1,
        state,
        property.name === "enumerable"
          ? { ...descriptor, enumerable: property.value.value }
          : { ...descriptor, configurable: property.value.value },
        onDescriptor,
      );
    }
    throw new JavaScriptAotLoweringError(
      property.span,
      `JavaScript accessor descriptor property ${JSON.stringify(property.name)} is not supported.`,
    );
  }

  private invokeRuntimeCallable(
    callee: FunctionalSurfaceExpression,
    state: FunctionalSurfaceExpression,
    thisValue: FunctionalSurfaceExpression,
    arguments_: readonly FunctionalSurfaceExpression[],
    onValue: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    return match(
      callee,
      this.expectObjectArms(span, (identity) => {
        const stateName = this.freshName("callState");
        const heapName = this.freshName("callHeap");
        const callerContextName = this.freshName("callerContext");
        const bindingsName = this.freshName("callBindings");
        const nextIdentityName = this.freshName("callNextIdentity");
        const objectsName = this.freshName("callObjects");
        const targetName = this.freshName("callTarget");
        const capturedRealmName = this.freshName("functionRealm");
        const capturedEnvironmentName = this.freshName("functionEnvironment");
        const thisBindingName = this.freshName("functionThisBinding");
        const lexicalThisName = this.freshName("lexicalThis");
        return letExpression(
          stateName,
          state,
          match(reference(stateName, span), [{
            constructor: Runtime.JAVASCRIPT_STATE,
            binders: [heapName, callerContextName, bindingsName],
            body: match(reference(heapName, span), [{
              constructor: Runtime.JAVASCRIPT_HEAP,
              binders: [nextIdentityName, objectsName],
              body: match(
                call(JAVASCRIPT_RUNTIME_OBJECT_KIND, [
                  reference(objectsName, span),
                  identity,
                ], span),
                [{
                  constructor: Runtime.JAVASCRIPT_OBJECT_ORDINARY,
                  binders: [],
                  body: runtimeFault("TypeError: JavaScript value is not callable", span),
                  span,
                }, {
                  constructor: Runtime.JAVASCRIPT_OBJECT_CALLABLE,
                  binders: [
                    targetName,
                    capturedRealmName,
                    capturedEnvironmentName,
                    thisBindingName,
                  ],
                  body: this.resumeCall(
                    this.dispatchCall(
                      reference(targetName, span),
                      call(Runtime.JAVASCRIPT_VALUE_OBJECT, [identity], span),
                      reference(heapName, span),
                      reference(capturedRealmName, span),
                      reference(capturedEnvironmentName, span),
                      reference(bindingsName, span),
                      match(reference(thisBindingName, span), [{
                        constructor: Runtime.JAVASCRIPT_THIS_DYNAMIC,
                        binders: [],
                        body: thisValue,
                        span,
                      }, {
                        constructor: Runtime.JAVASCRIPT_THIS_LEXICAL,
                        binders: [lexicalThisName],
                        body: reference(lexicalThisName, span),
                        span,
                      }], span),
                      arguments_,
                      span,
                    ),
                    reference(callerContextName, span),
                    onValue,
                    span,
                  ),
                  span,
                }, {
                  constructor: Runtime.JAVASCRIPT_OBJECT_ERROR,
                  binders: [this.freshName("calledErrorName")],
                  body: runtimeFault("TypeError: JavaScript value is not callable", span),
                  span,
                }],
                span,
              ),
              span,
            }], span),
            span,
          }], span),
          span,
        );
      }),
      span,
    );
  }

  private lowerArguments(
    arguments_: readonly JavaScriptAotExpression[],
    index: number,
    state: FunctionalSurfaceExpression,
    values: readonly FunctionalSurfaceExpression[],
    onArguments: (
      state: FunctionalSurfaceExpression,
      values: readonly FunctionalSurfaceExpression[],
    ) => FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const argument = arguments_[index];
    if (argument === undefined) return onArguments(state, values);
    return this.lowerExpression(
      argument,
      state,
      (nextState, value) =>
        this.lowerArguments(arguments_, index + 1, nextState, [...values, value], onArguments),
    );
  }

  private maximumRuntimeArgumentCount(): number {
    return this.#functions.reduce(
      (maximum, runtimeFunction) => Math.max(maximum, runtimeFunction.parameters.length),
      this.#maximumSourceCallArgumentCount,
    );
  }

  private dispatchCall(
    target: FunctionalSurfaceExpression,
    callee: FunctionalSurfaceExpression,
    heap: FunctionalSurfaceExpression,
    realm: FunctionalSurfaceExpression,
    environment: FunctionalSurfaceExpression,
    bindings: FunctionalSurfaceExpression,
    thisValue: FunctionalSurfaceExpression,
    arguments_: readonly FunctionalSurfaceExpression[],
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    const maximumArgumentCount = this.maximumRuntimeArgumentCount();
    const paddedArguments = Array.from(
      { length: maximumArgumentCount },
      (_, index) => arguments_[index] ?? reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, span),
    );
    if (!this.#usesSharedCallDispatcher) {
      return this.buildRuntimeCallDispatch(
        target,
        callee,
        heap,
        realm,
        environment,
        bindings,
        thisValue,
        integer(arguments_.length, span),
        paddedArguments,
        span,
      );
    }
    return call(JAVASCRIPT_RUNTIME_CALL_DISPATCH, [
      target,
      callee,
      heap,
      realm,
      environment,
      bindings,
      thisValue,
      integer(arguments_.length, span),
      ...paddedArguments,
    ], span);
  }

  private lowerRuntimeCallDispatcher(
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceDefinition {
    const targetName = this.freshName("dispatchTarget");
    const calleeName = this.freshName("dispatchCallee");
    const heapName = this.freshName("dispatchHeap");
    const realmName = this.freshName("dispatchRealm");
    const environmentName = this.freshName("dispatchEnvironment");
    const bindingsName = this.freshName("dispatchBindings");
    const thisValueName = this.freshName("dispatchThis");
    const argumentCountName = this.freshName("dispatchArgumentCount");
    const maximumArgumentCount = this.maximumRuntimeArgumentCount();
    const argumentNames = Array.from(
      { length: maximumArgumentCount },
      () => this.freshName("dispatchArgument"),
    );
    return {
      name: JAVASCRIPT_RUNTIME_CALL_DISPATCH,
      parameters: [
        targetName,
        calleeName,
        heapName,
        realmName,
        environmentName,
        bindingsName,
        thisValueName,
        argumentCountName,
        ...argumentNames,
      ],
      annotation: runtimeDispatcherType(maximumArgumentCount, span),
      body: this.buildRuntimeCallDispatch(
        reference(targetName, span),
        reference(calleeName, span),
        reference(heapName, span),
        reference(realmName, span),
        reference(environmentName, span),
        reference(bindingsName, span),
        reference(thisValueName, span),
        reference(argumentCountName, span),
        argumentNames.map((name) => reference(name, span)),
        span,
      ),
      span,
    };
  }

  private buildRuntimeCallDispatch(
    target: FunctionalSurfaceExpression,
    callee: FunctionalSurfaceExpression,
    heap: FunctionalSurfaceExpression,
    realm: FunctionalSurfaceExpression,
    environment: FunctionalSurfaceExpression,
    bindings: FunctionalSurfaceExpression,
    thisValue: FunctionalSurfaceExpression,
    argumentCount: FunctionalSurfaceExpression,
    arguments_: readonly FunctionalSurfaceExpression[],
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    let dispatch = runtimeFault(
      "JavaScript callable target is not registered in this module",
      span,
    );
    for (let index = this.#functions.length - 1; index >= 0; index--) {
      const runtimeFunction = this.#functions[index]!;
      const parameters = Array.from(
        { length: this.maximumRuntimeArgumentCount() },
        (_, parameterIndex) =>
          arguments_[parameterIndex] ?? reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, span),
      );
      const globalThisName = this.freshName("sloppyGlobalThis");
      const globalThisValue = match(realm, [{
        constructor: Runtime.JAVASCRIPT_REALM,
        binders: [globalThisName],
        body: reference(globalThisName, span),
        span,
      }], span);
      const booleanThisName = this.freshName("sloppyBooleanThis");
      const numberThisName = this.freshName("sloppyNumberThis");
      const stringThisName = this.freshName("sloppyStringThis");
      const symbolThisName = this.freshName("sloppySymbolThis");
      const objectThisName = this.freshName("sloppyObjectThis");
      const targetThisValue = runtimeFunction.thisMode === "lexical" || runtimeFunction.strict
        ? thisValue
        : match(thisValue, [{
          constructor: Runtime.JAVASCRIPT_VALUE_UNDEFINED,
          binders: [],
          body: globalThisValue,
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_NULL,
          binders: [],
          body: globalThisValue,
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_BOOLEAN,
          binders: [booleanThisName],
          body: call(
            Runtime.JAVASCRIPT_VALUE_BOOLEAN,
            [reference(booleanThisName, span)],
            span,
          ),
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_NUMBER,
          binders: [numberThisName],
          body: call(Runtime.JAVASCRIPT_VALUE_NUMBER, [reference(numberThisName, span)], span),
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_STRING,
          binders: [stringThisName],
          body: call(Runtime.JAVASCRIPT_VALUE_STRING, [reference(stringThisName, span)], span),
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_SYMBOL,
          binders: [symbolThisName],
          body: call(Runtime.JAVASCRIPT_VALUE_SYMBOL, [reference(symbolThisName, span)], span),
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_OBJECT,
          binders: [objectThisName],
          body: call(Runtime.JAVASCRIPT_VALUE_OBJECT, [reference(objectThisName, span)], span),
          span,
        }], span);
      dispatch = conditional(
        binary(
          FunctionalBinaryOperator.Equal,
          target,
          integer(runtimeFunction.id, span),
          span,
        ),
        call(
          runtimeFunction.name,
          [
            heap,
            realm,
            environment,
            bindings,
            targetThisValue,
            callee,
            argumentCount,
            ...parameters,
          ],
          span,
        ),
        dispatch,
        span,
      );
    }
    return dispatch;
  }

  private resumeCall(
    completion: FunctionalSurfaceExpression,
    callerContext: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    return this.withSharedExpressionContinuation(onValue, span, (resume) => {
      const resumeReturnedValue = (
        completedStateName: string,
        valueName: string,
      ): FunctionalSurfaceExpression => {
        const heapName = this.freshName("returnedHeap");
        const functionContextName = this.freshName("returnedFunctionContext");
        const bindingsName = this.freshName("returnedBindings");
        return match(reference(completedStateName, span), [{
          constructor: Runtime.JAVASCRIPT_STATE,
          binders: [heapName, functionContextName, bindingsName],
          body: resume(
            call(Runtime.JAVASCRIPT_STATE, [
              reference(heapName, span),
              callerContext,
              reference(bindingsName, span),
            ], span),
            reference(valueName, span),
          ),
          span,
        }], span);
      };
      const resumeThrow = (
        completedStateName: string,
        valueName: string,
      ): FunctionalSurfaceExpression => {
        const heapName = this.freshName("thrownHeap");
        const functionContextName = this.freshName("thrownFunctionContext");
        const bindingsName = this.freshName("thrownBindings");
        return match(reference(completedStateName, span), [{
          constructor: Runtime.JAVASCRIPT_STATE,
          binders: [heapName, functionContextName, bindingsName],
          body: call(Runtime.JAVASCRIPT_COMPLETION_THROW, [
            call(Runtime.JAVASCRIPT_STATE, [
              reference(heapName, span),
              callerContext,
              reference(bindingsName, span),
            ], span),
            reference(valueName, span),
          ], span),
          span,
        }], span);
      };
      const normalStateName = this.freshName("normalCallState");
      const normalValueName = this.freshName("normalCallValue");
      const returnStateName = this.freshName("returnCallState");
      const returnValueName = this.freshName("returnCallValue");
      const throwStateName = this.freshName("throwCallState");
      const throwValueName = this.freshName("throwCallValue");
      const breakStateName = this.freshName("breakCallState");
      const breakTargetName = this.freshName("breakCallTarget");
      const continueStateName = this.freshName("continueCallState");
      const continueTargetName = this.freshName("continueCallTarget");
      return match(completion, [{
        constructor: Runtime.JAVASCRIPT_COMPLETION_NORMAL,
        binders: [normalStateName, normalValueName],
        body: resumeReturnedValue(normalStateName, normalValueName),
        span,
      }, {
        constructor: Runtime.JAVASCRIPT_COMPLETION_RETURN,
        binders: [returnStateName, returnValueName],
        body: resumeReturnedValue(returnStateName, returnValueName),
        span,
      }, {
        constructor: Runtime.JAVASCRIPT_COMPLETION_THROW,
        binders: [throwStateName, throwValueName],
        body: resumeThrow(throwStateName, throwValueName),
        span,
      }, {
        constructor: Runtime.JAVASCRIPT_COMPLETION_BREAK,
        binders: [breakStateName, breakTargetName],
        body: runtimeFault("JavaScript function leaked a break completion", span),
        span,
      }, {
        constructor: Runtime.JAVASCRIPT_COMPLETION_CONTINUE,
        binders: [continueStateName, continueTargetName],
        body: runtimeFault("JavaScript function leaked a continue completion", span),
        span,
      }], span);
    });
  }

  private withSharedExpressionContinuation(
    onValue: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
    body: (resume: RuntimeExpressionContinuation) => FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const continuationName = this.freshName("expressionContinuation");
    const stateName = this.freshName("continuationState");
    const valueName = this.freshName("continuationValue");
    return {
      kind: "let-rec-group",
      bindings: [{
        name: continuationName,
        parameters: [stateName, valueName],
        body: onValue(reference(stateName, span), reference(valueName, span)),
        span,
      }],
      body: body((state, value) => call(continuationName, [state, value], span)),
      span,
    };
  }

  private lowerObject(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "object" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    return this.lowerObjectWithPrototype(
      expression,
      state,
      reference(Runtime.JAVASCRIPT_VALUE_NULL, expression.span),
      onValue,
    );
  }

  private lowerObjectWithPrototype(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "object" }>,
    state: FunctionalSurfaceExpression,
    prototype: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    const stateName = this.freshName("objectState");
    const heapName = this.freshName("objectHeap");
    const contextName = this.freshName("objectContext");
    const bindingsName = this.freshName("objectBindings");
    const allocatedHeapName = this.freshName("allocatedHeap");
    const allocatedObjectName = this.freshName("allocatedObject");
    return letExpression(
      stateName,
      state,
      match(reference(stateName, expression.span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, contextName, bindingsName],
        body: match(
          call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
            reference(heapName, expression.span),
            prototype,
            reference(Runtime.JAVASCRIPT_OBJECT_ORDINARY, expression.span),
          ], expression.span),
          [{
            constructor: Runtime.JAVASCRIPT_HEAP_ALLOCATION,
            binders: [allocatedHeapName, allocatedObjectName],
            body: match(
              reference(allocatedObjectName, expression.span),
              this.expectObjectArms(expression.span, (identity) =>
                this.lowerObjectProperties(
                  expression.properties,
                  0,
                  call(Runtime.JAVASCRIPT_STATE, [
                    reference(allocatedHeapName, expression.span),
                    reference(contextName, expression.span),
                    reference(bindingsName, expression.span),
                  ], expression.span),
                  reference(allocatedObjectName, expression.span),
                  identity,
                  onValue,
                )),
              expression.span,
            ),
            span: expression.span,
          }],
          expression.span,
        ),
        span: expression.span,
      }], expression.span),
      expression.span,
    );
  }

  private lowerObjectProperties(
    properties: Extract<JavaScriptAotExpression, { readonly kind: "object" }>["properties"],
    index: number,
    state: FunctionalSurfaceExpression,
    objectValue: FunctionalSurfaceExpression,
    identity: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    const property = properties[index];
    if (property === undefined) return onValue(state, objectValue);
    return this.lowerExpression(property.value, state, (propertyState, propertyValue) => {
      const stateName = this.freshName("propertyState");
      const heapName = this.freshName("propertyHeap");
      const contextName = this.freshName("propertyContext");
      const bindingsName = this.freshName("propertyBindings");
      return letExpression(
        stateName,
        propertyState,
        match(reference(stateName, property.span), [{
          constructor: Runtime.JAVASCRIPT_STATE,
          binders: [heapName, contextName, bindingsName],
          body: this.lowerObjectProperties(
            properties,
            index + 1,
            call(Runtime.JAVASCRIPT_STATE, [
              call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
                reference(heapName, property.span),
                identity,
                call(Runtime.JAVASCRIPT_PROPERTY_KEY_STRING, [
                  text(property.name, property.span),
                ], property.span),
                call(Runtime.JAVASCRIPT_DATA_DESCRIPTOR, [
                  propertyValue,
                  boolean(true, property.span),
                  boolean(true, property.span),
                  boolean(true, property.span),
                ], property.span),
              ], property.span),
              reference(contextName, property.span),
              reference(bindingsName, property.span),
            ], property.span),
            objectValue,
            identity,
            onValue,
          ),
          span: property.span,
        }], property.span),
        property.span,
      );
    });
  }

  private readProperty(
    state: FunctionalSurfaceExpression,
    receiver: FunctionalSurfaceExpression,
    propertyName: string,
    onValue: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    const complete = (
      completedState: FunctionalSurfaceExpression,
      value: FunctionalSurfaceExpression,
    ) => call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [completedState, value], span);
    const readCompletion = match(
      receiver,
      this.expectObjectArms(span, (identity) => {
        const stateName = this.freshName("propertyReadState");
        const propertyValueName = this.freshName("propertyValue");
        const getterName = this.freshName("getter");
        const getterReceiverName = this.freshName("getterReceiver");
        const objectValue = call(Runtime.JAVASCRIPT_VALUE_OBJECT, [identity], span);
        return letExpression(
          stateName,
          state,
          match(
            call(JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE, [
              reference(stateName, span),
              call(Runtime.JAVASCRIPT_PROPERTY_REFERENCE, [
                objectValue,
                call(Runtime.JAVASCRIPT_PROPERTY_KEY_STRING, [text(propertyName, span)], span),
                objectValue,
                boolean(true, span),
              ], span),
            ], span),
            [{
              constructor: Runtime.JAVASCRIPT_VALUE_MISSING,
              binders: [],
              body: complete(
                reference(stateName, span),
                reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, span),
              ),
              span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_UNINITIALIZED,
              binders: [],
              body: runtimeFault(
                `JavaScript property ${JSON.stringify(propertyName)} was uninitialized`,
                span,
              ),
              span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_FOUND,
              binders: [propertyValueName],
              body: complete(
                reference(stateName, span),
                reference(propertyValueName, span),
              ),
              span,
            }, {
              constructor: Runtime.JAVASCRIPT_VALUE_ACCESSOR,
              binders: [getterName, getterReceiverName],
              body: this.invokeRuntimeCallable(
                reference(getterName, span),
                reference(stateName, span),
                reference(getterReceiverName, span),
                [],
                complete,
                span,
              ),
              span,
            }],
            span,
          ),
          span,
        );
      }),
      span,
    );
    return this.resumeExpressionCompletion(readCompletion, onValue, span);
  }

  private toRuntimePrimitive(
    state: FunctionalSurfaceExpression,
    value: FunctionalSurfaceExpression,
    onPrimitive: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    return this.resumeExpressionCompletion(
      call(JAVASCRIPT_RUNTIME_TO_PRIMITIVE, [state, value], span),
      onPrimitive,
      span,
    );
  }

  private lowerRuntimePrimitiveDefinition(
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceDefinition {
    const stateName = this.freshName("primitiveState");
    const valueName = this.freshName("primitiveValue");
    const state = reference(stateName, span);
    const value = reference(valueName, span);
    const complete = (
      completedState: FunctionalSurfaceExpression,
      primitive: FunctionalSurfaceExpression,
    ) => call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [completedState, primitive], span);
    const conversion = match(
      value,
      primitiveOrObjectValueArms(
        this.freshName("primitiveObjectIdentity"),
        span,
        (primitive) => complete(state, primitive),
        (identity) => {
          const receiver = call(Runtime.JAVASCRIPT_VALUE_OBJECT, [identity], span);
          const tryToString = (nextState: FunctionalSurfaceExpression) =>
            this.readProperty(
              nextState,
              receiver,
              "toString",
              (methodState, method) =>
                this.invokeRuntimeMethodIfCallable(
                  methodState,
                  method,
                  receiver,
                  (resultState, result) =>
                    this.acceptRuntimePrimitive(
                      resultState,
                      result,
                      complete,
                      () =>
                        runtimeFault("JavaScript object did not produce a primitive value", span),
                      span,
                    ),
                  (unavailableState) =>
                    complete(
                      unavailableState,
                      call(Runtime.JAVASCRIPT_VALUE_STRING, [text("[object Object]", span)], span),
                    ),
                  span,
                ),
              span,
            );
          return this.readProperty(
            state,
            receiver,
            "valueOf",
            (methodState, method) =>
              this.invokeRuntimeMethodIfCallable(
                methodState,
                method,
                receiver,
                (resultState, result) =>
                  this.acceptRuntimePrimitive(
                    resultState,
                    result,
                    complete,
                    () => tryToString(resultState),
                    span,
                  ),
                tryToString,
                span,
              ),
            span,
          );
        },
      ),
      span,
    );
    return {
      name: JAVASCRIPT_RUNTIME_TO_PRIMITIVE,
      parameters: [stateName, valueName],
      annotation: null,
      body: conversion,
      span,
    };
  }

  private acceptRuntimePrimitive(
    state: FunctionalSurfaceExpression,
    value: FunctionalSurfaceExpression,
    onPrimitive: RuntimeExpressionContinuation,
    onObject: () => FunctionalSurfaceExpression,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    return match(
      value,
      primitiveOrObjectValueArms(
        this.freshName("nonPrimitiveObject"),
        span,
        (primitive) => onPrimitive(state, primitive),
        onObject,
      ),
      span,
    );
  }

  private invokeRuntimeMethodIfCallable(
    state: FunctionalSurfaceExpression,
    method: FunctionalSurfaceExpression,
    receiver: FunctionalSurfaceExpression,
    onResult: RuntimeExpressionContinuation,
    onUnavailable: RuntimeStatementContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    const stateName = this.freshName("methodState");
    const heapName = this.freshName("methodHeap");
    const contextName = this.freshName("methodContext");
    const bindingsName = this.freshName("methodBindings");
    return letExpression(
      stateName,
      state,
      match(reference(stateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, contextName, bindingsName],
        body: conditional(
          call(JAVASCRIPT_RUNTIME_IS_CALLABLE, [reference(heapName, span), method], span),
          this.invokeRuntimeCallable(
            method,
            reference(stateName, span),
            receiver,
            [],
            onResult,
            span,
          ),
          onUnavailable(reference(stateName, span)),
          span,
        ),
        span,
      }], span),
      span,
    );
  }

  private lowerUnary(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "unary" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    if (expression.operator === "typeof") {
      return this.lowerExpression(expression.value, state, (valueState, value) => {
        const stateName = this.freshName("typeofState");
        const heapName = this.freshName("typeofHeap");
        const contextName = this.freshName("typeofContext");
        const bindingsName = this.freshName("typeofBindings");
        return letExpression(
          stateName,
          valueState,
          match(reference(stateName, expression.span), [{
            constructor: Runtime.JAVASCRIPT_STATE,
            binders: [heapName, contextName, bindingsName],
            body: onValue(
              reference(stateName, expression.span),
              call(Runtime.JAVASCRIPT_VALUE_STRING, [
                call(JAVASCRIPT_RUNTIME_TYPEOF, [
                  reference(heapName, expression.span),
                  value,
                ], expression.span),
              ], expression.span),
            ),
            span: expression.span,
          }], expression.span),
          expression.span,
        );
      });
    }
    if (expression.operator === "!") {
      return this.lowerExpression(expression.value, state, (valueState, value) =>
        onValue(
          valueState,
          call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
            conditional(
              call(JAVASCRIPT_RUNTIME_TO_BOOLEAN, [value], expression.span),
              boolean(false, expression.span),
              boolean(true, expression.span),
              expression.span,
            ),
          ], expression.span),
        ));
    }
    if (expression.operator === "-" || expression.operator === "+") {
      if (!this.#usesSharedCallDispatcher) {
        return this.lowerExpression(
          expression.value,
          state,
          (valueState, value) =>
            this.expectNumber(value, expression.span, (number) =>
              onValue(
                valueState,
                call(Runtime.JAVASCRIPT_VALUE_NUMBER, [
                  expression.operator === "+" ? number : {
                    kind: "unary",
                    operator: FunctionalUnaryOperator.NegateFloat64,
                    value: number,
                    span: expression.span,
                  },
                ], expression.span),
              )),
        );
      }
      return this.lowerExpression(
        expression.value,
        state,
        (valueState, value) =>
          this.toRuntimePrimitive(
            valueState,
            value,
            (primitiveState, primitive) => {
              const number = call(JAVASCRIPT_RUNTIME_TO_NUMBER, [primitive], expression.span);
              return onValue(
                primitiveState,
                call(Runtime.JAVASCRIPT_VALUE_NUMBER, [
                  expression.operator === "+" ? number : {
                    kind: "unary",
                    operator: FunctionalUnaryOperator.NegateFloat64,
                    value: number,
                    span: expression.span,
                  },
                ], expression.span),
              );
            },
            expression.span,
          ),
      );
    }
    throw new JavaScriptAotLoweringError(
      expression.span,
      `JavaScript unary ${
        JSON.stringify(expression.operator)
      } is not yet supported by runtime-model lowering.`,
    );
  }

  private lowerBinary(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "binary" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    if (
      expression.operator === "instanceof" && expression.right.kind === "name" &&
      JAVASCRIPT_RUNTIME_ERROR_CONSTRUCTORS.has(expression.right.name)
    ) {
      const target = expression.right.name;
      return this.lowerExpression(
        expression.left,
        state,
        (leftState, leftValue) =>
          this.withSharedExpressionContinuation(
            onValue,
            expression.span,
            (resume) =>
              match(
                leftValue,
                primitiveOrObjectValueArms(
                  this.freshName("instanceofValue"),
                  expression.span,
                  () =>
                    resume(
                      leftState,
                      call(
                        Runtime.JAVASCRIPT_VALUE_BOOLEAN,
                        [boolean(false, expression.span)],
                        expression.span,
                      ),
                    ),
                  (identity) => {
                    const stateName = this.freshName("instanceofState");
                    const heapName = this.freshName("instanceofHeap");
                    const contextName = this.freshName("instanceofContext");
                    const bindingsName = this.freshName("instanceofBindings");
                    const nextIdentityName = this.freshName("instanceofNextIdentity");
                    const objectsName = this.freshName("instanceofObjects");
                    const errorName = this.freshName("instanceofErrorName");
                    return letExpression(
                      stateName,
                      leftState,
                      match(reference(stateName, expression.span), [{
                        constructor: Runtime.JAVASCRIPT_STATE,
                        binders: [heapName, contextName, bindingsName],
                        body: match(reference(heapName, expression.span), [{
                          constructor: Runtime.JAVASCRIPT_HEAP,
                          binders: [nextIdentityName, objectsName],
                          body: match(
                            call(JAVASCRIPT_RUNTIME_OBJECT_KIND, [
                              reference(objectsName, expression.span),
                              identity,
                            ], expression.span),
                            [{
                              constructor: Runtime.JAVASCRIPT_OBJECT_ORDINARY,
                              binders: [],
                              body: resume(
                                reference(stateName, expression.span),
                                call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
                                  boolean(false, expression.span),
                                ], expression.span),
                              ),
                              span: expression.span,
                            }, {
                              constructor: Runtime.JAVASCRIPT_OBJECT_CALLABLE,
                              binders: [
                                this.freshName("instanceofTarget"),
                                this.freshName("instanceofRealm"),
                                this.freshName("instanceofEnvironment"),
                                this.freshName("instanceofThis"),
                              ],
                              body: resume(
                                reference(stateName, expression.span),
                                call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
                                  boolean(false, expression.span),
                                ], expression.span),
                              ),
                              span: expression.span,
                            }, {
                              constructor: Runtime.JAVASCRIPT_OBJECT_ERROR,
                              binders: [errorName],
                              body: resume(
                                reference(stateName, expression.span),
                                call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
                                  target === "Error" ? boolean(true, expression.span) : binary(
                                    FunctionalBinaryOperator.StructuralEqual,
                                    reference(errorName, expression.span),
                                    text(target, expression.span),
                                    expression.span,
                                  ),
                                ], expression.span),
                              ),
                              span: expression.span,
                            }],
                            expression.span,
                          ),
                          span: expression.span,
                        }], expression.span),
                        span: expression.span,
                      }], expression.span),
                      expression.span,
                    );
                  },
                ),
                expression.span,
              ),
          ),
      );
    }
    if (expression.operator === "instanceof") {
      if (expression.right.kind !== "name") {
        throw new JavaScriptAotLoweringError(
          expression.right.span,
          "JavaScript runtime-model instanceof currently requires a statically named constructor.",
        );
      }
      const constructorName = expression.right.name;
      return this.lowerExpression(
        expression.left,
        state,
        (leftState, leftValue) =>
          this.lookupBinding(
            leftState,
            constructorName,
            (constructorState, constructorValue) =>
              this.readProperty(
                constructorState,
                constructorValue,
                "prototype",
                (prototypeState, prototypeValue) => {
                  const stateName = this.freshName("instanceofState");
                  const heapName = this.freshName("instanceofHeap");
                  const contextName = this.freshName("instanceofContext");
                  const bindingsName = this.freshName("instanceofBindings");
                  const nextIdentityName = this.freshName("instanceofNextIdentity");
                  const objectsName = this.freshName("instanceofObjects");
                  return letExpression(
                    stateName,
                    prototypeState,
                    match(reference(stateName, expression.span), [{
                      constructor: Runtime.JAVASCRIPT_STATE,
                      binders: [heapName, contextName, bindingsName],
                      body: onValue(
                        reference(stateName, expression.span),
                        call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
                          conditional(
                            call(JAVASCRIPT_RUNTIME_IS_CALLABLE, [
                              reference(heapName, expression.span),
                              constructorValue,
                            ], expression.span),
                            match(
                              prototypeValue,
                              valueCaseArms(
                                Runtime.JAVASCRIPT_VALUE_OBJECT,
                                this.freshName("instanceofPrototypeIdentity"),
                                expression.span,
                                (prototypeIdentity) =>
                                  match(
                                    leftValue,
                                    primitiveOrObjectValueArms(
                                      this.freshName("instanceofObjectIdentity"),
                                      expression.span,
                                      () => boolean(false, expression.span),
                                      (objectIdentity) =>
                                        match(reference(heapName, expression.span), [{
                                          constructor: Runtime.JAVASCRIPT_HEAP,
                                          binders: [nextIdentityName, objectsName],
                                          body: call(JAVASCRIPT_RUNTIME_HAS_PROTOTYPE, [
                                            reference(objectsName, expression.span),
                                            objectIdentity,
                                            prototypeIdentity,
                                          ], expression.span),
                                          span: expression.span,
                                        }], expression.span),
                                    ),
                                    expression.span,
                                  ),
                                "TypeError: JavaScript instanceof constructor has a non-object prototype",
                              ),
                              expression.span,
                            ),
                            runtimeFault(
                              "TypeError: JavaScript instanceof right operand is not callable",
                              expression.span,
                            ),
                            expression.span,
                          ),
                        ], expression.span),
                      ),
                      span: expression.span,
                    }], expression.span),
                    expression.span,
                  );
                },
                expression.span,
              ),
            expression.span,
          ),
      );
    }
    if (expression.operator === "same-value" || expression.operator === "not-same-value") {
      return this.lowerExpression(
        expression.left,
        state,
        (leftState, left) =>
          this.lowerExpression(expression.right, leftState, (rightState, right) => {
            const equality = call(JAVASCRIPT_RUNTIME_SAME_VALUE, [left, right], expression.span);
            return onValue(
              rightState,
              call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
                expression.operator === "same-value" ? equality : conditional(
                  equality,
                  boolean(false, expression.span),
                  boolean(true, expression.span),
                  expression.span,
                ),
              ], expression.span),
            );
          }),
      );
    }
    if (expression.operator === "===" || expression.operator === "!==") {
      return this.lowerExpression(
        expression.left,
        state,
        (leftState, left) =>
          this.lowerExpression(expression.right, leftState, (rightState, right) => {
            const equality = call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [left, right], expression.span);
            return onValue(
              rightState,
              call(Runtime.JAVASCRIPT_VALUE_BOOLEAN, [
                expression.operator === "===" ? equality : conditional(
                  equality,
                  boolean(false, expression.span),
                  boolean(true, expression.span),
                  expression.span,
                ),
              ], expression.span),
            );
          }),
      );
    }
    if (expression.operator === "&&" || expression.operator === "||") {
      return this.lowerExpression(
        expression.left,
        state,
        (leftState, left) =>
          this.resumeExpressionCompletion(
            conditional(
              call(JAVASCRIPT_RUNTIME_TO_BOOLEAN, [left], expression.left.span),
              expression.operator === "&&"
                ? this.lowerExpression(
                  expression.right,
                  leftState,
                  (rightState, right) =>
                    call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                      rightState,
                      right,
                    ], expression.right.span),
                )
                : call(
                  Runtime.JAVASCRIPT_COMPLETION_NORMAL,
                  [leftState, left],
                  expression.left.span,
                ),
              expression.operator === "&&"
                ? call(
                  Runtime.JAVASCRIPT_COMPLETION_NORMAL,
                  [leftState, left],
                  expression.left.span,
                )
                : this.lowerExpression(
                  expression.right,
                  leftState,
                  (rightState, right) =>
                    call(Runtime.JAVASCRIPT_COMPLETION_NORMAL, [
                      rightState,
                      right,
                    ], expression.right.span),
                ),
              expression.span,
            ),
            onValue,
            expression.span,
          ),
      );
    }
    if (expression.operator === "+") {
      return this.lowerExpression(
        expression.left,
        state,
        (leftState, left) =>
          this.lowerExpression(
            expression.right,
            leftState,
            (rightState, right) =>
              this.#usesSharedCallDispatcher
                ? this.toRuntimePrimitive(
                  rightState,
                  left,
                  (leftPrimitiveState, leftPrimitive) =>
                    this.toRuntimePrimitive(
                      leftPrimitiveState,
                      right,
                      (rightPrimitiveState, rightPrimitive) =>
                        onValue(
                          rightPrimitiveState,
                          call(
                            JAVASCRIPT_RUNTIME_ADD,
                            [leftPrimitive, rightPrimitive],
                            expression.span,
                          ),
                        ),
                      expression.right.span,
                    ),
                  expression.left.span,
                )
                : onValue(
                  rightState,
                  call(JAVASCRIPT_RUNTIME_ADD, [left, right], expression.span),
                ),
          ),
      );
    }
    const operator = runtimeNumericOperators[expression.operator];
    if (operator === undefined) {
      throw new JavaScriptAotLoweringError(
        expression.span,
        `JavaScript binary ${
          JSON.stringify(expression.operator)
        } is not yet supported by runtime-model lowering.`,
      );
    }
    if (!this.#usesSharedCallDispatcher) {
      return this.lowerExpression(
        expression.left,
        state,
        (leftState, left) =>
          this.expectNumber(
            left,
            expression.left.span,
            (leftNumber) =>
              this.lowerExpression(expression.right, leftState, (rightState, right) =>
                this.expectNumber(right, expression.right.span, (rightNumber) => {
                  const result = binary(operator, leftNumber, rightNumber, expression.span);
                  const comparison = expression.operator === "<" || expression.operator === "<=" ||
                    expression.operator === ">" || expression.operator === ">=";
                  return onValue(
                    rightState,
                    call(
                      comparison
                        ? Runtime.JAVASCRIPT_VALUE_BOOLEAN
                        : Runtime.JAVASCRIPT_VALUE_NUMBER,
                      [result],
                      expression.span,
                    ),
                  );
                })),
          ),
      );
    }
    return this.lowerExpression(
      expression.left,
      state,
      (leftState, left) =>
        this.lowerExpression(
          expression.right,
          leftState,
          (rightState, right) =>
            this.toRuntimePrimitive(
              rightState,
              left,
              (leftPrimitiveState, leftPrimitive) =>
                this.toRuntimePrimitive(
                  leftPrimitiveState,
                  right,
                  (rightPrimitiveState, rightPrimitive) => {
                    const result = binary(
                      operator,
                      call(
                        JAVASCRIPT_RUNTIME_TO_NUMBER,
                        [leftPrimitive],
                        expression.left.span,
                      ),
                      call(
                        JAVASCRIPT_RUNTIME_TO_NUMBER,
                        [rightPrimitive],
                        expression.right.span,
                      ),
                      expression.span,
                    );
                    const comparison = expression.operator === "<" ||
                      expression.operator === "<=" || expression.operator === ">" ||
                      expression.operator === ">=";
                    return onValue(
                      rightPrimitiveState,
                      call(
                        comparison
                          ? Runtime.JAVASCRIPT_VALUE_BOOLEAN
                          : Runtime.JAVASCRIPT_VALUE_NUMBER,
                        [result],
                        expression.span,
                      ),
                    );
                  },
                  expression.right.span,
                ),
              expression.left.span,
            ),
        ),
    );
  }

  private lookupBinding(
    state: FunctionalSurfaceExpression,
    name: string,
    onValue: RuntimeExpressionContinuation,
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    const stateName = this.freshName("bindingState");
    const valueName = this.freshName("bindingValue");
    return letExpression(
      stateName,
      state,
      match(
        call(JAVASCRIPT_RUNTIME_LOOKUP_BINDING, [
          reference(stateName, span),
          text(name, span),
        ], span),
        [{
          constructor: Runtime.JAVASCRIPT_VALUE_MISSING,
          binders: [],
          body: runtimeFault(
            `ReferenceError: JavaScript name ${JSON.stringify(name)} is not defined`,
            span,
          ),
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_UNINITIALIZED,
          binders: [],
          body: runtimeFault(
            `ReferenceError: JavaScript name ${
              JSON.stringify(name)
            } was read before initialization`,
            span,
          ),
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_FOUND,
          binders: [valueName],
          body: onValue(reference(stateName, span), reference(valueName, span)),
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_ACCESSOR,
          binders: ["getter", "receiver"],
          body: runtimeFault("JavaScript environment binding resolved as an accessor", span),
          span,
        }],
        span,
      ),
      span,
    );
  }

  private initializeBinding(
    state: FunctionalSurfaceExpression,
    name: string,
    value: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
    span: JavaScriptAotStatement["span"],
  ): FunctionalSurfaceExpression {
    return this.updateBinding(
      state,
      JAVASCRIPT_RUNTIME_INITIALIZE_BINDING,
      name,
      value,
      onNormal,
      span,
    );
  }

  private setBinding(
    state: FunctionalSurfaceExpression,
    name: string,
    value: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
    span: JavaScriptAotStatement["span"],
  ): FunctionalSurfaceExpression {
    return this.updateBinding(
      state,
      JAVASCRIPT_RUNTIME_SET_BINDING,
      name,
      value,
      onNormal,
      span,
    );
  }

  private updateBinding(
    state: FunctionalSurfaceExpression,
    operation: string,
    name: string,
    value: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
    span: JavaScriptAotStatement["span"],
  ): FunctionalSurfaceExpression {
    const stateName = this.freshName("environmentState");
    return letExpression(
      stateName,
      state,
      match(
        call(operation, [reference(stateName, span), text(name, span), value], span),
        this.bindingUpdateArms(name, onNormal, span),
        span,
      ),
      span,
    );
  }

  private bindingUpdateArms(
    name: string,
    onNormal: RuntimeStatementContinuation,
    span: JavaScriptAotStatement["span"],
  ): readonly FunctionalSurfaceCaseArm[] {
    const updatedStateName = this.freshName("updatedBindingState");
    return [{
      constructor: Runtime.JAVASCRIPT_BINDING_UPDATE_NOT_FOUND,
      binders: [],
      body: runtimeFault(
        `ReferenceError: JavaScript name ${JSON.stringify(name)} is not defined`,
        span,
      ),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_BINDING_UPDATE_UNINITIALIZED,
      binders: [],
      body: runtimeFault(
        `ReferenceError: JavaScript name ${
          JSON.stringify(name)
        } was assigned before initialization`,
        span,
      ),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED,
      binders: [],
      body: runtimeFault(
        `ReferenceError: JavaScript name ${JSON.stringify(name)} was initialized twice`,
        span,
      ),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_BINDING_UPDATE_IMMUTABLE,
      binders: [],
      body: runtimeFault(
        `TypeError: JavaScript binding ${JSON.stringify(name)} is immutable`,
        span,
      ),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_BINDING_UPDATE_UPDATED,
      binders: [updatedStateName],
      body: onNormal(reference(updatedStateName, span)),
      span,
    }];
  }

  private expectObjectArms(
    span: JavaScriptAotExpression["span"],
    onObject: (identity: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
  ): readonly FunctionalSurfaceCaseArm[] {
    const identityName = this.freshName("objectIdentity");
    return valueCaseArms(
      Runtime.JAVASCRIPT_VALUE_OBJECT,
      identityName,
      span,
      (identity) => onObject(identity),
      "TypeError: JavaScript property receiver is not an object",
    );
  }

  private expectNumber(
    value: FunctionalSurfaceExpression,
    span: JavaScriptAotExpression["span"],
    onNumber: (number: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const numberName = this.freshName("numberValue");
    return match(
      value,
      valueCaseArms(
        Runtime.JAVASCRIPT_VALUE_NUMBER,
        numberName,
        span,
        onNumber,
        "JavaScript numeric operation received a non-number value",
      ),
      span,
    );
  }

  private expectBoolean(
    value: FunctionalSurfaceExpression,
    span: JavaScriptAotExpression["span"],
    onBoolean: (boolean: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const booleanName = this.freshName("booleanValue");
    return match(
      value,
      valueCaseArms(
        Runtime.JAVASCRIPT_VALUE_BOOLEAN,
        booleanName,
        span,
        onBoolean,
        "JavaScript entry returned a non-boolean value",
      ),
      span,
    );
  }

  private expectString(
    value: FunctionalSurfaceExpression,
    span: JavaScriptAotExpression["span"],
    onString: (text: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const stringName = this.freshName("stringValue");
    return match(
      value,
      valueCaseArms(
        Runtime.JAVASCRIPT_VALUE_STRING,
        stringName,
        span,
        onString,
        "JavaScript entry returned a non-string value",
      ),
      span,
    );
  }

  private unwrapEntryCompletion(
    completion: FunctionalSurfaceExpression,
    span: JavaScriptAotFunctionDeclaration["span"],
    resultKind: RuntimeEntryResultKind,
  ): FunctionalSurfaceExpression {
    const unwrapValue = (value: FunctionalSurfaceExpression) => {
      switch (resultKind) {
        case "boolean":
          return this.expectBoolean(value, span, (boolean) => boolean);
        case "number":
          return this.expectNumber(value, span, (number) => number);
        case "string":
          return this.expectString(value, span, (text) => text);
      }
    };
    const unexpected = runtimeFault(
      "JavaScript entry completed without returning a number",
      span,
    );
    return match(completion, [{
      constructor: Runtime.JAVASCRIPT_COMPLETION_NORMAL,
      binders: ["completedState", "completedValue"],
      body: unwrapValue(reference("completedValue", span)),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_RETURN,
      binders: ["completedState", "completedValue"],
      body: unwrapValue(reference("completedValue", span)),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_THROW,
      binders: ["completedState", "thrownValue"],
      body: unexpected,
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_BREAK,
      binders: ["completedState", "target"],
      body: unexpected,
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_CONTINUE,
      binders: ["completedState", "target"],
      body: unexpected,
      span,
    }], span);
  }

  private freshName(purpose: string): string {
    return `$javascript#runtime#${purpose}#${this.#bindingIndex++}`;
  }
}

function runtimeStatementsReferenceName(
  statements: readonly JavaScriptAotStatement[],
  target: string,
): boolean {
  return statements.some((statement): boolean => {
    switch (statement.kind) {
      case "function-declaration":
      case "break":
      case "continue":
        return false;
      case "constant":
      case "mutable":
      case "return":
      case "throw":
      case "expression":
        return runtimeExpressionReferencesName(statement.value, target);
      case "assignment":
        return statement.name === target ||
          runtimeExpressionReferencesName(statement.value, target);
      case "property-assignment":
        return runtimeExpressionReferencesName(statement.target, target) ||
          runtimeExpressionReferencesName(statement.value, target);
      case "var":
        return statement.declarations.some((declaration) =>
          declaration.value !== null && runtimeExpressionReferencesName(declaration.value, target)
        );
      case "if":
        return runtimeExpressionReferencesName(statement.condition, target) ||
          runtimeStatementsReferenceName(statement.consequent, target) ||
          statement.alternate !== null &&
            runtimeStatementsReferenceName(statement.alternate, target);
      case "while":
        return runtimeExpressionReferencesName(statement.condition, target) ||
          runtimeStatementsReferenceName(statement.body, target) ||
          runtimeStatementsReferenceName(statement.continueBody, target);
      case "block":
        return runtimeStatementsReferenceName(statement.statements, target);
      case "try":
        return runtimeStatementsReferenceName(statement.body, target) ||
          statement.catchBody !== null &&
            runtimeStatementsReferenceName(statement.catchBody, target) ||
          statement.finallyBody !== null &&
            runtimeStatementsReferenceName(statement.finallyBody, target);
    }
  });
}

function rewriteMappedArguments(
  statements: readonly JavaScriptAotStatement[],
  parameters: readonly string[],
): readonly JavaScriptAotStatement[] {
  const pending = [...statements];
  while (pending.length !== 0) {
    const statement = pending.pop()!;
    if (
      (statement.kind === "constant" || statement.kind === "mutable" ||
          statement.kind === "function-declaration") && statement.name === "arguments" ||
      statement.kind === "var" &&
        statement.declarations.some((declaration) => declaration.name === "arguments") ||
      statement.kind === "try" && statement.catchName === "arguments"
    ) return statements;
    if (statement.kind === "block") pending.push(...statement.statements);
    if (statement.kind === "if") {
      pending.push(...statement.consequent);
      if (statement.alternate !== null) pending.push(...statement.alternate);
    }
    if (statement.kind === "while") {
      pending.push(...statement.body, ...statement.continueBody);
    }
    if (statement.kind === "try") {
      pending.push(...statement.body);
      if (statement.catchBody !== null) pending.push(...statement.catchBody);
      if (statement.finallyBody !== null) pending.push(...statement.finallyBody);
    }
  }

  const mappedParameter = (
    expression: JavaScriptAotExpression,
  ): string | null => {
    if (
      expression.kind !== "index" || expression.value.kind !== "name" ||
      expression.value.name !== "arguments" || expression.index.kind !== "number" ||
      !Number.isInteger(expression.index.value)
    ) return null;
    return parameters[expression.index.value] ?? null;
  };
  const rewriteExpression = (
    expression: JavaScriptAotExpression,
  ): JavaScriptAotExpression => {
    const parameter = mappedParameter(expression);
    if (parameter !== null) return { kind: "name", name: parameter, span: expression.span };
    switch (expression.kind) {
      case "array":
        return { ...expression, values: expression.values.map(rewriteExpression) };
      case "object":
        return {
          ...expression,
          properties: expression.properties.map((property) => ({
            ...property,
            value: rewriteExpression(property.value),
          })),
        };
      case "function":
        return expression;
      case "unary":
      case "property":
        return { ...expression, value: rewriteExpression(expression.value) };
      case "binary":
        return {
          ...expression,
          left: rewriteExpression(expression.left),
          right: rewriteExpression(expression.right),
        };
      case "conditional":
        return {
          ...expression,
          condition: rewriteExpression(expression.condition),
          consequent: rewriteExpression(expression.consequent),
          alternate: rewriteExpression(expression.alternate),
        };
      case "call":
        return {
          ...expression,
          callee: rewriteExpression(expression.callee),
          arguments: expression.arguments.map(rewriteExpression),
        };
      case "new":
        return { ...expression, arguments: expression.arguments.map(rewriteExpression) };
      case "index":
        return {
          ...expression,
          value: rewriteExpression(expression.value),
          index: rewriteExpression(expression.index),
        };
      default:
        return expression;
    }
  };
  const rewriteStatement = (
    statement: JavaScriptAotStatement,
  ): JavaScriptAotStatement => {
    switch (statement.kind) {
      case "function-declaration":
        return statement;
      case "constant":
      case "mutable":
      case "assignment":
      case "return":
      case "throw":
      case "expression":
        return { ...statement, value: rewriteExpression(statement.value) };
      case "property-assignment": {
        const parameter = mappedParameter(statement.target);
        if (parameter !== null) {
          return {
            kind: "assignment",
            name: parameter,
            operator: statement.operator,
            value: rewriteExpression(statement.value),
            span: statement.span,
          };
        }
        const target = statement.target.kind === "property"
          ? { ...statement.target, value: rewriteExpression(statement.target.value) }
          : {
            ...statement.target,
            value: rewriteExpression(statement.target.value),
            index: rewriteExpression(statement.target.index),
          };
        return {
          ...statement,
          target,
          value: rewriteExpression(statement.value),
        };
      }
      case "var":
        return {
          ...statement,
          declarations: statement.declarations.map((declaration) => ({
            ...declaration,
            value: declaration.value === null ? null : rewriteExpression(declaration.value),
          })),
        };
      case "if":
        return {
          ...statement,
          condition: rewriteExpression(statement.condition),
          consequent: statement.consequent.map(rewriteStatement),
          alternate: statement.alternate?.map(rewriteStatement) ?? null,
        };
      case "while":
        return {
          ...statement,
          condition: rewriteExpression(statement.condition),
          body: statement.body.map(rewriteStatement),
          continueBody: statement.continueBody.map(rewriteStatement),
        };
      case "block":
        return { ...statement, statements: statement.statements.map(rewriteStatement) };
      case "try":
        return {
          ...statement,
          body: statement.body.map(rewriteStatement),
          catchBody: statement.catchBody?.map(rewriteStatement) ?? null,
          finallyBody: statement.finallyBody?.map(rewriteStatement) ?? null,
        };
      case "break":
      case "continue":
        return statement;
    }
  };
  return statements.map(rewriteStatement);
}

function runtimeExpressionReferencesName(
  expression: JavaScriptAotExpression,
  target: string,
): boolean {
  switch (expression.kind) {
    case "name":
      return expression.name === target;
    case "function":
      return false;
    case "array":
      return expression.values.some((value) => runtimeExpressionReferencesName(value, target));
    case "object":
      return expression.properties.some((property) =>
        runtimeExpressionReferencesName(property.value, target)
      );
    case "unary":
    case "property":
      return runtimeExpressionReferencesName(expression.value, target);
    case "binary":
      return runtimeExpressionReferencesName(expression.left, target) ||
        runtimeExpressionReferencesName(expression.right, target);
    case "conditional":
      return runtimeExpressionReferencesName(expression.condition, target) ||
        runtimeExpressionReferencesName(expression.consequent, target) ||
        runtimeExpressionReferencesName(expression.alternate, target);
    case "call":
      return runtimeExpressionReferencesName(expression.callee, target) ||
        expression.arguments.some((argument) => runtimeExpressionReferencesName(argument, target));
    case "new":
      return expression.arguments.some((argument) =>
        runtimeExpressionReferencesName(argument, target)
      );
    case "index":
      return runtimeExpressionReferencesName(expression.value, target) ||
        runtimeExpressionReferencesName(expression.index, target);
    default:
      return false;
  }
}

function runtimeStatementsMaximumCallArgumentCount(
  statements: readonly JavaScriptAotStatement[],
): number {
  let maximum = 0;
  for (const statement of statements) {
    switch (statement.kind) {
      case "function-declaration":
        maximum = Math.max(
          maximum,
          runtimeStatementsMaximumCallArgumentCount(statement.body),
          ...Array.from(
            statement.classMethods ?? [],
            (method) => runtimeExpressionMaximumCallArgumentCount(method.value),
          ),
        );
        break;
      case "constant":
      case "mutable":
      case "return":
      case "throw":
      case "expression":
        maximum = Math.max(maximum, runtimeExpressionMaximumCallArgumentCount(statement.value));
        break;
      case "assignment":
        maximum = Math.max(maximum, runtimeExpressionMaximumCallArgumentCount(statement.value));
        break;
      case "property-assignment":
        maximum = Math.max(
          maximum,
          runtimeExpressionMaximumCallArgumentCount(statement.target),
          runtimeExpressionMaximumCallArgumentCount(statement.value),
        );
        break;
      case "var":
        for (const declaration of statement.declarations) {
          if (declaration.value !== null) {
            maximum = Math.max(
              maximum,
              runtimeExpressionMaximumCallArgumentCount(declaration.value),
            );
          }
        }
        break;
      case "if":
        maximum = Math.max(
          maximum,
          runtimeExpressionMaximumCallArgumentCount(statement.condition),
          runtimeStatementsMaximumCallArgumentCount(statement.consequent),
          statement.alternate === null
            ? 0
            : runtimeStatementsMaximumCallArgumentCount(statement.alternate),
        );
        break;
      case "while":
        maximum = Math.max(
          maximum,
          runtimeExpressionMaximumCallArgumentCount(statement.condition),
          runtimeStatementsMaximumCallArgumentCount(statement.body),
          runtimeStatementsMaximumCallArgumentCount(statement.continueBody),
        );
        break;
      case "block":
        maximum = Math.max(
          maximum,
          runtimeStatementsMaximumCallArgumentCount(statement.statements),
        );
        break;
      case "try":
        maximum = Math.max(
          maximum,
          runtimeStatementsMaximumCallArgumentCount(statement.body),
          statement.catchBody === null
            ? 0
            : runtimeStatementsMaximumCallArgumentCount(statement.catchBody),
          statement.finallyBody === null
            ? 0
            : runtimeStatementsMaximumCallArgumentCount(statement.finallyBody),
        );
        break;
      case "break":
      case "continue":
        break;
    }
  }
  return maximum;
}

function runtimeExpressionMaximumCallArgumentCount(expression: JavaScriptAotExpression): number {
  switch (expression.kind) {
    case "function":
      return runtimeStatementsMaximumCallArgumentCount(expression.body);
    case "array":
      return Math.max(0, ...expression.values.map(runtimeExpressionMaximumCallArgumentCount));
    case "object":
      return Math.max(
        0,
        ...expression.properties.map((property) =>
          runtimeExpressionMaximumCallArgumentCount(property.value)
        ),
      );
    case "unary":
    case "property":
      return runtimeExpressionMaximumCallArgumentCount(expression.value);
    case "binary":
      return Math.max(
        runtimeExpressionMaximumCallArgumentCount(expression.left),
        runtimeExpressionMaximumCallArgumentCount(expression.right),
      );
    case "conditional":
      return Math.max(
        runtimeExpressionMaximumCallArgumentCount(expression.condition),
        runtimeExpressionMaximumCallArgumentCount(expression.consequent),
        runtimeExpressionMaximumCallArgumentCount(expression.alternate),
      );
    case "call":
      return Math.max(
        expression.arguments.length,
        runtimeExpressionMaximumCallArgumentCount(expression.callee),
        ...expression.arguments.map(runtimeExpressionMaximumCallArgumentCount),
      );
    case "new":
      return Math.max(
        expression.arguments.length,
        ...expression.arguments.map(runtimeExpressionMaximumCallArgumentCount),
      );
    case "index":
      return Math.max(
        runtimeExpressionMaximumCallArgumentCount(expression.value),
        runtimeExpressionMaximumCallArgumentCount(expression.index),
      );
    default:
      return 0;
  }
}

function runtimeStatementsReadProperty(
  statements: readonly JavaScriptAotStatement[],
  propertyName: string,
): boolean {
  return statements.some((statement): boolean => {
    switch (statement.kind) {
      case "function-declaration":
        return runtimeStatementsReadProperty(statement.body, propertyName) ||
          (statement.classMethods ?? []).some((method) =>
            runtimeExpressionReadsProperty(method.value, propertyName)
          );
      case "break":
      case "continue":
        return false;
      case "constant":
      case "mutable":
      case "return":
      case "throw":
      case "expression":
        return runtimeExpressionReadsProperty(statement.value, propertyName);
      case "assignment":
        return runtimeExpressionReadsProperty(statement.value, propertyName);
      case "property-assignment":
        return runtimeExpressionReadsProperty(statement.target, propertyName) ||
          runtimeExpressionReadsProperty(statement.value, propertyName);
      case "var":
        return statement.declarations.some((declaration) =>
          declaration.value !== null &&
          runtimeExpressionReadsProperty(declaration.value, propertyName)
        );
      case "if":
        return runtimeExpressionReadsProperty(statement.condition, propertyName) ||
          runtimeStatementsReadProperty(statement.consequent, propertyName) ||
          statement.alternate !== null &&
            runtimeStatementsReadProperty(statement.alternate, propertyName);
      case "while":
        return runtimeExpressionReadsProperty(statement.condition, propertyName) ||
          runtimeStatementsReadProperty(statement.body, propertyName) ||
          runtimeStatementsReadProperty(statement.continueBody, propertyName);
      case "block":
        return runtimeStatementsReadProperty(statement.statements, propertyName);
      case "try":
        return runtimeStatementsReadProperty(statement.body, propertyName) ||
          statement.catchBody !== null &&
            runtimeStatementsReadProperty(statement.catchBody, propertyName) ||
          statement.finallyBody !== null &&
            runtimeStatementsReadProperty(statement.finallyBody, propertyName);
    }
  });
}

function runtimeExpressionReadsProperty(
  expression: JavaScriptAotExpression,
  propertyName: string,
): boolean {
  if (expression.kind === "property" && expression.name === propertyName) return true;
  if (
    expression.kind === "index" && expression.index.kind === "string" &&
    expression.index.value === propertyName
  ) return true;
  switch (expression.kind) {
    case "function":
      return runtimeStatementsReadProperty(expression.body, propertyName);
    case "array":
      return expression.values.some((value) => runtimeExpressionReadsProperty(value, propertyName));
    case "object":
      return expression.properties.some((property) =>
        runtimeExpressionReadsProperty(property.value, propertyName)
      );
    case "unary":
    case "property":
      return runtimeExpressionReadsProperty(expression.value, propertyName);
    case "binary":
      return runtimeExpressionReadsProperty(expression.left, propertyName) ||
        runtimeExpressionReadsProperty(expression.right, propertyName);
    case "conditional":
      return runtimeExpressionReadsProperty(expression.condition, propertyName) ||
        runtimeExpressionReadsProperty(expression.consequent, propertyName) ||
        runtimeExpressionReadsProperty(expression.alternate, propertyName);
    case "call":
      return runtimeExpressionReadsProperty(expression.callee, propertyName) ||
        expression.arguments.some((argument) =>
          runtimeExpressionReadsProperty(argument, propertyName)
        );
    case "new":
      return expression.arguments.some((argument) =>
        runtimeExpressionReadsProperty(argument, propertyName)
      );
    case "index":
      return runtimeExpressionReadsProperty(expression.value, propertyName) ||
        runtimeExpressionReadsProperty(expression.index, propertyName);
    default:
      return false;
  }
}

function runtimeStatementsNeedSharedCallDispatcher(
  statements: readonly JavaScriptAotStatement[],
): boolean {
  return statements.some((statement): boolean => {
    switch (statement.kind) {
      case "function-declaration":
        return runtimeStatementsNeedSharedCallDispatcher(statement.body) ||
          (statement.classMethods ?? []).some((method) =>
            runtimeExpressionNeedsSharedCallDispatcher(method.value)
          );
      case "break":
      case "continue":
        return false;
      case "constant":
      case "mutable":
      case "return":
      case "throw":
      case "expression":
        return runtimeExpressionNeedsSharedCallDispatcher(statement.value);
      case "assignment":
        return runtimeExpressionNeedsSharedCallDispatcher(statement.value);
      case "property-assignment":
        return runtimeExpressionNeedsSharedCallDispatcher(statement.target) ||
          runtimeExpressionNeedsSharedCallDispatcher(statement.value);
      case "var":
        return statement.declarations.some((declaration) =>
          declaration.value !== null &&
          runtimeExpressionNeedsSharedCallDispatcher(declaration.value)
        );
      case "if":
        return runtimeExpressionNeedsSharedCallDispatcher(statement.condition) ||
          runtimeStatementsNeedSharedCallDispatcher(statement.consequent) ||
          statement.alternate !== null &&
            runtimeStatementsNeedSharedCallDispatcher(statement.alternate);
      case "while":
        return runtimeExpressionNeedsSharedCallDispatcher(statement.condition) ||
          runtimeStatementsNeedSharedCallDispatcher(statement.body) ||
          runtimeStatementsNeedSharedCallDispatcher(statement.continueBody);
      case "block":
        return runtimeStatementsNeedSharedCallDispatcher(statement.statements);
      case "try":
        return runtimeStatementsNeedSharedCallDispatcher(statement.body) ||
          statement.catchBody !== null &&
            runtimeStatementsNeedSharedCallDispatcher(statement.catchBody) ||
          statement.finallyBody !== null &&
            runtimeStatementsNeedSharedCallDispatcher(statement.finallyBody);
    }
  });
}

function runtimeExpressionNeedsSharedCallDispatcher(
  expression: JavaScriptAotExpression,
): boolean {
  if (
    expression.kind === "unary" &&
    (expression.operator === "+" || expression.operator === "-") &&
    (expression.value.kind === "property" || expression.value.kind === "index")
  ) return true;
  switch (expression.kind) {
    case "function":
      return runtimeStatementsNeedSharedCallDispatcher(expression.body);
    case "array":
      return expression.values.some(runtimeExpressionNeedsSharedCallDispatcher);
    case "object":
      return expression.properties.some((property) =>
        property.name === "valueOf" || property.name === "toString" ||
        runtimeExpressionNeedsSharedCallDispatcher(property.value)
      );
    case "unary":
    case "property":
      return runtimeExpressionNeedsSharedCallDispatcher(expression.value);
    case "binary":
      return runtimeExpressionNeedsSharedCallDispatcher(expression.left) ||
        runtimeExpressionNeedsSharedCallDispatcher(expression.right);
    case "conditional":
      return runtimeExpressionNeedsSharedCallDispatcher(expression.condition) ||
        runtimeExpressionNeedsSharedCallDispatcher(expression.consequent) ||
        runtimeExpressionNeedsSharedCallDispatcher(expression.alternate);
    case "call":
      return runtimeExpressionNeedsSharedCallDispatcher(expression.callee) ||
        expression.arguments.some(runtimeExpressionNeedsSharedCallDispatcher);
    case "new":
      return expression.arguments.some(runtimeExpressionNeedsSharedCallDispatcher);
    case "index":
      return runtimeExpressionNeedsSharedCallDispatcher(expression.value) ||
        runtimeExpressionNeedsSharedCallDispatcher(expression.index);
    default:
      return false;
  }
}

function runtimeFunctionType(
  argumentCount: number,
  span: JavaScriptAotExpression["span"],
): FunctionalSourceType {
  const named = (name: string): FunctionalTypeSchema => ({ kind: "named", name, arguments: [] });
  return curriedRuntimeType([
    named(Runtime.JAVASCRIPT_HEAP_TYPE),
    named(Runtime.JAVASCRIPT_REALM_TYPE),
    named(Runtime.JAVASCRIPT_ENVIRONMENT_TYPE),
    named(Runtime.JAVASCRIPT_BINDING_STORE_TYPE),
    named(Runtime.JAVASCRIPT_VALUE_TYPE),
    named(Runtime.JAVASCRIPT_VALUE_TYPE),
    { kind: "integer" },
    ...Array.from({ length: argumentCount }, () => named(Runtime.JAVASCRIPT_VALUE_TYPE)),
  ], span);
}

function runtimeDispatcherType(
  argumentCount: number,
  span: JavaScriptAotExpression["span"],
): FunctionalSourceType {
  const functionType = runtimeFunctionType(argumentCount, span);
  const { startByte: _startByte, endByte: _endByte, ...result } = functionType;
  return {
    kind: "function",
    parameter: { kind: "integer" },
    result,
    startByte: span.startByte,
    endByte: span.endByte,
  };
}

function curriedRuntimeType(
  parameters: readonly FunctionalTypeSchema[],
  span: JavaScriptAotExpression["span"],
): FunctionalSourceType {
  let type: FunctionalTypeSchema = {
    kind: "named",
    name: Runtime.JAVASCRIPT_COMPLETION_TYPE,
    arguments: [],
  };
  for (let index = parameters.length - 1; index >= 0; index--) {
    type = { kind: "function", parameter: parameters[index]!, result: type };
  }
  return { ...type, startByte: span.startByte, endByte: span.endByte };
}

function firstRuntimeUnresolvedName(
  entry: JavaScriptAotFunctionDeclaration,
): { readonly name: string; readonly span: JavaScriptAotExpression["span"] } | null {
  const runtimeGlobals = new Set(["undefined", "NaN", "Infinity", "this"]);
  let unresolved: { readonly name: string; readonly span: JavaScriptAotExpression["span"] } | null =
    null;
  const visitExpression = (
    expression: JavaScriptAotExpression,
    names: ReadonlySet<string>,
  ): void => {
    if (unresolved !== null) return;
    switch (expression.kind) {
      case "name":
        if (!names.has(expression.name) && !runtimeGlobals.has(expression.name)) {
          unresolved = { name: expression.name, span: expression.span };
        }
        return;
      case "array":
        for (const value of expression.values) visitExpression(value, names);
        return;
      case "object":
        for (const property of expression.properties) visitExpression(property.value, names);
        return;
      case "function": {
        const functionNames = declaredRuntimeNames(expression.body, names);
        functionNames.add("arguments");
        for (const parameter of expression.parameters) functionNames.add(parameter);
        if (expression.name !== null) functionNames.add(expression.name);
        visitStatements(expression.body, functionNames);
        return;
      }
      case "unary":
      case "property":
        visitExpression(expression.value, names);
        return;
      case "binary":
        visitExpression(expression.left, names);
        if (
          expression.operator !== "instanceof" || expression.right.kind !== "name" ||
          !JAVASCRIPT_RUNTIME_ERROR_CONSTRUCTORS.has(expression.right.name)
        ) {
          visitExpression(expression.right, names);
        }
        return;
      case "conditional":
        visitExpression(expression.condition, names);
        visitExpression(expression.consequent, names);
        visitExpression(expression.alternate, names);
        return;
      case "call":
        if (!isRuntimeDefinePropertyCall(expression)) {
          visitExpression(expression.callee, names);
        }
        for (const argument of expression.arguments) visitExpression(argument, names);
        return;
      case "new":
        for (const argument of expression.arguments) visitExpression(argument, names);
        return;
      case "index":
        visitExpression(expression.value, names);
        visitExpression(expression.index, names);
        return;
      default:
        return;
    }
  };
  const visitStatements = (
    statements: readonly JavaScriptAotStatement[],
    outerNames: ReadonlySet<string>,
  ): void => {
    const names = declaredRuntimeNames(statements, outerNames);
    for (const statement of statements) {
      if (unresolved !== null) return;
      switch (statement.kind) {
        case "function-declaration": {
          const functionNames = declaredRuntimeNames(statement.body, names);
          functionNames.add(statement.name);
          functionNames.add("arguments");
          for (const parameter of statement.parameters) functionNames.add(parameter);
          visitStatements(statement.body, functionNames);
          for (const method of statement.classMethods ?? []) {
            visitExpression(method.value, names);
          }
          break;
        }
        case "constant":
        case "mutable":
        case "return":
        case "throw":
        case "expression":
          visitExpression(statement.value, names);
          break;
        case "assignment":
          if (!names.has(statement.name)) {
            unresolved = { name: statement.name, span: statement.span };
            return;
          }
          visitExpression(statement.value, names);
          break;
        case "property-assignment":
          visitExpression(statement.target, names);
          visitExpression(statement.value, names);
          break;
        case "var":
          for (const declaration of statement.declarations) {
            if (declaration.value !== null) visitExpression(declaration.value, names);
          }
          break;
        case "if":
          visitExpression(statement.condition, names);
          visitStatements(statement.consequent, names);
          if (statement.alternate !== null) visitStatements(statement.alternate, names);
          break;
        case "while":
          visitExpression(statement.condition, names);
          visitStatements(statement.body, names);
          visitStatements(statement.continueBody, names);
          break;
        case "block":
          visitStatements(statement.statements, names);
          break;
        case "try":
          visitStatements(statement.body, names);
          if (statement.catchBody !== null) {
            const catchNames = new Set(names);
            if (statement.catchName !== null) catchNames.add(statement.catchName);
            visitStatements(statement.catchBody, catchNames);
          }
          if (statement.finallyBody !== null) visitStatements(statement.finallyBody, names);
          break;
        case "break":
        case "continue":
          break;
      }
    }
  };
  const entryNames = declaredRuntimeNames(entry.body, new Set(entry.parameters));
  visitStatements(entry.body, entryNames);
  return unresolved;
}

function isRuntimeDefinePropertyCall(
  expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
): boolean {
  return expression.callee.kind === "property" &&
    expression.callee.value.kind === "name" &&
    expression.callee.value.name === "Object" &&
    expression.callee.name === "defineProperty";
}

function declaredRuntimeNames(
  statements: readonly JavaScriptAotStatement[],
  outerNames: ReadonlySet<string>,
): Set<string> {
  const names = new Set(outerNames);
  for (const declaration of runtimeVarDeclarations(statements)) names.add(declaration.name);
  for (const statement of statements) {
    if (
      statement.kind === "constant" || statement.kind === "mutable" ||
      statement.kind === "function-declaration"
    ) names.add(statement.name);
  }
  return names;
}

function runtimeVarDeclarations(
  statements: readonly JavaScriptAotStatement[],
): readonly Extract<JavaScriptAotStatement, { readonly kind: "var" }>["declarations"][number][] {
  const declarations: Extract<JavaScriptAotStatement, {
    readonly kind: "var";
  }>["declarations"][number][] = [];
  const visit = (nested: readonly JavaScriptAotStatement[]): void => {
    for (const statement of nested) {
      if (statement.kind === "var") {
        declarations.push(...statement.declarations);
        continue;
      }
      if (statement.kind === "block") visit(statement.statements);
      if (statement.kind === "if") {
        visit(statement.consequent);
        if (statement.alternate !== null) visit(statement.alternate);
      }
      if (statement.kind === "while") {
        visit(statement.body);
        visit(statement.continueBody);
      }
      if (statement.kind === "try") {
        visit(statement.body);
        if (statement.catchBody !== null) visit(statement.catchBody);
        if (statement.finallyBody !== null) visit(statement.finallyBody);
      }
    }
  };
  visit(statements);
  return declarations;
}

function runtimeEntryResultKind(
  entry: JavaScriptAotFunctionDeclaration,
): RuntimeEntryResultKind {
  const bindingKinds = new Map<string, RuntimeEntryResultKind>();
  const returns: JavaScriptAotExpression[] = [];
  const visitStatements = (statements: readonly JavaScriptAotStatement[]): void => {
    for (const statement of statements) {
      if (statement.kind === "constant" || statement.kind === "mutable") {
        const kind = runtimeExpressionResultKind(statement.value, bindingKinds);
        if (kind !== null && kind !== "never") bindingKinds.set(statement.name, kind);
        continue;
      }
      if (statement.kind === "return") {
        returns.push(statement.value);
        continue;
      }
      if (statement.kind === "block") visitStatements(statement.statements);
      if (statement.kind === "if") {
        visitStatements(statement.consequent);
        if (statement.alternate !== null) visitStatements(statement.alternate);
      }
      if (statement.kind === "try") {
        visitStatements(statement.body);
        if (statement.catchBody !== null) visitStatements(statement.catchBody);
        if (statement.finallyBody !== null) visitStatements(statement.finallyBody);
      }
    }
  };
  visitStatements(entry.body);
  if (returns.length === 0) {
    throw new JavaScriptAotLoweringError(
      entry.span,
      "JavaScript runtime-model entry must return a boolean, number, or string.",
    );
  }
  const resultKinds = returns.map((expression) =>
    runtimeExpressionResultKind(expression, bindingKinds)
  );
  const resultKind = resultKinds.find((kind): kind is RuntimeEntryResultKind =>
    kind !== null && kind !== "never"
  );
  if (resultKind === undefined) {
    throw new JavaScriptAotLoweringError(
      returns[0]!.span,
      "JavaScript runtime-model entry result must currently resolve to a boolean, number, or string.",
    );
  }
  for (let index = 0; index < returns.length; index++) {
    const expressionKind = resultKinds[index];
    if (expressionKind !== "never" && expressionKind !== resultKind) {
      throw new JavaScriptAotLoweringError(
        returns[index]!.span,
        `JavaScript runtime-model entry mixes ${resultKind} with a different result representation.`,
      );
    }
  }
  return resultKind;
}

function statementsUseStrictMode(statements: readonly JavaScriptAotStatement[]): boolean {
  for (const statement of statements) {
    if (statement.kind !== "expression" || statement.value.kind !== "string") return false;
    if (statement.value.raw === '"use strict"' || statement.value.raw === "'use strict'") {
      return true;
    }
  }
  return false;
}

function runtimeExpressionResultKind(
  expression: JavaScriptAotExpression,
  bindingKinds: ReadonlyMap<string, RuntimeEntryResultKind>,
): RuntimeExpressionResultKind | null {
  switch (expression.kind) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "name":
      if (expression.name === "NaN" || expression.name === "Infinity") return "number";
      return bindingKinds.get(expression.name) ?? null;
    case "unary":
      if (expression.operator === "!") return "boolean";
      if (expression.operator === "typeof") return "string";
      return expression.operator === "+" || expression.operator === "-" ||
          expression.operator === "~"
        ? "number"
        : null;
    case "binary":
      if (
        expression.operator === "===" || expression.operator === "!==" ||
        expression.operator === "==" || expression.operator === "!=" ||
        expression.operator === "<" || expression.operator === "<=" ||
        expression.operator === ">" || expression.operator === ">=" ||
        expression.operator === "instanceof" || expression.operator === "same-value" ||
        expression.operator === "not-same-value"
      ) return "boolean";
      if (expression.operator === "&&" || expression.operator === "||") {
        const leftKind = runtimeExpressionResultKind(expression.left, bindingKinds);
        return leftKind === runtimeExpressionResultKind(expression.right, bindingKinds)
          ? leftKind
          : null;
      }
      return "number";
    case "conditional": {
      const consequentKind = runtimeExpressionResultKind(expression.consequent, bindingKinds);
      return consequentKind === runtimeExpressionResultKind(expression.alternate, bindingKinds)
        ? consequentKind
        : null;
    }
    case "call": {
      if (expression.callee.kind !== "function") return null;
      const returns: JavaScriptAotExpression[] = [];
      let throws = false;
      const pending = [...expression.callee.body];
      while (pending.length !== 0) {
        const statement = pending.pop()!;
        switch (statement.kind) {
          case "return":
            returns.push(statement.value);
            break;
          case "throw":
            throws = true;
            break;
          case "block":
            pending.push(...statement.statements);
            break;
          case "if":
            pending.push(...statement.consequent);
            if (statement.alternate !== null) pending.push(...statement.alternate);
            break;
          case "while":
            pending.push(...statement.body, ...statement.continueBody);
            break;
          case "try":
            pending.push(...statement.body);
            if (statement.catchBody !== null) pending.push(...statement.catchBody);
            if (statement.finallyBody !== null) pending.push(...statement.finallyBody);
            break;
          case "function-declaration":
          case "break":
          case "continue":
          case "constant":
          case "mutable":
          case "var":
          case "assignment":
          case "property-assignment":
          case "expression":
            break;
        }
      }
      if (returns.length === 0) return throws ? "never" : null;
      const returnKinds = returns.map((value) => runtimeExpressionResultKind(value, bindingKinds));
      const returnKind = returnKinds.find((kind) => kind !== null && kind !== "never");
      return returnKind !== undefined &&
          returnKinds.every((kind) => kind === returnKind || kind === "never")
        ? returnKind
        : null;
    }
    default:
      return null;
  }
}

function expressionRequiresRuntimeModel(expression: JavaScriptAotExpression): boolean {
  if (expression.kind === "name" && expression.name === "this") return true;
  if (expression.kind === "name" && expression.name === "arguments") return true;
  if (expression.kind === "call" && isRuntimeDefinePropertyCall(expression)) return true;
  if (
    expression.kind === "binary" &&
    (expression.operator === "instanceof" || expression.operator === "same-value" ||
      expression.operator === "not-same-value")
  ) return true;
  if (
    expression.kind === "binary" &&
    (expression.operator === "===" || expression.operator === "!==" ||
      expression.operator === "same-value" || expression.operator === "not-same-value") &&
    (expression.left.kind === "object" || expression.right.kind === "object" ||
      expression.left.kind === "function" || expression.right.kind === "function")
  ) return true;
  switch (expression.kind) {
    case "array":
      return expression.values.some(expressionRequiresRuntimeModel);
    case "object":
      return expression.properties.some((property) =>
        property.value.kind === "function" || expressionRequiresRuntimeModel(property.value)
      );
    case "function":
      return runtimeStatementsContainThrow(expression.body) ||
        runtimeStatementsRequireModel(expression.body);
    case "unary":
      return expressionRequiresRuntimeModel(expression.value);
    case "binary":
      return expressionRequiresRuntimeModel(expression.left) ||
        expressionRequiresRuntimeModel(expression.right);
    case "conditional":
      return expressionRequiresRuntimeModel(expression.condition) ||
        expressionRequiresRuntimeModel(expression.consequent) ||
        expressionRequiresRuntimeModel(expression.alternate);
    case "call":
      return expressionRequiresRuntimeModel(expression.callee) ||
        expression.arguments.some(expressionRequiresRuntimeModel);
    case "new":
      return expression.arguments.some(expressionRequiresRuntimeModel);
    case "property":
      return expressionRequiresRuntimeModel(expression.value);
    case "index":
      return expressionRequiresRuntimeModel(expression.value) ||
        expressionRequiresRuntimeModel(expression.index);
    default:
      return false;
  }
}

function literalPropertyName(expression: JavaScriptAotExpression): string | null {
  return expression.kind === "string" || expression.kind === "number"
    ? String(expression.value)
    : null;
}

function statementRequiresRuntimeModel(statement: JavaScriptAotStatement): boolean {
  switch (statement.kind) {
    case "function-declaration":
      return statement.requiresRuntimeModel === true ||
        statement.classMethods !== undefined ||
        runtimeStatementsRequireModel(statement.body);
    case "constant":
    case "mutable":
      return runtimeExpressionReferencesName(statement.value, statement.name) ||
        expressionRequiresRuntimeModel(statement.value);
    case "assignment":
    case "return":
    case "throw":
    case "expression":
      return expressionRequiresRuntimeModel(statement.value);
    case "property-assignment":
      return true;
    case "var":
      return statement.declarations.some((declaration) =>
        declaration.value !== null && expressionRequiresRuntimeModel(declaration.value)
      );
    case "if":
      return expressionRequiresRuntimeModel(statement.condition) ||
        runtimeStatementsRequireModel(statement.consequent) ||
        statement.alternate !== null && runtimeStatementsRequireModel(statement.alternate);
    case "while":
      return expressionRequiresRuntimeModel(statement.condition) ||
        runtimeStatementsRequireModel(statement.body) ||
        runtimeStatementsRequireModel(statement.continueBody);
    case "block":
      return runtimeStatementsRequireModel(statement.statements);
    case "try":
      return runtimeStatementsRequireModel(statement.body) ||
        statement.catchBody !== null && runtimeStatementsRequireModel(statement.catchBody) ||
        statement.finallyBody !== null && runtimeStatementsRequireModel(statement.finallyBody);
    case "break":
    case "continue":
      return false;
  }
}

function runtimeStatementsContainThrow(
  statements: readonly JavaScriptAotStatement[],
): boolean {
  return statements.some((statement): boolean => {
    switch (statement.kind) {
      case "throw":
        return true;
      case "if":
        return runtimeStatementsContainThrow(statement.consequent) ||
          statement.alternate !== null && runtimeStatementsContainThrow(statement.alternate);
      case "while":
        return runtimeStatementsContainThrow(statement.body) ||
          runtimeStatementsContainThrow(statement.continueBody);
      case "block":
        return runtimeStatementsContainThrow(statement.statements);
      case "try":
        return runtimeStatementsContainThrow(statement.body) ||
          statement.catchBody !== null && runtimeStatementsContainThrow(statement.catchBody) ||
          statement.finallyBody !== null && runtimeStatementsContainThrow(statement.finallyBody);
      case "function-declaration":
      case "break":
      case "continue":
      case "constant":
      case "mutable":
      case "var":
      case "assignment":
      case "property-assignment":
      case "return":
      case "expression":
        return false;
    }
  });
}

function runtimeStatementsRequireModel(
  statements: readonly JavaScriptAotStatement[],
): boolean {
  return statements.some(statementRequiresRuntimeModel) ||
    runtimeStatementsReadBeforeLexicalInitialization(statements, new Set());
}

function runtimeStatementsReadBeforeLexicalInitialization(
  statements: readonly JavaScriptAotStatement[],
  outerPendingNames: ReadonlySet<string>,
): boolean {
  const pendingNames = new Set(outerPendingNames);
  for (const statement of statements) {
    if (statement.kind === "constant" || statement.kind === "mutable") {
      pendingNames.add(statement.name);
    }
  }
  for (const statement of statements) {
    if (runtimeStatementReferencesPendingName(statement, pendingNames)) return true;
    if (statement.kind === "constant" || statement.kind === "mutable") {
      pendingNames.delete(statement.name);
    }
  }
  return false;
}

function runtimeStatementReferencesPendingName(
  statement: JavaScriptAotStatement,
  pendingNames: ReadonlySet<string>,
): boolean {
  switch (statement.kind) {
    case "function-declaration":
    case "break":
    case "continue":
      return false;
    case "constant":
    case "mutable":
    case "return":
    case "throw":
    case "expression":
      return runtimeExpressionReferencesPendingName(statement.value, pendingNames);
    case "assignment":
      return pendingNames.has(statement.name) ||
        runtimeExpressionReferencesPendingName(statement.value, pendingNames);
    case "property-assignment":
      return runtimeExpressionReferencesPendingName(statement.target, pendingNames) ||
        runtimeExpressionReferencesPendingName(statement.value, pendingNames);
    case "var":
      return statement.declarations.some((declaration) =>
        declaration.value !== null &&
        runtimeExpressionReferencesPendingName(declaration.value, pendingNames)
      );
    case "if":
      return runtimeExpressionReferencesPendingName(statement.condition, pendingNames) ||
        runtimeStatementsReadBeforeLexicalInitialization(statement.consequent, pendingNames) ||
        statement.alternate !== null &&
          runtimeStatementsReadBeforeLexicalInitialization(statement.alternate, pendingNames);
    case "while":
      return runtimeExpressionReferencesPendingName(statement.condition, pendingNames) ||
        runtimeStatementsReadBeforeLexicalInitialization(statement.body, pendingNames) ||
        runtimeStatementsReadBeforeLexicalInitialization(statement.continueBody, pendingNames);
    case "block":
      return runtimeStatementsReadBeforeLexicalInitialization(statement.statements, pendingNames);
    case "try":
      return runtimeStatementsReadBeforeLexicalInitialization(statement.body, pendingNames) ||
        statement.catchBody !== null &&
          runtimeStatementsReadBeforeLexicalInitialization(statement.catchBody, pendingNames) ||
        statement.finallyBody !== null &&
          runtimeStatementsReadBeforeLexicalInitialization(statement.finallyBody, pendingNames);
  }
}

function runtimeExpressionReferencesPendingName(
  expression: JavaScriptAotExpression,
  pendingNames: ReadonlySet<string>,
): boolean {
  switch (expression.kind) {
    case "name":
      return pendingNames.has(expression.name);
    case "function":
      return false;
    case "array":
      return expression.values.some((value) =>
        runtimeExpressionReferencesPendingName(value, pendingNames)
      );
    case "object":
      return expression.properties.some((property) =>
        runtimeExpressionReferencesPendingName(property.value, pendingNames)
      );
    case "unary":
    case "property":
      return runtimeExpressionReferencesPendingName(expression.value, pendingNames);
    case "binary":
      return runtimeExpressionReferencesPendingName(expression.left, pendingNames) ||
        runtimeExpressionReferencesPendingName(expression.right, pendingNames);
    case "conditional":
      return runtimeExpressionReferencesPendingName(expression.condition, pendingNames) ||
        runtimeExpressionReferencesPendingName(expression.consequent, pendingNames) ||
        runtimeExpressionReferencesPendingName(expression.alternate, pendingNames);
    case "call":
      return runtimeExpressionReferencesPendingName(expression.callee, pendingNames) ||
        expression.arguments.some((argument) =>
          runtimeExpressionReferencesPendingName(argument, pendingNames)
        );
    case "new":
      return expression.arguments.some((argument) =>
        runtimeExpressionReferencesPendingName(argument, pendingNames)
      );
    case "index":
      return runtimeExpressionReferencesPendingName(expression.value, pendingNames) ||
        runtimeExpressionReferencesPendingName(expression.index, pendingNames);
    default:
      return false;
  }
}

function valueCaseArms(
  expectedConstructor: string,
  fieldName: string,
  span: JavaScriptAotExpression["span"],
  onExpected: (field: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
  failureMessage: string,
): readonly FunctionalSurfaceCaseArm[] {
  const constructors = [
    { name: Runtime.JAVASCRIPT_VALUE_UNDEFINED, carriesField: false },
    { name: Runtime.JAVASCRIPT_VALUE_NULL, carriesField: false },
    { name: Runtime.JAVASCRIPT_VALUE_BOOLEAN, carriesField: true },
    { name: Runtime.JAVASCRIPT_VALUE_NUMBER, carriesField: true },
    { name: Runtime.JAVASCRIPT_VALUE_STRING, carriesField: true },
    { name: Runtime.JAVASCRIPT_VALUE_SYMBOL, carriesField: true },
    { name: Runtime.JAVASCRIPT_VALUE_OBJECT, carriesField: true },
  ];
  return constructors.map(({ name, carriesField }) => {
    return {
      constructor: name,
      binders: carriesField ? [fieldName] : [],
      body: name === expectedConstructor
        ? onExpected(reference(fieldName, span))
        : runtimeFault(failureMessage, span),
      span,
    };
  });
}

function primitiveOrObjectValueArms(
  fieldName: string,
  span: JavaScriptAotExpression["span"],
  onPrimitive: (value: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
  onObject: (identity: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
): readonly FunctionalSurfaceCaseArm[] {
  const primitiveConstructors = [
    { name: Runtime.JAVASCRIPT_VALUE_UNDEFINED, carriesField: false },
    { name: Runtime.JAVASCRIPT_VALUE_NULL, carriesField: false },
    { name: Runtime.JAVASCRIPT_VALUE_BOOLEAN, carriesField: true },
    { name: Runtime.JAVASCRIPT_VALUE_NUMBER, carriesField: true },
    { name: Runtime.JAVASCRIPT_VALUE_STRING, carriesField: true },
    { name: Runtime.JAVASCRIPT_VALUE_SYMBOL, carriesField: true },
  ];
  return [
    ...primitiveConstructors.map(({ name, carriesField }) => {
      const binders = carriesField ? [fieldName] : [];
      return {
        constructor: name,
        binders,
        body: onPrimitive(
          carriesField ? call(name, [reference(fieldName, span)], span) : reference(name, span),
        ),
        span,
      };
    }),
    {
      constructor: Runtime.JAVASCRIPT_VALUE_OBJECT,
      binders: [fieldName],
      body: onObject(reference(fieldName, span)),
      span,
    },
  ];
}

function reference(
  name: string,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "name", name, span };
}

function float64(
  value: number,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "float-64", value, span };
}

function integer(
  value: number,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "integer", value, span };
}

function boolean(
  value: boolean,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "boolean", value, span };
}

function text(
  value: string,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "text", value, span };
}

function call(
  calleeName: string,
  arguments_: readonly FunctionalSurfaceExpression[],
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  let expression = reference(calleeName, span);
  for (const argument of arguments_) {
    expression = { kind: "apply", callee: expression, argument, span };
  }
  return expression;
}

function binary(
  operator: FunctionalBinaryOperator,
  left: FunctionalSurfaceExpression,
  right: FunctionalSurfaceExpression,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "binary", operator, left, right, span };
}

function conditional(
  condition: FunctionalSurfaceExpression,
  consequent: FunctionalSurfaceExpression,
  alternate: FunctionalSurfaceExpression,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "if", condition, consequent, alternate, span };
}

function letExpression(
  name: string,
  value: FunctionalSurfaceExpression,
  body: FunctionalSurfaceExpression,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "let", name, value, body, span };
}

function match(
  value: FunctionalSurfaceExpression,
  arms: readonly FunctionalSurfaceCaseArm[],
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "case", value, arms, span };
}

function runtimeFault(
  message: string,
  span: JavaScriptAotExpression["span"],
): FunctionalSurfaceExpression {
  return { kind: "runtime-fault", message, span };
}
