import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";

import {
  decodeFunctionalConstant,
  encodeFunctionalConstant,
  FUNCTIONAL_COMPTIME_DESCRIPTOR_SCHEMA,
  FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPES,
  FUNCTIONAL_COMPTIME_IR_SCHEMA,
  FUNCTIONAL_COMPTIME_IR_TYPES,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  type FunctionalComptimeModuleArtifact,
  type FunctionalConstant,
  functionalConstantExpression,
  functionalConstantFromGeneratedDefinitions,
  functionalConstantFromSurfaceExpression,
  functionalConstantFromTypeCoreValue,
  functionalGeneratedDefinitionsFromConstant,
  type FunctionalModuleArtifact,
  FunctionalNumericConversion,
  functionalSurfaceExpressionFromConstant,
  FunctionalUnaryOperator,
  GpuFunctionalCompiler,
  GpuFunctionalComptimeExecutor,
  IncrementalGpuFunctionalComptimeExecutor,
  linkFunctionalModules,
  MemoryFunctionalIncrementalCache,
  partiallyEvaluateFunctionalModule,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  spliceFunctionalGeneratedDefinitions,
  surface,
  validateFunctionalConstant,
} from "../functional.ts";

interface ComptimeRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly executor: GpuFunctionalComptimeExecutor;
}

let runtime: ComptimeRuntime | undefined;

Deno.test.beforeAll(async () => {
  const device = await requestWebGpuDevice();
  const [compiler, executor] = await Promise.all([
    GpuFunctionalCompiler.create(device),
    GpuFunctionalComptimeExecutor.create(device),
  ]);
  runtime = { device, compiler, executor };
});

Deno.test.afterAll(() => {
  runtime?.device.destroy();
  runtime = undefined;
});

function comptimeRuntime(): ComptimeRuntime {
  if (runtime === undefined) throw new Error("comptime test runtime was not initialized");
  return runtime;
}

Deno.test("required comptime evaluates pure functions, recursion, tuples, and constructor cases", async () => {
  const optionType = {
    name: "Option",
    parameters: ["value"],
    constructors: [
      { name: "None", fields: [] },
      {
        name: "Some",
        fields: [{ name: "value", type: { kind: "parameter", name: "value" } }],
      },
    ],
  } as const;
  const module: FunctionalComptimeModuleArtifact = {
    name: "constants",
    definitions: [
      {
        name: "factorial",
        parameters: ["value"],
        annotation: null,
        body: {
          kind: "if",
          condition: surface.binary(
            FunctionalBinaryOperator.Equal,
            surface.name("value"),
            surface.integer(0),
          ),
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
        },
      },
      {
        name: "answer",
        parameters: [],
        annotation: null,
        body: surface.apply(surface.name("factorial"), surface.integer(6)),
      },
      {
        name: "projected",
        parameters: [],
        annotation: null,
        body: {
          kind: "case",
          value: surface.apply(surface.name("Some"), surface.integer(17)),
          arms: [
            { constructor: "Some", binders: ["value"], body: surface.name("value") },
            { constructor: "None", binders: [], body: surface.integer(0) },
          ],
        },
      },
      {
        name: "pair",
        parameters: [],
        annotation: null,
        body: tuple(surface.name("answer"), surface.name("projected")),
      },
    ],
    typeDeclarations: [optionType],
    imports: [],
    exports: [
      { name: "answer", definition: "answer", type: { kind: "integer" } },
      { name: "projected", definition: "projected", type: { kind: "integer" } },
      {
        name: "pair",
        definition: "pair",
        type: { kind: "tuple", values: [{ kind: "integer" }, { kind: "integer" }] },
      },
    ],
    sourceByteLength: 100,
  };

  const result = await comptimeRuntime().executor.execute([module]);
  ok(result.ok, result.ok ? undefined : JSON.stringify(result));
  if (!result.ok) return;
  deepStrictEqual(result.exports.map((exported) => exported.value), [
    { kind: "integer", value: 720 },
    { kind: "integer", value: 17 },
    {
      kind: "tuple",
      values: [{ kind: "integer", value: 720 }, { kind: "integer", value: 17 }],
    },
  ]);
  ok(result.stats.evaluation.steps > 0);
  ok(result.stats.outputNodes >= 5);
});

