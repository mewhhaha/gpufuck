import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";

import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  type EncodedFunctionalModule,
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  type FunctionalSurfaceExpression,
  FunctionalWasmRuntimeError,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../functional.ts";
import { lowerHaskellFunctionalSource } from "../haskell_functional.ts";
import { lowerOcamlFunctionalSource } from "../ocaml_functional.ts";
import { lowerRustFunctionalSource } from "../rust_functional.ts";

interface FunctionalWasmRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly evaluator: GpuFunctionalEvaluator;
}

let runtime: FunctionalWasmRuntime | undefined;

Deno.test.beforeAll(async () => {
  const device = await requestWebGpuDevice();
  const [compiler, evaluator] = await Promise.all([
    GpuFunctionalCompiler.create(device),
    GpuFunctionalEvaluator.create(device),
  ]);
  runtime = { device, compiler, evaluator };
});

Deno.test.afterAll(() => {
  runtime?.device.destroy();
  runtime = undefined;
});

Deno.test("runs every checked-in Rust program through GPU compilation and WebAssembly", async () => {
  for (
    const [path, expected] of [
      ["examples/rust-functional/option_map.rs", 42],
      ["examples/rust-functional/point.rs", 2_022],
      ["examples/rust-functional/factorial.rs", 120],
      ["examples/rust-functional/tuple.rs", 42],
    ] as const
  ) {
    await assertWasmMatchesGpu(loweredRustModule(await Deno.readTextFile(path)), expected, path);
  }
});

Deno.test("runs every checked-in Haskell program through GPU compilation and WebAssembly", async () => {
  for (
    const fileName of [
      "option_map.hs",
      "tuple.hs",
      "tree.hs",
      "combinators.hs",
      "list.hs",
      "result.hs",
      "reader.hs",
      "state.hs",
      "dictionary.hs",
      "lambda_list.hs",
      "gadt.hs",
      "records.hs",
      "pattern_guards.hs",
      "classes.hs",
    ]
  ) {
    const path = `examples/haskell-functional/${fileName}`;
    await assertWasmMatchesGpu(loweredHaskellModule(await Deno.readTextFile(path)), 42, path);
  }
  const factorialPath = "examples/haskell-functional/factorial.hs";
  await assertWasmMatchesGpu(
    loweredHaskellModule(await Deno.readTextFile(factorialPath)),
    120,
    factorialPath,
  );
});

Deno.test("runs every checked-in OCaml program through GPU compilation and WebAssembly", async () => {
  for (const fileName of ["option_map.ml", "tuple.ml", "list.ml", "tree.ml"]) {
    const path = `examples/ocaml-functional/${fileName}`;
    await assertWasmMatchesGpu(loweredOcamlModule(await Deno.readTextFile(path)), 42, path);
  }
  const factorialPath = "examples/ocaml-functional/factorial.ml";
  await assertWasmMatchesGpu(
    loweredOcamlModule(await Deno.readTextFile(factorialPath)),
    120,
    factorialPath,
  );
});

