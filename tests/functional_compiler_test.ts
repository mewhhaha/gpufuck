import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  CASE_ALTERNATIVE_WORD_LENGTH,
  CaseAlternativeWord,
  CompilerPerformanceTrace,
  CORE_V1_PRIMITIVE_CAPABILITIES,
  CoreTag,
  CpuCompiler,
  createModuleArtifact,
  defineEffectOperation,
  effectSet,
  type EncodedModule,
  ExpressionTag,
  GpuCompiler,
  INIT_CONSTRUCTOR_NAME,
  INIT_TYPE_NAME,
  linkModules,
  locateDiagnostic,
  MAXIMUM_SOURCE_BYTE_LENGTH,
  MODULE_ABI_VERSION,
  NO_INDEX,
  NodeWord,
  PAIR_CONSTRUCTOR_NAME,
  PAIR_TYPE_NAME,
  requestWebGpuDevice,
  surface,
  type SurfaceExpression,
  tryRegisterLiteralModuleUpdate,
  TypecheckingProfile,
  type TypeSchema,
  WasmIntrinsic,
} from "../functional.ts";
import { GpuEvaluator } from "../src/functional/evaluator.ts";
import { GpuLazuliCompiler, lazuliSurfaceToModule, parseLazuliSource } from "../mod.ts";

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

Deno.test("CPU and GPU compilation produce identical resolved Core", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(
        surface.lambda(
          ["left", "right"],
          surface.binary(
            BinaryOperator.Add,
            surface.name("left"),
            surface.name("right"),
          ),
        ),
        surface.integer(20),
        surface.integer(22),
      ),
    }],
    [],
    "main",
    0,
  );
  const [cpu, gpu] = await Promise.all([
    new CpuCompiler().compileModule(module),
    functionalRuntime().compiler.compileModule(module),
  ]);
  ok(cpu.ok, cpu.ok ? undefined : cpu.diagnostics[0].message);
  ok(gpu.ok, gpu.ok ? undefined : gpu.diagnostics[0].message);
  if (!cpu.ok || !gpu.ok) return;
  try {
    deepStrictEqual(await cpu.module.readCoreNodes(), await gpu.module.readCoreNodes());
    deepStrictEqual(cpu.module.entryType, gpu.module.entryType);
  } finally {
    cpu.module.destroy();
    gpu.module.destroy();
  }
});

Deno.test("a GPU dispatch quantum preserves unchanged Core reuse", async () => {
  const module = buildSurfaceModule(
    [{
      name: "dispatch_cache",
      parameters: [],
      annotation: null,
      body: surface.integer(42),
    }],
    [],
    "dispatch_cache",
    0,
  );
  const compiler = functionalRuntime().compiler;
  const cold = await compiler.compileModule(module, { maximumStepsPerDispatch: 16_384 });
  ok(cold.ok, cold.ok ? undefined : cold.diagnostics[0].message);
  if (!cold.ok) return;
  cold.module.destroy();

  const trace = new CompilerPerformanceTrace();
  const warm = await compiler.compileModule(module, {
    maximumStepsPerDispatch: 16_384,
    trace,
  });
  ok(warm.ok, warm.ok ? undefined : warm.diagnostics[0].message);
  if (!warm.ok) return;
  try {
    const cache = trace.snapshot().find((event) => event.stage === "semantic.service-cache");
    equal(cache?.annotations.cacheLevel, "module");
    equal(
      trace.snapshot().some((event) => event.stage === "semantic.gpu.resolve-infer-readback"),
      false,
    );
  } finally {
    warm.module.destroy();
  }
});