Deno.test("default comptime executes deep scalar recursion without GPU workspace controls", async () => {
  const module: FunctionalComptimeModuleArtifact = {
    name: "deep-scalar-comptime",
    definitions: [{
      name: "countdown",
      parameters: ["remaining"],
      annotation: null,
      body: {
        kind: "if",
        condition: surface.binary(
          FunctionalBinaryOperator.Equal,
          surface.name("remaining"),
          surface.integer(0),
        ),
        consequent: surface.integer(0),
        alternate: surface.apply(
          surface.name("countdown"),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      },
    }, {
      name: "answer",
      parameters: [],
      annotation: null,
      body: surface.apply(surface.name("countdown"), surface.integer(1_000)),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "answer", definition: "answer", type: { kind: "integer" } }],
    sourceByteLength: 80,
  };
  const result = await comptimeRuntime().executor.execute([module], {
    maximumExecutionSteps: 10_000,
  });
  ok(result.ok, result.ok ? undefined : JSON.stringify(result));
  if (!result.ok) return;
  deepStrictEqual(result.exports[0]?.value, { kind: "integer", value: 0 });
  ok(result.stats.evaluation.steps > 1_000);
});

Deno.test("compiled comptime functions reuse instrumented code and memoize constant arguments", async () => {
  const module: FunctionalComptimeModuleArtifact = {
    name: "reusable-comptime",
    definitions: [{
      name: "double",
      parameters: ["value"],
      annotation: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "integer" },
      },
      body: surface.binary(
        FunctionalBinaryOperator.Multiply,
        surface.name("value"),
        surface.integer(2),
      ),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{
      name: "double",
      definition: "double",
      type: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "integer" },
      },
    }],
    sourceByteLength: 40,
  };
  const firstCompilation = await comptimeRuntime().executor.compileFunction(
    [module],
    { module: module.name, exportName: "double" },
  );
  ok(firstCompilation.ok, firstCompilation.ok ? undefined : JSON.stringify(firstCompilation));
  if (!firstCompilation.ok) return;
  const first = await firstCompilation.compiledFunction.invoke({ kind: "integer", value: 21 });
  ok(first.ok, first.ok ? undefined : JSON.stringify(first));
  if (!first.ok) return;
  deepStrictEqual(first.value, { kind: "integer", value: 42 });
  equal(first.stats.memoized, false);
  ok(first.stats.evaluation.steps > 1);

  const repeated = await firstCompilation.compiledFunction.invoke({ kind: "integer", value: 21 });
  ok(repeated.ok, repeated.ok ? undefined : JSON.stringify(repeated));
  if (!repeated.ok) return;
  equal(repeated.stats.memoized, true);

  const outputLimited = await firstCompilation.compiledFunction.invoke(
    { kind: "integer", value: 21 },
    { maximumOutputBytes: 1 },
  );
  equal(outputLimited.ok, false);
  if (!outputLimited.ok) {
    equal(outputLimited.stage, "comptime");
    if (outputLimited.stage === "comptime") equal(outputLimited.diagnostic.code, "F5002");
  }

  const exhausted = await firstCompilation.compiledFunction.invoke(
    { kind: "integer", value: 21 },
    { maximumExecutionSteps: first.stats.evaluation.steps - 1 },
  );
  equal(exhausted.ok, false);
  if (!exhausted.ok) {
    equal(exhausted.stage, "execute");
    if (exhausted.stage === "execute") equal(exhausted.fault.kind, "out-of-fuel");
  }
  const exact = await firstCompilation.compiledFunction.invoke(
    { kind: "integer", value: 21 },
    { maximumExecutionSteps: first.stats.evaluation.steps },
  );
  ok(exact.ok, exact.ok ? undefined : JSON.stringify(exact));
  if (exact.ok) deepStrictEqual(exact.value, { kind: "integer", value: 42 });
  firstCompilation.compiledFunction.destroy();

  const secondCompilation = await comptimeRuntime().executor.compileFunction(
    [module],
    { module: module.name, exportName: "double" },
  );
  ok(secondCompilation.ok, secondCompilation.ok ? undefined : JSON.stringify(secondCompilation));
  if (!secondCompilation.ok) return;
  try {
    const reused = await secondCompilation.compiledFunction.invoke({ kind: "integer", value: 21 });
    ok(reused.ok, reused.ok ? undefined : JSON.stringify(reused));
    if (reused.ok) equal(reused.stats.memoized, true);
  } finally {
    secondCompilation.compiledFunction.destroy();
  }
  await rejects(
    () => firstCompilation.compiledFunction.invoke({ kind: "integer", value: 21 }),
    /cannot invoke destroyed functional comptime function/,
  );
});

