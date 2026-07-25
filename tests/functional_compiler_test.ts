import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  CORE_V1_PRIMITIVE_CAPABILITIES,
  CoreTag,
  type EncodedFunctionalModule,
  EvaluationProfile,
  ExpressionTag,
  GpuCompiler,
  GpuEvaluator,
  locateFunctionalDiagnostic,
  MAXIMUM_SOURCE_BYTE_LENGTH,
  MODULE_ABI_VERSION,
  NO_INDEX,
  NodeWord,
  PAIR_CONSTRUCTOR_NAME,
  requestWebGpuDevice,
  surface,
  type SurfaceExpression,
  TypecheckingProfile,
  type TypeSchema,
  WasmIntrinsic,
} from "../functional.ts";
import { GpuLazuliCompiler, lazuliSurfaceToFunctionalModule, parseLazuliSource } from "../mod.ts";

interface Runtime {
  readonly device: GPUDevice;
  readonly compiler: GpuCompiler;
  readonly evaluator: GpuEvaluator;
}

let runtime: Runtime | undefined;

Deno.test.beforeAll(async () => {
  const device = await requestWebGpuDevice();
  const [compiler, evaluator] = await Promise.all([
    GpuCompiler.create(device),
    GpuEvaluator.create(device),
  ]);
  runtime = { device, compiler, evaluator };
});

Deno.test.afterAll(() => {
  runtime?.device.destroy();
  runtime = undefined;
});

Deno.test("surface type schemas reject structural cycles before encoding", () => {
  const typeArguments: TypeSchema[] = [];
  const cyclicType = {
    kind: "named",
    name: "Cycle",
    arguments: typeArguments,
  } as TypeSchema;
  typeArguments.push(cyclicType);

  throws(
    () =>
      buildSurfaceModule(
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
      buildSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body: surface.integer(0) }],
        [],
        "main",
        0,
        null as never,
      ),
    /surface module options must be an object/,
  );
});

Deno.test("surface type schemas bound expansion of structurally shared annotations", () => {
  let sharedType: TypeSchema = { kind: "integer" };
  for (let depth = 0; depth < 13; depth += 1) {
    sharedType = { kind: "tuple", values: [sharedType, sharedType] };
  }

  throws(
    () =>
      buildSurfaceModule(
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
  } as unknown as { body: SurfaceExpression } & SurfaceExpression;
  cyclicExpression.body = cyclicExpression;

  throws(
    () =>
      buildSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body: cyclicExpression }],
        [],
        "main",
        0,
      ),
    /surface expression contains a structural cycle/,
  );
});

