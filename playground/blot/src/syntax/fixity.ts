// @ts-nocheck -- Vendored Blot is checked under its own compiler options.
// Precedence resolution.
//
// The grammar parses expressions as flat `operand (OPERATOR operand)*` chains
// so that the contracted grammar has no residual recursion — precedence is a
// semantic recipe, not a grammar shape. This is where the chain becomes a tree.
//
// The table is needed only here, never by the parser, so a built-in default set
// costs nothing structurally. Without it every file would have to restate the
// fixity of `+` before it could use it. A module's `operators` header extends
// the defaults and may override any entry.

import type { Associativity, Expr, Fixity, Span } from "./ast.ts";
import { fail } from "../diagnostic.ts";

const NOWHERE: Span = { start: 0, end: 0 };

function entry(
  operator: string,
  associativity: Associativity,
  precedence: number,
  target: string,
): Fixity {
  // An intrinsic is one token, dots included; only a qualified name splits.
  const path = target.startsWith("@") ? [target] : target.split(".");
  return { operator, associativity, precedence, target: path, span: NOWHERE };
}

/**
 * Everything here is an ordinary blot declaration in `src/prelude`. None of it
 * is built into the compiler; only the precedence is.
 */
export const DEFAULT_FIXITIES: readonly Fixity[] = [
  // Loosest first. The levels are grouped by what an operator *does*, and two
  // groups only share a level when mixing them without parentheses is
  // meaningless anyway.
  entry("$", "right", 10, "Fn.apply"),
  entry("|>", "left", 20, "Fn.pipe"),

  // Distinct spellings from `|` and `&`, which are set algebra. Both are
  // ordinary curried functions, so both arguments are evaluated — `if` is the
  // short-circuiting form.
  entry("||", "right", 22, "Logic.or"),
  entry("&&", "right", 24, "Logic.and"),

  // An arrow is looser than everything that builds the types on either side of
  // it, so `A | B -> C` is `(A | B) -> C` — the reading the notation has
  // everywhere else.
  entry("->", "right", 25, "@type.arrow"),

  entry("==", "none", 30, "Eq.eq"),
  entry("/=", "none", 30, "Eq.ne"),
  entry("<", "none", 30, "Ord.lt"),
  entry("<=", "none", 30, "Ord.le"),
  entry(">", "none", 30, "Ord.gt"),
  entry(">=", "none", 30, "Ord.ge"),

  // Set algebra mirrors arithmetic: intersection is the product, union and
  // difference are the sum and the remainder, and the product binds tighter.
  // `A | B & C` is `A | (B & C)`.
  entry("|", "left", 40, "Set.union"),
  entry("\\", "left", 40, "Set.diff"),
  entry("&", "left", 45, "Set.intersect"),

  entry("<+", "left", 50, "attach"),

  // Above comparison, so `a <> b == c` compares the joined value; below
  // arithmetic, so `text <> x + y` appends the sum.
  entry("<>", "right", 55, "Semigroup.append"),

  entry("+", "left", 60, "Num.add"),
  entry("-", "left", 60, "Num.sub"),
  entry("*", "left", 70, "Num.mul"),
  entry("/", "left", 70, "Num.div"),
  entry("%", "left", 70, "Num.rem"),

  entry("-", "prefix", 90, "Num.negate"),
  entry("!", "prefix", 90, "@linear.own"),
  entry("?", "prefix", 90, "@linear.maybe"),
  entry("&", "prefix", 90, "@linear.borrow"),
];

export interface FixityTable {
  infix(operator: string): Fixity | undefined;
  prefix(operator: string): Fixity | undefined;
}

export function buildFixityTable(declared: readonly Fixity[]): FixityTable {
  const infix = new Map<string, Fixity>();
  const prefix = new Map<string, Fixity>();

  for (const fixity of [...DEFAULT_FIXITIES, ...declared]) {
    if (fixity.associativity === "prefix") {
      prefix.set(fixity.operator, fixity);
    } else {
      infix.set(fixity.operator, fixity);
    }
  }

  return {
    infix: (operator) => infix.get(operator),
    prefix: (operator) => prefix.get(operator),
  };
}

/** Turns a fixity target such as `Num.add` or `@type.union` into a callee. */
export function targetExpr(fixity: Fixity, span: Span): Expr {
  const [root, ...rest] = fixity.target;
  let result: Expr = root.startsWith("@")
    ? { tag: "intrinsic", name: root, span }
    : { tag: "var", name: root, span };
  for (const name of rest) {
    result = { tag: "field", target: result, name, span };
  }
  return result;
}

export interface ChainStep {
  readonly operator: string;
  readonly right: Expr;
  readonly span: Span;
}

/**
 * Operator-precedence fold over the flat chain.
 *
 * Infix application is curried: `a + b` becomes `Num.add a b`, not
 * `Num.add (a, b)`. Currying is what makes `Num.add 2` a usable value, which is
 * what makes `20 |> Num.add 2` work at all, and it is the reading a language
 * with one parameter per function should have.
 */
export function foldChain(
  first: Expr,
  steps: readonly ChainStep[],
  table: FixityTable,
): Expr {
  let position = 0;

  const lookup = (step: ChainStep): Fixity => {
    const fixity = table.infix(step.operator);
    if (fixity === undefined) {
      // `=>` reaching the fixity table means a lambda appeared where the
      // grammar could not admit one. Every character of `=>` is in the operator
      // class, so it lexes as an ordinary operator and lands here.
      if (step.operator === "=>") {
        fail(
          "BLOT_UNPARENTHESIZED_LAMBDA",
          "A lambda body is an expression, not another lambda. Parenthesize the inner one: `a => (b => ...)`.",
          step.span,
        );
      }
      fail(
        "BLOT_UNKNOWN_OPERATOR",
        `No fixity is declared for the infix operator \`${step.operator}\`. Declare one in the module's \`operators\` header.`,
        step.span,
      );
    }
    return fixity;
  };

  const climb = (left: Expr, minimum: number): Expr => {
    let result = left;
    while (position < steps.length) {
      const step = steps[position];
      const fixity = lookup(step);
      if (fixity.precedence < minimum) break;
      position += 1;

      let right = step.right;
      while (position < steps.length) {
        const next = lookup(steps[position]);
        const bindsTighter = next.precedence > fixity.precedence ||
          (next.precedence === fixity.precedence &&
            next.associativity === "right");
        if (!bindsTighter) break;
        right = climb(right, next.precedence);
      }

      if (
        fixity.associativity === "none" && position < steps.length &&
        lookup(steps[position]).precedence === fixity.precedence
      ) {
        fail(
          "BLOT_NON_ASSOCIATIVE_CHAIN",
          `\`${step.operator}\` is non-associative, so it cannot be chained with \`${
            steps[position].operator
          }\` at the same precedence. Parenthesize one side.`,
          steps[position].span,
        );
      }

      const span = { start: result.span.start, end: right.span.end };
      const callee = targetExpr(fixity, step.span);
      result = {
        tag: "apply",
        fn: { tag: "apply", fn: callee, arg: result, span },
        arg: right,
        span,
      };
    }
    return result;
  };

  const folded = climb(first, 0);
  expectConsumed(position, steps);
  return folded;
}

function expectConsumed(position: number, steps: readonly ChainStep[]): void {
  if (position !== steps.length) {
    fail(
      "BLOT_UNRESOLVED_CHAIN",
      "The operator chain could not be fully resolved.",
      steps[position].span,
    );
  }
}
