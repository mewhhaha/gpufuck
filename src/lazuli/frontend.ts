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
  type LazuliSourceType,
  type LazuliSpan,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
  type LazuliTypeSchema,
  LazuliTypeWord,
  LazuliUnaryOperator,
} from "./abi.ts";
import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";

type ParseResult = ReturnType<ReturnType<typeof createParser>["parse"]>;
type AnyRuleCursor = Extract<ParseResult, { readonly ok: true }>["cursor"];
type LazuliParser = ReturnType<typeof createParser>;

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
  readonly annotation: SourceType | null;
  readonly body: Expression;
  readonly span: Utf16Span;
}

interface DataDeclaration {
  readonly name: Identifier;
  readonly parameters: readonly Identifier[];
  readonly constructors: readonly ConstructorDeclaration[];
  readonly span: Utf16Span;
}

interface ConstDefinition {
  readonly kind: "const";
  readonly name: Identifier;
  readonly parameter: ConstParameter | null;
  readonly body: Expression;
  readonly span: Utf16Span;
}

type ConstParameter =
  | { readonly kind: "bind"; readonly name: Identifier; readonly span: Utf16Span }
  | {
    readonly kind: "tuple";
    readonly values: readonly [ConstParameter, ConstParameter];
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: Identifier;
      readonly value: ConstParameter;
    }[];
    readonly span: Utf16Span;
  };

type ConstDescriptor =
  | { readonly kind: "type"; readonly type: SourceType; readonly span: Utf16Span }
  | {
    readonly kind: "tuple";
    readonly values: readonly [ConstDescriptor, ConstDescriptor];
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "record";
    readonly fields: readonly {
      readonly name: Identifier;
      readonly value: ConstDescriptor;
    }[];
    readonly span: Utf16Span;
  }
  | { readonly kind: "hole"; readonly span: Utf16Span };

interface ConstructorDeclaration {
  readonly name: Identifier;
  readonly fields: readonly ConstructorField[];
  readonly result: SourceType | null;
  readonly span: Utf16Span;
}

interface ConstructorField {
  readonly name: Identifier;
  readonly type: SourceType;
}

type SourceType =
  | { readonly kind: "integer"; readonly span: Utf16Span }
  | { readonly kind: "boolean"; readonly span: Utf16Span }
  | { readonly kind: "unit"; readonly span: Utf16Span }
  | {
    readonly kind: "parameter";
    readonly name: string;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [SourceType, SourceType];
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "named";
    readonly name: string;
    readonly arguments: readonly SourceType[];
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "function";
    readonly parameter: SourceType;
    readonly result: SourceType;
    readonly span: Utf16Span;
  };

type Declaration = DataDeclaration | Definition | ConstDefinition;

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
    readonly kind: "const-instantiation";
    readonly name: Identifier;
    readonly argument: ConstDescriptor;
    readonly span: Utf16Span;
  }
  | {
    readonly kind: "record";
    readonly constructor: Identifier;
    readonly fields: readonly { readonly name: Identifier; readonly value: Expression }[];
    readonly span: Utf16Span;
  }
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
  "const",
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
const reservedBuiltinDeclarationNames = new Set([
  "List",
  "Nil",
  "Cons",
  "Bytes",
  "BytesNil",
  "BytesCons",
  "Text",
  "Utf8",
]);
// Baba snapshots each cursor tape, so sequential parses do not retain Wasm-backed cursors.
let lazuliParser: LazuliParser | undefined;

function getLazuliParser(): LazuliParser {
  if (lazuliParser !== undefined) return lazuliParser;

  lazuliParser = createParser({
    bytes: Deno.readFileSync(
      new URL("../../language/lazuli/generated/wasm/parser.wasm", import.meta.url),
    ),
    plan: Deno.readFileSync(
      new URL("../../language/lazuli/generated/wasm/parser.plan", import.meta.url),
    ),
  });
  return lazuliParser;
}

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
  const parser = getLazuliParser();

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
      if (error instanceof ReservedBuiltinDeclaration) {
        return failure({
          stage: "parse",
          code: "L1001",
          message: error.message,
          span: byteOffsets.span(error.span),
        });
      }
      if (error instanceof ApplicationSpacingError) {
        return failure({
          stage: "parse",
          code: "L1001",
          message: error.message,
          span: byteOffsets.span(error.span),
        });
      }
      if (error instanceof TypeApplicationError) {
        return failure({
          stage: "parse",
          code: "L1001",
          message: error.message,
          span: byteOffsets.span(error.span),
        });
      }
      if (error instanceof TypeApplicationSpacingError) {
        return failure({
          stage: "parse",
          code: "L1001",
          message: error.message,
          span: byteOffsets.span(error.span),
        });
      }
      if (error instanceof ConstSpecializationSpacingError) {
        return failure({
          stage: "parse",
          code: "L1001",
          message: error.message,
          span: byteOffsets.span(error.span),
        });
      }
      throw error;
    }
    let definitions: readonly Definition[] = declarations.filter(isDefinition);
    const dataDeclarations = [
      ...declarations.filter(isDataDeclaration),
      ...builtinDataDeclarations(source.length, symbols),
    ];
    const constDefinitions = declarations.filter(isConstDefinition);
    try {
      definitions = specializeConstDefinitions(
        definitions,
        constDefinitions,
        dataDeclarations,
        symbols,
      );
    } catch (error) {
      if (error instanceof ConstSpecializationError) {
        return failure({
          stage: "parse",
          code: "L1001",
          message: error.message,
          span: byteOffsets.span(error.span),
        });
      }
      throw error;
    }
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

