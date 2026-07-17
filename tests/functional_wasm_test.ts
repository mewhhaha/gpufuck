import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";

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
  FunctionalHostTypes,
  FunctionalLinkError,
  FunctionalNumericConversion,
  type FunctionalSurfaceExpression,
  type FunctionalTypeSchema,
  FunctionalUnaryOperator,
  FunctionalWasmBoundaryError,
  type FunctionalWasmExecution,
  FunctionalWasmRuntimeError,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  linkFunctionalModules,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  runFunctionalWasmModuleAsync,
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
    await assertWasmMatchesGpu(
      loweredRustModule(await Deno.readTextFile(path)),
      expected,
      path,
    );
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
    await assertWasmMatchesGpu(
      loweredHaskellModule(await Deno.readTextFile(path)),
      42,
      path,
    );
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
    await assertWasmMatchesGpu(
      loweredOcamlModule(await Deno.readTextFile(path)),
      42,
      path,
    );
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
      [{
        name: "main",
        parameters: [],
        annotation: null,
        body: testCase.expression,
      }],
      [],
      "main",
      0,
    );
    const compilation = await functionalWasmRuntime().compiler.compileModule(
      module,
    );
    ok(
      compilation.ok,
      compilation.ok ? undefined : compilation.diagnostics[0].message,
    );
    if (!compilation.ok) {
      throw new Error(`scalar WASM case ${index} did not compile`);
    }
    try {
      const oracle = await functionalWasmRuntime().evaluator.evaluate(
        compilation.module,
      );
      ok(oracle.ok, oracle.ok ? undefined : oracle.fault.message);
      if (!oracle.ok) {
        throw new Error(
          `scalar WASM case ${index} did not evaluate on the GPU`,
        );
      }
      deepStrictEqual(oracle.value, testCase.expected);
      const execution = await runFunctionalWasmModule(compilation.module);
      deepStrictEqual(execution.value, testCase.expected);
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("GPU typechecks and WebAssembly executes i64, f32, f64, and numeric conversions", async () => {
  const cases = [
    {
      expression: surface.binary(
        FunctionalBinaryOperator.AddSignedInteger64,
        surface.signedInteger64(9_007_199_254_740_992n),
        surface.signedInteger64(17n),
      ),
      expected: {
        kind: "signed-integer-64",
        value: 9_007_199_254_741_009n,
      } as const,
    },
    {
      expression: surface.binary(
        FunctionalBinaryOperator.MultiplyFloat32,
        surface.float32(1.5),
        surface.float32(4),
      ),
      expected: { kind: "float-32", value: 6 } as const,
    },
    {
      expression: surface.binary(
        FunctionalBinaryOperator.DivideFloat64,
        surface.float64(22),
        surface.float64(7),
      ),
      expected: { kind: "float-64", value: 22 / 7 } as const,
    },
    {
      expression: surface.convert(
        FunctionalNumericConversion.SignedInteger64ToFloat64,
        surface.signedInteger64(42n),
      ),
      expected: { kind: "float-64", value: 42 } as const,
    },
  ];
  for (const testCase of cases) {
    const encoded = buildFunctionalSurfaceModule(
      [{
        name: "main",
        parameters: [],
        annotation: null,
        body: testCase.expression,
      }],
      [],
      "main",
      0,
    );
    const compilation = await functionalWasmRuntime().compiler.compileModule(
      encoded,
    );
    if (!compilation.ok) {
      throw new Error(
        `numeric module did not compile: ${JSON.stringify(compilation.diagnostics)}`,
      );
    }
    try {
      const execution = await runFunctionalWasmModule(compilation.module);
      deepStrictEqual(execution.value, testCase.expected);
      const evaluation = await functionalWasmRuntime().evaluator.evaluate(
        compilation.module,
      );
      ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
      if (evaluation.ok) deepStrictEqual(evaluation.value, testCase.expected);
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("executes every explicit numeric conversion", async () => {
  const cases = [
    [
      FunctionalNumericConversion.SignedInteger32ToSignedInteger64,
      surface.integer(-42),
      { kind: "signed-integer-64", value: -42n },
    ],
    [
      FunctionalNumericConversion.SignedInteger64ToSignedInteger32,
      surface.signedInteger64(-42n),
      { kind: "integer", value: -42 },
    ],
    [
      FunctionalNumericConversion.SignedInteger32ToFloat32,
      surface.integer(-42),
      { kind: "float-32", value: -42 },
    ],
    [
      FunctionalNumericConversion.SignedInteger32ToFloat64,
      surface.integer(-42),
      { kind: "float-64", value: -42 },
    ],
    [
      FunctionalNumericConversion.SignedInteger64ToFloat32,
      surface.signedInteger64(42n),
      { kind: "float-32", value: 42 },
    ],
    [
      FunctionalNumericConversion.SignedInteger64ToFloat64,
      surface.signedInteger64(42n),
      { kind: "float-64", value: 42 },
    ],
    [
      FunctionalNumericConversion.Float32ToSignedInteger32,
      surface.float32(42.75),
      { kind: "integer", value: 42 },
    ],
    [
      FunctionalNumericConversion.Float32ToSignedInteger64,
      surface.float32(42.75),
      { kind: "signed-integer-64", value: 42n },
    ],
    [
      FunctionalNumericConversion.Float32ToFloat64,
      surface.float32(1.5),
      { kind: "float-64", value: 1.5 },
    ],
    [
      FunctionalNumericConversion.Float64ToSignedInteger32,
      surface.float64(42.75),
      { kind: "integer", value: 42 },
    ],
    [
      FunctionalNumericConversion.Float64ToSignedInteger64,
      surface.float64(42.75),
      { kind: "signed-integer-64", value: 42n },
    ],
    [
      FunctionalNumericConversion.Float64ToFloat32,
      surface.float64(1.1),
      { kind: "float-32", value: Math.fround(1.1) },
    ],
  ] as const;
  for (const [conversion, input, expected] of cases) {
    const encoded = buildFunctionalSurfaceModule(
      [{
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.convert(conversion, input),
      }],
      [],
      "main",
      0,
    );
    const compilation = await functionalWasmRuntime().compiler.compileModule(
      encoded,
    );
    if (!compilation.ok) {
      throw new Error(`numeric conversion ${conversion} did not compile`);
    }
    try {
      const execution = await runFunctionalWasmModule(compilation.module);
      deepStrictEqual(execution.value, expected);
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("executes remainder, bit operations, square root, and bit reinterpretation", async () => {
  const cases = [
    [
      surface.binary(
        FunctionalBinaryOperator.Remainder,
        surface.integer(-17),
        surface.integer(5),
      ),
      { kind: "integer", value: -2 },
    ],
    [
      surface.binary(
        FunctionalBinaryOperator.BitwiseXor,
        surface.integer(0x55aa),
        surface.integer(0x0f0f),
      ),
      { kind: "integer", value: 0x5aa5 },
    ],
    [
      surface.binary(
        FunctionalBinaryOperator.ShiftRightUnsigned,
        surface.integer(-1),
        surface.integer(4),
      ),
      { kind: "integer", value: 0x0fff_ffff },
    ],
    [
      surface.binary(
        FunctionalBinaryOperator.RemainderSignedInteger64,
        surface.signedInteger64(-17n),
        surface.signedInteger64(5n),
      ),
      { kind: "signed-integer-64", value: -2n },
    ],
    [
      surface.unary(
        FunctionalUnaryOperator.SquareRootFloat32,
        surface.float32(81),
      ),
      { kind: "float-32", value: 9 },
    ],
    [
      surface.convert(
        FunctionalNumericConversion.ReinterpretFloat32AsSignedInteger32,
        surface.float32(1),
      ),
      { kind: "integer", value: 1_065_353_216 },
    ],
    [
      surface.convert(
        FunctionalNumericConversion.ReinterpretSignedInteger32AsFloat32,
        surface.integer(1_065_353_216),
      ),
      { kind: "float-32", value: 1 },
    ],
  ] as const;
  for (const [expression, expected] of cases) {
    const encoded = buildFunctionalSurfaceModule(
      [{ name: "main", parameters: [], annotation: null, body: expression }],
      [],
      "main",
      0,
    );
    const compilation = await functionalWasmRuntime().compiler.compileModule(
      encoded,
    );
    if (!compilation.ok) {
      throw new Error(
        `extended primitive did not compile: ${compilation.diagnostics[0].message}`,
      );
    }
    try {
      const execution = await runFunctionalWasmModule(compilation.module);
      deepStrictEqual(execution.value, expected);
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("wide numeric primitives cross functions and structured WebAssembly values", async () => {
  const i64 = { kind: "signed-integer-64" } as const;
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["value"],
      annotation: { kind: "function", parameter: i64, result: i64 },
      body: surface.binary(
        FunctionalBinaryOperator.AddSignedInteger64,
        surface.name("value"),
        surface.signedInteger64(1n),
      ),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) throw new Error("wide numeric function did not compile");
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      argument: { kind: "signed-integer-64", value: 9_007_199_254_740_992n },
    });
    deepStrictEqual(execution.value, {
      kind: "signed-integer-64",
      value: 9_007_199_254_740_993n,
    });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("round-trips text, bytes, arrays, slices, and resources through WebAssembly", async () => {
  const integer = { kind: "integer" } as const;
  const cases = [
    [FunctionalHostTypes.text, { kind: "text", value: "Zażółć 🦆" }],
    [FunctionalHostTypes.bytes, {
      kind: "bytes",
      value: new Uint8Array([0, 127, 128, 255]),
    }],
    [
      FunctionalHostTypes.array(integer),
      {
        kind: "array",
        values: [{ kind: "integer", value: 1 }, { kind: "integer", value: -2 }],
      },
    ],
    [
      FunctionalHostTypes.slice(FunctionalHostTypes.text),
      {
        kind: "slice",
        values: [{ kind: "text", value: "first" }, {
          kind: "text",
          value: "second",
        }],
      },
    ],
    [FunctionalHostTypes.resource("duck.file"), { kind: "resource", id: 42 }],
  ] as const;
  for (const [type, value] of cases) {
    const encoded = buildFunctionalSurfaceModule(
      [{
        name: "main",
        parameters: ["value"],
        annotation: { kind: "function", parameter: type, result: type },
        body: surface.name("value"),
      }],
      [],
      "main",
      0,
    );
    const compilation = await functionalWasmRuntime().compiler.compileModule(
      encoded,
    );
    if (!compilation.ok) {
      throw new Error(
        `boundary value did not compile: ${compilation.diagnostics[0].message}`,
      );
    }
    try {
      const execution = await runFunctionalWasmModule(compilation.module, {
        argument: value,
        argumentOwnership: "ownership-transfer",
      });
      deepStrictEqual(execution.value, value);
      const freeListHead = execution.instance.exports.freeListHead;
      const allocate = execution.instance.exports.allocate;
      const free = execution.instance.exports.free;
      ok(freeListHead instanceof WebAssembly.Global);
      ok(typeof allocate === "function");
      ok(typeof free === "function");
      const releasedPointer = Number(freeListHead.value);
      ok(releasedPointer !== 0);
      const reusedPointer = allocate(8) as number;
      equal(reusedPointer, releasedPointer);
      free(reusedPointer, 8);
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("returns structured tuples through the stable WebAssembly aggregate ABI", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(
        surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
        surface.integer(20),
        surface.boolean(true),
      ),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) {
    throw new Error("structured tuple module did not compile");
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, {
      kind: "tuple",
      values: [{ kind: "integer", value: 20 }, {
        kind: "boolean",
        value: true,
      }],
    });
    await rejects(
      () => runFunctionalWasmModule(compilation.module, { maximumResultNodes: 2 }),
      (error) => {
        ok(error instanceof FunctionalWasmRuntimeError);
        equal(error.code, "F3010");
        equal(error.kind, "result-too-large");
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("accepts structured values through the stable WebAssembly aggregate ABI", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["value"],
      annotation: {
        kind: "function",
        parameter: {
          kind: "tuple",
          values: [{ kind: "integer" }, { kind: "boolean" }],
        },
        result: { kind: "integer" },
      },
      body: {
        kind: "case",
        value: surface.name("value"),
        arms: [{
          constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
          binders: ["first", "second"],
          body: surface.name("first"),
        }],
      },
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) {
    throw new Error("structured input module did not compile");
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      argument: {
        kind: "tuple",
        values: [{ kind: "integer", value: 42 }, {
          kind: "boolean",
          value: true,
        }],
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
    await rejects(
      () =>
        runFunctionalWasmModule(compilation.module, {
          argument: { kind: "boolean", value: true },
        }),
      (error) => {
        ok(error instanceof FunctionalWasmBoundaryError);
        equal(error.code, "F4101");
        equal(error.kind, "invalid-argument");
        equal(error.path, "argument");
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("decodes indexed constructor fields using the selected result refinement", async () => {
  const zero: FunctionalTypeSchema = {
    kind: "named",
    name: "Zero",
    arguments: [],
  };
  const vector = (length: FunctionalTypeSchema): FunctionalTypeSchema => ({
    kind: "named",
    name: "Vector",
    arguments: [length],
  });
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(
        surface.name("Cons"),
        surface.integer(42),
        surface.name("Nil"),
      ),
    }],
    [
      { name: "Zero", parameters: [], constructors: [] },
      { name: "Next", parameters: ["value"], constructors: [] },
      {
        name: "Vector",
        parameters: ["length"],
        constructors: [
          { name: "Nil", fields: [], result: vector(zero) },
          {
            name: "Cons",
            fields: [
              { name: "head", type: { kind: "integer" } },
              {
                name: "tail",
                type: vector({ kind: "parameter", name: "length" }),
              },
            ],
            result: vector({
              kind: "named",
              name: "Next",
              arguments: [{ kind: "parameter", name: "length" }],
            }),
          },
        ],
      },
    ],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) {
    throw new Error("indexed structured result module did not compile");
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, {
      kind: "constructor",
      name: "Cons",
      fields: [
        { kind: "integer", value: 42 },
        { kind: "constructor", name: "Nil", fields: [] },
      ],
    });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("passes aggregate host capabilities through the shared WebAssembly value ABI", async () => {
  const boxType = {
    name: "Box",
    parameters: [],
    constructors: [{
      name: "Box",
      fields: [{ name: "value", type: { kind: "integer" } as const }],
    }],
  } as const;
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
          binders: ["box"],
          body: surface.name("box"),
        }],
      },
    }],
    [boxType],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Environment",
        fields: [{
          kind: "value",
          name: "box",
          type: { kind: "named", name: "Box", arguments: [] },
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) {
    throw new Error("aggregate host capability module did not compile");
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Environment: {
          box: {
            kind: "constructor",
            name: "Box",
            fields: [{ kind: "integer", value: 42 }],
          },
        },
      },
    });
    deepStrictEqual(execution.value, {
      kind: "constructor",
      name: "Box",
      fields: [{ kind: "integer", value: 42 }],
    });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("calls aggregate host operations through the shared WebAssembly value ABI", async () => {
  const boxType = { kind: "named", name: "Box", arguments: [] } as const;
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
          binders: ["increment"],
          body: surface.apply(
            surface.name("increment"),
            surface.apply(surface.name("Box"), surface.integer(41)),
          ),
        }],
      },
    }],
    [{
      name: "Box",
      parameters: [],
      constructors: [{
        name: "Box",
        fields: [{ name: "value", type: { kind: "integer" } }],
      }],
    }],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Environment",
        fields: [{
          kind: "operation",
          name: "increment",
          purity: "pure",
          parameter: boxType,
          result: boxType,
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) {
    throw new Error("aggregate host operation module did not compile");
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Environment: {
          increment: (argument) => {
            if (argument.kind !== "constructor") {
              throw new Error("expected Box argument");
            }
            return {
              kind: "constructor",
              name: "Box",
              fields: [{ kind: "integer", value: 42 }],
            };
          },
        },
      },
    });
    deepStrictEqual(execution.value, {
      kind: "constructor",
      name: "Box",
      fields: [{ kind: "integer", value: 42 }],
    });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("direct execution rejects suspending host operations with the async runner name", async () => {
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
          binders: ["read"],
          body: surface.integer(42),
        }],
      },
    }],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Environment",
        fields: [{
          kind: "operation",
          name: "read",
          purity: "effectful",
          execution: "suspending",
          parameter: { kind: "unit" },
          result: { kind: "integer" },
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) {
    throw new Error("suspending host operation module did not compile");
  }
  try {
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      /Environment\.read.*suspending.*direct WASM ABI is synchronous.*runFunctionalWasmModuleAsync/,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("async execution resumes suspending operations without replaying completed effects", async () => {
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
          binders: ["tick", "read"],
          body: {
            kind: "let",
            name: "ignored",
            valueEvaluation: FunctionalEvaluationProfile.StrictEager,
            value: surface.apply(
              surface.name("tick"),
              surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
            ),
            body: surface.apply(
              surface.name("read"),
              surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
            ),
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
        fields: [
          {
            kind: "operation",
            name: "tick",
            purity: "effectful",
            parameter: { kind: "unit" },
            result: { kind: "unit" },
          },
          {
            kind: "operation",
            name: "read",
            purity: "effectful",
            execution: "suspending",
            parameter: { kind: "unit" },
            result: { kind: "integer" },
          },
        ],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) {
    throw new Error("async host operation module did not compile");
  }
  let tickCalls = 0;
  let readCalls = 0;
  try {
    const execution = await runFunctionalWasmModuleAsync(compilation.module, {
      init: {
        Environment: {
          tick: () => {
            tickCalls += 1;
            return { kind: "unit" };
          },
          read: async () => {
            readCalls += 1;
            await Promise.resolve();
            return { kind: "integer", value: 42 };
          },
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
    equal(tickCalls, 1);
    equal(readCalls, 1);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("emits multiple annotated definitions as persistent WebAssembly callables", async () => {
  const integer = { kind: "integer" } as const;
  const encoded = buildFunctionalSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.integer(0),
      },
      {
        name: "increment",
        parameters: ["value"],
        annotation: { kind: "function", parameter: integer, result: integer },
        body: surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("value"),
          surface.integer(1),
        ),
      },
      {
        name: "add",
        parameters: ["left", "right"],
        annotation: {
          kind: "function",
          parameter: integer,
          result: { kind: "function", parameter: integer, result: integer },
        },
        body: surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("left"),
          surface.name("right"),
        ),
      },
      {
        name: "answer",
        parameters: [],
        annotation: integer,
        body: surface.integer(42),
      },
    ],
    [],
    "main",
    0,
    {
      wasmExports: [
        { name: "duck_increment", definition: "increment" },
        { name: "duck_add", definition: "add" },
        { name: "duck_answer", definition: "answer" },
      ],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    encoded,
  );
  if (!compilation.ok) throw new Error("multi-callable module did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const instantiated = await WebAssembly.instantiate(bytes);
    const increment = instantiated.instance.exports.duck_increment;
    const add = instantiated.instance.exports.duck_add;
    const answer = instantiated.instance.exports.duck_answer;
    ok(typeof increment === "function");
    ok(typeof add === "function");
    ok(typeof answer === "function");
    equal(increment((41n << 3n) | 1n), 42);
    equal(add((20n << 3n) | 1n, (22n << 3n) | 1n), 42);
    equal(answer(), 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("links typed imports and exports from separately prepared functional modules", async () => {
  const integerFunction = {
    kind: "function",
    parameter: { kind: "integer" },
    result: { kind: "integer" },
  } as const;
  const linked = linkFunctionalModules([
    {
      name: "math",
      definitions: [{
        name: "double",
        parameters: ["value"],
        annotation: null,
        body: surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("value"),
          surface.name("value"),
        ),
      }],
      typeDeclarations: [],
      imports: [],
      exports: [{
        name: "double",
        definition: "double",
        type: integerFunction,
      }],
      sourceByteLength: 10,
      options: {},
    },
    {
      name: "application",
      definitions: [{
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.apply(surface.name("twice"), surface.integer(21)),
      }],
      typeDeclarations: [],
      imports: [{
        name: "twice",
        fromModule: "math",
        exportName: "double",
        type: integerFunction,
      }],
      exports: [{
        name: "main",
        definition: "main",
        type: { kind: "integer" },
      }],
      sourceByteLength: 20,
      options: {},
    },
  ], { module: "application", exportName: "main" });
  deepStrictEqual(linked.sources, [
    { module: "math", startByte: 0, endByte: 10 },
    { module: "application", startByte: 10, endByte: 30 },
  ]);
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    linked.module,
  );
  if (!compilation.ok) {
    throw new Error(
      `linked functional modules did not compile: ${JSON.stringify(compilation.diagnostics)}`,
    );
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("link failures expose stable codes and the missing module reference", () => {
  const integerFunction = {
    kind: "function",
    parameter: { kind: "integer" },
    result: { kind: "integer" },
  } as const;
  throws(
    () =>
      linkFunctionalModules([{
        name: "application",
        definitions: [],
        typeDeclarations: [],
        imports: [{
          name: "missing",
          fromModule: "library",
          exportName: "answer",
          type: integerFunction,
        }],
        exports: [],
        sourceByteLength: 10,
        options: {},
      }], { module: "application", exportName: "main" }),
    (error) => {
      ok(error instanceof FunctionalLinkError);
      equal(error.code, "F4003");
      equal(error.kind, "missing-import");
      equal(error.module, "application");
      equal(error.reference, "library.answer");
      return true;
    },
  );
});

Deno.test("links nominal values through typed module boundaries", async () => {
  const boxType = { kind: "named", name: "Box", arguments: [] } as const;
  const linked = linkFunctionalModules([
    {
      name: "library",
      definitions: [{
        name: "boxed",
        parameters: [],
        annotation: null,
        body: surface.apply(surface.name("Box"), surface.integer(42)),
      }],
      typeDeclarations: [{
        name: "Box",
        parameters: [],
        constructors: [{
          name: "Box",
          fields: [{ name: "value", type: { kind: "integer" } }],
        }],
      }],
      imports: [],
      exports: [{ name: "boxed", definition: "boxed", type: boxType }],
      sourceByteLength: 0,
      options: {},
    },
    {
      name: "application",
      definitions: [{
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.name("box"),
      }],
      typeDeclarations: [],
      imports: [{
        name: "box",
        fromModule: "library",
        exportName: "boxed",
        type: boxType,
      }],
      exports: [{ name: "main", definition: "main", type: boxType }],
      sourceByteLength: 0,
      options: {},
    },
  ], { module: "application", exportName: "main" });
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    linked.module,
  );
  if (!compilation.ok) throw new Error("nominal linked module did not compile");
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, {
      kind: "constructor",
      name: "library::Box",
      fields: [{ kind: "integer", value: 42 }],
    });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("passes immutable values and host operations to main through init", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    hostInitModule(
      surface.apply(
        surface.name("observe"),
        surface.apply(surface.name("increment"), surface.name("base")),
      ),
    ),
  );
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
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
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("ordered host operation module did not compile");
  }
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
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    module,
  );
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("unit host effect module did not compile");
  }
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
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    module,
  );
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("unit host value module did not compile");
  }
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
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) throw new Error("host boundary module did not compile");
  try {
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      (error) => {
        ok(error instanceof FunctionalWasmBoundaryError);
        equal(error.code, "F4102");
        equal(error.kind, "invalid-init");
        equal(error.path, "init");
        return true;
      },
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
    surface.binary(
      FunctionalBinaryOperator.Divide,
      surface.integer(1),
      surface.integer(0),
    );
  const lazyExpressions: readonly FunctionalSurfaceExpression[] = [
    {
      kind: "let",
      name: "unused",
      value: divisionByZero(),
      body: surface.integer(42),
    },
    surface.apply(
      surface.lambda("unused", surface.integer(42)),
      divisionByZero(),
    ),
    {
      kind: "if",
      condition: surface.boolean(true),
      consequent: surface.integer(42),
      alternate: divisionByZero(),
    },
  ];
  for (const [index, expression] of lazyExpressions.entries()) {
    await assertLazyWasmResult(
      singleDefinitionModule(expression),
      42,
      1,
      `lazy case ${index}`,
    );
  }

  const lazyFieldModule = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: {
        kind: "case",
        value: surface.apply(surface.name("Box"), divisionByZero()),
        arms: [{
          constructor: "Box",
          binders: ["unused"],
          body: surface.integer(42),
        }],
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

  await assertLazyWasmResult(
    module,
    42,
    1,
    "unused recursive Haskell argument",
  );
});

Deno.test("strict evaluation faults on an unused function argument", async () => {
  const divisionByZero = surface.binary(
    FunctionalBinaryOperator.Divide,
    surface.integer(1),
    surface.integer(0),
  );
  const module = singleDefinitionModule(
    surface.apply(
      surface.lambda("unused", surface.integer(42)),
      divisionByZero,
    ),
    FunctionalEvaluationProfile.StrictEager,
  );
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("strict argument module did not compile");
  }
  try {
    equal(
      compilation.module.evaluationProfile,
      FunctionalEvaluationProfile.StrictEager,
    );
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes[0]?.evaluationMode, FunctionalEvaluationMode.StrictEager);
    const gpuExecution = await evaluator.evaluate(compilation.module);
    equal(gpuExecution.ok, false);
    if (gpuExecution.ok) {
      throw new Error("GPU evaluator skipped a strict argument");
    }
    equal(gpuExecution.fault.kind, "divide-by-zero");
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      (error) => {
        ok(error instanceof FunctionalWasmRuntimeError);
        equal(error.code, "F3007");
        equal(error.kind, "divide-by-zero");
        ok(error.cause instanceof WebAssembly.RuntimeError);
        return true;
      },
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
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("strict local binding module did not compile");
  }
  try {
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes[0]?.evaluationMode, FunctionalEvaluationMode.StrictEager);
    const gpuExecution = await evaluator.evaluate(compilation.module);
    equal(gpuExecution.ok, false);
    if (gpuExecution.ok) {
      throw new Error("GPU evaluator skipped a strict local binding");
    }
    equal(gpuExecution.fault.kind, "divide-by-zero");
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      (error) => {
        ok(error instanceof FunctionalWasmRuntimeError);
        equal(error.code, "F3007");
        equal(error.kind, "divide-by-zero");
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("WASM runtime faults identify their source module and expression span", async () => {
  const expression: FunctionalSurfaceExpression = {
    kind: "binary",
    operator: FunctionalBinaryOperator.Divide,
    left: { kind: "integer", value: 42, span: { startByte: 12, endByte: 14 } },
    right: { kind: "integer", value: 0, span: { startByte: 17, endByte: 18 } },
    span: { startByte: 12, endByte: 18 },
  };
  const encoded = buildFunctionalSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body: expression }],
    [],
    "main",
    24,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule({
    ...encoded,
    sources: [{ module: "main.duck", startByte: 0, endByte: 24 }],
  });
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("located runtime fault module did not compile");
  }
  try {
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      (error) => {
        ok(error instanceof FunctionalWasmRuntimeError);
        equal(error.code, "F3007");
        equal(error.entryName, "main");
        deepStrictEqual(error.span, { startByte: 12, endByte: 18 });
        deepStrictEqual(error.location, {
          module: "main.duck",
          span: { startByte: 12, endByte: 18 },
        });
        ok(error.coreNode !== undefined);
        return true;
      },
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
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("lazy argument override did not compile");
  }
  try {
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes[0]?.evaluationMode, FunctionalEvaluationMode.LazyCallByNeed);
    const gpuExecution = await evaluator.evaluate(compilation.module);
    ok(
      gpuExecution.ok,
      gpuExecution.ok ? undefined : gpuExecution.fault.message,
    );
    if (!gpuExecution.ok) {
      throw new Error("GPU evaluator forced a lazy argument override");
    }
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
  const module = singleDefinitionModule(
    expression,
    FunctionalEvaluationProfile.StrictEager,
  );
  const { compiler, evaluator } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("lazy numeric loop argument did not compile");
  }
  try {
    const gpuExecution = await evaluator.evaluate(compilation.module);
    ok(
      gpuExecution.ok,
      gpuExecution.ok ? undefined : gpuExecution.fault.message,
    );
    if (!gpuExecution.ok) {
      throw new Error("GPU evaluator forced a lazy numeric loop argument");
    }
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
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("lazy local binding override did not compile");
  }
  try {
    const nodes = await compilation.module.readCoreNodes();
    equal(nodes[0]?.evaluationMode, FunctionalEvaluationMode.LazyCallByNeed);
    const gpuExecution = await evaluator.evaluate(compilation.module);
    ok(
      gpuExecution.ok,
      gpuExecution.ok ? undefined : gpuExecution.fault.message,
    );
    if (!gpuExecution.ok) {
      throw new Error("GPU evaluator forced a lazy local binding override");
    }
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

  await assertLazyWasmResult(
    singleDefinitionModule(sharedValue),
    84,
    2,
    "shared local thunk",
  );
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

  await assertLazyWasmResult(
    singleDefinitionModule(strictBinding),
    42,
    1,
    "strict local binding",
  );
});

Deno.test("shares a let-bound suspension with a callee instead of wrapping it", async () => {
  const module = singleDefinitionModule({
    kind: "let",
    name: "shared",
    value: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(40),
      surface.integer(2),
    ),
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
        body: surface.binary(
          FunctionalBinaryOperator.Add,
          surface.integer(40),
          surface.integer(2),
        ),
      },
      {
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.apply(
          doubleWithoutImmediateForce(),
          surface.name("shared"),
        ),
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
  const closure = (
    body: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression => ({
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
          body: surface.apply(
            surface.name("storedFunction"),
            surface.integer(2),
          ),
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
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)).some((
      entry,
    ) => entry.kind === "memory"),
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

  deepStrictEqual(selectedCapturedFunction.value, {
    kind: "integer",
    value: 42,
  });
  deepStrictEqual(selectedCapturelessFunction.value, {
    kind: "integer",
    value: 4,
  });
  equal(
    selectedCapturedFunction.stats.allocatedBytes -
      selectedCapturelessFunction.stats.allocatedBytes,
    8,
  );
  ok(selectedCapturedFunction.stats.specializedCallSites >= 2);
  ok(selectedCapturelessFunction.stats.specializedCallSites >= 2);
});

Deno.test("omits thunk captures that the suspended expression does not reference", async () => {
  const applySuspension = (
    argument: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression => ({
    kind: "let",
    name: "outer",
    value: surface.integer(40),
    body: surface.apply(doubleWithoutImmediateForce(), argument),
  });
  const captured = await runCompiledWasm(singleDefinitionModule(applySuspension(
    surface.binary(
      FunctionalBinaryOperator.Add,
      surface.name("outer"),
      surface.integer(2),
    ),
  )));
  const pruned = await runCompiledWasm(singleDefinitionModule(applySuspension(
    surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(1),
      surface.integer(1),
    ),
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
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)).some((
      entry,
    ) => entry.kind === "memory"),
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
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)).some((
      entry,
    ) => entry.kind === "memory"),
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
            condition: surface.equal(
              surface.name("remaining"),
              surface.integer(0),
            ),
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
    surface.apply(
      surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
      surface.integer(20),
    ),
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
  const execution = await runCompiledWasm(
    singleDefinitionModule(surface.integer(42)),
  );

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 0);
});

Deno.test("reuses immutable WebAssembly artifacts across fresh executions", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    singleDefinitionModule(surface.integer(42)),
  );
  if (!compilation.ok) {
    throw new Error("cached WebAssembly module did not compile");
  }
  try {
    const firstBytes = await compileFunctionalModuleToWasm(compilation.module);
    firstBytes[0] = 0;
    const secondBytes = await compileFunctionalModuleToWasm(compilation.module);
    equal(WebAssembly.validate(secondBytes), true);

    const firstExecution = await runFunctionalWasmModule(compilation.module);
    firstExecution.bytes[0] = 0;
    const secondExecution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(secondExecution.value, { kind: "integer", value: 42 });
    equal(WebAssembly.validate(secondExecution.bytes), true);
    ok(firstExecution.instance !== secondExecution.instance);
  } finally {
    compilation.module.destroy();
  }
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
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) throw new Error("blackhole module did not compile");
  try {
    const oracle = await evaluator.evaluate(compilation.module);
    equal(oracle.ok, false);
    if (oracle.ok) {
      throw new Error("GPU oracle unexpectedly evaluated a cyclic thunk");
    }
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

async function runCompiledWasm(
  module: EncodedFunctionalModule,
): Promise<FunctionalWasmExecution> {
  const { compiler } = functionalWasmRuntime();
  const compilation = await compiler.compileModule(module);
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) {
    throw new Error("functional module did not compile on the GPU");
  }
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

function hostInitModule(
  expression: FunctionalSurfaceExpression,
): EncodedFunctionalModule {
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
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
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
  if (!compilation.ok) {
    throw new Error("functional example did not compile on the GPU");
  }
  try {
    const gpuEvaluation = await evaluator.evaluate(compilation.module);
    ok(
      gpuEvaluation.ok,
      gpuEvaluation.ok ? undefined : gpuEvaluation.fault.message,
    );
    if (!gpuEvaluation.ok) {
      throw new Error("functional example did not evaluate on the GPU");
    }
    deepStrictEqual(
      gpuEvaluation.value,
      { kind: "integer", value: expected },
      `${sourcePath} returned a different GPU value`,
    );

    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    equal(
      WebAssembly.validate(bytes),
      true,
      `${sourcePath} emitted invalid WebAssembly`,
    );
    const instantiated = await WebAssembly.instantiate(bytes);
    const main = instantiated.instance.exports.main;
    equal(typeof main, "function");
    equal(
      (main as () => number)(),
      expected,
      `${sourcePath} returned a different WASM value`,
    );
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
  if (runtime === undefined) {
    throw new Error("functional WASM test runtime was not initialized");
  }
  return runtime;
}
