import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";

import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalConstraintElaborator,
  functionalEffectOperationsFromRow,
  FunctionalEvaluationProfile,
  functionalExistentialType,
  FunctionalPersistentSharing,
  functionalRecordConstructorName,
  functionalRowTypeDeclaration,
  FunctionalStorageClass,
  FunctionalStorageCoreError,
  type FunctionalSurfaceExpression,
  functionalThunkType,
  functionalVariantConstructorName,
  GpuFunctionalCompiler,
  packFunctionalExistential,
  planFunctionalModuleStorage,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
  unifyFunctionalRows,
  unpackFunctionalExistential,
} from "../functional.ts";

let device: GPUDevice | undefined;
let compiler: GpuFunctionalCompiler | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  compiler = await GpuFunctionalCompiler.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  compiler = undefined;
});

Deno.test("mutually recursive local functions retain lexical captures", async () => {
  const decrement = (name: string): FunctionalSurfaceExpression =>
    surface.binary(
      FunctionalBinaryOperator.Subtract,
      surface.name(name),
      surface.integer(1),
    );
  const module = buildFunctionalSurfaceModule(
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
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );

  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("storage planning separates static, scalar-local, and recursive closures", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "identity",
      parameters: ["value"],
      annotation: null,
      body: surface.name("value"),
    }, {
      name: "main",
      parameters: [],
      annotation: null,
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
        body: {
          kind: "let-rec",
          name: "countdown",
          value: surface.lambda("value", {
            kind: "if",
            condition: surface.equal(surface.name("value"), surface.integer(0)),
            consequent: surface.apply(surface.name("increment"), surface.integer(41)),
            alternate: surface.apply(
              surface.name("countdown"),
              surface.binary(
                FunctionalBinaryOperator.Subtract,
                surface.name("value"),
                surface.integer(1),
              ),
            ),
          }),
          body: surface.apply(surface.name("countdown"), surface.integer(2)),
        },
      },
    }],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const plan = await planFunctionalModuleStorage(compilation.module);
    equal(plan.verification.ok, true);
    equal(plan.core.persistentSharing, FunctionalPersistentSharing.Reject);
    const closures = plan.values.filter((value) => value.valueKind === "closure");
    ok(closures.some((value) => value.storage === FunctionalStorageClass.Static));
    ok(closures.some((value) =>
      value.storage === FunctionalStorageClass.ScalarLocal &&
      value.escapeStorage === FunctionalStorageClass.InvocationArena
    ));
    ok(closures.some((value) => value.storage === FunctionalStorageClass.InvocationArena));
    ok(plan.summary.staticValues >= 1);
    ok(plan.summary.scalarLocalValues >= 1);
    ok(plan.summary.invocationArenaValues >= 1);
    equal(plan.summary.automaticArenaReset, false);
    ok(plan.references.length >= 1);
    const coreReferences = new Set(
      plan.core.operations.flatMap((operation) =>
        operation.kind === "reference" ? [`${operation.owner}->${operation.target}`] : []
      ),
    );
    for (const reference of plan.references) {
      ok(coreReferences.has(`${reference.owner}->${reference.target}`));
    }
    const firstReference = plan.core.operations.find((operation) => operation.kind === "reference");
    if (firstReference === undefined) throw new Error("storage plan omitted capture references");
    await rejects(
      () =>
        compileFunctionalModuleToWasm(compilation.module, {
          storageCore: {
            persistentSharing: plan.core.persistentSharing,
            operations: plan.core.operations.filter((operation) => operation !== firstReference),
          },
        }),
      /omits required reference/,
    );
    await rejects(
      () =>
        compileFunctionalModuleToWasm(compilation.module, {
          storageCore: {
            persistentSharing: plan.core.persistentSharing,
            operations: [
              ...plan.core.operations,
              { kind: "enter-arena", arena: "forgotten" },
            ],
          },
        }),
      (error) => error instanceof FunctionalStorageCoreError && error.code === "F6006",
    );

    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("storage planning preserves frontend-selected host ownership contracts", async () => {
  const integer = { kind: "integer" } as const;
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["init"],
      annotation: null,
      body: {
        kind: "case",
        value: surface.name("init"),
        arms: [{
          constructor: FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
          binders: ["seed", "echo"],
          body: surface.name("seed"),
        }],
      },
    }],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Runtime",
        fields: [{
          kind: "value",
          name: "seed",
          type: integer,
          ownership: "ownership-transfer",
        }, {
          kind: "operation",
          name: "echo",
          purity: "pure",
          parameter: integer,
          result: integer,
          parameterOwnership: "bounded-borrow",
          resultOwnership: "frozen-shareable",
        }],
      }],
    },
  );
  const compilation = await functionalCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const plan = await planFunctionalModuleStorage(compilation.module);
    deepStrictEqual(
      plan.boundaries.map((boundary) => ({
        path: boundary.path,
        direction: boundary.direction,
        storage: boundary.storage,
      })),
      [{
        path: "Runtime.seed",
        direction: "host-to-module",
        storage: FunctionalStorageClass.Owned,
      }, {
        path: "Runtime.echo.parameter",
        direction: "module-to-host",
        storage: FunctionalStorageClass.InvocationArena,
      }, {
        path: "Runtime.echo.result",
        direction: "host-to-module",
        storage: FunctionalStorageClass.HostManaged,
      }],
    );
    equal(plan.summary.ownedBoundaries, 1);
    equal(plan.summary.hostManagedBoundaries, 1);
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