Deno.test("decodes scalar WebAssembly results with wrapping integer division", async () => {
  const cases = [
    {
      expression: surface.boolean(true),
      expected: { kind: "boolean", value: true } as const,
    },
    {
      expression: surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
      expected: { kind: "unit" } as const,
    },
    {
      expression: surface.binary(
        FunctionalBinaryOperator.Divide,
        surface.integer(-2_147_483_648),
        surface.integer(-1),
      ),
      expected: { kind: "integer", value: -2_147_483_648 } as const,
    },
  ];
  for (const [index, testCase] of cases.entries()) {
    const module = buildFunctionalSurfaceModule(
      [{ name: "main", parameters: [], annotation: null, body: testCase.expression }],
      [],
      "main",
      0,
    );
    const compilation = await functionalWasmRuntime().compiler.compileModule(module);
    ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
    if (!compilation.ok) throw new Error(`scalar WASM case ${index} did not compile`);
    try {
      const oracle = await functionalWasmRuntime().evaluator.evaluate(compilation.module);
      ok(oracle.ok, oracle.ok ? undefined : oracle.fault.message);
      if (!oracle.ok) throw new Error(`scalar WASM case ${index} did not evaluate on the GPU`);
      deepStrictEqual(oracle.value, testCase.expected);
      const execution = await runFunctionalWasmModule(compilation.module);
      deepStrictEqual(execution.value, testCase.expected);
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("passes immutable values and host operations to main through init", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(hostInitModule(
    surface.apply(
      surface.name("observe"),
      surface.apply(surface.name("increment"), surface.name("base")),
    ),
  ));
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("host init module did not compile");
  const observed: number[] = [];
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Environment: {
          base: { kind: "integer", value: 40 },
          increment: (argument) => ({
            kind: "integer",
            value: argument.kind === "integer" ? argument.value + 1 : 0,
          }),
          observe: (argument) => {
            if (argument.kind === "integer") observed.push(argument.value);
            return argument;
          },
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 41 });
    deepStrictEqual(observed, [41]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("preserves frontend-demanded order for effectful host operations", async () => {
  const expression = surface.binary(
    FunctionalBinaryOperator.Add,
    surface.apply(surface.name("observe"), surface.integer(1)),
    surface.apply(surface.name("observe"), surface.integer(2)),
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    hostInitModule(expression),
  );
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("ordered host operation module did not compile");
  const observed: number[] = [];
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Environment: {
          base: { kind: "integer", value: 0 },
          increment: (argument) => argument,
          observe: (argument) => {
            if (argument.kind === "integer") observed.push(argument.value);
            return argument;
          },
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 3 });
    deepStrictEqual(observed, [1, 2]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("sequences unit-returning host effects through an explicit demand", async () => {
  const module = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["init"],
      annotation: null,
      body: {
        kind: "case",
        value: surface.name("init"),
        arms: [{
          constructor: FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
          binders: ["write"],
          body: {
            kind: "case",
            value: surface.apply(surface.name("write"), surface.integer(7)),
            arms: [{
              constructor: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
              binders: [],
              body: surface.integer(42),
            }],
          },
        }],
      },
    }],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Console",
        fields: [{
          kind: "operation",
          name: "write",
          purity: "effectful",
          parameter: { kind: "integer" },
          result: { kind: "unit" },
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("unit host effect module did not compile");
  const observed: number[] = [];
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Console: {
          write: (argument) => {
            if (argument.kind === "integer") observed.push(argument.value);
            return { kind: "unit" };
          },
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
    deepStrictEqual(observed, [7]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("rejects missing and ill-typed init fields before WebAssembly execution", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    hostInitModule(surface.name("base")),
  );
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("host boundary module did not compile");
  try {
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      /requires init capabilities \["Environment"\]/,
    );
    await rejects(
      () =>
        runFunctionalWasmModule(compilation.module, {
          init: {
            Environment: {
              base: { kind: "boolean", value: true },
              increment: (argument) => argument,
              observe: (argument) => argument,
            },
          },
        }),
      /host field "Environment\.base" expected integer; received object with kind "boolean"/,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("leaves unused lets, arguments, branches, and constructor fields unevaluated", async () => {
  const divisionByZero = (): FunctionalSurfaceExpression =>
    surface.binary(FunctionalBinaryOperator.Divide, surface.integer(1), surface.integer(0));
  const lazyExpressions: readonly FunctionalSurfaceExpression[] = [
    {
      kind: "let",
      name: "unused",
      value: divisionByZero(),
      body: surface.integer(42),
    },
    surface.apply(surface.lambda("unused", surface.integer(42)), divisionByZero()),
    {
      kind: "if",
      condition: surface.boolean(true),
      consequent: surface.integer(42),
      alternate: divisionByZero(),
    },
  ];
  for (const [index, expression] of lazyExpressions.entries()) {
    await assertLazyWasmResult(singleDefinitionModule(expression), 42, 1, `lazy case ${index}`);
  }

  const lazyFieldModule = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: {
        kind: "case",
        value: surface.apply(surface.name("Box"), divisionByZero()),
        arms: [{ constructor: "Box", binders: ["unused"], body: surface.integer(42) }],
      },
    }],
    [{
      name: "BoxType",
      parameters: [],
      constructors: [{
        name: "Box",
        fields: [{ name: "value", type: { kind: "integer" } }],
      }],
    }],
    "main",
    0,
  );
  await assertLazyWasmResult(lazyFieldModule, 42, 1, "lazy constructor field");
});

Deno.test("preserves Haskell non-strictness for an unused recursive argument", async () => {
  const module = loweredHaskellModule(`module LazyArgument where
loop :: Int
loop = loop
ignore :: Int -> Int
ignore value = 42
gpuMain = ignore loop
`);

  await assertLazyWasmResult(module, 42, 1, "unused recursive Haskell argument");
});

Deno.test("evaluates a shared thunk once and reuses its cached value", async () => {
  const sharedValue: FunctionalSurfaceExpression = {
    kind: "let",
    name: "shared",
    value: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(40),
      surface.integer(2),
    ),
    body: {
      kind: "if",
      condition: surface.boolean(true),
      consequent: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.name("shared"),
        surface.name("shared"),
      ),
      alternate: surface.integer(0),
    },
  };

  await assertLazyWasmResult(singleDefinitionModule(sharedValue), 84, 2, "shared local thunk");
});

Deno.test("eliminates a thunk when demand analysis proves an immediate force", async () => {
  const strictBinding: FunctionalSurfaceExpression = {
    kind: "let",
    name: "answer",
    value: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(40),
      surface.integer(2),
    ),
    body: surface.name("answer"),
  };

  await assertLazyWasmResult(singleDefinitionModule(strictBinding), 42, 1, "strict local binding");
});

Deno.test("traps a recursively forced thunk as a blackhole", async () => {
  const module = buildFunctionalSurfaceModule(
    [
      {
        name: "loop",
        parameters: [],
        annotation: { kind: "integer" },
        body: surface.name("loop"),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "integer" },
        body: surface.name("loop"),
      },
    ],
    [],
    "main",
    0,
  );
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("blackhole module did not compile");
  try {
    const oracle = await evaluator.evaluate(compilation.module);
    equal(oracle.ok, false);
    if (oracle.ok) throw new Error("GPU oracle unexpectedly evaluated a cyclic thunk");
    equal(oracle.fault.kind, "blackhole");
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      (error) => {
        ok(error instanceof FunctionalWasmRuntimeError);
        equal(error.kind, "blackhole");
        equal(error.entryDefinition, compilation.module.entryDefinition);
        ok(error.cause instanceof WebAssembly.RuntimeError);
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

function singleDefinitionModule(expression: FunctionalSurfaceExpression): EncodedFunctionalModule {
  return buildFunctionalSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body: expression }],
    [],
    "main",
    0,
  );
}

function hostInitModule(expression: FunctionalSurfaceExpression): EncodedFunctionalModule {
  return buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["init"],
      annotation: null,
      body: {
        kind: "case",
        value: surface.name("init"),
        arms: [{
          constructor: FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
          binders: ["base", "increment", "observe"],
          body: expression,
        }],
      },
    }],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Environment",
        fields: [
          { kind: "value", name: "base", type: { kind: "integer" } },
          {
            kind: "operation",
            name: "increment",
            purity: "pure",
            parameter: { kind: "integer" },
            result: { kind: "integer" },
          },
          {
            kind: "operation",
            name: "observe",
            purity: "effectful",
            parameter: { kind: "integer" },
            result: { kind: "integer" },
          },
        ],
      }],
    },
  );
}

