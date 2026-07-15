import type { FunctionalSpan } from "../functional/abi.ts";
import type {
  OcamlFunctionalBinaryOperator,
  OcamlFunctionalConstructor,
  OcamlFunctionalDeclaration,
  OcamlFunctionalDefinition,
  OcamlFunctionalExpression,
  OcamlFunctionalMatchArm,
  OcamlFunctionalPattern,
  OcamlFunctionalPatternBinder,
  OcamlFunctionalProgram,
  OcamlFunctionalType,
  OcamlFunctionalTypeDeclaration,
} from "./ast.ts";
import { OcamlFunctionalSyntaxError } from "./diagnostic.ts";
import {
  lexOcamlFunctionalSource,
  type OcamlFunctionalToken,
  type OcamlFunctionalTokenKind,
} from "./lexer.ts";

const binaryPrecedence: Readonly<Record<string, number>> = {
  "=": 1,
  "<>": 1,
  "<": 1,
  "<=": 1,
  ">": 1,
  ">=": 1,
  "+": 2,
  "-": 2,
  "*": 3,
  "/": 3,
};

const expressionKeywords = new Set([
  "let",
  "rec",
  "in",
  "if",
  "then",
  "else",
  "match",
  "with",
  "fun",
  "type",
  "of",
]);
const typeKeywords = new Set(["let", "type", "of", "in", "with"]);

export function parseOcamlFunctionalProgram(source: string): OcamlFunctionalProgram {
  return new OcamlFunctionalParser(lexOcamlFunctionalSource(source)).parseProgram();
}

class OcamlFunctionalParser {
  #position = 0;

  constructor(private readonly tokens: readonly OcamlFunctionalToken[]) {}

  parseProgram(): OcamlFunctionalProgram {
    const declarations: OcamlFunctionalDeclaration[] = [];
    while (!this.checkKind("eof")) {
      if (this.consumeText(";;")) continue;
      declarations.push(this.parseDeclaration());
      this.consumeText(";;");
    }
    const first = declarations[0]?.span ?? this.current().span;
    return {
      declarations,
      span: combine(first, this.current().span),
    };
  }

  private parseDeclaration(): OcamlFunctionalDeclaration {
    if (this.checkText("type")) return this.parseTypeDeclaration();
    if (this.checkText("let")) return this.parseDefinition();
    throw this.syntax(
      this.current(),
      `Expected an OCaml type or let declaration; received ${this.describe(this.current())}.`,
    );
  }

  private parseTypeDeclaration(): OcamlFunctionalTypeDeclaration {
    const start = this.expectText("type");
    const parameters: OcamlFunctionalToken[] = [];
    if (this.consumeText("(")) {
      do parameters.push(this.expectTypeParameter()); while (this.consumeText(","));
      this.expectText(")");
    } else if (this.checkTypeParameter()) {
      parameters.push(this.advance());
    }
    const name = this.expectLowerIdentifier("type name");
    this.expectText("=");
    const constructors: OcamlFunctionalConstructor[] = [];
    this.consumeText("|");
    do {
      constructors.push(this.parseConstructor());
    } while (!this.atTopLevelBoundary() && this.consumeText("|"));
    if (constructors.length === 0) {
      throw this.syntax(name, `OCaml type ${JSON.stringify(name.text)} has no constructors.`);
    }
    return {
      kind: "type",
      name: name.text,
      parameters: parameters.map((parameter) => parameter.text.slice(1)),
      constructors,
      span: combine(start.span, constructors.at(-1)?.span ?? name.span),
    };
  }

  private parseConstructor(): OcamlFunctionalConstructor {
    const name = this.expectUpperIdentifier("variant constructor");
    const fields: OcamlFunctionalType[] = [];
    if (this.consumeText("of")) {
      do fields.push(this.parseTypeApplication()); while (this.consumeText("*"));
    }
    return {
      name: name.text,
      fields,
      span: combine(name.span, fields.at(-1)?.span ?? name.span),
    };
  }

  private parseDefinition(): OcamlFunctionalDefinition {
    const start = this.expectText("let");
    const recursive = this.consumeText("rec");
    const name = this.expectLowerIdentifier("value name");
    const parameters: OcamlFunctionalToken[] = [];
    while (this.checkLowerIdentifier() && !this.checkText("=")) parameters.push(this.advance());
    this.expectText("=");
    const body = this.parseExpression();
    return {
      kind: "definition",
      name: name.text,
      recursive,
      parameters: parameters.map((parameter) => parameter.text),
      body,
      span: combine(start.span, body.span),
    };
  }

