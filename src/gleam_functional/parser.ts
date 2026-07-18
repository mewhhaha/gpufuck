import { createParser } from "@mewhhaha/baba/runtime/generated-wasm";
import {
  babaChildRule,
  babaOptionalRuleField,
  babaRequiredRuleField,
  babaRequiredTokenField,
  type BabaRuleCursor,
  babaRuleFieldArray,
  BabaUtf8ByteOffsets,
} from "../baba_frontend.ts";
import type {
  GleamFunctionalBinaryOperator,
  GleamFunctionalCaseArm,
  GleamFunctionalConstant,
  GleamFunctionalConstructor,
  GleamFunctionalDeclaration,
  GleamFunctionalExpression,
  GleamFunctionalFunction,
  GleamFunctionalImport,
  GleamFunctionalModule,
  GleamFunctionalPattern,
  GleamFunctionalType,
  GleamFunctionalTypeAlias,
  GleamFunctionalTypeDeclaration,
} from "./ast.ts";
import { GleamFunctionalSyntaxError } from "./diagnostic.ts";

type GleamParser = ReturnType<typeof createParser>;

let gleamParser: GleamParser | undefined;

export function parseGleamFunctionalModule(
  name: string,
  source: string,
): GleamFunctionalModule {
  if (name.length === 0) throw new Error("Gleam module name must be nonempty");
  const byteOffsets = new BabaUtf8ByteOffsets(source);
  const parsed = getGleamParser().parse(source, { preserveTrivia: false });
  if (!parsed.ok) {
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic === undefined) {
      throw new Error(
        `Baba failed to parse Gleam module ${JSON.stringify(name)} without diagnostics.`,
      );
    }
    throw new GleamFunctionalSyntaxError(
      byteOffsets.span(diagnostic.span),
      `Gleam module ${JSON.stringify(name)}: ${diagnostic.code}: ${diagnostic.message}`,
    );
  }
  const declarations = babaRuleFieldArray(parsed.cursor, "declarations");
  const imports: GleamFunctionalImport[] = [];
  const values: GleamFunctionalDeclaration[] = [];
  for (const declaration of declarations) {
    const topLevel = babaChildRule(declaration);
    if (topLevel.name === "import_declaration") imports.push(parseImport(topLevel, byteOffsets));
    else values.push(parseDeclaration(topLevel, byteOffsets));
  }
  return {
    name,
    imports,
    declarations: values,
    span: { startByte: 0, endByte: byteOffsets.byteLength },
  };
}

function getGleamParser(): GleamParser {
  if (gleamParser !== undefined) return gleamParser;
  gleamParser = createParser({
    bytes: Deno.readFileSync(
      new URL("../../language/gleam/generated/wasm/parser.wasm", import.meta.url),
    ),
    plan: Deno.readFileSync(
      new URL("../../language/gleam/generated/wasm/parser.plan", import.meta.url),
    ),
  });
  return gleamParser;
}

