import { createParser, createParserAsync } from "@mewhhaha/baba/runtime/generated-wasm";
import {
  type CompilerPerformanceTrace,
  measureCompilerStage,
} from "../compiler_performance_trace.ts";
import {
  babaChildRule,
  babaOptionalRuleField,
  babaOptionalTokenField,
  babaRequiredRuleField,
  babaRequiredTokenField,
  type BabaRuleCursor,
  babaRuleFieldArray,
  BabaUtf8ByteOffsets,
} from "../baba_frontend.ts";
import type {
  GleamBinaryOperator,
  GleamBitArraySegment,
  GleamCaseArm,
  GleamConstant,
  GleamConstructor,
  GleamDeclaration,
  GleamExpression,
  GleamFunction,
  GleamImport,
  GleamModule,
  GleamPattern,
  GleamType,
  GleamTypeAlias,
  GleamTypeDeclaration,
} from "./ast.ts";
import { GleamSyntaxError } from "./diagnostic.ts";

type GleamParser = ReturnType<typeof createParser>;

interface SynchronousFileReader {
  readFileSync(path: string | URL): Uint8Array;
}

let gleamParser: GleamParser | undefined;
let gleamParserInitialization: Promise<GleamParser> | undefined;
const parsedIntegerUpdates = new WeakMap<GleamModule, GleamModule>();

export function parsedIntegerUpdate(module: GleamModule): GleamModule | undefined {
  return parsedIntegerUpdates.get(module);
}

export function parseGleamModule(
  name: string,
  source: string,
  trace?: CompilerPerformanceTrace,
): GleamModule {
  if (name.length === 0) throw new Error("Gleam module name must be nonempty");
  const syntaxAnnotations = { module: name, sourceCharacters: source.length };
  const parsed = trace === undefined
    ? getGleamParser().parse(normalizeGleamParserSource(source), {
      preserveTrivia: false,
    })
    : measureCompilerStage(
      trace,
      "frontend.parse.syntax",
      syntaxAnnotations,
      () =>
        getGleamParser().parse(normalizeGleamParserSource(source), {
          preserveTrivia: false,
        }),
    );
  return materializeGleamParse(name, source, parsed, trace);
}

export class GleamModuleParser {
  readonly #name: string;
  #normalizedSource: string;
  #source: string;
  #parsedModule: GleamModule | undefined;
  #parsedSource: string | undefined;

  constructor(name: string, source: string) {
    if (name.length === 0) throw new Error("Gleam module name must be nonempty");
    this.#name = name;
    this.#source = source;
    this.#normalizedSource = normalizeGleamParserSource(source);
  }

