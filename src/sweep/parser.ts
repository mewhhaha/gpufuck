/**
 * A hand-written recursive-descent parser for Sweep.
 *
 * Hand-written rather than generated because the grammar is deliberately small and because
 * BASELINE.md measures baba at ~1.4 MB/s against tree-sitter's 10–30; a language arguing for cheap
 * compilation should not import an expensive parser to prove it.
 *
 * Diagnostics are returned, never thrown — TASKS item 11 records what the alternative costs a tool
 * that drives a frontend in bulk.
 *
 * @module
 */
import type {
  SweepArm,
  SweepBinaryOperator,
  SweepConstructor,
  SweepExpression,
  SweepFunction,
  SweepModule,
  SweepParameter,
  SweepSpan,
  SweepType,
  SweepTypeDeclaration,
} from "./ast.ts";

export interface SweepDiagnostic {
  readonly message: string;
  readonly span: SweepSpan;
}

export type SweepParseResult =
  | { readonly ok: true; readonly module: SweepModule }
  | { readonly ok: false; readonly diagnostics: readonly SweepDiagnostic[] };

const KEYWORDS = new Set([
  "fn",
  "type",
  "let",
  "in",
  "if",
  "then",
  "else",
  "match",
  "export",
  "true",
  "false",
]);

interface Token {
  readonly kind: "name" | "integer" | "symbol" | "end";
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/** Longest first, so `->` and `<=` win over `-` and `<`. */
const SYMBOLS = [
  "->",
  "<=",
  ">=",
  "==",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  ",",
  ";",
  ":",
  "=",
  "+",
  "-",
  "*",
  "<",
  ">",
  "|",
];

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index]!;
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      index++;
      continue;
    }
    if (character === "-" && source[index + 1] === "-") {
      while (index < source.length && source[index] !== "\n") index++;
      continue;
    }
    const start = index;
    if (/[A-Za-z_]/.test(character)) {
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) index++;
      tokens.push({ kind: "name", text: source.slice(start, index), start, end: index });
      continue;
    }
    if (/[0-9]/.test(character)) {
      while (index < source.length && /[0-9]/.test(source[index]!)) index++;
      tokens.push({ kind: "integer", text: source.slice(start, index), start, end: index });
      continue;
    }
    const symbol = SYMBOLS.find((candidate) => source.startsWith(candidate, index));
    if (symbol === undefined) {
      tokens.push({ kind: "symbol", text: character, start, end: index + 1 });
      index++;
      continue;
    }
    index += symbol.length;
    tokens.push({ kind: "symbol", text: symbol, start, end: index });
  }
  tokens.push({ kind: "end", text: "", start: source.length, end: source.length });
  return tokens;
}

class ParseError extends Error {
  constructor(readonly diagnostic: SweepDiagnostic) {
    super(diagnostic.message);
  }
}

class Parser {
  #index = 0;
  constructor(private readonly tokens: readonly Token[], private readonly name: string) {}

  #peek(): Token {
    return this.tokens[this.#index]!;
  }