class ReservedBuiltinDeclaration extends Error {
  constructor(readonly span: Utf16Span, name: string) {
    super(`Built-in name ${JSON.stringify(name)} cannot be declared in source.`);
  }
}

class ApplicationSpacingError extends Error {
  constructor(readonly span: Utf16Span) {
    super("Function application requires whitespace before its argument.");
  }
}

class TypeApplicationError extends Error {
  constructor(readonly span: Utf16Span) {
    super("Only named types can be applied to type arguments.");
  }
}

class TypeApplicationSpacingError extends Error {
  constructor(readonly span: Utf16Span) {
    super("Type application requires whitespace before its argument.");
  }
}

class ConstSpecializationSpacingError extends Error {
  constructor(readonly span: Utf16Span, name: string) {
    super(
      `Const specialization ${
        JSON.stringify(name)
      } requires whitespace before its @ type descriptor.`,
    );
  }
}

function builtinDataDeclarations(
  sourceEnd: number,
  symbols: SymbolInterner,
): readonly DataDeclaration[] {
  const span = { start: sourceEnd, end: sourceEnd };
  const parameter = (name: string): Identifier => ({ spelling: name, span });
  const named = (name: string, arguments_: readonly SourceType[] = []): SourceType => ({
    kind: "named",
    name,
    arguments: arguments_,
    span,
  });
  const field = (name: string, type: SourceType): ConstructorField => ({
    name: parameter(name),
    type,
  });
  const declaration = (
    typeName: string,
    parameters: readonly string[],
    constructors: readonly {
      readonly name: string;
      readonly fields: readonly ConstructorField[];
    }[],
  ): DataDeclaration => {
    symbols.intern(typeName);
    for (const constructor of constructors) symbols.intern(constructor.name);
    return {
      name: { spelling: typeName, span },
      parameters: parameters.map(parameter),
      constructors: constructors.map((constructor) => ({
        name: { spelling: constructor.name, span },
        fields: constructor.fields,
        result: null,
        span,
      })),
      span,
    };
  };
  const value = parameter("value");
  const first = parameter("first");
  const second = parameter("second");
  return [
    declaration("List", [value.spelling], [
      { name: "Nil", fields: [] },
      {
        name: "Cons",
        fields: [
          field("value", { kind: "parameter", name: value.spelling, span }),
          field("tail", named("List", [{ kind: "parameter", name: value.spelling, span }])),
        ],
      },
    ]),
    declaration("Bytes", [], [
      { name: "BytesNil", fields: [] },
      {
        name: "BytesCons",
        fields: [
          field("byte", { kind: "integer", span }),
          field("tail", named("Bytes")),
        ],
      },
    ]),
    declaration("Text", [], [
      { name: "Utf8", fields: [field("bytes", named("Bytes"))] },
    ]),
    declaration("$UnitType", [], [{ name: "$Unit", fields: [] }]),
    declaration("$TupleType", [first.spelling, second.spelling], [{
      name: "$Tuple",
      fields: [
        field("first", { kind: "parameter", name: first.spelling, span }),
        field("second", { kind: "parameter", name: second.spelling, span }),
      ],
    }]),
  ];
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
    case "let_declaration":
      return parseLetDeclaration(declaration, symbols);
    case "const_declaration":
      return parseConstDefinition(declaration, symbols);
    default:
      throw new Error(`Unsupported Lazuli declaration syntax node ${declaration.name}.`);
  }
}

function parseDataDeclaration(node: AnyRuleCursor, symbols: SymbolInterner): DataDeclaration {
  const name = identifier(requiredToken(node, "name"));
  rejectReservedBuiltinDeclaration(name);
  symbols.intern(name.spelling);
  const parameters = tokenFieldArray(node, "parameters").map(identifier);
  const constructorsNode = optionalRuleField(node, "constructors");
  const constructors = constructorsNode === null ? [] : [
    requiredRuleField(constructorsNode, "head"),
    ...ruleFieldArray(constructorsNode, "tail").map((tail) => requiredRuleField(tail, "value")),
  ].map((constructor) => parseConstructorDeclaration(constructor, symbols));
  return { name, parameters, constructors, span: node.span };
}

function parseConstructorDeclaration(
  node: AnyRuleCursor,
  symbols: SymbolInterner,
): ConstructorDeclaration {
  if (node.name !== "constructor_declaration") {
    throw new Error(`Expected constructor declaration syntax node, got ${node.name}.`);
  }
  const name = identifier(requiredToken(node, "name"));
  rejectReservedBuiltinDeclaration(name);
  symbols.intern(name.spelling);
  const fields = optionalRuleField(node, "fields");
  const constructorFields = fields
    ? parseConstructorFieldList(requiredRuleField(fields, "values"))
    : [];
  const result = optionalRuleField(node, "result");
  if (constructorFields.length > LAZULI_MAXIMUM_CONSTRUCTOR_ARITY) {
    throw new ConstructorArityLimit(node.span, name.spelling, constructorFields.length);
  }
  return {
    name,
    fields: constructorFields,
    result: result === null ? null : parseSourceType(requiredRuleField(result, "type")),
    span: node.span,
  };
}

function parseDefinition(node: AnyRuleCursor, symbols: SymbolInterner): Definition {
  if (node.name !== "definition") {
    throw new Error(`Expected definition syntax node, got ${node.name}.`);
  }
  const name = identifier(requiredToken(node, "name"));
  rejectReservedBuiltinDeclaration(name);
  symbols.intern(name.spelling);
  const parameters = tokenFieldArray(node, "params").map(identifier);
  for (const parameter of parameters) symbols.intern(parameter.spelling);
  const bodyDepth = parameters.length + 1;
  ensureParseDepth(bodyDepth, node.span);
  return {
    name,
    parameters,
    annotation: null,
    body: parseExpression(requiredRuleField(node, "body"), symbols, bodyDepth),
    span: node.span,
  };
}