Deno.test("compiled metaprograms return typed Functional IR that validates and executes", async () => {
  const generatedDefinitions = functionalConstantFromGeneratedDefinitions([{
    name: "answer",
    parameters: [],
    body: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(20),
      surface.integer(22),
    ),
  }]);
  const generator: FunctionalComptimeModuleArtifact = {
    name: "ir-generator",
    definitions: [{
      name: "generate",
      parameters: ["seed"],
      annotation: {
        kind: "function",
        parameter: { kind: "integer" },
        result: FUNCTIONAL_COMPTIME_IR_SCHEMA,
      },
      body: functionalConstantExpression(generatedDefinitions),
    }],
    typeDeclarations: FUNCTIONAL_COMPTIME_IR_TYPES,
    imports: [],
    exports: [{
      name: "generate",
      definition: "generate",
      type: {
        kind: "function",
        parameter: { kind: "integer" },
        result: FUNCTIONAL_COMPTIME_IR_SCHEMA,
      },
    }],
    sourceByteLength: 100,
  };
  const compilation = await comptimeRuntime().executor.compileFunction(
    [generator],
    { module: generator.name, exportName: "generate" },
  );
  ok(compilation.ok, compilation.ok ? undefined : JSON.stringify(compilation));
  if (!compilation.ok) return;
  try {
    const generated = await compilation.compiledFunction.invoke({ kind: "integer", value: 0 });
    ok(generated.ok, generated.ok ? undefined : JSON.stringify(generated));
    if (!generated.ok) return;
    deepStrictEqual(functionalGeneratedDefinitionsFromConstant(generated.value), [{
      name: "answer",
      parameters: [],
      body: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.integer(20),
        surface.integer(22),
      ),
    }]);
    const application: FunctionalModuleArtifact = {
      name: "generated-application",
      definitions: [{
        name: "main",
        parameters: [],
        annotation: { kind: "integer" },
        body: surface.name("answer"),
      }],
      typeDeclarations: [],
      imports: [],
      exports: [{ name: "main", definition: "main", type: { kind: "integer" } }],
      sourceByteLength: 20,
      options: {},
    };
    const spliced = spliceFunctionalGeneratedDefinitions(application, generated.value);
    const linked = linkFunctionalModules(
      [spliced],
      { module: spliced.name, exportName: "main" },
    );
    const executable = await comptimeRuntime().compiler.compileModule(linked.module);
    ok(executable.ok, executable.ok ? undefined : executable.diagnostics[0].message);
    if (!executable.ok) return;
    try {
      const execution = await runFunctionalWasmModule(executable.module);
      deepStrictEqual(execution.value, { kind: "integer", value: 42 });
    } finally {
      executable.module.destroy();
    }
  } finally {
    compilation.compiledFunction.destroy();
  }

  const encodedExpression = functionalConstantFromSurfaceExpression(
    surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(1),
      surface.integer(2),
    ),
  );
  ok(encodedExpression.kind === "constructor");
  if (encodedExpression.kind !== "constructor") return;
  const malformedOperator: FunctionalConstant = {
    ...encodedExpression,
    fields: [{ kind: "integer", value: 999 }, ...encodedExpression.fields.slice(1)],
  };
  throws(
    () => functionalSurfaceExpressionFromConstant(malformedOperator),
    /unknown binary operator 999/,
  );
  for (
    const expression of [
      surface.text("Zażółć 🦆"),
      surface.bytes(new Uint8Array([0, 127, 128, 255])),
      surface.runtimeFault("generated failure"),
    ]
  ) {
    deepStrictEqual(
      functionalSurfaceExpressionFromConstant(
        functionalConstantFromSurfaceExpression(expression),
      ),
      expression,
    );
  }
});

