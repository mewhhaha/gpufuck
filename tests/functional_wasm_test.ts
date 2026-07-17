import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";

import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  type EncodedFunctionalModule,
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationMode,
  FunctionalEvaluationProfile,
  type FunctionalSurfaceExpression,
  type FunctionalWasmExecution,
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

Deno.test("passes unit host values through the shared nullary constructor", async () => {
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
          binders: ["ready"],
          body: {
            kind: "case",
            value: surface.name("ready"),
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
        name: "Environment",
        fields: [{ kind: "value", name: "ready", type: { kind: "unit" } }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("unit host value module did not compile");
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: { Environment: { ready: { kind: "unit" } } },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
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
    { evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed },
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

Deno.test("strict evaluation faults on an unused function argument", async () => {
  const divisionByZero = surface.binary(
    FunctionalBinaryOperator.Divide,
    surface.integer(1),
    surface.integer(0),
  );
  const module = singleDefinitionModule(
    surface.apply(surface.lambda("unused", surface.integer(42)), divisionByZero),
    FunctionalEvaluationProfile.StrictEager,
  );
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("strict argument module did not compile");
  try {
    equal(compilation.module.evaluationProfile, FunctionalEvaluationProfile.StrictEager);
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes[0]?.evaluationMode, FunctionalEvaluationMode.StrictEager);
    const gpuExecution = await evaluator.evaluate(compilation.module);
    equal(gpuExecution.ok, false);
    if (gpuExecution.ok) throw new Error("GPU evaluator skipped a strict argument");
    equal(gpuExecution.fault.kind, "divide-by-zero");
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      WebAssembly.RuntimeError,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("strict evaluation faults on an unused local binding", async () => {
  const expression: FunctionalSurfaceExpression = {
    kind: "let",
    name: "unused",
    value: surface.binary(
      FunctionalBinaryOperator.Divide,
      surface.integer(1),
      surface.integer(0),
    ),
    body: surface.integer(42),
  };
  const module = singleDefinitionModule(
    expression,
    FunctionalEvaluationProfile.StrictEager,
  );
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("strict local binding module did not compile");
  try {
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes[0]?.evaluationMode, FunctionalEvaluationMode.StrictEager);
    const gpuExecution = await evaluator.evaluate(compilation.module);
    equal(gpuExecution.ok, false);
    if (gpuExecution.ok) throw new Error("GPU evaluator skipped a strict local binding");
    equal(gpuExecution.fault.kind, "divide-by-zero");
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      WebAssembly.RuntimeError,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("a lazy argument overrides a strict module default", async () => {
  const expression: FunctionalSurfaceExpression = {
    kind: "apply",
    callee: surface.lambda("unused", surface.integer(42)),
    argument: surface.binary(
      FunctionalBinaryOperator.Divide,
      surface.integer(1),
      surface.integer(0),
    ),
    argumentEvaluation: FunctionalEvaluationProfile.LazyCallByNeed,
  };
  const module = singleDefinitionModule(
    expression,
    FunctionalEvaluationProfile.StrictEager,
  );
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("lazy argument override did not compile");
  try {
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes[0]?.evaluationMode, FunctionalEvaluationMode.LazyCallByNeed);
    const gpuExecution = await evaluator.evaluate(compilation.module);
    ok(gpuExecution.ok, gpuExecution.ok ? undefined : gpuExecution.fault.message);
    if (!gpuExecution.ok) throw new Error("GPU evaluator forced a lazy argument override");
    deepStrictEqual(gpuExecution.value, { kind: "integer", value: 42 });
    const wasmExecution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(wasmExecution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("a lazy numeric loop argument overrides strict profile unboxing", async () => {
  const lazyInitialValue: FunctionalSurfaceExpression = {
    kind: "apply",
    callee: surface.name("choose"),
    argument: surface.binary(
      FunctionalBinaryOperator.Divide,
      surface.integer(1),
      surface.integer(0),
    ),
    argumentEvaluation: FunctionalEvaluationProfile.LazyCallByNeed,
  };
  const expression: FunctionalSurfaceExpression = {
    kind: "let-rec",
    name: "choose",
    value: surface.lambda(
      "unused",
      surface.lambda("remaining", {
        kind: "if",
        condition: surface.equal(surface.name("remaining"), surface.integer(0)),
        consequent: surface.integer(42),
        alternate: surface.apply(
          surface.apply(
            surface.name("choose"),
            surface.binary(
              FunctionalBinaryOperator.Add,
              surface.name("unused"),
              surface.integer(1),
            ),
          ),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      }),
    ),
    body: surface.apply(lazyInitialValue, surface.integer(0)),
  };
  const module = singleDefinitionModule(expression, FunctionalEvaluationProfile.StrictEager);
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("lazy numeric loop argument did not compile");
  try {
    const gpuExecution = await evaluator.evaluate(compilation.module);
    ok(gpuExecution.ok, gpuExecution.ok ? undefined : gpuExecution.fault.message);
    if (!gpuExecution.ok) throw new Error("GPU evaluator forced a lazy numeric loop argument");
    deepStrictEqual(gpuExecution.value, { kind: "integer", value: 42 });
    const wasmExecution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(wasmExecution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("a lazy local binding overrides a strict module default", async () => {
  const expression: FunctionalSurfaceExpression = {
    kind: "let",
    name: "unused",
    value: surface.binary(
      FunctionalBinaryOperator.Divide,
      surface.integer(1),
      surface.integer(0),
    ),
    body: surface.integer(42),
    valueEvaluation: FunctionalEvaluationProfile.LazyCallByNeed,
  };
  const module = singleDefinitionModule(
    expression,
    FunctionalEvaluationProfile.StrictEager,
  );
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("lazy local binding override did not compile");
  try {
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes[0]?.evaluationMode, FunctionalEvaluationMode.LazyCallByNeed);
    const gpuExecution = await evaluator.evaluate(compilation.module);
    ok(gpuExecution.ok, gpuExecution.ok ? undefined : gpuExecution.fault.message);
    if (!gpuExecution.ok) throw new Error("GPU evaluator forced a lazy local binding override");
    deepStrictEqual(gpuExecution.value, { kind: "integer", value: 42 });
    const wasmExecution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(wasmExecution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
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

Deno.test("shares a let-bound suspension with a callee instead of wrapping it", async () => {
  const module = singleDefinitionModule({
    kind: "let",
    name: "shared",
    value: surface.binary(FunctionalBinaryOperator.Add, surface.integer(40), surface.integer(2)),
    body: surface.apply(doubleWithoutImmediateForce(), surface.name("shared")),
  });

  await assertLazyWasmResult(module, 84, 2, "shared local suspension");
});

Deno.test("shares a global suspension with a callee instead of wrapping it", async () => {
  const module = buildFunctionalSurfaceModule(
    [
      {
        name: "shared",
        parameters: [],
        annotation: null,
        body: surface.binary(FunctionalBinaryOperator.Add, surface.integer(40), surface.integer(2)),
      },
      {
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.apply(doubleWithoutImmediateForce(), surface.name("shared")),
      },
    ],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed },
  );

  await assertLazyWasmResult(module, 84, 2, "shared global suspension");
});

Deno.test("omits closure captures that the closure body does not reference", async () => {
  const closure = (body: FunctionalSurfaceExpression): FunctionalSurfaceExpression => ({
    kind: "let",
    name: "outer",
    value: surface.integer(40),
    body: {
      kind: "let",
      name: "function",
      value: surface.lambda("inner", body),
      body: {
        kind: "case",
        value: surface.apply(
          surface.apply(
            surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
            surface.name("function"),
          ),
          surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
        ),
        arms: [{
          constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
          binders: ["storedFunction", "ignored"],
          body: surface.apply(surface.name("storedFunction"), surface.integer(2)),
        }],
      },
    },
  });
  const captured = await runCompiledWasm(singleDefinitionModule(closure(
    surface.binary(
      FunctionalBinaryOperator.Add,
      surface.name("outer"),
      surface.name("inner"),
    ),
  )));
  const pruned = await runCompiledWasm(
    singleDefinitionModule(closure(surface.name("inner"))),
  );

  deepStrictEqual(captured.value, { kind: "integer", value: 42 });
  deepStrictEqual(pruned.value, { kind: "integer", value: 2 });
  equal(captured.stats.allocatedBytes - pruned.stats.allocatedBytes, 8);
  ok(captured.stats.specializedCallSites >= 1);
  ok(pruned.stats.specializedCallSites >= 1);
});

Deno.test("specializes let-bound higher-order functions without allocating closures", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let",
    name: "applyOnce",
    value: surface.lambda(
      "function",
      surface.apply(surface.name("function"), surface.integer(41)),
    ),
    body: {
      kind: "let",
      name: "increment",
      value: surface.lambda(
        "value",
        surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("value"),
          surface.integer(1),
        ),
      ),
      body: surface.apply(surface.name("applyOnce"), surface.name("increment")),
    },
  }));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 24);
  ok(execution.stats.specializedCallSites >= 1);
});

Deno.test("strict higher-order scalar calls omit closures and the lazy runtime", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let",
    name: "applyOnce",
    value: surface.lambda(
      "function",
      surface.apply(surface.name("function"), surface.integer(41)),
    ),
    body: {
      kind: "let",
      name: "increment",
      value: surface.lambda(
        "value",
        surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("value"),
          surface.integer(1),
        ),
      ),
      body: surface.apply(surface.name("applyOnce"), surface.name("increment")),
    },
  }, FunctionalEvaluationProfile.StrictEager));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.thunkEvaluations, 0);
  equal(execution.stats.allocatedBytes, 0);
  equal(
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)).some((entry) =>
      entry.kind === "memory"
    ),
    false,
  );
});

Deno.test("dispatches branch-selected lambda sets with their own captures", async () => {
  const chooseFunction = (condition: boolean): FunctionalSurfaceExpression => ({
    kind: "let",
    name: "offset",
    value: surface.integer(40),
    body: {
      kind: "let",
      name: "function",
      value: {
        kind: "if",
        condition: surface.boolean(condition),
        consequent: surface.lambda(
          "value",
          surface.binary(
            FunctionalBinaryOperator.Add,
            surface.name("value"),
            surface.name("offset"),
          ),
        ),
        alternate: surface.lambda(
          "value",
          surface.binary(
            FunctionalBinaryOperator.Multiply,
            surface.name("value"),
            surface.integer(2),
          ),
        ),
      },
      body: surface.apply(surface.name("function"), surface.integer(2)),
    },
  });

  const selectedCapturedFunction = await runCompiledWasm(
    singleDefinitionModule(chooseFunction(true)),
  );
  const selectedCapturelessFunction = await runCompiledWasm(
    singleDefinitionModule(chooseFunction(false)),
  );

  deepStrictEqual(selectedCapturedFunction.value, { kind: "integer", value: 42 });
  deepStrictEqual(selectedCapturelessFunction.value, { kind: "integer", value: 4 });
  equal(
    selectedCapturedFunction.stats.allocatedBytes -
      selectedCapturelessFunction.stats.allocatedBytes,
    8,
  );
  ok(selectedCapturedFunction.stats.specializedCallSites >= 2);
  ok(selectedCapturelessFunction.stats.specializedCallSites >= 2);
});

Deno.test("omits thunk captures that the suspended expression does not reference", async () => {
  const applySuspension = (argument: FunctionalSurfaceExpression): FunctionalSurfaceExpression => ({
    kind: "let",
    name: "outer",
    value: surface.integer(40),
    body: surface.apply(doubleWithoutImmediateForce(), argument),
  });
  const captured = await runCompiledWasm(singleDefinitionModule(applySuspension(
    surface.binary(FunctionalBinaryOperator.Add, surface.name("outer"), surface.integer(2)),
  )));
  const pruned = await runCompiledWasm(singleDefinitionModule(applySuspension(
    surface.binary(FunctionalBinaryOperator.Add, surface.integer(1), surface.integer(1)),
  )));

  deepStrictEqual(captured.value, { kind: "integer", value: 84 });
  deepStrictEqual(pruned.value, { kind: "integer", value: 4 });
  equal(captured.stats.allocatedBytes - pruned.stats.allocatedBytes, 8);
});

Deno.test("omits a let-rec self capture when the function is not recursive", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let-rec",
    name: "constant",
    value: surface.lambda("ignored", surface.integer(42)),
    body: surface.apply(surface.name("constant"), surface.integer(0)),
  }));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 40);
});

