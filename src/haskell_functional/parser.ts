import type { FunctionalSpan } from "../functional/abi.ts";
import type {
  HaskellFunctionalBinaryOperator,
  HaskellFunctionalCaseArm,
  HaskellFunctionalClassDeclaration,
  HaskellFunctionalConstructor,
  HaskellFunctionalDeclaration,
  HaskellFunctionalDefinition,
  HaskellFunctionalExpression,
  HaskellFunctionalInstanceDeclaration,
  HaskellFunctionalPattern,
  HaskellFunctionalProgram,
  HaskellFunctionalRecordField,
  HaskellFunctionalRecordPatternField,
  HaskellFunctionalType,
  HaskellFunctionalTypeAliasDeclaration,
  HaskellFunctionalTypeDeclaration,
  HaskellFunctionalTypeSignature,
} from "./ast.ts";
import { HaskellFunctionalSyntaxError } from "./diagnostic.ts";
import {
  type HaskellFunctionalToken,
  type HaskellFunctionalTokenKind,
  lexHaskellFunctionalSource,
} from "./lexer.ts";

const binaryPrecedence: Readonly<Record<string, number>> = {
  "==": 1,
  "/=": 1,
  "<": 1,
  "<=": 1,
  ">": 1,
  ">=": 1,
  "+": 2,
  "-": 2,
  "*": 3,
  "/": 3,
};

const expressionTerminators = new Set(["then", "else", "of", "in", "where"]);
const typeTerminators = new Set(["where"]);

export function parseHaskellFunctionalProgram(source: string): HaskellFunctionalProgram {
  return new HaskellFunctionalParser(lexHaskellFunctionalSource(source)).parseProgram();
}

class HaskellFunctionalParser {
  #position = 0;
  readonly #layoutIndentations: number[] = [];

  constructor(private readonly tokens: readonly HaskellFunctionalToken[]) {}

  parseProgram(): HaskellFunctionalProgram {
    const start = this.expectText("module");
    const moduleName = this.expectUpperIdentifier("module name");
    this.expectText("where");
    const explicit = this.consumeText("{");
    const declarations = explicit
      ? this.parseExplicitDeclarations()
      : this.parseLayoutDeclarations();
    const end = explicit ? this.expectText("}") : this.current();
    this.expectKind("eof", "end of source");
    return {
      moduleName: moduleName.text,
      declarations,
      span: combine(start.span, end.span),
    };
  }

  private parseExplicitDeclarations(): HaskellFunctionalDeclaration[] {
    const declarations: HaskellFunctionalDeclaration[] = [];
    while (!this.checkText("}")) {
      declarations.push(this.parseDeclaration());
      if (!this.consumeText(";") && !this.checkText("}")) {
        throw this.syntax(
          this.current(),
          "Explicit-brace Haskell declarations must be separated by semicolons.",
        );
      }
      while (this.consumeText(";")) {
        // Empty declarations are valid between explicit braces.
      }
    }
    return declarations;
  }

  private parseLayoutDeclarations(): HaskellFunctionalDeclaration[] {
    if (this.checkKind("eof")) return [];
    const indentation = this.current().column;
    return this.withLayout(indentation, () => {
      const declarations: HaskellFunctionalDeclaration[] = [];
      while (!this.checkKind("eof")) {
        if (declarations.length > 0 && !this.consumeText(";")) {
          this.requireLayoutSibling(indentation, "declaration");
        }
        while (this.consumeText(";")) {
          // Explicit separators remain valid inside a layout block.
        }
        if (this.checkKind("eof")) break;
        declarations.push(this.parseDeclaration());
      }
      return declarations;
    });
  }

  private parseDeclaration(): HaskellFunctionalDeclaration {
    if (this.checkText("data")) return this.parseTypeDeclaration("data");
    if (this.checkText("newtype")) return this.parseTypeDeclaration("newtype");
    if (this.checkText("type")) return this.parseTypeAliasDeclaration();
    if (this.checkText("class")) return this.parseClassDeclaration();
    if (this.checkText("instance")) return this.parseInstanceDeclaration();
    const name = this.expectLowerIdentifier("value name");
    if (this.consumeText("::")) return this.parseTypeSignature(name);
    return this.parseDefinition(name);
  }

