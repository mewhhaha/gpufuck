import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";

import {
  buildFunctionalSurfaceModule,
  type EncodedFunctionalModule,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalCoreTag,
  FunctionalEvaluationProfile,
  FunctionalExpressionTag,
  type FunctionalIncrementalCache,
  type FunctionalModuleArtifact,
  FunctionalNodeWord,
  type FunctionalSurfaceExpression,
  FunctionalTypecheckingProfile,
  type FunctionalTypeSchema,
  FunctionalWasmIntrinsic,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  IncrementalGpuFunctionalCompiler,
  locateFunctionalDiagnostic,
  lowerFunctionalEffectProgram,
  MemoryFunctionalIncrementalCache,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../functional.ts";
import { GpuLazuliCompiler, lazuliSurfaceToFunctionalModule, parseLazuliSource } from "../mod.ts";

interface FunctionalRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly evaluator: GpuFunctionalEvaluator;
}

let runtime: FunctionalRuntime | undefined;

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

Deno.test("surface type schemas reject structural cycles before encoding", () => {
  const typeArguments: FunctionalTypeSchema[] = [];
  const cyclicType = {
    kind: "named",
    name: "Cycle",
    arguments: typeArguments,
  } as FunctionalTypeSchema;
  typeArguments.push(cyclicType);

  throws(
    () =>
      buildFunctionalSurfaceModule(
        [{ name: "main", parameters: [], annotation: cyclicType, body: surface.integer(0) }],
        [],
        "main",
        0,
      ),
    /definition 0 annotation contains a structural type cycle/,
  );
});

Deno.test("surface module construction rejects malformed options at its boundary", () => {
  throws(
    () =>
      buildFunctionalSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body: surface.integer(0) }],
        [],
        "main",
        0,
        null as unknown as {},
      ),
    /surface module options must be an object/,
  );
});

Deno.test("surface type schemas bound expansion of structurally shared annotations", () => {
  let sharedType: FunctionalTypeSchema = { kind: "integer" };
  for (let depth = 0; depth < 13; depth += 1) {
    sharedType = { kind: "tuple", values: [sharedType, sharedType] };
  }

  throws(
    () =>
      buildFunctionalSurfaceModule(
        [{ name: "main", parameters: [], annotation: sharedType, body: surface.integer(0) }],
        [],
        "main",
        0,
      ),
    /definition 0 annotation exceeds 4096 type nodes/,
  );
});

Deno.test("surface expressions reject structural cycles before encoding", () => {
  const cyclicExpression = {
    kind: "let",
    name: "cycle",
    value: surface.integer(0),
    body: undefined,
  } as unknown as { body: FunctionalSurfaceExpression } & FunctionalSurfaceExpression;
  cyclicExpression.body = cyclicExpression;

  throws(
    () =>
      buildFunctionalSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body: cyclicExpression }],
        [],
        "main",
        0,
      ),
    /surface expression contains a structural cycle/,
  );
});

Deno.test("surface expressions bound expansion of structurally shared trees", () => {
  let sharedExpression: FunctionalSurfaceExpression = surface.integer(1);
  for (let depth = 0; depth < 16; depth += 1) {
    sharedExpression = surface.binary(
      FunctionalBinaryOperator.Add,
      sharedExpression,
      sharedExpression,
    );
  }

  throws(
    () =>
      buildFunctionalSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body: sharedExpression }],
        [],
        "main",
        0,
      ),
    /surface expression exceeds 65536 nodes/,
  );
});

Deno.test("surface encoding handles wide parameter lists without host recursion", () => {
  const parameterCount = 2_048;
  const module = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: Array.from({ length: parameterCount }, (_, index) => `value${index}`),
      annotation: null,
      body: surface.integer(0),
    }],
    [],
    "main",
    0,
  );

  equal(module.nodeCount, parameterCount + 1);
});

Deno.test("surface encoding handles wide case lists without host recursion", () => {
  const armCount = 2_048;
  const module = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: {
        kind: "case",
        value: surface.integer(0),
        arms: Array.from({ length: armCount }, (_, index) => ({
          constructor: `Constructor${index}`,
          binders: [],
          body: surface.integer(index),
        })),
      },
    }],
    [],
    "main",
    0,
  );

  equal(module.nodeCount, 2 + armCount * 2);
});

Deno.test("surface validation bounds application chains created by recursive-group lifting", () => {
  const captureCount = 513;
  const parameters = Array.from({ length: captureCount }, (_, index) => `capture${index}`);

  throws(
    () =>
      buildFunctionalSurfaceModule(
        [{
          name: "main",
          parameters,
          annotation: null,
          body: {
            kind: "let-rec-group",
            bindings: [{
              name: "choice",
              parameters: [],
              body: {
                kind: "case",
                value: surface.integer(0),
                arms: parameters.map((parameter, index) => ({
                  constructor: `Constructor${index}`,
                  binders: [],
                  body: surface.name(parameter),
                })),
              },
            }],
            body: surface.name("choice"),
          },
        }],
        [],
        "main",
        0,
      ),
    /recursive group captures 513 lexical names; maximum is 512/,
  );
});

