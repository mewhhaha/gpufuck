import type { FunctionalSpan } from "../functional/abi.ts";
import type {
  RustFunctionalBinaryOperator,
  RustFunctionalDeclaration,
  RustFunctionalEnumDeclaration,
  RustFunctionalExpression,
  RustFunctionalExpressionField,
  RustFunctionalField,
  RustFunctionalFunctionDeclaration,
  RustFunctionalFunctionParameter,
  RustFunctionalMatchArm,
  RustFunctionalPattern,
  RustFunctionalPatternBinder,
  RustFunctionalPatternField,
  RustFunctionalProgram,
  RustFunctionalStructDeclaration,
  RustFunctionalType,
  RustFunctionalVariant,
} from "./ast.ts";
import { RustFunctionalSyntaxError } from "./diagnostic.ts";
import {
  lexRustFunctionalSource,
  type RustFunctionalToken,
  type RustFunctionalTokenKind,
} from "./lexer.ts";

interface ExpressionOptions {
  readonly allowRecord: boolean;
}

const regularExpression: ExpressionOptions = { allowRecord: true };
const expressionBeforeBlock: ExpressionOptions = { allowRecord: false };

export function parseRustFunctionalProgram(source: string): RustFunctionalProgram {
  const parser = new RustFunctionalParser(lexRustFunctionalSource(source));
  return parser.parseProgram();
}

class RustFunctionalParser {
  #position = 0;

  constructor(private readonly tokens: readonly RustFunctionalToken[]) {}

  parseProgram(): RustFunctionalProgram {
    const declarations: RustFunctionalDeclaration[] = [];
    while (!this.checkKind("eof")) declarations.push(this.parseDeclaration());
    const end = this.current().span.endByte;
    return { declarations, span: { startByte: 0, endByte: end } };
  }

  private parseDeclaration(): RustFunctionalDeclaration {
    if (this.checkText("enum")) return this.parseEnumDeclaration();
    if (this.checkText("struct")) return this.parseStructDeclaration();
    if (this.checkText("fn")) return this.parseFunctionDeclaration();
    const token = this.current();
    throw this.syntax(
      token,
      `Expected enum, struct, or fn; received ${this.describe(token)}.`,
    );
  }

  private parseEnumDeclaration(): RustFunctionalEnumDeclaration {
    const start = this.expectText("enum");
    const name = this.expectIdentifier("enum name");
    const parameters = this.parseGenericParameters();
    const parameterNames = new Set(parameters.map((parameter) => parameter.text));
    this.expectText("{");
    const variants: RustFunctionalVariant[] = [];
    while (!this.checkText("}")) {
      const variantName = this.expectIdentifier("enum variant name");
      const fields: RustFunctionalType[] = [];
      if (this.consumeText("(")) {
        if (!this.checkText(")")) {
          do fields.push(this.parseType(parameterNames)); while (this.consumeText(","));
        }
        this.expectText(")");
      }
      variants.push({
        name: `${name.text}::${variantName.text}`,
        fields,
        span: combine(variantName.span, this.previous().span),
      });
      if (!this.consumeText(",") && !this.checkText("}")) {
        throw this.syntax(this.current(), "Enum variants must be separated by commas.");
      }
    }
    const end = this.expectText("}");
    return {
      kind: "enum",
      name: name.text,
      parameters: parameters.map((parameter) => parameter.text),
      variants,
      span: combine(start.span, end.span),
    };
  }

  private parseStructDeclaration(): RustFunctionalStructDeclaration {
    const start = this.expectText("struct");
    const name = this.expectIdentifier("struct name");
    const parameters = this.parseGenericParameters();
    const parameterNames = new Set(parameters.map((parameter) => parameter.text));
    this.expectText("{");
    const fields: RustFunctionalField[] = [];
    while (!this.checkText("}")) {
      const fieldName = this.expectIdentifier("struct field name");
      this.expectText(":");
      const type = this.parseType(parameterNames);
      fields.push({ name: fieldName.text, type, span: combine(fieldName.span, type.span) });
      if (!this.consumeText(",") && !this.checkText("}")) {
        throw this.syntax(this.current(), "Struct fields must be separated by commas.");
      }
    }
    const end = this.expectText("}");
    return {
      kind: "struct",
      name: name.text,
      parameters: parameters.map((parameter) => parameter.text),
      fields,
      span: combine(start.span, end.span),
    };
  }