Deno.test("resident GPU compiler restores cached Core after source-only edits", async () => {
  const firstModule = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.at({ startByte: 0, endByte: 2 }).integer(42),
    }],
    [],
    "main",
    2,
  );
  const secondModule = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.at({ startByte: 5, endByte: 7 }).integer(42),
    }],
    [],
    "main",
    7,
  );
  const coldTrace = new CompilerPerformanceTrace();
  const first = await functionalRuntime().compiler.compileModule(firstModule, { trace: coldTrace });
  ok(first.ok, first.ok ? undefined : first.diagnostics[0]?.message);
  if (!first.ok) return;
  const allocation = coldTrace.snapshot().find((event) =>
    event.stage === "semantic.gpu.allocate-upload"
  );
  const gpuMachine = coldTrace.snapshot().find((event) =>
    event.stage === "semantic.gpu.resolve-infer-readback"
  );
  ok(Number(allocation?.annotations.uploadedBytes) > 0);
  ok(Number(gpuMachine?.annotations.dispatches) >= 1);
  ok(Number(gpuMachine?.annotations.inferenceTransitions) >= 1);
  first.module.destroy();

  const trace = new CompilerPerformanceTrace();
  const second = await functionalRuntime().compiler.compileModule(secondModule, { trace });
  ok(second.ok, second.ok ? undefined : second.diagnostics[0]?.message);
  if (!second.ok) return;
  try {
    const cache = trace.snapshot().find((event) => event.stage === "semantic.service-cache");
    equal(cache?.annotations.backend, "gpu");
    equal(cache?.annotations.cacheLevel, "semantics");
    equal(trace.snapshot().some((event) => event.stage === "semantic.inference.solve"), false);
    const entry = (await second.module.readCoreNodes())[
      second.module.definitionRoots[second.module.entryDefinition]!
    ];
    equal(entry?.sourceByteOffset, 5);
    equal(entry?.sourceEndByte, 7);
  } finally {
    second.module.destroy();
  }
});

Deno.test("resident GPU compiler applies same-shape literal edits without inference", async () => {
  const firstModule = integerModule(41, "incremental_literal");
  const secondModule = integerModule(42, "incremental_literal");
  equal(tryRegisterLiteralModuleUpdate(firstModule, secondModule), true);

  const first = await functionalRuntime().compiler.compileModule(firstModule);
  ok(first.ok, first.ok ? undefined : first.diagnostics[0]?.message);
  if (!first.ok) return;
  first.module.destroy();

  const trace = new CompilerPerformanceTrace();
  const second = await functionalRuntime().compiler.compileModule(secondModule, { trace });
  ok(second.ok, second.ok ? undefined : second.diagnostics[0]?.message);
  if (!second.ok) return;
  try {
    const cache = trace.snapshot().find((event) => event.stage === "semantic.service-cache");
    equal(cache?.annotations.cacheLevel, "literal-update");
    equal(trace.snapshot().some((event) => event.stage === "semantic.inference.solve"), false);
    const evaluation = await functionalRuntime().evaluator.evaluate(second.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (evaluation.ok) {
      deepStrictEqual(evaluation.value, { kind: "integer", value: 42 });
    }
  } finally {
    second.module.destroy();
  }
});

Deno.test("nested case scrutinees keep contiguous alternative metadata", () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.case(
        surface.case(surface.name("A"), [{
          constructor: "A",
          binders: [],
          body: surface.name("B"),
        }]),
        [{ constructor: "B", binders: [], body: surface.integer(42) }],
      ),
    }],
    [{
      name: "Choice",
      parameters: [],
      constructors: [
        { name: "A", fields: [] },
        { name: "B", fields: [] },
      ],
    }],
    "main",
    0,
  );

  equal(module.caseAlternativeCount, 2);
  for (let alternative = 0; alternative < module.caseAlternativeCount; alternative++) {
    const constructor = module.caseAlternativeWords[
      alternative * CASE_ALTERNATIVE_WORD_LENGTH + CaseAlternativeWord.Constructor
    ];
    ok(constructor !== NO_INDEX);
  }
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

Deno.test("surface definitions reject malformed effects before host binding reads them", () => {
  throws(
    () =>
      buildSurfaceModule(
        [{
          name: "emit",
          parameters: ["value"],
          annotation: {
            kind: "function",
            parameter: { kind: "integer" },
            result: { kind: "integer" },
          },
          effects: { size: 1 } as never,
          body: surface.name("value"),
        }, {
          name: "main",
          parameters: [],
          annotation: { kind: "integer" },
          body: surface.integer(42),
        }],
        [],
        "main",
        0,
        {
          hostCapabilities: [{
            name: "Console",
            fields: [{
              kind: "operation",
              name: "emit",
              effects: effectSet("Console.Write"),
              parameter: { kind: "integer" },
              result: { kind: "integer" },
            }],
          }],
          hostDefinitions: [{
            definition: "emit",
            capability: "Console",
            field: "emit",
          }],
        },
      ),
    /functional definition 0 effects must be a ReadonlySet; received \{"size":1\}/,
  );
});

