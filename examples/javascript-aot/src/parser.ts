import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";
import {
  babaChildRule,
  babaOptionalRuleField,
  babaOptionalTokenField,
  babaRequiredRuleField,
  babaRequiredTokenField,
  type BabaRuleCursor,
  babaRuleFieldArray,
  BabaUtf8ByteOffsets,
} from "../../../src/baba_frontend.ts";
import type {
  JavaScriptAotBinaryOperator,
  JavaScriptAotClassMethod,
  JavaScriptAotDeclaration,
  JavaScriptAotExpression,
  JavaScriptAotModule,
  JavaScriptAotStatement,
} from "./ast.ts";
import { JavaScriptAotSyntaxError } from "./diagnostic.ts";

type JavaScriptAotParser = ReturnType<typeof createParser>;

const JAVASCRIPT_AOT_MAXIMUM_AUTOMATIC_SEMICOLONS = 4;
const JAVASCRIPT_AOT_MAXIMUM_SOURCE_BYTE_LENGTH = 256 * 1024;
const JAVASCRIPT_AOT_MAXIMUM_SYNTAX_NESTING = 256;
const JAVASCRIPT_AOT_MAXIMUM_TOKENS = 8_192;
const JAVASCRIPT_AOT_OPENING_DELIMITERS = new Set(["(", "[", "{"]);
const JAVASCRIPT_AOT_CLOSING_DELIMITERS = new Set([")", "]", "}"]);
const JAVASCRIPT_AOT_PREFIX_OPERATORS = new Set([
  "!",
  "+",
  "-",
  "new",
  "typeof",
  "void",
  "~",
]);

let javascriptAotParser: JavaScriptAotParser | undefined;

export function parseJavaScriptAotModule(name: string, source: string): JavaScriptAotModule {
  if (name.length === 0) throw new Error("JavaScript AOT module name must be nonempty");
  const sourceByteLength = new TextEncoder().encode(source).byteLength;
  if (sourceByteLength > JAVASCRIPT_AOT_MAXIMUM_SOURCE_BYTE_LENGTH) {
    throw new JavaScriptAotSyntaxError(
      { startByte: 0, endByte: sourceByteLength },
      `JavaScript module ${
        JSON.stringify(name)
      } exceeds the ${JAVASCRIPT_AOT_MAXIMUM_SOURCE_BYTE_LENGTH}-byte source limit; received ${sourceByteLength} bytes.`,
    );
  }
  const parser = getJavaScriptAotParser();
  try {
    const byteOffsets = new BabaUtf8ByteOffsets(source);
    let parserSource = source;
    const lexed = parser.lex(parserSource, { preserveTrivia: false });
    if (
      lexed.diagnostics.length === 0 &&
      lexed.tokenTape.length > JAVASCRIPT_AOT_MAXIMUM_TOKENS
    ) {
      throw new JavaScriptAotSyntaxError(
        { startByte: 0, endByte: sourceByteLength },
        `JavaScript module ${
          JSON.stringify(name)
        } exceeds the ${JAVASCRIPT_AOT_MAXIMUM_TOKENS}-token parser limit; received ${lexed.tokenTape.length} tokens.`,
      );
    }
    if (lexed.diagnostics.length === 0) {
      let delimiterDepth = 0;
      let prefixOperatorDepth = 0;
      for (let tokenIndex = 0; tokenIndex < lexed.tokenTape.length; tokenIndex++) {
        const token = lexed.tokenTape.token(tokenIndex);
        if (token === undefined || token.type !== "literal") {
          prefixOperatorDepth = 0;
          continue;
        }
        if (JAVASCRIPT_AOT_OPENING_DELIMITERS.has(token.literal)) {
          delimiterDepth++;
        } else if (JAVASCRIPT_AOT_CLOSING_DELIMITERS.has(token.literal)) {
          delimiterDepth = Math.max(0, delimiterDepth - 1);
        }
        if (delimiterDepth > JAVASCRIPT_AOT_MAXIMUM_SYNTAX_NESTING) {
          throw new JavaScriptAotSyntaxError(
            byteOffsets.span(token.span),
            `JavaScript module ${
              JSON.stringify(name)
            } exceeds the syntax nesting limit of ${JAVASCRIPT_AOT_MAXIMUM_SYNTAX_NESTING}.`,
          );
        }

        prefixOperatorDepth = JAVASCRIPT_AOT_PREFIX_OPERATORS.has(token.literal)
          ? prefixOperatorDepth + 1
          : 0;
        if (prefixOperatorDepth > JAVASCRIPT_AOT_MAXIMUM_SYNTAX_NESTING) {
          throw new JavaScriptAotSyntaxError(
            byteOffsets.span(token.span),
            `JavaScript module ${
              JSON.stringify(name)
            } exceeds the prefix-operator nesting limit of ${JAVASCRIPT_AOT_MAXIMUM_SYNTAX_NESTING}.`,
          );
        }
      }
    }
    let parsed = parser.parse(parserSource, { preserveTrivia: false });
    let insertedSemicolons = 0;
    while (!parsed.ok) {
      const diagnostic = parsed.diagnostics[0];
      if (diagnostic?.expected?.includes('";"') !== true) break;

      let cursor = diagnostic.span.start - 1;
      let lineTerminator = -1;
      let whitespace = -1;
      while (cursor >= 0 && /\s/.test(parserSource[cursor]!)) {
        whitespace = cursor;
        if (parserSource[cursor] === "\n" || parserSource[cursor] === "\r") {
          lineTerminator = cursor;
          break;
        }
        cursor--;
      }
      const permitsInsertionBeforeBrace = diagnostic.found === '"}"' && whitespace >= 0;
      const semicolonPosition = lineTerminator >= 0
        ? lineTerminator
        : permitsInsertionBeforeBrace
        ? whitespace
        : -1;
      if (semicolonPosition < 0) break;
      if (insertedSemicolons === JAVASCRIPT_AOT_MAXIMUM_AUTOMATIC_SEMICOLONS) {
        throw new JavaScriptAotSyntaxError(
          byteOffsets.span(diagnostic.span),
          `JavaScript module ${
            JSON.stringify(name)
          } requires more than ${JAVASCRIPT_AOT_MAXIMUM_AUTOMATIC_SEMICOLONS} automatic semicolon insertions.`,
        );
      }
      insertedSemicolons++;
      parserSource = parserSource.slice(0, semicolonPosition) + ";" +
        parserSource.slice(semicolonPosition + 1);
      parsed = parser.parse(parserSource, { preserveTrivia: false });
    }
    if (!parsed.ok) {
      const diagnostic = parsed.diagnostics[0];
      if (diagnostic === undefined) {
        throw new Error(
          `Baba failed to parse JavaScript AOT module ${JSON.stringify(name)} without diagnostics.`,
        );
      }
      throw new JavaScriptAotSyntaxError(
        byteOffsets.span(diagnostic.span),
        `JavaScript module ${JSON.stringify(name)}: ${diagnostic.code}: ${diagnostic.message}`,
      );
    }
    const module = {
      name,
      declarations: babaRuleFieldArray(parsed.cursor, "declarations").map((declaration) =>
        parseDeclaration(declaration, byteOffsets)
      ),
      span: { startByte: 0, endByte: byteOffsets.byteLength },
    };
    assertStrictModeEarlyErrors(module.declarations);
    return module;
  } catch (error) {
    if (
      error instanceof RangeError &&
      (error.message === "Maximum call stack size exceeded" ||
        error.message === "Wasm parser plan exceeds maximum memory pages.")
    ) {
      throw new JavaScriptAotSyntaxError(
        { startByte: 0, endByte: sourceByteLength },
        `JavaScript module ${JSON.stringify(name)} exhausted the parser resource limit.`,
      );
    }
    throw error;
  } finally {
    parser.reset();
  }
}