  private parseFunctionDeclaration(): RustFunctionalFunctionDeclaration {
    const start = this.expectText("fn");
    const name = this.expectIdentifier("function name");
    const typeParameters = this.parseGenericParameters();
    const parameterNames = new Set(typeParameters.map((parameter) => parameter.text));
    this.expectText("(");
    const parameters: RustFunctionalFunctionParameter[] = [];
    if (!this.checkText(")")) {
      do {
        if (this.checkText("mut")) {
          throw this.syntax(
            this.current(),
            "Mutable parameters are outside the Rust functional profile.",
          );
        }
        const parameter = this.expectIdentifier("function parameter name");
        this.expectText(":");
        const type = this.parseType(parameterNames);
        parameters.push({ name: parameter.text, type, span: combine(parameter.span, type.span) });
      } while (this.consumeText(",") && !this.checkText(")"));
    }
    this.expectText(")");
    const result = this.consumeText("->")
      ? this.parseType(parameterNames)
      : { kind: "unit", span: this.previous().span } as const;
    const body = this.parseBlock();
    return {
      kind: "function",
      name: name.text,
      typeParameters: typeParameters.map((parameter) => parameter.text),
      parameters,
      result,
      body,
      span: combine(start.span, body.span),
    };
  }

  private parseGenericParameters(): readonly RustFunctionalToken[] {
    if (!this.consumeText("<")) return [];
    const parameters: RustFunctionalToken[] = [];
    if (this.checkText(">")) {
      throw this.syntax(this.current(), "Generic parameter lists cannot be empty.");
    }
    do parameters.push(this.expectIdentifier("generic type parameter")); while (
      this.consumeText(",")
    );
    this.expectText(">");
    return parameters;
  }

  private parseType(parameters: ReadonlySet<string>): RustFunctionalType {
    const start = this.current();
    if (this.consumeText("(")) {
      if (this.consumeText(")")) {
        return { kind: "unit", span: combine(start.span, this.previous().span) };
      }
      const first = this.parseType(parameters);
      if (!this.consumeText(",")) {
        const end = this.expectText(")");
        return { ...first, span: combine(start.span, end.span) };
      }
      const second = this.parseType(parameters);
      const end = this.expectText(")");
      return { kind: "tuple", values: [first, second], span: combine(start.span, end.span) };
    }
    if (this.consumeText("fn")) {
      this.expectText("(");
      const arguments_: RustFunctionalType[] = [];
      if (!this.checkText(")")) {
        do arguments_.push(this.parseType(parameters)); while (this.consumeText(","));
      }
      this.expectText(")");
      this.expectText("->");
      let result = this.parseType(parameters);
      if (arguments_.length === 0) {
        throw this.syntax(start, "Zero-argument function values are outside this profile.");
      }
      for (let index = arguments_.length - 1; index >= 0; index--) {
        const parameter = arguments_[index];
        if (parameter === undefined) throw new Error(`Function type omitted argument ${index}.`);
        result = {
          kind: "function",
          parameter,
          result,
          span: combine(start.span, result.span),
        };
      }
      return result;
    }
    const path = this.parsePath("type name");
    const arguments_: RustFunctionalType[] = [];
    if (this.consumeText("<")) {
      if (this.checkText(">")) {
        throw this.syntax(this.current(), "Type argument lists cannot be empty.");
      }
      do arguments_.push(this.parseType(parameters)); while (this.consumeText(","));
      this.expectText(">");
    }
    const span = combine(start.span, this.previous().span);
    if (path === "i32" && arguments_.length === 0) return { kind: "integer", span };
    if (path === "bool" && arguments_.length === 0) return { kind: "boolean", span };
    if (parameters.has(path) && arguments_.length === 0) {
      return { kind: "parameter", name: path, span };
    }
    return { kind: "named", name: path, arguments: arguments_, span };
  }