Deno.test("saturated numeric tail recursion uses an uncurried constant-space worker", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let-rec",
    name: "count",
    value: surface.lambda(
      "value",
      surface.lambda("remaining", {
        kind: "if",
        condition: surface.equal(surface.name("remaining"), surface.integer(0)),
        consequent: surface.name("value"),
        alternate: surface.apply(
          surface.apply(
            surface.name("count"),
            surface.binary(
              FunctionalBinaryOperator.Add,
              surface.name("value"),
              surface.integer(1),
            ),
          ),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      }),
    ),
    body: surface.apply(
      surface.apply(
        surface.name("count"),
        surface.binary(
          FunctionalBinaryOperator.Add,
          surface.integer(20),
          surface.integer(22),
        ),
      ),
      surface.integer(4_096),
    ),
  }));

  deepStrictEqual(execution.value, { kind: "integer", value: 4_138 });
  equal(execution.stats.thunkEvaluations, 1);
  equal(execution.stats.allocatedBytes, 48);
  equal(execution.stats.specializedCallSites, 1);
});

Deno.test("strict scalar tail loops omit the lazy WebAssembly runtime", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let-rec",
    name: "count",
    value: surface.lambda(
      "value",
      surface.lambda("remaining", {
        kind: "if",
        condition: surface.equal(surface.name("remaining"), surface.integer(0)),
        consequent: surface.name("value"),
        alternate: surface.apply(
          surface.apply(
            surface.name("count"),
            surface.binary(
              FunctionalBinaryOperator.Add,
              surface.name("value"),
              surface.integer(1),
            ),
          ),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      }),
    ),
    body: surface.apply(
      surface.apply(surface.name("count"), surface.integer(42)),
      surface.integer(4_096),
    ),
  }, FunctionalEvaluationProfile.StrictEager));

  deepStrictEqual(execution.value, { kind: "integer", value: 4_138 });
  equal(execution.stats.thunkEvaluations, 0);
  equal(execution.stats.allocatedBytes, 0);
  equal(execution.stats.specializedCallSites, 1);
  equal(
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)).some((entry) =>
      entry.kind === "memory"
    ),
    false,
  );
  equal((execution.instance.exports.main as () => number)(), 4_138);
});

