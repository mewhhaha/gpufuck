import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_MAXIMUM_CONSTRUCTOR_ARITY,
  LAZULI_MAXIMUM_PARSE_DEPTH,
  LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH,
  LAZULI_MAXIMUM_SURFACE_NODES,
  LAZULI_NO_INDEX,
  LAZULI_NODE_WORD_LENGTH,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliBinaryOperator,
  LazuliConstructorWord,
  LazuliDefinitionWord,
  type LazuliDiagnostic,
  type LazuliFrontendResult,
  type LazuliSpan,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
  LazuliTypeWord,
  LazuliUnaryOperator,
} from "./abi.ts";
import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";

type ParseResult = ReturnType<ReturnType<typeof createParser>["parse"]>;
type AnyRuleCursor = Extract<ParseResult, { readonly ok: true }>["cursor"];

interface Utf16Span {
  readonly start: number;
  readonly end: number;
}

interface Identifier {
  readonly spelling: string;
  readonly span: Utf16Span;
}

interface Definition {
  readonly name: Identifier;
  readonly parameters: readonly Identifier[];
  readonly body: Expression;
  readonly span: Utf16Span;
}

interface DataDeclaration {
  readonly name: Identifier;
  readonly constructors: readonly ConstructorDeclaration[];
  readonly span: Utf16Span;
}

interface ConstructorDeclaration {
  readonly name: Identifier;
  readonly fields: readonly Identifier[];
  readonly span: Utf16Span;
}

type Declaration = DataDeclaration | Definition;

interface CaseArm {
  readonly constructor: Identifier;
  readonly binders: readonly Identifier[];
  readonly body: Expression;
  readonly span: Utf16Span;
}

type Expression =
  | { readonly kind: "integer"; readonly text: string; readonly span: Utf16Span }
  | { readonly kind: "boolean"; readonly value: boolean; readonly span: Utf16Span }
  | { readonly kind: "name"; readonly identifier: Identifier; readonly span: Utf16Span }
  | {
    readonly kind: "let";
    readonly name: Identifier;
    readonly value: Expression;
    readonly body: Expression;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "let-rec";
    readonly name: Identifier;
    readonly parameter: Identifier;
    readonly value: Expression;
    readonly body: Expression;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "if";
    readonly condition: Expression;
    readonly consequent: Expression;
    readonly alternate: Expression;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "lambda";
    readonly parameter: Identifier;
    readonly body: Expression;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "apply";
    readonly callee: Expression;
    readonly argument: Expression;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "unary";
    readonly operator: number;
    readonly body: Expression;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "binary";
    readonly operator: number;
    readonly left: Expression;
    readonly right: Expression;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "case";
    readonly scrutinee: Expression;
    readonly arms: readonly CaseArm[];
    readonly span: Utf16Span;
  };

interface ExpressionSummary {
  readonly nodeCount: number;
  readonly maximumDepth: number;
  readonly integerDiagnostics: readonly LazuliDiagnostic[];
}

const minimumI32 = -2_147_483_648n;
const maximumI32 = 2_147_483_647n;
const minimumI32Magnitude = 2_147_483_648n;
const reservedIdentifierSpellings = new Set([
  "case",
  "data",
  "else",
  "end",
  "false",
  "fn",
  "fun",
  "if",
  "in",
  "let",
  "of",
  "rec",
  "then",
  "true",
]);