  private parseTypeDeclaration(
    representation: HaskellFunctionalTypeDeclaration["representation"],
  ): HaskellFunctionalTypeDeclaration {
    const start = this.expectText(representation);
    const name = this.expectUpperIdentifier("type constructor name");
    const parameters: HaskellFunctionalToken[] = [];
    while (this.checkLowerIdentifier() && !this.checkText("where")) {
      parameters.push(this.advance());
    }
    const constructors: HaskellFunctionalConstructor[] = [];
    if (this.consumeText("=")) {
      do constructors.push(this.parseConstructor()); while (this.consumeText("|"));
    } else {
      this.expectText("where");
      if (this.consumeText("{")) {
        while (!this.checkText("}")) {
          constructors.push(this.parseGadtConstructor());
          if (!this.consumeText(";") && !this.checkText("}")) {
            throw this.syntax(this.current(), "GADT constructors must be separated by semicolons.");
          }
          while (this.consumeText(";")) {
            // Empty declarations are valid between explicit braces.
          }
        }
        this.expectText("}");
      } else {
        const indentation = this.current().column;
        this.withLayout(indentation, () => {
          while (!this.layoutBlockEnded(indentation)) {
            if (constructors.length > 0) this.requireLayoutSibling(indentation, "GADT constructor");
            constructors.push(this.parseGadtConstructor());
          }
        });
      }
    }
    if (constructors.length === 0) {
      throw this.syntax(this.current(), `Type ${JSON.stringify(name.text)} has no constructors.`);
    }
    return {
      kind: "type",
      representation,
      name: name.text,
      parameters: parameters.map((parameter) => parameter.text),
      constructors,
      span: combine(start.span, this.previous().span),
    };
  }

  private parseTypeAliasDeclaration(): HaskellFunctionalTypeAliasDeclaration {
    const start = this.expectText("type");
    const name = this.expectUpperIdentifier("type synonym name");
    const parameters: HaskellFunctionalToken[] = [];
    while (this.checkLowerIdentifier()) parameters.push(this.advance());
    this.expectText("=");
    const target = this.parseType();
    return {
      kind: "type-alias",
      name: name.text,
      parameters: parameters.map((parameter) => parameter.text),
      target,
      span: combine(start.span, target.span),
    };
  }

  private parseConstructor(): HaskellFunctionalConstructor {
    const name = this.expectUpperIdentifier("data constructor name");
    if (this.consumeText("{")) {
      const fields = [];
      if (!this.checkText("}")) {
        do {
          const fieldName = this.expectLowerIdentifier("record field name");
          this.expectText("::");
          const type = this.parseType();
          fields.push({
            name: fieldName.text,
            type,
            span: combine(fieldName.span, type.span),
          });
        } while (this.consumeText(","));
      }
      const end = this.expectText("}");
      return {
        name: name.text,
        fields,
        record: true,
        span: combine(name.span, end.span),
      };
    }
    const fields = [];
    while (this.startsTypeAtom() && !this.checkText("|")) {
      const type = this.parseTypeAtom();
      fields.push({ name: null, type, span: type.span });
    }
    return {
      name: name.text,
      fields,
      record: false,
      span: combine(name.span, this.previous().span),
    };
  }

  private parseGadtConstructor(): HaskellFunctionalConstructor {
    const name = this.expectUpperIdentifier("GADT constructor name");
    this.expectText("::");
    const signature = this.parseType();
    const fields = [];
    let result = signature;
    while (result.kind === "function") {
      fields.push({ name: null, type: result.parameter, span: result.parameter.span });
      result = result.result;
    }
    return {
      name: name.text,
      fields,
      result,
      record: false,
      span: combine(name.span, signature.span),
    };
  }