  update(source: string): void {
    if (source === this.#source) return;

    this.#source = source;
    this.#normalizedSource = normalizeGleamParserSource(source);
  }

  parse(trace?: CompilerPerformanceTrace): GleamModule {
    const syntaxAnnotations = {
      module: this.#name,
      sourceCharacters: this.#source.length,
      reparse: this.#parsedModule !== undefined,
    };
    const parsed = measureCompilerStage(
      trace,
      "frontend.parse.syntax",
      syntaxAnnotations,
      () => getGleamParser().parse(this.#normalizedSource, { preserveTrivia: false }),
    );
    if (parsed.ok && this.#parsedModule !== undefined && this.#parsedSource !== undefined) {
      const updatedModule = tryUpdateParsedIntegerLiteral(
        this.#parsedModule,
        this.#parsedSource,
        this.#source,
      );
      if (updatedModule !== undefined) {
        const materializeAnnotations = {
          module: this.#name,
          declarations: updatedModule.declarations.length,
          cacheHit: true,
        };
        const module = measureCompilerStage(
          trace,
          "frontend.parse.materialize",
          materializeAnnotations,
          () => updatedModule,
        );
        const previousModule = this.#parsedModule;
        this.#parsedModule = module;
        this.#parsedSource = this.#source;
        parsedIntegerUpdates.set(module, previousModule);
        return module;
      }
    }
    const module = materializeGleamParse(this.#name, this.#source, parsed, trace);
    this.#parsedModule = module;
    this.#parsedSource = this.#source;
    return module;
  }
}

function materializeGleamParse(
  name: string,
  source: string,
  parsed:
    | { readonly ok: true; readonly cursor: BabaRuleCursor }
    | {
      readonly ok: false;
      readonly diagnostics: readonly {
        readonly span: { readonly start: number; readonly end: number };
        readonly code: string;
        readonly message: string;
      }[];
    },
  trace?: CompilerPerformanceTrace,
): GleamModule {
  if (!parsed.ok) {
    const byteOffsets = new BabaUtf8ByteOffsets(source);
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic === undefined) {
      throw new Error(
        `Baba failed to parse Gleam module ${JSON.stringify(name)} without diagnostics.`,
      );
    }
    throw new GleamSyntaxError(
      byteOffsets.span(diagnostic.span),
      `Gleam module ${JSON.stringify(name)}: ${diagnostic.code}: ${diagnostic.message}`,
    );
  }
  const materializeAnnotations = { module: name, declarations: 0, cacheHit: false };
  if (trace === undefined) {
    return materializeGleamModule(name, source, parsed.cursor);
  }
  return measureCompilerStage(
    trace,
    "frontend.parse.materialize",
    materializeAnnotations,
    () => {
      const module = materializeGleamModule(name, source, parsed.cursor);
      materializeAnnotations.declarations = module.declarations.length;
      return module;
    },
  );
}

function tryUpdateParsedIntegerLiteral(
  previousModule: GleamModule,
  previousSource: string,
  updatedSource: string,
): GleamModule | undefined {
  if (previousSource.length !== updatedSource.length) return undefined;
  if (previousSource === updatedSource) return previousModule;

  let editStart = 0;
  while (
    editStart < previousSource.length &&
    previousSource[editStart] === updatedSource[editStart]
  ) editStart++;
  let previousEditEnd = previousSource.length;
  let updatedEditEnd = updatedSource.length;
  while (
    previousEditEnd > editStart &&
    updatedEditEnd > editStart &&
    previousSource[previousEditEnd - 1] === updatedSource[updatedEditEnd - 1]
  ) {
    previousEditEnd--;
    updatedEditEnd--;
  }

  const previousOffsets = new BabaUtf8ByteOffsets(previousSource);
  const updatedOffsets = new BabaUtf8ByteOffsets(updatedSource);
  if (previousOffsets.byteLength !== updatedOffsets.byteLength) return undefined;
  const previousEdit = previousOffsets.span({ start: editStart, end: previousEditEnd });
  const updatedEdit = updatedOffsets.span({
    start: editStart,
    end: updatedEditEnd,
  });
  if (
    previousEdit.startByte !== updatedEdit.startByte ||
    previousEdit.endByte !== updatedEdit.endByte
  ) return undefined;

  let updatedLiterals = 0;
  const update = (value: unknown): unknown => {
    if (isParsedInteger(value)) {
      if (
        previousEdit.startByte < value.span.startByte ||
        previousEdit.endByte > value.span.endByte
      ) return value;
      let expressionStart: number | undefined;
      let expressionEnd: number | undefined;
      let byteOffset = 0;
      for (let index = 0; index <= previousSource.length; index++) {
        if (byteOffset === value.span.startByte) expressionStart = index;
        if (byteOffset === value.span.endByte) {
          expressionEnd = index;
          break;
        }
        const codePoint = previousSource.codePointAt(index);
        if (codePoint === undefined) break;
        byteOffset += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
        if (codePoint > 0xffff) index += 1;
      }
      if (expressionStart === undefined || expressionEnd === undefined) return value;
      const expression = previousSource.slice(expressionStart, expressionEnd);
      let updatedValue: number | undefined;
      for (const match of expression.matchAll(/-?[0-9][0-9_]*/g)) {
        if (match.index === undefined) continue;
        const tokenStart = expressionStart + match.index;
        const tokenEnd = tokenStart + match[0].length;
        const tokenSpan = previousOffsets.span({ start: tokenStart, end: tokenEnd });
        if (
          tokenSpan.startByte > previousEdit.startByte ||
          tokenSpan.endByte < previousEdit.endByte ||
          parseIntegerToken(match[0]) !== value.value
        ) continue;
        const updatedToken = updatedSource.slice(tokenStart, tokenEnd);
        if (!/^-?[0-9][0-9_]*$/.test(updatedToken)) return value;
        if (updatedValue !== undefined) return value;
        updatedValue = parseIntegerToken(updatedToken);
      }
      if (updatedValue === undefined) return value;
      updatedLiterals += 1;
      return { ...value, value: updatedValue };
    }
    if (Array.isArray(value)) {
      let changed = false;
      const members = value.map((member) => {
        const updated = update(member);
        if (updated !== member) changed = true;
        return updated;
      });
      return changed ? members : value;
    }
    if (value === null || typeof value !== "object") return value;
    const record = value as Readonly<Record<string, unknown>>;
    let changed = false;
    const updated: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(record)) {
      const updatedMember = update(member);
      if (updatedMember !== member) changed = true;
      updated[key] = updatedMember;
    }
    return changed ? updated : value;
  };
  const updatedModule = update(previousModule);
  return updatedLiterals === 1 ? updatedModule as GleamModule : undefined;
}

function isParsedInteger(
  value: unknown,
): value is {
  readonly kind: "integer";
  readonly value: number;
  readonly span: { readonly startByte: number; readonly endByte: number };
} {
  return value !== null && typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "integer" &&
    typeof (value as { readonly value?: unknown }).value === "number" &&
    (value as { readonly span?: unknown }).span !== null &&
    typeof (value as { readonly span?: unknown }).span === "object" &&
    typeof (value as { readonly span?: { readonly startByte?: unknown } }).span?.startByte ===
      "number" &&
    typeof (value as { readonly span?: { readonly endByte?: unknown } }).span?.endByte === "number";
}

function materializeGleamModule(
  name: string,
  source: string,
  cursor: BabaRuleCursor,
): GleamModule {
  const byteOffsets = new BabaUtf8ByteOffsets(source);
  const declarations = babaRuleFieldArray(cursor, "declarations");
  const imports: GleamImport[] = [];
  const values: GleamDeclaration[] = [];
  for (const declaration of declarations) {
    const child = babaChildRule(declaration);
    const topLevel = child.name === "top_level_declaration" ? babaChildRule(child) : child;
    if (declarationTarget(source, topLevel.span.start) === "erlang") continue;
    if (topLevel.name === "import_declaration") {
      imports.push(parseImport(topLevel, byteOffsets));
    } else values.push(parseDeclaration(topLevel, byteOffsets));
  }
  return {
    name,
    imports,
    declarations: values,
    span: { startByte: 0, endByte: byteOffsets.byteLength },
  };
}

function declarationTarget(source: string, declarationStart: number): string | null {
  let end = declarationStart - 1;
  while (end >= 0 && /\s/.test(source[end] ?? "")) end--;
  if (source[end] !== ")") return null;
  const start = source.lastIndexOf("@target(", end);
  if (start < 0) return null;
  if (source.indexOf(")", start + "@target(".length) !== end) return null;
  const target = source.slice(start + "@target(".length, end).trim();
  return target.length === 0 ? null : target;
}

function normalizeGleamParserSource(source: string): string {
  let normalized: string[] | undefined;
  let inString = false;
  let escaped = false;
  let inComment = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (inComment) {
      if (character === "\n" || character === "\r") inComment = false;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "/" && source[index + 1] === "/") {
      inComment = true;
      index++;
      continue;
    }
    if (character === "a" && isAssertModifier(source, index)) {
      normalized ??= source.split("");
      for (let keywordIndex = index; keywordIndex < index + "assert".length; keywordIndex++) {
        normalized[keywordIndex] = " ";
      }
      index += "assert".length - 1;
      continue;
    }
    if (character !== ",") continue;
    let next = index + 1;
    while (/\s/.test(source[next] ?? "")) next++;
    if (
      source[next] === ")" || source[next] === "]" || source[next] === "}" ||
      source[next] === ">" && source[next + 1] === ">"
    ) {
      normalized ??= source.split("");
      normalized[index] = " ";
    }
  }
  return normalized?.join("") ?? source;
}