/** Parses Lazuli source into the stable surface-node ABI without resolving names. */
export function parseLazuliSource(source: string): LazuliFrontendResult {
  const byteOffsets = new Utf8ByteOffsets(source);
  if (byteOffsets.byteLength > LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH) {
    return failure(limitDiagnostic(
      `Source is ${byteOffsets.byteLength} bytes; the ABI limit is ${LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH}.`,
      { startByte: 0, endByte: byteOffsets.byteLength },
    ));
  }
  const parenthesisLimit = parenthesisDepthDiagnostic(source, byteOffsets);
  if (parenthesisLimit) return failure(parenthesisLimit);

  const symbols = new SymbolInterner();
  symbols.intern("main");
  const parser = createParser({
    bytes: Deno.readFileSync(
      new URL("../../language/lazuli/generated/wasm/parser.wasm", import.meta.url),
    ),
    plan: Deno.readFileSync(
      new URL("../../language/lazuli/generated/wasm/parser.plan", import.meta.url),
    ),
  });

  try {
    const parsed = parser.parse(source, { preserveTrivia: false });
    if (!parsed.ok) {
      if (parsed.diagnostics.length === 0) {
        throw new Error("Lazuli parser failed without diagnostics.");
      }
      const diagnostics = parsed.diagnostics.map((diagnostic): LazuliDiagnostic => ({
        stage: "parse",
        code: "L1001",
        message: `${diagnostic.code}: ${diagnostic.message}`,
        span: byteOffsets.span(diagnostic.span),
      }));
      return { ok: false, diagnostics: asNonemptyDiagnostics(diagnostics) };
    }

    let declarations: readonly Declaration[];
    try {
      declarations = parsed.cursor.children().filter(isRuleCursor).map((cursor) =>
        parseDeclaration(cursor, symbols)
      );
    } catch (error) {
      if (error instanceof ParseDepthLimit) {
        return failure(limitDiagnostic(error.message, byteOffsets.span(error.span)));
      }
      if (error instanceof ConstructorArityLimit) {
        return failure(limitDiagnostic(error.message, byteOffsets.span(error.span)));
      }
      if (error instanceof ReservedIdentifier) {
        return failure({
          stage: "parse",
          code: "L1001",
          message: `Reserved word ${
            JSON.stringify(error.spelling)
          } cannot be used as an identifier.`,
          span: byteOffsets.span(error.span),
        });
      }
      throw error;
    }
    const definitions = declarations.filter(isDefinition);
    const dataDeclarations = declarations.filter(isDataDeclaration);
    const summary = summarizeDefinitions(definitions, byteOffsets);
    if (summary.integerDiagnostics.length > 0) {
      return { ok: false, diagnostics: asNonemptyDiagnostics(summary.integerDiagnostics) };
    }
    if (summary.nodeCount > LAZULI_MAXIMUM_SURFACE_NODES) {
      return failure(limitDiagnostic(
        `Surface has ${summary.nodeCount} nodes; the ABI limit is ${LAZULI_MAXIMUM_SURFACE_NODES}.`,
        { startByte: 0, endByte: byteOffsets.byteLength },
      ));
    }
    if (summary.maximumDepth > LAZULI_MAXIMUM_PARSE_DEPTH) {
      return failure(limitDiagnostic(
        `Surface depth is ${summary.maximumDepth}; the ABI limit is ${LAZULI_MAXIMUM_PARSE_DEPTH}.`,
        { startByte: 0, endByte: byteOffsets.byteLength },
      ));
    }

    return {
      ok: true,
      surface: encodeSurface(definitions, dataDeclarations, symbols, byteOffsets),
    };
  } catch (error) {
    if (isCallStackOverflow(error)) {
      return failure(limitDiagnostic(
        `Source nesting exceeded the parser's stack-safe limit; the ABI depth limit is ${LAZULI_MAXIMUM_PARSE_DEPTH}.`,
        { startByte: 0, endByte: byteOffsets.byteLength },
      ));
    }
    if (isParserCapacityError(error)) {
      return failure(limitDiagnostic(
        `Source exceeds the generated parser's capacity: ${error.message}`,
        { startByte: 0, endByte: byteOffsets.byteLength },
      ));
    }
    throw error;
  } finally {
    parser.dispose();
  }
}

class ParseDepthLimit extends Error {
  constructor(readonly span: Utf16Span, depth: number) {
    super(`Surface depth is ${depth}; the ABI limit is ${LAZULI_MAXIMUM_PARSE_DEPTH}.`);
  }
}

class ConstructorArityLimit extends Error {
  constructor(readonly span: Utf16Span, name: string, arity: number) {
    super(
      `Constructor ${
        JSON.stringify(name)
      } has arity ${arity}; the ABI limit is ${LAZULI_MAXIMUM_CONSTRUCTOR_ARITY}.`,
    );
  }
}

class ReservedIdentifier extends Error {
  constructor(readonly span: Utf16Span, readonly spelling: string) {
    super(`Reserved word ${JSON.stringify(spelling)} cannot be used as an identifier.`);
  }
}

function ensureParseDepth(depth: number, span: Utf16Span): void {
  if (depth > LAZULI_MAXIMUM_PARSE_DEPTH) {
    throw new ParseDepthLimit(span, depth);
  }
}

function parenthesisDepthDiagnostic(
  source: string,
  byteOffsets: Utf8ByteOffsets,
): LazuliDiagnostic | null {
  let depth = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "-" && source[index + 1] === "-") {
      index += 2;
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index++;
      }
      continue;
    }
    if (source[index] === "(") {
      depth++;
      if (depth > LAZULI_MAXIMUM_PARSE_DEPTH) {
        return limitDiagnostic(
          `Parenthesis depth is ${depth}; the ABI limit is ${LAZULI_MAXIMUM_PARSE_DEPTH}.`,
          byteOffsets.span({ start: index, end: index + 1 }),
        );
      }
    } else if (source[index] === ")" && depth > 0) {
      depth--;
    }
  }
  return null;
}

function parseDeclaration(node: AnyRuleCursor, symbols: SymbolInterner): Declaration {
  const declaration = node.name === "declaration" ? childRule(node) : node;
  switch (declaration.name) {
    case "data_declaration":
      return parseDataDeclaration(declaration, symbols);
    case "definition":
      return parseDefinition(declaration, symbols);
    default:
      throw new Error(`Unsupported Lazuli declaration syntax node ${declaration.name}.`);
  }
}