  private parseTypeSignature(name: HaskellFunctionalToken): HaskellFunctionalTypeSignature {
    const quantifiedParameters = this.parseForallParameters();
    const constraints = [];
    const constraintStart = this.#position;
    const candidate = this.parseTypeApplication();
    if (this.consumeText("=>")) {
      const parsedConstraints = constraintsFromType(candidate);
      if (parsedConstraints === null) {
        throw this.syntax(
          name,
          "Class constraints must each apply one class to one type in this profile.",
        );
      }
      constraints.push(...parsedConstraints);
    } else {
      this.#position = constraintStart;
    }
    const body = this.parseType();
    const type: HaskellFunctionalType = quantifiedParameters.length === 0 ? body : {
      kind: "forall",
      parameters: quantifiedParameters.map((parameter) => parameter.text),
      body,
      span: combine(quantifiedParameters[0]?.span ?? body.span, body.span),
    };
    return {
      kind: "signature",
      name: name.text,
      constraints,
      type,
      span: combine(name.span, type.span),
    };
  }

  private parseClassDeclaration(): HaskellFunctionalClassDeclaration {
    const start = this.expectText("class");
    const name = this.expectUpperIdentifier("class name");
    const parameter = this.expectLowerIdentifier("class parameter");
    this.expectText("where");
    const methods: HaskellFunctionalTypeSignature[] = [];
    if (this.consumeText("{")) {
      while (!this.checkText("}")) {
        methods.push(this.parseClassMethod());
        if (!this.consumeText(";") && !this.checkText("}")) {
          throw this.syntax(this.current(), "Class methods must be separated by semicolons.");
        }
        while (this.consumeText(";")) {
          // Empty declarations are valid between explicit braces.
        }
      }
      this.expectText("}");
    } else {
      const indentation = this.current().column;
      this.withLayout(indentation, () => {
        while (!this.layoutBlockEnded(indentation)) {
          if (methods.length > 0) this.requireLayoutSibling(indentation, "class method");
          methods.push(this.parseClassMethod());
        }
      });
    }
    if (methods.length === 0) {
      throw this.syntax(name, `Class ${JSON.stringify(name.text)} has no methods.`);
    }
    return {
      kind: "class",
      name: name.text,
      parameter: parameter.text,
      methods,
      span: combine(start.span, this.previous().span),
    };
  }

  private parseClassMethod(): HaskellFunctionalTypeSignature {
    const name = this.expectLowerIdentifier("class method name");
    this.expectText("::");
    return this.parseTypeSignature(name);
  }

  private parseInstanceDeclaration(): HaskellFunctionalInstanceDeclaration {
    const start = this.expectText("instance");
    const className = this.expectUpperIdentifier("instance class name");
    const type = this.parseTypeApplication();
    this.expectText("where");
    const methods: HaskellFunctionalDefinition[] = [];
    if (this.consumeText("{")) {
      while (!this.checkText("}")) {
        methods.push(this.parseLocalDefinition());
        if (!this.consumeText(";") && !this.checkText("}")) {
          throw this.syntax(this.current(), "Instance methods must be separated by semicolons.");
        }
        while (this.consumeText(";")) {
          // Empty declarations are valid between explicit braces.
        }
      }
      this.expectText("}");
    } else {
      const indentation = this.current().column;
      this.withLayout(indentation, () => {
        while (!this.layoutBlockEnded(indentation)) {
          if (methods.length > 0) this.requireLayoutSibling(indentation, "instance method");
          methods.push(this.parseLocalDefinition());
        }
      });
    }
    return {
      kind: "instance",
      className: className.text,
      type,
      methods,
      span: combine(start.span, this.previous().span),
    };
  }

  private parseDefinition(name: HaskellFunctionalToken): HaskellFunctionalDefinition {
    const parameters: HaskellFunctionalPattern[] = [];
    while (!this.checkText("=") && !this.checkText("|")) {
      parameters.push(this.parsePattern());
    }
    const alternatives = [];
    if (this.consumeText("=")) {
      const body = this.parseExpression();
      alternatives.push({ condition: null, body, span: body.span });
    } else {
      while (this.consumeText("|")) {
        const condition = this.parseExpression();
        this.expectText("=");
        const body = this.parseExpression();
        alternatives.push({
          condition,
          body,
          span: combine(condition.span, body.span),
        });
      }
    }
    if (alternatives.length === 0) {
      throw this.syntax(this.current(), `Definition ${JSON.stringify(name.text)} has no body.`);
    }
    const whereDefinitions = this.consumeText("where") ? this.parseWhereDefinitions() : [];
    const end = whereDefinitions.at(-1)?.span ?? alternatives.at(-1)?.span;
    if (end === undefined) throw new Error(`Haskell definition ${name.text} omitted its end span.`);
    return {
      kind: "definition",
      name: name.text,
      parameters,
      alternatives,
      whereDefinitions,
      span: combine(name.span, end),
    };
  }

