import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";

import {
  beginFunctionalWasmArena,
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  type EncodedFunctionalModule,
  encodeFunctionalWasmArenaValue,
  encodeFunctionalWasmOwnedValue,
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationMode,
  FunctionalEvaluationProfile,
  FunctionalHostTypes,
  FunctionalLinkError,
  FunctionalNumericConversion,
  FunctionalPersistentSharing,
  type FunctionalSurfaceExpression,
  type FunctionalType,
  type FunctionalTypeSchema,
  FunctionalUnaryOperator,
  type FunctionalWasmAsyncInit,
  FunctionalWasmBoundaryError,
  type FunctionalWasmExecution,
  type FunctionalWasmInit,
  FunctionalWasmIntrinsic,
  type FunctionalWasmRunOptions,
  FunctionalWasmRuntimeError,
  type FunctionalWasmValue,
  FunctionalWasmValueAbi,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  linkFunctionalModules,
  markFunctionalWasmScratch,
  planFunctionalModuleStorage,
  promoteFunctionalWasmArenaValueToOwned,
  promoteFunctionalWasmArenaValueToParent,
  requestWebGpuDevice,
  resetFunctionalWasmScratch,
  runFunctionalWasmModule,
  runFunctionalWasmModuleAsync,
  surface,
  withFunctionalWasmArena,
} from "../functional.ts";
import { lowerHaskellFunctionalSource } from "../haskell_functional.ts";
import { lowerOcamlFunctionalSource } from "../ocaml_functional.ts";
import { lowerRustFunctionalSource } from "../rust_functional.ts";
import { decodeFunctionalWasmValue } from "../src/functional/wasm_value_codec.ts";

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
      ["examples/rust-functional/ownership.rs", 42],
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
      const heapTop = execution.instance.exports.heapTop;
      const allocate = execution.instance.exports.allocate;
      const free = execution.instance.exports.free;
      ok(freeListHead instanceof WebAssembly.Global);
      ok(heapTop instanceof WebAssembly.Global);
      ok(typeof allocate === "function");
      ok(typeof free === "function");
      equal(Number(freeListHead.value), 0);
      const reclaimedTop = Number(heapTop.value);
      const reusedPointer = allocate(8) as number;
      equal(reusedPointer, reclaimedTop);
      free(reusedPointer, 8);
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("reclaims bounded-borrow arguments when static thunks disable arena reset", async () => {
  const integer: FunctionalType = { kind: "integer" };
  const pair: FunctionalType = { kind: "tuple", values: [integer, integer] };
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "unused",
      parameters: [],
      annotation: null,
      body: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.integer(1),
        surface.integer(2),
      ),
    }, {
      name: "main",
      parameters: ["value"],
      annotation: { kind: "function", parameter: pair, result: pair },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("bounded-borrow cleanup fixture did not compile");
  try {
    const storage = await planFunctionalModuleStorage(compilation.module);
    equal(storage.summary.automaticArenaReset, false);
    const execution = await runFunctionalWasmModule(compilation.module, {
      argument: {
        kind: "tuple",
        values: [{ kind: "integer", value: 1 }, { kind: "integer", value: 2 }],
      },
    });
    const freeListHead = execution.instance.exports.freeListHead;
    const allocate = execution.instance.exports.allocate;
    ok(freeListHead instanceof WebAssembly.Global);
    ok(typeof allocate === "function");
    const reclaimedPointer = Number(freeListHead.value);
    ok(reclaimedPointer > 0);
    equal(allocate(32), reclaimedPointer);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("nested WebAssembly arenas reset in order without consuming owned free blocks", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["value"],
      annotation: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "integer" },
      },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("arena fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    const allocate = instance.exports.allocate;
    const free = instance.exports.free;
    const heapTop = instance.exports.heapTop;
    const freeListHead = instance.exports.freeListHead;
    ok(typeof initialize === "function");
    ok(typeof allocate === "function");
    ok(typeof free === "function");
    ok(heapTop instanceof WebAssembly.Global);
    ok(freeListHead instanceof WebAssembly.Global);
    initialize();

    const ownedPointer = allocate(8) as number;
    free(ownedPointer, 8);
    equal(Number(freeListHead.value), ownedPointer);

    const outer = beginFunctionalWasmArena(instance);
    equal(Number(freeListHead.value), 0);
    const arenaPointer = allocate(8) as number;
    equal(arenaPointer, outer.mark);
    const nested = beginFunctionalWasmArena(instance);
    allocate(16);
    throws(
      () => outer.reset(),
      /cannot reset before its nested arena/,
    );
    nested.reset();
    equal(nested.active, false);
    equal(Number(heapTop.value), nested.mark);
    outer.reset();
    equal(outer.active, false);
    equal(Number(heapTop.value), outer.mark);
    equal(Number(freeListHead.value), ownedPointer);
    throws(() => outer.reset(), /already reset/);

    const reusedPointer = allocate(8) as number;
    equal(reusedPointer, ownedPointer);
    free(reusedPointer, 8);

    const scratchMark = markFunctionalWasmScratch(instance);
    allocate(8);
    resetFunctionalWasmScratch(instance, scratchMark);
    equal(Number(heapTop.value), scratchMark);
    equal(Number(freeListHead.value), ownedPointer);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("WebAssembly allocator rejects wrapped sizes and invalid frees without corrupting reuse", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    singleDefinitionModule(surface.integer(0)),
  );
  if (!compilation.ok) throw new Error("allocator validation fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    const allocate = instance.exports.allocate;
    const free = instance.exports.free;
    const heapTop = instance.exports.heapTop;
    const freeListHead = instance.exports.freeListHead;
    ok(typeof initialize === "function");
    ok(typeof allocate === "function");
    ok(typeof free === "function");
    ok(heapTop instanceof WebAssembly.Global);
    ok(freeListHead instanceof WebAssembly.Global);
    initialize();

    const initialHeapTop = Number(heapTop.value);
    throws(() => allocate(-1), WebAssembly.RuntimeError);
    equal(Number(heapTop.value), initialHeapTop);
    const pointer = allocate(16) as number;
    throws(() => free(pointer, 24), WebAssembly.RuntimeError);
    throws(() => free(pointer + 8, 16), WebAssembly.RuntimeError);
    equal(Number(freeListHead.value), 0);
    free(pointer, 16);
    equal(Number(freeListHead.value), pointer);
    throws(() => free(pointer, 16), WebAssembly.RuntimeError);
    equal(Number(freeListHead.value), pointer);
    equal(allocate(16), pointer);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("WebAssembly allocator uses externally grown memory without false exhaustion", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    singleDefinitionModule(surface.integer(0)),
  );
  if (!compilation.ok) throw new Error("external memory growth fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    const allocate = instance.exports.allocate;
    const memory = instance.exports.memory;
    ok(typeof initialize === "function");
    ok(typeof allocate === "function");
    ok(memory instanceof WebAssembly.Memory);
    initialize();

    equal(memory.grow(2), 1);
    const externallyGrownByteLength = memory.buffer.byteLength;
    ok((allocate(70_000) as number) > 0);
    equal(memory.buffer.byteLength, externallyGrownByteLength);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("arena promotion preserves nested values and recursively drops owned resources", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["value"],
      annotation: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "integer" },
      },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("arena promotion fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    const allocate = instance.exports.allocate;
    ok(typeof initialize === "function");
    ok(typeof allocate === "function");
    initialize();

    const resource = FunctionalHostTypes.resource("duck.file") as FunctionalType;
    const aggregateType: FunctionalType = {
      kind: "tuple",
      values: [resource, FunctionalHostTypes.array(resource) as FunctionalType],
    };
    const aggregateValue = {
      kind: "tuple",
      values: [
        { kind: "resource", id: 7 },
        { kind: "array", values: [{ kind: "resource", id: 8 }] },
      ],
    } as const;
    const outer = beginFunctionalWasmArena(instance);
    const nested = beginFunctionalWasmArena(instance);
    const temporary = encodeFunctionalWasmArenaValue(
      nested,
      compilation.module,
      aggregateType,
      aggregateValue,
    );
    const parentValue = promoteFunctionalWasmArenaValueToParent(
      nested,
      compilation.module,
      aggregateType,
      temporary,
    );
    equal(nested.active, false);
    equal(outer.active, true);

    const dropped: [string, number][] = [];
    const owned = promoteFunctionalWasmArenaValueToOwned(
      outer,
      compilation.module,
      aggregateType,
      parentValue,
      {
        dropResource: (resourceName, id) => dropped.push([resourceName, id]),
      },
    );
    equal(outer.active, false);
    deepStrictEqual(owned.decode(), aggregateValue);
    const ownedHeapStart = outer.mark;
    throws(
      () => owned.transfer(),
      /cannot transfer while host resource drop callbacks remain attached/,
    );
    const retained = owned.retain();
    owned.release();
    equal(owned.active, false);
    deepStrictEqual(dropped, []);
    deepStrictEqual(retained.decode(), aggregateValue);
    const releaseArena = beginFunctionalWasmArena(instance);
    throws(
      () => retained.release(),
      /cannot release its final lease while 1 arenas are active/,
    );
    equal(retained.active, true);
    releaseArena.reset();
    retained.release();
    deepStrictEqual(dropped, [["duck.file", 7], ["duck.file", 8]]);
    throws(() => owned.decode(), /already released/);
    throws(() => owned.release(), /already released/);
    equal(allocate(16), ownedHeapStart);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("arena encoding reclaims partial allocations after a boundary mismatch", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["value"],
      annotation: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "integer" },
      },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("arena cleanup fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    const allocate = instance.exports.allocate;
    ok(typeof initialize === "function");
    ok(typeof allocate === "function");
    initialize();

    const arena = beginFunctionalWasmArena(instance);
    throws(
      () =>
        encodeFunctionalWasmArenaValue(
          arena,
          compilation.module,
          {
            kind: "tuple",
            values: [FunctionalHostTypes.text as FunctionalType, { kind: "integer" }],
          },
          {
            kind: "tuple",
            values: [
              { kind: "text", value: "failure" },
              { kind: "boolean", value: false },
            ],
          },
        ),
      /expected integer; received boolean/,
    );
    equal(allocate(24), arena.mark);
    arena.reset();
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("cyclic structured arguments fail after reclaiming partial allocations", async () => {
  const loopType: FunctionalType = { kind: "named", name: "Loop", arguments: [] };
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(
        surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
        surface.integer(0),
        surface.integer(0),
      ),
    }],
    [{
      name: "Loop",
      parameters: [],
      constructors: [{
        name: "Node",
        fields: [{ name: "label", type: FunctionalHostTypes.text }, {
          name: "next",
          type: loopType,
        }],
      }],
    }],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("cyclic argument fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    const freeListHead = instance.exports.freeListHead;
    const allocate = instance.exports.allocate;
    ok(typeof initialize === "function");
    ok(freeListHead instanceof WebAssembly.Global);
    ok(typeof allocate === "function");
    initialize();

    const fields: FunctionalWasmValue[] = [{ kind: "text", value: "x" }];
    const cyclicValue: FunctionalWasmValue = {
      kind: "constructor",
      name: "Node",
      fields,
    };
    fields.push(cyclicValue);
    throws(
      () =>
        encodeFunctionalWasmOwnedValue(
          instance,
          compilation.module,
          loopType,
          cyclicValue,
        ),
      /cyclic constructor "Node" value/,
    );
    const reclaimedPointer = Number(freeListHead.value);
    ok(reclaimedPointer > 0);
    equal(allocate(24), reclaimedPointer);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("verified Storage Core emits standalone retain and stack-safe drop exports", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.integer(0),
    }],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("owned drop export fixture did not compile");
  try {
    const plan = await planFunctionalModuleStorage(compilation.module);
    const storageCore = {
      persistentSharing: FunctionalPersistentSharing.ExplicitReferenceCounting,
      operations: [
        { kind: "declare" as const, value: "frontend-owned", lifetime: "owned" as const },
        ...plan.core.operations,
      ],
    };
    const ownedType: FunctionalType = {
      kind: "tuple",
      values: [
        FunctionalHostTypes.text as FunctionalType,
        FunctionalHostTypes.array({ kind: "integer" }) as FunctionalType,
      ],
    };
    await rejects(
      () =>
        compileFunctionalModuleToWasm(compilation.module, {
          storageCore,
          ownedTypeExports: [{
            name: "message",
            storageValue: "unrelated-owned-value",
            type: ownedType,
          }],
        }),
      /requires owned Storage Core value "unrelated-owned-value"/,
    );
    const bytes = await compileFunctionalModuleToWasm(compilation.module, {
      storageCore,
      ownedTypeExports: [{
        name: "message",
        storageValue: "frontend-owned",
        type: ownedType,
      }],
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    const retain = instance.exports.retain_message;
    const drop = instance.exports.drop_message;
    const allocate = instance.exports.allocate;
    const freeListHead = instance.exports.freeListHead;
    const heapTop = instance.exports.heapTop;
    const memory = instance.exports.memory;
    ok(typeof initialize === "function");
    ok(typeof retain === "function");
    ok(typeof drop === "function");
    ok(typeof allocate === "function");
    ok(freeListHead instanceof WebAssembly.Global);
    ok(heapTop instanceof WebAssembly.Global);
    ok(memory instanceof WebAssembly.Memory);
    initialize();

    const owned = encodeFunctionalWasmOwnedValue(
      instance,
      compilation.module,
      ownedType,
      {
        kind: "tuple",
        values: [
          { kind: "text", value: "owned" },
          { kind: "array", values: [{ kind: "integer", value: 42 }] },
        ],
      },
    );
    const additionalLease = owned.retain();
    throws(() => owned.transfer(), /cannot transfer with 2 active leases/);
    additionalLease.release();
    const pointer = owned.transfer();
    equal(owned.active, false);
    const activeArena = beginFunctionalWasmArena(instance);
    throws(() => drop(pointer), WebAssembly.RuntimeError);
    activeArena.reset();
    retain(pointer);
    drop(pointer);
    equal(Number(freeListHead.value), 0);
    drop(pointer);
    const firstReleasedPointer = Number(freeListHead.value);
    ok(firstReleasedPointer > 0);
    const stableHeapTop = Number(heapTop.value);
    for (let iteration = 0; iteration < 128; iteration++) {
      const next = encodeFunctionalWasmOwnedValue(
        instance,
        compilation.module,
        ownedType,
        {
          kind: "tuple",
          values: [
            { kind: "text", value: "owned" },
            { kind: "array", values: [{ kind: "integer", value: iteration }] },
          ],
        },
      );
      drop(next.transfer());
    }
    equal(Number(heapTop.value), stableHeapTop);
    let deepValue = 1n;
    for (let depth = 0; depth < 20_000; depth++) {
      const deepPointer = allocate(24) as number;
      const deepView = new DataView(memory.buffer);
      deepView.setUint32(
        deepPointer + FunctionalWasmValueAbi.objectKindByteOffset,
        FunctionalWasmValueAbi.objectKinds.constructor,
        true,
      );
      deepView.setUint32(deepPointer + FunctionalWasmValueAbi.objectPayloadByteOffset, 0, true);
      deepView.setUint32(deepPointer + FunctionalWasmValueAbi.objectValueCountByteOffset, 1, true);
      deepView.setUint32(
        deepPointer + FunctionalWasmValueAbi.objectReferenceCountByteOffset,
        1,
        true,
      );
      deepView.setBigInt64(
        deepPointer + FunctionalWasmValueAbi.objectValuesByteOffset,
        deepValue,
        true,
      );
      deepValue = BigInt(deepPointer);
    }
    const deepHeapTop = Number(heapTop.value);
    drop(deepValue);
    equal(Number(heapTop.value), deepHeapTop);
    ok(Number(freeListHead.value) > 0);
    const overflow = encodeFunctionalWasmOwnedValue(
      instance,
      compilation.module,
      ownedType,
      {
        kind: "tuple",
        values: [
          { kind: "text", value: "overflow" },
          { kind: "array", values: [] },
        ],
      },
    ).transfer();
    const overflowHeapTop = Number(heapTop.value);
    const overflowPointer = Number(BigInt.asUintN(32, overflow));
    const overflowView = new DataView(memory.buffer);
    overflowView.setUint32(
      overflowPointer + FunctionalWasmValueAbi.objectReferenceCountByteOffset,
      0xffff_ffff,
      true,
    );
    throws(() => retain(overflow), WebAssembly.RuntimeError);
    overflowView.setUint32(
      overflowPointer + FunctionalWasmValueAbi.objectReferenceCountByteOffset,
      1,
      true,
    );
    throws(() => retain(4n), WebAssembly.RuntimeError);
    throws(
      () => retain(BigInt(memory.buffer.byteLength - 8)),
      WebAssembly.RuntimeError,
    );
    throws(() => retain(BigInt(Number(heapTop.value))), WebAssembly.RuntimeError);
    overflowView.setUint32(
      overflowPointer + FunctionalWasmValueAbi.objectKindByteOffset,
      0xffff_ffff,
      true,
    );
    throws(() => retain(overflow), WebAssembly.RuntimeError);
    throws(() => drop(overflow), WebAssembly.RuntimeError);
    overflowView.setUint32(
      overflowPointer + FunctionalWasmValueAbi.objectKindByteOffset,
      FunctionalWasmValueAbi.objectKinds.constructor,
      true,
    );
    overflowView.setUint32(
      overflowPointer + FunctionalWasmValueAbi.objectValueCountByteOffset,
      0xffff_ffff,
      true,
    );
    throws(() => drop(overflow), WebAssembly.RuntimeError);
    equal(
      overflowView.getUint32(
        overflowPointer + FunctionalWasmValueAbi.objectReferenceCountByteOffset,
        true,
      ),
      1,
    );
    overflowView.setUint32(
      overflowPointer + FunctionalWasmValueAbi.objectValueCountByteOffset,
      2,
      true,
    );
    drop(overflow);
    const reusedPointer = allocate(24) as number;
    ok(reusedPointer > 0 && reusedPointer < overflowHeapTop);
    equal(Number(heapTop.value), overflowHeapTop);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("lexical WebAssembly arenas remain active across await and reset after rejection", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["value"],
      annotation: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "integer" },
      },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("async arena fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    const allocate = instance.exports.allocate;
    const heapTop = instance.exports.heapTop;
    ok(typeof initialize === "function");
    ok(typeof allocate === "function");
    ok(heapTop instanceof WebAssembly.Global);
    initialize();
    const heapStart = Number(heapTop.value);
    let scopedArenaMark = -1;

    await rejects(
      () =>
        withFunctionalWasmArena(instance, async (arena) => {
          scopedArenaMark = arena.mark;
          allocate(32);
          await Promise.resolve();
          equal(arena.active, true);
          throw new Error("scope failed");
        }),
      /scope failed/,
    );
    equal(scopedArenaMark, heapStart);
    equal(Number(heapTop.value), heapStart);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("executes Text and Bytes intrinsics inside WebAssembly", async () => {
  const integer = { kind: "integer" } as const;
  const boolean = { kind: "boolean" } as const;
  const pair = (
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression =>
    surface.apply(surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME), left, right);
  const joined = surface.apply(
    surface.name("append"),
    pair(surface.name("first"), surface.name("last")),
  );
  const sliced = surface.apply(
    surface.name("slice"),
    pair(
      surface.name("first"),
      pair(surface.integer(0), surface.integer(2)),
    ),
  );
  const matchingScore = surface.binary(
    FunctionalBinaryOperator.Add,
    surface.binary(
      FunctionalBinaryOperator.Add,
      surface.binary(
        FunctionalBinaryOperator.Multiply,
        surface.apply(surface.name("length"), joined),
        surface.integer(100),
      ),
      surface.apply(
        surface.name("get"),
        pair(joined, surface.integer(2)),
      ),
    ),
    {
      kind: "if",
      condition: surface.apply(
        surface.name("equal"),
        pair(sliced, surface.name("first")),
      ),
      consequent: surface.integer(1),
      alternate: surface.integer(0),
    },
  );
  const score = surface.binary(
    FunctionalBinaryOperator.Add,
    matchingScore,
    {
      kind: "if",
      condition: surface.apply(
        surface.name("equal"),
        pair(surface.name("first"), surface.name("last")),
      ),
      consequent: surface.integer(0),
      alternate: surface.integer(10),
    },
  );
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
          binders: ["first", "last", "length", "get", "slice", "append", "equal"],
          body: score,
        }],
      },
    }],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Buffer",
        fields: [{
          kind: "value",
          name: "first",
          type: FunctionalHostTypes.text,
          ownership: "frozen-shareable",
          wasmLiteral: { kind: "text", value: "AB" },
        }, {
          kind: "value",
          name: "last",
          type: FunctionalHostTypes.text,
          ownership: "frozen-shareable",
          wasmLiteral: { kind: "text", value: "C" },
        }, {
          kind: "operation",
          name: "length",
          purity: "pure",
          parameter: FunctionalHostTypes.text,
          result: integer,
          wasmIntrinsic: FunctionalWasmIntrinsic.BufferByteLength,
        }, {
          kind: "operation",
          name: "get",
          purity: "pure",
          parameter: { kind: "tuple", values: [FunctionalHostTypes.text, integer] },
          result: integer,
          wasmIntrinsic: FunctionalWasmIntrinsic.BufferByteGet,
        }, {
          kind: "operation",
          name: "slice",
          purity: "pure",
          parameter: {
            kind: "tuple",
            values: [
              FunctionalHostTypes.text,
              { kind: "tuple", values: [integer, integer] },
            ],
          },
          result: FunctionalHostTypes.text,
          wasmIntrinsic: FunctionalWasmIntrinsic.BufferByteSlice,
        }, {
          kind: "operation",
          name: "append",
          purity: "pure",
          parameter: {
            kind: "tuple",
            values: [FunctionalHostTypes.text, FunctionalHostTypes.text],
          },
          result: FunctionalHostTypes.text,
          wasmIntrinsic: FunctionalWasmIntrinsic.BufferAppend,
        }, {
          kind: "operation",
          name: "equal",
          purity: "pure",
          parameter: {
            kind: "tuple",
            values: [FunctionalHostTypes.text, FunctionalHostTypes.text],
          },
          result: boolean,
          wasmIntrinsic: FunctionalWasmIntrinsic.BufferEqual,
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) {
    throw new Error("native buffer intrinsic module did not compile");
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 378 });
    const wasmModule = await WebAssembly.compile(execution.bytes);
    deepStrictEqual(WebAssembly.Module.imports(wasmModule), []);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("generates Bytes with a source callback inside WebAssembly", async () => {
  const integer = { kind: "integer" } as const;
  const generator = surface.lambda(
    "index",
    surface.binary(
      FunctionalBinaryOperator.Add,
      surface.name("index"),
      surface.integer(65),
    ),
  );
  const argument = surface.apply(
    surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
    surface.integer(4),
    generator,
  );
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
          binders: ["generate"],
          body: surface.apply(surface.name("generate"), argument),
        }],
      },
    }],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Buffer",
        fields: [{
          kind: "operation",
          name: "generate",
          purity: "pure",
          parameter: {
            kind: "tuple",
            values: [
              integer,
              { kind: "function", parameter: integer, result: integer },
            ],
          },
          result: FunctionalHostTypes.bytes,
          resultOwnership: "unique",
          wasmIntrinsic: FunctionalWasmIntrinsic.BufferGenerate,
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) {
    throw new Error("native byte generation module did not compile");
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, {
      kind: "bytes",
      value: new Uint8Array([65, 66, 67, 68]),
    });
    const wasmModule = await WebAssembly.compile(execution.bytes);
    deepStrictEqual(WebAssembly.Module.imports(wasmModule), []);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("branch-selected uncurried workers load their caller-local capture", async () => {
  const integer = { kind: "integer" } as const;
  const combine = (): FunctionalSurfaceExpression =>
    surface.lambda(
      "left",
      surface.lambda(
        "right",
        surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("seed"),
          surface.binary(
            FunctionalBinaryOperator.Add,
            surface.name("left"),
            surface.name("right"),
          ),
        ),
      ),
    );
  const encoded = buildFunctionalSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.integer(0),
      },
      {
        name: "run",
        parameters: ["seed"],
        annotation: { kind: "function", parameter: integer, result: integer },
        body: {
          kind: "let",
          name: "selected",
          value: {
            kind: "if",
            condition: surface.equal(surface.name("seed"), surface.integer(0)),
            consequent: combine(),
            alternate: combine(),
          },
          body: surface.apply(
            surface.apply(surface.name("selected"), surface.integer(20)),
            surface.integer(20),
          ),
        },
      },
    ],
    [],
    "main",
    0,
    {
      evaluationProfile: FunctionalEvaluationProfile.StrictEager,
      wasmExports: [{ name: "run", definition: "run" }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("uncurried capture fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const run = instance.exports.run;
    ok(typeof run === "function");
    equal(run(1n), 40);
    equal(run((2n << 3n) | 1n), 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("initializes more than 64 native WebAssembly host values", async () => {
  const integer = { kind: "integer" } as const;
  const literalNames = Array.from(
    { length: 65 },
    (_, index) => `literal${index}`,
  );
  const fields = literalNames.map((name) => ({
    kind: "value" as const,
    name,
    type: FunctionalHostTypes.text,
    ownership: "frozen-shareable" as const,
    wasmLiteral: { kind: "text" as const, value: name },
  }));
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
          binders: [...literalNames, "length"],
          body: surface.apply(
            surface.name("length"),
            surface.name("literal64"),
          ),
        }],
      },
    }],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Buffer",
        fields: [...fields, {
          kind: "operation",
          name: "length",
          purity: "pure",
          parameter: FunctionalHostTypes.text,
          result: integer,
          wasmIntrinsic: FunctionalWasmIntrinsic.BufferByteLength,
        }],
      }],
    },
  );

  const execution = await runCompiledWasm(encoded);
  deepStrictEqual(execution.value, { kind: "integer", value: 9 });
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

