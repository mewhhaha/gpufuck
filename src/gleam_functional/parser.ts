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
  GleamFunctionalConstructor,
  GleamFunctionalDeclaration,
  GleamFunctionalExpression,
  GleamFunctionalFunction,
  GleamFunctionalImport,
  GleamFunctionalModule,
  GleamFunctionalPattern,
  GleamFunctionalType,
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
    const name = babaRequiredTokenField(imported, "name");
    const aliasNode = babaOptionalRuleField(imported, "alias");
    return {
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
  if (node.name === "function_declaration") return parseFunction(node, offsets);
  throw new Error(`Unsupported Baba Gleam declaration node ${node.name}.`);
}

function parseTypeDeclaration(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunctionalTypeDeclaration {
  const parametersNode = babaOptionalRuleField(node, "parameters");
  const valuesNode = parametersNode === null
    ? null
    : babaOptionalRuleField(parametersNode, "values");
  return {
    kind: "type",
    public: babaOptionalRuleField(node, "visibility") !== null,
    opaque: babaOptionalRuleField(node, "opacity") !== null,
    name: babaRequiredTokenField(node, "name").text,
    parameters: valuesNode === null ? [] : identifierList(valuesNode),
    constructors: babaRuleFieldArray(node, "constructors").map((constructor) =>
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
  const parametersNode = babaOptionalRuleField(node, "parameters");
  const resultNode = babaOptionalRuleField(node, "result");
  return {
    kind: "function",
    public: babaOptionalRuleField(node, "visibility") !== null,
    name: babaRequiredTokenField(node, "name").text,
    parameters: parametersNode === null ? [] : listRules(parametersNode).map((parameter) => {
      const annotation = babaOptionalRuleField(parameter, "annotation");
      return {
        name: babaRequiredTokenField(parameter, "name").text,
        annotation: annotation === null
          ? null
          : parseType(babaRequiredRuleField(annotation, "type"), offsets),
        span: offsets.span(parameter.span),
      };
    }),
    result: resultNode === null
      ? null
      : parseType(babaRequiredRuleField(resultNode, "type"), offsets),
    body: parseBlock(babaRequiredRuleField(node, "body"), offsets),
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
      ],
      span,
    };
  }
  if (type.name !== "named_type") throw new Error(`Unsupported Baba Gleam type node ${type.name}.`);
  const name = babaRequiredTokenField(type, "name").text;
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
    expression = {
      kind: "let",
      name: babaRequiredTokenField(binding, "name").text,
      value: parseExpression(babaRequiredRuleField(binding, "value"), offsets),
      body: expression,
      span: offsets.span({ start: binding.span.start, end: node.span.end }),
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
        const arguments_ = valuesNode === null
          ? []
          : listRules(valuesNode).map((argument) =>
            parseExpression(babaRequiredRuleField(babaChildRule(argument), "value"), offsets)
          );
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
        ],
        span: offsets.span(expression.span),
      };
    case "list_expression": {
      const valuesNode = babaOptionalRuleField(expression, "values");
      return {
        kind: "list",
        values: valuesNode === null
          ? []
          : listRules(valuesNode).map((value) => parseExpression(value, offsets)),
        span: offsets.span(expression.span),
      };
    }
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

function parseCase(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunctionalExpression {
  const subjectsNode = babaRequiredRuleField(node, "subjects");
  return {
    kind: "case",
    subjects: listRules(subjectsNode).map((subject) => parseExpression(subject, offsets)),
    arms: babaRuleFieldArray(node, "arms").map((arm): GleamFunctionalCaseArm => {
      const patternsNode = babaRequiredRuleField(arm, "patterns");
      return {
        patterns: listRules(patternsNode).map((pattern) => parsePattern(pattern, offsets)),
        body: parseExpression(babaRequiredRuleField(arm, "body"), offsets),
        span: offsets.span(arm.span),
      };
    }),
    span: offsets.span(node.span),
  };
}

function parsePattern(
  node: BabaRuleCursor,
  offsets: BabaUtf8ByteOffsets,
): GleamFunctionalPattern {
  if (node.name === "pattern" || node.name === "list_pattern") {
    return parsePattern(babaChildRule(node), offsets);
  }
  const pattern = node;
  const span = offsets.span(pattern.span);
  switch (pattern.name) {
    case "discard_pattern":
      return { kind: "discard", span };
    case "list_nil_pattern":
      return { kind: "list-nil", span };
    case "list_cons_pattern":
      return {
        kind: "list-cons",
        head: parsePattern(babaRequiredRuleField(pattern, "head"), offsets),
        tail: parsePattern(babaRequiredRuleField(pattern, "tail"), offsets),
        span,
      };
    case "tuple_pattern":
      return {
        kind: "tuple",
        values: [
          parsePattern(babaRequiredRuleField(pattern, "first"), offsets),
          parsePattern(babaRequiredRuleField(pattern, "second"), offsets),
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
      const name = babaRequiredTokenField(pattern, "name").text;
      const argumentsNode = babaOptionalRuleField(pattern, "arguments");
      if (argumentsNode === null && startsLowercase(name)) {
        return { kind: "variable", name, span };
      }
      const valuesNode = argumentsNode === null
        ? null
        : babaOptionalRuleField(argumentsNode, "values");
      return {
        kind: "constructor",
        name,
        arguments: valuesNode === null
          ? []
          : listRules(valuesNode).map((argument) =>
            parsePattern(babaRequiredRuleField(babaChildRule(argument), "value"), offsets)
          ),
        span,
      };
    }
    default:
      throw new Error(`Unsupported Baba Gleam pattern node ${pattern.name}.`);
  }
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
  if (target.kind === "call") return { ...target, arguments: [value, ...target.arguments], span };
  return { kind: "call", callee: target, arguments: [value], span };
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
    default:
      throw new Error(`Unsupported Baba Gleam operator node ${name}.`);
  }
}

function startsLowercase(value: string): boolean {
  return /^[a-z]/.test(value);
}