function parseLetDeclaration(node: AnyRuleCursor, symbols: SymbolInterner): Definition {
  if (node.name !== "let_declaration") {
    throw new Error(`Expected let declaration syntax node, got ${node.name}.`);
  }
  const name = identifier(requiredToken(node, "name"));
  rejectReservedBuiltinDeclaration(name);
  symbols.intern(name.spelling);
  const annotation = optionalRuleField(node, "annotation");
  return {
    name,
    parameters: [],
    annotation: annotation === null ? null : parseSourceType(requiredRuleField(annotation, "type")),
    body: parseExpression(requiredRuleField(node, "body"), symbols, 1),
    span: node.span,
  };
}

function parseConstDefinition(node: AnyRuleCursor, symbols: SymbolInterner): ConstDefinition {
  if (node.name !== "const_declaration") {
    throw new Error(`Expected const declaration syntax node, got ${node.name}.`);
  }
  const name = identifier(requiredToken(node, "name"));
  rejectReservedBuiltinDeclaration(name);
  const parameterNode = optionalRuleField(node, "parameter");
  const parameter = parameterNode === null ? null : parseConstParameter(parameterNode);
  return {
    kind: "const",
    name,
    parameter,
    body: parseExpression(requiredRuleField(node, "body"), symbols, 1),
    span: node.span,
  };
}

function parseConstParameter(node: AnyRuleCursor): ConstParameter {
  const parameter = node.name === "const_parameter" ? childRule(node) : node;
  if (parameter.name === "const_parameter_bind") {
    return {
      kind: "bind",
      name: identifier(requiredToken(parameter, "name")),
      span: parameter.span,
    };
  }
  if (parameter.name === "const_parameter_tuple") {
    return {
      kind: "tuple",
      values: [
        parseConstParameter(requiredRuleField(parameter, "first")),
        parseConstParameter(requiredRuleField(parameter, "second")),
      ],
      span: parameter.span,
    };
  }
  if (parameter.name === "const_parameter_record") {
    const fields = requiredRuleField(parameter, "fields");
    const fieldNodes = [
      requiredRuleField(fields, "head"),
      ...ruleFieldArray(fields, "tail").map((tail) => requiredRuleField(tail, "value")),
    ];
    return {
      kind: "record",
      fields: fieldNodes.map((field) => ({
        name: identifier(requiredToken(field, "name")),
        value: parseConstParameter(requiredRuleField(field, "value")),
      })),
      span: parameter.span,
    };
  }
  throw new Error(`Unsupported const parameter syntax node ${parameter.name}.`);
}

function parseConstructorFieldList(node: AnyRuleCursor): readonly ConstructorField[] {
  if (node.name !== "constructor_field_list") {
    throw new Error(`Expected constructor field list syntax node, got ${node.name}.`);
  }
  return [
    requiredRuleField(node, "head"),
    ...ruleFieldArray(node, "tail").map((tail) => requiredRuleField(tail, "value")),
  ].map(parseConstructorField);
}

function parseConstructorField(node: AnyRuleCursor): ConstructorField {
  if (node.name !== "constructor_field") {
    throw new Error(`Expected constructor field syntax node, got ${node.name}.`);
  }
  return {
    name: identifier(requiredToken(node, "name")),
    type: parseSourceType(requiredRuleField(node, "type")),
  };
}

function parseSourceType(node: AnyRuleCursor): SourceType {
  if (node.name !== "source_type") {
    throw new Error(`Expected source type syntax node, got ${node.name}.`);
  }
  const left = parseTypeApplication(requiredRuleField(node, "left"));
  const tail = optionalRuleField(node, "tail");
  if (tail === null) return withTypeSpan(left, node.span);
  return {
    kind: "function",
    parameter: left,
    result: parseSourceType(requiredRuleField(tail, "result")),
    span: node.span,
  };
}

function parseTypeApplication(node: AnyRuleCursor): SourceType {
  if (node.name !== "type_application") {
    throw new Error(`Expected type application syntax node, got ${node.name}.`);
  }
  const calleeNode = requiredRuleField(node, "callee");
  const callee = parseTypeAtom(calleeNode);
  const argumentNodes = ruleFieldArray(node, "arguments");
  let previousTokenEnd = lastTokenEnd(calleeNode);
  const arguments_ = argumentNodes.map((argument) => {
    if (argument.span.start <= previousTokenEnd) {
      throw new TypeApplicationSpacingError(argument.span);
    }
    previousTokenEnd = lastTokenEnd(argument);
    return parseTypeAtom(argument);
  });
  if (arguments_.length === 0) return withTypeSpan(callee, node.span);
  if (callee.kind !== "named") {
    throw new TypeApplicationError(node.span);
  }
  return { ...callee, arguments: arguments_, span: node.span };
}

function parseTypeAtom(node: AnyRuleCursor): SourceType {
  const atom = node.name === "type_atom" ? childRule(node) : node;
  switch (atom.name) {
    case "type_named": {
      const name = identifier(requiredToken(atom, "name"));
      if (name.spelling === "Int") return { kind: "integer", span: atom.span };
      if (name.spelling === "Bool") return { kind: "boolean", span: atom.span };
      return { kind: "named", name: name.spelling, arguments: [], span: atom.span };
    }
    case "type_unit":
      return { kind: "unit", span: atom.span };
    case "type_tuple":
      return {
        kind: "tuple",
        values: [
          parseSourceType(requiredRuleField(atom, "first")),
          parseSourceType(requiredRuleField(atom, "second")),
        ],
        span: atom.span,
      };
    case "type_group":
      return withTypeSpan(parseSourceType(requiredRuleField(atom, "body")), atom.span);
    default:
      throw new Error(`Unsupported Lazuli type syntax node ${atom.name}.`);
  }
}