Deno.test("strict numeric recursive folds run in constant space", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let-rec",
    name: "sum",
    value: surface.lambda("remaining", {
      kind: "if",
      condition: surface.equal(surface.name("remaining"), surface.integer(0)),
      consequent: surface.integer(0),
      alternate: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.name("remaining"),
        surface.apply(
          surface.name("sum"),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      ),
    }),
    body: surface.apply(surface.name("sum"), surface.integer(100_000)),
  }, FunctionalEvaluationProfile.StrictEager));

  deepStrictEqual(execution.value, { kind: "integer", value: 705_082_704 });
  equal(execution.stats.thunkEvaluations, 0);
  equal(execution.stats.allocatedBytes, 0);
  equal(
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)).some((entry) =>
      entry.kind === "memory"
    ),
    false,
  );
});

Deno.test("strict multiplicative recursive folds preserve integer results", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let-rec",
    name: "factorial",
    value: surface.lambda("value", {
      kind: "if",
      condition: surface.equal(surface.name("value"), surface.integer(0)),
      consequent: surface.integer(1),
      alternate: surface.binary(
        FunctionalBinaryOperator.Multiply,
        surface.name("value"),
        surface.apply(
          surface.name("factorial"),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("value"),
            surface.integer(1),
          ),
        ),
      ),
    }),
    body: surface.apply(surface.name("factorial"), surface.integer(12)),
  }, FunctionalEvaluationProfile.StrictEager));

  deepStrictEqual(execution.value, { kind: "integer", value: 479_001_600 });
});