  private parseWhereDefinitions(): HaskellFunctionalDefinition[] {
    if (this.consumeText("{")) {
      const definitions: HaskellFunctionalDefinition[] = [];
      while (!this.checkText("}")) {
        definitions.push(this.parseLocalDefinition());
        if (!this.consumeText(";") && !this.checkText("}")) {
          throw this.syntax(this.current(), "Where definitions must be separated by semicolons.");
        }
        while (this.consumeText(";")) {
          // Empty definitions are valid between explicit braces.
        }
      }
      this.expectText("}");
      return definitions;
    }

    const indentation = this.current().column;
    return this.withLayout(indentation, () => {
      const definitions: HaskellFunctionalDefinition[] = [];
      while (!this.layoutBlockEnded(indentation)) {
        if (definitions.length > 0) this.requireLayoutSibling(indentation, "where definition");
        definitions.push(this.parseLocalDefinition());
      }
      return definitions;
    });
  }

  private parseLocalDefinition(): HaskellFunctionalDefinition {
    const name = this.expectLowerIdentifier("where definition name");
    return this.parseDefinition(name);
  }

  private parseType(): HaskellFunctionalType {
    const quantifiedParameters = this.parseForallParameters();
    if (quantifiedParameters.length > 0) {
      const body = this.parseType();
      return {
        kind: "forall",
        parameters: quantifiedParameters.map((parameter) => parameter.text),
        body,
        span: combine(quantifiedParameters[0]?.span ?? body.span, body.span),
      };
    }
    const parameter = this.parseTypeApplication();
    if (!this.consumeText("->")) return parameter;
    const result = this.parseType();
    return {
      kind: "function",
      parameter,
      result,
      span: combine(parameter.span, result.span),
    };
  }

  private parseTypeApplication(): HaskellFunctionalType {
    let type = this.parseTypeAtom();
    while (type.kind === "named" && this.startsTypeAtom()) {
      const argument = this.parseTypeAtom();
      type = {
        kind: "named",
        name: type.name,
        arguments: [...type.arguments, argument],
        span: combine(type.span, argument.span),
      };
    }
    return type;
  }

  private parseTypeAtom(): HaskellFunctionalType {
    const start = this.current();
    if (this.consumeText("[")) {
      const value = this.parseType();
      const end = this.expectText("]");
      return { kind: "list", value, span: combine(start.span, end.span) };
    }
    if (this.consumeText("(")) {
      if (this.consumeText(")")) {
        return { kind: "unit", span: combine(start.span, this.previous().span) };
      }
      const first = this.parseType();
      if (!this.consumeText(",")) {
        const end = this.expectText(")");
        return { ...first, span: combine(start.span, end.span) };
      }
      const second = this.parseType();
      const end = this.expectText(")");
      return { kind: "tuple", values: [first, second], span: combine(start.span, end.span) };
    }

    const name = this.expectKind("identifier", "type");
    if (name.text === "Int") return { kind: "integer", span: name.span };
    if (name.text === "Char") return { kind: "character", span: name.span };
    if (name.text === "String") {
      return {
        kind: "list",
        value: { kind: "character", span: name.span },
        span: name.span,
      };
    }
    if (name.text === "Bool") return { kind: "boolean", span: name.span };
    if (startsLowercase(name.text)) {
      return { kind: "parameter", name: name.text, span: name.span };
    }
    return { kind: "named", name: name.text, arguments: [], span: name.span };
  }