function parseImport(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunctionalImport {
  const moduleNode = babaRequiredRuleField(node, "module");
  const module = joinedName(moduleNode, "/");
  const namesNode = babaOptionalRuleField(node, "names");
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
  return { module, names, span: offsets.span(node.span) };
}

function parseDeclaration(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunctionalDeclaration {
  if (node.name === "type_declaration") return parseTypeDeclaration(node, offsets);
  if (node.name === "constant_declaration") return parseConstant(node, offsets);
  if (node.name === "function_declaration") return parseFunction(node, offsets);
  throw new Error(`Unsupported Baba Gleam declaration node ${node.name}.`);
}

function parseConstant(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunctionalConstant {
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
): GleamFunctionalTypeDeclaration | GleamFunctionalTypeAlias {
  const parametersNode = babaOptionalRuleField(node, "parameters");
  const valuesNode = parametersNode === null
    ? null
    : babaOptionalRuleField(parametersNode, "values");
  const parameters = valuesNode === null ? [] : identifierList(valuesNode);
  const body = babaChildRule(babaRequiredRuleField(node, "body"));
  if (body.name === "type_alias_body") {
    if (babaOptionalRuleField(node, "opacity") !== null) {
      throw new GleamFunctionalSyntaxError(
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
): GleamFunctionalConstructor {
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
): GleamFunctionalFunction {
  const declaration = node.name === "function_declaration" ? babaChildRule(node) : node;
  const parametersNode = babaOptionalRuleField(declaration, "parameters");
  const resultNode = babaOptionalRuleField(declaration, "result");
  const externalNode = babaOptionalRuleField(declaration, "external");
  const bodyNode = babaOptionalRuleField(declaration, "body");
  if ((externalNode === null) === (bodyNode === null)) {
    throw new GleamFunctionalSyntaxError(
      offsets.span(declaration.span),
      "A Gleam function must have either a body or one @external annotation.",
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
    external: externalNode === null ? null : {
      target: babaRequiredTokenField(externalNode, "target").text,
      module: parseStringToken(
        babaRequiredTokenField(externalNode, "module"),
        offsets,
      ).value,
      name: parseStringToken(babaRequiredTokenField(externalNode, "name"), offsets).value,
    },
    span: offsets.span(node.span),
  };
}

function parseType(node: BabaRuleCursor, offsets: BabaUtf8ByteOffsets): GleamFunctionalType {
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
    return {
      kind: "tuple",
      values: [
        parseType(babaRequiredRuleField(type, "first"), offsets),
        parseType(babaRequiredRuleField(type, "second"), offsets),
        ...babaRuleFieldArray(type, "rest").map((tail) =>
          parseType(babaRequiredRuleField(tail, "value"), offsets)
        ),
      ],
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
      return startsLowercase(name)
        ? { kind: "parameter", name, span }
        : { kind: "named", name, arguments: arguments_, span };
  }
}

function parseBlock(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunctionalExpression {
  let expression = parseExpression(babaRequiredRuleField(node, "result"), offsets);
  const bindings = babaRuleFieldArray(node, "bindings");
  for (let index = bindings.length - 1; index >= 0; index--) {
    const binding = bindings[index]!;
    const statement = babaChildRule(binding);
    if (statement.name === "let_binding") {
      expression = {
        kind: "let",
        name: babaRequiredTokenField(statement, "name").text,
        value: parseExpression(babaRequiredRuleField(statement, "value"), offsets),
        body: expression,
        span: offsets.span({ start: binding.span.start, end: node.span.end }),
      };
      continue;
    }
    if (statement.name !== "use_binding") {
      throw new Error(`Unsupported Baba Gleam block binding ${statement.name}.`);
    }
    const parametersNode = babaOptionalRuleField(statement, "parameters");
    const callback: GleamFunctionalExpression = {
      kind: "lambda",
      parameters: parametersNode === null ? [] : identifierList(parametersNode),
      body: expression,
      span: offsets.span({ start: binding.span.start, end: node.span.end }),
    };
    const target = parseExpression(babaRequiredRuleField(statement, "value"), offsets);
    expression = target.kind === "call"
      ? { ...target, arguments: [...target.arguments, positionalCallArgument(callback)] }
      : {
        kind: "call",
        callee: target,
        arguments: [positionalCallArgument(callback)],
        span: offsets.span(statement.span),
      };
  }
  return { ...expression, span: offsets.span(node.span) };
}

function parseExpression(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunctionalExpression {
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
    case "call": {
      let result = parseExpression(babaRequiredRuleField(expression, "callee"), offsets);
      for (const call of babaRuleFieldArray(expression, "calls")) {
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
        parameters: parametersNode === null ? [] : identifierList(parametersNode),
        body: parseBlock(babaRequiredRuleField(expression, "body"), offsets),
        span: offsets.span(expression.span),
      };
    }
    case "tuple_expression":
      return {
        kind: "tuple",
        values: [
          parseExpression(babaRequiredRuleField(expression, "first"), offsets),
          parseExpression(babaRequiredRuleField(expression, "second"), offsets),
          ...babaRuleFieldArray(expression, "rest").map((tail) =>
            parseExpression(babaRequiredRuleField(tail, "value"), offsets)
          ),
        ],
        span: offsets.span(expression.span),
      };
    case "list_expression": {
      const entriesNode = babaOptionalRuleField(expression, "entries");
      const values: GleamFunctionalExpression[] = [];
      let tail: GleamFunctionalExpression | null = null;
      const entries = entriesNode === null ? [] : listRules(entriesNode);
      for (const [index, entry] of entries.entries()) {
        const value = babaChildRule(entry);
        if (value.name === "spread_list_expression") {
          if (index + 1 !== entries.length) {
            throw new GleamFunctionalSyntaxError(
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
      return {
        kind: "bit-array",
        bytes: parseStaticBitArray(expression, offsets),
        span: offsets.span(expression.span),
      };
    case "group_expression":
      return parseExpression(babaRequiredRuleField(expression, "body"), offsets);
    case "unit_expression":
      return { kind: "unit", span: offsets.span(expression.span) };
    case "float_expression":
      return {
        kind: "float",
        value: Number(babaRequiredTokenField(expression, "value").text),
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
          : parseStringToken(babaRequiredTokenField(message, "value"), offsets),
        span: offsets.span(expression.span),
      };
    }
    case "integer_expression":
      return {
        kind: "integer",
        value: Number(babaRequiredTokenField(expression, "value").text),
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
    case "named_expression":
      return {
        kind: "name",
        name: joinedName(babaRequiredRuleField(expression, "name"), "."),
        span: offsets.span(expression.span),
      };
    default:
      throw new Error(`Unsupported Baba Gleam expression node ${expression.name}.`);
  }
}

function parseStringToken(
  token: ReturnType<typeof babaRequiredTokenField>,
  offsets: BabaUtf8ByteOffsets,
): Extract<GleamFunctionalExpression, { readonly kind: "string" }> {
  try {
    return {
      kind: "string",
      value: JSON.parse(token.text) as string,
      span: offsets.span(token.span),
    };
  } catch (cause) {
    throw new GleamFunctionalSyntaxError(
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
): GleamFunctionalExpression {
  const subjectsNode = babaRequiredRuleField(node, "subjects");
  return {
    kind: "case",
    subjects: listRules(subjectsNode).map((subject) => parseExpression(subject, offsets)),
    arms: babaRuleFieldArray(node, "arms").flatMap((arm): readonly GleamFunctionalCaseArm[] => {
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
): GleamFunctionalPattern {
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
      const value = babaRequiredRuleField(pattern, "value");
      return { kind: "bit-array", bytes: parseStaticBitArray(value, offsets), span };
    }
    case "list_pattern": {
      const entriesNode = babaOptionalRuleField(pattern, "entries");
      const values: BabaRuleCursor[] = [];
      let result: GleamFunctionalPattern = { kind: "list-nil", span };
      const entries = entriesNode === null ? [] : listRules(entriesNode);
      for (const [index, entry] of entries.entries()) {
        const value = babaChildRule(entry);
        if (value.name !== "spread_list_pattern") {
          values.push(babaRequiredRuleField(value, "value"));
          continue;
        }
        if (index + 1 !== entries.length) {
          throw new GleamFunctionalSyntaxError(
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
    case "tuple_pattern":
      return {
        kind: "tuple",
        values: [
          parsePattern(babaRequiredRuleField(pattern, "first"), offsets),
          parsePattern(babaRequiredRuleField(pattern, "second"), offsets),
          ...babaRuleFieldArray(pattern, "rest").map((tail) =>
            parsePattern(babaRequiredRuleField(tail, "value"), offsets)
          ),
        ],
        span,
      };
    case "unit_pattern":
      return { kind: "unit", span };
    case "integer_pattern":
      return {
        kind: "integer",
        value: Number(babaRequiredTokenField(pattern, "value").text),
        span,
      };
    case "boolean_pattern":
      return { kind: "boolean", value: babaChildRule(pattern).name === "truth", span };
    case "named_pattern": {
      const name = joinedName(babaRequiredRuleField(pattern, "name"), ".");
      const argumentsNode = babaOptionalRuleField(pattern, "arguments");
      if (argumentsNode === null && startsLowercase(name)) {
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
            throw new GleamFunctionalSyntaxError(
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

function parseStaticBitArray(
  expression: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): Uint8Array {
  const segmentsNode = babaOptionalRuleField(expression, "segments");
  if (segmentsNode === null) return new Uint8Array();
  const bytes: number[] = [];
  for (const segment of listRules(segmentsNode)) {
    const value = babaChildRule(babaRequiredRuleField(segment, "value"));
    const encodingNode = babaOptionalRuleField(segment, "encoding");
    const encoding = encodingNode === null ? null : babaRequiredTokenField(encodingNode, "value");
    if (value.name === "string_bit_array_segment") {
      if (encoding?.text !== "utf8") {
        throw new GleamFunctionalSyntaxError(
          encoding === null ? offsets.span(value.span) : offsets.span(encoding.span),
          "A portable Gleam bit-array string segment must use the utf8 encoding.",
        );
      }
      const text = parseStringToken(babaRequiredTokenField(value, "value"), offsets).value;
      bytes.push(...new TextEncoder().encode(text));
      continue;
    }
    if (encoding !== null && encoding.text !== "int") {
      throw new GleamFunctionalSyntaxError(
        offsets.span(encoding.span),
        `A portable Gleam bit-array integer segment supports only int encoding; received ${encoding.text}.`,
      );
    }
    const token = babaRequiredTokenField(value, "value");
    const byte = Number(token.text);
    if (byte <= 255) {
      bytes.push(byte);
      continue;
    }
    throw new GleamFunctionalSyntaxError(
      offsets.span(token.span),
      `A portable Gleam bit-array byte must be within 0..255; received ${token.text}.`,
    );
  }
  return new Uint8Array(bytes);
}

function foldOperator(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
  operator: GleamFunctionalBinaryOperator,
): GleamFunctionalExpression {
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
): GleamFunctionalExpression {
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
    left: GleamFunctionalExpression,
    right: GleamFunctionalExpression,
    span: { readonly startByte: number; readonly endByte: number },
  ) => GleamFunctionalExpression,
): GleamFunctionalExpression {
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
  value: GleamFunctionalExpression,
  target: GleamFunctionalExpression,
  span: { readonly startByte: number; readonly endByte: number },
): GleamFunctionalExpression {
  if (target.kind === "call") {
    if (target.arguments.some((argument) => argument.value.kind === "capture")) {
      return { kind: "call", callee: target, arguments: [positionalCallArgument(value)], span };
    }
    return { ...target, arguments: [positionalCallArgument(value), ...target.arguments], span };
  }
  return { kind: "call", callee: target, arguments: [positionalCallArgument(value)], span };
}

function positionalCallArgument(
  value: GleamFunctionalExpression,
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
    ...babaRuleFieldArray(node, "tail").map((tail) => babaRequiredTokenField(tail, "value").text),
  ].join(separator);
}

function operatorText(name: string): GleamFunctionalBinaryOperator {
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