function parseDataDeclaration(node: AnyRuleCursor, symbols: SymbolInterner): DataDeclaration {
  const name = identifier(requiredToken(node, "name"));
  symbols.intern(name.spelling);
  const constructors = ruleFieldArray(node, "constructors").map((constructor) =>
    parseConstructorDeclaration(constructor, symbols)
  );
  return { name, constructors, span: node.span };
}

function parseConstructorDeclaration(
  node: AnyRuleCursor,
  symbols: SymbolInterner,
): ConstructorDeclaration {
  if (node.name !== "constructor_declaration") {
    throw new Error(`Expected constructor declaration syntax node, got ${node.name}.`);
  }
  const name = identifier(requiredToken(node, "name"));
  symbols.intern(name.spelling);
  const fields = optionalRuleField(node, "fields");
  const fieldNames = fields ? parseIdentifierList(requiredRuleField(fields, "values")) : [];
  if (fieldNames.length > LAZULI_MAXIMUM_CONSTRUCTOR_ARITY) {
    throw new ConstructorArityLimit(node.span, name.spelling, fieldNames.length);
  }
  return { name, fields: fieldNames, span: node.span };
}

function parseDefinition(node: AnyRuleCursor, symbols: SymbolInterner): Definition {
  if (node.name !== "definition") {
    throw new Error(`Expected definition syntax node, got ${node.name}.`);
  }
  const name = identifier(requiredToken(node, "name"));
  symbols.intern(name.spelling);
  const parameters = tokenFieldArray(node, "params").map(identifier);
  for (const parameter of parameters) symbols.intern(parameter.spelling);
  const bodyDepth = parameters.length + 1;
  ensureParseDepth(bodyDepth, node.span);
  return {
    name,
    parameters,
    body: parseExpression(requiredRuleField(node, "body"), symbols, bodyDepth),
    span: node.span,
  };
}

function parseExpression(
  node: AnyRuleCursor,
  symbols: SymbolInterner,
  depth: number,
): Expression {
  ensureParseDepth(depth, node.span);
  switch (node.name) {
    case "expr":
    case "primary":
    case "unary":
    case "boolean":
      return parseExpression(childRule(node), symbols, depth);
    case "let_expr": {
      const name = identifier(requiredToken(node, "name"));
      symbols.intern(name.spelling);
      return {
        kind: "let",
        name,
        value: parseExpression(requiredRuleField(node, "value"), symbols, depth + 1),
        body: parseExpression(requiredRuleField(node, "body"), symbols, depth + 1),
        span: node.span,
      };
    }
    case "let_rec_expr": {
      const name = identifier(requiredToken(node, "name"));
      const parameter = identifier(requiredToken(node, "parameter"));
      symbols.intern(name.spelling);
      symbols.intern(parameter.spelling);
      return {
        kind: "let-rec",
        name,
        parameter,
        value: parseExpression(requiredRuleField(node, "value"), symbols, depth + 2),
        body: parseExpression(requiredRuleField(node, "body"), symbols, depth + 1),
        span: node.span,
      };
    }
    case "if_expr":
      return {
        kind: "if",
        condition: parseExpression(requiredRuleField(node, "condition"), symbols, depth + 1),
        consequent: parseExpression(requiredRuleField(node, "consequent"), symbols, depth + 1),
        alternate: parseExpression(requiredRuleField(node, "alternate"), symbols, depth + 1),
        span: node.span,
      };
    case "fun_expr": {
      const parameter = identifier(requiredToken(node, "param"));
      symbols.intern(parameter.spelling);
      return {
        kind: "lambda",
        parameter,
        body: parseExpression(requiredRuleField(node, "body"), symbols, depth + 1),
        span: node.span,
      };
    }
    case "case_expr":
      return {
        kind: "case",
        scrutinee: parseExpression(requiredRuleField(node, "scrutinee"), symbols, depth + 1),
        arms: ruleFieldArray(node, "arms").map((arm, index) =>
          parseCaseArm(arm, symbols, depth + 1 + index)
        ),
        span: node.span,
      };
    case "equality":
      return foldBinary(node, symbols, equalityOperator, depth);
    case "comparison":
      return foldBinary(node, symbols, comparisonOperator, depth);
    case "additive":
      return foldBinary(node, symbols, additiveOperator, depth);
    case "multiplicative":
      return foldBinary(node, symbols, multiplicativeOperator, depth);
    case "negate": {
      const body = parseExpression(requiredRuleField(node, "body"), symbols, depth + 1);
      if (body.kind === "integer" && BigInt(body.text) === minimumI32Magnitude) {
        return { kind: "integer", text: "-2147483648", span: node.span };
      }
      return {
        kind: "unary",
        operator: LazuliUnaryOperator.Negate,
        body,
        span: node.span,
      };
    }
    case "call":
      return parseCall(node, symbols, depth);
    case "integer":
      return {
        kind: "integer",
        text: requiredToken(node, "value").text,
        span: node.span,
      };
    case "truth":
      return { kind: "boolean", value: true, span: node.span };
    case "falsity":
      return { kind: "boolean", value: false, span: node.span };
    case "variable": {
      const name = identifier(requiredToken(node, "name"));
      symbols.intern(name.spelling);
      return { kind: "name", identifier: name, span: node.span };
    }
    case "group":
      return parseExpression(requiredRuleField(node, "body"), symbols, depth);
    default:
      throw new Error(`Unsupported Lazuli syntax node ${node.name}.`);
  }
}

