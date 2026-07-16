import type { FunctionalSpan } from "../functional/abi.ts";
import type {
  OneSubmlFunctionalBinaryOperator,
  OneSubmlFunctionalDefinition,
  OneSubmlFunctionalExpression,
  OneSubmlFunctionalPattern,
  OneSubmlFunctionalProgram,
  OneSubmlFunctionalRecordField,
  OneSubmlFunctionalType,
} from "./ast.ts";
import { OneSubmlFunctionalSyntaxError } from "./diagnostic.ts";
import {
  lexOneSubmlFunctionalSource,
  type OneSubmlFunctionalToken,
  type OneSubmlFunctionalTokenKind,
} from "./lexer.ts";

const binaryPrecedence: Readonly<Record<string, number>> = {
  "==": 1,
  "!=": 1,
  "<": 1,
  "<=": 1,
  ">": 1,
  ">=": 1,
  "+": 2,
  "-": 2,
  "*": 3,
  "/": 3,
};

const reservedNames = new Set(["let", "rec", "fun", "if", "then", "else", "true", "false"]);

export function parseOneSubmlFunctionalProgram(source: string): OneSubmlFunctionalProgram {
  return new OneSubmlFunctionalParser(lexOneSubmlFunctionalSource(source)).parseProgram();
}

class OneSubmlFunctionalParser {
  #position = 0;

  constructor(private readonly tokens: readonly OneSubmlFunctionalToken[]) {}

  parseProgram(): OneSubmlFunctionalProgram {
    const definitions: OneSubmlFunctionalDefinition[] = [];
    while (!this.checkKind("eof")) {
      if (this.consumeText(";")) continue;
      definitions.push(this.parseDefinition());
      this.expectText(";");
    }
    const first = definitions[0]?.span ?? this.current().span;
    return { definitions, span: combine(first, this.current().span) };
  }

  private parseDefinition(): OneSubmlFunctionalDefinition {
    const start = this.expectText("let");
    const recursive = this.consumeText("rec");
    const name = this.expectName("top-level value");
    this.expectText("=");
    const value = this.parseExpression();
    return {
      name: name.text,
      recursive,
      value,
      span: combine(start.span, value.span),
    };
  }

  private parseExpression(): OneSubmlFunctionalExpression {
    if (this.checkText("let")) return this.parseLetExpression();
    if (this.checkText("if")) return this.parseIfExpression();
    if (this.checkText("fun")) return this.parseLambdaExpression();
    return this.parseBinaryExpression(0);
  }

  private parseLetExpression(): OneSubmlFunctionalExpression {
    const start = this.expectText("let");
    const recursive = this.consumeText("rec");
    const pattern = this.parsePattern();
    if (recursive && pattern.kind !== "name") {
      throw this.syntax(pattern.span, "Recursive 1SubML bindings require a name pattern.");
    }
    this.expectText("=");
    const value = this.parseExpression();
    this.expectText(";");
    const body = this.parseExpression();
    return {
      kind: "let",
      pattern,
      recursive,
      value,
      body,
      span: combine(start.span, body.span),
    };
  }

  private parseIfExpression(): OneSubmlFunctionalExpression {
    const start = this.expectText("if");
    const condition = this.parseExpression();
    this.expectText("then");
    const consequent = this.parseExpression();
    this.expectText("else");
    const alternate = this.parseExpression();
    return {
      kind: "if",
      condition,
      consequent,
      alternate,
      span: combine(start.span, alternate.span),
    };
  }

  private parseLambdaExpression(): OneSubmlFunctionalExpression {
    const start = this.expectText("fun");
    const typeParameters: OneSubmlFunctionalToken[] = [];
    if (this.consumeText("[")) {
      do typeParameters.push(this.expectName("function type parameter")); while (
        this.consumeText(";")
      );
      this.expectText("]");
    }
    const parameter = this.parsePattern();
    const parameterType = this.consumeText(":") ? this.parseType() : null;
    const resultType = this.consumeText("::") ? this.parseReturnType() : null;
    this.expectText("->");
    const body = this.parseExpression();
    return {
      kind: "lambda",
      typeParameters: typeParameters.map((parameter) => parameter.text),
      parameter,
      parameterType,
      resultType,
      body,
      span: combine(start.span, body.span),
    };
  }