Deno.test("existential packages hide their witness while exposing payload operations", async () => {
  const hiddenType = { kind: "parameter", name: "hidden" } as const;
  const existential = {
    parameters: ["hidden"],
    payload: hiddenType,
    result: { kind: "integer" },
  } as const;
  const packageType = functionalExistentialType(existential);
  const packageExpression = packFunctionalExistential(
    surface.integer(41),
    "hidden",
    surface.binary(
      FunctionalBinaryOperator.Add,
      surface.name("hidden"),
      surface.integer(1),
    ),
  );
  const module = buildFunctionalSurfaceModule(
    [
      {
        name: "package",
        parameters: [],
        annotation: packageType,
        body: packageExpression,
      },
      {
        name: "main",
        parameters: [],
        annotation: null,
        body: unpackFunctionalExistential(surface.name("package")),
      },
    ],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );

  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("existential packages reject a hidden witness in their result", () => {
  const hiddenType = { kind: "parameter", name: "hidden" } as const;
  let message = "";
  try {
    functionalExistentialType({
      parameters: ["hidden"],
      payload: hiddenType,
      result: hiddenType,
    });
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  equal(message, 'functional existential result exposes hidden parameter "hidden"');
});

Deno.test("higher-kinded constraint goals insert resolved runtime evidence", async () => {
  const elaborator = new FunctionalConstraintElaborator(
    {
      constructors: [{ name: "List", parameterKinds: [{ kind: "type" }] }],
      functions: [{
        name: "Twice",
        parameters: [
          {
            name: "constructor",
            kind: {
              kind: "constructor",
              parameter: { kind: "type" },
              result: { kind: "type" },
            },
          },
          { name: "value", kind: { kind: "type" } },
        ],
        resultKind: { kind: "type" },
        body: {
          kind: "apply",
          constructor: { kind: "reference", name: "constructor" },
          argument: {
            kind: "apply",
            constructor: { kind: "reference", name: "constructor" },
            argument: { kind: "reference", name: "value" },
          },
        },
      }],
    },
    [{
      id: "measure-nested-list",
      predicate: "measure",
      inputs: [{
        kind: "type",
        type: {
          kind: "named",
          name: "List",
          arguments: [{
            kind: "type",
            type: {
              kind: "named",
              name: "List",
              arguments: [{ kind: "type", type: { kind: "variable", name: "element" } }],
            },
          }],
        },
      }],
      outputs: [],
      premises: [],
      witness: { kind: "runtime-dictionary", symbol: "measureNestedList" },
    }],
  );
  const call = elaborator.elaborateCall(
    surface.name("useMeasure"),
    [],
    [{
      predicate: "measure",
      inputs: [{
        kind: "apply",
        constructor: {
          kind: "apply",
          constructor: { kind: "reference", name: "Twice" },
          argument: { kind: "reference", name: "List" },
        },
        argument: { kind: "integer" },
      }],
    }],
  );
  ok(call.ok, call.ok ? undefined : call.failure.message);
  if (!call.ok) return;
  const module = buildFunctionalSurfaceModule(
    [
      {
        name: "measureNestedList",
        parameters: ["unit"],
        annotation: null,
        body: surface.integer(42),
      },
      {
        name: "useMeasure",
        parameters: ["measure"],
        annotation: null,
        body: surface.apply(surface.name("measure"), surface.name("$Unit")),
      },
      { name: "main", parameters: [], annotation: null, body: call.expression },
    ],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("constraint elaboration shares one exact transition budget", () => {
  const elaborator = new FunctionalConstraintElaborator(
    { constructors: [], functions: [] },
    [],
  );
  const result = elaborator.resolve(
    { predicate: "missing", inputs: [{ kind: "integer" }] },
    { maximumTransitions: 1 },
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.failure.kind, "out-of-fuel");
  equal(result.transitions, 1);
});

Deno.test("open rows infer missing fields with a reusable tail substitution", () => {
  const integer = { kind: "integer" } as const;
  const boolean = { kind: "boolean" } as const;
  const result = unifyFunctionalRows(
    {
      kind: "record",
      fields: [{ label: "value", type: integer }],
      tail: "rest",
    },
    {
      kind: "record",
      fields: [
        { label: "enabled", type: boolean },
        { label: "value", type: integer },
      ],
      tail: null,
    },
  );

  ok(result.ok, result.ok ? undefined : result.message);
  if (!result.ok) return;
  deepStrictEqual(result.row, {
    kind: "record",
    fields: [
      { label: "enabled", type: boolean },
      { label: "value", type: integer },
    ],
    tail: null,
  });
  deepStrictEqual(result.substitution, [{
    variable: "rest",
    row: {
      kind: "record",
      fields: [{ label: "enabled", type: boolean }],
      tail: null,
    },
  }]);
});

Deno.test("row unification reports its exact transition boundary", () => {
  const result = unifyFunctionalRows(
    {
      kind: "variant",
      fields: [{ label: "value", type: { kind: "integer" } }],
      tail: null,
    },
    {
      kind: "variant",
      fields: [{ label: "value", type: { kind: "integer" } }],
      tail: null,
    },
    { maximumTransitions: 1 },
  );

  equal(result.ok, false);
  if (result.ok) return;
  equal(result.kind, "out-of-fuel");
  equal(result.transitions, 1);
});

Deno.test("row declarations retain free field type parameters", () => {
  const declaration = functionalRowTypeDeclaration("Box", {
    kind: "record",
    fields: [{ label: "value", type: { kind: "parameter", name: "value" } }],
    tail: null,
  });

  deepStrictEqual(declaration.parameters, ["value"]);
});

Deno.test("closed record and variant rows lower to executable nominal types", async () => {
  const integer = { kind: "integer" } as const;
  const boolean = { kind: "boolean" } as const;
  const recordName = "Result";
  const variantName = "Choice";
  const recordConstructor = functionalRecordConstructorName(recordName);
  const answerConstructor = functionalVariantConstructorName(variantName, "answer");
  const disabledConstructor = functionalVariantConstructorName(variantName, "disabled");
  const declarations = [
    functionalRowTypeDeclaration(recordName, {
      kind: "record",
      fields: [
        { label: "enabled", type: boolean },
        { label: "value", type: integer },
      ],
      tail: null,
    }),
    functionalRowTypeDeclaration(variantName, {
      kind: "variant",
      fields: [
        { label: "answer", type: integer },
        { label: "disabled", type: boolean },
      ],
      tail: null,
    }),
  ];
  const resultExpression = (
    enabled: FunctionalSurfaceExpression,
    value: FunctionalSurfaceExpression,
  ) => surface.apply(surface.name(recordConstructor), enabled, value);
  const selectedResult: FunctionalSurfaceExpression = {
    kind: "case",
    value: surface.apply(surface.name(answerConstructor), surface.integer(42)),
    arms: [
      {
        constructor: answerConstructor,
        binders: ["answer"],
        body: resultExpression(surface.boolean(true), surface.name("answer")),
      },
      {
        constructor: disabledConstructor,
        binders: ["disabled"],
        body: resultExpression(surface.name("disabled"), surface.integer(0)),
      },
    ],
  };
  const executable = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(surface.name("readResult"), selectedResult),
    }, {
      name: "readResult",
      parameters: ["result"],
      annotation: null,
      body: {
        kind: "case",
        value: surface.name("result"),
        arms: [{
          constructor: recordConstructor,
          binders: ["enabled", "value"],
          body: {
            kind: "if",
            condition: surface.name("enabled"),
            consequent: surface.name("value"),
            alternate: surface.integer(0),
          },
        }],
      },
    }],
    declarations,
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );

  const compilation = await functionalCompiler().compileModule(executable);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("effect rows lower through the shared row representation", () => {
  const operations = functionalEffectOperationsFromRow("Console", {
    kind: "effect",
    fields: [{
      label: "read",
      type: {
        kind: "function",
        parameter: { kind: "unit" },
        result: { kind: "integer" },
      },
    }, {
      label: "write",
      type: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "unit" },
      },
    }],
    tail: null,
  });

  deepStrictEqual(operations, [{
    effect: "Console",
    name: "read",
    parameter: { kind: "unit" },
    result: { kind: "integer" },
  }, {
    effect: "Console",
    name: "write",
    parameter: { kind: "integer" },
    result: { kind: "unit" },
  }]);
});

async function compileAndRunThunkModule(forceTwice: boolean) {
  const forced = surface.force(surface.name("shared"));
  const result = forceTwice ? surface.binary(FunctionalBinaryOperator.Add, forced, forced) : forced;
  const body: FunctionalSurfaceExpression = {
    kind: "let",
    name: "unused",
    value: surface.delay(
      surface.binary(
        FunctionalBinaryOperator.Divide,
        surface.integer(1),
        surface.integer(0),
      ),
    ),
    body: {
      kind: "let",
      name: "shared",
      value: surface.delay(
        surface.binary(
          FunctionalBinaryOperator.Add,
          surface.integer(20),
          surface.integer(1),
        ),
      ),
      body: result,
    },
  };
  const module = buildFunctionalSurfaceModule(
    [{
      name: "declaredThunk",
      parameters: [],
      annotation: functionalThunkType({ kind: "integer" }),
      body: surface.delay(surface.integer(5)),
    }, { name: "main", parameters: [], annotation: null, body }],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("explicit thunk module did not compile");
  try {
    return await runFunctionalWasmModule(compilation.module);
  } finally {
    compilation.module.destroy();
  }
}

function functionalCompiler(): GpuFunctionalCompiler {
  if (compiler === undefined) throw new Error("functional compiler was not initialized");
  return compiler;
}