function parseCaseArm(node: AnyRuleCursor, symbols: SymbolInterner, depth: number): CaseArm {
  if (node.name !== "case_arm") {
    throw new Error(`Expected case arm syntax node, got ${node.name}.`);
  }
  const pattern = requiredRuleField(node, "pattern");
  const constructor = identifier(requiredToken(pattern, "name"));
  symbols.intern(constructor.spelling);
  const bindersNode = optionalRuleField(pattern, "binders");
  const binders = bindersNode ? parseIdentifierList(requiredRuleField(bindersNode, "values")) : [];
  for (const binder of binders) symbols.intern(binder.spelling);
  return {
    constructor,
    binders,
    body: parseExpression(requiredRuleField(node, "body"), symbols, depth + 1 + binders.length),
    span: node.span,
  };
}

function parseIdentifierList(node: AnyRuleCursor): readonly Identifier[] {
  if (node.name !== "identifier_list") {
    throw new Error(`Expected identifier list syntax node, got ${node.name}.`);
  }
  return [
    identifier(requiredToken(node, "head")),
    ...ruleFieldArray(node, "tail").map((tail) => identifier(requiredToken(tail, "value"))),
  ];
}

function parseCall(node: AnyRuleCursor, symbols: SymbolInterner, depth: number): Expression {
  const callArguments = ruleFieldArray(node, "args");
  const argumentNodes: Array<{
    readonly node: AnyRuleCursor;
    readonly argumentsNode: AnyRuleCursor;
    readonly isFinal: boolean;
  }> = [];
  for (const argumentsNode of callArguments) {
    const values = requiredRuleField(argumentsNode, "values");
    const valuesInCall = [
      requiredRuleField(values, "head"),
      ...ruleFieldArray(values, "tail").map((tail) => requiredRuleField(tail, "value")),
    ];
    for (let index = 0; index < valuesInCall.length; index++) {
      const argument = valuesInCall[index];
      if (!argument) throw new Error("Call arguments unexpectedly omitted an argument.");
      argumentNodes.push({
        node: argument,
        argumentsNode,
        isFinal: index === valuesInCall.length - 1,
      });
    }
  }
  let callee = parseExpression(
    requiredRuleField(node, "callee"),
    symbols,
    depth + argumentNodes.length,
  );
  for (let index = 0; index < argumentNodes.length; index++) {
    const argumentEntry = argumentNodes[index];
    if (!argumentEntry) throw new Error("Call arguments unexpectedly omitted an argument.");
    const argument = parseExpression(
      argumentEntry.node,
      symbols,
      depth + argumentNodes.length - index,
    );
    callee = {
      kind: "apply",
      callee,
      argument,
      span: {
        start: callee.span.start,
        end: argumentEntry.isFinal ? argumentEntry.argumentsNode.span.end : argument.span.end,
      },
    };
  }
  return callee;
}

function foldBinary(
  node: AnyRuleCursor,
  symbols: SymbolInterner,
  operatorFromRule: (ruleName: string) => number,
  depth: number,
): Expression {
  const tails = ruleFieldArray(node, "rest");
  let left = parseExpression(requiredRuleField(node, "left"), symbols, depth + tails.length);
  for (let index = 0; index < tails.length; index++) {
    const tail = tails[index];
    if (!tail) throw new Error("Binary expression unexpectedly omitted an operator tail.");
    const operator = childRule(requiredRuleField(tail, "op"));
    const right = parseExpression(
      requiredRuleField(tail, "right"),
      symbols,
      depth + tails.length - index,
    );
    left = {
      kind: "binary",
      operator: operatorFromRule(operator.name),
      left,
      right,
      span: { start: left.span.start, end: right.span.end },
    };
  }
  return left;
}

function equalityOperator(ruleName: string): number {
  switch (ruleName) {
    case "eq":
      return LazuliBinaryOperator.Equal;
    case "ne":
      return LazuliBinaryOperator.NotEqual;
    default:
      throw new Error(`Unknown equality operator ${ruleName}.`);
  }
}

function comparisonOperator(ruleName: string): number {
  switch (ruleName) {
    case "lt":
      return LazuliBinaryOperator.Less;
    case "le":
      return LazuliBinaryOperator.LessEqual;
    case "gt":
      return LazuliBinaryOperator.Greater;
    case "ge":
      return LazuliBinaryOperator.GreaterEqual;
    default:
      throw new Error(`Unknown comparison operator ${ruleName}.`);
  }
}

