import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";

import {
  type EncodedFunctionalModule,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NO_INDEX,
  FunctionalCoreTag,
  FunctionalEvaluationProfile,
  FunctionalExpressionTag,
  FunctionalTypecheckingProfile,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
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