  private parseType(): OcamlFunctionalType {
    const parameter = this.parseTupleType();
    if (!this.consumeText("->")) return parameter;
    const result = this.parseType();
    return {
      kind: "function",
      parameter,
      result,
      span: combine(parameter.span, result.span),
    };
  }

  private parseTupleType(): OcamlFunctionalType {
    let type = this.parseTypeApplication();
    while (this.consumeText("*")) {
      const second = this.parseTypeApplication();
      type = { kind: "tuple", values: [type, second], span: combine(type.span, second.span) };
    }
    return type;
  }

  private parseTypeApplication(): OcamlFunctionalType {
    let type = this.parseTypeAtom();
    while (this.checkLowerIdentifier() && !typeKeywords.has(this.current().text)) {
      const constructor = this.advance();
      type = {
        kind: "named",
        name: constructor.text,
        arguments: [type],
        span: combine(type.span, constructor.span),
      };
    }
    return type;
  }

  private parseTypeAtom(): OcamlFunctionalType {
    const start = this.current();
    if (this.consumeText("(")) {
      const type = this.parseType();
      const end = this.expectText(")");
      return { ...type, span: combine(start.span, end.span) };
    }
    if (this.checkTypeParameter()) {
      const parameter = this.advance();
      return { kind: "parameter", name: parameter.text.slice(1), span: parameter.span };
    }
    const name = this.expectLowerIdentifier("type");
    if (name.text === "int") return { kind: "integer", span: name.span };
    if (name.text === "bool") return { kind: "boolean", span: name.span };
    if (name.text === "unit") return { kind: "unit", span: name.span };
    return { kind: "named", name: name.text, arguments: [], span: name.span };
  }

  private parseExpression(): OcamlFunctionalExpression {
    if (this.checkText("let")) return this.parseLetExpression();
    if (this.checkText("if")) return this.parseIfExpression();
    if (this.checkText("match")) return this.parseMatchExpression();
    if (this.checkText("fun")) return this.parseLambdaExpression();
    return this.parseConsExpression();
  }

  private parseLetExpression(): OcamlFunctionalExpression {
    const start = this.expectText("let");
    const recursive = this.consumeText("rec");
    const name = this.expectLowerIdentifier("local value name");
    const parameters: OcamlFunctionalToken[] = [];
    while (this.checkLowerIdentifier() && !this.checkText("=")) parameters.push(this.advance());
    this.expectText("=");
    const value = this.parseExpression();
    this.expectText("in");
    const body = this.parseExpression();
    if (recursive && parameters.length === 0) {
      throw this.syntax(name, "OCaml recursive local bindings require a function parameter here.");
    }
    return {
      kind: "let",
      name: name.text,
      recursive,
      parameters: parameters.map((parameter) => parameter.text),
      value,
      body,
      span: combine(start.span, body.span),
    };
  }

