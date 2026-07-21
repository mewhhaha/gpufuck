export type LazuliHighlightKind =
  | "comment"
  | "constant"
  | "declaration"
  | "keyword"
  | "number"
  | "operator"
  | "plain"
  | "string"
  | "type";

export interface LazuliHighlightToken {
  readonly kind: LazuliHighlightKind;
  readonly start: number;
  readonly value: string;
}

const KEYWORDS = new Set([
  "case",
  "const",
  "data",
  "else",
  "end",
  "fn",
  "fun",
  "if",
  "in",
  "let",
  "of",
  "rec",
  "then",
]);
const CONSTANTS = new Set(["false", "true"]);
const DECLARATION_KEYWORDS = new Set(["const", "data", "fn", "let"]);
const TOKEN_PATTERN =
  /--[^\r\n]*|"[^"\r\n]*"|[A-Za-z_][A-Za-z0-9_]*|[0-9]+|->|=>|==|!=|<=|>=|[@=+\-*/<>|:,;()[\]{}]/g;
const OPERATOR_PATTERN = /^(?:->|=>|==|!=|<=|>=|[@=+\-*/<>|])$/;

export function highlightLazuliSource(source: string): readonly LazuliHighlightToken[] {
  const tokens: LazuliHighlightToken[] = [];
  let sourceOffset = 0;
  let previousSignificantToken = "";

  for (const match of source.matchAll(TOKEN_PATTERN)) {
    const start = match.index;
    if (start > sourceOffset) {
      tokens.push({ kind: "plain", start: sourceOffset, value: source.slice(sourceOffset, start) });
    }

    const value = match[0];
    tokens.push({ kind: highlightKind(value, previousSignificantToken), start, value });
    sourceOffset = start + value.length;
    if (!value.startsWith("--")) previousSignificantToken = value;
  }

  if (sourceOffset < source.length) {
    tokens.push({ kind: "plain", start: sourceOffset, value: source.slice(sourceOffset) });
  }
  return tokens;
}

function highlightKind(value: string, previousSignificantToken: string): LazuliHighlightKind {
  if (value.startsWith("--")) return "comment";
  if (value.startsWith('"')) return "string";
  if (/^[0-9]/.test(value)) return "number";
  if (KEYWORDS.has(value)) return "keyword";
  if (CONSTANTS.has(value)) return "constant";
  if (DECLARATION_KEYWORDS.has(previousSignificantToken)) return "declaration";
  if (/^[A-Z]/.test(value)) return "type";
  if (OPERATOR_PATTERN.test(value)) return "operator";
  return "plain";
}