function additiveOperator(ruleName: string): number {
  switch (ruleName) {
    case "plus":
      return LazuliBinaryOperator.Add;
    case "minus":
      return LazuliBinaryOperator.Subtract;
    default:
      throw new Error(`Unknown additive operator ${ruleName}.`);
  }
}

function multiplicativeOperator(ruleName: string): number {
  switch (ruleName) {
    case "star":
      return LazuliBinaryOperator.Multiply;
    case "slash":
      return LazuliBinaryOperator.Divide;
    default:
      throw new Error(`Unknown multiplicative operator ${ruleName}.`);
  }
}

function summarizeDefinitions(
  definitions: readonly Definition[],
  byteOffsets: Utf8ByteOffsets,
): ExpressionSummary {
  let nodeCount = 0;
  let maximumDepth = 0;
  const integerDiagnostics: LazuliDiagnostic[] = [];
  const pending: Array<{ expression: Expression; depth: number }> = [];

  for (const definition of definitions) {
    nodeCount += definition.parameters.length;
    pending.push({ expression: definition.body, depth: definition.parameters.length + 1 });
    maximumDepth = Math.max(maximumDepth, definition.parameters.length + 1);
  }

  while (pending.length > 0) {
    const next = pending.pop();
    if (!next) throw new Error("Expression traversal unexpectedly ended.");
    const { expression, depth } = next;
    nodeCount++;
    maximumDepth = Math.max(maximumDepth, depth);
    switch (expression.kind) {
      case "integer": {
        const value = BigInt(expression.text);
        if (value < minimumI32 || value > maximumI32) {
          integerDiagnostics.push({
            stage: "parse",
            code: "L1002",
            message: `Integer ${expression.text} is outside the signed i32 range.`,
            span: byteOffsets.span(expression.span),
          });
        }
        break;
      }
      case "boolean":
      case "name":
        break;
      case "let":
        pending.push({ expression: expression.body, depth: depth + 1 });
        pending.push({ expression: expression.value, depth: depth + 1 });
        break;
      case "let-rec":
        nodeCount++;
        maximumDepth = Math.max(maximumDepth, depth + 1);
        pending.push({ expression: expression.body, depth: depth + 1 });
        pending.push({ expression: expression.value, depth: depth + 2 });
        break;
      case "if":
        pending.push({ expression: expression.alternate, depth: depth + 1 });
        pending.push({ expression: expression.consequent, depth: depth + 1 });
        pending.push({ expression: expression.condition, depth: depth + 1 });
        break;
      case "lambda":
        pending.push({ expression: expression.body, depth: depth + 1 });
        break;
      case "apply":
        pending.push({ expression: expression.argument, depth: depth + 1 });
        pending.push({ expression: expression.callee, depth: depth + 1 });
        break;
      case "binary":
        pending.push({ expression: expression.right, depth: depth + 1 });
        pending.push({ expression: expression.left, depth: depth + 1 });
        break;
      case "unary":
        pending.push({ expression: expression.body, depth: depth + 1 });
        break;
      case "case":
        pending.push({ expression: expression.scrutinee, depth: depth + 1 });
        for (let index = 0; index < expression.arms.length; index++) {
          const arm = expression.arms[index];
          if (!arm) throw new Error("Case expression unexpectedly omitted an arm.");
          const armDepth = depth + 1 + index;
          nodeCount += 1 + arm.binders.length;
          maximumDepth = Math.max(maximumDepth, armDepth);
          pending.push({ expression: arm.body, depth: armDepth + 1 + arm.binders.length });
        }
        break;
    }
  }

  return { nodeCount, maximumDepth, integerDiagnostics };
}