  private parseBlock(): RustFunctionalExpression {
    const start = this.expectText("{");
    const bindings: Array<{
      readonly name: string;
      readonly value: RustFunctionalExpression;
      readonly span: FunctionalSpan;
    }> = [];
    while (this.consumeText("let")) {
      const letToken = this.previous();
      if (this.checkText("mut")) {
        throw this.syntax(
          this.current(),
          "Mutable bindings are outside the Rust functional profile.",
        );
      }
      const name = this.expectIdentifier("binding name");
      if (this.consumeText(":")) {
        throw this.syntax(
          this.previous(),
          "Local type annotations are outside the Rust functional profile; use inferred let bindings.",
        );
      }
      this.expectText("=");
      const value = this.parseExpression(regularExpression);
      const end = this.expectText(";");
      bindings.push({ name: name.text, value, span: combine(letToken.span, end.span) });
    }

    let body: RustFunctionalExpression;
    if (this.checkText("}")) {
      body = { kind: "unit", span: this.current().span };
    } else {
      body = this.parseExpression(regularExpression);
      if (this.consumeText(";")) {
        throw this.syntax(
          this.previous(),
          "Expression statements are outside the Rust functional profile; return the expression from the block.",
        );
      }
    }
    const end = this.expectText("}");
    for (let index = bindings.length - 1; index >= 0; index--) {
      const binding = bindings[index];
      if (binding === undefined) throw new Error(`Block omitted binding ${index}.`);
      body = {
        kind: "let",
        name: binding.name,
        value: binding.value,
        body,
        span: combine(binding.span, body.span),
      };
    }
    return { ...body, span: combine(start.span, end.span) };
  }

  private parseExpression(options: ExpressionOptions): RustFunctionalExpression {
    if (this.checkText("match")) return this.parseMatchExpression();
    if (this.checkText("if")) return this.parseIfExpression();
    if (this.checkText("{")) return this.parseBlock();
    return this.parseEquality(options);
  }

  private parseMatchExpression(): RustFunctionalExpression {
    const start = this.expectText("match");
    const value = this.parseExpression(expressionBeforeBlock);
    this.expectText("{");
    const arms: RustFunctionalMatchArm[] = [];
    while (!this.checkText("}")) {
      const pattern = this.parsePattern();
      this.expectText("=>");
      const body = this.parseExpression(regularExpression);
      arms.push({ pattern, body, span: combine(pattern.span, body.span) });
      if (!this.consumeText(",") && !this.checkText("}")) {
        throw this.syntax(this.current(), "Match arms must be separated by commas.");
      }
    }
    if (arms.length === 0) throw this.syntax(this.current(), "Match expressions require an arm.");
    const end = this.expectText("}");
    return { kind: "match", value, arms, span: combine(start.span, end.span) };
  }

  private parseIfExpression(): RustFunctionalExpression {
    const start = this.expectText("if");
    const condition = this.parseExpression(expressionBeforeBlock);
    const consequent = this.parseBlock();
    this.expectText("else");
    const alternate = this.checkText("if") ? this.parseIfExpression() : this.parseBlock();
    return {
      kind: "if",
      condition,
      consequent,
      alternate,
      span: combine(start.span, alternate.span),
    };
  }