function isAssertModifier(source: string, start: number): boolean {
  if (!source.startsWith("assert", start) || /[A-Za-z0-9_]/.test(source[start + 6] ?? "")) {
    return false;
  }
  let previous = start - 1;
  while (/\s/.test(source[previous] ?? "")) previous--;
  if (source.slice(previous - 2, previous + 1) !== "let") return false;
  return !/[A-Za-z0-9_]/.test(source[previous - 3] ?? "");
}

/**
 * Loads the generated Gleam parser assets for runtimes with no filesystem, which in practice means
 * the browser: `getGleamParser` reads them synchronously off disk, and there is nothing to read
 * from in a tab.
 */
export async function initializeGleamParser(
  parserModuleUrl: URL,
  parserPlanUrl: URL,
): Promise<void> {
  if (gleamParser !== undefined) return;

  const initialization = gleamParserInitialization ??
    createParserAsync({ url: parserModuleUrl, planUrl: parserPlanUrl });
  gleamParserInitialization = initialization;
  try {
    gleamParser = await initialization;
  } catch (cause) {
    if (gleamParserInitialization === initialization) gleamParserInitialization = undefined;
    throw new Error(
      `could not initialize the Gleam parser from ${parserModuleUrl.href} and ${parserPlanUrl.href}`,
      { cause },
    );
  }
}

function getGleamParser(): GleamParser {
  if (gleamParser !== undefined) return gleamParser;

  const fileReader = (globalThis as typeof globalThis & { Deno?: SynchronousFileReader }).Deno;
  if (fileReader === undefined) {
    throw new Error(
      "the Gleam parser is not initialized; call initializeGleamParser() before parsing in a browser",
    );
  }

  gleamParser = createParser({
    bytes: fileReader.readFileSync(
      new URL("../../language/gleam/generated/wasm/parser.wasm", import.meta.url),
    ),
    plan: fileReader.readFileSync(
      new URL("../../language/gleam/generated/wasm/parser.plan", import.meta.url),
    ),
  });
  return gleamParser;
}

