import {
  type EncodedFunctionalModule,
  FunctionalBinaryOperator,
  FunctionalUnaryOperator,
} from "../../../src/functional/abi.ts";
import {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceCaseArm,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
} from "../../../src/functional/surface_builder.ts";
import type {
  JavaScriptAotExpression,
  JavaScriptAotFunctionDeclaration,
  JavaScriptAotModule,
  JavaScriptAotStatement,
} from "./ast.ts";
import { JavaScriptAotLoweringError } from "./diagnostic.ts";
import {
  JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT,
  JAVASCRIPT_RUNTIME_DEFINE_BINDING,
  JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED,
  JAVASCRIPT_RUNTIME_EMPTY_STATE,
  JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE,
  JAVASCRIPT_RUNTIME_GLOBAL_OBJECT,
  JAVASCRIPT_RUNTIME_INITIALIZE_BINDING,
  JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT,
  JAVASCRIPT_RUNTIME_LOOKUP_BINDING,
  JAVASCRIPT_RUNTIME_OBJECT_KIND,
  JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE,
  JAVASCRIPT_RUNTIME_REALM,
  JAVASCRIPT_RUNTIME_SAME_VALUE,
  JAVASCRIPT_RUNTIME_SET_BINDING,
  JAVASCRIPT_RUNTIME_STRICT_EQUAL,
  JAVASCRIPT_RUNTIME_THIS_VALUE,
  JAVASCRIPT_RUNTIME_TO_BOOLEAN,
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
}

type RuntimeExpressionContinuation = (
  state: FunctionalSurfaceExpression,
  value: FunctionalSurfaceExpression,
) => FunctionalSurfaceExpression;

type RuntimeStatementContinuation = (
  state: FunctionalSurfaceExpression,
) => FunctionalSurfaceExpression;

type RuntimeEntryResultKind = "boolean" | "number" | "string";