  private parseExpression(): HaskellFunctionalExpression {
    const head = this.parseBinaryExpression(0);
    if (!this.consumeText(":")) return head;
    const tail = this.parseExpression();
    return { kind: "list-cons", head, tail, span: combine(head.span, tail.span) };
  }

  private parseBinaryExpression(minimumPrecedence: number): HaskellFunctionalExpression {
    let left = this.parseApplication();
    while (true) {
      if (this.atLayoutBoundary()) return left;
      const operator = this.current().text;
      const precedence = binaryPrecedence[operator];
      if (precedence === undefined || precedence < minimumPrecedence) return left;
      this.advance();
      const right = this.parseBinaryExpression(precedence + 1);
      left = {
        kind: "binary",
        operator: operator as HaskellFunctionalBinaryOperator,
        left,
        right,
        span: combine(left.span, right.span),
      };
    }
  }

  private parseApplication(): HaskellFunctionalExpression {
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

  private parseExpressionAtom(): HaskellFunctionalExpression {
    if (this.checkText("if")) return this.parseIfExpression();
    if (this.checkText("case")) return this.parseCaseExpression();
    if (this.checkText("let")) return this.parseLetExpression();
    if (this.checkText("\\")) return this.parseLambdaExpression();

    const start = this.current();
    if (this.checkKind("integer")) {
      const integer = this.advance();
      const value = Number(integer.text);
      if (!Number.isSafeInteger(value) || value > 0x7fff_ffff) {
        throw this.syntax(integer, `Integer literal ${integer.text} is outside signed i32 range.`);
      }
      return { kind: "integer", value, span: integer.span };
    }
    if (this.checkKind("character")) {
      const character = this.advance();
      const values = decodeQuotedLiteral(character, "character");
      const codePoints = [...values].map((value) => value.codePointAt(0));
      if (codePoints.length !== 1 || codePoints[0] === undefined) {
        throw this.syntax(character, "Haskell character literals must contain one character.");
      }
      return { kind: "character", value: codePoints[0], span: character.span };
    }
    if (this.checkKind("string")) {
      const string = this.advance();
      return {
        kind: "string",
        values: [...decodeQuotedLiteral(string, "string")].map((value) => {
          const codePoint = value.codePointAt(0);
          if (codePoint === undefined) throw new Error("Haskell string omitted a code point.");
          return codePoint;
        }),
        span: string.span,
      };
    }
    if (this.checkKind("identifier")) {
      const name = this.advance();
      if (name.text === "True") return { kind: "boolean", value: true, span: name.span };
      if (name.text === "False") return { kind: "boolean", value: false, span: name.span };
      if (startsUppercase(name.text) && this.consumeText("{")) {
        const fields: HaskellFunctionalRecordField[] = [];
        if (!this.checkText("}")) {
          do {
            const fieldName = this.expectLowerIdentifier("record field name");
            this.expectText("=");
            const value = this.parseExpression();
            fields.push({
              name: fieldName.text,
              value,
              span: combine(fieldName.span, value.span),
            });
          } while (this.consumeText(","));
        }
        const end = this.expectText("}");
        return {
          kind: "record",
          constructor: name.text,
          fields,
          span: combine(name.span, end.span),
        };
      }
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
      const values: HaskellFunctionalExpression[] = [];
      if (!this.checkText("]")) {
        do values.push(this.parseExpression()); while (this.consumeText(","));
      }
      const end = this.expectText("]");
      return { kind: "list", values, span: combine(start.span, end.span) };
    }
    throw this.syntax(start, `Expected an expression; received ${this.describe(start)}.`);
  }

  private parseLambdaExpression(): HaskellFunctionalExpression {
    const start = this.expectText("\\");
    const parameters: HaskellFunctionalToken[] = [];
    while (this.checkLowerIdentifier()) parameters.push(this.advance());
    if (parameters.length === 0) {
      throw this.syntax(this.current(), "Haskell lambdas require at least one variable parameter.");
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

  private parseIfExpression(): HaskellFunctionalExpression {
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

  private parseCaseExpression(): HaskellFunctionalExpression {
    const start = this.expectText("case");
    const value = this.parseExpression();
    this.expectText("of");
    const arms: HaskellFunctionalCaseArm[] = [];
    let end: HaskellFunctionalToken;
    if (this.consumeText("{")) {
      while (!this.checkText("}")) {
        arms.push(this.parseCaseArm());
        if (!this.consumeText(";") && !this.checkText("}")) {
          throw this.syntax(this.current(), "Case alternatives must be separated by semicolons.");
        }
        while (this.consumeText(";")) {
          // Empty alternatives are accepted by the explicit-brace grammar.
        }
      }
      end = this.expectText("}");
    } else {
      const indentation = this.current().column;
      this.withLayout(indentation, () => {
        while (!this.layoutBlockEnded(indentation)) {
          if (arms.length > 0) this.requireLayoutSibling(indentation, "case alternative");
          arms.push(this.parseCaseArm());
        }
      });
      end = this.previous();
    }
    if (arms.length === 0) throw this.syntax(end, "Case expressions must contain an alternative.");
    return { kind: "case", value, arms, span: combine(start.span, end.span) };
  }

  private parseCaseArm(): HaskellFunctionalCaseArm {
    const pattern = this.parsePattern();
    this.expectText("->");
    const body = this.parseExpression();
    return { pattern, body, span: combine(pattern.span, body.span) };
  }

  private parsePattern(): HaskellFunctionalPattern {
    const head = this.parsePatternAtom();
    if (!this.consumeText(":")) return head;
    const tail = this.parsePattern();
    return { kind: "list-cons", head, tail, span: combine(head.span, tail.span) };
  }

  private parsePatternAtom(): HaskellFunctionalPattern {
    const start = this.current();
    if (this.consumeText("_")) return { kind: "wildcard", span: start.span };
    if (this.checkLowerIdentifier()) {
      const name = this.advance();
      return { kind: "variable", name: name.text, span: name.span };
    }
    if (this.consumeText("[")) {
      if (this.consumeText("]")) {
        return { kind: "list-nil", span: combine(start.span, this.previous().span) };
      }
      const values: HaskellFunctionalPattern[] = [];
      do values.push(this.parsePattern()); while (this.consumeText(","));
      const end = this.expectText("]");
      let pattern: HaskellFunctionalPattern = {
        kind: "list-nil",
        span: combine(start.span, end.span),
      };
      for (let index = values.length - 1; index >= 0; index--) {
        const value = values[index];
        if (value === undefined) throw new Error(`Haskell list pattern omitted value ${index}.`);
        pattern = {
          kind: "list-cons",
          head: value,
          tail: pattern,
          span: combine(start.span, end.span),
        };
      }
      return pattern;
    }
    if (this.consumeText("(")) {
      const first = this.parsePattern();
      if (!this.consumeText(",")) {
        this.expectText(")");
        return first;
      }
      const second = this.parsePattern();
      const end = this.expectText(")");
      return {
        kind: "tuple",
        values: [first, second],
        span: combine(start.span, end.span),
      };
    }

    const constructor = this.expectUpperIdentifier("constructor pattern");
    if (this.consumeText("{")) {
      const fields: HaskellFunctionalRecordPatternField[] = [];
      if (!this.checkText("}")) {
        do {
          const fieldName = this.expectLowerIdentifier("record pattern field name");
          const pattern = this.consumeText("=")
            ? this.parsePattern()
            : { kind: "variable", name: fieldName.text, span: fieldName.span } as const;
          fields.push({
            name: fieldName.text,
            pattern,
            span: combine(fieldName.span, pattern.span),
          });
        } while (this.consumeText(","));
      }
      const end = this.expectText("}");
      return {
        kind: "record",
        constructor: constructor.text,
        fields,
        span: combine(constructor.span, end.span),
      };
    }
    const arguments_: HaskellFunctionalPattern[] = [];
    while (this.startsPatternAtom()) arguments_.push(this.parsePatternAtom());
    return {
      kind: "constructor",
      constructor: constructor.text,
      arguments: arguments_,
      span: combine(constructor.span, this.previous().span),
    };
  }

  private startsPatternAtom(): boolean {
    if (this.atLayoutBoundary()) return false;
    return this.checkKind("identifier") || this.checkText("_") || this.checkText("(") ||
      this.checkText("[");
  }

  private parseLetExpression(): HaskellFunctionalExpression {
    const start = this.expectText("let");
    const bindings: HaskellFunctionalDefinition[] = [];
    if (this.consumeText("{")) {
      while (!this.checkText("}")) {
        bindings.push(this.parseLetBinding());
        if (!this.consumeText(";") && !this.checkText("}")) {
          throw this.syntax(this.current(), "Let bindings must be separated by semicolons.");
        }
        while (this.consumeText(";")) {
          // Empty bindings are accepted by the explicit-brace grammar.
        }
      }
      this.expectText("}");
    } else {
      const indentation = this.current().column;
      this.withLayout(indentation, () => {
        while (!this.checkText("in") && !this.layoutBlockEnded(indentation)) {
          if (bindings.length > 0) this.requireLayoutSibling(indentation, "let binding");
          bindings.push(this.parseLetBinding());
        }
      });
    }
    this.expectText("in");
    const body = this.parseExpression();
    if (bindings.length === 0) {
      throw this.syntax(start, "Let expressions must contain a binding.");
    }
    return { kind: "let", bindings, body, span: combine(start.span, body.span) };
  }

  private parseLetBinding(): HaskellFunctionalDefinition {
    const name = this.expectLowerIdentifier("let binding name");
    return this.parseDefinition(name);
  }

  private parseForallParameters(): HaskellFunctionalToken[] {
    if (!this.consumeText("forall")) return [];
    const parameters: HaskellFunctionalToken[] = [];
    const names = new Set<string>();
    while (this.checkLowerIdentifier()) {
      const parameter = this.advance();
      if (names.has(parameter.text)) {
        throw this.syntax(
          parameter,
          `Haskell forall repeats type parameter ${JSON.stringify(parameter.text)}.`,
        );
      }
      names.add(parameter.text);
      parameters.push(parameter);
    }
    if (parameters.length === 0) {
      throw this.syntax(this.current(), "Haskell forall requires at least one type parameter.");
    }
    this.expectText(".");
    return parameters;
  }

  private startsTypeAtom(): boolean {
    if (this.atLayoutBoundary()) return false;
    if (typeTerminators.has(this.current().text)) return false;
    return this.checkKind("identifier") || this.checkText("(") || this.checkText("[");
  }

  private startsExpressionAtom(): boolean {
    if (this.atLayoutBoundary()) return false;
    if (
      this.checkKind("integer") || this.checkText("(") || this.checkText("[") ||
      this.checkText("\\") || this.checkKind("character") || this.checkKind("string")
    ) return true;
    if (!this.checkKind("identifier")) return false;
    return !expressionTerminators.has(this.current().text);
  }

  private withLayout<Result>(indentation: number, parse: () => Result): Result {
    this.#layoutIndentations.push(indentation);
    try {
      return parse();
    } finally {
      this.#layoutIndentations.pop();
    }
  }

  private atLayoutBoundary(): boolean {
    const indentation = this.#layoutIndentations.at(-1);
    if (indentation === undefined) return false;
    const token = this.current();
    return token.lineBreakBefore && token.column <= indentation;
  }

  private layoutBlockEnded(indentation: number): boolean {
    const token = this.current();
    return token.kind === "eof" || token.lineBreakBefore && token.column < indentation;
  }

  private requireLayoutSibling(indentation: number, location: string): void {
    const token = this.current();
    if (token.lineBreakBefore && token.column === indentation) return;
    throw this.syntax(
      token,
      `Haskell layout ${location} must begin at column ${indentation}; received column ${token.column}.`,
    );
  }

  private expectUpperIdentifier(expectation: string): HaskellFunctionalToken {
    const token = this.expectKind("identifier", expectation);
    if (!startsUppercase(token.text)) {
      throw this.syntax(token, `Expected ${expectation}; received ${JSON.stringify(token.text)}.`);
    }
    return token;
  }

  private expectLowerIdentifier(expectation: string): HaskellFunctionalToken {
    const token = this.expectKind("identifier", expectation);
    if (!startsLowercase(token.text)) {
      throw this.syntax(token, `Expected ${expectation}; received ${JSON.stringify(token.text)}.`);
    }
    return token;
  }

  private checkLowerIdentifier(): boolean {
    return this.checkKind("identifier") && startsLowercase(this.current().text);
  }

  private expectText(text: string): HaskellFunctionalToken {
    if (this.checkText(text)) return this.advance();
    const token = this.current();
    throw this.syntax(token, `Expected ${JSON.stringify(text)}; received ${this.describe(token)}.`);
  }

  private expectKind(
    kind: HaskellFunctionalTokenKind,
    expectation: string,
  ): HaskellFunctionalToken {
    if (this.checkKind(kind)) return this.advance();
    const token = this.current();
    throw this.syntax(token, `Expected ${expectation}; received ${this.describe(token)}.`);
  }

  private consumeText(text: string): boolean {
    if (!this.checkText(text)) return false;
    this.advance();
    return true;
  }

  private checkText(text: string): boolean {
    return this.current().text === text;
  }

  private checkKind(kind: HaskellFunctionalTokenKind): boolean {
    return this.current().kind === kind;
  }

  private advance(): HaskellFunctionalToken {
    const token = this.current();
    if (token.kind !== "eof") this.#position++;
    return token;
  }

  private current(): HaskellFunctionalToken {
    const token = this.tokens[this.#position];
    if (token === undefined) throw new Error(`Haskell parser omitted token ${this.#position}.`);
    return token;
  }

  private previous(): HaskellFunctionalToken {
    const token = this.tokens[Math.max(0, this.#position - 1)];
    if (token === undefined) throw new Error("Haskell parser omitted its previous token.");
    return token;
  }

  private syntax(token: HaskellFunctionalToken, message: string): HaskellFunctionalSyntaxError {
    return new HaskellFunctionalSyntaxError(token.span, message);
  }

  private describe(token: HaskellFunctionalToken): string {
    return token.kind === "eof" ? "end of source" : JSON.stringify(token.text);
  }
}

function combine(start: FunctionalSpan, end: FunctionalSpan): FunctionalSpan {
  return { startByte: start.startByte, endByte: end.endByte };
}

function constraintsFromType(
  type: HaskellFunctionalType,
): HaskellFunctionalTypeSignature["constraints"] | null {
  if (type.kind === "named" && type.arguments.length === 1) {
    const constrainedType = type.arguments[0];
    if (constrainedType === undefined) throw new Error("Haskell constraint omitted its type.");
    return [{ className: type.name, type: constrainedType, span: type.span }];
  }
  if (type.kind !== "tuple") return null;
  const left = constraintsFromType(type.values[0]);
  const right = constraintsFromType(type.values[1]);
  return left === null || right === null ? null : [...left, ...right];
}

function decodeQuotedLiteral(
  token: HaskellFunctionalToken,
  description: "character" | "string",
): string {
  const contents = token.text.slice(1, -1);
  let decoded = "";
  for (let index = 0; index < contents.length; index++) {
    const value = contents[index];
    if (value !== "\\") {
      decoded += value;
      continue;
    }
    const escape = contents[++index];
    const escaped = escape === "n"
      ? "\n"
      : escape === "r"
      ? "\r"
      : escape === "t"
      ? "\t"
      : escape === "0"
      ? "\0"
      : escape === "\\"
      ? "\\"
      : escape === '"'
      ? '"'
      : escape === "'"
      ? "'"
      : undefined;
    if (escaped !== undefined) {
      decoded += escaped;
      continue;
    }
    throw new HaskellFunctionalSyntaxError(
      token.span,
      `Haskell ${description} literal contains unsupported escape \\${escape ?? ""}.`,
    );
  }
  return decoded;
}

function startsUppercase(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 0x41 && first <= 0x5a;
}

function startsLowercase(name: string): boolean {
  const first = name.charCodeAt(0);
  return first >= 0x61 && first <= 0x7a;
}