function parseImport(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamImport {
  const moduleNode = babaRequiredRuleField(node, "module");
  const module = joinedName(moduleNode, "/");
  const namesNode = babaOptionalRuleField(node, "names");
  const aliasNode = babaOptionalRuleField(node, "alias");
  const valuesNode = namesNode === null ? null : babaOptionalRuleField(namesNode, "values");
  const names = valuesNode === null ? [] : listRules(valuesNode).map((imported) => {
    const value = babaChildRule(imported);
    const name = babaRequiredTokenField(value, "name");
    const aliasNode = babaOptionalRuleField(value, "alias");
    return {
      kind: value.name === "type_import_name" ? "type" as const : "value" as const,
      name: name.text,
      alias: aliasNode === null ? name.text : babaRequiredTokenField(aliasNode, "name").text,
      span: offsets.span(imported.span),
    };
  });
  return {
    module,
    alias: aliasNode === null ? null : babaRequiredTokenField(aliasNode, "name").text,
    names,
    span: offsets.span(node.span),
  };
}

function parseDeclaration(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamDeclaration {
  if (node.name === "type_declaration") return parseTypeDeclaration(node, offsets);
  if (node.name === "constant_declaration") return parseConstant(node, offsets);
  if (node.name === "function_declaration") return parseFunction(node, offsets);
  throw new Error(`Unsupported Baba Gleam declaration node ${node.name}.`);
}

function parseConstant(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamConstant {
  const annotationNode = babaOptionalRuleField(node, "annotation");
  return {
    kind: "constant",
    public: babaOptionalRuleField(node, "visibility") !== null,
    name: babaRequiredTokenField(node, "name").text,
    annotation: annotationNode === null
      ? null
      : parseType(babaRequiredRuleField(annotationNode, "type"), offsets),
    value: parseExpression(babaRequiredRuleField(node, "value"), offsets),
    span: offsets.span(node.span),
  };
}

function parseTypeDeclaration(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamTypeDeclaration | GleamTypeAlias {
  const parametersNode = babaOptionalRuleField(node, "parameters");
  const valuesNode = parametersNode === null
    ? null
    : babaOptionalRuleField(parametersNode, "values");
  const parameters = valuesNode === null ? [] : identifierList(valuesNode);
  const bodyNode = babaOptionalRuleField(node, "body");
  if (bodyNode === null) {
    return {
      kind: "type",
      public: babaOptionalRuleField(node, "visibility") !== null,
      opaque: true,
      name: babaRequiredTokenField(node, "name").text,
      parameters,
      constructors: [],
      span: offsets.span(node.span),
    };
  }
  const body = babaChildRule(bodyNode);
  if (body.name === "type_alias_body") {
    if (babaOptionalRuleField(node, "opacity") !== null) {
      throw new GleamSyntaxError(
        offsets.span(node.span),
        "A Gleam type alias cannot be opaque.",
      );
    }
    return {
      kind: "type-alias",
      public: babaOptionalRuleField(node, "visibility") !== null,
      name: babaRequiredTokenField(node, "name").text,
      parameters,
      type: parseType(babaRequiredRuleField(body, "type"), offsets),
      span: offsets.span(node.span),
    };
  }
  return {
    kind: "type",
    public: babaOptionalRuleField(node, "visibility") !== null,
    opaque: babaOptionalRuleField(node, "opacity") !== null,
    name: babaRequiredTokenField(node, "name").text,
    parameters,
    constructors: babaRuleFieldArray(body, "constructors").map((constructor) =>
      parseConstructor(constructor, offsets)
    ),
    span: offsets.span(node.span),
  };
}

function parseConstructor(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamConstructor {
  const fieldsNode = babaOptionalRuleField(node, "fields");
  const valuesNode = fieldsNode === null ? null : babaOptionalRuleField(fieldsNode, "values");
  return {
    name: babaRequiredTokenField(node, "name").text,
    fields: valuesNode === null ? [] : listRules(valuesNode).map((field) => {
      const value = babaChildRule(field);
      return {
        label: value.name === "labeled_constructor_field"
          ? babaRequiredTokenField(value, "label").text
          : null,
        type: parseType(babaRequiredRuleField(value, "type"), offsets),
        span: offsets.span(field.span),
      };
    }),
    span: offsets.span(node.span),
  };
}

function parseFunction(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunction {
  const declaration = node.name === "function_declaration" ? babaChildRule(node) : node;
  const parametersNode = babaOptionalRuleField(declaration, "parameters");
  const resultNode = babaOptionalRuleField(declaration, "result");
  const externalNodes = babaRuleFieldArray(declaration, "external");
  const bodyNode = babaOptionalRuleField(declaration, "body");
  if (externalNodes.length === 0 && bodyNode === null) {
    throw new GleamSyntaxError(
      offsets.span(declaration.span),
      "A Gleam function must have a body or at least one @external annotation.",
    );
  }
  return {
    kind: "function",
    public: babaOptionalRuleField(declaration, "visibility") !== null,
    name: babaRequiredTokenField(declaration, "name").text,
    parameters: parametersNode === null ? [] : listRules(parametersNode).map((parameter) => {
      const value = babaChildRule(parameter);
      const annotation = babaOptionalRuleField(value, "annotation");
      return {
        label: value.name === "labeled_function_parameter"
          ? babaRequiredTokenField(value, "label").text
          : null,
        name: babaRequiredTokenField(value, "name").text,
        annotation: annotation === null
          ? null
          : parseType(babaRequiredRuleField(annotation, "type"), offsets),
        span: offsets.span(parameter.span),
      };
    }),
    result: resultNode === null
      ? null
      : parseType(babaRequiredRuleField(resultNode, "type"), offsets),
    body: bodyNode === null ? null : parseBlock(bodyNode, offsets),
    external: selectedExternal(externalNodes, offsets),
    span: offsets.span(node.span),
  };
}

function selectedExternal(
  externalNodes: readonly BabaRuleCursor[],
  offsets: BabaUtf8ByteOffsets,
): GleamFunction["external"] {
  const node =
    externalNodes.find((candidate) =>
      babaRequiredTokenField(candidate, "target").text === "javascript"
    ) ?? externalNodes[0];
  if (node === undefined) return null;
  return {
    target: babaRequiredTokenField(node, "target").text,
    module: parseStringToken(babaRequiredTokenField(node, "module"), offsets).value,
    name: parseStringToken(babaRequiredTokenField(node, "name"), offsets).value,
  };
}

function parseType(node: BabaRuleCursor, offsets: BabaUtf8ByteOffsets): GleamType {
  const type = node.name === "source_type" ? babaChildRule(node) : node;
  const span = offsets.span(type.span);
  if (type.name === "function_type") {
    const parametersNode = babaOptionalRuleField(type, "parameters");
    return {
      kind: "function",
      parameters: parametersNode === null
        ? []
        : listRules(parametersNode).map((parameter) => parseType(parameter, offsets)),
      result: parseType(babaRequiredRuleField(type, "result"), offsets),
      span,
    };
  }
  if (type.name === "tuple_type") {
    const valuesNode = babaOptionalRuleField(type, "values");
    return {
      kind: "tuple",
      values: valuesNode === null
        ? []
        : listRules(valuesNode).map((value) => parseType(value, offsets)),
      span,
    };
  }
  if (type.name !== "named_type") throw new Error(`Unsupported Baba Gleam type node ${type.name}.`);
  const name = joinedName(babaRequiredRuleField(type, "name"), ".");
  const argumentsNode = babaOptionalRuleField(type, "arguments");
  const valuesNode = argumentsNode === null ? null : babaOptionalRuleField(argumentsNode, "values");
  const arguments_ = valuesNode === null
    ? []
    : listRules(valuesNode).map((argument) => parseType(argument, offsets));
  switch (name) {
    case "Int":
      return { kind: "integer", span };
    case "Float":
      return { kind: "float", span };
    case "Bool":
      return { kind: "boolean", span };
    case "Nil":
      return { kind: "unit", span };
    default:
      return !name.includes(".") && startsLowercase(name)
        ? { kind: "parameter", name, span }
        : { kind: "named", name, arguments: arguments_, span };
  }
}

function parseBlock(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamExpression {
  const entries = babaRuleFieldArray(node, "entries");
  const finalStatement = babaChildRule(entries.at(-1)!);
  const hasResult = finalStatement.name === "expression_statement";
  let expression: GleamExpression = hasResult
    ? parseExpression(babaRequiredRuleField(finalStatement, "value"), offsets)
    : { kind: "unit", span: offsets.span(finalStatement.span) };
  for (let index = entries.length - (hasResult ? 2 : 1); index >= 0; index--) {
    const entry = entries[index]!;
    const statement = babaChildRule(entry);
    if (statement.name === "expression_statement") {
      const value = parseExpression(babaRequiredRuleField(statement, "value"), offsets);
      expression = {
        kind: "let",
        pattern: { kind: "discard", span: offsets.span(statement.span) },
        value,
        body: expression,
        span: offsets.span({ start: entry.span.start, end: node.span.end }),
      };
      continue;
    }
    if (statement.name === "let_binding") {
      expression = {
        kind: "let",
        pattern: parsePattern(babaRequiredRuleField(statement, "pattern"), offsets),
        value: parseExpression(babaRequiredRuleField(statement, "value"), offsets),
        body: expression,
        span: offsets.span({ start: entry.span.start, end: node.span.end }),
      };
      continue;
    }
    if (statement.name !== "use_binding") {
      throw new Error(`Unsupported Baba Gleam block binding ${statement.name}.`);
    }
    const parametersNode = babaOptionalRuleField(statement, "parameters");
    const callback: GleamExpression = {
      kind: "lambda",
      parameters: parametersNode === null ? [] : identifierList(parametersNode),
      body: expression,
      span: offsets.span({ start: entry.span.start, end: node.span.end }),
    };
    const target = parseExpression(babaRequiredRuleField(statement, "value"), offsets);
    if (target.kind === "call") {
      const arguments_ = [...target.arguments];
      const firstLabeledArgument = arguments_.findIndex((argument) => argument.label !== null);
      arguments_.splice(
        firstLabeledArgument < 0 ? arguments_.length : firstLabeledArgument,
        0,
        positionalCallArgument(callback),
      );
      expression = { ...target, arguments: arguments_ };
    } else {
      expression = {
        kind: "call",
        callee: target,
        arguments: [positionalCallArgument(callback)],
        span: offsets.span(statement.span),
      };
    }
  }
  return { ...expression, span: offsets.span(node.span) };
}

function parseExpression(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamExpression {
  const expression = node.name === "expr" ? babaChildRule(node) : node;
  switch (expression.name) {
    case "pipeline":
      return foldBinary(
        expression,
        offsets,
        (left, right, span) => pipeExpression(left, right, span),
      );
    case "logical_or":
      return foldOperator(expression, offsets, "||");
    case "logical_and":
      return foldOperator(expression, offsets, "&&");
    case "equality":
    case "comparison":
    case "additive":
    case "multiplicative":
      return foldNamedOperators(expression, offsets);
    case "concatenation":
      return foldOperator(expression, offsets, "<>");
    case "unary":
    case "primary":
      return parseExpression(babaChildRule(expression), offsets);
    case "negate": {
      const value = parseExpression(babaRequiredRuleField(expression, "value"), offsets);
      if (value.kind === "integer" || value.kind === "float") {
        return { ...value, value: -value.value, span: offsets.span(expression.span) };
      }
      return {
        kind: "binary",
        operator: "-",
        left: { kind: "integer", value: 0, span: offsets.span(expression.span) },
        right: value,
        span: offsets.span(expression.span),
      };
    }
    case "boolean_not": {
      const value = parseExpression(babaRequiredRuleField(expression, "value"), offsets);
      const span = offsets.span(expression.span);
      return {
        kind: "binary",
        operator: "==",
        left: value,
        right: { kind: "boolean", value: false, span },
        span,
      };
    }
    case "call": {
      let result = parseExpression(babaRequiredRuleField(expression, "callee"), offsets);
      for (const entry of babaRuleFieldArray(expression, "operations")) {
        const operation = babaChildRule(entry);
        if (operation.name === "field_access") {
          result = {
            kind: "field-access",
            value: result,
            field: nameTailValue(operation),
            span: offsets.span({
              start: result.span.startByte,
              end: offsets.span(operation.span).endByte,
            }),
          };
          continue;
        }
        const call = operation;
        const valuesNode = babaOptionalRuleField(call, "values");
        const arguments_ = valuesNode === null ? [] : listRules(valuesNode).map((argument) => {
          const value = babaChildRule(argument);
          const span = offsets.span(argument.span);
          if (
            value.name === "labeled_call_argument" &&
            babaOptionalRuleField(value, "value") === null
          ) {
            const label = babaRequiredTokenField(value, "label").text;
            return {
              label,
              spread: false,
              value: { kind: "name" as const, name: label, span },
              span,
            };
          }
          return {
            label: value.name === "labeled_call_argument"
              ? babaRequiredTokenField(value, "label").text
              : null,
            spread: value.name === "spread_call_argument",
            value: parseExpression(babaRequiredRuleField(value, "value"), offsets),
            span,
          };
        });
        result = {
          kind: "call",
          callee: result,
          arguments: arguments_,
          span: offsets.span(expression.span),
        };
      }
      return result;
    }
    case "block":
      return parseBlock(expression, offsets);
    case "case_expression":
      return parseCase(expression, offsets);
    case "lambda_expression": {
      const parametersNode = babaOptionalRuleField(expression, "parameters");
      return {
        kind: "lambda",
        parameters: parametersNode === null
          ? []
          : listRules(parametersNode).map((parameter) =>
            babaRequiredTokenField(babaChildRule(parameter), "name").text
          ),
        body: parseBlock(babaRequiredRuleField(expression, "body"), offsets),
        span: offsets.span(expression.span),
      };
    }
    case "tuple_expression": {
      const valuesNode = babaOptionalRuleField(expression, "values");
      return {
        kind: "tuple",
        values: valuesNode === null
          ? []
          : listRules(valuesNode).map((value) => parseExpression(value, offsets)),
        span: offsets.span(expression.span),
      };
    }
    case "assert_expression": {
      const span = offsets.span(expression.span);
      return {
        kind: "case",
        subjects: [parseExpression(babaRequiredRuleField(expression, "value"), offsets)],
        arms: [{
          patterns: [{ kind: "boolean", value: true, span }],
          guard: null,
          body: { kind: "unit", span },
          span,
        }, {
          patterns: [{ kind: "discard", span }],
          guard: null,
          body: { kind: "panic", message: null, span },
          span,
        }],
        span,
      };
    }
    case "list_expression": {
      const entriesNode = babaOptionalRuleField(expression, "entries");
      const values: GleamExpression[] = [];
      let tail: GleamExpression | null = null;
      const entries = entriesNode === null ? [] : listRules(entriesNode);
      for (const [index, entry] of entries.entries()) {
        const value = babaChildRule(entry);
        if (value.name === "spread_list_expression") {
          if (index + 1 !== entries.length) {
            throw new GleamSyntaxError(
              offsets.span(entry.span),
              "A Gleam list spread must be the final list expression.",
            );
          }
          tail = parseExpression(babaRequiredRuleField(value, "value"), offsets);
          continue;
        }
        values.push(parseExpression(babaRequiredRuleField(value, "value"), offsets));
      }
      return {
        kind: "list",
        values,
        tail,
        span: offsets.span(expression.span),
      };
    }
    case "bit_array_expression":
      return parseBitArrayExpression(expression, offsets);
    case "group_expression":
      return parseExpression(babaRequiredRuleField(expression, "body"), offsets);
    case "unit_expression":
      return { kind: "unit", span: offsets.span(expression.span) };
    case "tuple_index_expression":
      return {
        kind: "tuple-index",
        value: parseExpression(babaRequiredRuleField(expression, "value"), offsets),
        index: parseIntegerToken(babaRequiredTokenField(expression, "index").text.slice(1)),
        span: offsets.span(expression.span),
      };
    case "float_expression":
      return {
        kind: "float",
        value: parseFloatToken(babaRequiredTokenField(expression, "value").text),
        span: offsets.span(expression.span),
      };
    case "string_expression":
      return parseStringToken(babaRequiredTokenField(expression, "value"), offsets);
    case "panic_expression": {
      const message = babaOptionalRuleField(expression, "message");
      return {
        kind: "panic",
        message: message === null
          ? null
          : parseExpression(babaRequiredRuleField(message, "value"), offsets),
        span: offsets.span(expression.span),
      };
    }
    case "integer_expression":
      return {
        kind: "integer",
        value: parseIntegerToken(babaRequiredTokenField(expression, "value").text),
        span: offsets.span(expression.span),
      };
    case "boolean_expression":
      return {
        kind: "boolean",
        value: babaChildRule(expression).name === "truth",
        span: offsets.span(expression.span),
      };
    case "capture_expression":
      return { kind: "capture", span: offsets.span(expression.span) };
    case "named_expression": {
      const name = joinedName(babaRequiredRuleField(expression, "name"), ".");
      return name === "Nil"
        ? { kind: "unit", span: offsets.span(expression.span) }
        : { kind: "name", name, span: offsets.span(expression.span) };
    }
    default:
      throw new Error(`Unsupported Baba Gleam expression node ${expression.name}.`);
  }
}

function parseStringToken(
  token: ReturnType<typeof babaRequiredTokenField>,
  offsets: BabaUtf8ByteOffsets,
): Extract<GleamExpression, { readonly kind: "string" }> {
  try {
    // Gleam writes `\u{H...}`; JSON only understands `\uHHHH`, so rewrite before handing the token
    // to `JSON.parse`. Match the backslash run itself rather than the character before it: an
    // earlier version consumed the preceding character, which meant adjacent escapes such as
    // `\u{0020}\u{0009}` matched only every other one and left the rest for JSON to reject. An odd
    // run ends in the backslash that opens the escape; an even run is escaped pairs followed by
    // literal `u{...}`.
    const jsonString = token.text.replace(
      /(\\+)u\{([0-9A-Fa-f]{1,6})\}/g,
      (whole, backslashes: string, hex: string) => {
        if (backslashes.length % 2 === 0) return whole;
        const codePoint = Number.parseInt(hex, 16);
        if (codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff) {
          throw new RangeError(`invalid Unicode codepoint U+${hex.toUpperCase()}`);
        }
        const escapedPairs = backslashes.slice(0, -1);
        if (codePoint <= 0xffff) {
          return `${escapedPairs}\\u${codePoint.toString(16).padStart(4, "0")}`;
        }
        const scalar = codePoint - 0x10000;
        const high = 0xd800 + (scalar >> 10);
        const low = 0xdc00 + (scalar & 0x3ff);
        return `${escapedPairs}\\u${high.toString(16)}\\u${low.toString(16)}`;
      },
    );
    return {
      kind: "string",
      value: JSON.parse(jsonString) as string,
      span: offsets.span(token.span),
    };
  } catch (cause) {
    throw new GleamSyntaxError(
      offsets.span(token.span),
      `Gleam string literal is malformed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

function parseCase(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamExpression {
  const subjectsNode = babaRequiredRuleField(node, "subjects");
  return {
    kind: "case",
    subjects: listRules(subjectsNode).map((subject) => parseExpression(subject, offsets)),
    arms: babaRuleFieldArray(node, "arms").flatMap((arm): readonly GleamCaseArm[] => {
      const guardNode = babaOptionalRuleField(arm, "guard");
      const guard = guardNode === null
        ? null
        : parseExpression(babaRequiredRuleField(guardNode, "condition"), offsets);
      const body = parseExpression(babaRequiredRuleField(arm, "body"), offsets);
      const alternatives = [
        babaRequiredRuleField(arm, "patterns"),
        ...babaRuleFieldArray(arm, "alternatives").map((alternative) =>
          babaRequiredRuleField(alternative, "patterns")
        ),
      ];
      return alternatives.map((patternsNode) => ({
        patterns: listRules(patternsNode).map((pattern) => parsePattern(pattern, offsets)),
        guard,
        body,
        span: offsets.span(arm.span),
      }));
    }),
    span: offsets.span(node.span),
  };
}

function parsePattern(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamPattern {
  if (node.name === "pattern") {
    const pattern = parsePattern(babaRequiredRuleField(node, "body"), offsets);
    const aliasNode = babaOptionalRuleField(node, "alias");
    if (aliasNode === null) return pattern;
    return {
      kind: "alias",
      pattern,
      name: babaRequiredTokenField(aliasNode, "name").text,
      span: offsets.span(node.span),
    };
  }
  if (node.name === "base_pattern") {
    return parsePattern(babaChildRule(node), offsets);
  }
  const pattern = node;
  const span = offsets.span(pattern.span);
  switch (pattern.name) {
    case "discard_pattern":
      return { kind: "discard", span };
    case "bit_array_pattern": {
      return parseBitArrayPattern(pattern, offsets);
    }
    case "list_pattern": {
      const entriesNode = babaOptionalRuleField(pattern, "entries");
      const values: BabaRuleCursor[] = [];
      let result: GleamPattern = { kind: "list-nil", span };
      const entries = entriesNode === null ? [] : listRules(entriesNode);
      for (const [index, entry] of entries.entries()) {
        const value = babaChildRule(entry);
        if (value.name !== "spread_list_pattern") {
          values.push(babaRequiredRuleField(value, "value"));
          continue;
        }
        if (index + 1 !== entries.length) {
          throw new GleamSyntaxError(
            offsets.span(entry.span),
            "A Gleam list spread pattern must be the final list pattern.",
          );
        }
        const restValue = babaOptionalRuleField(value, "value");
        result = restValue === null
          ? { kind: "discard", span: offsets.span(value.span) }
          : parsePattern(restValue, offsets);
      }
      for (let index = values.length - 1; index >= 0; index--) {
        result = {
          kind: "list-cons",
          head: parsePattern(values[index]!, offsets),
          tail: result,
          span,
        };
      }
      return result;
    }
    case "tuple_pattern": {
      const valuesNode = babaOptionalRuleField(pattern, "values");
      return {
        kind: "tuple",
        values: valuesNode === null
          ? []
          : listRules(valuesNode).map((value) => parsePattern(value, offsets)),
        span,
      };
    }
    case "unit_pattern":
      return { kind: "unit", span };
    case "integer_pattern":
      return {
        kind: "integer",
        value: (babaOptionalTokenField(pattern, "sign") === null ? 1 : -1) *
          parseIntegerToken(babaRequiredTokenField(pattern, "value").text),
        span,
      };
    case "float_pattern":
      return {
        kind: "float",
        value: (babaOptionalTokenField(pattern, "sign") === null ? 1 : -1) *
          parseFloatToken(babaRequiredTokenField(pattern, "value").text),
        span,
      };
    case "boolean_pattern":
      return { kind: "boolean", value: babaChildRule(pattern).name === "truth", span };
    case "string_pattern":
      return {
        kind: "string",
        value: parseStringToken(babaRequiredTokenField(pattern, "value"), offsets).value,
        span,
      };
    case "string_prefix_pattern":
      return {
        kind: "string-prefix",
        prefix: parseStringToken(babaRequiredTokenField(pattern, "prefix"), offsets).value,
        rest: parsePattern(babaRequiredRuleField(pattern, "rest"), offsets),
        span,
      };
    case "named_pattern": {
      const name = joinedName(babaRequiredRuleField(pattern, "name"), ".");
      const argumentsNode = babaOptionalRuleField(pattern, "arguments");
      if (argumentsNode === null && !name.includes(".") && startsLowercase(name)) {
        return { kind: "variable", name, span };
      }
      const entriesNode = argumentsNode === null
        ? null
        : babaOptionalRuleField(argumentsNode, "entries");
      const entries = entriesNode === null ? [] : listRules(entriesNode);
      let discardRemaining = false;
      const arguments_ = entries.flatMap((argument, index) => {
        const value = babaChildRule(argument);
        if (value.name === "spread_pattern_argument") {
          if (index + 1 !== entries.length) {
            throw new GleamSyntaxError(
              offsets.span(argument.span),
              "A Gleam record pattern spread must be its final field.",
            );
          }
          discardRemaining = true;
          return [];
        }
        const argumentSpan = offsets.span(argument.span);
        const label = value.name === "labeled_pattern_argument"
          ? babaRequiredTokenField(value, "label").text
          : null;
        const patternNode = babaOptionalRuleField(value, "value");
        if (patternNode !== null) {
          return [{ label, value: parsePattern(patternNode, offsets), span: argumentSpan }];
        }
        if (label === null) {
          throw new Error("Positional Gleam pattern argument omitted its value.");
        }
        return [{
          label,
          value: { kind: "variable" as const, name: label, span: argumentSpan },
          span: argumentSpan,
        }];
      });
      return {
        kind: "constructor",
        name,
        arguments: arguments_,
        discardRemaining,
        span,
      };
    }
    default:
      throw new Error(`Unsupported Baba Gleam pattern node ${pattern.name}.`);
  }
}

function parseBitArrayExpression(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamExpression {
  const segmentsNode = babaOptionalRuleField(node, "segments");
  const segments = segmentsNode === null ? [] : listRules(segmentsNode).map((segment) => ({
    value: parseExpression(babaRequiredRuleField(segment, "value"), offsets),
    options: parseBitArrayOptions(segment, offsets),
    span: offsets.span(segment.span),
  }));
  const literal = staticBitArrayLiteral(segments);
  return literal === null
    ? { kind: "bit-array-build", segments, span: offsets.span(node.span) }
    : { kind: "bit-array", ...literal, span: offsets.span(node.span) };
}

function parseBitArrayPattern(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamPattern {
  const segmentsNode = babaOptionalRuleField(node, "segments");
  const segments = segmentsNode === null ? [] : listRules(segmentsNode).map((segment) => ({
    value: parsePattern(babaRequiredRuleField(segment, "value"), offsets),
    options: parseBitArrayOptions(segment, offsets),
    span: offsets.span(segment.span),
  }));
  const literal = staticBitArrayLiteral(segments);
  return literal === null
    ? { kind: "bit-array-segments", segments, span: offsets.span(node.span) }
    : { kind: "bit-array", ...literal, span: offsets.span(node.span) };
}

function parseBitArrayOptions(
  segment: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
) {
  const optionsNode = babaOptionalRuleField(segment, "options");
  if (optionsNode === null) return [];
  return listRules(optionsNode).map((option) => {
    const value = option.name === "bit_array_segment_option" ? babaChildRule(option) : option;
    if (value.name === "bit_array_segment_size") {
      const sign = babaOptionalTokenField(value, "sign") === null ? 1 : -1;
      const span = offsets.span(value.span);
      return {
        name: "size",
        arguments: [{
          kind: "integer" as const,
          value: sign * parseIntegerToken(babaRequiredTokenField(value, "value").text),
          span,
        }],
        span,
      };
    }
    const argumentsNode = babaOptionalRuleField(value, "arguments");
    const valuesNode = argumentsNode === null
      ? null
      : babaOptionalRuleField(argumentsNode, "values");
    return {
      name: babaRequiredTokenField(value, "name").text,
      arguments: valuesNode === null
        ? []
        : listRules(valuesNode).map((argument) =>
          parseExpression(babaRequiredRuleField(babaChildRule(argument), "value"), offsets)
        ),
      span: offsets.span(value.span),
    };
  });
}

function staticBitArrayLiteral(
  segments: readonly GleamBitArraySegment<
    GleamExpression | GleamPattern
  >[],
): { readonly bytes: Uint8Array; readonly bitLength: number } | null {
  const maximumBitLength = 1_000_000;
  const bits: number[] = [];
  const appendInteger = (integer: number, bitLength: number): void => {
    // A negative size is legal Gleam and contributes no bits, rather than being a syntax error:
    // upstream's own suite asserts `bit_size(<<0:-8>>) == 0` and `bit_size(<<0:-1>>) == 0`.
    if (bitLength <= 0) return;
    if (bits.length + bitLength > maximumBitLength) {
      throw new GleamSyntaxError(
        segments[0]?.span ?? { startByte: 0, endByte: 0 },
        `A static Gleam bit array cannot exceed ${maximumBitLength} bits; received at least ${
          bits.length + bitLength
        }.`,
      );
    }
    const value = BigInt.asUintN(bitLength, BigInt(integer));
    for (let index = bitLength - 1; index >= 0; index--) {
      bits.push(Number(value >> BigInt(index) & 1n));
    }
  };
  for (const segment of segments) {
    if (segment.value.kind === "string") {
      if (segment.options.length !== 1 || segment.options[0]?.name !== "utf8") {
        throw new GleamSyntaxError(
          segment.options[0]?.span ?? segment.span,
          "A portable Gleam bit-array string segment must use the utf8 encoding.",
        );
      }
      for (const byte of new TextEncoder().encode(segment.value.value)) appendInteger(byte, 8);
      continue;
    }
    if (segment.value.kind !== "integer") return null;
    let bitLength = 8;
    for (const option of segment.options) {
      if (option.name === "int") continue;
      if (
        option.name === "size" && option.arguments.length === 1 &&
        option.arguments[0]?.kind === "integer"
      ) {
        bitLength = option.arguments[0].value;
        continue;
      }
      return null;
    }
    appendInteger(segment.value.value, bitLength);
  }
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (const [index, bit] of bits.entries()) {
    const byteIndex = index >> 3;
    bytes[byteIndex] = bytes[byteIndex]! | bit << (7 - (index & 7));
  }
  return { bytes, bitLength: bits.length };
}

function parseIntegerToken(value: string): number {
  const integer = Number(value.replaceAll("_", ""));
  if (!Number.isFinite(integer) || !Number.isInteger(integer)) {
    throw new Error(`Baba produced invalid Gleam integer token ${JSON.stringify(value)}.`);
  }
  return integer;
}

function parseFloatToken(value: string): number {
  const float = Number(value.replaceAll("_", ""));
  if (!Number.isFinite(float)) {
    throw new Error(`Baba produced invalid Gleam float token ${JSON.stringify(value)}.`);
  }
  return float;
}

function foldOperator(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
  operator: GleamBinaryOperator,
): GleamExpression {
  return foldBinary(node, offsets, (left, right, span) => ({
    kind: "binary",
    operator,
    left,
    right,
    span,
  }));
}

function foldNamedOperators(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamExpression {
  let result = parseExpression(babaRequiredRuleField(node, "left"), offsets);
  for (const tail of babaRuleFieldArray(node, "rest")) {
    const operatorNode = babaChildRule(babaRequiredRuleField(tail, "op"));
    const right = parseExpression(babaRequiredRuleField(tail, "right"), offsets);
    result = {
      kind: "binary",
      operator: operatorText(operatorNode.name),
      left: result,
      right,
      span: offsets.span({ start: node.span.start, end: tail.span.end }),
    };
  }
  return result;
}

function foldBinary(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
  combine: (
    left: GleamExpression,
    right: GleamExpression,
    span: { readonly startByte: number; readonly endByte: number },
  ) => GleamExpression,
): GleamExpression {
  let result = parseExpression(babaRequiredRuleField(node, "left"), offsets);
  for (const tail of babaRuleFieldArray(node, "rest")) {
    const right = parseExpression(babaRequiredRuleField(tail, "right"), offsets);
    result = combine(
      result,
      right,
      offsets.span({ start: node.span.start, end: tail.span.end }),
    );
  }
  return result;
}

function pipeExpression(
  value: GleamExpression,
  target: GleamExpression,
  span: { readonly startByte: number; readonly endByte: number },
): GleamExpression {
  if (target.kind === "call") {
    if (target.arguments.some((argument) => argument.value.kind === "capture")) {
      return { kind: "call", callee: target, arguments: [positionalCallArgument(value)], span };
    }
    return { ...target, arguments: [positionalCallArgument(value), ...target.arguments], span };
  }
  return { kind: "call", callee: target, arguments: [positionalCallArgument(value)], span };
}

function positionalCallArgument(
  value: GleamExpression,
) {
  return { label: null, spread: false, value, span: value.span };
}

function listRules(node: BabaRuleCursor): readonly BabaRuleCursor[] {
  return [
    babaRequiredRuleField(node, "head"),
    ...babaRuleFieldArray(node, "tail").map((tail) => babaRequiredRuleField(tail, "value")),
  ];
}

function identifierList(node: BabaRuleCursor): readonly string[] {
  return [
    babaRequiredTokenField(node, "head").text,
    ...babaRuleFieldArray(node, "tail").map((tail) => babaRequiredTokenField(tail, "value").text),
  ];
}

function joinedName(node: BabaRuleCursor, separator: string): string {
  return [
    babaRequiredTokenField(node, "head").text,
    ...babaRuleFieldArray(node, "tail").map(nameTailValue),
  ].join(separator);
}

function nameTailValue(node: BabaRuleCursor): string {
  const value = babaOptionalTokenField(node, "value");
  if (value !== null) return value.text;
  const keyword = babaRequiredRuleField(node, "keyword");
  if (babaChildRule(keyword).name === "function_keyword") return "function";
  throw new Error(`Unsupported Baba Gleam qualified-name keyword ${keyword.name}.`);
}

function operatorText(name: string): GleamBinaryOperator {
  switch (name) {
    case "eq":
      return "==";
    case "ne":
      return "!=";
    case "lt":
      return "<";
    case "le":
      return "<=";
    case "gt":
      return ">";
    case "ge":
      return ">=";
    case "float_lt":
      return "<.";
    case "float_le":
      return "<=.";
    case "float_gt":
      return ">.";
    case "float_ge":
      return ">=.";
    case "plus":
      return "+";
    case "minus":
      return "-";
    case "float_plus":
      return "+.";
    case "float_minus":
      return "-.";
    case "star":
      return "*";
    case "slash":
      return "/";
    case "float_star":
      return "*.";
    case "float_slash":
      return "/.";
    case "remainder":
      return "%";
    default:
      throw new Error(`Unsupported Baba Gleam operator node ${name}.`);
  }
}

function startsLowercase(value: string): boolean {
  return /^[a-z]/.test(value);
}
