/**
 * Every surface node kind carries an optional span, but no builder emitted one, so a frontend that
 * tracks source locations had to abandon the builder and hand-write node literals. `at()` covers
 * that, and it has to reach the interior of a fold: stamping only the outermost node loses one span
 * per curried lambda parameter and per extra application argument.
 */
import { equal, ok } from "node:assert/strict";

import {
  BinaryOperator,
  EvaluationProfile,
  type Span,
  surface,
  type SurfaceExpression,
} from "../functional.ts";

const SPAN: Span = { startByte: 10, endByte: 20 };

function spanOf(expression: unknown): Span | undefined {
  return (expression as { readonly span?: Span }).span;
}

Deno.test("the default builder emits no span, so existing output is unchanged", () => {
  ok(!JSON.stringify(surface.integer(1)).includes("span"));
  equal(
    JSON.stringify(surface.lambda(["x", "y"], surface.name("y"))),
    JSON.stringify({
      kind: "lambda",
      parameter: "x",
      body: { kind: "lambda", parameter: "y", body: { kind: "name", name: "y" } },
    }),
  );
});

Deno.test("at() stamps the node each helper produces", () => {
  equal(spanOf(surface.at(SPAN).integer(1)), SPAN);
  equal(spanOf(surface.at(SPAN).storeEmpty()), SPAN);
  equal(
    spanOf(
      surface.at(SPAN).binary(BinaryOperator.Add, surface.integer(1), surface.integer(2)),
    ),
    SPAN,
  );
});

Deno.test("every node of a folded spine carries the span, not just the outermost", () => {
  const applied = surface.at(SPAN).apply(surface.name("f"), surface.integer(1), surface.integer(2));
  equal(spanOf(applied), SPAN);
  equal(spanOf((applied as { readonly callee: unknown }).callee), SPAN);

  const curried = surface.at(SPAN).lambda(["x", "y", "z"], surface.name("z"));
  equal(spanOf(curried), SPAN);
  const second = (curried as { readonly body: unknown }).body;
  equal(spanOf(second), SPAN);
  equal(spanOf((second as { readonly body: unknown }).body), SPAN);
});

Deno.test("desugarings attribute the span to the nodes they synthesize", () => {
  const delayed = surface.at(SPAN).delay(surface.integer(1));
  equal(spanOf(delayed), SPAN);
  equal(spanOf((delayed as { readonly callee: unknown }).callee), SPAN);

  const forced = surface.at(SPAN).force(surface.name("t"));
  equal(spanOf(forced), SPAN);
  const arms = (forced as { readonly arms: readonly { readonly body: unknown }[] }).arms;
  equal(spanOf(arms[0]!), SPAN);
  equal(spanOf(arms[0]!.body), SPAN);
});

Deno.test("applying no arguments returns the callee rather than claiming its span", () => {
  equal(
    JSON.stringify(surface.at(SPAN).apply(surface.name("f"))),
    JSON.stringify({ kind: "name", name: "f" }),
  );
});

Deno.test("binding no parameters returns the body rather than claiming its span", () => {
  equal(
    JSON.stringify(surface.at(SPAN).lambda([], surface.name("f"))),
    JSON.stringify({ kind: "name", name: "f" }),
  );
});

Deno.test("let, if, and case stamp the span the frontend would have written by hand", () => {
  const bound = surface.at(SPAN).let("x", surface.integer(1), surface.name("x"));
  equal(spanOf(bound), SPAN);
  equal((bound as { readonly kind: string }).kind, "let");

  const branch = surface.at(SPAN).if(surface.boolean(true), surface.integer(1), surface.integer(2));
  equal(spanOf(branch), SPAN);
  equal((branch as { readonly kind: string }).kind, "if");
});

Deno.test("let omits the evaluation profile unless one is requested", () => {
  equal(
    JSON.stringify(surface.let("x", surface.integer(1), surface.name("x"))),
    JSON.stringify({
      kind: "let",
      name: "x",
      value: { kind: "integer", value: 1 },
      body: { kind: "name", name: "x" },
    }),
  );
  const lazy = surface.let(
    "x",
    surface.integer(1),
    surface.name("x"),
    EvaluationProfile.LazyCallByNeed,
  );
  equal(
    (lazy as { readonly valueEvaluation?: EvaluationProfile }).valueEvaluation,
    EvaluationProfile.LazyCallByNeed,
  );
});

Deno.test("case fills in arm spans it was not given and keeps the ones it was", () => {
  const armSpan: Span = { startByte: 30, endByte: 40 };
  const matched = surface.at(SPAN).case(
    surface.name("value"),
    [
      { constructor: "None", binders: [], body: surface.integer(0) },
      { constructor: "Some", binders: ["v"], body: surface.name("v"), span: armSpan },
    ],
    { binder: "other", body: surface.integer(1) },
  ) as Extract<SurfaceExpression, { readonly kind: "case" }>;

  equal(spanOf(matched), SPAN);
  equal(matched.arms[0]!.span, SPAN);
  equal(matched.arms[1]!.span, armSpan);
  equal(matched.otherwise?.span, SPAN);
});

Deno.test("the default builder leaves case arms unspanned", () => {
  const matched = surface.case(surface.name("value"), [{
    constructor: "None",
    binders: [],
    body: surface.integer(0),
  }]) as Extract<SurfaceExpression, { readonly kind: "case" }>;

  ok(!JSON.stringify(matched).includes("span"));
});