function functionalRuntime(): FunctionalRuntime {
  if (runtime === undefined) throw new Error("functional test runtime was not initialized");
  return runtime;
}

function integerModule(value: number, entryName = "entry"): EncodedFunctionalModule {
  return {
    abiVersion: FUNCTIONAL_MODULE_ABI_VERSION,
    sourceByteLength: 2,
    evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed,
    typecheckingProfile: FunctionalTypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities: [],
    nodeWords: Uint32Array.of(
      FunctionalExpressionTag.Integer,
      0,
      2,
      value >>> 0,
      FUNCTIONAL_NO_INDEX,
      FUNCTIONAL_NO_INDEX,
      FUNCTIONAL_NO_INDEX,
      FUNCTIONAL_NO_INDEX,
    ),
    definitionWords: Uint32Array.of(0, 0, 0, 2),
    typeWords: new Uint32Array(),
    constructorWords: new Uint32Array(),
    nodeCount: 1,
    definitionCount: 1,
    typeCount: 0,
    constructorCount: 0,
    entrySymbol: 0,
    symbolNames: [entryName],
    definitionTypes: [{ annotation: null }],
    typeDeclarations: [],
  };
}

Deno.test("compiles and evaluates a parser-independent functional module", async () => {
  const { compiler, evaluator } = functionalRuntime();
  const compilation = await compiler.compileModule(integerModule(42, "program_result"));

  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    deepStrictEqual(compilation.module.entryType, { kind: "integer" });
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes.length, 1);
    equal(nodes[0]?.tag, FunctionalCoreTag.Integer);

    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (evaluation.ok) {
      deepStrictEqual(evaluation.value, { kind: "integer", value: 42 });
    }
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("infers and executes target-neutral structural equality", async () => {
  const pair = (left: number, right: number) =>
    surface.apply(
      surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
      surface.integer(left),
      surface.integer(right),
    );
  const module = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.structuralEqual(pair(20, 22), pair(20, 22)),
    }],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const { compiler, evaluator } = functionalRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    deepStrictEqual(compilation.module.entryType, { kind: "boolean" });
    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (evaluation.ok) deepStrictEqual(evaluation.value, { kind: "boolean", value: true });
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "boolean", value: true });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("rejects structural equality between different operand types", async () => {
  const module = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.structuralEqual(surface.integer(42), surface.boolean(true)),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalRuntime().compiler.compileModule(module);
  ok(!compilation.ok);
  if (compilation.ok) return;
  match(compilation.diagnostics[0].message, /expected Int, received Bool/);
});

Deno.test("infers and emits first-class static text and bytes literals", async () => {
  const modules = [
    buildFunctionalSurfaceModule(
      [{ name: "main", parameters: [], annotation: null, body: surface.text("Zażółć 🦆") }],
      [],
      "main",
      0,
    ),
    buildFunctionalSurfaceModule(
      [{
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.bytes(new Uint8Array([0, 127, 128, 255])),
      }],
      [],
      "main",
      0,
    ),
  ];
  const compilations = await functionalRuntime().compiler.compileBatch(modules);
  ok(compilations.every((compilation) => compilation.ok));
  const compiled = compilations.flatMap((compilation) =>
    compilation.ok ? [compilation.module] : []
  );
  try {
    const results = await Promise.all(compiled.map((module) => runFunctionalWasmModule(module)));
    deepStrictEqual(results[0]?.value, { kind: "text", value: "Zażółć 🦆" });
    deepStrictEqual(results[1]?.value, {
      kind: "bytes",
      value: new Uint8Array([0, 127, 128, 255]),
    });
  } finally {
    for (const module of compiled) module.destroy();
  }
});

Deno.test("GPU functional evaluation accepts i64 and f32 inputs", async () => {
  const modules = [
    buildFunctionalSurfaceModule(
      [{
        name: "main",
        parameters: ["input"],
        annotation: null,
        body: surface.binary(
          FunctionalBinaryOperator.AddSignedInteger64,
          surface.name("input"),
          surface.signedInteger64(9n),
        ),
      }],
      [],
      "main",
      10,
    ),
    buildFunctionalSurfaceModule(
      [{
        name: "main",
        parameters: ["input"],
        annotation: null,
        body: surface.binary(
          FunctionalBinaryOperator.MultiplyFloat32,
          surface.name("input"),
          surface.float32(4),
        ),
      }],
      [],
      "main",
      10,
    ),
  ];
  const compilations = await functionalRuntime().compiler.compileBatch(modules);
  ok(compilations.every((compilation) => compilation.ok));
  const compiled = compilations.flatMap((compilation) =>
    compilation.ok ? [compilation.module] : []
  );
  try {
    const results = await functionalRuntime().evaluator.evaluateBatch(compiled, {
      resultForm: "deep",
      inputs: [
        { kind: "signed-integer-64", value: 33n },
        { kind: "float-32", value: 1.5 },
      ],
    });
    ok(results[0]?.ok);
    ok(results[1]?.ok);
    if (results[0]?.ok) {
      deepStrictEqual(results[0].value, { kind: "signed-integer-64", value: 42n });
    }
    if (results[1]?.ok) {
      deepStrictEqual(results[1].value, { kind: "float-32", value: 6 });
    }
  } finally {
    for (const module of compiled) module.destroy();
  }
});