Deno.test("surface expressions bound expansion of structurally shared trees", () => {
  let sharedExpression: SurfaceExpression = surface.integer(1);
  for (let depth = 0; depth < 16; depth += 1) {
    sharedExpression = surface.binary(
      BinaryOperator.Add,
      sharedExpression,
      sharedExpression,
    );
  }

  throws(
    () =>
      buildSurfaceModule(
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
  const module = buildSurfaceModule(
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
  const module = buildSurfaceModule(
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
      buildSurfaceModule(
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

Deno.test("surface validation rejects expression depth before host recursion overflows", () => {
  let body: SurfaceExpression = surface.integer(0);
  for (let depth = 0; depth < 1_025; depth++) {
    body = {
      kind: "let",
      name: `value${depth}`,
      value: surface.integer(depth),
      body,
    };
  }

  throws(
    () =>
      buildSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body }],
        [],
        "main",
        0,
      ),
    /functional surface expression exceeds depth 1024/,
  );
});

function functionalRuntime(): Runtime {
  if (runtime === undefined) throw new Error("functional test runtime was not initialized");
  return runtime;
}

function integerModule(value: number, entryName = "entry"): EncodedFunctionalModule {
  return {
    abiVersion: MODULE_ABI_VERSION,
    sourceByteLength: 2,
    evaluationProfile: EvaluationProfile.LazyCallByNeed,
    typecheckingProfile: TypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities: [],
    nodeWords: Uint32Array.of(
      ExpressionTag.Integer,
      0,
      2,
      value >>> 0,
      NO_INDEX,
      NO_INDEX,
      NO_INDEX,
      NO_INDEX,
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
    equal(nodes[0]?.tag, CoreTag.Integer);

    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (evaluation.ok) {
      deepStrictEqual(evaluation.value, { kind: "integer", value: 42 });
    }
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("accepts a 524288-step dispatch quantum and rejects larger quanta", async () => {
  const { compiler } = functionalRuntime();
  const compilation = await compiler.compileModule(integerModule(42, "program_result"), {
    maximumStepsPerDispatch: 524_288,
  });
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (compilation.ok) compilation.module.destroy();

  await rejects(
    compiler.compileModule(integerModule(42, "program_result"), {
      maximumStepsPerDispatch: 524_289,
    }),
    /maximumStepsPerDispatch must be an integer from 1 through 524288; received 524289/,
  );
});

Deno.test("rejects structural equality between different operand types", async () => {
  const module = buildSurfaceModule(
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

Deno.test("GPU functional evaluation accepts i64 and f32 inputs", async () => {
  const modules = [
    buildSurfaceModule(
      [{
        name: "main",
        parameters: ["input"],
        annotation: null,
        body: surface.binary(
          BinaryOperator.AddSignedInteger64,
          surface.name("input"),
          surface.signedInteger64(9n),
        ),
      }],
      [],
      "main",
      10,
    ),
    buildSurfaceModule(
      [{
        name: "main",
        parameters: ["input"],
        annotation: null,
        body: surface.binary(
          BinaryOperator.MultiplyFloat32,
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
          surface.name(PAIR_CONSTRUCTOR_NAME),
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
        constructor: PAIR_CONSTRUCTOR_NAME,
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
  const module = buildSurfaceModule([identity, use, withIdentity, main], [], "main", 0);
  equal(module.typecheckingProfile, TypecheckingProfile.PredicativeRankNIndexed);
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

Deno.test("rejects duplicate host capability fields at the surface boundary", () => {
  throws(
    () =>
      buildSurfaceModule(
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
      buildSurfaceModule(
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
              wasmIntrinsic: WasmIntrinsic.BufferByteLength,
            }],
          }],
        },
      ),
    /parameter must be Text or Bytes/,
  );
});

Deno.test("rejects unsupported functional module envelopes before GPU work", async () => {
  const { compiler } = functionalRuntime();
  const valid = integerModule(42);

  await rejects(
    () => compiler.compileModule({ ...valid, abiVersion: MODULE_ABI_VERSION + 1 }),
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
  const module = buildSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body: surface.bytes(Uint8Array.of(42)) }],
    [],
    "main",
    0,
  );
  const symbols = [...module.symbolNames];
  const literalSymbol = module.nodeWords[NodeWord.Payload]!;
  symbols[literalSymbol] = "$bytes:zz";

  await rejects(
    () => functionalRuntime().compiler.compileModule({ ...module, symbolNames: symbols }),
    /malformed hexadecimal bytes.*\$bytes:zz/,
  );
});

Deno.test("rejects runtime faults outside the symbol table before GPU work", async () => {
  const module = buildSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body: surface.runtimeFault("broken") }],
    [],
    "main",
    0,
  );
  const nodeWords = module.nodeWords.slice();
  nodeWords[NodeWord.Payload] = module.symbolNames.length;

  await rejects(
    () => functionalRuntime().compiler.compileModule({ ...module, nodeWords }),
    /runtime fault node 0 references symbol.*expected fewer than/,
  );
});

Deno.test("bounds functional source spans before allocating GPU state", async () => {
  const { compiler } = functionalRuntime();
  const compilation = await compiler.compileModule({
    ...integerModule(42),
    sourceByteLength: MAXIMUM_SOURCE_BYTE_LENGTH + 1,
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
  const module = buildSurfaceModule(
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
