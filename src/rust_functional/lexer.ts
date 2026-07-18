import type { FunctionalSpan } from "../functional/abi.ts";
import { RustFunctionalSyntaxError } from "./diagnostic.ts";

export type RustFunctionalTokenKind = "identifier" | "integer" | "symbol" | "eof";

export interface RustFunctionalToken {
  readonly kind: RustFunctionalTokenKind;
  readonly text: string;
  readonly span: FunctionalSpan;
}

const twoCharacterSymbols = new Set(["::", "->", "=>", "==", "!=", "<=", ">="]);
const oneCharacterSymbols = new Set([
  "{",
  "}",
  "(",
  ")",
  "<",
  ">",
  ",",
  ":",
  ";",
  "=",
  "+",
  "-",
  "*",
  "/",
  "_",
  "&",
]);

export function lexRustFunctionalSource(source: string): readonly RustFunctionalToken[] {
  const byteOffsets = new Utf8ByteOffsets(source);
  const tokens: RustFunctionalToken[] = [];
  let offset = 0;

  while (offset < source.length) {
    const codeUnit = source.charCodeAt(offset);
    if (isWhitespace(codeUnit)) {
      offset++;
      continue;
    }
    if (source.startsWith("//", offset)) {
      offset += 2;
      while (offset < source.length && source[offset] !== "\n" && source[offset] !== "\r") {
        offset++;
      }
      continue;
    }

    const start = offset;
    if (isIdentifierStart(codeUnit)) {
      offset++;
      while (offset < source.length && isIdentifierContinue(source.charCodeAt(offset))) offset++;
      tokens.push(token("identifier", source, start, offset, byteOffsets));
      continue;
    }
    if (isDigit(codeUnit)) {
      offset++;
      while (offset < source.length && isDigit(source.charCodeAt(offset))) offset++;
      tokens.push(token("integer", source, start, offset, byteOffsets));
      continue;
    }

    const pair = source.slice(offset, offset + 2);
    if (twoCharacterSymbols.has(pair)) {
      offset += 2;
      tokens.push(token("symbol", source, start, offset, byteOffsets));
      continue;
    }
    const symbol = source[offset];
    if (symbol !== undefined && oneCharacterSymbols.has(symbol)) {
      offset++;
      tokens.push(token("symbol", source, start, offset, byteOffsets));
      continue;
    }

    const span = byteOffsets.span(start, Math.min(source.length, start + 1));
    throw new RustFunctionalSyntaxError(
      span,
      `Rust functional profile does not recognize ${
        JSON.stringify(source.slice(start, start + 1))
      }.`,
    );
  }

  const end = byteOffsets.span(source.length, source.length);
  tokens.push({ kind: "eof", text: "", span: end });
  return tokens;
}

function token(
  kind: RustFunctionalTokenKind,
  source: string,
  start: number,
  end: number,
  byteOffsets: Utf8ByteOffsets,
): RustFunctionalToken {
  return { kind, text: source.slice(start, end), span: byteOffsets.span(start, end) };
}

function isWhitespace(codeUnit: number): boolean {
  return codeUnit === 0x20 || codeUnit === 0x09 || codeUnit === 0x0a || codeUnit === 0x0d;
}

function isIdentifierStart(codeUnit: number): boolean {
  return codeUnit === 0x5f || codeUnit >= 0x41 && codeUnit <= 0x5a ||
    codeUnit >= 0x61 && codeUnit <= 0x7a;
}

function isIdentifierContinue(codeUnit: number): boolean {
  return isIdentifierStart(codeUnit) || isDigit(codeUnit);
}

function isDigit(codeUnit: number): boolean {
  return codeUnit >= 0x30 && codeUnit <= 0x39;
}

class Utf8ByteOffsets {
  readonly #offsets: Uint32Array;

  constructor(source: string) {
    this.#offsets = new Uint32Array(source.length + 1);
    let byteOffset = 0;
    for (let index = 0; index < source.length; index++) {
      this.#offsets[index] = byteOffset;
      const codeUnit = source.charCodeAt(index);
      const nextCodeUnit = source.charCodeAt(index + 1);
      if (isHighSurrogate(codeUnit) && isLowSurrogate(nextCodeUnit)) {
        this.#offsets[index + 1] = byteOffset;
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
    this.#offsets[source.length] = byteOffset;
  }

  span(start: number, end: number): FunctionalSpan {
    return { startByte: this.at(start), endByte: this.at(end) };
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