function assertStrictModeEarlyErrors(
  declarations: readonly JavaScriptAotDeclaration[],
): void {
  const restrictedNames = new Set(["arguments", "eval"]);
  const hasUseStrictDirective = (statements: readonly JavaScriptAotStatement[]): boolean => {
    for (const statement of statements) {
      if (statement.kind !== "expression" || statement.value.kind !== "string") return false;
      if (statement.value.raw === '"use strict"' || statement.value.raw === "'use strict'") {
        return true;
      }
    }
    return false;
  };
  const visitExpression = (expression: JavaScriptAotExpression, strict: boolean): void => {
    switch (expression.kind) {
      case "array":
        for (const value of expression.values) visitExpression(value, strict);
        return;
      case "object":
        for (const property of expression.properties) visitExpression(property.value, strict);
        return;
      case "function":
        visitFunction(
          expression.name,
          expression.parameters,
          expression.body,
          strict,
          expression.span,
        );
        return;
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
    statements: readonly JavaScriptAotStatement[],
    inheritedStrictMode: boolean,
  ): void => {
    const strict = inheritedStrictMode || hasUseStrictDirective(statements);
    for (const statement of statements) {
      switch (statement.kind) {
        case "function-declaration":
          visitFunction(
            statement.name,
            statement.parameters,
            statement.body,
            statement.classMethods !== undefined || strict,
            statement.span,
          );
          for (const method of statement.classMethods ?? []) {
            visitExpression(method.value, true);
          }
          break;
        case "constant":
        case "mutable":
          if (strict && restrictedNames.has(statement.name)) {
            throw new JavaScriptAotSyntaxError(
              statement.span,
              `JavaScript strict mode cannot bind ${JSON.stringify(statement.name)}.`,
            );
          }
          visitExpression(statement.value, strict);
          break;
        case "var":
          for (const declaration of statement.declarations) {
            if (strict && restrictedNames.has(declaration.name)) {
              throw new JavaScriptAotSyntaxError(
                declaration.span,
                `JavaScript strict mode cannot bind ${JSON.stringify(declaration.name)}.`,
              );
            }
            if (declaration.value !== null) visitExpression(declaration.value, strict);
          }
          break;
        case "assignment":
          if (strict && restrictedNames.has(statement.name)) {
            throw new JavaScriptAotSyntaxError(
              statement.span,
              `JavaScript strict mode cannot assign to ${JSON.stringify(statement.name)}.`,
            );
          }
          visitExpression(statement.value, strict);
          break;
        case "property-assignment":
          visitExpression(statement.target, strict);
          visitExpression(statement.value, strict);
          break;
        case "return":
        case "throw":
        case "expression":
          visitExpression(statement.value, strict);
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
          if (strict && statement.catchName !== null && restrictedNames.has(statement.catchName)) {
            throw new JavaScriptAotSyntaxError(
              statement.span,
              `JavaScript strict mode cannot bind ${JSON.stringify(statement.catchName)}.`,
            );
          }
          visitStatements(statement.body, strict);
          if (statement.catchBody !== null) visitStatements(statement.catchBody, strict);
          if (statement.finallyBody !== null) visitStatements(statement.finallyBody, strict);
          break;
        case "break":
        case "continue":
          break;
      }
    }
  };
  const visitFunction = (
    name: string | null,
    parameters: readonly string[],
    body: readonly JavaScriptAotStatement[],
    inheritedStrictMode: boolean,
    span: JavaScriptAotExpression["span"],
  ): void => {
    const strict = inheritedStrictMode || hasUseStrictDirective(body);
    if (strict) {
      if (name !== null && restrictedNames.has(name)) {
        throw new JavaScriptAotSyntaxError(
          span,
          `JavaScript strict mode cannot bind function name ${JSON.stringify(name)}.`,
        );
      }
      const restrictedParameter = parameters.find((parameter) => restrictedNames.has(parameter));
      if (restrictedParameter !== undefined) {
        throw new JavaScriptAotSyntaxError(
          span,
          `JavaScript strict mode cannot bind parameter ${JSON.stringify(restrictedParameter)}.`,
        );
      }
      const parameterNames = new Set<string>();
      for (const parameter of parameters) {
        if (parameterNames.has(parameter)) {
          throw new JavaScriptAotSyntaxError(
            span,
            `JavaScript strict mode function declares parameter ${
              JSON.stringify(parameter)
            } more than once.`,
          );
        }
        parameterNames.add(parameter);
      }
    }
    visitStatements(body, strict);
  };

  for (const declaration of declarations) {
    if (declaration.kind === "constant") {
      visitExpression(declaration.value, false);
    } else {
      visitFunction(
        declaration.name,
        declaration.parameters,
        declaration.body,
        declaration.classMethods !== undefined,
        declaration.span,
      );
      for (const method of declaration.classMethods ?? []) {
        visitExpression(method.value, true);
      }
    }
  }
}

function getJavaScriptAotParser(): JavaScriptAotParser {
  if (javascriptAotParser !== undefined) return javascriptAotParser;
  javascriptAotParser = createParser({
    bytes: Deno.readFileSync(
      new URL("../language/generated/wasm/parser.wasm", import.meta.url),
    ),
    plan: Deno.readFileSync(
      new URL("../language/generated/wasm/parser.plan", import.meta.url),
    ),
  });
  return javascriptAotParser;
}

function parseDeclaration(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): JavaScriptAotDeclaration {
  let declaration = node.name === "declaration" ? babaChildRule(node) : node;
  let exported = false;
  if (declaration.name === "exported_declaration") {
    exported = true;
    declaration = babaChildRule(babaRequiredRuleField(declaration, "declaration"));
  }
  const span = offsets.span(declaration.span);
  if (declaration.name === "constant_declaration") {
    return {
      kind: "constant",
      exported,
      name: babaRequiredTokenField(declaration, "name").text,
      value: parseExpression(babaRequiredRuleField(declaration, "value"), offsets),
      span,
    };
  }
  if (declaration.name === "class_declaration") {
    const parsedClass = parseClass(declaration, offsets);
    return {
      kind: "function",
      exported,
      ...parsedClass,
    };
  }
  if (
    declaration.name === "generator_declaration" ||
    declaration.name === "async_function_declaration"
  ) {
    const parametersNode = babaOptionalRuleField(declaration, "parameters");
    const parameters = parametersNode === null
      ? { names: [], initializers: [], functionLength: 0 }
      : parseParameterList(parametersNode, offsets);
    const bodyNode = babaRequiredRuleField(declaration, "body");
    const body = declaration.name === "generator_declaration"
      ? parseGeneratorBody(bodyNode, offsets)
      : transformAsyncBody(parseBlock(bodyNode, offsets), offsets.span(declaration.span));
    return {
      kind: "function",
      exported,
      name: babaRequiredTokenField(declaration, "name").text,
      parameters: parameters.names,
      parameterLength: parameters.functionLength,
      ...(declaration.name === "generator_declaration"
        ? { requiresRuntimeModel: true as const }
        : {}),
      body: insertParameterInitializers(body, parameters.initializers),
      span,
    };
  }
  if (declaration.name !== "function_declaration") {
    throw new Error(`Unsupported Baba JavaScript declaration node ${declaration.name}.`);
  }
  const parametersNode = babaOptionalRuleField(declaration, "parameters");
  const parameters = parametersNode === null
    ? { names: [], initializers: [], functionLength: 0 }
    : parseParameterList(parametersNode, offsets);
  return {
    kind: "function",
    exported,
    name: babaRequiredTokenField(declaration, "name").text,
    parameters: parameters.names,
    parameterLength: parameters.functionLength,
    body: insertParameterInitializers(
      parseBlock(babaRequiredRuleField(declaration, "body"), offsets),
      parameters.initializers,
    ),
    span,
  };
}

function parseBlock(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): readonly JavaScriptAotStatement[] {
  return babaRuleFieldArray(node, "statements").map((statement) =>
    parseStatement(statement, offsets)
  );
}

function parseStatement(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): JavaScriptAotStatement {
  const statement = node.name === "statement" ? babaChildRule(node) : node;
  const span = offsets.span(statement.span);
  switch (statement.name) {
    case "class_declaration":
      return {
        kind: "function-declaration",
        ...parseClass(statement, offsets),
      };
    case "generator_declaration":
    case "async_function_declaration": {
      const parametersNode = babaOptionalRuleField(statement, "parameters");
      const parameters = parametersNode === null
        ? { names: [], initializers: [], functionLength: 0 }
        : parseParameterList(parametersNode, offsets);
      const bodyNode = babaRequiredRuleField(statement, "body");
      const body = statement.name === "generator_declaration"
        ? parseGeneratorBody(bodyNode, offsets)
        : transformAsyncBody(parseBlock(bodyNode, offsets), span);
      return {
        kind: "function-declaration",
        name: babaRequiredTokenField(statement, "name").text,
        parameters: parameters.names,
        parameterLength: parameters.functionLength,
        ...(statement.name === "generator_declaration"
          ? { requiresRuntimeModel: true as const }
          : {}),
        body: insertParameterInitializers(body, parameters.initializers),
        span,
      };
    }
    case "function_declaration": {
      const parametersNode = babaOptionalRuleField(statement, "parameters");
      const parameters = parametersNode === null
        ? { names: [], initializers: [], functionLength: 0 }
        : parseParameterList(parametersNode, offsets);
      return {
        kind: "function-declaration",
        name: babaRequiredTokenField(statement, "name").text,
        parameters: parameters.names,
        parameterLength: parameters.functionLength,
        body: insertParameterInitializers(
          parseBlock(babaRequiredRuleField(statement, "body"), offsets),
          parameters.initializers,
        ),
        span,
      };
    }
    case "constant_statement":
      return {
        kind: "constant",
        name: babaRequiredTokenField(statement, "name").text,
        value: parseExpression(babaRequiredRuleField(statement, "value"), offsets),
        span,
      };
    case "mutable_statement": {
      const initializer = babaOptionalRuleField(statement, "initializer");
      return {
        kind: "mutable",
        name: babaRequiredTokenField(statement, "name").text,
        value: initializer === null
          ? { kind: "name", name: "undefined", span }
          : parseExpression(babaRequiredRuleField(initializer, "value"), offsets),
        span,
      };
    }
    case "var_statement":
      return {
        kind: "var",
        declarations: variableDeclarators(
          babaRequiredRuleField(statement, "declarations"),
        ).map(
          (declaration) => {
            const initializer = babaOptionalRuleField(declaration, "initializer");
            return {
              name: babaRequiredTokenField(declaration, "name").text,
              value: initializer === null
                ? null
                : parseExpression(babaRequiredRuleField(initializer, "value"), offsets),
              span: offsets.span(declaration.span),
            };
          },
        ),
        span,
      };
    case "assignment_statement": {
      return parseAssignment(babaChildRule(statement), offsets, span);
    }
    case "update_statement":
      return parseUpdate(babaChildRule(statement), offsets, span);
    case "return_statement":
      return {
        kind: "return",
        value: parseOptionalReturnValue(statement, offsets),
        span,
      };
    case "throw_statement":
      return {
        kind: "throw",
        value: parseExpression(babaRequiredRuleField(statement, "value"), offsets),
        span,
      };
    case "break_statement":
      return { kind: "break", span };
    case "continue_statement":
      return { kind: "continue", span };
    case "try_statement": {
      const continuation = babaChildRule(babaRequiredRuleField(statement, "continuation"));
      const catchWithFinally = continuation.name === "catch_with_finally" ? continuation : null;
      const catchClause = catchWithFinally === null
        ? null
        : babaRequiredRuleField(catchWithFinally, "catch");
      const binding = catchClause === null ? null : babaOptionalRuleField(catchClause, "binding");
      const finallyClause = catchWithFinally === null
        ? continuation
        : babaOptionalRuleField(catchWithFinally, "finally");
      return {
        kind: "try",
        body: parseBlock(babaRequiredRuleField(statement, "body"), offsets),
        catchName: binding === null ? null : babaRequiredTokenField(binding, "name").text,
        catchBody: catchClause === null
          ? null
          : parseBlock(babaRequiredRuleField(catchClause, "body"), offsets),
        finallyBody: finallyClause === null
          ? null
          : parseBlock(babaRequiredRuleField(finallyClause, "body"), offsets),
        span,
      };
    }
    case "expression_statement":
      return {
        kind: "expression",
        value: parseExpression(babaRequiredRuleField(statement, "value"), offsets),
        span,
      };
    case "yield_statement":
      throw new JavaScriptAotSyntaxError(
        span,
        "JavaScript yield is only valid directly inside a supported generator body.",
      );
    case "block_statement":
      return {
        kind: "block",
        statements: parseBlock(babaRequiredRuleField(statement, "body"), offsets),
        span,
      };
    case "empty_statement":
      return { kind: "block", statements: [], span };
    case "if_statement": {
      const alternateNode = babaOptionalRuleField(statement, "alternate");
      return {
        kind: "if",
        condition: parseExpression(babaRequiredRuleField(statement, "condition"), offsets),
        consequent: parseStatementBody(
          babaRequiredRuleField(statement, "consequent"),
          offsets,
        ),
        alternate: alternateNode === null ? null : parseConditionalBody(
          babaRequiredRuleField(alternateNode, "body"),
          offsets,
        ),
        span,
      };
    }
    case "while_statement":
      return {
        kind: "while",
        condition: parseExpression(babaRequiredRuleField(statement, "condition"), offsets),
        body: parseStatementBody(babaRequiredRuleField(statement, "body"), offsets),
        continueBody: [],
        span,
      };
    case "for_statement": {
      const initializerRule = babaOptionalRuleField(statement, "initializer");
      const updateRule = babaOptionalRuleField(statement, "update");
      const body = parseStatementBody(babaRequiredRuleField(statement, "body"), offsets);
      const continueBody = updateRule === null ? [] : [parseForUpdate(updateRule, offsets)];
      const statements: JavaScriptAotStatement[] = [];
      if (initializerRule !== null) {
        statements.push(parseForInitializer(initializerRule, offsets));
      }
      const conditionRule = babaOptionalRuleField(statement, "condition");
      statements.push({
        kind: "while",
        condition: conditionRule === null
          ? { kind: "boolean", value: true, span }
          : parseExpression(conditionRule, offsets),
        body,
        continueBody,
        span,
      });
      return {
        kind: "block",
        statements,
        span,
      };
    }
    default:
      throw new Error(`Unsupported Baba JavaScript statement node ${statement.name}.`);
  }
}

function parseClass(
  declaration: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): {
  readonly name: string;
  readonly parameters: readonly string[];
  readonly parameterLength: number;
  readonly requiresRuntimeModel: true;
  readonly classMethods: readonly JavaScriptAotClassMethod[];
  readonly body: readonly JavaScriptAotStatement[];
  readonly span: JavaScriptAotDeclaration["span"];
} {
  const methods = babaRuleFieldArray(
    babaRequiredRuleField(declaration, "body"),
    "methods",
  );
  const constructors = methods.filter((method) =>
    babaRequiredTokenField(method, "name").text === "constructor"
  );
  if (constructors.length > 1) {
    throw new JavaScriptAotSyntaxError(
      offsets.span(constructors[1]!.span),
      `JavaScript class ${
        JSON.stringify(babaRequiredTokenField(declaration, "name").text)
      } declares more than one constructor.`,
    );
  }
  const constructor = constructors[0] ?? null;
  const parametersNode = constructor === null
    ? null
    : babaOptionalRuleField(constructor, "parameters");
  const parameters = parametersNode === null
    ? { names: [], initializers: [], functionLength: 0 }
    : parseParameterList(parametersNode, offsets);
  const classMethods = methods.flatMap((method): readonly JavaScriptAotClassMethod[] => {
    const methodName = babaRequiredTokenField(method, "name");
    if (methodName.text === "constructor") return [];
    const methodParametersNode = babaOptionalRuleField(method, "parameters");
    const methodParameters = methodParametersNode === null
      ? { names: [], initializers: [], functionLength: 0 }
      : parseParameterList(methodParametersNode, offsets);
    const methodSpan = offsets.span(method.span);
    return [{
      name: methodName.text,
      value: {
        kind: "function",
        name: methodName.text,
        thisMode: "dynamic",
        parameters: methodParameters.names,
        parameterLength: methodParameters.functionLength,
        body: insertParameterInitializers(
          parseBlock(babaRequiredRuleField(method, "body"), offsets),
          methodParameters.initializers,
        ),
        span: methodSpan,
      },
      span: methodSpan,
    }];
  });
  const constructorBody = constructor === null
    ? []
    : parseBlock(babaRequiredRuleField(constructor, "body"), offsets);
  return {
    name: babaRequiredTokenField(declaration, "name").text,
    parameters: parameters.names,
    parameterLength: parameters.functionLength,
    requiresRuntimeModel: true,
    classMethods,
    body: insertParameterInitializers(
      constructorBody,
      parameters.initializers,
    ),
    span: offsets.span(declaration.span),
  };
}

function parseForInitializer(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): JavaScriptAotStatement {
  const initializer = babaChildRule(node);
  const span = offsets.span(initializer.span);
  if (initializer.name === "var_for_initializer") {
    return {
      kind: "var",
      declarations: variableDeclarators(
        babaRequiredRuleField(initializer, "declarations"),
      ).map((declaration) => {
        const value = babaOptionalRuleField(declaration, "initializer");
        return {
          name: babaRequiredTokenField(declaration, "name").text,
          value: value === null
            ? null
            : parseExpression(babaRequiredRuleField(value, "value"), offsets),
          span: offsets.span(declaration.span),
        };
      }),
      span,
    };
  }
  return {
    kind: initializer.name === "mutable_for_initializer" ? "mutable" : "constant",
    name: babaRequiredTokenField(initializer, "name").text,
    value: parseExpression(babaRequiredRuleField(initializer, "value"), offsets),
    span,
  };
}

function parseAssignment(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
  span: { readonly startByte: number; readonly endByte: number },
): Extract<JavaScriptAotStatement, {
  readonly kind: "assignment" | "property-assignment";
}> {
  const operator = babaChildRule(babaRequiredRuleField(node, "op"));
  const target = parseExpression(babaRequiredRuleField(node, "target"), offsets);
  const value = parseExpression(babaRequiredRuleField(node, "value"), offsets);
  if (target.kind === "name") {
    return {
      kind: "assignment",
      name: target.name,
      operator: assignmentOperator(operator.name),
      value,
      span,
    };
  }
  if (target.kind === "property" || target.kind === "index") {
    return {
      kind: "property-assignment",
      target,
      operator: assignmentOperator(operator.name),
      value,
      span,
    };
  }
  throw new JavaScriptAotSyntaxError(
    target.span,
    `JavaScript assignment target ${JSON.stringify(target.kind)} is not assignable.`,
  );
}

function parseForUpdate(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): Extract<JavaScriptAotStatement, {
  readonly kind: "assignment" | "property-assignment";
}> {
  const update = babaChildRule(node);
  return update.name === "assignment"
    ? parseAssignment(update, offsets, offsets.span(update.span))
    : parseUpdate(update, offsets, offsets.span(update.span));
}

function parseUpdate(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
  span: { readonly startByte: number; readonly endByte: number },
): Extract<JavaScriptAotStatement, { readonly kind: "assignment" }> {
  const update = node.name === "update" ? babaChildRule(node) : node;
  const name = babaRequiredTokenField(update, "name").text;
  const valueSpan = offsets.span(update.span);
  return {
    kind: "assignment",
    name,
    operator: "=",
    value: {
      kind: "binary",
      operator: update.name === "increment" ? "+" : "-",
      left: {
        kind: "unary",
        operator: "+",
        value: { kind: "name", name, span: valueSpan },
        span: valueSpan,
      },
      right: { kind: "number", value: 1, span: valueSpan },
      span: valueSpan,
    },
    span,
  };
}

function assignmentOperator(
  name: string,
): Extract<JavaScriptAotStatement, { readonly kind: "assignment" }>["operator"] {
  switch (name) {
    case "assign":
      return "=";
    case "add_assign":
      return "+=";
    case "subtract_assign":
      return "-=";
    case "multiply_assign":
      return "*=";
    case "divide_assign":
      return "/=";
    case "remainder_assign":
      return "%=";
    case "shift_left_assign":
      return "<<=";
    case "shift_right_assign":
      return ">>=";
    case "shift_right_unsigned_assign":
      return ">>>=";
    case "bitwise_and_assign":
      return "&=";
    case "bitwise_xor_assign":
      return "^=";
    case "bitwise_or_assign":
      return "|=";
    default:
      throw new Error(`Unsupported Baba JavaScript assignment operator ${name}.`);
  }
}

function parseConditionalBody(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): readonly JavaScriptAotStatement[] {
  const body = node.name === "conditional_body" ? babaChildRule(node) : node;
  return parseStatementBody(body, offsets);
}

function parseStatementBody(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): readonly JavaScriptAotStatement[] {
  let body = node.name === "statement_body" ? babaChildRule(node) : node;
  if (body.name === "non_if_statement") body = babaChildRule(body);
  return body.name === "block" ? parseBlock(body, offsets) : [parseStatement(body, offsets)];
}

function parseExpression(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): JavaScriptAotExpression {
  const expression = node.name === "expr" ? babaChildRule(node) : node;
  switch (expression.name) {
    case "arrow_function": {
      const body = babaChildRule(babaRequiredRuleField(expression, "body"));
      const span = offsets.span(expression.span);
      return {
        kind: "function",
        name: null,
        thisMode: "lexical",
        parameters: [babaRequiredTokenField(expression, "parameter").text],
        body: body.name === "block"
          ? parseBlock(body, offsets)
          : [{ kind: "return", value: parseExpression(body, offsets), span }],
        span,
      };
    }
    case "conditional": {
      const condition = parseExpression(babaRequiredRuleField(expression, "condition"), offsets);
      const tail = babaOptionalRuleField(expression, "tail");
      if (tail === null) return condition;
      return {
        kind: "conditional",
        condition,
        consequent: parseExpression(babaRequiredRuleField(tail, "consequent"), offsets),
        alternate: parseExpression(babaRequiredRuleField(tail, "alternate"), offsets),
        span: offsets.span(expression.span),
      };
    }
    case "logical_or":
      return foldOperator(expression, offsets, "||");
    case "logical_and":
      return foldOperator(expression, offsets, "&&");
    case "bitwise_or":
      return foldOperator(expression, offsets, "|");
    case "bitwise_xor":
      return foldOperator(expression, offsets, "^");
    case "bitwise_and":
      return foldOperator(expression, offsets, "&");
    case "equality":
    case "comparison":
    case "shift":
    case "additive":
    case "multiplicative":
      return foldNamedOperators(expression, offsets);
    case "unary":
    case "primary":
      return parseExpression(babaChildRule(expression), offsets);
    case "negate":
      return {
        kind: "unary",
        operator: "-",
        value: parseExpression(babaRequiredRuleField(expression, "value"), offsets),
        span: offsets.span(expression.span),
      };
    case "positive":
      return {
        kind: "unary",
        operator: "+",
        value: parseExpression(babaRequiredRuleField(expression, "value"), offsets),
        span: offsets.span(expression.span),
      };
    case "boolean_not":
      return {
        kind: "unary",
        operator: "!",
        value: parseExpression(babaRequiredRuleField(expression, "value"), offsets),
        span: offsets.span(expression.span),
      };
    case "bitwise_not":
      return {
        kind: "unary",
        operator: "~",
        value: parseExpression(babaRequiredRuleField(expression, "value"), offsets),
        span: offsets.span(expression.span),
      };
    case "typeof_expression":
    case "void_expression":
      return {
        kind: "unary",
        operator: expression.name === "typeof_expression" ? "typeof" : "void",
        value: parseExpression(babaRequiredRuleField(expression, "value"), offsets),
        span: offsets.span(expression.span),
      };
    case "await_expression": {
      const span = offsets.span(expression.span);
      return {
        kind: "property",
        value: parseExpression(babaRequiredRuleField(expression, "value"), offsets),
        name: "value",
        span,
      };
    }
    case "call": {
      let result = parseExpression(babaRequiredRuleField(expression, "callee"), offsets);
      for (const operationWrapper of babaRuleFieldArray(expression, "operations")) {
        const operation = operationWrapper.name === "postfix_operation"
          ? babaChildRule(operationWrapper)
          : operationWrapper;
        if (operation.name === "property_access") {
          result = {
            kind: "property",
            value: result,
            name: babaRequiredTokenField(operation, "name").text,
            span: offsets.span({ start: expression.span.start, end: operation.span.end }),
          };
          continue;
        }
        if (operation.name === "index_access") {
          result = {
            kind: "index",
            value: result,
            index: parseExpression(babaRequiredRuleField(operation, "index"), offsets),
            span: offsets.span({ start: expression.span.start, end: operation.span.end }),
          };
          continue;
        }
        const argumentsNode = babaOptionalRuleField(operation, "values");
        const arguments_ = argumentsNode === null
          ? []
          : listRules(argumentsNode).map((argument) => parseExpression(argument, offsets));
        result = {
          kind: "call",
          callee: result,
          arguments: arguments_,
          span: offsets.span({
            start: expression.span.start,
            end: operation.span.end,
          }),
        };
      }
      return result;
    }
    case "grouped_expression":
      return parseExpression(babaRequiredRuleField(expression, "body"), offsets);
    case "function_expression": {
      const parametersNode = babaOptionalRuleField(expression, "parameters");
      const parameters = parametersNode === null
        ? { names: [], initializers: [], functionLength: 0 }
        : parseParameterList(parametersNode, offsets);
      return {
        kind: "function",
        name: babaOptionalTokenField(expression, "name")?.text ?? null,
        thisMode: "dynamic",
        parameters: parameters.names,
        parameterLength: parameters.functionLength,
        body: insertParameterInitializers(
          parseBlock(babaRequiredRuleField(expression, "body"), offsets),
          parameters.initializers,
        ),
        span: offsets.span(expression.span),
      };
    }
    case "array_expression": {
      const valuesNode = babaOptionalRuleField(expression, "values");
      return {
        kind: "array",
        values: valuesNode === null
          ? []
          : listRules(valuesNode).map((value) => parseExpression(value, offsets)),
        span: offsets.span(expression.span),
      };
    }
    case "object_expression": {
      const properties = babaOptionalRuleField(expression, "properties");
      return {
        kind: "object",
        properties: properties === null ? [] : listRules(properties).map((property) => ({
          ...parseObjectProperty(property, offsets),
          span: offsets.span(property.span),
        })),
        span: offsets.span(expression.span),
      };
    }
    case "new_expression": {
      const argumentsNode = babaOptionalRuleField(expression, "arguments");
      const valuesNode = argumentsNode === null
        ? null
        : babaOptionalRuleField(argumentsNode, "values");
      return {
        kind: "new",
        constructor: babaRequiredTokenField(expression, "constructor").text,
        arguments: valuesNode === null
          ? []
          : listRules(valuesNode).map((value) => parseExpression(value, offsets)),
        span: offsets.span(expression.span),
      };
    }
    case "number_expression":
      return {
        kind: "number",
        value: Number(babaRequiredTokenField(expression, "value").text.replaceAll("_", "")),
        span: offsets.span(expression.span),
      };
    case "string_expression": {
      const token = babaRequiredTokenField(expression, "value");
      return {
        kind: "string",
        value: parseString(token.text, offsets.span(token.span)),
        raw: token.text,
        span: offsets.span(expression.span),
      };
    }
    case "boolean_expression":
      return {
        kind: "boolean",
        value: babaChildRule(expression).name === "truth",
        span: offsets.span(expression.span),
      };
    case "null_expression":
      return { kind: "null", span: offsets.span(expression.span) };
    case "named_expression":
      return {
        kind: "name",
        name: babaRequiredTokenField(expression, "name").text,
        span: offsets.span(expression.span),
      };
    default:
      throw new Error(`Unsupported Baba JavaScript expression node ${expression.name}.`);
  }
}

function parseObjectProperty(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): { readonly name: string; readonly value: JavaScriptAotExpression } {
  const property = babaChildRule(node);
  if (property.name === "shorthand_object_property") {
    const name = babaRequiredTokenField(property, "name");
    return {
      name: name.text,
      value: { kind: "name", name: name.text, span: offsets.span(name.span) },
    };
  }
  const propertyName = babaChildRule(babaRequiredRuleField(property, "name"));
  const nameToken = babaRequiredTokenField(propertyName, "value");
  const name = propertyName.name === "string_property_name"
    ? parseString(nameToken.text, offsets.span(nameToken.span))
    : propertyName.name === "number_property_name"
    ? String(Number(nameToken.text.replaceAll("_", "")))
    : nameToken.text;
  if (property.name === "object_method") {
    const parametersNode = babaOptionalRuleField(property, "parameters");
    const parameters = parametersNode === null
      ? { names: [], initializers: [], functionLength: 0 }
      : parseParameterList(parametersNode, offsets);
    return {
      name,
      value: {
        kind: "function",
        name: null,
        thisMode: "dynamic",
        parameters: parameters.names,
        parameterLength: parameters.functionLength,
        body: insertParameterInitializers(
          parseBlock(babaRequiredRuleField(property, "body"), offsets),
          parameters.initializers,
        ),
        span: offsets.span(property.span),
      },
    };
  }
  return {
    name,
    value: parseExpression(babaRequiredRuleField(property, "value"), offsets),
  };
}

function parseGeneratorBody(
  block: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): readonly JavaScriptAotStatement[] {
  const span = offsets.span(block.span);
  const yielded: JavaScriptAotExpression[] = [];
  let returned: JavaScriptAotExpression | null = null;
  for (const wrappedStatement of babaRuleFieldArray(block, "statements")) {
    const statement = wrappedStatement.name === "statement"
      ? babaChildRule(wrappedStatement)
      : wrappedStatement;
    if (statement.name === "empty_statement") continue;
    if (statement.name === "yield_statement") {
      if (returned !== null) {
        throw new JavaScriptAotSyntaxError(
          offsets.span(statement.span),
          "JavaScript generator yield cannot follow its final return.",
        );
      }
      const value = babaOptionalRuleField(statement, "value");
      yielded.push(
        value === null
          ? { kind: "name", name: "undefined", span: offsets.span(statement.span) }
          : parseExpression(value, offsets),
      );
      continue;
    }
    if (statement.name === "return_statement" && returned === null) {
      returned = parseOptionalReturnValue(statement, offsets);
      continue;
    }
    throw new JavaScriptAotSyntaxError(
      offsets.span(statement.span),
      "JavaScript AOT generators currently support only straight-line yield statements and one final return.",
    );
  }

  const stateName = `$javascript#generatorState#${span.startByte}`;
  const nextBody: JavaScriptAotStatement[] = [{
    kind: "assignment",
    name: stateName,
    operator: "=",
    value: {
      kind: "binary",
      operator: "+",
      left: { kind: "name", name: stateName, span },
      right: { kind: "number", value: 1, span },
      span,
    },
    span,
  }];
  let nextValue: JavaScriptAotExpression = { kind: "name", name: "undefined", span };
  if (returned !== null) {
    nextValue = {
      kind: "conditional",
      condition: {
        kind: "binary",
        operator: "===",
        left: { kind: "name", name: stateName, span },
        right: { kind: "number", value: yielded.length + 1, span },
        span,
      },
      consequent: returned,
      alternate: nextValue,
      span,
    };
  }
  for (let index = yielded.length - 1; index >= 0; index--) {
    nextValue = {
      kind: "conditional",
      condition: {
        kind: "binary",
        operator: "===",
        left: { kind: "name", name: stateName, span },
        right: { kind: "number", value: index + 1, span },
        span,
      },
      consequent: yielded[index]!,
      alternate: nextValue,
      span,
    };
  }
  nextBody.push({
    kind: "return",
    value: iteratorResult(nextValue, {
      kind: "binary",
      operator: ">",
      left: { kind: "name", name: stateName, span },
      right: { kind: "number", value: yielded.length, span },
      span,
    }, span),
    span,
  });
  return [{
    kind: "mutable",
    name: stateName,
    value: { kind: "number", value: 0, span },
    span,
  }, {
    kind: "return",
    value: {
      kind: "object",
      properties: [{
        name: "next",
        value: {
          kind: "function",
          name: null,
          thisMode: "dynamic",
          parameters: [],
          parameterLength: 0,
          body: nextBody,
          span,
        },
        span,
      }],
      span,
    },
    span,
  }];
}

function iteratorResult(
  value: JavaScriptAotExpression,
  done: boolean | JavaScriptAotExpression,
  span: JavaScriptAotExpression["span"],
): JavaScriptAotExpression {
  return {
    kind: "object",
    properties: [{ name: "value", value, span }, {
      name: "done",
      value: typeof done === "boolean" ? { kind: "boolean", value: done, span } : done,
      span,
    }],
    span,
  };
}

function transformAsyncBody(
  body: readonly JavaScriptAotStatement[],
  span: JavaScriptAotExpression["span"],
): readonly JavaScriptAotStatement[] {
  const transform = (statement: JavaScriptAotStatement): JavaScriptAotStatement => {
    switch (statement.kind) {
      case "return":
        return { ...statement, value: fulfilledPromise(statement.value, statement.span) };
      case "if":
        return {
          ...statement,
          consequent: statement.consequent.map(transform),
          alternate: statement.alternate?.map(transform) ?? null,
        };
      case "while":
        return {
          ...statement,
          body: statement.body.map(transform),
          continueBody: statement.continueBody.map(transform),
        };
      case "block":
        return { ...statement, statements: statement.statements.map(transform) };
      case "try":
        return {
          ...statement,
          body: statement.body.map(transform),
          catchBody: statement.catchBody?.map(transform) ?? null,
          finallyBody: statement.finallyBody?.map(transform) ?? null,
        };
      default:
        return statement;
    }
  };
  return [
    ...body.map(transform),
    {
      kind: "return",
      value: fulfilledPromise({ kind: "name", name: "undefined", span }, span),
      span,
    },
  ];
}

function fulfilledPromise(
  value: JavaScriptAotExpression,
  span: JavaScriptAotExpression["span"],
): JavaScriptAotExpression {
  return {
    kind: "object",
    properties: [{ name: "value", value, span }, {
      name: "then",
      value: {
        kind: "function",
        name: null,
        thisMode: "dynamic",
        parameters: ["resolve"],
        parameterLength: 1,
        body: [{
          kind: "return",
          value: {
            kind: "call",
            callee: { kind: "name", name: "resolve", span },
            arguments: [{
              kind: "property",
              value: { kind: "name", name: "this", span },
              name: "value",
              span,
            }],
            span,
          },
          span,
        }],
        span,
      },
      span,
    }],
    span,
  };
}

function parseOptionalReturnValue(
  statement: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): JavaScriptAotExpression {
  const value = babaOptionalRuleField(statement, "value");
  if (
    value === null ||
    /[\n\r\u2028\u2029]/.test(offsets.text({
      start: statement.span.start + "return".length,
      end: value.span.start,
    }))
  ) {
    return { kind: "name", name: "undefined", span: offsets.span(statement.span) };
  }
  return parseExpression(value, offsets);
}

function foldOperator(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
  operator: JavaScriptAotBinaryOperator,
): JavaScriptAotExpression {
  let result = parseExpression(babaRequiredRuleField(node, "left"), offsets);
  for (const tail of babaRuleFieldArray(node, "rest")) {
    const right = parseExpression(babaRequiredRuleField(tail, "right"), offsets);
    result = {
      kind: "binary",
      operator,
      left: result,
      right,
      span: offsets.span({ start: node.span.start, end: tail.span.end }),
    };
  }
  return result;
}

function foldNamedOperators(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): JavaScriptAotExpression {
  let result = parseExpression(babaRequiredRuleField(node, "left"), offsets);
  for (const tail of babaRuleFieldArray(node, "rest")) {
    const operator = babaChildRule(babaRequiredRuleField(tail, "op"));
    const right = parseExpression(babaRequiredRuleField(tail, "right"), offsets);
    result = {
      kind: "binary",
      operator: operatorText(operator.name),
      left: result,
      right,
      span: offsets.span({ start: node.span.start, end: tail.span.end }),
    };
  }
  return result;
}

function operatorText(name: string): JavaScriptAotBinaryOperator {
  switch (name) {
    case "plus":
      return "+";
    case "minus":
      return "-";
    case "star":
      return "*";
    case "slash":
      return "/";
    case "remainder":
      return "%";
    case "less":
      return "<";
    case "less_equal":
      return "<=";
    case "greater":
      return ">";
    case "greater_equal":
      return ">=";
    case "instanceof_operator":
      return "instanceof";
    case "shift_left":
      return "<<";
    case "shift_right":
      return ">>";
    case "shift_right_unsigned":
      return ">>>";
    case "strict_equal":
      return "===";
    case "strict_not_equal":
      return "!==";
    case "loose_equal":
      return "==";
    case "loose_not_equal":
      return "!=";
    default:
      throw new Error(`Unsupported Baba JavaScript operator node ${name}.`);
  }
}

function parseParameterList(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): {
  readonly names: readonly string[];
  readonly initializers: readonly JavaScriptAotStatement[];
  readonly functionLength: number;
} {
  const names: string[] = [];
  const initializers: JavaScriptAotStatement[] = [];
  let functionLength = 0;
  let foundDefault = false;
  let current: BabaRuleCursor | null = node;
  let parameterIndex = 0;
  while (current !== null) {
    const parameter = babaChildRule(babaRequiredRuleField(current, "head"));
    const tail = babaOptionalRuleField(current, "rest");
    const next = tail === null ? null : babaOptionalRuleField(tail, "rest");
    if (parameter.name === "rest_parameter") {
      if (parameterIndex !== 0 || next !== null) {
        throw new JavaScriptAotSyntaxError(
          offsets.span(parameter.span),
          "JavaScript AOT currently requires a rest parameter to be the function's only parameter.",
        );
      }
      const name = babaRequiredTokenField(parameter, "name").text;
      initializers.push({
        kind: "mutable",
        name,
        value: { kind: "name", name: "arguments", span: offsets.span(parameter.span) },
        span: offsets.span(parameter.span),
      });
      foundDefault = true;
      current = next;
      parameterIndex++;
      continue;
    }
    if (
      parameter.name === "array_binding_parameter" ||
      parameter.name === "object_binding_parameter"
    ) {
      const span = offsets.span(parameter.span);
      names.push(`$javascript#parameter#${span.startByte}`);
      if (!foundDefault) functionLength++;
      const argument = parameterArgumentExpression(parameterIndex, span);
      initializers.push({
        kind: "if",
        condition: {
          kind: "binary",
          operator: "||",
          left: {
            kind: "binary",
            operator: "===",
            left: argument,
            right: { kind: "null", span },
            span,
          },
          right: {
            kind: "binary",
            operator: "===",
            left: argument,
            right: { kind: "name", name: "undefined", span },
            span,
          },
          span,
        },
        consequent: [{
          kind: "throw",
          value: { kind: "new", constructor: "TypeError", arguments: [], span },
          span,
        }],
        alternate: null,
        span,
      });
      const bindings = babaOptionalRuleField(parameter, "bindings");
      if (bindings !== null) {
        if (parameter.name === "array_binding_parameter") {
          for (const [index, binding] of tokenList(bindings).entries()) {
            initializers.push({
              kind: "mutable",
              name: binding,
              value: {
                kind: "index",
                value: argument,
                index: { kind: "string", value: String(index), raw: null, span },
                span,
              },
              span,
            });
          }
        } else {
          for (const binding of listRules(bindings)) {
            const property = babaRequiredTokenField(binding, "property").text;
            const alias = babaOptionalRuleField(binding, "alias");
            initializers.push({
              kind: "mutable",
              name: alias === null ? property : babaRequiredTokenField(alias, "name").text,
              value: { kind: "property", value: argument, name: property, span },
              span,
            });
          }
        }
      }
      current = next;
      parameterIndex++;
      continue;
    }
    const name = babaRequiredTokenField(parameter, "name").text;
    names.push(name);
    if (parameter.name === "default_parameter") {
      foundDefault = true;
      const span = offsets.span(parameter.span);
      initializers.push({
        kind: "if",
        condition: {
          kind: "binary",
          operator: "===",
          left: { kind: "name", name, span },
          right: { kind: "name", name: "undefined", span },
          span,
        },
        consequent: [{
          kind: "assignment",
          name,
          operator: "=",
          value: parseExpression(babaRequiredRuleField(parameter, "value"), offsets),
          span,
        }],
        alternate: null,
        span,
      });
    } else if (!foundDefault) {
      functionLength++;
    }
    current = next;
    parameterIndex++;
  }
  return { names, initializers, functionLength };
}

function parameterArgumentExpression(
  index: number,
  span: JavaScriptAotExpression["span"],
): JavaScriptAotExpression {
  return {
    kind: "index",
    value: { kind: "name", name: "arguments", span },
    index: { kind: "string", value: String(index), raw: null, span },
    span,
  };
}

function insertParameterInitializers(
  body: readonly JavaScriptAotStatement[],
  initializers: readonly JavaScriptAotStatement[],
): readonly JavaScriptAotStatement[] {
  if (initializers.length === 0) return body;
  let directiveCount = 0;
  while (directiveCount < body.length) {
    const statement = body[directiveCount]!;
    if (statement.kind !== "expression" || statement.value.kind !== "string") break;
    directiveCount++;
  }
  return [
    ...body.slice(0, directiveCount),
    ...initializers,
    ...body.slice(directiveCount),
  ];
}

function listRules(node: BabaRuleCursor): readonly BabaRuleCursor[] {
  const values: BabaRuleCursor[] = [];
  let current: BabaRuleCursor | null = node;
  while (current !== null) {
    values.push(babaRequiredRuleField(current, "head"));
    const tail = babaOptionalRuleField(current, "rest");
    current = tail === null ? null : babaOptionalRuleField(tail, "rest");
  }
  return values;
}

function tokenList(node: BabaRuleCursor): readonly string[] {
  const values: string[] = [];
  let current: BabaRuleCursor | null = node;
  while (current !== null) {
    values.push(babaRequiredTokenField(current, "head").text);
    const tail = babaOptionalRuleField(current, "rest");
    current = tail === null ? null : babaOptionalRuleField(tail, "rest");
  }
  return values;
}

function variableDeclarators(node: BabaRuleCursor): readonly BabaRuleCursor[] {
  return [
    babaRequiredRuleField(node, "head"),
    ...babaRuleFieldArray(node, "tail").map((tail) => babaRequiredRuleField(tail, "value")),
  ];
}

function parseString(
  source: string,
  span: { readonly startByte: number; readonly endByte: number },
): string {
  let value = "";
  for (let index = 1; index < source.length - 1; index++) {
    const character = source[index]!;
    if (character !== "\\") {
      value += character;
      continue;
    }
    index++;
    const escaped = source[index];
    if (escaped === undefined) throw malformedString(span, "trailing escape");
    if (escaped === "\n") continue;
    if (escaped === "\r") {
      if (source[index + 1] === "\n") index++;
      continue;
    }
    const simpleEscape = ({
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
      "0": "\0",
    } as Readonly<Record<string, string>>)[escaped];
    if (simpleEscape !== undefined) {
      if (escaped === "0" && /[0-9]/.test(source[index + 1] ?? "")) {
        throw malformedString(span, "legacy octal escapes are not supported");
      }
      value += simpleEscape;
      continue;
    }
    if (escaped === "x") {
      const hex = source.slice(index + 1, index + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw malformedString(span, "invalid hexadecimal escape");
      value += String.fromCharCode(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    if (escaped === "u") {
      const braced = source[index + 1] === "{";
      const end = braced ? source.indexOf("}", index + 2) : index + 5;
      const hex = braced ? source.slice(index + 2, end) : source.slice(index + 1, end);
      if (end < 0 || !/^[0-9A-Fa-f]+$/.test(hex) || !braced && hex.length !== 4) {
        throw malformedString(span, "invalid Unicode escape");
      }
      const codePoint = Number.parseInt(hex, 16);
      if (codePoint > 0x10ffff) throw malformedString(span, `Unicode escape U+${hex} is too large`);
      value += String.fromCodePoint(codePoint);
      index = braced ? end : end - 1;
      continue;
    }
    if (/[1-9]/.test(escaped)) {
      throw malformedString(span, "legacy octal escapes are not supported");
    }
    value += escaped;
  }
  return value;
}

function malformedString(
  span: { readonly startByte: number; readonly endByte: number },
  reason: string,
): JavaScriptAotSyntaxError {
  return new JavaScriptAotSyntaxError(span, `JavaScript string literal is malformed: ${reason}.`);
}