Deno.test("incremental compilation rechecks dependents only when an imported interface changes", async () => {
  const { compiler, evaluator } = functionalRuntime();
  const cache = new MemoryFunctionalIncrementalCache();
  const incremental = new IncrementalGpuFunctionalCompiler(compiler, { cache });
  const integerFunction = {
    kind: "function",
    parameter: { kind: "integer" },
    result: { kind: "integer" },
  } as const;
  const application = {
    name: "application",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(surface.name("transform"), surface.integer(21)),
    }],
    typeDeclarations: [],
    imports: [{
      name: "transform",
      fromModule: "math",
      exportName: "transform",
      type: integerFunction,
    }],
    exports: [{ name: "main", definition: "main", type: { kind: "integer" } }],
    sourceByteLength: 20,
    options: {},
  } satisfies FunctionalModuleArtifact;
  const math = (increment: number): FunctionalModuleArtifact => ({
    name: "math",
    definitions: [{
      name: "transform",
      parameters: ["value"],
      annotation: null,
      body: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.name("value"),
        surface.integer(increment),
      ),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "transform", definition: "transform", type: integerFunction }],
    sourceByteLength: 10,
    options: {},
  });
  const entry = { module: "application", exportName: "main" } as const;

  const first = await incremental.compile([math(1), application], entry);
  ok(first.ok, first.ok ? undefined : first.diagnostics[0].message);
  if (!first.ok) return;
  try {
    deepStrictEqual(first.incremental.compiledModules, ["application", "math"]);
    const evaluation = await evaluator.evaluate(first.module);
    ok(evaluation.ok);
    if (evaluation.ok) deepStrictEqual(evaluation.value, { kind: "integer", value: 22 });
  } finally {
    first.module.destroy();
  }

  const restartedIncremental = new IncrementalGpuFunctionalCompiler(compiler, { cache });
  const unchanged = await restartedIncremental.compile([math(1), application], entry);
  ok(unchanged.ok, unchanged.ok ? undefined : unchanged.diagnostics[0].message);
  if (!unchanged.ok) return;
  try {
    deepStrictEqual(unchanged.incremental.compiledModules, []);
    deepStrictEqual(unchanged.incremental.reusedModules, ["application", "math"]);
  } finally {
    unchanged.module.destroy();
  }

  const implementationChange = await incremental.compile([math(2), application], entry);
  ok(
    implementationChange.ok,
    implementationChange.ok ? undefined : implementationChange.diagnostics[0].message,
  );
  if (!implementationChange.ok) return;
  try {
    deepStrictEqual(implementationChange.incremental.compiledModules, ["math"]);
    deepStrictEqual(implementationChange.incremental.reusedModules, ["application"]);
    const evaluation = await evaluator.evaluate(implementationChange.module);
    ok(evaluation.ok);
    if (evaluation.ok) deepStrictEqual(evaluation.value, { kind: "integer", value: 23 });
    const execution = await runFunctionalWasmModule(implementationChange.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 23 });
  } finally {
    implementationChange.module.destroy();
  }

  const booleanMath: FunctionalModuleArtifact = {
    ...math(0),
    definitions: [{
      name: "transform",
      parameters: ["value"],
      annotation: null,
      body: surface.boolean(true),
    }],
    exports: [{
      name: "transform",
      definition: "transform",
      type: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "boolean" },
      },
    }],
  };
  const interfaceChange = await incremental.compile([booleanMath, application], entry);
  equal(interfaceChange.ok, false);
  if (interfaceChange.ok) return;
  deepStrictEqual(interfaceChange.incremental.compiledModules, ["application", "math"]);
  match(interfaceChange.diagnostics[0].message, /type|integer|boolean/i);
});