  private parsePattern(): RustFunctionalPattern {
    const start = this.current();
    if (this.consumeText("(")) {
      const first = this.parsePatternBinder();
      this.expectText(",");
      const second = this.parsePatternBinder();
      const end = this.expectText(")");
      return {
        kind: "tuple",
        binders: [first, second],
        span: combine(start.span, end.span),
      };
    }
    const constructor = this.parsePath("constructor pattern");
    if (this.consumeText("(")) {
      const binders: RustFunctionalPatternBinder[] = [];
      if (!this.checkText(")")) {
        do binders.push(this.parsePatternBinder()); while (this.consumeText(","));
      }
      const end = this.expectText(")");
      return {
        kind: "constructor",
        constructor,
        binders,
        span: combine(start.span, end.span),
      };
    }
    if (this.consumeText("{")) {
      const fields: RustFunctionalPatternField[] = [];
      while (!this.checkText("}")) {
        const name = this.expectIdentifier("record pattern field");
        const binder = this.consumeText(":")
          ? this.parsePatternBinder()
          : { name: name.text, span: name.span };
        fields.push({ name: name.text, binder, span: combine(name.span, binder.span) });
        if (!this.consumeText(",") && !this.checkText("}")) {
          throw this.syntax(this.current(), "Record pattern fields must be separated by commas.");
        }
      }
      const end = this.expectText("}");
      return {
        kind: "record",
        constructor,
        fields,
        span: combine(start.span, end.span),
      };
    }
    return { kind: "constructor", constructor, binders: [], span: start.span };
  }

  private parsePatternBinder(): RustFunctionalPatternBinder {
    if (this.consumeText("_")) return { name: null, span: this.previous().span };
    const name = this.expectIdentifier("pattern binding");
    return { name: name.text, span: name.span };
  }

  private parseEquality(options: ExpressionOptions): RustFunctionalExpression {
    return this.parseLeftAssociative(() => this.parseComparison(options), ["==", "!="]);
  }

  private parseComparison(options: ExpressionOptions): RustFunctionalExpression {
    return this.parseLeftAssociative(
      () => this.parseAdditive(options),
      ["<", "<=", ">", ">="],
    );
  }

  private parseAdditive(options: ExpressionOptions): RustFunctionalExpression {
    return this.parseLeftAssociative(() => this.parseMultiplicative(options), ["+", "-"]);
  }

  private parseMultiplicative(options: ExpressionOptions): RustFunctionalExpression {
    return this.parseLeftAssociative(() => this.parseUnary(options), ["*", "/"]);
  }

  private parseLeftAssociative(
    operand: () => RustFunctionalExpression,
    operators: readonly RustFunctionalBinaryOperator[],
  ): RustFunctionalExpression {
    let expression = operand();
    while (operators.includes(this.current().text as RustFunctionalBinaryOperator)) {
      const operator = this.advance().text as RustFunctionalBinaryOperator;
      const right = operand();
      expression = {
        kind: "binary",
        operator,
        left: expression,
        right,
        span: combine(expression.span, right.span),
      };
    }
    return expression;
  }

  private parseUnary(options: ExpressionOptions): RustFunctionalExpression {
    if (this.consumeText("&")) {
      const start = this.previous();
      const value = this.parseUnary(options);
      return { kind: "borrow", value, span: combine(start.span, value.span) };
    }
    if (!this.consumeText("-")) return this.parsePostfix(options);
    const start = this.previous();
    const body = this.parseUnary(options);
    return {
      kind: "binary",
      operator: "-",
      left: { kind: "integer", value: 0, span: start.span },
      right: body,
      span: combine(start.span, body.span),
    };
  }

  private parsePostfix(options: ExpressionOptions): RustFunctionalExpression {
    let expression = this.parsePrimary(options);
    while (this.consumeText("(")) {
      const arguments_: RustFunctionalExpression[] = [];
      if (!this.checkText(")")) {
        do arguments_.push(this.parseExpression(regularExpression)); while (this.consumeText(","));
      }
      const end = this.expectText(")");
      if (arguments_.length === 0) {
        throw this.syntax(end, "Zero-argument calls are outside the Rust functional profile.");
      }
      expression = {
        kind: "call",
        callee: expression,
        arguments: arguments_,
        span: combine(expression.span, end.span),
      };
    }
    return expression;
  }

