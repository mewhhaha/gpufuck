// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// A diagnostic is a problem with the user's program: it is returned, never
// thrown, so a pass reports everything it found rather than stopping at the
// first problem.
//
// An invariant is different. It is a fact the compiler must already know — a
// binding that has to be in scope by this pass, a rule the grammar has already
// accepted. If one is missing the compiler is wrong, not the source, so
// `expect` throws at the site.

import type { Span } from "./syntax/ast.ts";

export interface Diagnostic {
  readonly code: string;
  readonly message: string;
  readonly span: Span;
}

/** The file a diagnostic's span indexes into. */
export interface Origin {
  readonly path: string;
  readonly source: string;
}

export class BlotError extends Error {
  constructor(
    readonly diagnostic: Diagnostic,
    /**
     * A span is an offset into one file, and nothing below the module boundary
     * knows which file. `null` means no pass has claimed the error yet; the
     * module being checked attaches itself as the error propagates out.
     */
    readonly origin: Origin | null = null,
  ) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "BlotError";
  }
}

export function fail(code: string, message: string, span: Span): never {
  throw new BlotError({ code, message, span });
}

export function expect(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) {
    throw new Error(`blot invariant violated: ${message}`);
  }
}

export interface Located {
  readonly line: number;
  readonly column: number;
}

export function locate(source: string, offset: number): Located {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

export function render(
  path: string,
  source: string,
  diagnostic: Diagnostic,
): string {
  const { line, column } = locate(source, diagnostic.span.start);
  return `${path}:${line}:${column}: ${diagnostic.code}: ${diagnostic.message}`;
}