Deno.test("known global tail recursion uses one uncurried worker", async () => {
  const module = buildFunctionalSurfaceModule(
    [
      {
        name: "count",
        parameters: [],
        annotation: null,
        body: surface.lambda(
          "value",
          surface.lambda("remaining", {
            kind: "if",
            condition: surface.equal(surface.name("remaining"), surface.integer(0)),
            consequent: surface.name("value"),
            alternate: surface.apply(
              surface.apply(
                surface.name("count"),
                surface.binary(
                  FunctionalBinaryOperator.Add,
                  surface.name("value"),
                  surface.integer(1),
                ),
              ),
              surface.binary(
                FunctionalBinaryOperator.Subtract,
                surface.name("remaining"),
                surface.integer(1),
              ),
            ),
          }),
        ),
      },
      {
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.apply(
          surface.apply(surface.name("count"), surface.integer(0)),
          surface.integer(4_096),
        ),
      },
    ],
    [],
    "main",
    0,
  );
  const execution = await runCompiledWasm(module);

  deepStrictEqual(execution.value, { kind: "integer", value: 4_096 });
  equal(execution.stats.thunkEvaluations, 0);
  equal(execution.stats.allocatedBytes, 0);
  equal(execution.stats.specializedCallSites, 1);
});

Deno.test("tail-call loops leave an unused recursive argument lazy", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let-rec",
    name: "choose",
    value: surface.lambda(
      "unused",
      surface.lambda("remaining", {
        kind: "if",
        condition: surface.equal(surface.name("remaining"), surface.integer(0)),
        consequent: surface.integer(42),
        alternate: surface.apply(
          surface.apply(
            surface.name("choose"),
            surface.binary(
              FunctionalBinaryOperator.Divide,
              surface.integer(1),
              surface.integer(0),
            ),
          ),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      }),
    ),
    body: surface.apply(
      surface.apply(surface.name("choose"), surface.integer(0)),
      surface.integer(1),
    ),
  }));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.thunkEvaluations, 1);
});