interface RuntimeFunction {
  readonly id: number;
  readonly name: string;
  readonly thisMode: "dynamic" | "lexical";
  readonly parameters: readonly string[];
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
export function requiresJavaScriptRuntimeModel(sourceModule: JavaScriptAotModule): boolean {
  return sourceModule.declarations.some((declaration) =>
    declaration.kind === "constant"
      ? expressionRequiresRuntimeModel(declaration.value)
      : declaration.body.some(statementRequiresRuntimeModel)
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

class JavaScriptRuntimeLowering {
  #bindingIndex = 0;
  readonly #functions: RuntimeFunction[] = [];
  readonly #functionsBySyntax = new WeakMap<RuntimeFunctionSyntax, RuntimeFunction>();

  constructor(
    private readonly sourceModule: JavaScriptAotModule,
    private readonly entryName: string,
    private readonly options: JavaScriptRuntimeLoweringOptions,
  ) {}

  lower(): LoweredJavaScriptRuntimeModule {
    const entry = this.requireEntry();
    const unresolvedName = firstRuntimeUnresolvedName(entry);
    if (unresolvedName !== null) {
      throw new JavaScriptAotLoweringError(
        unresolvedName.span,
        `JavaScript runtime-model name ${JSON.stringify(unresolvedName.name)} is not declared.`,
      );
    }
    this.prepareRuntimeFunctions(entry.body);
    const entryResultKind = runtimeEntryResultKind(entry);
    const runtime = javascriptRuntimeSurface(this.sourceModule.span.endByte);
    const emptyState = reference(JAVASCRIPT_RUNTIME_EMPTY_STATE, entry.span);
    const initialState = this.extendFunctionStateWithDeclarations(
      (this.options.callThisMode ?? "strict") === "sloppy"
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
    const definitions = [entryDefinition, ...functionDefinitions, ...runtime.definitions];
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
    const argumentNames = runtimeFunction.parameters.map(() => this.freshName("argument"));
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
        ...argumentNames,
      ],
      annotation: null,
      body: this.initializeHoistedFunctions(
        runtimeFunction.body,
        0,
        state,
        (readyState) => this.lowerStatements(runtimeFunction.body, 0, readyState),
      ),
      span: runtimeFunction.span,
    };
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
    const additionalDeclarations = this.sourceModule.declarations.filter((declaration) =>
      declaration !== entry
    );
    if (additionalDeclarations.length !== 0) {
      throw new JavaScriptAotLoweringError(
        additionalDeclarations[0]!.span,
        "JavaScript runtime-model lowering does not yet link additional top-level declarations.",
      );
    }
    return entry;
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
    if (statement.kind !== "function-declaration") {
      return this.initializeHoistedFunctions(statements, index + 1, state, onReady);
    }
    const runtimeFunction = this.registerRuntimeFunction(
      statement,
      statement.parameters,
      statement.body,
      statement.span,
      "dynamic",
    );
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
    return this.lowerStatement(
      statement,
      state,
      (nextState) => this.lowerStatements(statements, index + 1, nextState),
    );
  }

  private lowerStatement(
    statement: JavaScriptAotStatement,
    state: FunctionalSurfaceExpression,
    onNormal: RuntimeStatementContinuation,
  ): FunctionalSurfaceExpression {
    switch (statement.kind) {
      case "function-declaration":
        return onNormal(state);
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
      : statement.target.index.kind === "string"
      ? statement.target.index.value
      : null;
    if (propertyName === null) {
      throw new JavaScriptAotLoweringError(
        statement.target.span,
        "JavaScript runtime-model computed assignment currently requires a string literal key.",
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
              return letExpression(
                stateName,
                valueState,
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
                    body: onNormal(reference(updatedStateName, statement.span)),
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
                        onNormal(completedState),
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
      case "object":
        return this.lowerObject(expression, state, onValue);
      case "function":
        return this.lowerFunctionValue(expression, state, onValue);
      case "call":
        return this.lowerCall(expression, state, onValue);
      case "new": {
        const faultMessage = this.options.runtimeFaultConstructors?.get(expression.constructor);
        if (faultMessage === undefined) {
          throw new JavaScriptAotLoweringError(
            expression.span,
            `JavaScript runtime-model construction with new ${expression.constructor} is not supported.`,
          );
        }
        return this.lowerArguments(
          expression.arguments,
          0,
          state,
          [],
          () => runtimeFault(faultMessage, expression.span),
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
        if (expression.index.kind !== "string") {
          throw new JavaScriptAotLoweringError(
            expression.index.span,
            "JavaScript runtime-model computed properties currently require a string literal key.",
          );
        }
        const propertyName = expression.index.value;
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
      default:
        throw new JavaScriptAotLoweringError(
          expression.span,
          `JavaScript ${expression.kind} expression is not yet supported by runtime-model lowering.`,
        );
    }
  }

  private lowerFunctionValue(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "function" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    const runtimeFunction = this.registerRuntimeFunction(
      expression,
      expression.parameters,
      expression.body,
      expression.span,
      expression.thisMode,
    );
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
      parameters,
      body,
      span,
    };
    this.#functions.push(runtimeFunction);
    this.#functionsBySyntax.set(syntax, runtimeFunction);
    return runtimeFunction;
  }

  private prepareRuntimeFunctions(statements: readonly JavaScriptAotStatement[]): void {
    const visitExpression = (expression: JavaScriptAotExpression): void => {
      switch (expression.kind) {
        case "array":
          for (const value of expression.values) visitExpression(value);
          return;
        case "object":
          for (const property of expression.properties) visitExpression(property.value);
          return;
        case "function":
          this.registerRuntimeFunction(
            expression,
            expression.parameters,
            expression.body,
            expression.span,
            expression.thisMode,
          );
          visitStatements(expression.body);
          return;
        case "unary":
        case "property":
          visitExpression(expression.value);
          return;
        case "binary":
          visitExpression(expression.left);
          visitExpression(expression.right);
          return;
        case "conditional":
          visitExpression(expression.condition);
          visitExpression(expression.consequent);
          visitExpression(expression.alternate);
          return;
        case "call":
          visitExpression(expression.callee);
          for (const argument of expression.arguments) visitExpression(argument);
          return;
        case "new":
          for (const argument of expression.arguments) visitExpression(argument);
          return;
        case "index":
          visitExpression(expression.value);
          visitExpression(expression.index);
          return;
        default:
          return;
      }
    };
    const visitStatements = (nested: readonly JavaScriptAotStatement[]): void => {
      for (const statement of nested) {
        switch (statement.kind) {
          case "function-declaration":
            this.registerRuntimeFunction(
              statement,
              statement.parameters,
              statement.body,
              statement.span,
              "dynamic",
            );
            visitStatements(statement.body);
            break;
          case "constant":
          case "mutable":
          case "assignment":
          case "return":
          case "throw":
          case "expression":
            visitExpression(statement.value);
            break;
          case "property-assignment":
            visitExpression(statement.target);
            visitExpression(statement.value);
            break;
          case "var":
            for (const declaration of statement.declarations) {
              if (declaration.value !== null) visitExpression(declaration.value);
            }
            break;
          case "if":
            visitExpression(statement.condition);
            visitStatements(statement.consequent);
            if (statement.alternate !== null) visitStatements(statement.alternate);
            break;
          case "while":
            visitExpression(statement.condition);
            visitStatements(statement.body);
            visitStatements(statement.continueBody);
            break;
          case "block":
            visitStatements(statement.statements);
            break;
          case "try":
            visitStatements(statement.body);
            if (statement.catchBody !== null) visitStatements(statement.catchBody);
            if (statement.finallyBody !== null) visitStatements(statement.finallyBody);
            break;
          case "break":
          case "continue":
            break;
        }
      }
    };
    visitStatements(statements);
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

  private lowerCall(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
    if (isRuntimeDefinePropertyCall(expression)) {
      return this.lowerDefinePropertyCall(expression, state, onValue);
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
      if (callee.index.kind !== "string") {
        throw new JavaScriptAotLoweringError(
          callee.index.span,
          "JavaScript runtime-model computed method calls currently require a string literal key.",
        );
      }
      const propertyName = callee.index.value;
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
      (calleeState, callee) => {
        if ((this.options.callThisMode ?? "strict") === "strict") {
          return this.lowerCallArguments(
            expression,
            calleeState,
            callee,
            reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, expression.span),
            onValue,
          );
        }
        const stateName = this.freshName("sloppyCallState");
        return letExpression(
          stateName,
          calleeState,
          this.lowerCallArguments(
            expression,
            reference(stateName, expression.span),
            callee,
            call(JAVASCRIPT_RUNTIME_GLOBAL_OBJECT, [
              reference(stateName, expression.span),
            ], expression.span),
            onValue,
          ),
          expression.span,
        );
      },
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
          const continueWithAccessor = this.lowerAccessorDescriptor(
            properties,
            index + 1,
            nextState,
            nextDescriptor,
            onDescriptor,
          );
          const invalidAccessor = runtimeFault(
            `JavaScript accessor descriptor ${
              JSON.stringify(property.name)
            } must be callable or undefined`,
            property.value.span,
          );
          return match(value, [{
            constructor: Runtime.JAVASCRIPT_VALUE_UNDEFINED,
            binders: [],
            body: continueWithAccessor,
            span: property.value.span,
          }, {
            constructor: Runtime.JAVASCRIPT_VALUE_OBJECT,
            binders: [this.freshName("accessorIdentity")],
            body: continueWithAccessor,
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
          }], property.value.span);
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
                  body: runtimeFault("JavaScript value is not callable", span),
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

  private dispatchCall(
    target: FunctionalSurfaceExpression,
    heap: FunctionalSurfaceExpression,
    realm: FunctionalSurfaceExpression,
    environment: FunctionalSurfaceExpression,
    bindings: FunctionalSurfaceExpression,
    thisValue: FunctionalSurfaceExpression,
    arguments_: readonly FunctionalSurfaceExpression[],
    span: JavaScriptAotExpression["span"],
  ): FunctionalSurfaceExpression {
    let dispatch = runtimeFault(
      "JavaScript callable target is not registered in this module",
      span,
    );
    for (let index = this.#functions.length - 1; index >= 0; index--) {
      const runtimeFunction = this.#functions[index]!;
      const parameters = runtimeFunction.parameters.map((_, parameterIndex) =>
        arguments_[parameterIndex] ?? reference(Runtime.JAVASCRIPT_VALUE_UNDEFINED, span)
      );
      dispatch = conditional(
        binary(
          FunctionalBinaryOperator.Equal,
          target,
          integer(runtimeFunction.id, span),
          span,
        ),
        call(
          runtimeFunction.name,
          [heap, realm, environment, bindings, thisValue, ...parameters],
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
    const resumeValue = (
      completedStateName: string,
      valueName: string,
    ): FunctionalSurfaceExpression => {
      const heapName = this.freshName("returnedHeap");
      const functionContextName = this.freshName("returnedFunctionContext");
      const bindingsName = this.freshName("returnedBindings");
      return match(reference(completedStateName, span), [{
        constructor: Runtime.JAVASCRIPT_STATE,
        binders: [heapName, functionContextName, bindingsName],
        body: onValue(
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
      body: resumeValue(normalStateName, normalValueName),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_COMPLETION_RETURN,
      binders: [returnStateName, returnValueName],
      body: resumeValue(returnStateName, returnValueName),
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
  }

  private lowerObject(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "object" }>,
    state: FunctionalSurfaceExpression,
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
            reference(Runtime.JAVASCRIPT_VALUE_NULL, expression.span),
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
    return match(
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
              body: onValue(
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
              body: onValue(
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
                onValue,
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
  }

  private lowerUnary(
    expression: Extract<JavaScriptAotExpression, { readonly kind: "unary" }>,
    state: FunctionalSurfaceExpression,
    onValue: RuntimeExpressionContinuation,
  ): FunctionalSurfaceExpression {
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
    const operator = runtimeNumericOperators[expression.operator];
    if (operator === undefined) {
      throw new JavaScriptAotLoweringError(
        expression.span,
        `JavaScript binary ${
          JSON.stringify(expression.operator)
        } is not yet supported by runtime-model lowering.`,
      );
    }
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
                    comparison ? Runtime.JAVASCRIPT_VALUE_BOOLEAN : Runtime.JAVASCRIPT_VALUE_NUMBER,
                    [result],
                    expression.span,
                  ),
                );
              })),
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
          body: runtimeFault(`JavaScript name ${JSON.stringify(name)} is not defined`, span),
          span,
        }, {
          constructor: Runtime.JAVASCRIPT_VALUE_UNINITIALIZED,
          binders: [],
          body: runtimeFault(
            `JavaScript name ${JSON.stringify(name)} was read before initialization`,
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
      body: runtimeFault(`JavaScript name ${JSON.stringify(name)} is not defined`, span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_BINDING_UPDATE_UNINITIALIZED,
      binders: [],
      body: runtimeFault(
        `JavaScript name ${JSON.stringify(name)} was assigned before initialization`,
        span,
      ),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED,
      binders: [],
      body: runtimeFault(`JavaScript name ${JSON.stringify(name)} was initialized twice`, span),
      span,
    }, {
      constructor: Runtime.JAVASCRIPT_BINDING_UPDATE_IMMUTABLE,
      binders: [],
      body: runtimeFault(`JavaScript binding ${JSON.stringify(name)} is immutable`, span),
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
      "JavaScript property receiver is not an object",
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
        visitExpression(expression.right, names);
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
          for (const parameter of statement.parameters) functionNames.add(parameter);
          visitStatements(statement.body, functionNames);
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
        if (kind !== null) bindingKinds.set(statement.name, kind);
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
  const resultKind = runtimeExpressionResultKind(returns[0]!, bindingKinds);
  if (resultKind === null) {
    throw new JavaScriptAotLoweringError(
      returns[0]!.span,
      "JavaScript runtime-model entry result must currently resolve to a boolean, number, or string.",
    );
  }
  for (const expression of returns.slice(1)) {
    if (runtimeExpressionResultKind(expression, bindingKinds) !== resultKind) {
      throw new JavaScriptAotLoweringError(
        expression.span,
        `JavaScript runtime-model entry mixes ${resultKind} with a different result representation.`,
      );
    }
  }
  return resultKind;
}

function runtimeExpressionResultKind(
  expression: JavaScriptAotExpression,
  bindingKinds: ReadonlyMap<string, RuntimeEntryResultKind>,
): RuntimeEntryResultKind | null {
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
    default:
      return null;
  }
}

function expressionRequiresRuntimeModel(expression: JavaScriptAotExpression): boolean {
  if (expression.kind === "name" && expression.name === "this") return true;
  if (expression.kind === "call" && isRuntimeDefinePropertyCall(expression)) return true;
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
        expressionRequiresRuntimeModel(property.value)
      );
    case "function":
      return expression.body.some(statementRequiresRuntimeModel);
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

function statementRequiresRuntimeModel(statement: JavaScriptAotStatement): boolean {
  switch (statement.kind) {
    case "function-declaration":
      return statement.body.some(statementRequiresRuntimeModel);
    case "constant":
    case "mutable":
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
        statement.consequent.some(statementRequiresRuntimeModel) ||
        statement.alternate?.some(statementRequiresRuntimeModel) === true;
    case "while":
      return expressionRequiresRuntimeModel(statement.condition) ||
        statement.body.some(statementRequiresRuntimeModel) ||
        statement.continueBody.some(statementRequiresRuntimeModel);
    case "block":
      return statement.statements.some(statementRequiresRuntimeModel);
    case "try":
      return statement.body.some(statementRequiresRuntimeModel) ||
        statement.catchBody?.some(statementRequiresRuntimeModel) === true ||
        statement.finallyBody?.some(statementRequiresRuntimeModel) === true;
    case "break":
    case "continue":
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
