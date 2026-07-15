import type { FunctionalSpan } from "../functional/abi.ts";
import { OcamlFunctionalSyntaxError } from "./diagnostic.ts";

export type OcamlFunctionalTokenKind = "identifier" | "integer" | "symbol" | "eof";

export interface OcamlFunctionalToken {
  readonly kind: OcamlFunctionalTokenKind;
  readonly text: string;
  readonly span: FunctionalSpan;
  readonly line: number;
  readonly column: number;
  readonly lineBreakBefore: boolean;
}

const twoCharacterSymbols = new Set(["->", "<=", ">=", "<>", "::", ";;"]);
const oneCharacterSymbols = new Set([
  "(",
  ")",
  "[",
  "]",
  ",",
  ";",
  "=",
  "|",
  "+",
  "-",
  "*",
  "/",
  "<",
  ">",
  "_",
]);

export function lexOcamlFunctionalSource(source: string): readonly OcamlFunctionalToken[] {
  const byteOffsets = new Utf8ByteOffsets(source);
  const tokens: OcamlFunctionalToken[] = [];
  let previousTokenLine = 0;
  let offset = 0;

  const pushToken = (
    kind: OcamlFunctionalTokenKind,
    start: number,
    end: number,
  ): void => {
    const position = byteOffsets.position(start);
    tokens.push({
      kind,
      text: source.slice(start, end),
      span: byteOffsets.span(start, end),
      line: position.line,
      column: position.column,
      lineBreakBefore: previousTokenLine !== 0 && position.line > previousTokenLine,
    });
    previousTokenLine = position.line;
  };

  while (offset < source.length) {
    const codeUnit = source.charCodeAt(offset);
    if (isWhitespace(codeUnit)) {
      offset++;
      continue;
    }
    if (source.startsWith("(*", offset)) {
      offset = skipComment(source, offset, byteOffsets);
      continue;
    }

    const start = offset;
    if (codeUnit === 0x27 && isIdentifierStart(source.charCodeAt(offset + 1))) {
      offset += 2;
      while (offset < source.length && isIdentifierContinue(source.charCodeAt(offset))) offset++;
      pushToken("identifier", start, offset);
      continue;
    }
    if (isIdentifierStart(codeUnit)) {
      offset++;
      while (offset < source.length && isIdentifierContinue(source.charCodeAt(offset))) offset++;
      pushToken("identifier", start, offset);
      continue;
    }
    if (isDigit(codeUnit)) {
      offset++;
      while (offset < source.length && isDigit(source.charCodeAt(offset))) offset++;
      pushToken("integer", start, offset);
      continue;
    }

    const pair = source.slice(offset, offset + 2);
    if (twoCharacterSymbols.has(pair)) {
      offset += 2;
      pushToken("symbol", start, offset);
      continue;
    }
    const symbol = source[offset];
    if (symbol !== undefined && oneCharacterSymbols.has(symbol)) {
      offset++;
      pushToken("symbol", start, offset);
      continue;
    }

    const span = byteOffsets.span(start, Math.min(source.length, start + 1));
    throw new OcamlFunctionalSyntaxError(
      span,
      `OCaml functional profile does not recognize ${
        JSON.stringify(source.slice(start, start + 1))
      }.`,
    );
  }

  const end = byteOffsets.span(source.length, source.length);
  const endPosition = byteOffsets.position(source.length);
  tokens.push({
    kind: "eof",
    text: "",
    span: end,
    line: endPosition.line,
    column: endPosition.column,
    lineBreakBefore: endPosition.line > previousTokenLine,
  });
  return tokens;
}

function skipComment(source: string, start: number, byteOffsets: Utf8ByteOffsets): number {
  let depth = 1;
  let offset = start + 2;
  while (offset < source.length) {
    if (source.startsWith("(*", offset)) {
      depth++;
      offset += 2;
      continue;
    }
    if (source.startsWith("*)", offset)) {
      depth--;
      offset += 2;
      if (depth === 0) return offset;
      continue;
    }
    offset++;
  }
  throw new OcamlFunctionalSyntaxError(
    byteOffsets.span(start, source.length),
    `OCaml comment at byte ${byteOffsets.span(start, start).startByte} is unterminated.`,
  );
}

function isWhitespace(codeUnit: number): boolean {
  return codeUnit === 0x20 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d;
}

function isIdentifierStart(codeUnit: number): boolean {
  return codeUnit >= 0x41 && codeUnit <= 0x5a || codeUnit >= 0x61 && codeUnit <= 0x7a ||
    codeUnit === 0x5f;
}

function isIdentifierContinue(codeUnit: number): boolean {
  return isIdentifierStart(codeUnit) || isDigit(codeUnit) || codeUnit === 0x27;
}

function isDigit(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x39;
}

class Utf8ByteOffsets {
  readonly #offsets: Uint32Array;
  readonly #lines: Uint32Array;
  readonly #columns: Uint32Array;

  constructor(source: string) {
    this.#offsets = new Uint32Array(source.length + 1);
    this.#lines = new Uint32Array(source.length + 1);
    this.#columns = new Uint32Array(source.length + 1);
    let byteOffset = 0;
    let line = 1;
    let column = 1;
    for (let index = 0; index < source.length; index++) {
      this.#offsets[index] = byteOffset;
      this.#lines[index] = line;
      this.#columns[index] = column;
      const codeUnit = source.charCodeAt(index);
      const nextCodeUnit = source.charCodeAt(index + 1);
      if (isHighSurrogate(codeUnit) && isLowSurrogate(nextCodeUnit)) {
        this.#offsets[index + 1] = byteOffset;
        this.#lines[index + 1] = line;
        this.#columns[index + 1] = column;
        byteOffset += 4;
        column++;
        index++;
      } else if (codeUnit <= 0x7f) {
        byteOffset++;
        if (codeUnit === 0x0a) {
          if (index === 0 || source.charCodeAt(index - 1) !== 0x0d) line++;
          column = 1;
        } else if (codeUnit === 0x0d) {
          line++;
          column = 1;
        } else if (codeUnit === 0x09) {
          column += 8 - (column - 1) % 8;
        } else {
          column++;
        }
      } else if (codeUnit <= 0x7ff) {
        byteOffset += 2;
        column++;
      } else {
        byteOffset += 3;
        column++;
      }
    }
    this.#offsets[source.length] = byteOffset;
    this.#lines[source.length] = line;
    this.#columns[source.length] = column;
  }

  span(start: number, end: number): FunctionalSpan {
    return { startByte: this.at(start), endByte: this.at(end) };
  }

  position(offset: number): { readonly line: number; readonly column: number } {
    const bounded = Math.min(Math.max(offset, 0), this.#offsets.length - 1);
    return {
      line: this.#lines[bounded] ?? 1,
      column: this.#columns[bounded] ?? 1,
    };
  }

  private at(offset: number): number {
    const bounded = Math.min(Math.max(offset, 0), this.#offsets.length - 1);
    return this.#offsets[bounded] ?? 0;
  }
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}