Deno.test("required comptime reports fuel, output, and closure failures across numeric backends", async () => {
  const recursive: FunctionalComptimeModuleArtifact = {
    name: "recursive",
    definitions: [{
      name: "loop",
      parameters: ["value"],
      annotation: null,
      body: surface.apply(surface.name("loop"), surface.name("value")),
    }, {
      name: "answer",
      parameters: [],
      annotation: null,
      body: surface.apply(surface.name("loop"), surface.integer(0)),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "answer", definition: "answer", type: { kind: "integer" } }],
    sourceByteLength: 20,
  };
  const exhausted = await comptimeRuntime().executor.execute([recursive], {
    maximumExecutionSteps: 64,
  });
  equal(exhausted.ok, false);
  if (!exhausted.ok) {
    equal(exhausted.stage, "execute");
    if (exhausted.stage === "execute") equal(exhausted.fault.kind, "out-of-fuel");
  }

  const large = constantModule("large", tuple(surface.integer(1), surface.integer(2)), {
    kind: "tuple",
    values: [{ kind: "integer" }, { kind: "integer" }],
  });
  const outputLimited = await comptimeRuntime().executor.execute([large], {
    maximumOutputBytes: 1,
  });
  equal(outputLimited.ok, false);
  if (!outputLimited.ok && outputLimited.stage === "comptime") {
    equal(outputLimited.diagnostic.code, "F5002");
    equal(outputLimited.diagnostic.kind, "output-limit");
  }

  const closure = constantModule(
    "closure",
    surface.lambda("value", surface.name("value")),
    { kind: "function", parameter: { kind: "integer" }, result: { kind: "integer" } },
  );
  const nonConstant = await comptimeRuntime().executor.execute([closure]);
  equal(nonConstant.ok, false);
  if (!nonConstant.ok && nonConstant.stage === "comptime") {
    equal(nonConstant.diagnostic.code, "F5001");
  }

  const wide = constantModule(
    "wide",
    { kind: "signed-integer-64", value: 42n },
    { kind: "signed-integer-64" },
  );
  const boundedWide = await comptimeRuntime().executor.execute([wide]);
  ok(boundedWide.ok, boundedWide.ok ? undefined : JSON.stringify(boundedWide));
  if (boundedWide.ok) {
    deepStrictEqual(boundedWide.exports[0]?.value, {
      kind: "signed-integer-64",
      value: 42n,
    });
  }

  const boundedFloat64 = await comptimeRuntime().executor.execute([
    constantModule("float64", surface.float64(42), { kind: "float-64" }),
  ]);
  ok(boundedFloat64.ok, boundedFloat64.ok ? undefined : JSON.stringify(boundedFloat64));
  if (boundedFloat64.ok) {
    deepStrictEqual(boundedFloat64.exports[0]?.value, {
      kind: "float-64",
      value: 42,
    });
  }
});