function withTypeSpan(type: SourceType, span: Utf16Span): SourceType {
  return { ...type, span };
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
    case "arrow_expr": {
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
    case "string": {
      const token = requiredToken(node, "value");
      const bytes = new TextEncoder().encode(token.text.slice(1, -1));
      let byteList = constructorExpression("BytesNil", [], node.span, symbols);
      for (let byteIndex = bytes.length - 1; byteIndex >= 0; byteIndex--) {
        const byte = bytes[byteIndex];
        if (byte === undefined) throw new Error(`UTF-8 text omitted byte ${byteIndex}.`);
        byteList = constructorExpression(
          "BytesCons",
          [{ kind: "integer", text: byte.toString(), span: node.span }, byteList],
          node.span,
          symbols,
        );
      }
      return constructorExpression("Utf8", [byteList], node.span, symbols);
    }
    case "list": {
      const valuesNode = optionalRuleField(node, "values");
      const values = valuesNode === null ? [] : [
        requiredRuleField(valuesNode, "head"),
        ...ruleFieldArray(valuesNode, "tail").map((tail) => requiredRuleField(tail, "value")),
      ].map((value) => parseExpression(value, symbols, depth + 1));
      let list = constructorExpression("Nil", [], node.span, symbols);
      for (let valueIndex = values.length - 1; valueIndex >= 0; valueIndex--) {
        const value = values[valueIndex];
        if (value === undefined) throw new Error(`List literal omitted value ${valueIndex}.`);
        list = constructorExpression("Cons", [value, list], node.span, symbols);
      }
      return list;
    }
    case "named": {
      const nameToken = requiredToken(node, "name");
      const constructor = identifier(nameToken);
      symbols.intern(constructor.spelling);
      const suffixNode = optionalRuleField(node, "suffix");
      if (suffixNode === null) {
        return { kind: "name", identifier: constructor, span: node.span };
      }
      const suffix = childRule(suffixNode);
      if (suffix.name === "const_instantiation") {
        if (suffix.span.start <= nameToken.span.end) {
          throw new ConstSpecializationSpacingError(suffix.span, constructor.spelling);
        }
        return {
          kind: "const-instantiation",
          name: constructor,
          argument: parseConstDescriptor(requiredRuleField(suffix, "argument")),
          span: node.span,
        };
      }
      if (suffix.name !== "record") {
        throw new Error(`Unsupported Lazuli named suffix ${suffix.name}.`);
      }
      const fieldsNode = optionalRuleField(suffix, "fields");
      const fieldNodes = fieldsNode === null ? [] : [
        requiredRuleField(fieldsNode, "head"),
        ...ruleFieldArray(fieldsNode, "tail").map((tail) => requiredRuleField(tail, "value")),
      ];
      const fields = fieldNodes.map((field) => ({
        name: identifier(requiredToken(field, "name")),
        value: parseExpression(requiredRuleField(field, "value"), symbols, depth + 1),
      }));
      return { kind: "record", constructor, fields, span: node.span };
    }
    case "truth":
      return { kind: "boolean", value: true, span: node.span };
    case "falsity":
      return { kind: "boolean", value: false, span: node.span };
    case "unit":
      return constructorExpression("$Unit", [], node.span, symbols);
    case "tuple":
      return constructorExpression(
        "$Tuple",
        [
          parseExpression(requiredRuleField(node, "first"), symbols, depth + 1),
          parseExpression(requiredRuleField(node, "second"), symbols, depth + 1),
        ],
        node.span,
        symbols,
      );
    case "group":
      return parseExpression(requiredRuleField(node, "body"), symbols, depth);
    default:
      throw new Error(`Unsupported Lazuli syntax node ${node.name}.`);
  }
}

function constructorExpression(
  name: string,
  arguments_: readonly Expression[],
  span: Utf16Span,
  symbols: SymbolInterner,
): Expression {
  const identifier: Identifier = { spelling: name, span };
  symbols.intern(name);
  let expression: Expression = { kind: "name", identifier, span };
  for (const argument of arguments_) {
    expression = { kind: "apply", callee: expression, argument, span };
  }
  return expression;
}