function encodeSurface(
  definitions: readonly Definition[],
  dataDeclarations: readonly DataDeclaration[],
  symbols: SymbolInterner,
  byteOffsets: Utf8ByteOffsets,
): EncodedLazuliSurface {
  const encoder = new SurfaceEncoder(symbols, byteOffsets);
  const definitionWords: number[] = [];
  for (const definition of definitions) {
    let root: Expression = definition.body;
    for (let index = definition.parameters.length - 1; index >= 0; index--) {
      const parameter = definition.parameters[index];
      if (!parameter) throw new Error("Definition parameters unexpectedly omitted a parameter.");
      root = {
        kind: "lambda",
        parameter,
        body: root,
        span: definition.span,
      };
    }
    const rootNode = encoder.emitExpression(root, LAZULI_NO_INDEX);
    const span = byteOffsets.span(definition.span);
    const encodedDefinition = new Array<number>(4);
    encodedDefinition[LazuliDefinitionWord.Symbol] = symbols.id(definition.name.spelling);
    encodedDefinition[LazuliDefinitionWord.RootNode] = rootNode;
    encodedDefinition[LazuliDefinitionWord.StartByte] = span.startByte;
    encodedDefinition[LazuliDefinitionWord.EndByte] = span.endByte;
    definitionWords.push(...encodedDefinition);
  }
  const typeWords: number[] = [];
  const constructorWords: number[] = [];
  for (let typeIndex = 0; typeIndex < dataDeclarations.length; typeIndex++) {
    const declaration = dataDeclarations[typeIndex];
    if (!declaration) throw new Error("Data declaration unexpectedly omitted a declaration.");
    const span = byteOffsets.span(declaration.span);
    const firstConstructor = constructorWords.length / LAZULI_CONSTRUCTOR_WORD_LENGTH;
    const encodedType = new Array<number>(LAZULI_TYPE_WORD_LENGTH);
    encodedType[LazuliTypeWord.Symbol] = symbols.id(declaration.name.spelling);
    encodedType[LazuliTypeWord.FirstConstructor] = firstConstructor;
    encodedType[LazuliTypeWord.ConstructorCount] = declaration.constructors.length;
    encodedType[LazuliTypeWord.StartByte] = span.startByte;
    encodedType[LazuliTypeWord.EndByte] = span.endByte;
    typeWords.push(...encodedType);
    for (const constructor of declaration.constructors) {
      const constructorSpan = byteOffsets.span(constructor.span);
      const encodedConstructor = new Array<number>(LAZULI_CONSTRUCTOR_WORD_LENGTH);
      encodedConstructor[LazuliConstructorWord.Symbol] = symbols.id(constructor.name.spelling);
      encodedConstructor[LazuliConstructorWord.Type] = typeIndex;
      encodedConstructor[LazuliConstructorWord.Arity] = constructor.fields.length;
      encodedConstructor[LazuliConstructorWord.StartByte] = constructorSpan.startByte;
      encodedConstructor[LazuliConstructorWord.EndByte] = constructorSpan.endByte;
      constructorWords.push(...encodedConstructor);
    }
  }
  return {
    nodeWords: Uint32Array.from(encoder.words),
    definitionWords: Uint32Array.from(definitionWords),
    typeWords: Uint32Array.from(typeWords),
    constructorWords: Uint32Array.from(constructorWords),
    nodeCount: encoder.nodeCount,
    definitionCount: definitions.length,
    typeCount: dataDeclarations.length,
    constructorCount: constructorWords.length / LAZULI_CONSTRUCTOR_WORD_LENGTH,
    mainSymbol: symbols.id("main"),
    symbolNames: symbols.names,
  };
}

class SurfaceEncoder {
  readonly words: number[] = [];

  constructor(
    private readonly symbols: SymbolInterner,
    private readonly byteOffsets: Utf8ByteOffsets,
  ) {}

  get nodeCount(): number {
    return this.words.length / LAZULI_NODE_WORD_LENGTH;
  }

  emitExpression(expression: Expression, parent: number): number {
    switch (expression.kind) {
      case "integer":
        return this.emitNode(
          LazuliSurfaceTag.Integer,
          expression.span,
          Number(BigInt(expression.text)) >>> 0,
          [],
          parent,
        );
      case "boolean":
        return this.emitNode(
          LazuliSurfaceTag.Boolean,
          expression.span,
          expression.value ? 1 : 0,
          [],
          parent,
        );
      case "name":
        return this.emitName(expression.identifier, parent);
      case "let": {
        const node = this.reserveNode(
          LazuliSurfaceTag.Let,
          expression.span,
          this.symbols.id(expression.name.spelling),
          parent,
        );
        const value = this.emitExpression(expression.value, node);
        const body = this.emitExpression(expression.body, node);
        this.setChildren(node, [value, body]);
        return node;
      }
      case "let-rec": {
        const node = this.reserveNode(
          LazuliSurfaceTag.LetRec,
          expression.span,
          this.symbols.id(expression.name.spelling),
          parent,
        );
        const lambda = this.reserveNode(
          LazuliSurfaceTag.Lambda,
          { start: expression.name.span.start, end: expression.value.span.end },
          this.symbols.id(expression.parameter.spelling),
          node,
        );
        const value = this.emitExpression(expression.value, lambda);
        this.setChildren(lambda, [value]);
        const body = this.emitExpression(expression.body, node);
        this.setChildren(node, [lambda, body]);
        return node;
      }
      case "if": {
        const node = this.reserveNode(LazuliSurfaceTag.If, expression.span, 0, parent);
        const condition = this.emitExpression(expression.condition, node);
        const consequent = this.emitExpression(expression.consequent, node);
        const alternate = this.emitExpression(expression.alternate, node);
        this.setChildren(node, [condition, consequent, alternate]);
        return node;
      }
      case "lambda": {
        const node = this.reserveNode(
          LazuliSurfaceTag.Lambda,
          expression.span,
          this.symbols.id(expression.parameter.spelling),
          parent,
        );
        const body = this.emitExpression(expression.body, node);
        this.setChildren(node, [body]);
        return node;
      }
      case "apply": {
        const node = this.reserveNode(LazuliSurfaceTag.Apply, expression.span, 0, parent);
        const callee = this.emitExpression(expression.callee, node);
        const argument = this.emitExpression(expression.argument, node);
        this.setChildren(node, [callee, argument]);
        return node;
      }
      case "unary": {
        const node = this.reserveNode(
          LazuliSurfaceTag.Unary,
          expression.span,
          expression.operator,
          parent,
        );
        this.setChildren(node, [this.emitExpression(expression.body, node)]);
        return node;
      }
      case "binary": {
        const node = this.reserveNode(
          LazuliSurfaceTag.Binary,
          expression.span,
          expression.operator,
          parent,
        );
        const left = this.emitExpression(expression.left, node);
        const right = this.emitExpression(expression.right, node);
        this.setChildren(node, [left, right]);
        return node;
      }
      case "case": {
        const node = this.reserveNode(LazuliSurfaceTag.Case, expression.span, 0, parent);
        const scrutinee = this.emitExpression(expression.scrutinee, node);
        const firstArm = this.emitCaseArms(expression.arms, 0, node);
        this.setChildren(node, [scrutinee, firstArm]);
        return node;
      }
    }
  }