Deno.test("GPU comptime evaluates i64 and f32 operators identically across dispatch quanta", async () => {
  const left = -9_007_199_254_740_991n;
  const right = 37n;
  const expressions = [
    numericDefinition(
      "i64Add",
      surface.binary(
        FunctionalBinaryOperator.AddSignedInteger64,
        surface.signedInteger64(left),
        surface.signedInteger64(right),
      ),
      { kind: "signed-integer-64" },
      { kind: "signed-integer-64", value: BigInt.asIntN(64, left + right) },
    ),
    numericDefinition(
      "i64Multiply",
      surface.binary(
        FunctionalBinaryOperator.MultiplySignedInteger64,
        surface.signedInteger64(left),
        surface.signedInteger64(right),
      ),
      { kind: "signed-integer-64" },
      { kind: "signed-integer-64", value: BigInt.asIntN(64, left * right) },
    ),
    numericDefinition(
      "i64Divide",
      surface.binary(
        FunctionalBinaryOperator.DivideSignedInteger64,
        surface.signedInteger64(left),
        surface.signedInteger64(right),
      ),
      { kind: "signed-integer-64" },
      { kind: "signed-integer-64", value: left / right },
    ),
    numericDefinition(
      "i64Remainder",
      surface.binary(
        FunctionalBinaryOperator.RemainderSignedInteger64,
        surface.signedInteger64(left),
        surface.signedInteger64(right),
      ),
      { kind: "signed-integer-64" },
      { kind: "signed-integer-64", value: left % right },
    ),
    numericDefinition(
      "i64OverflowDivide",
      surface.binary(
        FunctionalBinaryOperator.DivideSignedInteger64,
        surface.signedInteger64(-0x8000000000000000n),
        surface.signedInteger64(-1n),
      ),
      { kind: "signed-integer-64" },
      { kind: "signed-integer-64", value: -0x8000000000000000n },
    ),
    numericDefinition(
      "i64Shift",
      surface.binary(
        FunctionalBinaryOperator.ShiftRightUnsignedSignedInteger64,
        surface.signedInteger64(left),
        surface.signedInteger64(17n),
      ),
      { kind: "signed-integer-64" },
      {
        kind: "signed-integer-64",
        value: BigInt.asIntN(64, BigInt.asUintN(64, left) >> 17n),
      },
    ),
    numericDefinition(
      "i64Compare",
      surface.binary(
        FunctionalBinaryOperator.LessSignedInteger64,
        surface.signedInteger64(left),
        surface.signedInteger64(right),
      ),
      { kind: "boolean" },
      { kind: "boolean", value: true },
    ),
    numericDefinition(
      "i64Negate",
      surface.unary(
        FunctionalUnaryOperator.NegateSignedInteger64,
        surface.signedInteger64(left),
      ),
      { kind: "signed-integer-64" },
      { kind: "signed-integer-64", value: -left },
    ),
    numericDefinition(
      "f32Multiply",
      surface.binary(
        FunctionalBinaryOperator.MultiplyFloat32,
        surface.float32(22),
        surface.float32(7),
      ),
      { kind: "float-32" },
      { kind: "float-32", value: 154 },
    ),
    numericDefinition(
      "f32Negate",
      surface.unary(FunctionalUnaryOperator.NegateFloat32, surface.float32(81)),
      { kind: "float-32" },
      { kind: "float-32", value: -81 },
    ),
    numericDefinition(
      "i64ToF32",
      surface.convert(
        FunctionalNumericConversion.SignedInteger64ToFloat32,
        surface.signedInteger64(left),
      ),
      { kind: "float-32" },
      { kind: "float-32", value: Math.fround(Number(left)) },
    ),
    numericDefinition(
      "f32ToI64",
      surface.convert(
        FunctionalNumericConversion.Float32ToSignedInteger64,
        surface.float32(-42.75),
      ),
      { kind: "signed-integer-64" },
      { kind: "signed-integer-64", value: -42n },
    ),
    numericDefinition(
      "reinterpretF32",
      surface.convert(
        FunctionalNumericConversion.ReinterpretFloat32AsSignedInteger32,
        surface.float32(-0),
      ),
      { kind: "integer" },
      { kind: "integer", value: -2_147_483_648 },
    ),
  ] as const;
  const module: FunctionalComptimeModuleArtifact = {
    name: "gpu-numerics",
    definitions: expressions.map(({ name, expression }) => ({
      name,
      parameters: [],
      annotation: null,
      body: expression,
    })),
    typeDeclarations: [],
    imports: [],
    exports: expressions.map(({ name, type }) => ({ name, definition: name, type })),
    sourceByteLength: 200,
  };
  const fullResult = await comptimeRuntime().executor.execute([module]);
  ok(fullResult.ok, fullResult.ok ? undefined : JSON.stringify(fullResult));
  if (fullResult.ok) {
    deepStrictEqual(
      fullResult.exports.map((exported) => exported.value),
      expressions.map(({ expected }) => expected),
    );
  }
  const representativeExpressions = expressions.filter(({ name }) =>
    name === "i64Add" || name === "f32Multiply"
  );
  const representative: FunctionalComptimeModuleArtifact = {
    ...module,
    name: "gpu-numeric-dispatch",
    definitions: module.definitions.filter((definition) =>
      representativeExpressions.some(({ name }) => name === definition.name)
    ),
    exports: module.exports.filter((exported) =>
      representativeExpressions.some(({ name }) => name === exported.name)
    ),
  };
  const results = await Promise.all(
    [1, 7, 4_096].map((maximumStepsPerDispatch) =>
      comptimeRuntime().executor.execute([representative], { maximumStepsPerDispatch })
    ),
  );
  for (const result of results) {
    ok(result.ok, result.ok ? undefined : JSON.stringify(result));
    if (!result.ok) continue;
    deepStrictEqual(
      result.exports.map((exported) => exported.value),
      representativeExpressions.map(({ expected }) => expected),
    );
  }
  const successful = results.filter((result) => result.ok);
  deepStrictEqual(
    successful.map((result) => result.stats.evaluation.steps),
    successful.map(() => successful[0]!.stats.evaluation.steps),
  );

  const runtimeArtifact: FunctionalModuleArtifact = { ...module, options: {} };
  const linked = linkFunctionalModules(
    [runtimeArtifact],
    { module: module.name, exportName: "i64OverflowDivide" },
  );
  const compilation = await comptimeRuntime().compiler.compileModule(linked.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (compilation.ok) {
    try {
      const execution = await runFunctionalWasmModule(compilation.module);
      deepStrictEqual(execution.value, {
        kind: "signed-integer-64",
        value: -0x8000000000000000n,
      });
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("bounded IEEE comptime preserves division, NaN, infinity, and signed zero", async () => {
  const expressions = [
    numericDefinition(
      "f32Divide",
      surface.binary(
        FunctionalBinaryOperator.DivideFloat32,
        surface.float32(22),
        surface.float32(7),
      ),
      { kind: "float-32" },
      { kind: "float-32", value: Math.fround(Math.fround(22) / Math.fround(7)) },
    ),
    numericDefinition(
      "f32SquareRoot",
      surface.unary(FunctionalUnaryOperator.SquareRootFloat32, surface.float32(81)),
      { kind: "float-32" },
      { kind: "float-32", value: 9 },
    ),
    numericDefinition(
      "f32NegativeZero",
      surface.float32(-0),
      { kind: "float-32" },
      { kind: "float-32", value: -0 },
    ),
    numericDefinition(
      "f64NanComparison",
      surface.binary(
        FunctionalBinaryOperator.EqualFloat64,
        surface.float64(NaN),
        surface.float64(NaN),
      ),
      { kind: "boolean" },
      { kind: "boolean", value: false },
    ),
    numericDefinition(
      "f64Infinity",
      surface.binary(
        FunctionalBinaryOperator.AddFloat64,
        surface.float64(Infinity),
        surface.float64(1),
      ),
      { kind: "float-64" },
      { kind: "float-64", value: Infinity },
    ),
  ] as const;
  const module: FunctionalComptimeModuleArtifact = {
    name: "ieee-comptime",
    definitions: expressions.map(({ name, expression }) => ({
      name,
      parameters: [],
      annotation: null,
      body: expression,
    })),
    typeDeclarations: [],
    imports: [],
    exports: expressions.map(({ name, type }) => ({ name, definition: name, type })),
    sourceByteLength: 100,
  };
  const result = await comptimeRuntime().executor.execute([module]);
  ok(result.ok, result.ok ? undefined : JSON.stringify(result));
  if (!result.ok) return;
  deepStrictEqual(
    result.exports.map((exported) => exported.value),
    expressions.map(({ expected }) => expected),
  );

  const invalidConversion = await comptimeRuntime().executor.execute([
    constantModule(
      "invalid-conversion",
      surface.convert(
        FunctionalNumericConversion.Float32ToSignedInteger32,
        surface.float32(NaN),
      ),
      { kind: "integer" },
    ),
  ]);
  equal(invalidConversion.ok, false);
  if (!invalidConversion.ok) {
    equal(invalidConversion.stage, "execute");
    if (invalidConversion.stage === "execute") {
      equal(invalidConversion.fault.kind, "invalid-numeric-conversion");
    }
  }
  const invalidFloat64Conversion = await comptimeRuntime().executor.execute([
    constantModule(
      "invalid-float64-conversion",
      surface.convert(
        FunctionalNumericConversion.Float64ToSignedInteger32,
        surface.float64(Infinity),
      ),
      { kind: "integer" },
    ),
  ]);
  equal(invalidFloat64Conversion.ok, false);
  if (!invalidFloat64Conversion.ok) {
    equal(invalidFloat64Conversion.stage, "execute");
    if (invalidFloat64Conversion.stage === "execute") {
      equal(invalidFloat64Conversion.fault.kind, "invalid-numeric-conversion");
    }
  }
});

Deno.test("bounded f64 comptime succeeds exactly at its derived semantic fuel threshold", async () => {
  const module: FunctionalComptimeModuleArtifact = {
    name: "float64-threshold",
    definitions: [{
      name: "countdown",
      parameters: ["remaining"],
      annotation: null,
      body: {
        kind: "if",
        condition: surface.binary(
          FunctionalBinaryOperator.Equal,
          surface.name("remaining"),
          surface.integer(0),
        ),
        consequent: surface.binary(
          FunctionalBinaryOperator.DivideFloat64,
          surface.float64(22),
          surface.float64(7),
        ),
        alternate: surface.apply(
          surface.name("countdown"),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      },
    }, {
      name: "value",
      parameters: [],
      annotation: null,
      body: surface.apply(surface.name("countdown"), surface.integer(32)),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "value", definition: "value", type: { kind: "float-64" } }],
    sourceByteLength: 80,
  };
  let lower = 0;
  let upper = 4_096;
  while (lower + 1 < upper) {
    const candidate = Math.floor((lower + upper) / 2);
    const result = await comptimeRuntime().executor.execute([module], {
      maximumExecutionSteps: candidate,
    });
    if (result.ok) upper = candidate;
    else lower = candidate;
  }
  const exhausted = await comptimeRuntime().executor.execute([module], {
    maximumExecutionSteps: upper - 1,
  });
  equal(exhausted.ok, false);
  if (!exhausted.ok) {
    equal(exhausted.stage, "execute");
    if (exhausted.stage === "execute") equal(exhausted.fault.kind, "out-of-fuel");
  }
  const completed = await comptimeRuntime().executor.execute([module], {
    maximumExecutionSteps: upper,
  });
  ok(completed.ok, completed.ok ? undefined : JSON.stringify(completed));
  if (completed.ok) {
    equal(completed.stats.evaluation.steps, upper);
    deepStrictEqual(completed.exports[0]?.value, { kind: "float-64", value: 22 / 7 });
  }
});

Deno.test("comptime constants round-trip wide numerics and reject malformed buffers", () => {
  const constant: FunctionalConstant = {
    kind: "constructor",
    name: "Example",
    fields: [
      { kind: "signed-integer-64", value: -9_223_372_036_854_775_808n },
      { kind: "float-64", value: NaN },
      { kind: "float-32", value: -0 },
    ],
  };
  const decoded = decodeFunctionalConstant(encodeFunctionalConstant(constant));
  equal(decoded.kind, "constructor");
  if (decoded.kind !== "constructor") return;
  deepStrictEqual(decoded.fields[0], constant.fields[0]);
  ok(decoded.fields[1]?.kind === "float-64" && Number.isNaN(decoded.fields[1].value));
  ok(decoded.fields[2]?.kind === "float-32" && Object.is(decoded.fields[2].value, -0));
  throws(
    () => decodeFunctionalConstant(new TextEncoder().encode("not-json")),
    /not valid UTF-8 JSON/,
  );
  const cyclic = { kind: "constructor", name: "Cycle", fields: [] } as unknown as {
    kind: "constructor";
    name: string;
    fields: FunctionalConstant[];
  };
  cyclic.fields.push(cyclic);
  throws(() => validateFunctionalConstant(cyclic), /contains a cycle/);
});

Deno.test("incremental comptime invalidates consumers only when an exported constant changes", async () => {
  const cache = new MemoryFunctionalIncrementalCache();
  const incremental = new IncrementalGpuFunctionalComptimeExecutor(
    comptimeRuntime().executor,
    { cache },
  );
  const library = (
    body: FunctionalComptimeModuleArtifact["definitions"][number]["body"],
  ): FunctionalComptimeModuleArtifact => ({
    name: "library",
    definitions: [{ name: "base", parameters: [], annotation: null, body }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "base", definition: "base", type: { kind: "integer" } }],
    sourceByteLength: 10,
  });
  const application: FunctionalComptimeModuleArtifact = {
    name: "application",
    definitions: [{
      name: "answer",
      parameters: [],
      annotation: null,
      body: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.name("base"),
        surface.integer(2),
      ),
    }],
    typeDeclarations: [],
    imports: [{
      name: "base",
      fromModule: "library",
      exportName: "base",
      type: { kind: "integer" },
    }],
    exports: [{ name: "answer", definition: "answer", type: { kind: "integer" } }],
    sourceByteLength: 10,
  };

  const first = await incremental.execute([library(surface.integer(40)), application]);
  ok(first.ok, first.ok ? undefined : JSON.stringify(first.failure));
  if (!first.ok) return;
  deepStrictEqual(first.incremental.compiledModules, ["application", "library"]);

  const equivalent = await incremental.execute([
    library(surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(20),
      surface.integer(20),
    )),
    application,
  ]);
  ok(equivalent.ok, equivalent.ok ? undefined : JSON.stringify(equivalent.failure));
  if (!equivalent.ok) return;
  deepStrictEqual(equivalent.incremental.compiledModules, ["library"]);
  deepStrictEqual(equivalent.incremental.reusedModules, ["application"]);
  deepStrictEqual(equivalent.exports.map((exported) => exported.value), [
    { kind: "integer", value: 40 },
    { kind: "integer", value: 42 },
  ]);

  const changed = await incremental.execute([library(surface.integer(41)), application]);
  ok(changed.ok, changed.ok ? undefined : JSON.stringify(changed.failure));
  if (!changed.ok) return;
  deepStrictEqual(changed.incremental.compiledModules, ["application", "library"]);
  deepStrictEqual(changed.exports.map((exported) => exported.value), [
    { kind: "integer", value: 41 },
    { kind: "integer", value: 43 },
  ]);
});

Deno.test("Type Core descriptors are ordinary comptime ADTs", async () => {
  const descriptor = functionalConstantFromTypeCoreValue({
    kind: "type",
    type: {
      kind: "named",
      name: "List",
      arguments: [{ kind: "type", type: { kind: "integer" } }],
    },
  });
  const module: FunctionalComptimeModuleArtifact = {
    name: "reflection",
    definitions: [{
      name: "descriptor",
      parameters: [],
      annotation: FUNCTIONAL_COMPTIME_DESCRIPTOR_SCHEMA,
      body: functionalConstantExpression(descriptor),
    }],
    typeDeclarations: FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPES,
    imports: [],
    exports: [{
      name: "descriptor",
      definition: "descriptor",
      type: FUNCTIONAL_COMPTIME_DESCRIPTOR_SCHEMA,
    }],
    sourceByteLength: 10,
  };
  const result = await comptimeRuntime().executor.execute([module]);
  ok(result.ok, result.ok ? undefined : JSON.stringify(result));
  if (!result.ok) return;
  const value = result.exports[0]?.value;
  ok(value?.kind === "constructor");
  if (value?.kind === "constructor") {
    equal(value.name, "reflection::$ComptimeDescriptorType");
  }
});

Deno.test("partial evaluation folds required constants and silently preserves failed attempts", async () => {
  const artifact: FunctionalModuleArtifact = {
    name: "application",
    definitions: [{
      name: "answer",
      parameters: [],
      annotation: null,
      body: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.integer(20),
        surface.integer(22),
      ),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "answer", definition: "answer", type: { kind: "integer" } }],
    sourceByteLength: 10,
    options: {},
  };
  const folded = await partiallyEvaluateFunctionalModule(
    comptimeRuntime().executor,
    artifact,
  );
  deepStrictEqual(folded.foldedDefinitions, ["answer"]);
  deepStrictEqual(folded.artifact.definitions[0]?.body, { kind: "integer", value: 42 });

  const linked = linkFunctionalModules(
    [folded.artifact],
    { module: "application", exportName: "answer" },
  );
  const compilation = await comptimeRuntime().compiler.compileModule(linked.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (compilation.ok) {
    try {
      const execution = await runFunctionalWasmModule(compilation.module);
      deepStrictEqual(execution.value, { kind: "integer", value: 42 });
    } finally {
      compilation.module.destroy();
    }
  }

  const faulting: FunctionalModuleArtifact = {
    ...artifact,
    definitions: [{
      ...artifact.definitions[0]!,
      body: surface.binary(
        FunctionalBinaryOperator.Divide,
        surface.integer(1),
        surface.integer(0),
      ),
    }],
  };
  const unchanged = await partiallyEvaluateFunctionalModule(
    comptimeRuntime().executor,
    faulting,
  );
  deepStrictEqual(unchanged.foldedDefinitions, []);
  equal(unchanged.skipped?.stage, "execute");
  deepStrictEqual(unchanged.artifact.definitions[0]?.body, faulting.definitions[0]?.body);
});

function constantModule(
  name: string,
  body: FunctionalComptimeModuleArtifact["definitions"][number]["body"],
  type: FunctionalComptimeModuleArtifact["exports"][number]["type"],
): FunctionalComptimeModuleArtifact {
  return {
    name,
    definitions: [{ name: "value", parameters: [], annotation: null, body }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "value", definition: "value", type }],
    sourceByteLength: 10,
  };
}

function numericDefinition(
  name: string,
  expression: FunctionalComptimeModuleArtifact["definitions"][number]["body"],
  type: FunctionalComptimeModuleArtifact["exports"][number]["type"],
  expected: FunctionalConstant,
): {
  readonly name: string;
  readonly expression: FunctionalComptimeModuleArtifact["definitions"][number]["body"];
  readonly type: FunctionalComptimeModuleArtifact["exports"][number]["type"];
  readonly expected: FunctionalConstant;
} {
  return { name, expression, type, expected };
}

function tuple(
  first: FunctionalComptimeModuleArtifact["definitions"][number]["body"],
  second: FunctionalComptimeModuleArtifact["definitions"][number]["body"],
): FunctionalComptimeModuleArtifact["definitions"][number]["body"] {
  return surface.apply(
    surface.apply(surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME), first),
    second,
  );
}