Deno.test("incremental compilation treats mutually recursive modules as one cache unit", async () => {
  const { compiler, evaluator } = functionalRuntime();
  const cache = new MemoryFunctionalIncrementalCache();
  const incremental = new IncrementalGpuFunctionalCompiler(compiler, { cache });
  const integer = { kind: "integer" } as const;
  const left = (fallback: number): FunctionalModuleArtifact => ({
    name: "left",
    definitions: [{
      name: "answer",
      parameters: [],
      annotation: null,
      body: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.name("rightAnswer"),
        surface.integer(fallback),
      ),
    }],
    typeDeclarations: [],
    imports: [{
      name: "rightAnswer",
      fromModule: "right",
      exportName: "answer",
      type: integer,
    }],
    exports: [{ name: "answer", definition: "answer", type: integer }],
    sourceByteLength: 10,
    options: {},
  });
  const right: FunctionalModuleArtifact = {
    name: "right",
    definitions: [{
      name: "answer",
      parameters: [],
      annotation: null,
      body: surface.integer(40),
    }],
    typeDeclarations: [],
    imports: [{
      name: "leftAnswer",
      fromModule: "left",
      exportName: "answer",
      type: integer,
    }],
    exports: [{ name: "answer", definition: "answer", type: integer }],
    sourceByteLength: 10,
    options: {},
  };
  const entry = { module: "left", exportName: "answer" } as const;

  const first = await incremental.compile([left(1), right], entry);
  ok(first.ok, first.ok ? undefined : first.diagnostics[0].message);
  if (!first.ok) return;
  first.module.destroy();
  equal(first.incremental.compiledComponents, 1);

  const changed = await incremental.compile([left(2), right], entry);
  ok(changed.ok, changed.ok ? undefined : changed.diagnostics[0].message);
  if (!changed.ok) return;
  try {
    deepStrictEqual(changed.incremental.compiledModules, ["left", "right"]);
    const evaluation = await evaluator.evaluate(changed.module);
    ok(evaluation.ok);
    if (evaluation.ok) deepStrictEqual(evaluation.value, { kind: "integer", value: 42 });
  } finally {
    changed.module.destroy();
  }
});

Deno.test("incremental compilation conservatively invalidates inferred module interfaces", async () => {
  const { compiler, evaluator } = functionalRuntime();
  const incremental = new IncrementalGpuFunctionalCompiler(compiler, {
    cache: new MemoryFunctionalIncrementalCache(),
  });
  const library = (value: number): FunctionalModuleArtifact => ({
    name: "inferred-library",
    definitions: [{
      name: "answer",
      parameters: [],
      annotation: null,
      body: surface.integer(value),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "answer", definition: "answer" }],
    sourceByteLength: 1,
    options: {},
  });
  const application: FunctionalModuleArtifact = {
    name: "inferred-application",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.name("answer"),
    }],
    typeDeclarations: [],
    imports: [{
      name: "answer",
      fromModule: "inferred-library",
      exportName: "answer",
    }],
    exports: [{ name: "main", definition: "main" }],
    sourceByteLength: 1,
    options: {},
  };
  const entry = { module: application.name, exportName: "main" };

  const first = await incremental.compile([library(41), application], entry);
  ok(first.ok, first.ok ? undefined : first.diagnostics[0].message);
  if (!first.ok) return;
  first.module.destroy();

  const changed = await incremental.compile([library(42), application], entry);
  ok(changed.ok, changed.ok ? undefined : changed.diagnostics[0].message);
  if (!changed.ok) return;
  try {
    deepStrictEqual(changed.incremental.compiledModules, [
      "inferred-application",
      "inferred-library",
    ]);
    const evaluation = await evaluator.evaluate(changed.module);
    ok(evaluation.ok);
    if (evaluation.ok) deepStrictEqual(evaluation.value, { kind: "integer", value: 42 });
  } finally {
    changed.module.destroy();
  }
});

Deno.test("incremental Core relinking preserves imported constructors and case arms", async () => {
  const { compiler } = functionalRuntime();
  const incremental = new IncrementalGpuFunctionalCompiler(compiler, {
    cache: new MemoryFunctionalIncrementalCache(),
  });
  const optionalInteger = {
    kind: "named",
    name: "Option",
    arguments: [{ kind: "integer" }],
  } as const;
  const library: FunctionalModuleArtifact = {
    name: "library",
    definitions: [{
      name: "some",
      parameters: ["value"],
      annotation: null,
      body: surface.apply(surface.name("Some"), surface.name("value")),
    }],
    typeDeclarations: [{
      name: "Option",
      parameters: ["value"],
      constructors: [
        { name: "None", fields: [] },
        {
          name: "Some",
          fields: [{ name: "value", type: { kind: "parameter", name: "value" } }],
        },
      ],
    }],
    imports: [],
    exports: [{
      name: "some",
      definition: "some",
      type: {
        kind: "function",
        parameter: { kind: "integer" },
        result: optionalInteger,
      },
    }],
    sourceByteLength: 20,
    options: {},
  };
  const application: FunctionalModuleArtifact = {
    name: "application",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: null,
      body: {
        kind: "case",
        value: surface.apply(surface.name("some"), surface.integer(42)),
        arms: [
          { constructor: "library::Some", binders: ["value"], body: surface.name("value") },
          { constructor: "library::None", binders: [], body: surface.integer(0) },
        ],
      },
    }],
    typeDeclarations: [],
    imports: [{
      name: "some",
      fromModule: "library",
      exportName: "some",
      type: {
        kind: "function",
        parameter: { kind: "integer" },
        result: optionalInteger,
      },
    }],
    exports: [{ name: "main", definition: "main", type: { kind: "integer" } }],
    sourceByteLength: 20,
    options: {},
  };

  const first = await incremental.compile(
    [library, application],
    { module: "application", exportName: "main" },
  );
  ok(first.ok, first.ok ? undefined : first.diagnostics[0].message);
  if (!first.ok) return;
  first.module.destroy();
  const reused = await incremental.compile(
    [library, application],
    { module: "application", exportName: "main" },
  );
  ok(reused.ok, reused.ok ? undefined : reused.diagnostics[0].message);
  if (!reused.ok) return;
  try {
    deepStrictEqual(reused.incremental.compiledModules, []);
    const execution = await runFunctionalWasmModule(reused.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    reused.module.destroy();
  }
});