  private parseType(): OneSubmlFunctionalType {
    if (this.checkText("[")) return this.parseForallType();
    const parameter = this.parseTypeAtom();
    if (!this.consumeText("->")) return parameter;
    const result = this.parseType();
    return { kind: "function", parameter, result, span: combine(parameter.span, result.span) };
  }

  private parseReturnType(): OneSubmlFunctionalType {
    return this.parseTypeAtom();
  }

  private parseForallType(): OneSubmlFunctionalType {
    const start = this.expectText("[");
    const parameters: OneSubmlFunctionalToken[] = [];
    do parameters.push(this.expectName("forall type parameter")); while (this.consumeText(";"));
    this.expectText("]");
    this.expectText(".");
    const body = this.parseType();
    return {
      kind: "forall",
      parameters: parameters.map((parameter) => parameter.text),
      body,
      span: combine(start.span, body.span),
    };
  }

  private parseTypeAtom(): OneSubmlFunctionalType {
    const token = this.current();
    if (this.consumeText("(")) {
      const first = this.parseType();
      if (!this.consumeText(",")) {
        const end = this.expectText(")");
        return { ...first, span: combine(token.span, end.span) };
      }
      const second = this.parseType();
      const end = this.expectText(")");
      return { kind: "tuple", values: [first, second], span: combine(token.span, end.span) };
    }
    const name = this.expectName("type");
    if (name.text === "int") return { kind: "integer", span: name.span };
    if (name.text === "bool") return { kind: "boolean", span: name.span };
    if (name.text === "unit") return { kind: "unit", span: name.span };
    return { kind: "parameter", name: name.text, span: name.span };
  }

  private parseBinaryExpression(minimumPrecedence: number): OneSubmlFunctionalExpression {
    let expression = this.parseApplicationExpression();
    while (true) {
      const operator = this.current().text;
      const precedence = binaryPrecedence[operator];
      if (precedence === undefined || precedence < minimumPrecedence) break;
      this.advance();
      const right = this.parseBinaryExpression(precedence + 1);
      expression = {
        kind: "binary",
        operator: operator as OneSubmlFunctionalBinaryOperator,
        left: expression,
        right,
        span: combine(expression.span, right.span),
      };
    }
    return expression;
  }

  private parseApplicationExpression(): OneSubmlFunctionalExpression {
    const callee = this.parsePostfixExpression();
    if (!this.startsApplicationArgument()) return callee;
    const argument = this.parseApplicationExpression();
    return { kind: "apply", callee, argument, span: combine(callee.span, argument.span) };
  }

  private parsePostfixExpression(): OneSubmlFunctionalExpression {
    let expression = this.parseUnaryExpression();
    while (this.consumeText(".")) {
      const field = this.expectName("record field");
      expression = {
        kind: "field",
        value: expression,
        field: field.text,
        span: combine(expression.span, field.span),
      };
    }
    return expression;
  }

  private parseUnaryExpression(): OneSubmlFunctionalExpression {
    if (!this.consumeText("-")) return this.parseAtom();
    const start = this.previous();
    const value = this.parseUnaryExpression();
    return {
      kind: "binary",
      operator: "-",
      left: { kind: "integer", value: 0, span: start.span },
      right: value,
      span: combine(start.span, value.span),
    };
  }

  private parseAtom(): OneSubmlFunctionalExpression {
    const token = this.current();
    if (token.kind === "integer") {
      this.advance();
      const value = Number(token.text);
      if (!Number.isSafeInteger(value) || value > 2_147_483_647) {
        throw this.syntax(token.span, `1SubML integer ${token.text} is outside the i32 profile.`);
      }
      return { kind: "integer", value, span: token.span };
    }
    if (this.consumeText("true")) return { kind: "boolean", value: true, span: token.span };
    if (this.consumeText("false")) return { kind: "boolean", value: false, span: token.span };
    if (token.kind === "identifier" && !reservedNames.has(token.text)) {
      this.advance();
      return { kind: "name", name: token.text, span: token.span };
    }
    if (this.consumeText("(")) return this.parseParenthesizedExpression(token);
    if (this.consumeText("{")) return this.parseRecordExpression(token);
    throw this.syntax(
      token.span,
      `Expected a 1SubML expression; received ${this.describe(token)}.`,
    );
  }