function parseCaseArm(node: AnyRuleCursor, symbols: SymbolInterner, depth: number): CaseArm {
  if (node.name !== "case_arm") {
    throw new Error(`Expected case arm syntax node, got ${node.name}.`);
  }
  const pattern = childRule(requiredRuleField(node, "pattern"));
  let constructor: Identifier;
  let binders: readonly Identifier[];
  if (pattern.name === "tuple_pattern") {
    constructor = { spelling: "$Tuple", span: pattern.span };
    binders = [
      identifier(requiredToken(pattern, "first")),
      identifier(requiredToken(pattern, "second")),
    ];
  } else if (pattern.name === "unit_pattern") {
    constructor = { spelling: "$Unit", span: pattern.span };
    binders = [];
  } else if (pattern.name === "constructor_pattern") {
    constructor = identifier(requiredToken(pattern, "name"));
    const bindersNode = optionalRuleField(pattern, "binders");
    binders = bindersNode ? parseIdentifierList(requiredRuleField(bindersNode, "values")) : [];
  } else {
    throw new Error(`Unsupported Lazuli case pattern ${pattern.name}.`);
  }
  symbols.intern(constructor.spelling);
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

function parseConstDescriptor(node: AnyRuleCursor): ConstDescriptor {
  const descriptor = node.name === "const_descriptor" ? childRule(node) : node;
  if (descriptor.name === "const_descriptor_hole") {
    return { kind: "hole", span: descriptor.span };
  }
  if (descriptor.name === "const_descriptor_tuple") {
    return {
      kind: "tuple",
      values: [
        parseConstDescriptor(requiredRuleField(descriptor, "first")),
        parseConstDescriptor(requiredRuleField(descriptor, "second")),
      ],
      span: descriptor.span,
    };
  }
  if (descriptor.name === "const_descriptor_record") {
    const fields = requiredRuleField(descriptor, "fields");
    const fieldNodes = [
      requiredRuleField(fields, "head"),
      ...ruleFieldArray(fields, "tail").map((tail) => requiredRuleField(tail, "value")),
    ];
    return {
      kind: "record",
      fields: fieldNodes.map((field) => ({
        name: identifier(requiredToken(field, "name")),
        value: parseConstDescriptor(requiredRuleField(field, "value")),
      })),
      span: descriptor.span,
    };
  }
  if (
    descriptor.name === "type_named" || descriptor.name === "type_unit" ||
    descriptor.name === "type_group"
  ) {
    return {
      kind: "type",
      type: parseTypeAtom(descriptor),
      span: descriptor.span,
    };
  }
  throw new Error(`Unsupported const descriptor syntax node ${descriptor.name}.`);
}

function parseCall(node: AnyRuleCursor, symbols: SymbolInterner, depth: number): Expression {
  const callArguments = ruleFieldArray(node, "args");
  const calleeNode = requiredRuleField(node, "callee");
  let callee = parseExpression(
    calleeNode,
    symbols,
    depth + callArguments.length,
  );
  let previousTokenEnd = lastTokenEnd(calleeNode);
  for (let index = 0; index < callArguments.length; index++) {
    const argumentEntry = callArguments[index];
    if (!argumentEntry) throw new Error("Call arguments unexpectedly omitted an argument.");
    const argumentNode = requiredRuleField(argumentEntry, "value");
    if (argumentNode.span.start <= previousTokenEnd) {
      throw new ApplicationSpacingError(argumentNode.span);
    }
    const argument = parseExpression(
      argumentNode,
      symbols,
      depth + callArguments.length - index,
    );
    callee = {
      kind: "apply",
      callee,
      argument,
      span: {
        start: callee.span.start,
        end: argumentNode.span.end,
      },
    };
    previousTokenEnd = lastTokenEnd(argumentNode);
  }
  return callee;
}

function lastTokenEnd(node: AnyRuleCursor): number {
  let end = node.span.start;
  const pending: AnyRuleCursor[] = [node];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) throw new Error("Syntax traversal unexpectedly ended.");
    for (const child of current.children()) {
      if (isRuleCursor(child)) {
        pending.push(child);
      } else if (isTokenCursor(child)) {
        end = Math.max(end, child.span.end);
      }
    }
  }
  return end;
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

class ConstSpecializationError extends Error {
  constructor(readonly span: Utf16Span, message: string) {
    super(message);
  }
}