  private parsePrimary(options: ExpressionOptions): RustFunctionalExpression {
    const token = this.current();
    if (this.consumeText("true")) return { kind: "boolean", value: true, span: token.span };
    if (this.consumeText("false")) return { kind: "boolean", value: false, span: token.span };
    if (token.kind === "integer") {
      this.advance();
      const value = Number(token.text);
      if (!Number.isSafeInteger(value) || value > 0x7fffffff) {
        throw this.syntax(token, `Integer literal ${token.text} is outside signed i32.`);
      }
      return { kind: "integer", value, span: token.span };
    }
    if (this.consumeText("(")) {
      if (this.consumeText(")")) {
        return { kind: "unit", span: combine(token.span, this.previous().span) };
      }
      const first = this.parseExpression(regularExpression);
      if (!this.consumeText(",")) {
        const end = this.expectText(")");
        return { ...first, span: combine(token.span, end.span) };
      }
      const second = this.parseExpression(regularExpression);
      const end = this.expectText(")");
      return { kind: "tuple", values: [first, second], span: combine(token.span, end.span) };
    }
    if (token.kind === "identifier") {
      const name = this.parsePath("expression name");
      if (options.allowRecord && this.consumeText("{")) {
        const fields: RustFunctionalExpressionField[] = [];
        while (!this.checkText("}")) {
          const fieldName = this.expectIdentifier("record expression field");
          const value = this.consumeText(":")
            ? this.parseExpression(regularExpression)
            : { kind: "name", name: fieldName.text, span: fieldName.span } as const;
          fields.push({
            name: fieldName.text,
            value,
            span: combine(fieldName.span, value.span),
          });
          if (!this.consumeText(",") && !this.checkText("}")) {
            throw this.syntax(this.current(), "Record fields must be separated by commas.");
          }
        }
        const end = this.expectText("}");
        return { kind: "record", constructor: name, fields, span: combine(token.span, end.span) };
      }
      return { kind: "name", name, span: combine(token.span, this.previous().span) };
    }
    throw this.syntax(token, `Expected an expression; received ${this.describe(token)}.`);
  }

  private parsePath(location: string): string {
    const segments = [this.expectIdentifier(location).text];
    while (this.consumeText("::")) segments.push(this.expectIdentifier(`${location} segment`).text);
    return segments.join("::");
  }

  private current(): RustFunctionalToken {
    const token = this.tokens[this.#position];
    if (token === undefined) throw new Error(`Rust token stream omitted token ${this.#position}.`);
    return token;
  }

  private previous(): RustFunctionalToken {
    const token = this.tokens[this.#position - 1];
    if (token === undefined) throw new Error("Rust parser has no previous token.");
    return token;
  }

  private advance(): RustFunctionalToken {
    const token = this.current();
    if (token.kind !== "eof") this.#position++;
    return token;
  }

  private checkKind(kind: RustFunctionalTokenKind): boolean {
    return this.current().kind === kind;
  }

  private checkText(text: string): boolean {
    return this.current().text === text;
  }

  private consumeText(text: string): boolean {
    if (!this.checkText(text)) return false;
    this.advance();
    return true;
  }

  private expectText(text: string): RustFunctionalToken {
    const token = this.current();
    if (token.text !== text) {
      throw this.syntax(
        token,
        `Expected ${JSON.stringify(text)}; received ${this.describe(token)}.`,
      );
    }
    return this.advance();
  }

  private expectIdentifier(location: string): RustFunctionalToken {
    const token = this.current();
    if (token.kind !== "identifier") {
      throw this.syntax(token, `Expected ${location}; received ${this.describe(token)}.`);
    }
    return this.advance();
  }

  private syntax(token: RustFunctionalToken, message: string): RustFunctionalSyntaxError {
    return new RustFunctionalSyntaxError(token.span, message);
  }

  private describe(token: RustFunctionalToken): string {
    return token.kind === "eof" ? "end of source" : JSON.stringify(token.text);
  }
}

function combine(start: FunctionalSpan, end: FunctionalSpan): FunctionalSpan {
  return { startByte: start.startByte, endByte: end.endByte };
}