  #at(text: string): boolean {
    return this.#peek().text === text && this.#peek().kind !== "integer";
  }

  #span(token: Token): SweepSpan {
    return { startByte: token.start, endByte: token.end };
  }

  #fail(message: string): never {
    throw new ParseError({ message, span: this.#span(this.#peek()) });
  }

  #take(text: string): Token {
    if (!this.#at(text)) {
      this.#fail(
        `expected ${JSON.stringify(text)}, found ${
          JSON.stringify(this.#peek().text || "end of input")
        }`,
      );
    }
    return this.tokens[this.#index++]!;
  }

  #takeName(what: string): Token {
    const token = this.#peek();
    if (token.kind !== "name" || KEYWORDS.has(token.text)) this.#fail(`expected ${what}`);
    this.#index++;
    return token;
  }

  parseModule(): SweepModule {
    const exports: string[] = [];
    const types: SweepTypeDeclaration[] = [];
    const functions: SweepFunction[] = [];
    while (this.#peek().kind !== "end") {
      if (this.#at("export")) {
        this.#take("export");
        exports.push(this.#takeName("an exported name").text);
        while (this.#at(",")) {
          this.#take(",");
          exports.push(this.#takeName("an exported name").text);
        }
        this.#take(";");
        continue;
      }
      if (this.#at("type")) types.push(this.#parseType());
      else if (this.#at("fn")) functions.push(this.#parseFunction());
      else this.#fail(`expected "export", "type", or "fn"`);
    }
    return { name: this.name, exports, types, functions };
  }

  #parseType(): SweepTypeDeclaration {
    const start = this.#take("type");
    const name = this.#takeName("a type name").text;
    const parameters: string[] = [];
    if (this.#at("[")) {
      this.#take("[");
      parameters.push(this.#takeName("a type parameter").text);
      while (this.#at(",")) {
        this.#take(",");
        parameters.push(this.#takeName("a type parameter").text);
      }
      this.#take("]");
    }
    this.#take("=");
    const constructors: SweepConstructor[] = [this.#parseConstructor(parameters)];
    while (this.#at("|")) {
      this.#take("|");
      constructors.push(this.#parseConstructor(parameters));
    }
    const end = this.#take(";");
    return { name, parameters, constructors, span: { startByte: start.start, endByte: end.end } };
  }

  #parseConstructor(typeParameters: readonly string[]): SweepConstructor {
    const name = this.#takeName("a constructor name");
    const fields: { name: string; type: SweepType }[] = [];
    if (this.#at("(")) {
      this.#take("(");
      if (!this.#at(")")) {
        do {
          const fieldName = this.#takeName("a field name").text;
          this.#take(":");
          fields.push({ name: fieldName, type: this.#parseTypeExpression(typeParameters) });
        } while (this.#at(",") && (this.#take(","), !this.#at(")")));
      }
      this.#take(")");
    }
    return { name: name.text, fields, span: this.#span(name) };
  }

  #parseTypeExpression(typeParameters: readonly string[]): SweepType {
    if (this.#at("(")) {
      // A parenthesised parameter list is a function type: (Int, Int) -> Int
      this.#take("(");
      const parameters: SweepType[] = [];
      if (!this.#at(")")) {
        do parameters.push(this.#parseTypeExpression(typeParameters)); while (
          this.#at(",") && (this.#take(","), !this.#at(")"))
        );
      }
      this.#take(")");
      this.#take("->");
      return { kind: "function", parameters, result: this.#parseTypeExpression(typeParameters) };
    }
    const name = this.#takeName("a type").text;
    if (typeParameters.includes(name)) return { kind: "parameter", name };
    const args: SweepType[] = [];
    if (this.#at("[")) {
      this.#take("[");
      do args.push(this.#parseTypeExpression(typeParameters)); while (
        this.#at(",") && (this.#take(","), !this.#at("]"))
      );
      this.#take("]");
    }
    return { kind: "name", name, arguments: args };
  }

  #parseFunction(): SweepFunction {
    const start = this.#take("fn");
    const name = this.#takeName("a function name").text;
    const typeParameters: string[] = [];
    if (this.#at("[")) {
      this.#take("[");
      typeParameters.push(this.#takeName("a type parameter").text);
      while (this.#at(",")) {
        this.#take(",");
        typeParameters.push(this.#takeName("a type parameter").text);
      }
      this.#take("]");
    }
    this.#take("(");
    const parameters: SweepParameter[] = [];
    if (!this.#at(")")) {
      do {
        const parameterName = this.#takeName("a parameter name").text;
        // Rule 1: there is no syntax for an unannotated parameter.
        this.#take(":");
        parameters.push({ name: parameterName, type: this.#parseTypeExpression(typeParameters) });
      } while (this.#at(",") && (this.#take(","), !this.#at(")")));
    }
    this.#take(")");
    this.#take("->");
    const result = this.#parseTypeExpression(typeParameters);
    this.#take("=");
    const body = this.#parseExpression(typeParameters);
    const end = this.#take(";");
    return {
      name,
      typeParameters,
      parameters,
      result,
      body,
      span: { startByte: start.start, endByte: end.end },
    };
  }

  #parseExpression(typeParameters: readonly string[]): SweepExpression {
    return this.#parseComparison(typeParameters);
  }

  #parseComparison(typeParameters: readonly string[]): SweepExpression {
    let left = this.#parseSum(typeParameters);
    const operators: Record<string, SweepBinaryOperator> = {
      "<": "less",
      "<=": "less-equal",
      ">": "greater",
      ">=": "greater-equal",
      "==": "equal",
    };
    while (operators[this.#peek().text] !== undefined && this.#peek().kind === "symbol") {
      const operator = operators[this.tokens[this.#index++]!.text]!;
      const right = this.#parseSum(typeParameters);
      left = {
        kind: "binary",
        operator,
        left,
        right,
        span: { startByte: left.span.startByte, endByte: right.span.endByte },
      };
    }
    return left;
  }

  #parseSum(typeParameters: readonly string[]): SweepExpression {
    let left = this.#parseProduct(typeParameters);
    while (this.#at("+") || this.#at("-")) {
      const operator: SweepBinaryOperator = this.tokens[this.#index++]!.text === "+"
        ? "add"
        : "subtract";
      const right = this.#parseProduct(typeParameters);
      left = {
        kind: "binary",
        operator,
        left,
        right,
        span: { startByte: left.span.startByte, endByte: right.span.endByte },
      };
    }
    return left;
  }

  #parseProduct(typeParameters: readonly string[]): SweepExpression {
    let left = this.#parseAtom(typeParameters);
    while (this.#at("*")) {
      this.#take("*");
      const right = this.#parseAtom(typeParameters);
      left = {
        kind: "binary",
        operator: "multiply",
        left,
        right,
        span: { startByte: left.span.startByte, endByte: right.span.endByte },
      };
    }
    return left;
  }

  #parseAtom(typeParameters: readonly string[]): SweepExpression {
    const token = this.#peek();
    if (token.kind === "integer") {
      this.#index++;
      return { kind: "integer", value: Number(token.text), span: this.#span(token) };
    }
    if (this.#at("true") || this.#at("false")) {
      this.#index++;
      return { kind: "boolean", value: token.text === "true", span: this.#span(token) };
    }
    if (this.#at("(")) {
      this.#take("(");
      const inner = this.#parseExpression(typeParameters);
      this.#take(")");
      return inner;
    }
    if (this.#at("let")) return this.#parseLet(typeParameters);
    if (this.#at("if")) return this.#parseIf(typeParameters);
    if (this.#at("match")) return this.#parseMatch(typeParameters);

    const name = this.#takeName("an expression");
    // Rule 2: `f[Int](x)` — type arguments are part of the call, never recovered by inference.
    const typeArguments: SweepType[] = [];
    if (this.#at("[")) {
      this.#take("[");
      do typeArguments.push(this.#parseTypeExpression(typeParameters)); while (
        this.#at(",") && (this.#take(","), !this.#at("]"))
      );
      this.#take("]");
    }
    if (this.#at("(")) {
      this.#take("(");
      const args: SweepExpression[] = [];
      if (!this.#at(")")) {
        do args.push(this.#parseExpression(typeParameters)); while (
          this.#at(",") && (this.#take(","), !this.#at(")"))
        );
      }
      const close = this.#take(")");
      const span = { startByte: name.start, endByte: close.end };
      // Uppercase means a constructor; the distinction is lexical so no resolution is needed here.
      return /^[A-Z]/.test(name.text)
        ? {
          kind: "construct",
          constructor: name.text,
          typeArguments,
          arguments: args,
          span,
        }
        : { kind: "call", callee: name.text, typeArguments, arguments: args, span };
    }
    if (typeArguments.length > 0) this.#fail("type arguments require a call");
    return /^[A-Z]/.test(name.text)
      ? {
        kind: "construct",
        constructor: name.text,
        typeArguments: [],
        arguments: [],
        span: this.#span(name),
      }
      : { kind: "name", name: name.text, span: this.#span(name) };
  }

  #parseLet(typeParameters: readonly string[]): SweepExpression {
    const start = this.#take("let");
    const name = this.#takeName("a binding name").text;
    this.#take(":");
    const type = this.#parseTypeExpression(typeParameters);
    this.#take("=");
    const value = this.#parseExpression(typeParameters);
    this.#take("in");
    const body = this.#parseExpression(typeParameters);
    return {
      kind: "let",
      name,
      type,
      value,
      body,
      span: { startByte: start.start, endByte: body.span.endByte },
    };
  }

  #parseIf(typeParameters: readonly string[]): SweepExpression {
    const start = this.#take("if");
    const condition = this.#parseExpression(typeParameters);
    this.#take("then");
    const consequent = this.#parseExpression(typeParameters);
    this.#take("else");
    const alternate = this.#parseExpression(typeParameters);
    return {
      kind: "if",
      condition,
      consequent,
      alternate,
      span: { startByte: start.start, endByte: alternate.span.endByte },
    };
  }

  #parseMatch(typeParameters: readonly string[]): SweepExpression {
    const start = this.#take("match");
    const subject = this.#parseExpression(typeParameters);
    this.#take("{");
    const arms: SweepArm[] = [];
    while (!this.#at("}")) {
      const constructor = this.#takeName("a constructor name");
      const binders: string[] = [];
      if (this.#at("(")) {
        this.#take("(");
        if (!this.#at(")")) {
          do binders.push(this.#takeName("a binder").text); while (
            this.#at(",") && (this.#take(","), !this.#at(")"))
          );
        }
        this.#take(")");
      }
      this.#take("->");
      const body = this.#parseExpression(typeParameters);
      this.#take(";");
      arms.push({ constructor: constructor.text, binders, body, span: this.#span(constructor) });
    }
    const end = this.#take("}");
    return { kind: "match", subject, arms, span: { startByte: start.start, endByte: end.end } };
  }
}

export function parseSweepModule(name: string, source: string): SweepParseResult {
  try {
    return { ok: true, module: new Parser(tokenize(source), name).parseModule() };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, diagnostics: [error.diagnostic] };
    throw error;
  }
}