async function assertLazyWasmResult(
  module: EncodedFunctionalModule,
  expectedValue: number,
  expectedThunkEvaluations: number,
  context: string,
): Promise<void> {
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error(`${context} did not compile`);
  try {
    const oracle = await evaluator.evaluate(compilation.module);
    ok(oracle.ok, oracle.ok ? undefined : oracle.fault.message);
    if (!oracle.ok) throw new Error(`${context} did not evaluate on the GPU`);
    deepStrictEqual(oracle.value, { kind: "integer", value: expectedValue });

    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: expectedValue });
    equal(execution.stats.thunkEvaluations, expectedThunkEvaluations, context);
  } finally {
    compilation.module.destroy();
  }
}

async function assertWasmMatchesGpu(
  module: EncodedFunctionalModule,
  expected: number,
  sourcePath: string,
) {
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional example did not compile on the GPU");
  try {
    const gpuEvaluation = await evaluator.evaluate(compilation.module);
    ok(gpuEvaluation.ok, gpuEvaluation.ok ? undefined : gpuEvaluation.fault.message);
    if (!gpuEvaluation.ok) throw new Error("functional example did not evaluate on the GPU");
    deepStrictEqual(
      gpuEvaluation.value,
      { kind: "integer", value: expected },
      `${sourcePath} returned a different GPU value`,
    );

    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    equal(WebAssembly.validate(bytes), true, `${sourcePath} emitted invalid WebAssembly`);
    const instantiated = await WebAssembly.instantiate(bytes);
    const main = instantiated.instance.exports.main;
    equal(typeof main, "function");
    equal((main as () => number)(), expected, `${sourcePath} returned a different WASM value`);
  } finally {
    compilation.module.destroy();
  }
}

function loweredRustModule(source: string): EncodedFunctionalModule {
  const result = lowerRustFunctionalSource(source);
  ok(result.ok, result.ok ? undefined : result.diagnostics[0].message);
  if (!result.ok) throw new Error("Rust example did not lower");
  return result.lowered.module;
}

function loweredHaskellModule(source: string): EncodedFunctionalModule {
  const result = lowerHaskellFunctionalSource(source);
  ok(result.ok, result.ok ? undefined : result.diagnostics[0].message);
  if (!result.ok) throw new Error("Haskell example did not lower");
  return result.lowered.module;
}

function loweredOcamlModule(source: string): EncodedFunctionalModule {
  const result = lowerOcamlFunctionalSource(source);
  ok(result.ok, result.ok ? undefined : result.diagnostics[0].message);
  if (!result.ok) throw new Error("OCaml example did not lower");
  return result.lowered.module;
}

function functionalWasmRuntime(): FunctionalWasmRuntime {
  if (runtime === undefined) throw new Error("functional WASM test runtime was not initialized");
  return runtime;
}