Deno.test("incremental compilation rejects corrupted persistent cache entries with their key", async () => {
  const corruptCache: FunctionalIncrementalCache = {
    read: () => Promise.resolve(Uint8Array.of(0xff)),
    write: () => Promise.resolve(),
  };
  const incremental = new IncrementalGpuFunctionalCompiler(functionalRuntime().compiler, {
    cache: corruptCache,
  });
  const application: FunctionalModuleArtifact = {
    name: "application",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.integer(42),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "main", definition: "main", type: { kind: "integer" } }],
    sourceByteLength: 10,
    options: {},
  };
  await rejects(
    () =>
      incremental.compile(
        [application],
        { module: "application", exportName: "main" },
      ),
    /cache entry [0-9a-f]{64} is not valid UTF-8 JSON/,
  );
});

Deno.test("checks a parser-independent rank-3 function parameter on the GPU", async () => {
  const identity = {
    name: "identity",
    parameters: [],
    annotation: null,
    body: surface.lambda("value", surface.name("value")),
  } as const;
  const use = {
    name: "use",
    parameters: [],
    annotation: {
      kind: "function",
      parameter: {
        kind: "forall",
        parameters: ["T"],
        body: {
          kind: "function",
          parameter: { kind: "parameter", name: "T" },
          result: { kind: "parameter", name: "T" },
        },
      },
      result: {
        kind: "tuple",
        values: [{ kind: "integer" }, { kind: "boolean" }],
      },
    },
    body: surface.lambda(
      "function",
      surface.apply(
        surface.apply(
          surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
          surface.apply(surface.name("function"), surface.integer(42)),
        ),
        surface.apply(surface.name("function"), surface.boolean(true)),
      ),
    ),
  } as const;
  const withIdentity = {
    name: "with_identity",
    parameters: [],
    annotation: {
      kind: "function",
      parameter: {
        kind: "function",
        parameter: use.annotation.parameter,
        result: use.annotation.result,
      },
      result: use.annotation.result,
    },
    body: surface.lambda(
      "consumer",
      surface.apply(surface.name("consumer"), surface.name("identity")),
    ),
  } as const;
  const main = {
    name: "main",
    parameters: [],
    annotation: null,
    body: {
      kind: "case",
      value: surface.apply(surface.name("with_identity"), surface.name("use")),
      arms: [{
        constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
        binders: ["answer", "condition"],
        body: {
          kind: "if",
          condition: surface.name("condition"),
          consequent: surface.name("answer"),
          alternate: surface.integer(0),
        },
      }],
    },
  } as const;
  const module = buildFunctionalSurfaceModule([identity, use, withIdentity, main], [], "main", 0);
  equal(module.typecheckingProfile, FunctionalTypecheckingProfile.PredicativeRankNIndexed);
  const { compiler, evaluator } = functionalRuntime();
  const compilation = await compiler.compileModule(module);

  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (evaluation.ok) deepStrictEqual(evaluation.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("compiles independent functional modules concurrently", async () => {
  const { compiler, evaluator } = functionalRuntime();
  const compilations = await Promise.all([
    compiler.compileModule(integerModule(20, "left_result")),
    compiler.compileModule(integerModule(22, "right_result")),
  ]);
  ok(compilations.every((compilation) => compilation.ok));
  const modules = compilations.flatMap((compilation) => compilation.ok ? [compilation.module] : []);
  try {
    const results = await evaluator.evaluateBatch(modules);
    deepStrictEqual(
      results.map((result) => result.ok ? result.value : result.fault),
      [
        { kind: "integer", value: 20 },
        { kind: "integer", value: 22 },
      ],
    );
  } finally {
    for (const module of modules) module.destroy();
  }
});

Deno.test("packed functional compilation preserves lane order and scalar results", async () => {
  const { compiler, evaluator } = functionalRuntime();
  const missingEntry = {
    ...integerModule(0, "available"),
    entrySymbol: 1,
    symbolNames: ["available", "missing"],
  };
  const compilations = await compiler.compileBatch([
    integerModule(20, "left_result"),
    missingEntry,
    integerModule(22, "right_result"),
  ]);
  equal(compilations.length, 3);
  ok(compilations[0]?.ok);
  equal(compilations[1]?.ok, false);
  ok(compilations[2]?.ok);
  if (compilations[1]?.ok === false) {
    equal(compilations[1].diagnostics[0].code, "F2003");
  }
  const modules = compilations.flatMap((compilation) => compilation.ok ? [compilation.module] : []);
  try {
    equal(modules.length, 2);
    const evaluations = await evaluator.evaluateBatch(modules);
    deepStrictEqual(
      evaluations.map((evaluation) => evaluation.ok ? evaluation.value : evaluation.fault),
      [
        { kind: "integer", value: 20 },
        { kind: "integer", value: 22 },
      ],
    );
    const scalar = await compiler.compileModule(integerModule(20, "left_result"));
    ok(scalar.ok);
    if (scalar.ok && compilations[0]?.ok) {
      try {
        deepStrictEqual(compilations[0].module.entryType, scalar.module.entryType);
        deepStrictEqual(
          await compilations[0].module.readCoreNodes(),
          await scalar.module.readCoreNodes(),
        );
      } finally {
        scalar.module.destroy();
      }
    }
  } finally {
    for (const module of modules) module.destroy();
  }
});

Deno.test("runs handled algebraic effects as explicit GPU continuations", async () => {
  const handled = lowerFunctionalEffectProgram({
    operations: [{
      effect: "Reader",
      name: "ask",
      parameter: { kind: "unit" },
      result: { kind: "integer" },
    }],
    handlers: [{
      effect: "Reader",
      operation: "ask",
      implementation: surface.lambda(
        "$request",
        surface.lambda("$resume", surface.apply(surface.name("$resume"), surface.integer(40))),
      ),
    }],
    expression: {
      kind: "bind",
      name: "answer",
      computation: {
        kind: "perform",
        effect: "Reader",
        operation: "ask",
        argument: surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
      },
      body: {
        kind: "pure",
        value: surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("answer"),
          surface.integer(2),
        ),
        valueType: { kind: "integer" },
      },
    },
  });
  const module = buildFunctionalSurfaceModule(
    [
      ...handled.definitions,
      {
        name: "gpuMain",
        parameters: [],
        annotation: handled.resultType.value,
        body: handled.expression,
      },
    ],
    [],
    "gpuMain",
    0,
  );
  const { compiler, evaluator } = functionalRuntime();

  const compilation = await compiler.compileModule(module);

  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (evaluation.ok) deepStrictEqual(evaluation.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("compatibility effect handlers may discard their continuation", async () => {
  const handled = lowerFunctionalEffectProgram({
    operations: [{
      effect: "Abort",
      name: "stop",
      parameter: { kind: "unit" },
      result: { kind: "integer" },
    }],
    handlers: [{
      effect: "Abort",
      operation: "stop",
      implementation: surface.lambda(
        "$request",
        surface.lambda("$resume", surface.integer(99)),
      ),
    }],
    expression: {
      kind: "bind",
      name: "unreachable",
      computation: {
        kind: "perform",
        effect: "Abort",
        operation: "stop",
        argument: surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
      },
      body: {
        kind: "pure",
        value: surface.integer(0),
        valueType: { kind: "integer" },
      },
    },
  });
  const module = buildFunctionalSurfaceModule(
    [
      ...handled.definitions,
      {
        name: "gpuMain",
        parameters: [],
        annotation: handled.resultType.value,
        body: handled.expression,
      },
    ],
    [],
    "gpuMain",
    0,
  );
  const { compiler, evaluator } = functionalRuntime();

  const compilation = await compiler.compileModule(module);

  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (evaluation.ok) deepStrictEqual(evaluation.value, { kind: "integer", value: 99 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("rejects performed effects without an explicit handler", () => {
  throws(
    () =>
      lowerFunctionalEffectProgram({
        operations: [{
          effect: "Reader",
          name: "ask",
          parameter: { kind: "unit" },
          result: { kind: "integer" },
        }],
        handlers: [],
        expression: {
          kind: "perform",
          effect: "Reader",
          operation: "ask",
          argument: surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
        },
      }),
    /performs "Reader\.ask" without a handler/,
  );
});

Deno.test("rejects duplicate host capability fields at the surface boundary", () => {
  throws(
    () =>
      buildFunctionalSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body: surface.integer(42) }],
        [],
        "main",
        0,
        {
          hostCapabilities: [{
            name: "Console",
            fields: [
              { kind: "value", name: "enabled", type: { kind: "boolean" } },
              { kind: "value", name: "enabled", type: { kind: "boolean" } },
            ],
          }],
        },
      ),
    /capability "Console" repeats field "enabled"/,
  );
});

Deno.test("rejects a WASM buffer intrinsic with an incompatible signature", () => {
  throws(
    () =>
      buildFunctionalSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body: surface.integer(42) }],
        [],
        "main",
        0,
        {
          hostCapabilities: [{
            name: "Buffer",
            fields: [{
              kind: "operation",
              name: "length",
              purity: "pure",
              parameter: { kind: "integer" },
              result: { kind: "integer" },
              wasmIntrinsic: FunctionalWasmIntrinsic.BufferByteLength,
            }],
          }],
        },
      ),
    /parameter must be Text or Bytes/,
  );
});

Deno.test("GPU inference rejects an effect handler that resumes with the wrong type", async () => {
  const handled = lowerFunctionalEffectProgram({
    operations: [{
      effect: "Reader",
      name: "ask",
      parameter: { kind: "unit" },
      result: { kind: "integer" },
    }],
    handlers: [{
      effect: "Reader",
      operation: "ask",
      implementation: surface.lambda(
        "$request",
        surface.lambda("$resume", surface.apply(surface.name("$resume"), surface.boolean(true))),
      ),
    }],
    expression: {
      kind: "perform",
      effect: "Reader",
      operation: "ask",
      argument: surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
    },
  });
  const module = buildFunctionalSurfaceModule(
    [
      ...handled.definitions,
      {
        name: "gpuMain",
        parameters: [],
        annotation: handled.resultType.value,
        body: handled.expression,
      },
    ],
    [],
    "gpuMain",
    0,
  );

  const compilation = await functionalRuntime().compiler.compileModule(module);

  equal(compilation.ok, false);
  if (!compilation.ok) equal(compilation.diagnostics[0].stage, "compile");
});

Deno.test("rejects unsupported functional module envelopes before GPU work", async () => {
  const { compiler } = functionalRuntime();
  const valid = integerModule(42);

  await rejects(
    () => compiler.compileModule({ ...valid, abiVersion: FUNCTIONAL_MODULE_ABI_VERSION + 1 }),
    /ABI version 6 is unsupported; expected 5/,
  );
  await rejects(
    () =>
      compiler.compileModule({
        ...valid,
        evaluationProfile: "strict-v1" as typeof valid.evaluationProfile,
      }),
    /evaluation profile "strict-v1" is unsupported/,
  );
  await rejects(
    () =>
      compiler.compileModule({
        ...valid,
        primitiveCapabilities: valid.primitiveCapabilities.slice(1),
      }),
    /missing=.*signed-integer-i32/,
  );
});

Deno.test("rejects malformed functional record tables with their exact shape", async () => {
  const { compiler } = functionalRuntime();
  const valid = integerModule(42);

  await rejects(
    () => compiler.compileModule({ ...valid, nodeWords: valid.nodeWords.slice(0, 7) }),
    /has 7 node words for 1 records; expected 8/,
  );
});

Deno.test("rejects malformed encoded bytes before GPU work", async () => {
  const module = buildFunctionalSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body: surface.bytes(Uint8Array.of(42)) }],
    [],
    "main",
    0,
  );
  const symbols = [...module.symbolNames];
  const literalSymbol = module.nodeWords[FunctionalNodeWord.Payload]!;
  symbols[literalSymbol] = "$bytes:zz";

  await rejects(
    () => functionalRuntime().compiler.compileModule({ ...module, symbolNames: symbols }),
    /malformed hexadecimal bytes.*\$bytes:zz/,
  );
});