function specializeConstDefinitions(
  definitions: readonly Definition[],
  constDefinitions: readonly ConstDefinition[],
  dataDeclarations: readonly DataDeclaration[],
  symbols: SymbolInterner,
): readonly Definition[] {
  const templates = new Map<string, ConstDefinition>();
  for (const definition of constDefinitions) {
    if (templates.has(definition.name.spelling)) {
      throw new ConstSpecializationError(
        definition.name.span,
        `Duplicate const declaration ${JSON.stringify(definition.name.spelling)}.`,
      );
    }
    validateConstParameter(definition);
    templates.set(definition.name.spelling, definition);
  }
  const types = new Map(
    dataDeclarations.map((declaration) => [declaration.name.spelling, declaration]),
  );
  const constructors = new Map<string, ConstructorDeclaration>();
  for (const declaration of dataDeclarations) {
    for (const constructor of declaration.constructors) {
      if (!constructors.has(constructor.name.spelling)) {
        constructors.set(constructor.name.spelling, constructor);
      }
    }
  }
  const runtimeNames = new Set(definitions.map((definition) => definition.name.spelling));
  const specializations = new Map<string, Identifier>();
  const generated: Definition[] = [];

  const instantiate = (
    name: Identifier,
    argument: ConstDescriptor | null,
    descriptors: ReadonlyMap<string, ConstDescriptor>,
    span: Utf16Span,
  ): Expression => {
    const template = templates.get(name.spelling);
    if (template === undefined) {
      throw new ConstSpecializationError(
        span,
        `Unknown const declaration ${JSON.stringify(name.spelling)}.`,
      );
    }
    if (template.parameter === null && argument !== null) {
      throw new ConstSpecializationError(
        span,
        `Const ${JSON.stringify(name.spelling)} does not accept a type descriptor.`,
      );
    }
    if (template.parameter !== null && argument === null) {
      throw new ConstSpecializationError(
        span,
        `Const ${JSON.stringify(name.spelling)} requires one type descriptor after @.`,
      );
    }
    const resolvedArgument = argument === null
      ? null
      : resolveConstDescriptor(argument, descriptors, types);
    const key = resolvedArgument === null
      ? name.spelling
      : `${name.spelling}@${constDescriptorStructuralKey(resolvedArgument)}`;
    let generatedName = specializations.get(key);
    if (generatedName === undefined) {
      generatedName = { spelling: `$const$${specializations.size}`, span: template.name.span };
      symbols.intern(generatedName.spelling);
      specializations.set(key, generatedName);
      const generatedIndex = generated.length;
      generated.push({
        name: generatedName,
        parameters: [],
        annotation: null,
        body: { kind: "boolean", value: false, span: template.span },
        span: template.span,
      });
      const templateDescriptors = new Map<string, ConstDescriptor>();
      if (template.parameter !== null && resolvedArgument !== null) {
        bindConstParameter(
          template.name.spelling,
          template.parameter,
          resolvedArgument,
          templateDescriptors,
        );
      }
      generated[generatedIndex] = {
        name: generatedName,
        parameters: [],
        annotation: null,
        body: expand(template.body, templateDescriptors, new Set()),
        span: template.span,
      };
    }
    return { kind: "name", identifier: generatedName, span };
  };

  const expand = (
    expression: Expression,
    descriptors: ReadonlyMap<string, ConstDescriptor>,
    boundNames: ReadonlySet<string>,
  ): Expression => {
    const withBoundName = (name: string): ReadonlySet<string> => {
      const next = new Set(boundNames);
      next.add(name);
      return next;
    };
    switch (expression.kind) {
      case "integer":
      case "boolean":
        return expression;
      case "name": {
        const template = templates.get(expression.identifier.spelling);
        if (
          template !== undefined && !boundNames.has(expression.identifier.spelling) &&
          !runtimeNames.has(expression.identifier.spelling)
        ) {
          if (template.parameter === null) {
            return instantiate(expression.identifier, null, descriptors, expression.span);
          }
          throw new ConstSpecializationError(
            expression.span,
            `Const ${
              JSON.stringify(expression.identifier.spelling)
            } requires one type descriptor after @.`,
          );
        }
        return expression;
      }
      case "const-instantiation":
        return instantiate(expression.name, expression.argument, descriptors, expression.span);
      case "record": {
        const constructor = constructors.get(expression.constructor.spelling);
        if (constructor === undefined) {
          throw new ConstSpecializationError(
            expression.constructor.span,
            `Unknown record constructor ${JSON.stringify(expression.constructor.spelling)}.`,
          );
        }
        const suppliedFields = new Map<string, Expression>();
        for (const field of expression.fields) {
          if (suppliedFields.has(field.name.spelling)) {
            throw new ConstSpecializationError(
              field.name.span,
              `Record ${JSON.stringify(expression.constructor.spelling)} repeats field ${
                JSON.stringify(field.name.spelling)
              }.`,
            );
          }
          suppliedFields.set(field.name.spelling, field.value);
        }
        const orderedValues = constructor.fields.map((field) => {
          const value = suppliedFields.get(field.name.spelling);
          if (value === undefined) {
            throw new ConstSpecializationError(
              expression.span,
              `Record ${JSON.stringify(expression.constructor.spelling)} is missing field ${
                JSON.stringify(field.name.spelling)
              }.`,
            );
          }
          suppliedFields.delete(field.name.spelling);
          return expand(value, descriptors, boundNames);
        });
        const unknownField = suppliedFields.keys().next().value;
        if (typeof unknownField === "string") {
          throw new ConstSpecializationError(
            expression.span,
            `Record ${JSON.stringify(expression.constructor.spelling)} has unknown field ${
              JSON.stringify(unknownField)
            }.`,
          );
        }
        return constructorExpression(
          expression.constructor.spelling,
          orderedValues,
          expression.span,
          symbols,
        );
      }
      case "let":
        return {
          ...expression,
          value: expand(expression.value, descriptors, boundNames),
          body: expand(
            expression.body,
            descriptors,
            withBoundName(expression.name.spelling),
          ),
        };
      case "let-rec": {
        const recursiveNames = new Set(boundNames);
        recursiveNames.add(expression.name.spelling);
        recursiveNames.add(expression.parameter.spelling);
        return {
          ...expression,
          value: expand(expression.value, descriptors, recursiveNames),
          body: expand(
            expression.body,
            descriptors,
            withBoundName(expression.name.spelling),
          ),
        };
      }
      case "if":
        return {
          ...expression,
          condition: expand(expression.condition, descriptors, boundNames),
          consequent: expand(expression.consequent, descriptors, boundNames),
          alternate: expand(expression.alternate, descriptors, boundNames),
        };
      case "lambda":
        return {
          ...expression,
          body: expand(
            expression.body,
            descriptors,
            withBoundName(expression.parameter.spelling),
          ),
        };
      case "apply":
        return {
          ...expression,
          callee: expand(expression.callee, descriptors, boundNames),
          argument: expand(expression.argument, descriptors, boundNames),
        };
      case "unary":
        return { ...expression, body: expand(expression.body, descriptors, boundNames) };
      case "binary":
        return {
          ...expression,
          left: expand(expression.left, descriptors, boundNames),
          right: expand(expression.right, descriptors, boundNames),
        };
      case "case":
        return {
          ...expression,
          scrutinee: expand(expression.scrutinee, descriptors, boundNames),
          arms: expression.arms.map((arm) => {
            const armNames = new Set(boundNames);
            for (const binder of arm.binders) armNames.add(binder.spelling);
            return { ...arm, body: expand(arm.body, descriptors, armNames) };
          }),
        };
    }
  };

  const expandedDefinitions = definitions.map((definition) => {
    const boundNames = new Set(definition.parameters.map((parameter) => parameter.spelling));
    return { ...definition, body: expand(definition.body, new Map(), boundNames) };
  });
  return [...expandedDefinitions, ...generated].sort((left, right) =>
    left.span.start - right.span.start || left.span.end - right.span.end
  );
}

