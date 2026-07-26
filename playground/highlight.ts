/// <reference lib="dom" />

/**
 * A Gleam highlighter for the playground editor.
 *
 * Hand-written rather than a dependency, for the same reason the playground has no bundler: the
 * grammar it needs to colour is the subset this compiler accepts, which is small and already
 * documented in `examples/gleam/`. It is a lexer, not a parser — it never needs to be right about
 * structure, only about which run of characters is a comment, a string, a number, a keyword, or a
 * capitalised name.
 *
 * @module
 */

/** Reserved words in the accepted subset, plus the ones a user is likely to type by habit. */
const KEYWORDS = new Set([
  "as",
  "assert",
  "case",
  "const",
  "echo",
  "fn",
  "if",
  "import",
  "let",
  "opaque",
  "panic",
  "pub",
  "todo",
  "type",
  "use",
]);

/** Prelude names worth distinguishing from user constructors, since they are always in scope. */
const PRELUDE = new Set([
  "Bool",
  "BitArray",
  "Error",
  "False",
  "Float",
  "Int",
  "List",
  "Nil",
  "Ok",
  "Result",
  "String",
  "True",
  "UtfCodepoint",
]);

type TokenKind =
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "prelude"
  | "type"
  | "function"
  | "operator"
  | "plain";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
}

/**
 * One ordered alternation, so the first match wins and a `//` inside a string cannot be mistaken for
 * a comment. Order is load-bearing: comments and strings come before everything else.
 */
const TOKEN = new RegExp(
  [
    "(?<comment>\\/\\/[^\\n]*)",
    '(?<string>"(?:[^"\\\\\\n]|\\\\.)*"?)',
    "(?<number>0[bx][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]*)?(?:[eE][+-]?\\d+)?)",
    "(?<upper>[A-Z][A-Za-z0-9_]*)",
    "(?<lower>[a-z_][A-Za-z0-9_]*)",
    "(?<operator>[-+*/%<>=!|&.,:;(){}\\[\\]#@]+)",
    "(?<space>\\s+)",
  ].join("|"),
  "gu",
);

function tokenize(source: string): readonly Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  for (const match of source.matchAll(TOKEN)) {
    // Anything the alternation did not claim still has to reach the output, or the overlay would
    // drift out of alignment with the textarea it sits behind.
    if (match.index > cursor) {
      tokens.push({ kind: "plain", text: source.slice(cursor, match.index) });
    }
    cursor = match.index + match[0].length;
    const groups = match.groups ?? {};
    if (groups.comment !== undefined) tokens.push({ kind: "comment", text: match[0] });
    else if (groups.string !== undefined) tokens.push({ kind: "string", text: match[0] });
    else if (groups.number !== undefined) tokens.push({ kind: "number", text: match[0] });
    else if (groups.upper !== undefined) {
      tokens.push({ kind: PRELUDE.has(match[0]) ? "prelude" : "type", text: match[0] });
    } else if (groups.lower !== undefined) {
      // A lowercase name directly followed by `(` reads as a call; that is a lexical guess and it
      // is allowed to be wrong, because being wrong only changes a colour.
      const next = source[cursor];
      const kind: TokenKind = KEYWORDS.has(match[0])
        ? "keyword"
        : next === "("
        ? "function"
        : "plain";
      tokens.push({ kind, text: match[0] });
    } else if (groups.operator !== undefined) tokens.push({ kind: "operator", text: match[0] });
    else tokens.push({ kind: "plain", text: match[0] });
  }
  if (cursor < source.length) tokens.push({ kind: "plain", text: source.slice(cursor) });
  return tokens;
}

/**
 * Renders `source` into `target` as coloured spans.
 *
 * Built with `createTextNode` rather than `innerHTML` so no path exists from editor content to
 * markup — the editor is the one place on the page where a user types arbitrary text.
 *
 * A trailing newline gets a space appended, because a text node ending in `\\n` collapses and the
 * highlight layer would then be one line shorter than the textarea and scroll out of step.
 */
export function renderHighlight(source: string, target: HTMLElement): void {
  const fragment = document.createDocumentFragment();
  for (const token of tokenize(source)) {
    if (token.kind === "plain") {
      fragment.append(document.createTextNode(token.text));
      continue;
    }
    const span = document.createElement("span");
    span.className = `tok-${token.kind}`;
    span.textContent = token.text;
    fragment.append(span);
  }
  if (source.endsWith("\n") || source.length === 0) {
    fragment.append(document.createTextNode(" "));
  }
  target.replaceChildren(fragment);
}