  private parseParenthesizedExpression(
    start: OneSubmlFunctionalToken,
  ): OneSubmlFunctionalExpression {
    if (this.consumeText(")")) {
      return { kind: "unit", span: combine(start.span, this.previous().span) };
    }
    const first = this.parseExpression();
    if (!this.consumeText(",")) {
      const end = this.expectText(")");
      return { ...first, span: combine(start.span, end.span) };
    }
    const second = this.parseExpression();
    if (this.checkText(",")) {
      throw this.syntax(
        this.current().span,
        "1SubML functional tuples currently require two fields.",
      );
    }
    const end = this.expectText(")");
    return { kind: "tuple", values: [first, second], span: combine(start.span, end.span) };
  }

  private parseRecordExpression(start: OneSubmlFunctionalToken): OneSubmlFunctionalExpression {
    const fields: OneSubmlFunctionalRecordField[] = [];
    while (!this.checkText("}")) {
      const name = this.expectName("record field");
      const value = this.consumeText("=")
        ? this.parseExpression()
        : { kind: "name" as const, name: name.text, span: name.span };
      fields.push({ name: name.text, value, span: combine(name.span, value.span) });
      if (!this.consumeText(";")) break;
    }
    const end = this.expectText("}");
    return { kind: "record", fields, span: combine(start.span, end.span) };
  }

  private parsePattern(): OneSubmlFunctionalPattern {
    const token = this.current();
    if (token.kind === "identifier" && !reservedNames.has(token.text)) {
      this.advance();
      return { kind: "name", name: token.text === "_" ? null : token.text, span: token.span };
    }
    if (!this.consumeText("(")) {
      throw this.syntax(
        token.span,
        `Expected a 1SubML binding pattern; received ${this.describe(token)}.`,
      );
    }
    const first = this.parsePattern();
    this.expectText(",");
    const second = this.parsePattern();
    const end = this.expectText(")");
    return { kind: "tuple", values: [first, second], span: combine(token.span, end.span) };
  }

  private startsApplicationArgument(): boolean {
    const token = this.current();
    if (token.kind === "integer") return true;
    if (token.text === "true" || token.text === "false") return true;
    if (token.kind === "identifier") return !reservedNames.has(token.text);
    return token.text === "(" || token.text === "{";
  }

  private expectName(location: string): OneSubmlFunctionalToken {
    const token = this.current();
    if (token.kind === "identifier" && !reservedNames.has(token.text)) return this.advance();
    throw this.syntax(token.span, `Expected ${location}; received ${this.describe(token)}.`);
  }

  private checkText(text: string): boolean {
    return this.current().text === text;
  }

  private consumeText(text: string): boolean {
    if (!this.checkText(text)) return false;
    this.advance();
    return true;
  }

  private expectText(text: string): OneSubmlFunctionalToken {
    const token = this.current();
    if (token.text === text) return this.advance();
    throw this.syntax(
      token.span,
      `Expected ${JSON.stringify(text)}; received ${this.describe(token)}.`,
    );
  }

  private checkKind(kind: OneSubmlFunctionalTokenKind): boolean {
    return this.current().kind === kind;
  }

  private current(): OneSubmlFunctionalToken {
    const token = this.tokens[this.#position];
    if (token === undefined) throw new Error(`1SubML parser omitted token ${this.#position}.`);
    return token;
  }

  private previous(): OneSubmlFunctionalToken {
    const token = this.tokens[this.#position - 1];
    if (token === undefined) throw new Error("1SubML parser has no previous token.");
    return token;
  }

  private advance(): OneSubmlFunctionalToken {
    const token = this.current();
    if (token.kind !== "eof") this.#position++;
    return token;
  }

  private describe(token: OneSubmlFunctionalToken): string {
    return token.kind === "eof" ? "end of source" : JSON.stringify(token.text);
  }

  private syntax(span: FunctionalSpan, message: string): OneSubmlFunctionalSyntaxError {
    const token = this.current();
    return new OneSubmlFunctionalSyntaxError(
      span,
      `${message} At line ${token.line}, column ${token.column}.`,
    );
  }
}

function combine(first: FunctionalSpan, second: FunctionalSpan): FunctionalSpan {
  return { startByte: first.startByte, endByte: second.endByte };
}