Deno.test("allocator grows memory after lazy loop state crosses its cached limit", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let-rec",
    name: "choose",
    value: surface.lambda(
      "unused",
      surface.lambda("remaining", {
        kind: "if",
        condition: surface.equal(surface.name("remaining"), surface.integer(0)),
        consequent: surface.integer(42),
        alternate: surface.apply(
          surface.apply(
            surface.name("choose"),
            surface.binary(
              FunctionalBinaryOperator.Add,
              surface.name("unused"),
              surface.integer(1),
            ),
          ),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      }),
    ),
    body: surface.apply(
      surface.apply(surface.name("choose"), surface.integer(0)),
      surface.integer(2_500),
    ),
  }));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.thunkEvaluations, 1);
  equal(execution.stats.allocatedBytes, 80_048);
});

Deno.test("immediately applied lambdas allocate no closure", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule(
    surface.apply(
      surface.lambda(
        "value",
        surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("value"),
          surface.integer(1),
        ),
      ),
      surface.integer(41),
    ),
  ));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 24);
});

Deno.test("saturated constructors allocate their result without staged closures", async () => {
  const pair = surface.apply(
    surface.apply(surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME), surface.integer(20)),
    surface.integer(22),
  );
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "case",
    value: pair,
    arms: [{
      constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
      binders: ["left", "right"],
      body: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.name("left"),
        surface.name("right"),
      ),
    }],
  }));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 56);
});

Deno.test("partially applied constructors retain callable staged closures", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let",
    name: "withLeft",
    value: surface.apply(
      surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
      surface.integer(20),
    ),
    body: {
      kind: "case",
      value: surface.apply(surface.name("withLeft"), surface.integer(22)),
      arms: [{
        constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
        binders: ["left", "right"],
        body: surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("left"),
          surface.name("right"),
        ),
      }],
    },
  }));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 80);
});

Deno.test("reuses one nullary constructor object for repeated references", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let",
    name: "first",
    value: surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
    body: {
      kind: "let",
      name: "second",
      value: surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
      body: {
        kind: "case",
        value: surface.name("first"),
        arms: [{
          constructor: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
          binders: [],
          body: {
            kind: "case",
            value: surface.name("second"),
            arms: [{
              constructor: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
              binders: [],
              body: surface.integer(42),
            }],
          },
        }],
      },
    },
  }));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 40);
});

Deno.test("reports zero allocation for an immediate scalar entry", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule(surface.integer(42)));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 0);
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

function doubleWithoutImmediateForce(): FunctionalSurfaceExpression {
  return surface.lambda("value", {
    kind: "if",
    condition: surface.boolean(true),
    consequent: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.name("value"),
      surface.name("value"),
    ),
    alternate: surface.integer(0),
  });
}

async function runCompiledWasm(module: EncodedFunctionalModule): Promise<FunctionalWasmExecution> {
  const { compiler } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional module did not compile on the GPU");
  try {
    return await runFunctionalWasmModule(compilation.module);
  } finally {
    compilation.module.destroy();
  }
}

function singleDefinitionModule(
  expression: FunctionalSurfaceExpression,
  evaluationProfile: FunctionalEvaluationProfile = FunctionalEvaluationProfile.LazyCallByNeed,
): EncodedFunctionalModule {
  return buildFunctionalSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body: expression }],
    [],
    "main",
    0,
    { evaluationProfile },
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
  ok(
    compilation.ok,
    compilation.ok ? undefined : `${sourcePath}: ${compilation.diagnostics[0].message}`,
  );
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
