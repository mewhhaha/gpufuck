// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// blot's abstract syntax. The concrete grammar is shaped by the GPU profile —
// flat operator chains, `;` and `end` boundaries, a `value` rule that is either
// a lambda or an expression — and none of that survives into this tree. What
// arrives here is already fixity-folded and pattern-classified.

export interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * `!` is consumed exactly once, `?` at most once, `&` borrowed without spending.
 *
 * Affine is not a weaker linear: it is the right rule for a continuation, where
 * not resuming is an abort rather than a leak.
 */
export type Qualifier = "none" | "linear" | "affine" | "borrow";

export type Pattern =
  | {
    readonly tag: "name";
    readonly name: string;
    readonly qualifier: Qualifier;
    readonly span: Span;
  }
  | { readonly tag: "wildcard"; readonly span: Span }
  | { readonly tag: "int"; readonly value: bigint; readonly span: Span }
  | { readonly tag: "text"; readonly value: string; readonly span: Span }
  | { readonly tag: "unit"; readonly span: Span }
  | {
    readonly tag: "tuple";
    readonly elements: readonly Pattern[];
    readonly span: Span;
  }
  | {
    readonly tag: "array";
    readonly elements: readonly Pattern[];
    readonly span: Span;
  }
  | {
    readonly tag: "constructor";
    readonly name: string;
    readonly payload: Pattern | null;
    readonly span: Span;
  }
  | {
    readonly tag: "shape";
    readonly fields: readonly ShapePatternField[];
    readonly span: Span;
  };

export interface ShapePatternField {
  readonly name: string;
  readonly pattern: Pattern;
}

export interface ArrayElement {
  readonly spread: boolean;
  readonly value: Expr;
}

export type ShapeMember =
  | { readonly tag: "field"; readonly name: string; readonly value: Expr }
  | { readonly tag: "spread"; readonly value: Expr };

export interface Branch {
  readonly condition: Expr;
  readonly consequence: Expr;
}

export interface Arm {
  readonly pattern: Pattern;
  readonly body: Expr;
}

export type Expr =
  | { readonly tag: "var"; readonly name: string; readonly span: Span }
  | { readonly tag: "int"; readonly value: bigint; readonly span: Span }
  | { readonly tag: "text"; readonly value: string; readonly span: Span }
  | { readonly tag: "unit"; readonly span: Span }
  /** An `@`-primitive. The whole compiler surface lives in this namespace. */
  | { readonly tag: "intrinsic"; readonly name: string; readonly span: Span }
  /** A bare constructor, `#Ready`. Applying it attaches a payload. */
  | { readonly tag: "tag"; readonly name: string; readonly span: Span }
  | {
    readonly tag: "apply";
    readonly fn: Expr;
    readonly arg: Expr;
    readonly span: Span;
  }
  | {
    readonly tag: "field";
    readonly target: Expr;
    readonly name: string;
    readonly span: Span;
  }
  | {
    readonly tag: "lambda";
    readonly parameter: Pattern;
    readonly body: Expr;
    readonly span: Span;
  }
  | {
    readonly tag: "array";
    readonly elements: readonly ArrayElement[];
    readonly span: Span;
  }
  | {
    readonly tag: "tuple";
    readonly elements: readonly Expr[];
    readonly span: Span;
  }
  | {
    readonly tag: "shape";
    readonly members: readonly ShapeMember[];
    readonly span: Span;
  }
  | {
    readonly tag: "if";
    readonly branches: readonly Branch[];
    readonly fallback: Expr | null;
    readonly span: Span;
  }
  | {
    readonly tag: "case";
    readonly target: Expr;
    readonly arms: readonly Arm[];
    readonly span: Span;
  }
  | {
    readonly tag: "block";
    readonly declarations: readonly Decl[];
    readonly result: Expr;
    readonly span: Span;
  }
  /** `rec f` binds `rec` inside `f`'s body to `f` itself. */
  | { readonly tag: "rec"; readonly lambda: Expr; readonly span: Span }
  | { readonly tag: "comptime"; readonly body: Expr; readonly span: Span };

export type DeclKind = "let" | "const" | "sig";

export interface OpenMapping {
  readonly source: string;
  /** `null` suppresses the source field instead of binding it. */
  readonly target: string | null;
  readonly span: Span;
}

export type Decl =
  | {
    readonly tag: "binding";
    readonly kind: DeclKind;
    readonly pattern: Pattern;
    readonly value: Expr;
    readonly span: Span;
  }
  | {
    readonly tag: "shadow";
    readonly name: string;
    readonly value: Expr;
    readonly span: Span;
  }
  /**
   * `open { .source: target, .hidden: _ } = expr;` spreads a record's fields
   * into scope while renaming or suppressing the listed fields.
   *
   * The prelude is an ordinary module with no privilege, so this is how `+`
   * reaches `Num.add`: a default fixity whose target is not in scope is
   * useless, and `open` is what puts it there.
   */
  | {
    readonly tag: "open";
    readonly mappings: readonly OpenMapping[];
    readonly value: Expr;
    readonly span: Span;
  };

export type Associativity = "left" | "right" | "none" | "prefix";

export interface Fixity {
  readonly operator: string;
  readonly associativity: Associativity;
  readonly precedence: number;
  /** Dotted path, e.g. `Num.add` or `@type.union`. */
  readonly target: readonly string[];
  readonly span: Span;
}

export interface Module {
  /** Bound by `module <pattern>;`. The entry module's whole authority. */
  readonly parameter: Pattern | null;
  readonly fixities: readonly Fixity[];
  readonly declarations: readonly Decl[];
  readonly result: Expr;
  readonly span: Span;
}