  private parseIfExpression(): OcamlFunctionalExpression {
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

  private parseMatchExpression(): OcamlFunctionalExpression {
    const start = this.expectText("match");
    const value = this.parseExpression();
    this.expectText("with");
    const arms: OcamlFunctionalMatchArm[] = [];
    this.consumeText("|");
    do {
      const pattern = this.parsePattern();
      this.expectText("->");
      const body = this.parseExpression();
      arms.push({ pattern, body, span: combine(pattern.span, body.span) });
    } while (!this.atTopLevelBoundary() && this.consumeText("|"));
    if (arms.length === 0) throw this.syntax(start, "OCaml match requires an arm.");
    return {
      kind: "match",
      value,
      arms,
      span: combine(start.span, arms.at(-1)?.span ?? start.span),
    };
  }

  private parseLambdaExpression(): OcamlFunctionalExpression {
    const start = this.expectText("fun");
    const parameters: OcamlFunctionalToken[] = [];
    while (this.checkLowerIdentifier()) parameters.push(this.advance());
    if (parameters.length === 0) {
      throw this.syntax(this.current(), "OCaml lambdas require at least one variable parameter.");
    }
    this.expectText("->");
    const body = this.parseExpression();
    return {
      kind: "lambda",
      parameters: parameters.map((parameter) => parameter.text),
      body,
      span: combine(start.span, body.span),
    };
  }

  private parseConsExpression(): OcamlFunctionalExpression {
    const head = this.parseBinaryExpression(0);
    if (!this.consumeText("::")) return head;
    const tail = this.parseExpression();
    return { kind: "list-cons", head, tail, span: combine(head.span, tail.span) };
  }

  private parseBinaryExpression(minimumPrecedence: number): OcamlFunctionalExpression {
    let left = this.parseApplication();
    while (true) {
      const operator = this.current().text;
      const precedence = binaryPrecedence[operator];
      if (precedence === undefined || precedence < minimumPrecedence) return left;
      this.advance();
      const right = this.parseBinaryExpression(precedence + 1);
      left = {
        kind: "binary",
        operator: operator as OcamlFunctionalBinaryOperator,
        left,
        right,
        span: combine(left.span, right.span),
      };
    }
  }

  private parseApplication(): OcamlFunctionalExpression {
    let expression = this.parseExpressionAtom();
    while (this.startsExpressionAtom()) {
      const argument = this.parseExpressionAtom();
      expression = {
        kind: "apply",
        callee: expression,
        argument,
        span: combine(expression.span, argument.span),
      };
    }
    return expression;
  }

  private parseExpressionAtom(): OcamlFunctionalExpression {
    const start = this.current();
    if (this.checkKind("integer")) {
      const integer = this.advance();
      const value = Number(integer.text);
      if (!Number.isSafeInteger(value) || value > 0x7fff_ffff) {
        throw this.syntax(integer, `Integer literal ${integer.text} is outside signed i32 range.`);
      }
      return { kind: "integer", value, span: integer.span };
    }
    if (this.checkKind("identifier")) {
      const name = this.advance();
      if (name.text === "true") return { kind: "boolean", value: true, span: name.span };
      if (name.text === "false") return { kind: "boolean", value: false, span: name.span };
      return { kind: "name", name: name.text, span: name.span };
    }
    if (this.consumeText("(")) {
      if (this.consumeText(")")) {
        return { kind: "unit", span: combine(start.span, this.previous().span) };
      }
      const first = this.parseExpression();
      if (!this.consumeText(",")) {
        const end = this.expectText(")");
        return { ...first, span: combine(start.span, end.span) };
      }
      const second = this.parseExpression();
      const end = this.expectText(")");
      return { kind: "tuple", values: [first, second], span: combine(start.span, end.span) };
    }
    if (this.consumeText("[")) {
      const values: OcamlFunctionalExpression[] = [];
      if (!this.checkText("]")) {
        do values.push(this.parseExpression()); while (this.consumeText(";"));
      }
      const end = this.expectText("]");
      return { kind: "list", values, span: combine(start.span, end.span) };
    }
    throw this.syntax(start, `Expected an OCaml expression; received ${this.describe(start)}.`);
  }

  private parsePattern(): OcamlFunctionalPattern {
    if (this.consumeText("[")) {
      const start = this.previous();
      const end = this.expectText("]");
      return { kind: "list-nil", span: combine(start.span, end.span) };
    }
    if (this.consumeText("(")) {
      const start = this.previous();
      const first = this.parsePatternBinder();
      this.expectText(",");
      const second = this.parsePatternBinder();
      const end = this.expectText(")");
      return { kind: "tuple", binders: [first, second], span: combine(start.span, end.span) };
    }
    if (this.checkLowerIdentifier() || this.checkText("_")) {
      const head = this.parsePatternBinder();
      if (!this.consumeText("::")) {
        throw this.syntax(this.current(), "A bare variable match arm is outside this profile.");
      }
      const tail = this.parsePatternBinder();
      return { kind: "list-cons", head, tail, span: combine(head.span, tail.span) };
    }

    const constructor = this.expectUpperIdentifier("variant pattern");
    const binders: OcamlFunctionalPatternBinder[] = [];
    if (this.consumeText("(")) {
      if (!this.checkText(")")) {
        do binders.push(this.parsePatternBinder()); while (this.consumeText(","));
      }
      this.expectText(")");
    } else {
      while (this.checkLowerIdentifier() || this.checkText("_")) {
        binders.push(this.parsePatternBinder());
      }
    }
    return {
      kind: "constructor",
      constructor: constructor.text,
      binders,
      span: combine(constructor.span, binders.at(-1)?.span ?? constructor.span),
    };
  }

  private parsePatternBinder(): OcamlFunctionalPatternBinder {
    const token = this.current();
    if (this.consumeText("_")) return { name: null, span: token.span };
    const name = this.expectLowerIdentifier("pattern variable");
    return { name: name.text, span: name.span };
  }

  private startsExpressionAtom(): boolean {
    if (this.atTopLevelBoundary()) return false;
    if (this.checkKind("integer") || this.checkText("(") || this.checkText("[")) return true;
    if (!this.checkKind("identifier")) return false;
    return !expressionKeywords.has(this.current().text);
  }

  private atTopLevelBoundary(): boolean {
    const token = this.current();
    return token.lineBreakBefore && token.column === 1 &&
      (token.text === "let" || token.text === "type");
  }

  private expectTypeParameter(): OcamlFunctionalToken {
    if (this.checkTypeParameter()) return this.advance();
    throw this.syntax(
      this.current(),
      `Expected a type parameter; received ${this.describe(this.current())}.`,
    );
  }

  private checkTypeParameter(): boolean {
    return this.checkKind("identifier") && this.current().text.startsWith("'");
  }

  private expectUpperIdentifier(expectation: string): OcamlFunctionalToken {
    const token = this.expectKind("identifier", expectation);
    if (!startsUppercase(token.text)) {
      throw this.syntax(token, `Expected ${expectation}; received ${JSON.stringify(token.text)}.`);
    }
    return token;
  }

  private expectLowerIdentifier(expectation: string): OcamlFunctionalToken {
    const token = this.expectKind("identifier", expectation);
    if (!startsLowercase(token.text)) {
      throw this.syntax(token, `Expected ${expectation}; received ${JSON.stringify(token.text)}.`);
    }
    return token;
  }

  private checkLowerIdentifier(): boolean {
    return this.checkKind("identifier") && startsLowercase(this.current().text) &&
      !expressionKeywords.has(this.current().text);
  }

  private expectText(text: string): OcamlFunctionalToken {
    if (this.checkText(text)) return this.advance();
    throw this.syntax(
      this.current(),
      `Expected ${JSON.stringify(text)}; received ${this.describe(this.current())}.`,
    );
  }

  private expectKind(kind: OcamlFunctionalTokenKind, expectation: string): OcamlFunctionalToken {
    if (this.checkKind(kind)) return this.advance();
    throw this.syntax(
      this.current(),
      `Expected ${expectation}; received ${this.describe(this.current())}.`,
    );
  }

  private consumeText(text: string): boolean {
    if (!this.checkText(text)) return false;
    this.advance();
    return true;
  }

  private checkText(text: string): boolean {
    return this.current().text === text;
  }

  private checkKind(kind: OcamlFunctionalTokenKind): boolean {
    return this.current().kind === kind;
  }

  private advance(): OcamlFunctionalToken {
    const token = this.current();
    if (token.kind !== "eof") this.#position++;
    return token;
  }

  private current(): OcamlFunctionalToken {
    const token = this.tokens[this.#position];
    if (token === undefined) throw new Error(`OCaml parser omitted token ${this.#position}.`);
    return token;
  }

  private previous(): OcamlFunctionalToken {
    const token = this.tokens[Math.max(0, this.#position - 1)];
    if (token === undefined) throw new Error("OCaml parser omitted its previous token.");
    return token;
  }

  private syntax(token: OcamlFunctionalToken, message: string): OcamlFunctionalSyntaxError {
    return new OcamlFunctionalSyntaxError(token.span, message);
  }

  private describe(token: OcamlFunctionalToken): string {
    return token.kind === "eof" ? "end of source" : JSON.stringify(token.text);
  }
}

function combine(start: FunctionalSpan, end: FunctionalSpan): FunctionalSpan {
  return { startByte: start.startByte, endByte: end.endByte };
}

function startsUppercase(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 0x41 && first <= 0x5a;
}

function startsLowercase(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 0x61 && first <= 0x7a || first === 0x5f;
}
