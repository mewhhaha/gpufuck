/**
 * Every surface node kind carries an optional span, but no builder emitted one, so a frontend that
 * tracks source locations had to abandon the builder and hand-write node literals — Gleam does
 * exactly that at 116 sites, and Ducklang emits no spans at all.
 */
import { equal, ok } from "node:assert/strict";

import { BinaryOperator, type Span, surface } from "../functional.ts";

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
  equal(
    spanOf(
      surface.at(SPAN).binary(BinaryOperator.Add, surface.integer(1), surface.integer(2)),
    ),
    SPAN,
  );
});

Deno.test("a folded spine carries the span only on its outermost node", () => {
  const applied = surface.at(SPAN).apply(surface.name("f"), surface.integer(1), surface.integer(2));
  equal(spanOf(applied), SPAN);
  equal(spanOf((applied as { readonly callee: unknown }).callee), undefined);

  const curried = surface.at(SPAN).lambda(["x", "y"], surface.name("y"));
  equal(spanOf(curried), SPAN);
  equal(spanOf((curried as { readonly body: unknown }).body), undefined);
});

Deno.test("desugarings do not attribute the span to nodes they synthesize", () => {
  const delayed = surface.at(SPAN).delay(surface.integer(1));
  equal(spanOf(delayed), SPAN);
  equal(spanOf((delayed as { readonly callee: unknown }).callee), undefined);

  const forced = surface.at(SPAN).force(surface.name("t"));
  equal(spanOf(forced), SPAN);
  const arms = (forced as { readonly arms: readonly { readonly body: unknown }[] }).arms;
  equal(spanOf(arms[0]!.body), undefined);
});

Deno.test("applying no arguments returns the callee rather than claiming its span", () => {
  equal(
    JSON.stringify(surface.at(SPAN).apply(surface.name("f"))),
    JSON.stringify({ kind: "name", name: "f" }),
  );
});