Deno.test("rejects runtime faults outside the symbol table before GPU work", async () => {
  const module = buildFunctionalSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body: surface.runtimeFault("broken") }],
    [],
    "main",
    0,
  );
  const nodeWords = module.nodeWords.slice();
  nodeWords[FunctionalNodeWord.Payload] = module.symbolNames.length;

  await rejects(
    () => functionalRuntime().compiler.compileModule({ ...module, nodeWords }),
    /runtime fault node 0 references symbol.*expected fewer than/,
  );
});

Deno.test("bounds functional source spans before allocating GPU state", async () => {
  const { compiler } = functionalRuntime();
  const compilation = await compiler.compileModule({
    ...integerModule(42),
    sourceByteLength: FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH + 1,
  });

  equal(compilation.ok, false);
  if (compilation.ok) return;
  equal(compilation.diagnostics[0].code, "F1003");
  match(compilation.diagnostics[0].message, /module spans 1048577 UTF-8 source bytes/);
});

Deno.test("preserves Lazuli compatibility across the functional module boundary", async () => {
  const { device, compiler } = functionalRuntime();
  const source = "let identity = value => value; let main = (identity 1, identity true);";
  const parsing = parseLazuliSource(source);
  ok(parsing.ok);
  if (!parsing.ok) return;
  const [functional, lazuli] = await Promise.all([
    compiler.compileModule(
      lazuliSurfaceToFunctionalModule(
        parsing.surface,
        new TextEncoder().encode(source).byteLength,
      ),
    ),
    GpuLazuliCompiler.create(device).then((lazuliCompiler) => lazuliCompiler.compile(source)),
  ]);
  ok(functional.ok, functional.ok ? undefined : functional.diagnostics[0].message);
  ok(lazuli.ok, lazuli.ok ? undefined : lazuli.diagnostics[0].message);
  if (!functional.ok || !lazuli.ok) return;
  try {
    deepStrictEqual(functional.module.entryType, lazuli.module.mainType);
    deepStrictEqual(
      await functional.module.readCoreNodes(),
      await lazuli.module.readCoreNodes(),
    );
  } finally {
    functional.module.destroy();
    lazuli.module.destroy();
  }
});

