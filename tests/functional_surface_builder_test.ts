/**
 * Every surface node kind carries an optional span, but no builder emitted one, so a frontend that
 * tracks source locations had to abandon the builder and hand-write node literals. `at()` covers
 * that. Exact-arity lambdas and applications carry one span for the whole source construct.
 */
import { equal, ok, throws } from "node:assert/strict";

import { BinaryOperator, type Span, surface, type SurfaceExpression } from "../functional.ts";

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
      parameters: ["x", "y"],
      body: { kind: "name", name: "y" },
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

Deno.test("exact-arity functions and calls carry one span", () => {
  const applied = surface.at(SPAN).apply(surface.name("f"), surface.integer(1), surface.integer(2));
  equal(spanOf(applied), SPAN);
  equal(
    (applied as { readonly arguments: readonly unknown[] }).arguments.length,
    2,
  );

  const lambda = surface.at(SPAN).lambda(["x", "y", "z"], surface.name("z"));
  equal(spanOf(lambda), SPAN);
  equal((lambda as { readonly parameters: readonly string[] }).parameters.length, 3);
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

Deno.test("applying no arguments produces a genuine zero-arity call", () => {
  equal(
    JSON.stringify(surface.at(SPAN).apply(surface.name("f"))),
    JSON.stringify({
      kind: "apply",
      callee: { kind: "name", name: "f" },
      arguments: [],
      span: SPAN,
    }),
  );
});

Deno.test("binding no parameters produces a genuine zero-arity function", () => {
  equal(
    JSON.stringify(surface.at(SPAN).lambda([], surface.name("f"))),
    JSON.stringify({
      kind: "lambda",
      parameters: [],
      body: { kind: "name", name: "f" },
      span: SPAN,
    }),
  );
});

Deno.test("structural record construction rejects fields that disagree with its layout", () => {
  const layout = { type: "Point", constructor: "Point", fields: ["x", "y"] } as const;
  throws(
    () => surface.structuralRecord(layout, { x: surface.integer(1) }),
    /structural record "Point" is missing field "y"/,
  );
  throws(
    () =>
      surface.structuralRecord(layout, {
        x: surface.integer(1),
        y: surface.integer(2),
        z: surface.integer(3),
      }),
    /structural record "Point" has no field "z"/,
  );
});

Deno.test("structural record desugarings carry the spanned builder through every node", () => {
  const source = { type: "Source", constructor: "Source", fields: ["x"] } as const;
  const patch = { type: "Patch", constructor: "Patch", fields: ["y"] } as const;
  const result = { type: "Result", constructor: "Result", fields: ["x", "y"] } as const;
  const spanned = surface.at(SPAN);
  const expressions = [
    spanned.structuralRecord(source, { x: spanned.integer(1) }),
    spanned.hasFieldEvidence(source, "x"),
    spanned.projectField("x", spanned.name("record"), spanned.name("evidence")),
    spanned.extendRecordEvidence(source, patch, result),
    spanned.extendRecord(
      spanned.name("record"),
      spanned.name("patch"),
      spanned.name("evidence"),
    ),
  ];

  const visit = (expression: SurfaceExpression): void => {
    equal(expression.span, SPAN);
    switch (expression.kind) {
      case "lambda":
        visit(expression.body);
        return;
      case "apply":
        visit(expression.callee);
        for (const argument of expression.arguments) visit(argument);
        return;
      case "case":
        visit(expression.value);
        for (const arm of expression.arms) {
          equal(arm.span, SPAN);
          visit(arm.body);
        }
        return;
      default:
        return;
    }
  };
  for (const expression of expressions) visit(expression);
});

Deno.test("let, if, and case stamp the span the frontend would have written by hand", () => {
  const bound = surface.at(SPAN).let("x", surface.integer(1), surface.name("x"));
  equal(spanOf(bound), SPAN);
  equal((bound as { readonly kind: string }).kind, "let");

  const branch = surface.at(SPAN).if(surface.boolean(true), surface.integer(1), surface.integer(2));
  equal(spanOf(branch), SPAN);
  equal((branch as { readonly kind: string }).kind, "if");
});

Deno.test("let and sequence expose demand and sequencing as distinct expressions", () => {
  equal(
    JSON.stringify(surface.let("x", surface.integer(1), surface.name("x"))),
    JSON.stringify({
      kind: "let",
      name: "x",
      value: { kind: "integer", value: 1 },
      body: { kind: "name", name: "x" },
    }),
  );
  equal(
    JSON.stringify(surface.sequence("x", surface.integer(1), surface.name("x"))),
    JSON.stringify({
      kind: "sequence",
      name: "x",
      value: { kind: "integer", value: 1 },
      body: { kind: "name", name: "x" },
    }),
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
