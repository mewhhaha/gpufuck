import { deepStrictEqual, equal, ok } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  EvaluationProfile,
  functionalThunkType,
  GpuCompiler,
  GpuEvaluator,
  requestWebGpuDevice,
  surface,
  type SurfaceExpression,
} from "../functional.ts";

let device: GPUDevice | undefined;
let compiler: GpuCompiler | undefined;
let evaluator: GpuEvaluator | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  compiler = await GpuCompiler.create(device);
  evaluator = await GpuEvaluator.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  compiler = undefined;
  evaluator = undefined;
});

Deno.test("mutually recursive local functions retain lexical captures", async () => {
  const decrement = (name: string): SurfaceExpression =>
    surface.binary(
      BinaryOperator.Subtract,
      surface.name(name),
      surface.integer(1),
    );
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: {
        kind: "let",
        name: "captured",
        value: surface.integer(42),
        body: {
          kind: "let-rec-group",
          bindings: [
            {
              name: "even",
              parameters: ["value"],
              body: {
                kind: "if",
                condition: surface.equal(surface.name("value"), surface.integer(0)),
                consequent: surface.name("captured"),
                alternate: surface.apply(surface.name("odd"), decrement("value")),
              },
            },
            {
              name: "odd",
              parameters: ["value"],
              body: {
                kind: "if",
                condition: surface.equal(surface.name("value"), surface.integer(0)),
                consequent: surface.integer(0),
                alternate: surface.apply(surface.name("even"), decrement("value")),
              },
            },
          ],
          body: surface.apply(surface.name("even"), surface.integer(12)),
        },
      },
    }],
    [],
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );

  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const execution = await functionalEvaluator().evaluate(compilation.module);
    ok(execution.ok, "GPU evaluation failed");
    if (!execution.ok) return;
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("nested recursive groups preserve source order through GPU compilation", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      span: { startByte: 0, endByte: 30 },
      body: {
        kind: "let-rec-group",
        bindings: [{
          name: "outer",
          parameters: [],
          span: { startByte: 10, endByte: 30 },
          body: {
            kind: "let-rec-group",
            bindings: [{
              name: "inner",
              parameters: [],
              body: surface.integer(42),
              span: { startByte: 20, endByte: 25 },
            }],
            body: surface.name("inner"),
            span: { startByte: 20, endByte: 25 },
          },
        }],
        body: surface.name("outer"),
        span: { startByte: 10, endByte: 30 },
      },
    }],
    [],
    "main",
    30,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );

  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const execution = await functionalEvaluator().evaluate(compilation.module);
    ok(execution.ok, "GPU evaluation failed");
    if (!execution.ok) return;
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("explicit thunk delays work and memoizes its first force", async () => {
  const once = await compileAndRunThunkModule(false);
  const twice = await compileAndRunThunkModule(true);

  deepStrictEqual(once.value, { kind: "integer", value: 21 });
  deepStrictEqual(twice.value, { kind: "integer", value: 42 });
  equal(twice.stats.thunkEvaluations, once.stats.thunkEvaluations);
});

async function compileAndRunThunkModule(forceTwice: boolean) {
  const forced = surface.force(surface.name("shared"));
  const result = forceTwice ? surface.binary(BinaryOperator.Add, forced, forced) : forced;
  const body: SurfaceExpression = {
    kind: "let",
    name: "unused",
    value: surface.delay(
      surface.binary(
        BinaryOperator.Divide,
        surface.integer(1),
        surface.integer(0),
      ),
    ),
    body: {
      kind: "let",
      name: "shared",
      value: surface.delay(
        surface.binary(
          BinaryOperator.Add,
          surface.integer(20),
          surface.integer(1),
        ),
      ),
      body: result,
    },
  };
  const module = buildSurfaceModule(
    [{
      name: "declaredThunk",
      parameters: [],
      annotation: functionalThunkType({ kind: "integer" }),
      body: surface.delay(surface.integer(5)),
    }, { name: "main", parameters: [], annotation: null, body }],
    [],
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("explicit thunk module did not compile");
  try {
    const execution = await functionalEvaluator().evaluate(compilation.module);
    if (!execution.ok) throw new Error("explicit thunk module did not evaluate");
    return execution;
  } finally {
    compilation.module.destroy();
  }
}
function functionalCompiler(): GpuCompiler {
  if (compiler === undefined) throw new Error("functional compiler was not initialized");
  return compiler;
}

function functionalEvaluator(): GpuEvaluator {
  if (evaluator === undefined) throw new Error("functional evaluator was not initialized");
  return evaluator;
}