Deno.test("round-trips deeply nested WebAssembly values without using the JavaScript call stack", async () => {
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(
        surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
        surface.integer(0),
        surface.integer(0),
      ),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("deep boundary fixture did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(bytes);
    const initialize = instance.exports.initialize;
    ok(typeof initialize === "function");
    initialize();
    await withFunctionalWasmArena(instance, (arena) => {
      const integer: FunctionalType = { kind: "integer" };
      let deepType: FunctionalType = integer;
      let deepValue: FunctionalWasmValue = { kind: "integer", value: 0 };
      for (let depth = 0; depth < 10_000; depth++) {
        deepType = { kind: "tuple", values: [integer, deepType] };
        deepValue = {
          kind: "tuple",
          values: [{ kind: "integer", value: depth }, deepValue],
        };
      }

      const encodedValue = encodeFunctionalWasmArenaValue(
        arena,
        compilation.module,
        deepType,
        deepValue,
      );
      let decoded = decodeFunctionalWasmValue(
        instance,
        compilation.module,
        deepType,
        encodedValue,
        20_001,
      );
      for (let depth = 9_999; depth >= 0; depth--) {
        if (decoded.kind !== "tuple") {
          throw new Error(`deep decoder returned ${decoded.kind} at depth ${depth}`);
        }
        deepStrictEqual(decoded.values[0], { kind: "integer", value: depth });
        decoded = decoded.values[1];
      }
      deepStrictEqual(decoded, { kind: "integer", value: 0 });
    });
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

Deno.test("async replay snapshots deeply nested host results without using the call stack", async () => {
  const chainType: FunctionalType = { kind: "named", name: "Chain", arguments: [] };
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
          binders: ["build"],
          body: surface.apply(
            surface.name("build"),
            surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
          ),
        }],
      },
    }],
    [{
      name: "Chain",
      parameters: [],
      constructors: [{ name: "End", fields: [] }, {
        name: "Link",
        fields: [{ name: "value", type: { kind: "integer" } }, {
          name: "next",
          type: chainType,
        }],
      }],
    }],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Environment",
        fields: [{
          kind: "operation",
          name: "build",
          purity: "effectful",
          execution: "suspending",
          parameter: { kind: "unit" },
          result: chainType,
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("deep async result fixture did not compile");
  let result: FunctionalWasmValue = { kind: "constructor", name: "End", fields: [] };
  for (let depth = 0; depth < 10_000; depth++) {
    result = {
      kind: "constructor",
      name: "Link",
      fields: [{ kind: "integer", value: depth }, result],
    };
  }
  let buildCalls = 0;
  try {
    const execution = await runFunctionalWasmModuleAsync(compilation.module, {
      init: {
        Environment: {
          build: async () => {
            buildCalls += 1;
            await Promise.resolve();
            return result;
          },
        },
      },
      maximumResultNodes: 20_001,
    });
    equal(buildCalls, 1);
    let current = execution.value;
    for (let depth = 9_999; depth >= 0; depth--) {
      if (current.kind !== "constructor" || current.name !== "Link") {
        throw new Error(`deep async result returned ${current.kind} at depth ${depth}`);
      }
      deepStrictEqual(current.fields[0], { kind: "integer", value: depth });
      current = current.fields[1]!;
    }
    deepStrictEqual(current, { kind: "constructor", name: "End", fields: [] });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("async replay reports cyclic host results as host-operation failures", async () => {
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
          binders: ["build"],
          body: surface.apply(
            surface.name("build"),
            surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
          ),
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
          name: "build",
          purity: "effectful",
          execution: "suspending",
          parameter: { kind: "unit" },
          result: FunctionalHostTypes.array({ kind: "integer" }),
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("cyclic async result fixture did not compile");
  const values: FunctionalWasmValue[] = [];
  const result: FunctionalWasmValue = { kind: "array", values };
  values.push(result);
  try {
    await rejects(
      () =>
        runFunctionalWasmModuleAsync(compilation.module, {
          init: {
            Environment: {
              build: () => Promise.resolve(result),
            },
          },
        }),
      (error) => {
        ok(error instanceof FunctionalWasmRuntimeError);
        equal(error.kind, "host-operation");
        equal(error.capability, "Environment");
        equal(error.operation, "build");
        ok(error.message.includes("cyclic array value"));
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("async execution cancels a suspended invocation and remains reusable", async () => {
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
          body: surface.apply(
            surface.name("read"),
            surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
          ),
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
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("async cancellation module did not compile");
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => notifyStarted = resolve);
  let finishRead: ((result: { kind: "integer"; value: number }) => void) | undefined;
  const pendingRead = new Promise<{ kind: "integer"; value: number }>(
    (resolve) => finishRead = resolve,
  );
  const controller = new AbortController();
  try {
    const cancelledExecution = runFunctionalWasmModuleAsync(compilation.module, {
      init: {
        Environment: {
          read: () => {
            notifyStarted?.();
            return pendingRead;
          },
        },
      },
      signal: controller.signal,
    });
    await started;
    const cancellation = new Error("cancel async invocation");
    controller.abort(cancellation);
    await rejects(
      () => cancelledExecution,
      (error) => error === cancellation,
    );
    finishRead?.({ kind: "integer", value: 1 });

    const execution = await runFunctionalWasmModuleAsync(compilation.module, {
      init: {
        Environment: {
          read: () => Promise.resolve({ kind: "integer", value: 42 }),
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
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
    deepStrictEqual(
      WebAssembly.Module.exports(new WebAssembly.Module(bytes)),
      [
        { name: "main", kind: "function" },
        { name: "duck_increment", kind: "function" },
        { name: "duck_add", kind: "function" },
        { name: "duck_answer", kind: "function" },
      ],
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("direct scalar exports fuse tail loops that capture their runtime argument", async () => {
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
        name: "run",
        parameters: ["increment"],
        annotation: { kind: "function", parameter: integer, result: integer },
        body: {
          kind: "let-rec",
          name: "count",
          value: surface.lambda(
            "value",
            surface.lambda("remaining", {
              kind: "if",
              condition: surface.equal(
                surface.name("remaining"),
                surface.integer(0),
              ),
              consequent: surface.name("value"),
              alternate: surface.apply(
                surface.name("count"),
                surface.binary(
                  FunctionalBinaryOperator.Add,
                  surface.name("value"),
                  surface.name("increment"),
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
            surface.name("count"),
            surface.integer(0),
            surface.integer(512),
          ),
        },
      },
    ],
    [],
    "main",
    0,
    {
      evaluationProfile: FunctionalEvaluationProfile.StrictEager,
      wasmExports: [{ name: "run", definition: "run" }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("direct scalar export module did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const instantiated = await WebAssembly.instantiate(bytes);
    const run = instantiated.instance.exports.run;
    ok(typeof run === "function");
    equal(run((1n << 3n) | 1n), 512);
    equal(run((17n << 3n) | 1n), 8_704);
    deepStrictEqual(
      WebAssembly.Module.exports(new WebAssembly.Module(bytes)),
      [
        { name: "main", kind: "function" },
        { name: "run", kind: "function" },
      ],
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("direct scalar exports bypass initialization required by an aggregate entry", async () => {
  const integer = { kind: "integer" } as const;
  const integerFunction = {
    kind: "function",
    parameter: integer,
    result: integer,
  } as const;
  const encoded = buildFunctionalSurfaceModule(
    [
      {
        name: "run",
        parameters: ["value"],
        annotation: integerFunction,
        body: surface.binary(
          FunctionalBinaryOperator.Add,
          surface.name("value"),
          surface.integer(1),
        ),
      },
      {
        name: "main",
        parameters: [],
        annotation: {
          kind: "tuple",
          values: [integer, integer],
        },
        body: surface.apply(
          surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
          surface.integer(0),
          surface.integer(0),
        ),
      },
    ],
    [],
    "main",
    0,
    {
      evaluationProfile: FunctionalEvaluationProfile.StrictEager,
      wasmExports: [{ name: "run", definition: "run" }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("aggregate entry export module did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const instantiated = await WebAssembly.instantiate(bytes);
    const run = instantiated.instance.exports.run;
    const initialize = instantiated.instance.exports.initialize;
    const heapTop = instantiated.instance.exports.heapTop;
    ok(typeof run === "function");
    ok(typeof initialize === "function");
    ok(heapTop instanceof WebAssembly.Global);
    const heapBeforeCall = heapTop.value;
    equal(run((41n << 3n) | 1n), 42);
    equal(heapTop.value, heapBeforeCall);
    initialize();
    equal(Number(heapTop.value) - Number(heapBeforeCall), 24);
    ok(
      WebAssembly.Module.exports(new WebAssembly.Module(bytes)).some((entry) =>
        entry.kind === "memory"
      ),
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("lazy callable exports retain the general WebAssembly runtime", async () => {
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
        name: "identity",
        parameters: ["value"],
        annotation: { kind: "function", parameter: integer, result: integer },
        body: surface.name("value"),
      },
    ],
    [],
    "main",
    0,
    {
      evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed,
      wasmExports: [{ name: "identity", definition: "identity" }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("lazy callable export module did not compile");
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    const instantiated = await WebAssembly.instantiate(bytes);
    const identity = instantiated.instance.exports.identity;
    ok(typeof identity === "function");
    equal(identity((42n << 3n) | 1n), 42);
    const exports = WebAssembly.Module.exports(new WebAssembly.Module(bytes));
    ok(exports.some((entry) => entry.name === "initialize"));
    ok(exports.some((entry) => entry.kind === "memory"));
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

Deno.test("rejects invalid result bounds before running host effects", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    hostInitModule(
      surface.apply(surface.name("observe"), surface.integer(1)),
    ),
  );
  if (!compilation.ok) throw new Error("early result-bound fixture did not compile");
  const observed: number[] = [];
  try {
    await rejects(
      () =>
        runFunctionalWasmModule(compilation.module, {
          maximumResultNodes: 0,
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
        }),
      /maximumResultNodes must be a positive safe integer; received 0/,
    );
    deepStrictEqual(observed, []);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("rejects invalid argument ownership before reading host initialization", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    hostInitModule(surface.name("base")),
  );
  if (!compilation.ok) throw new Error("early ownership fixture did not compile");
  const environment = {
    base: { kind: "integer", value: 0 } as const,
    increment: (argument: FunctionalWasmValue) => argument,
    observe: (argument: FunctionalWasmValue) => argument,
  };
  let initializationReads = 0;
  const init = new Proxy<FunctionalWasmInit>({}, {
    get(_target, property) {
      if (property !== "Environment") return undefined;
      initializationReads += 1;
      return environment;
    },
    getOwnPropertyDescriptor(_target, property) {
      if (property !== "Environment") return undefined;
      initializationReads += 1;
      return { configurable: true, enumerable: true, value: environment };
    },
  });
  const options: FunctionalWasmRunOptions = {
    init,
    argumentOwnership: "invalid" as NonNullable<
      FunctionalWasmRunOptions["argumentOwnership"]
    >,
  };
  try {
    await rejects(
      () => runFunctionalWasmModule(compilation.module, options),
      (error) => {
        ok(error instanceof FunctionalWasmBoundaryError);
        equal(error.path, "argumentOwnership");
        return true;
      },
    );
    equal(initializationReads, 0);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("async execution validates shared controls before reading host initialization", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    hostInitModule(surface.name("base")),
  );
  if (!compilation.ok) throw new Error("async control validation fixture did not compile");
  let initializationReads = 0;
  const init = new Proxy<FunctionalWasmAsyncInit>({}, {
    get() {
      initializationReads += 1;
      return undefined;
    },
  });
  try {
    await rejects(
      () =>
        runFunctionalWasmModuleAsync(compilation.module, {
          init,
          maximumResultNodes: 0,
        }),
      /maximumResultNodes must be a positive safe integer; received 0/,
    );
    equal(initializationReads, 0);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("rejects a missing entry argument before WebAssembly execution", async () => {
  const integer: FunctionalType = { kind: "integer" };
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["value"],
      annotation: { kind: "function", parameter: integer, result: integer },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("missing argument fixture did not compile");
  try {
    await rejects(
      () => runFunctionalWasmModule(compilation.module),
      (error) => {
        ok(error instanceof FunctionalWasmBoundaryError);
        equal(error.path, "argument");
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("rejects an unexpected entry argument before WebAssembly execution", async () => {
  const compilation = await functionalWasmRuntime().compiler.compileModule(
    singleDefinitionModule(surface.integer(1)),
  );
  if (!compilation.ok) throw new Error("unexpected argument fixture did not compile");
  try {
    await rejects(
      () =>
        runFunctionalWasmModule(compilation.module, {
          argument: { kind: "integer", value: 1 },
        }),
      (error) => {
        ok(error instanceof FunctionalWasmBoundaryError);
        equal(error.path, "argument");
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("rejects malformed scalar argument payloads without coercion", async () => {
  const cases: readonly {
    readonly type: FunctionalType;
    readonly argument: unknown;
    readonly message: RegExp;
  }[] = [{
    type: { kind: "boolean" },
    argument: { kind: "boolean", value: 1 },
    message: /boolean argument payload must be boolean; received number/,
  }, {
    type: { kind: "signed-integer-64" },
    argument: { kind: "signed-integer-64", value: 0x8000000000000000n },
    message: /i64 argument payload must be a signed i64/,
  }, {
    type: { kind: "float-32" },
    argument: { kind: "float-32", value: "1.5" },
    message: /f32 argument payload must be a number; received string/,
  }, {
    type: { kind: "float-64" },
    argument: { kind: "float-64", value: null },
    message: /f64 argument payload must be a number; received object/,
  }, {
    type: FunctionalHostTypes.text as FunctionalType,
    argument: { kind: "text", value: 42 },
    message: /text argument payload must be a string; received number/,
  }, {
    type: FunctionalHostTypes.bytes as FunctionalType,
    argument: { kind: "bytes", value: [1, 2, 3] },
    message: /bytes argument payload must be Uint8Array; received \[object Array\]/,
  }];
  for (const testCase of cases) {
    const encoded = buildFunctionalSurfaceModule(
      [{
        name: "main",
        parameters: ["value"],
        annotation: { kind: "function", parameter: testCase.type, result: testCase.type },
        body: surface.name("value"),
      }],
      [],
      "main",
      0,
    );
    const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
    if (!compilation.ok) throw new Error("malformed scalar argument fixture did not compile");
    try {
      await rejects(
        () =>
          runFunctionalWasmModule(compilation.module, {
            argument: testCase.argument as FunctionalWasmValue,
          }),
        (error) => {
          ok(error instanceof FunctionalWasmBoundaryError);
          equal(error.path, "argument");
          ok(testCase.message.test(error.message), error.message);
          return true;
        },
      );
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("rejects malformed aggregate argument shapes with boundary evidence", async () => {
  const integer: FunctionalType = { kind: "integer" };
  const cases: readonly {
    readonly type: FunctionalType;
    readonly argument: unknown;
    readonly message: RegExp;
  }[] = [{
    type: integer,
    argument: null,
    message: /argument expected integer; received null/,
  }, {
    type: { kind: "tuple", values: [integer, integer] },
    argument: { kind: "tuple", values: [{ kind: "integer", value: 1 }] },
    message: /tuple argument requires exactly 2 values; received 1/,
  }, {
    type: FunctionalHostTypes.array(integer) as FunctionalType,
    argument: { kind: "array", values: { first: { kind: "integer", value: 1 } } },
    message: /array argument values must be an array; received \[object Object\]/,
  }];
  for (const testCase of cases) {
    const encoded = buildFunctionalSurfaceModule(
      [{
        name: "main",
        parameters: ["value"],
        annotation: { kind: "function", parameter: testCase.type, result: testCase.type },
        body: surface.name("value"),
      }],
      [],
      "main",
      0,
    );
    const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
    if (!compilation.ok) throw new Error("malformed aggregate argument fixture did not compile");
    try {
      await rejects(
        () =>
          runFunctionalWasmModule(compilation.module, {
            argument: testCase.argument as FunctionalWasmValue,
          }),
        (error) => {
          ok(error instanceof FunctionalWasmBoundaryError);
          equal(error.path, "argument");
          ok(testCase.message.test(error.message), error.message);
          return true;
        },
      );
    } finally {
      compilation.module.destroy();
    }
  }
});

Deno.test("rejects oversized host allocations before WebAssembly i32 truncation", async () => {
  const bytesType = FunctionalHostTypes.bytes as FunctionalType;
  const encoded = buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: ["value"],
      annotation: { kind: "function", parameter: bytesType, result: bytesType },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("oversized allocation fixture did not compile");
  const oversizedBytes = new Uint8Array(0);
  Object.defineProperty(oversizedBytes, "byteLength", { value: 0xffff_0000 });
  try {
    await rejects(
      () =>
        runFunctionalWasmModule(compilation.module, {
          argument: { kind: "bytes", value: oversizedBytes },
        }),
      (error) => {
        ok(error instanceof FunctionalWasmBoundaryError);
        equal(error.path, "argument");
        ok(error.message.includes("allocation requires 4294901776 aligned bytes"));
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("rejects malformed scalar host results without coercion", async () => {
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
          body: surface.apply(
            surface.name("read"),
            surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
          ),
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
          parameter: { kind: "unit" },
          result: { kind: "float-64" },
        }],
      }],
    },
  );
  const compilation = await functionalWasmRuntime().compiler.compileModule(encoded);
  if (!compilation.ok) throw new Error("malformed scalar host result fixture did not compile");
  try {
    await rejects(
      () =>
        runFunctionalWasmModule(compilation.module, {
          init: {
            Environment: {
              read: () => ({ kind: "float-64", value: "42" } as unknown as FunctionalWasmValue),
            },
          },
        }),
      (error) => {
        ok(error instanceof FunctionalWasmRuntimeError);
        equal(error.kind, "host-operation");
        ok(error.message.includes("returned string; expected a float-64 payload"));
        return true;
      },
    );
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

Deno.test("strict curried higher-order calls inline known functions into compact WASM", async () => {
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let",
    name: "applyTwice",
    value: surface.lambda(
      "value",
      surface.lambda(
        "function",
        surface.apply(
          surface.name("function"),
          surface.apply(surface.name("function"), surface.name("value")),
        ),
      ),
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
      body: surface.apply(
        surface.apply(surface.name("applyTwice"), surface.integer(40)),
        surface.name("increment"),
      ),
    },
  }, FunctionalEvaluationProfile.StrictEager));

  deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  equal(execution.stats.allocatedBytes, 0);
  deepStrictEqual(
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)),
    [{ name: "main", kind: "function" }],
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
  equal(
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)).some((entry) =>
      entry.name === "specializedCallSites"
    ),
    false,
  );
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

Deno.test("strict recursive workers embed fields from known constructor values", async () => {
  const configuration = surface.apply(
    surface.apply(
      surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
      surface.integer(1),
    ),
    surface.integer(4_096),
  );
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let",
    name: "configuration",
    value: configuration,
    body: {
      kind: "case",
      value: surface.name("configuration"),
      arms: [{
        constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
        binders: ["increment", "rounds"],
        body: {
          kind: "let-rec",
          name: "count",
          value: surface.lambda(
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
                    surface.name("increment"),
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
            surface.name("rounds"),
          ),
        },
      }],
    },
  }, FunctionalEvaluationProfile.StrictEager));

  deepStrictEqual(execution.value, { kind: "integer", value: 4_138 });
  deepStrictEqual(
    WebAssembly.Module.exports(new WebAssembly.Module(execution.bytes)),
    [{ name: "main", kind: "function" }],
  );
  equal(execution.stats.allocatedBytes, 0);
  equal(execution.stats.thunkEvaluations, 0);
  equal(execution.stats.specializedCallSites, 1);
});

Deno.test("reused recursive workers preserve each static capture environment", async () => {
  const countedTwice = surface.lambda("increment", {
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
              surface.name("increment"),
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
    body: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.apply(
        surface.apply(surface.name("count"), surface.integer(0)),
        surface.integer(2),
      ),
      surface.apply(
        surface.apply(surface.name("count"), surface.integer(0)),
        surface.integer(2),
      ),
    ),
  });
  const execution = await runCompiledWasm(singleDefinitionModule({
    kind: "let",
    name: "countedTwice",
    value: countedTwice,
    body: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.apply(surface.name("countedTwice"), surface.integer(1)),
      surface.apply(surface.name("countedTwice"), surface.integer(2)),
    ),
  }, FunctionalEvaluationProfile.StrictEager));

  deepStrictEqual(execution.value, { kind: "integer", value: 12 });
  equal(execution.stats.allocatedBytes, 0);
  equal(execution.stats.thunkEvaluations, 0);
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