function validateConstParameter(definition: ConstDefinition): void {
  if (definition.parameter === null) return;
  const names = new Set<string>();
  const pending = [definition.parameter];
  while (pending.length > 0) {
    const parameter = pending.pop();
    if (parameter === undefined) throw new Error("Const parameter traversal ended unexpectedly.");
    if (parameter.kind === "bind") {
      if (names.has(parameter.name.spelling)) {
        throw new ConstSpecializationError(
          parameter.name.span,
          `Const ${JSON.stringify(definition.name.spelling)} repeats type parameter ${
            JSON.stringify(parameter.name.spelling)
          }.`,
        );
      }
      names.add(parameter.name.spelling);
      continue;
    }
    if (parameter.kind === "tuple") {
      pending.push(parameter.values[1], parameter.values[0]);
      continue;
    }
    const fields = new Set<string>();
    for (const field of parameter.fields) {
      if (fields.has(field.name.spelling)) {
        throw new ConstSpecializationError(
          field.name.span,
          `Const ${JSON.stringify(definition.name.spelling)} repeats descriptor field ${
            JSON.stringify(field.name.spelling)
          }.`,
        );
      }
      fields.add(field.name.spelling);
      pending.push(field.value);
    }
  }
}

function bindConstParameter(
  templateName: string,
  parameter: ConstParameter,
  descriptor: ConstDescriptor,
  bindings: Map<string, ConstDescriptor>,
): void {
  if (parameter.kind === "bind") {
    bindings.set(parameter.name.spelling, descriptor);
    return;
  }
  if (parameter.kind === "tuple") {
    if (descriptor.kind !== "tuple") {
      throw new ConstSpecializationError(
        descriptor.span,
        `Const ${JSON.stringify(templateName)} expects a tuple type descriptor; received ${
          JSON.stringify(descriptor.kind)
        }.`,
      );
    }
    bindConstParameter(templateName, parameter.values[0], descriptor.values[0], bindings);
    bindConstParameter(templateName, parameter.values[1], descriptor.values[1], bindings);
    return;
  }
  if (descriptor.kind !== "record") {
    throw new ConstSpecializationError(
      descriptor.span,
      `Const ${JSON.stringify(templateName)} expects a record type descriptor; received ${
        JSON.stringify(descriptor.kind)
      }.`,
    );
  }
  const supplied = new Map(descriptor.fields.map((field) => [field.name.spelling, field]));
  for (const field of parameter.fields) {
    const suppliedField = supplied.get(field.name.spelling);
    if (suppliedField === undefined) {
      throw new ConstSpecializationError(
        descriptor.span,
        `Const ${JSON.stringify(templateName)} descriptor is missing field ${
          JSON.stringify(field.name.spelling)
        }.`,
      );
    }
    supplied.delete(field.name.spelling);
    bindConstParameter(templateName, field.value, suppliedField.value, bindings);
  }
  const unknownField = supplied.keys().next().value;
  if (typeof unknownField === "string") {
    throw new ConstSpecializationError(
      descriptor.span,
      `Const ${JSON.stringify(templateName)} descriptor has unknown field ${
        JSON.stringify(unknownField)
      }.`,
    );
  }
}

function resolveConstDescriptor(
  descriptor: ConstDescriptor,
  forwardingDescriptors: ReadonlyMap<string, ConstDescriptor>,
  declaredTypes: ReadonlyMap<string, DataDeclaration>,
): ConstDescriptor {
  if (descriptor.kind === "hole") return descriptor;
  if (descriptor.kind === "tuple") {
    return {
      ...descriptor,
      values: [
        resolveConstDescriptor(descriptor.values[0], forwardingDescriptors, declaredTypes),
        resolveConstDescriptor(descriptor.values[1], forwardingDescriptors, declaredTypes),
      ],
    };
  }
  if (descriptor.kind === "record") {
    const fields = new Set<string>();
    return {
      ...descriptor,
      fields: descriptor.fields.map((field) => {
        if (fields.has(field.name.spelling)) {
          throw new ConstSpecializationError(
            field.name.span,
            `Const descriptor repeats field ${JSON.stringify(field.name.spelling)}.`,
          );
        }
        fields.add(field.name.spelling);
        return {
          ...field,
          value: resolveConstDescriptor(field.value, forwardingDescriptors, declaredTypes),
        };
      }),
    };
  }
  if (
    descriptor.type.kind === "named" && descriptor.type.arguments.length === 0
  ) {
    const forwarded = forwardingDescriptors.get(descriptor.type.name);
    if (forwarded !== undefined) return forwarded;
  }
  return {
    ...descriptor,
    type: resolveConstType(descriptor.type, forwardingDescriptors, declaredTypes),
  };
}

function resolveConstType(
  type: SourceType,
  forwardingDescriptors: ReadonlyMap<string, ConstDescriptor>,
  declaredTypes: ReadonlyMap<string, DataDeclaration>,
): SourceType {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return type;
    case "parameter":
      throw new ConstSpecializationError(
        type.span,
        `Const type descriptor ${JSON.stringify(type.name)} is not closed.`,
      );
    case "tuple":
      return {
        ...type,
        values: [
          resolveConstType(type.values[0], forwardingDescriptors, declaredTypes),
          resolveConstType(type.values[1], forwardingDescriptors, declaredTypes),
        ],
      };
    case "function":
      return {
        ...type,
        parameter: resolveConstType(type.parameter, forwardingDescriptors, declaredTypes),
        result: resolveConstType(type.result, forwardingDescriptors, declaredTypes),
      };
    case "named": {
      if (type.arguments.length === 0) {
        const forwarded = forwardingDescriptors.get(type.name);
        if (forwarded !== undefined) {
          const forwardedType = constDescriptorType(forwarded);
          if (forwardedType === null) {
            throw new ConstSpecializationError(
              type.span,
              `Const type parameter ${JSON.stringify(type.name)} cannot embed descriptor kind ${
                JSON.stringify(forwarded.kind)
              }.`,
            );
          }
          return { ...forwardedType, span: type.span };
        }
      }
      const declaration = declaredTypes.get(type.name);
      if (declaration === undefined) {
        throw new ConstSpecializationError(
          type.span,
          `Unknown const type descriptor ${JSON.stringify(type.name)}.`,
        );
      }
      if (type.arguments.length !== declaration.parameters.length) {
        throw new ConstSpecializationError(
          type.span,
          `Type descriptor ${
            JSON.stringify(type.name)
          } expects ${declaration.parameters.length} type arguments; received ${type.arguments.length}.`,
        );
      }
      return {
        ...type,
        arguments: type.arguments.map((argument) =>
          resolveConstType(argument, forwardingDescriptors, declaredTypes)
        ),
      };
    }
  }
}