Deno.test("reports functional diagnostic codes without frontend-specific prefixes", async () => {
  const { compiler } = functionalRuntime();
  const invalid = integerModule(42);
  const compilation = await compiler.compileModule({
    ...invalid,
    definitionWords: Uint32Array.of(1, 0, 0, 2),
    symbolNames: ["entry", "missing_entry"],
  });

  equal(compilation.ok, false);
  if (compilation.ok) return;
  equal(compilation.diagnostics[0].code, "F2003");
  match(compilation.diagnostics[0].message, /missing required entry definition/);
});

Deno.test("duplicate declarations report the original source span", async () => {
  const module = buildFunctionalSurfaceModule(
    [
      {
        name: "answer",
        parameters: [],
        annotation: null,
        body: surface.integer(1),
        span: { startByte: 0, endByte: 10 },
      },
      {
        name: "answer",
        parameters: [],
        annotation: null,
        body: surface.integer(2),
        span: { startByte: 11, endByte: 21 },
      },
    ],
    [],
    "answer",
    21,
  );
  const compilation = await functionalRuntime().compiler.compileModule(module);
  equal(compilation.ok, false);
  if (compilation.ok) return;
  equal(compilation.diagnostics[0].code, "F2002");
  deepStrictEqual(compilation.diagnostics[0].span, { startByte: 11, endByte: 21 });
  deepStrictEqual(compilation.diagnostics[0].related, [{
    message: "first declaration",
    span: { startByte: 0, endByte: 10 },
  }]);
});