  private emitCaseArms(arms: readonly CaseArm[], index: number, parent: number): number {
    const arm = arms[index];
    if (!arm) return LAZULI_NO_INDEX;
    const node = this.reserveNode(
      LazuliSurfaceTag.CaseArm,
      arm.span,
      this.symbols.id(arm.constructor.spelling),
      parent,
    );
    const body = this.emitPatternBindings(arm.binders, arm.body, node);
    const nextArm = this.emitCaseArms(arms, index + 1, node);
    this.setChildren(node, [body, nextArm]);
    return node;
  }

  private emitPatternBindings(
    binders: readonly Identifier[],
    body: Expression,
    parent: number,
  ): number {
    let bindingParent = parent;
    let firstBinding = LAZULI_NO_INDEX;
    for (let index = binders.length - 1; index >= 0; index--) {
      const binder = binders[index];
      if (!binder) throw new Error("Pattern binders unexpectedly omitted a binder.");
      const binding = this.reserveNode(
        LazuliSurfaceTag.PatternBind,
        binder.span,
        this.symbols.id(binder.spelling),
        bindingParent,
      );
      if (firstBinding === LAZULI_NO_INDEX) firstBinding = binding;
      else this.setChildren(bindingParent, [binding]);
      bindingParent = binding;
    }
    const bodyNode = this.emitExpression(body, bindingParent);
    if (firstBinding === LAZULI_NO_INDEX) return bodyNode;
    this.setChildren(bindingParent, [bodyNode]);
    return firstBinding;
  }

  private emitName(identifier: Identifier, parent: number): number {
    return this.emitNode(
      LazuliSurfaceTag.Name,
      identifier.span,
      this.symbols.id(identifier.spelling),
      [],
      parent,
    );
  }

  private emitNode(
    tag: number,
    span: Utf16Span,
    payload: number,
    children: readonly number[],
    parent: number,
  ): number {
    const node = this.reserveNode(tag, span, payload, parent);
    this.setChildren(node, children);
    return node;
  }

  private reserveNode(tag: number, span: Utf16Span, payload: number, parent: number): number {
    const node = this.nodeCount;
    const byteSpan = this.byteOffsets.span(span);
    this.words.push(
      tag,
      byteSpan.startByte,
      byteSpan.endByte,
      payload,
      LAZULI_NO_INDEX,
      LAZULI_NO_INDEX,
      LAZULI_NO_INDEX,
      parent,
    );
    return node;
  }

  private setChildren(node: number, children: readonly number[]): void {
    if (children.length > 3) {
      throw new Error(`Surface node ${node} has ${children.length} children.`);
    }
    const offset = node * LAZULI_NODE_WORD_LENGTH + LazuliSurfaceWord.Child0;
    for (let index = 0; index < children.length; index++) {
      this.words[offset + index] = children[index] ?? LAZULI_NO_INDEX;
    }
  }
}

class SymbolInterner {
  private readonly identifiers = new Map<string, number>();
  private readonly orderedNames: string[] = [];

  get names(): readonly string[] {
    return this.orderedNames;
  }

  intern(spelling: string): number {
    const existing = this.identifiers.get(spelling);
    if (existing !== undefined) return existing;
    const symbol = this.orderedNames.length;
    this.identifiers.set(spelling, symbol);
    this.orderedNames.push(spelling);
    return symbol;
  }

  id(spelling: string): number {
    const symbol = this.identifiers.get(spelling);
    if (symbol === undefined) {
      throw new Error(`Identifier ${JSON.stringify(spelling)} was not interned.`);
    }
    return symbol;
  }

  find(spelling: string): number | undefined {
    return this.identifiers.get(spelling);
  }
}

class Utf8ByteOffsets {
  private readonly offsets: Uint32Array;