function constDescriptorType(descriptor: ConstDescriptor): SourceType | null {
  if (descriptor.kind === "type") return descriptor.type;
  if (descriptor.kind !== "tuple") return null;
  const first = constDescriptorType(descriptor.values[0]);
  const second = constDescriptorType(descriptor.values[1]);
  if (first === null || second === null) return null;
  return { kind: "tuple", values: [first, second], span: descriptor.span };
}

function constDescriptorStructuralKey(descriptor: ConstDescriptor): string {
  if (descriptor.kind === "hole") return "hole";
  if (descriptor.kind === "type") return `type(${typeStructuralKey(descriptor.type)})`;
  if (descriptor.kind === "tuple") {
    return `tuple(${constDescriptorStructuralKey(descriptor.values[0])},${
      constDescriptorStructuralKey(descriptor.values[1])
    })`;
  }
  const fields = descriptor.fields.map((field) =>
    `${JSON.stringify(field.name.spelling)}:${constDescriptorStructuralKey(field.value)}`
  ).sort();
  return `record({${fields.join(",")}})`;
}

function typeStructuralKey(type: SourceType): string {
  switch (type.kind) {
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "unit":
      return "unit";
    case "parameter":
      return `parameter(${JSON.stringify(type.name)})`;
    case "tuple":
      return `tuple(${typeStructuralKey(type.values[0])},${typeStructuralKey(type.values[1])})`;
    case "named":
      return `named(${JSON.stringify(type.name)}:[${
        type.arguments.map(typeStructuralKey).join(",")
      }])`;
    case "function":
      return `function(${typeStructuralKey(type.parameter)},${typeStructuralKey(type.result)})`;
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
      case "const-instantiation":
        throw new Error("Const instantiation reached surface summarization.");
      case "record":
        throw new Error("Record expression reached surface summarization.");
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
    definitionTypes: definitions.map((definition) => ({
      annotation: definition.annotation === null
        ? null
        : encodeSourceType(definition.annotation, byteOffsets),
    })),
    typeDeclarations: dataDeclarations.map((declaration) => {
      const parameterNames = new Set(declaration.parameters.map((parameter) => parameter.spelling));
      return {
        name: declaration.name.spelling,
        parameters: declaration.parameters.map((parameter) => parameter.spelling),
        constructors: declaration.constructors.map((constructor) => ({
          name: constructor.name.spelling,
          fields: constructor.fields.map((field) => ({
            name: field.name.spelling,
            type: encodeSourceType(field.type, byteOffsets, parameterNames),
          })),
          ...(constructor.result === null ? {} : {
            result: encodeSourceType(constructor.result, byteOffsets, parameterNames),
          }),
        })),
      };
    }),
  };
}

function encodeSourceType(
  type: SourceType,
  byteOffsets: Utf8ByteOffsets,
  parameters: ReadonlySet<string> = new Set(),
): LazuliSourceType {
  return {
    ...encodeTypeSchema(type, parameters),
    ...byteOffsets.span(type.span),
  } as LazuliSourceType;
}

function encodeTypeSchema(
  type: SourceType,
  parameters: ReadonlySet<string>,
): LazuliTypeSchema {
  switch (type.kind) {
    case "integer":
      return { kind: "integer" };
    case "boolean":
      return { kind: "boolean" };
    case "unit":
      return { kind: "unit" };
    case "parameter":
      return { kind: "parameter", name: type.name };
    case "tuple":
      return {
        kind: "tuple",
        values: [
          encodeTypeSchema(type.values[0], parameters),
          encodeTypeSchema(type.values[1], parameters),
        ],
      };
    case "named":
      if (type.arguments.length === 0 && parameters.has(type.name)) {
        return { kind: "parameter", name: type.name };
      }
      return {
        kind: "named",
        name: type.name,
        arguments: type.arguments.map((argument) => encodeTypeSchema(argument, parameters)),
      };
    case "function":
      return {
        kind: "function",
        parameter: encodeTypeSchema(type.parameter, parameters),
        result: encodeTypeSchema(type.result, parameters),
      };
  }
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
      case "const-instantiation":
        throw new Error("Const instantiation reached surface encoding.");
      case "record":
        throw new Error("Record expression reached surface encoding.");
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

function rejectReservedBuiltinDeclaration(identifier: Identifier): void {
  if (reservedBuiltinDeclarationNames.has(identifier.spelling)) {
    throw new ReservedBuiltinDeclaration(identifier.span, identifier.spelling);
  }
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
  return "body" in declaration && !("kind" in declaration);
}

function isDataDeclaration(declaration: Declaration): declaration is DataDeclaration {
  return "constructors" in declaration;
}

function isConstDefinition(declaration: Declaration): declaration is ConstDefinition {
  return "kind" in declaration && declaration.kind === "const";
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