Deno.test("linked diagnostics map primary and related spans back to frontend modules", () => {
  const located = locateFunctionalDiagnostic(
    [
      { module: "library.duck", startByte: 0, endByte: 10 },
      { module: "application.duck", startByte: 10, endByte: 30 },
    ],
    {
      stage: "compile",
      code: "F2002",
      message: "duplicate top-level definition answer",
      span: { startByte: 18, endByte: 24 },
      related: [{ message: "first declaration", span: { startByte: 2, endByte: 8 } }],
    },
  );
  deepStrictEqual(located, {
    stage: "compile",
    code: "F2002",
    message: "duplicate top-level definition answer",
    location: {
      module: "application.duck",
      span: { startByte: 8, endByte: 14 },
    },
    related: [{
      message: "first declaration",
      location: {
        module: "library.duck",
        span: { startByte: 2, endByte: 8 },
      },
    }],
  });
});

Deno.test("keeps frontend collection names as ordinary constructors", async () => {
  const { compiler, evaluator } = functionalRuntime();
  const source = "let main = [42];";
  const parsing = parseLazuliSource(source);
  ok(parsing.ok);
  if (!parsing.ok) return;
  const compilation = await compiler.compileModule(
    lazuliSurfaceToFunctionalModule(
      parsing.surface,
      new TextEncoder().encode(source).byteLength,
    ),
  );
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const result = await evaluator.evaluate(compilation.module, { resultForm: "deep" });
    ok(result.ok, result.ok ? undefined : result.fault.message);
    if (!result.ok) return;
    deepStrictEqual(result.value, {
      kind: "constructor",
      name: "Cons",
      fieldCount: 2,
      fields: [
        { kind: "integer", value: 42 },
        { kind: "constructor", name: "Nil", fieldCount: 0, fields: [] },
      ],
    });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("reports functional runtime faults without frontend-specific prefixes", async () => {
  const { compiler, evaluator } = functionalRuntime();
  const source = "let main = 1 / 0;";
  const parsing = parseLazuliSource(source);
  ok(parsing.ok);
  if (!parsing.ok) return;
  const compilation = await compiler.compileModule(
    lazuliSurfaceToFunctionalModule(
      parsing.surface,
      new TextEncoder().encode(source).byteLength,
    ),
  );
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const result = await evaluator.evaluate(compilation.module);
    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.code, "F3007");
    equal(result.fault.kind, "divide-by-zero");
  } finally {
    compilation.module.destroy();
  }
});