Deno.test("effect sets provide deterministic ordinary set operations", () => {
  const consoleEffects = effectSet("Console.Write", "Console.Read", "Console.Write");
  const storageEffects = effectSet("Storage");
  const combinedEffects = consoleEffects.union(storageEffects);

  deepStrictEqual([...consoleEffects], ["Console.Read", "Console.Write"]);
  deepStrictEqual(
    [...combinedEffects],
    ["Console.Read", "Console.Write", "Storage"],
  );
  deepStrictEqual(
    [...consoleEffects.intersection(effectSet("Console.Write", "Network"))],
    ["Console.Write"],
  );
  deepStrictEqual(
    [...consoleEffects.difference(effectSet("Console.Read"))],
    ["Console.Write"],
  );
  deepStrictEqual(
    [...consoleEffects.symmetricDifference(effectSet("Console.Read", "Storage"))],
    ["Console.Write", "Storage"],
  );
  throws(
    () => (combinedEffects as Set<string>).add("Network"),
    /functional effect sets are immutable/,
  );
  equal(consoleEffects.isSubsetOf(combinedEffects), true);
  equal(consoleEffects.isDisjointFrom(storageEffects), true);
});

Deno.test("effect sets reject runtime mutation", () => {
  const effects = effectSet("Console.Write");

  throws(
    () => (effects as Set<string>).clear(),
    /functional effect sets are immutable/,
  );
  throws(
    () => Set.prototype.clear.call(effects),
    /incompatible receiver|not a Set/,
  );
  deepStrictEqual([...effects], ["Console.Write"]);
});

