import type {
  JavaScriptAotClassMethod,
  JavaScriptAotDeclaration,
  JavaScriptAotExpression,
  JavaScriptAotModule,
  JavaScriptAotStatement,
} from "./ast.ts";
import {
  type JavaScriptAotDiagnostic,
  JavaScriptAotLoweringError,
  JavaScriptAotSyntaxError,
} from "./diagnostic.ts";
import { type LoweredJavaScriptAotModule, lowerJavaScriptAotModule } from "./lowering.ts";
import { parseJavaScriptAotModule } from "./parser.ts";
import {
  lowerJavaScriptRuntimeModule,
  requiresJavaScriptRuntimeModel,
  validateJavaScriptRuntimeResolution,
} from "./runtime_lowering.ts";
import type { Test262ExecutionMode, Test262Metadata } from "./test262.ts";
import { test262FrontendProbeSource, test262NegativeProbeSource } from "./test262.ts";

const TEST262_FAILURE_CONSTRUCTOR = "$Test262Failure";
const TEST262_ERROR_CONSTRUCTORS = new Set([
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

export type Test262HarnessLoweringResult =
  | { readonly ok: true; readonly lowered: LoweredJavaScriptAotModule }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [JavaScriptAotDiagnostic, ...JavaScriptAotDiagnostic[]];
  };

export type Test262NegativeHarnessResult =
  | { readonly kind: "matched"; readonly phase: "parse" | "resolution" }
  | {
    readonly kind: "runtime-ready";
    readonly expectedType: string;
    readonly validation: "returned-boolean" | "runtime-fault";
    readonly lowered: LoweredJavaScriptAotModule;
  }
  | { readonly kind: "mismatch"; readonly diagnostic: JavaScriptAotDiagnostic };

export type Test262NegativeProbeResult =
  | { readonly kind: "matched"; readonly phase: "parse" | "resolution" }
  | { readonly kind: "runtime-ready"; readonly expectedType: string }
  | { readonly kind: "mismatch"; readonly diagnostic: JavaScriptAotDiagnostic };

export function lowerTest262PositiveTest(
  path: string,
  source: string,
  metadata: Test262Metadata,
  entryName: string,
  mode: Test262ExecutionMode,
): Test262HarnessLoweringResult {
  const probeSource = test262FrontendProbeSource(source, metadata, entryName, mode);
  if (probeSource === null) {
    throw new Error(
      `Test262 negative test ${JSON.stringify(path)} cannot use the positive-test harness.`,
    );
  }

  let sourceModule: JavaScriptAotModule;
  try {
    sourceModule = parseJavaScriptAotModule(path, probeSource);
  } catch (error) {
    if (error instanceof JavaScriptAotSyntaxError) {
      return { ok: false, diagnostics: [diagnostic(path, "parse", "J1001", error)] };
    }
    throw error;
  }

  try {
    const harnessModule = transformModuleAssertions(sourceModule);
    return {
      ok: true,
      lowered: lowerHarnessModule(path, harnessModule, entryName, mode),
    };
  } catch (error) {
    if (error instanceof JavaScriptAotLoweringError) {
      return { ok: false, diagnostics: [diagnostic(path, "lower", "J1002", error)] };
    }
    if (isSurfaceLimitError(error)) {
      return {
        ok: false,
        diagnostics: [surfaceLimitDiagnostic(path, sourceModule.span, error)],
      };
    }
    throw error;
  }
}

export function lowerTest262NegativeTest(
  path: string,
  source: string,
  metadata: Test262Metadata,
  entryName: string,
  mode: Test262ExecutionMode,
): Test262NegativeHarnessResult {
  const expectation = metadata.negative;
  if (expectation === null) {
    throw new Error(`Positive Test262 test ${JSON.stringify(path)} has no negative expectation.`);
  }
  const probeSource = test262NegativeProbeSource(source, metadata, entryName, mode);
  let sourceModule: JavaScriptAotModule;
  try {
    sourceModule = parseJavaScriptAotModule(path, probeSource);
  } catch (error) {
    if (!(error instanceof JavaScriptAotSyntaxError)) throw error;
    if (expectation.phase === "parse" && expectation.type === "SyntaxError") {
      return { kind: "matched", phase: "parse" };
    }
    return {
      kind: "mismatch",
      diagnostic: negativeMismatchDiagnostic(
        path,
        expectation.phase,
        expectation.type,
        "parse",
        "SyntaxError",
        error.span,
      ),
    };
  }

  try {
    if (expectation.phase === "runtime") {
      const harnessModule = transformModuleAssertions(sourceModule);
      if (expectation.type === "ReferenceError") {
        return {
          kind: "runtime-ready",
          expectedType: expectation.type,
          validation: "runtime-fault",
          lowered: lowerHarnessModule(path, harnessModule, entryName, mode, {
            allowUnresolvedReferences: true,
          }),
        };
      }
      if (requiresJavaScriptRuntimeModel(harnessModule)) {
        return {
          kind: "runtime-ready",
          expectedType: expectation.type,
          validation: "runtime-fault",
          lowered: lowerHarnessModule(path, harnessModule, entryName, mode),
        };
      }
      const caughtName = `$Test262RuntimeException${sourceModule.span.startByte}`;
      const lowered = lowerHarnessModule(
        path,
        {
          ...harnessModule,
          declarations: harnessModule.declarations.map((declaration) => {
            if (declaration.kind !== "function" || declaration.name !== entryName) {
              return declaration;
            }
            return {
              ...declaration,
              body: [{
                kind: "try",
                body: declaration.body,
                catchName: caughtName,
                catchBody: [{
                  kind: "return",
                  value: {
                    kind: "binary",
                    operator: "instanceof",
                    left: { kind: "name", name: caughtName, span: declaration.span },
                    right: { kind: "name", name: expectation.type, span: declaration.span },
                    span: declaration.span,
                  },
                  span: declaration.span,
                }],
                finallyBody: null,
                span: declaration.span,
              }, {
                kind: "return",
                value: { kind: "boolean", value: false, span: declaration.span },
                span: declaration.span,
              }],
            };
          }),
        },
        entryName,
        mode,
        { caughtExceptionType: expectation.type },
      );
      return {
        kind: "runtime-ready",
        expectedType: expectation.type,
        validation: "returned-boolean",
        lowered,
      };
    }
    lowerHarnessModule(
      path,
      transformModuleAssertions(sourceModule),
      entryName,
      mode,
    );
    return {
      kind: "mismatch",
      diagnostic: negativeMismatchDiagnostic(
        path,
        expectation.phase,
        expectation.type,
        "runtime",
        "no error",
        sourceModule.span,
      ),
    };
  } catch (error) {
    if (isSurfaceLimitError(error)) {
      return {
        kind: "mismatch",
        diagnostic: surfaceLimitDiagnostic(path, sourceModule.span, error),
      };
    }
    if (!(error instanceof JavaScriptAotLoweringError)) throw error;
    const actualType = resolutionErrorType(error);
    if (expectation.phase === "resolution" && expectation.type === actualType) {
      return { kind: "matched", phase: "resolution" };
    }
    return {
      kind: "mismatch",
      diagnostic: negativeMismatchDiagnostic(
        path,
        expectation.phase,
        expectation.type,
        "resolution",
        actualType,
        error.span,
      ),
    };
  }
}

export function probeTest262NegativeTest(
  path: string,
  source: string,
  metadata: Test262Metadata,
  entryName: string,
  mode: Test262ExecutionMode,
): Test262NegativeProbeResult {
  const expectation = metadata.negative;
  if (expectation === null) {
    throw new Error(`Positive Test262 test ${JSON.stringify(path)} has no negative expectation.`);
  }
  const probeSource = test262NegativeProbeSource(source, metadata, entryName, mode);
  let sourceModule: JavaScriptAotModule;
  try {
    sourceModule = parseJavaScriptAotModule(path, probeSource);
  } catch (error) {
    if (!(error instanceof JavaScriptAotSyntaxError)) throw error;
    if (expectation.phase === "parse" && expectation.type === "SyntaxError") {
      return { kind: "matched", phase: "parse" };
    }
    return {
      kind: "mismatch",
      diagnostic: negativeMismatchDiagnostic(
        path,
        expectation.phase,
        expectation.type,
        "parse",
        "SyntaxError",
        error.span,
      ),
    };
  }

  try {
    validateJavaScriptRuntimeResolution(
      transformModuleAssertions(sourceModule),
      entryName,
    );
  } catch (error) {
    if (!(error instanceof JavaScriptAotLoweringError)) throw error;
    const actualType = resolutionErrorType(error);
    if (expectation.phase === "resolution" && expectation.type === actualType) {
      return { kind: "matched", phase: "resolution" };
    }
    return {
      kind: "mismatch",
      diagnostic: negativeMismatchDiagnostic(
        path,
        expectation.phase,
        expectation.type,
        "resolution",
        actualType,
        error.span,
      ),
    };
  }

  if (expectation.phase === "runtime") {
    return { kind: "runtime-ready", expectedType: expectation.type };
  }
  return {
    kind: "mismatch",
    diagnostic: negativeMismatchDiagnostic(
      path,
      expectation.phase,
      expectation.type,
      "runtime",
      "no error",
      sourceModule.span,
    ),
  };
}

function resolutionErrorType(error: JavaScriptAotLoweringError): "ReferenceError" | "SyntaxError" {
  return /not (?:lexically )?declared|unresolved|later lexical binding/.test(error.message)
    ? "ReferenceError"
    : "SyntaxError";
}

function isSurfaceLimitError(error: unknown): error is RangeError {
  return error instanceof RangeError &&
    error.message.startsWith("functional surface ") && error.message.includes(" exceeds ");
}

function surfaceLimitDiagnostic(
  path: string,
  span: JavaScriptAotModule["span"],
  error: RangeError,
): JavaScriptAotDiagnostic {
  return {
    stage: "lower",
    code: "J1002",
    module: path,
    span,
    message: `JavaScript AOT ${error.message}.`,
  };
}

function lowerHarnessModule(
  path: string,
  sourceModule: JavaScriptAotModule,
  entryName: string,
  mode: Test262ExecutionMode,
  options: {
    readonly caughtExceptionType?: string;
    readonly allowUnresolvedReferences?: true;
  } = {},
): LoweredJavaScriptAotModule {
  const runtimeFaultConstructors = new Map([
    [TEST262_FAILURE_CONSTRUCTOR, `Test262 assertion failed in ${path}.`],
    ...(options.caughtExceptionType === "Test262Error"
      ? []
      : [["Test262Error", `Test262Error: test failed in ${path}.`] as const]),
  ]);
  return options.allowUnresolvedReferences === true || requiresJavaScriptRuntimeModel(sourceModule)
    ? lowerJavaScriptRuntimeModule(sourceModule, entryName, {
      runtimeFaultConstructors,
      callThisMode: mode === "non-strict" || mode === "raw" ? "sloppy" : "strict",
      entryThisMode: mode === "module" ? "undefined" : "global",
      ...(options.allowUnresolvedReferences === true ? { allowUnresolvedReferences: true } : {}),
    })
    : lowerJavaScriptAotModule(sourceModule, entryName, {
      exceptionConstructors: new Set(["Test262Error"]),
      runtimeFaultConstructors,
    });
}

function negativeMismatchDiagnostic(
  path: string,
  expectedPhase: "parse" | "resolution" | "runtime",
  expectedType: string,
  actualPhase: "parse" | "resolution" | "runtime",
  actualType: string,
  span: JavaScriptAotModule["span"],
): JavaScriptAotDiagnostic {
  return {
    stage: actualPhase === "parse" ? "parse" : "lower",
    code: actualPhase === "parse" ? "J1001" : "J1002",
    module: path,
    span,
    message: `Test262 negative test ${
      JSON.stringify(path)
    } expected ${expectedPhase} ${expectedType}, but reached ${actualPhase} ${actualType}.`,
  };
}

function diagnostic(
  path: string,
  stage: "parse" | "lower",
  code: "J1001" | "J1002",
  error: JavaScriptAotSyntaxError | JavaScriptAotLoweringError,
): JavaScriptAotDiagnostic {
  return { stage, code, module: path, span: error.span, message: error.message };
}

function transformModuleAssertions(sourceModule: JavaScriptAotModule): JavaScriptAotModule {
  return {
    ...sourceModule,
    declarations: sourceModule.declarations.map(transformDeclarationAssertions),
  };
}

function transformDeclarationAssertions(
  declaration: JavaScriptAotDeclaration,
): JavaScriptAotDeclaration {
  if (declaration.kind === "constant") {
    return { ...declaration, value: transformExpressionAssertions(declaration.value) };
  }
  const classMethods = declaration.classMethods?.map(transformClassMethodAssertions);
  return {
    ...declaration,
    body: declaration.body.map(transformStatementAssertions),
    ...(classMethods === undefined ? {} : { classMethods }),
  };
}

function transformStatementAssertions(statement: JavaScriptAotStatement): JavaScriptAotStatement {
  switch (statement.kind) {
    case "break":
    case "continue":
      return statement;
    case "function-declaration": {
      const classMethods = statement.classMethods?.map(transformClassMethodAssertions);
      return {
        ...statement,
        body: statement.body.map(transformStatementAssertions),
        ...(classMethods === undefined ? {} : { classMethods }),
      };
    }
    case "constant":
    case "mutable":
    case "assignment":
    case "return":
    case "throw":
      return { ...statement, value: transformExpressionAssertions(statement.value) };
    case "property-assignment":
      return {
        ...statement,
        target: statement.target.kind === "property"
          ? {
            ...statement.target,
            value: transformExpressionAssertions(statement.target.value),
          }
          : {
            ...statement.target,
            value: transformExpressionAssertions(statement.target.value),
            index: transformExpressionAssertions(statement.target.index),
          },
        value: transformExpressionAssertions(statement.value),
      };
    case "expression": {
      const expression = transformExpressionAssertions(statement.value);
      return transformThrowsAssertion(expression, statement.span) ??
        { ...statement, value: expression };
    }
    case "var":
      return {
        ...statement,
        declarations: statement.declarations.map((declaration) => ({
          ...declaration,
          value: declaration.value === null
            ? null
            : transformExpressionAssertions(declaration.value),
        })),
      };
    case "block":
      return { ...statement, statements: statement.statements.map(transformStatementAssertions) };
    case "try":
      return {
        ...statement,
        body: statement.body.map(transformStatementAssertions),
        catchBody: statement.catchBody?.map(transformStatementAssertions) ?? null,
        finallyBody: statement.finallyBody?.map(transformStatementAssertions) ?? null,
      };
    case "while":
      return {
        ...statement,
        condition: transformExpressionAssertions(statement.condition),
        body: statement.body.map(transformStatementAssertions),
        continueBody: statement.continueBody.map(transformStatementAssertions),
      };
    case "if":
      return {
        ...statement,
        condition: transformExpressionAssertions(statement.condition),
        consequent: statement.consequent.map(transformStatementAssertions),
        alternate: statement.alternate?.map(transformStatementAssertions) ?? null,
      };
  }
}

function transformClassMethodAssertions(
  method: JavaScriptAotClassMethod,
): JavaScriptAotClassMethod {
  const value = transformExpressionAssertions(method.value);
  if (value.kind !== "function") {
    throw new Error(
      `Test262 assertion transformation changed class method ${
        JSON.stringify(method.name)
      } into ${value.kind}.`,
    );
  }
  return { ...method, value };
}

function transformThrowsAssertion(
  expression: JavaScriptAotExpression,
  span: JavaScriptAotStatement["span"],
): JavaScriptAotStatement | null {
  if (
    expression.kind !== "call" || expression.callee.kind !== "property" ||
    expression.callee.value.kind !== "name" || expression.callee.value.name !== "assert" ||
    expression.callee.name !== "throws" || expression.arguments.length < 2
  ) {
    return null;
  }
  const expected = expression.arguments[0]!;
  const callback = expression.arguments[1]!;
  if (
    expected.kind !== "name" || !TEST262_ERROR_CONSTRUCTORS.has(expected.name) ||
    callback.kind !== "function" || callback.name !== null ||
    callback.parameters.length !== 0 || statementsContainReturn(callback.body) ||
    !statementsThrowOnlyErrors(callback.body)
  ) {
    return null;
  }
  if (
    expression.arguments.slice(2).some((argument) =>
      argument.kind !== "number" && argument.kind !== "string" &&
      argument.kind !== "boolean" && argument.kind !== "null"
    )
  ) {
    return null;
  }

  const caughtName = `$Test262CaughtException${span.startByte}`;
  const failure: JavaScriptAotExpression = {
    kind: "new",
    constructor: TEST262_FAILURE_CONSTRUCTOR,
    arguments: [],
    span,
  };
  return {
    kind: "block",
    statements: [{
      kind: "try",
      body: [...callback.body, { kind: "throw", value: failure, span }],
      catchName: caughtName,
      catchBody: [{
        kind: "expression",
        value: assertionExpression(
          binaryExpression(
            "instanceof",
            { kind: "name", name: caughtName, span },
            expected,
            span,
          ),
          span,
        ),
        span,
      }],
      finallyBody: null,
      span,
    }],
    span,
  };
}

function statementsContainReturn(statements: readonly JavaScriptAotStatement[]): boolean {
  return statements.some((statement) => {
    switch (statement.kind) {
      case "return":
        return true;
      case "function-declaration":
        return false;
      case "block":
        return statementsContainReturn(statement.statements);
      case "while":
        return statementsContainReturn(statement.body) ||
          statementsContainReturn(statement.continueBody);
      case "if":
        return statementsContainReturn(statement.consequent) ||
          statement.alternate !== null && statementsContainReturn(statement.alternate);
      case "try":
        return statementsContainReturn(statement.body) ||
          statement.catchBody !== null && statementsContainReturn(statement.catchBody) ||
          statement.finallyBody !== null && statementsContainReturn(statement.finallyBody);
      default:
        return false;
    }
  });
}

function statementsThrowOnlyErrors(statements: readonly JavaScriptAotStatement[]): boolean {
  let sawSupportedExceptionSource = false;
  const visit = (nested: readonly JavaScriptAotStatement[]): boolean => {
    for (const statement of nested) {
      if (statement.kind === "function-declaration") continue;
      if (statement.kind === "throw") {
        sawSupportedExceptionSource = true;
        if (
          statement.value.kind !== "new" ||
          !TEST262_ERROR_CONSTRUCTORS.has(statement.value.constructor)
        ) return false;
        continue;
      }
      if (
        (statement.kind === "constant" || statement.kind === "mutable" ||
          statement.kind === "assignment" || statement.kind === "return" ||
          statement.kind === "property-assignment" ||
          statement.kind === "expression") && expressionContainsCall(statement.value)
      ) {
        sawSupportedExceptionSource = true;
      }
      if (
        statement.kind === "var" &&
        statement.declarations.some((declaration) =>
          declaration.value !== null && expressionContainsCall(declaration.value)
        )
      ) {
        sawSupportedExceptionSource = true;
      }
      if (statement.kind === "while" && expressionContainsCall(statement.condition)) {
        sawSupportedExceptionSource = true;
      }
      if (statement.kind === "if" && expressionContainsCall(statement.condition)) {
        sawSupportedExceptionSource = true;
      }
      if (statement.kind === "block" && !visit(statement.statements)) return false;
      if (
        statement.kind === "while" &&
        (!visit(statement.body) || !visit(statement.continueBody))
      ) return false;
      if (statement.kind === "if") {
        if (!visit(statement.consequent)) return false;
        if (statement.alternate !== null && !visit(statement.alternate)) return false;
      }
      if (statement.kind === "try") {
        if (!visit(statement.body)) return false;
        if (statement.catchBody !== null && !visit(statement.catchBody)) return false;
        if (statement.finallyBody !== null && !visit(statement.finallyBody)) return false;
      }
    }
    return true;
  };
  return visit(statements) && sawSupportedExceptionSource;
}

function expressionContainsCall(expression: JavaScriptAotExpression): boolean {
  switch (expression.kind) {
    case "call":
      return true;
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "name":
    case "function":
      return false;
    case "array":
      return expression.values.some(expressionContainsCall);
    case "object":
      return expression.properties.some((property) => expressionContainsCall(property.value));
    case "unary":
    case "property":
      return expressionContainsCall(expression.value);
    case "binary":
      return expressionContainsCall(expression.left) || expressionContainsCall(expression.right);
    case "conditional":
      return expressionContainsCall(expression.condition) ||
        expressionContainsCall(expression.consequent) ||
        expressionContainsCall(expression.alternate);
    case "new":
      return expression.arguments.some(expressionContainsCall);
    case "index":
      return expressionContainsCall(expression.value) || expressionContainsCall(expression.index);
  }
}

function transformExpressionAssertions(
  expression: JavaScriptAotExpression,
): JavaScriptAotExpression {
  switch (expression.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "name":
      return expression;
    case "array":
      return { ...expression, values: expression.values.map(transformExpressionAssertions) };
    case "object":
      return {
        ...expression,
        properties: expression.properties.map((property) => ({
          ...property,
          value: transformExpressionAssertions(property.value),
        })),
      };
    case "function":
      return { ...expression, body: expression.body.map(transformStatementAssertions) };
    case "unary":
      return { ...expression, value: transformExpressionAssertions(expression.value) };
    case "binary":
      return {
        ...expression,
        left: transformExpressionAssertions(expression.left),
        right: transformExpressionAssertions(expression.right),
      };
    case "conditional":
      return {
        ...expression,
        condition: transformExpressionAssertions(expression.condition),
        consequent: transformExpressionAssertions(expression.consequent),
        alternate: transformExpressionAssertions(expression.alternate),
      };
    case "new":
      return { ...expression, arguments: expression.arguments.map(transformExpressionAssertions) };
    case "property":
      return { ...expression, value: transformExpressionAssertions(expression.value) };
    case "index":
      return {
        ...expression,
        value: transformExpressionAssertions(expression.value),
        index: transformExpressionAssertions(expression.index),
      };
    case "call":
      return transformCallAssertion(expression);
  }
}

function transformCallAssertion(
  expression: Extract<JavaScriptAotExpression, { readonly kind: "call" }>,
): JavaScriptAotExpression {
  const arguments_ = expression.arguments.map(transformExpressionAssertions);
  const callee = transformExpressionAssertions(expression.callee);
  if (callee.kind === "name" && callee.name === "assert" && arguments_.length >= 1) {
    return assertionExpression(arguments_[0]!, expression.span);
  }
  if (
    callee.kind !== "property" || callee.value.kind !== "name" ||
    callee.value.name !== "assert" || arguments_.length < 2
  ) {
    return { ...expression, callee, arguments: arguments_ };
  }
  if (callee.name === "sameValue") {
    return assertionExpression(
      binaryExpression("same-value", arguments_[0]!, arguments_[1]!, expression.span),
      expression.span,
    );
  }
  if (callee.name === "notSameValue") {
    return assertionExpression(
      binaryExpression("not-same-value", arguments_[0]!, arguments_[1]!, expression.span),
      expression.span,
    );
  }
  return { ...expression, callee, arguments: arguments_ };
}

function assertionExpression(
  condition: JavaScriptAotExpression,
  span: JavaScriptAotExpression["span"],
): JavaScriptAotExpression {
  return {
    kind: "conditional",
    condition,
    consequent: { kind: "boolean", value: true, span },
    alternate: { kind: "new", constructor: TEST262_FAILURE_CONSTRUCTOR, arguments: [], span },
    span,
  };
}

function binaryExpression(
  operator: "===" | "!==" | "instanceof" | "same-value" | "not-same-value",
  left: JavaScriptAotExpression,
  right: JavaScriptAotExpression,
  span: JavaScriptAotExpression["span"],
): JavaScriptAotExpression {
  return { kind: "binary", operator, left, right, span };
}