  constructor(source: string) {
    this.offsets = new Uint32Array(source.length + 1);
    let byteOffset = 0;
    for (let index = 0; index < source.length; index++) {
      this.offsets[index] = byteOffset;
      const codeUnit = source.charCodeAt(index);
      const nextCodeUnit = source.charCodeAt(index + 1);
      if (isHighSurrogate(codeUnit) && isLowSurrogate(nextCodeUnit)) {
        this.offsets[index + 1] = byteOffset;
        byteOffset += 4;
        index++;
      } else if (codeUnit <= 0x7f) {
        byteOffset++;
      } else if (codeUnit <= 0x7ff) {
        byteOffset += 2;
      } else {
        byteOffset += 3;
      }
    }
    this.offsets[source.length] = byteOffset;
  }

  get byteLength(): number {
    return this.offsets[this.offsets.length - 1] ?? 0;
  }

  span(span: Utf16Span): LazuliSpan {
    return {
      startByte: this.at(span.start),
      endByte: this.at(span.end),
    };
  }

  private at(utf16Offset: number): number {
    const clamped = Math.min(Math.max(0, utf16Offset), this.offsets.length - 1);
    return this.offsets[clamped] ?? 0;
  }
}

function identifier(token: { readonly text: string; readonly span: Utf16Span }): Identifier {
  if (reservedIdentifierSpellings.has(token.text)) {
    throw new ReservedIdentifier(token.span, token.text);
  }
  return { spelling: token.text, span: token.span };
}

function isCallStackOverflow(error: unknown): error is RangeError {
  return error instanceof RangeError && /maximum call stack size exceeded/i.test(error.message);
}

function isParserCapacityError(error: unknown): error is RangeError {
  return error instanceof RangeError &&
    /parser plan exceeds maximum memory pages/i.test(error.message);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function isRuleCursor(value: unknown): value is AnyRuleCursor {
  return !!value && typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "rule";
}

function isDefinition(declaration: Declaration): declaration is Definition {
  return "parameters" in declaration;
}

function isDataDeclaration(declaration: Declaration): declaration is DataDeclaration {
  return "constructors" in declaration;
}

function isTokenCursor(
  value: unknown,
): value is { readonly type: "token"; readonly text: string; readonly span: Utf16Span } {
  return !!value && typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "token" &&
    typeof (value as { readonly text?: unknown }).text === "string";
}

function childRule(node: AnyRuleCursor): AnyRuleCursor {
  const child = node.children().find(isRuleCursor);
  if (!child) throw new Error(`Expected a child rule on ${node.name}.`);
  return child;
}

function requiredRuleField(node: AnyRuleCursor, name: string): AnyRuleCursor {
  const value = node.field(name);
  if (!isRuleCursor(value)) {
    throw new Error(`Expected rule field ${name} on ${node.name}.`);
  }
  return value;
}

function optionalRuleField(node: AnyRuleCursor, name: string): AnyRuleCursor | null {
  const value = node.field(name);
  if (value === undefined || value === null) return null;
  if (!isRuleCursor(value)) {
    throw new Error(`Expected optional rule field ${name} on ${node.name}.`);
  }
  return value;
}

function requiredToken(
  node: AnyRuleCursor,
  name: string,
): { readonly type: "token"; readonly text: string; readonly span: Utf16Span } {
  const value = node.field(name);
  if (!isTokenCursor(value)) {
    throw new Error(`Expected token field ${name} on ${node.name}.`);
  }
  return value;
}

function ruleFieldArray(node: AnyRuleCursor, name: string): readonly AnyRuleCursor[] {
  const values = node.fieldArray(name);
  const rules: AnyRuleCursor[] = [];
  for (const value of values) {
    if (!isRuleCursor(value)) {
      throw new Error(`Expected rule array field ${name} on ${node.name}.`);
    }
    rules.push(value);
  }
  return rules;
}

function tokenFieldArray(
  node: AnyRuleCursor,
  name: string,
): readonly { readonly type: "token"; readonly text: string; readonly span: Utf16Span }[] {
  const values = node.fieldArray(name);
  const tokens: Array<{ readonly type: "token"; readonly text: string; readonly span: Utf16Span }> =
    [];
  for (const value of values) {
    if (!isTokenCursor(value)) {
      throw new Error(`Expected token array field ${name} on ${node.name}.`);
    }
    tokens.push(value);
  }
  return tokens;
}

function failure(diagnostic: LazuliDiagnostic): LazuliFrontendResult {
  return { ok: false, diagnostics: [diagnostic] };
}

function asNonemptyDiagnostics(
  diagnostics: readonly LazuliDiagnostic[],
): readonly [LazuliDiagnostic, ...LazuliDiagnostic[]] {
  const first = diagnostics[0];
  if (!first) throw new Error("Expected at least one diagnostic.");
  return [first, ...diagnostics.slice(1)];
}

function limitDiagnostic(message: string, span: LazuliSpan): LazuliDiagnostic {
  return { stage: "parse", code: "L1003", message, span };
}