Deno.test("GPU evaluation skips an ordinary let value outside the selected branch", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.let(
        "x",
        surface.integer(1),
        surface.let(
          "y",
          surface.runtimeFault("unselected let value"),
          surface.if(
            surface.equal(surface.name("x"), surface.integer(1)),
            surface.name("x"),
            surface.name("y"),
          ),
        ),
      ),
    }],
    [],
    "main",
    0,
  );
  const { compiler, evaluator } = functionalRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) return;
  try {
    const result = await evaluator.evaluate(compilation.module);
    ok(result.ok, result.ok ? undefined : result.fault.message);
    if (result.ok) deepStrictEqual(result.value, { kind: "integer", value: 1 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("functional evaluation runs an unused sequenced value before its body", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.sequence(
        "ignored",
        surface.runtimeFault("sequenced value"),
        surface.integer(42),
      ),
    }],
    [],
    "main",
    0,
  );
  const { compiler, evaluator } = functionalRuntime();
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) return;
  try {
    await rejects(() => evaluator.evaluate(compilation.module), /sequenced value/);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("effect analysis removes an operation under an unused ordinary let", async () => {
  const integer = { kind: "integer" as const };
  const module = buildSurfaceModule(
    [
      defineEffectOperation({
        name: "tick",
        parameter: { name: "value", type: integer },
        result: integer,
        effects: effectSet("Clock.Tick"),
        body: surface.name("value"),
      }),
      {
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.let(
          "ignored",
          surface.apply(surface.name("tick"), surface.integer(41)),
          surface.integer(42),
        ),
      },
    ],
    [],
    "main",
    0,
  );
  const compilation = await functionalRuntime().compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) return;
  try {
    deepStrictEqual([...compilation.module.entryEffects], []);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("effect analysis retains an operation under sequence", async () => {
  const integer = { kind: "integer" as const };
  const module = buildSurfaceModule(
    [
      defineEffectOperation({
        name: "tick",
        parameter: { name: "value", type: integer },
        result: integer,
        effects: effectSet("Clock.Tick"),
        body: surface.name("value"),
      }),
      {
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.sequence(
          "ignored",
          surface.apply(surface.name("tick"), surface.integer(41)),
          surface.integer(42),
        ),
      },
    ],
    [],
    "main",
    0,
  );
  const compilation = await functionalRuntime().compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) return;
  try {
    deepStrictEqual([...compilation.module.entryEffects], ["Clock.Tick"]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("infers effect sets through higher-order Core calls", async () => {
  const consoleEffects = effectSet("Console.Write", "Telemetry");
  const integer = { kind: "integer" as const };
  const operationType = {
    kind: "function" as const,
    parameter: integer,
    result: integer,
  };
  const module = buildSurfaceModule(
    [
      defineEffectOperation({
        name: "tick",
        parameter: { name: "value", type: integer },
        result: integer,
        effects: effectSet("Clock.Tick"),
        body: surface.name("value"),
      }),
      {
        name: "emit",
        parameters: [],
        annotation: operationType,
        body: surface.lambda(
          "value",
          surface.apply(surface.name("tick"), surface.name("value")),
        ),
      },
      {
        name: "invoke",
        parameters: ["callback"],
        annotation: null,
        body: surface.apply(surface.name("callback"), surface.integer(42)),
      },
      {
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.apply(surface.name("invoke"), surface.name("emit")),
      },
    ],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Console",
        fields: [{
          kind: "operation",
          name: "emit",
          effects: consoleEffects,
          parameter: integer,
          result: integer,
        }],
      }],
      hostDefinitions: [{
        definition: "emit",
        capability: "Console",
        field: "emit",
      }],
    },
  );
  const { compiler } = functionalRuntime();
  const compilation = await compiler.compileModule(module);

  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    deepStrictEqual([...compilation.module.entryEffects], ["Console.Write", "Telemetry"]);
    const tick = compilation.module.definitionNames.indexOf("tick");
    const emit = compilation.module.definitionNames.indexOf("emit");
    const invoke = compilation.module.definitionNames.indexOf("invoke");
    const main = compilation.module.definitionNames.indexOf("main");
    deepStrictEqual([...compilation.module.definitionEffects[tick]!], ["Clock.Tick"]);
    deepStrictEqual([...compilation.module.definitionEffects[emit]!], [
      "Console.Write",
      "Telemetry",
    ]);
    deepStrictEqual([...compilation.module.definitionEffects[invoke]!], [
      "Console.Write",
      "Telemetry",
    ]);
    deepStrictEqual([...compilation.module.definitionEffects[main]!], [
      "Console.Write",
      "Telemetry",
    ]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("host-bound definitions reject conflicting source effect declarations", () => {
  const integer = { kind: "integer" as const };

  throws(
    () =>
      buildSurfaceModule(
        [
          {
            name: "emit",
            parameters: ["value"],
            annotation: {
              kind: "function",
              parameter: integer,
              result: integer,
            },
            effects: new Set(["Telemetry", "Audit"]) as never,
            body: surface.name("value"),
          },
          {
            name: "main",
            parameters: [],
            annotation: integer,
            body: surface.integer(42),
          },
        ],
        [],
        "main",
        0,
        {
          hostCapabilities: [{
            name: "Console",
            fields: [{
              kind: "operation",
              name: "emit",
              effects: effectSet("Console.Write"),
              parameter: integer,
              result: integer,
            }],
          }],
          hostDefinitions: [{
            definition: "emit",
            capability: "Console",
            field: "emit",
          }],
        },
      ),
    /host definition "emit" declares effects \["Audit","Telemetry"\]; field "Console\.emit" declares \["Console\.Write"\]/,
  );
});

Deno.test("source effects flow through higher-order calls and pure handlers discharge them", async () => {
  const integer = { kind: "integer" as const };
  const tickImplementation = surface.lambda(
    "value",
    surface.binary(
      BinaryOperator.Add,
      surface.name("value"),
      surface.integer(1),
    ),
  );
  const buildModule = (mainBody: SurfaceExpression): EncodedModule =>
    buildSurfaceModule(
      [
        defineEffectOperation({
          name: "tick",
          parameter: { name: "value", type: integer },
          result: integer,
          effects: effectSet("Tick"),
          body: surface.binary(
            BinaryOperator.Add,
            surface.name("value"),
            surface.integer(1),
          ),
        }),
        {
          name: "invoke",
          parameters: ["operation"],
          annotation: null,
          body: surface.apply(surface.name("operation"), surface.integer(41)),
        },
        {
          name: "main",
          parameters: [],
          annotation: integer,
          body: mainBody,
        },
      ],
      [],
      "main",
      0,
    );
  const unhandled = buildModule(
    surface.apply(surface.name("invoke"), surface.name("tick")),
  );
  const handled = buildModule(
    surface.withEffectHandler(
      "tick",
      tickImplementation,
      surface.apply(surface.name("invoke"), surface.name("tick")),
    ),
  );
  const { compiler, evaluator } = functionalRuntime();

  const unhandledCompilation = await compiler.compileModule(unhandled);
  ok(
    unhandledCompilation.ok,
    unhandledCompilation.ok ? undefined : unhandledCompilation.diagnostics[0].message,
  );
  if (!unhandledCompilation.ok) return;
  const handledCompilation = await compiler.compileModule(handled);
  ok(
    handledCompilation.ok,
    handledCompilation.ok ? undefined : handledCompilation.diagnostics[0].message,
  );
  if (!handledCompilation.ok) {
    unhandledCompilation.module.destroy();
    return;
  }

  try {
    deepStrictEqual([...unhandledCompilation.module.entryEffects], ["Tick"]);
    deepStrictEqual([...handledCompilation.module.entryEffects], []);
    const tick = handledCompilation.module.definitionNames.indexOf("tick");
    deepStrictEqual([...handledCompilation.module.declaredDefinitionEffects[tick]!], ["Tick"]);
    deepStrictEqual([...handledCompilation.module.definitionEffects[tick]!], ["Tick"]);

    const [unhandledResult, handledResult] = await Promise.all([
      evaluator.evaluate(unhandledCompilation.module),
      evaluator.evaluate(handledCompilation.module),
    ]);
    if (!unhandledResult.ok) throw new Error(unhandledResult.fault.message);
    if (!handledResult.ok) throw new Error(handledResult.fault.message);
    deepStrictEqual(unhandledResult.value, { kind: "integer", value: 42 });
    deepStrictEqual(handledResult.value, { kind: "integer", value: 42 });
  } finally {
    unhandledCompilation.module.destroy();
    handledCompilation.module.destroy();
  }
});

Deno.test("lexical effect evidence does not intercept an operation closed over by a function", async () => {
  const integer = { kind: "integer" as const };
  const module = buildSurfaceModule(
    [
      defineEffectOperation({
        name: "tick",
        parameter: { name: "value", type: integer },
        result: integer,
        effects: effectSet("Tick"),
        body: surface.binary(
          BinaryOperator.Add,
          surface.name("value"),
          surface.integer(1),
        ),
      }),
      {
        name: "closedComputation",
        parameters: ["value"],
        annotation: null,
        body: surface.apply(surface.name("tick"), surface.name("value")),
      },
      {
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.withEffectHandler(
          "tick",
          surface.lambda("value", surface.name("value")),
          surface.apply(surface.name("closedComputation"), surface.integer(41)),
        ),
      },
    ],
    [],
    "main",
    0,
  );
  const { compiler, evaluator } = functionalRuntime();

  const compilation = await compiler.compileModule(module);
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) return;

  try {
    deepStrictEqual([...compilation.module.entryEffects], ["Tick"]);
    const evaluation = await evaluator.evaluate(compilation.module);
    if (!evaluation.ok) throw new Error(evaluation.fault.message);
    deepStrictEqual(evaluation.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("definition and export effects include fully applied curried bodies", async () => {
  const integer = { kind: "integer" as const };
  const module = buildSurfaceModule(
    [
      defineEffectOperation({
        name: "tick",
        parameter: { name: "value", type: integer },
        result: integer,
        effects: effectSet("Clock.Tick"),
        body: surface.name("value"),
      }),
      {
        name: "combine",
        parameters: ["left", "right"],
        annotation: {
          kind: "function",
          parameter: integer,
          result: {
            kind: "function",
            parameter: integer,
            result: integer,
          },
        },
        effects: effectSet("Combine"),
        body: surface.apply(surface.name("tick"), surface.name("right")),
      },
      {
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.let(
          "partial",
          surface.apply(surface.name("combine"), surface.integer(1)),
          surface.integer(42),
        ),
      },
    ],
    [],
    "main",
    0,
    { wasmExports: [{ name: "combine", definition: "combine" }] },
  );
  const compilation = await functionalRuntime().compiler.compileModule(module);

  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const combine = compilation.module.definitionNames.indexOf("combine");
    deepStrictEqual([...compilation.module.entryEffects], []);
    deepStrictEqual([...compilation.module.definitionEffects[combine]!], [
      "Clock.Tick",
      "Combine",
    ]);
    deepStrictEqual([...compilation.module.wasmExports[0]!.effects], [
      "Clock.Tick",
      "Combine",
    ]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("nested source handlers discharge only the effects they replace", async () => {
  const integer = { kind: "integer" as const };
  const identity = surface.lambda("value", surface.name("value"));
  const operation = (name: string, effect: string) =>
    defineEffectOperation({
      name,
      parameter: { name: "value", type: integer },
      result: integer,
      effects: effectSet(effect),
      body: surface.name("value"),
    });
  const computation = surface.binary(
    BinaryOperator.Add,
    surface.apply(surface.name("tick"), surface.integer(20)),
    surface.apply(surface.name("trace"), surface.integer(22)),
  );
  const buildModule = (body: SurfaceExpression): EncodedModule =>
    buildSurfaceModule(
      [
        operation("tick", "Tick"),
        operation("trace", "Trace"),
        {
          name: "main",
          parameters: [],
          annotation: integer,
          body,
        },
      ],
      [],
      "main",
      0,
    );
  const partial = buildModule(
    surface.withEffectHandler("tick", identity, computation),
  );
  const complete = buildModule(
    surface.withEffectHandler(
      "tick",
      identity,
      surface.withEffectHandler("trace", identity, computation),
    ),
  );
  const { compiler, evaluator } = functionalRuntime();
  const partialCompilation = await compiler.compileModule(partial);
  ok(
    partialCompilation.ok,
    partialCompilation.ok ? undefined : partialCompilation.diagnostics[0].message,
  );
  if (!partialCompilation.ok) return;
  const completeCompilation = await compiler.compileModule(complete);
  ok(
    completeCompilation.ok,
    completeCompilation.ok ? undefined : completeCompilation.diagnostics[0].message,
  );
  if (!completeCompilation.ok) {
    partialCompilation.module.destroy();
    return;
  }

  try {
    deepStrictEqual([...partialCompilation.module.entryEffects], ["Trace"]);
    deepStrictEqual([...completeCompilation.module.entryEffects], []);
    const result = await evaluator.evaluate(completeCompilation.module);
    if (!result.ok) throw new Error(result.fault.message);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  } finally {
    partialCompilation.module.destroy();
    completeCompilation.module.destroy();
  }
});

Deno.test("infers effects from operations supplied through host init", async () => {
  const consoleEffects = effectSet("Console.Write");
  const integer = { kind: "integer" as const };
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: ["init"],
      annotation: {
        kind: "function",
        parameter: { kind: "named", name: INIT_TYPE_NAME, arguments: [] },
        result: integer,
      },
      body: surface.case(surface.name("init"), [{
        constructor: INIT_CONSTRUCTOR_NAME,
        binders: ["write"],
        body: surface.apply(surface.name("write"), surface.integer(42)),
      }]),
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
          effects: consoleEffects,
          parameter: integer,
          result: integer,
        }],
      }],
    },
  );
  const { compiler } = functionalRuntime();
  const compilation = await compiler.compileModule(module);

  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    deepStrictEqual([...compilation.module.entryEffects], ["Console.Write"]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("linked host operations must declare the same effect set", () => {
  const integer = { kind: "integer" as const };
  const artifact = (name: string, effects: ReadonlySet<string>) =>
    createModuleArtifact({
      name,
      definitions: [{
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.integer(0),
      }],
      typeDeclarations: [],
      imports: [],
      exports: name === "entry" ? [{ name: "main", definition: "main" }] : [],
      sourceByteLength: 0,
      options: {
        hostCapabilities: [{
          name: "Console",
          fields: [{
            kind: "operation",
            name: "write",
            effects,
            parameter: integer,
            result: integer,
          }],
        }],
      },
    });

  throws(
    () =>
      linkModules(
        [
          artifact("entry", effectSet("Console.Write")),
          artifact("library", effectSet("Telemetry")),
        ],
        { module: "entry", exportName: "main" },
      ),
    /F4005: functional modules declare incompatible host field "Console.write"/,
  );

  const snapshot = artifact("snapshot", effectSet("Console.Write"));
  const operation = snapshot.options.hostCapabilities?.[0]?.fields[0];
  if (operation?.kind !== "operation") throw new Error("test artifact omitted its operation");
  throws(
    () => (operation.effects as Set<string>).add("Telemetry"),
    /functional effect sets are immutable/,
  );
});

Deno.test("module linking preserves source effect declarations", async () => {
  const integer = { kind: "integer" as const };
  const operationType = {
    kind: "function" as const,
    parameter: integer,
    result: integer,
  };
  const library = createModuleArtifact({
    name: "library",
    definitions: [defineEffectOperation({
      name: "tick",
      parameter: { name: "value", type: integer },
      result: integer,
      effects: effectSet("Tick"),
      body: surface.name("value"),
    })],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "tick", definition: "tick", type: operationType }],
    sourceByteLength: 0,
    options: {},
  });
  const entry = createModuleArtifact({
    name: "entry",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: integer,
      body: surface.apply(surface.name("tick"), surface.integer(42)),
    }],
    typeDeclarations: [],
    imports: [{
      name: "tick",
      fromModule: "library",
      exportName: "tick",
      type: operationType,
    }],
    exports: [{ name: "main", definition: "main", type: integer }],
    sourceByteLength: 0,
    options: {},
  });
  const linked = linkModules([entry, library], {
    module: "entry",
    exportName: "main",
  });
  const compilation = await functionalRuntime().compiler.compileModule(linked.module);

  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    deepStrictEqual([...compilation.module.entryEffects], ["Tick"]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("surface type schemas bound expansion of structurally shared annotations", () => {
  let sharedType: TypeSchema = { kind: "integer" };
  for (let depth = 0; depth < 13; depth += 1) {
    sharedType = {
      kind: "named",
      name: PAIR_TYPE_NAME,
      arguments: [sharedType, sharedType],
    };
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

  equal(module.nodeCount, 2);
  equal(module.parameterWords.length, parameterCount);
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
    [{
      name: "Many",
      parameters: [],
      constructors: Array.from({ length: armCount }, (_, index) => ({
        name: `Constructor${index}`,
        fields: [],
      })),
    }],
    "main",
    0,
  );

  equal(module.nodeCount, 2 + armCount);
  equal(module.caseAlternativeCount, armCount);
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

function integerModule(value: number, entryName = "entry"): EncodedModule {
  return {
    abiVersion: MODULE_ABI_VERSION,
    sourceByteLength: 2,
    typecheckingProfile: TypecheckingProfile.HindleyMilnerIndexed,
    primitiveCapabilities: CORE_V1_PRIMITIVE_CAPABILITIES,
    hostCapabilities: [],
    declaredDefinitionEffects: [effectSet()],
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
    parameterWords: new Uint32Array(),
    argumentWords: new Uint32Array(),
    caseAlternativeWords: new Uint32Array(),
    caseBinderWords: new Uint32Array(),
    definitionWords: Uint32Array.of(0, 0, 0, 2),
    typeWords: new Uint32Array(),
    constructorWords: new Uint32Array(),
    nodeCount: 1,
    argumentCount: 0,
    caseAlternativeCount: 0,
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
  const compilations = await Promise.all([
    new CpuCompiler().compileModule(module),
    functionalRuntime().compiler.compileModule(module),
  ]);
  for (const compilation of compilations) {
    ok(!compilation.ok);
    if (compilation.ok) continue;
    match(compilation.diagnostics[0].message, /expected Int, received Bool/);
  }
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
        kind: "named",
        name: PAIR_TYPE_NAME,
        arguments: [{ kind: "integer" }, { kind: "boolean" }],
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
              effects: effectSet(),
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

Deno.test("rejects a suspending host operation with no declared effects", () => {
  throws(
    () =>
      buildSurfaceModule(
        [{ name: "main", parameters: [], annotation: null, body: surface.integer(42) }],
        [],
        "main",
        0,
        {
          hostCapabilities: [{
            name: "Network",
            fields: [{
              kind: "operation",
              name: "fetch",
              effects: effectSet(),
              execution: "suspending",
              parameter: { kind: "integer" },
              result: { kind: "integer" },
            }],
          }],
        },
      ),
    /suspending host operation "Network.fetch" must declare at least one effect/,
  );
});

Deno.test("rejects unsupported functional module envelopes before GPU work", async () => {
  const { compiler } = functionalRuntime();
  const valid = integerModule(42);

  await rejects(
    () => compiler.compileModule({ ...valid, abiVersion: MODULE_ABI_VERSION + 1 }),
    new RegExp(
      `ABI version ${MODULE_ABI_VERSION + 1} is unsupported; expected ${MODULE_ABI_VERSION}`,
    ),
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

Deno.test("rejects incomplete source effect declarations before GPU work", async () => {
  const { compiler } = functionalRuntime();

  await rejects(
    () =>
      compiler.compileModule({
        ...integerModule(42),
        declaredDefinitionEffects: [],
      }),
    /has 0 declared effect sets for 1 definitions/,
  );
});

Deno.test("rejects encoded host effect conflicts before GPU work", async () => {
  const integer = { kind: "integer" as const };
  const module = buildSurfaceModule(
    [
      defineEffectOperation({
        name: "emit",
        parameter: { name: "value", type: integer },
        result: integer,
        effects: effectSet("Console.Write"),
        body: surface.name("value"),
      }),
      {
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.integer(42),
      },
    ],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Console",
        fields: [{
          kind: "operation",
          name: "emit",
          effects: effectSet("Console.Write"),
          parameter: integer,
          result: integer,
        }],
      }],
      hostDefinitions: [{
        definition: "emit",
        capability: "Console",
        field: "emit",
      }],
    },
  );

  await rejects(
    () =>
      functionalRuntime().compiler.compileModule({
        ...module,
        declaredDefinitionEffects: [effectSet("Telemetry"), effectSet()],
      }),
    /host definition "emit" declares effects \["Telemetry"\]; field "Console\.emit" declares \["Console\.Write"\]/,
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

Deno.test("rejects unknown runtime fault categories before GPU work", async () => {
  const module = buildSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body: surface.runtimeFault("broken") }],
    [],
    "main",
    0,
  );
  const nodeWords = module.nodeWords.slice();
  nodeWords[NodeWord.Child0] = 2;

  await rejects(
    () => functionalRuntime().compiler.compileModule({ ...module, nodeWords }),
    /runtime fault node 0 has unknown category 2/,
  );
});

Deno.test("rejects unknown let evaluation modes before compiler selection", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.let("answer", surface.integer(42), surface.name("answer")),
    }],
    [],
    "main",
    0,
  );
  const nodeWords = module.nodeWords.slice();
  nodeWords[NodeWord.Child2] = 2;

  await rejects(
    () => new CpuCompiler().compileModule({ ...module, nodeWords }),
    /functional let node 0 has unknown evaluation mode 2/,
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
      lazuliSurfaceToModule(
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
  const module = {
    ...invalid,
    definitionWords: Uint32Array.of(1, 0, 0, 2),
    symbolNames: ["entry", "missing_entry"],
  };
  const compilations = await Promise.all([
    new CpuCompiler().compileModule(module),
    compiler.compileModule(module),
  ]);

  for (const compilation of compilations) {
    equal(compilation.ok, false);
    if (compilation.ok) continue;
    equal(compilation.diagnostics[0].code, "F2003");
    match(compilation.diagnostics[0].message, /missing required entry definition/);
  }
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
  const compilations = await Promise.all([
    new CpuCompiler().compileModule(module),
    functionalRuntime().compiler.compileModule(module),
  ]);
  for (const compilation of compilations) {
    equal(compilation.ok, false);
    if (compilation.ok) continue;
    equal(compilation.diagnostics[0].code, "F2002");
    deepStrictEqual(compilation.diagnostics[0].span, { startByte: 11, endByte: 21 });
    deepStrictEqual(compilation.diagnostics[0].related, [{
      message: "first declaration",
      span: { startByte: 0, endByte: 10 },
    }]);
  }
});

Deno.test("linked diagnostics map primary and related spans back to frontend modules", () => {
  const located = locateDiagnostic(
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
    lazuliSurfaceToModule(
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
    lazuliSurfaceToModule(
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
