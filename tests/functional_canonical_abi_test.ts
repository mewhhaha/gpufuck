import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  compileModuleToWasm,
  CompilerPerformanceTrace,
  CpuCompiler,
  effectSet,
  HostTypes,
  storeType,
  surface,
  UNIT_CONSTRUCTOR_NAME,
  WasmRuntimeFaultCode,
} from "../functional.ts";

const signedInteger64 = { kind: "signed-integer-64" as const };
const canonicalSignedInteger64 = { kind: "signed-integer-64" as const };
const float32 = { kind: "float-32" as const };
const float64 = { kind: "float-64" as const };
const boolean = { kind: "boolean" as const };
const unit = { kind: "unit" as const };
const canonicalUnit = { kind: "unit" as const };

Deno.test("canonical ABI carries Float32 and Float64 values without integer coercion", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: float64,
      body: surface.float64(0),
    }, {
      name: "identity32",
      parameters: ["value"],
      annotation: { kind: "function", parameter: float32, result: float32 },
      body: surface.name("value"),
    }, {
      name: "identity64",
      parameters: ["value"],
      annotation: { kind: "function", parameter: float64, result: float64 },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
    {
      wasmExports: [
        { name: "identity32", definition: "identity32" },
        { name: "identity64", definition: "identity64" },
      ],
    },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "identity32",
          function: { parameters: [float32], result: float32 },
        }, {
          name: "identity64",
          function: { parameters: [float64], result: float64 },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const identity32 = instance.exports.identity32;
    const identity64 = instance.exports.identity64;
    ok(typeof identity32 === "function");
    ok(typeof identity64 === "function");
    equal(identity32(1.1), Math.fround(1.1));
    equal(identity64(Math.PI), Math.PI);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI preserves floating-point variant payloads through joined flat slots", async () => {
  const choice = { kind: "named" as const, name: "FloatChoice", arguments: [] };
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: float64,
      body: surface.float64(0),
    }, {
      name: "identity",
      parameters: ["value"],
      annotation: { kind: "function", parameter: choice, result: choice },
      body: surface.name("value"),
    }],
    [{
      name: "FloatChoice",
      parameters: [],
      constructors: [{
        name: "Single",
        fields: [{ name: "value", type: float32 }],
      }, {
        name: "Double",
        fields: [{ name: "value", type: float64 }],
      }],
    }],
    "main",
    0,
    { wasmExports: [{ name: "identity", definition: "identity" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  const canonicalChoice = {
    kind: "variant" as const,
    cases: [{ name: "Double", constructor: "Double", payload: float64 }, {
      name: "Single",
      constructor: "Single",
      payload: float32,
    }],
  };
  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "identity",
          postReturn: "cabi_post_identity",
          function: {
            parameters: [canonicalChoice],
            result: canonicalChoice,
          },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const identity = instance.exports.identity;
    const postReturn = instance.exports.cabi_post_identity;
    const memory = instance.exports.memory;
    ok(typeof identity === "function");
    ok(typeof postReturn === "function");
    ok(memory instanceof WebAssembly.Memory);

    const encoded = new DataView(new ArrayBuffer(8));
    encoded.setFloat64(0, Math.PI, true);
    const doubleResult = identity(0, encoded.getBigInt64(0, true));
    const doubleView = new DataView(memory.buffer);
    equal(doubleView.getUint8(doubleResult), 0);
    equal(doubleView.getFloat64(doubleResult + 8, true), Math.PI);
    postReturn(doubleResult);

    encoded.setFloat32(0, 1.25, true);
    const singleResult = identity(1, BigInt(encoded.getUint32(0, true)));
    const singleView = new DataView(memory.buffer);
    equal(singleView.getUint8(singleResult), 1);
    equal(singleView.getFloat32(singleResult + 8, true), 1.25);
    postReturn(singleResult);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI exports use caller-facing scalar signatures", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.binary(
          BinaryOperator.AddSignedInteger64,
          surface.signedInteger64(0n),
          surface.signedInteger64(0n),
        ),
      },
      {
        name: "add",
        parameters: ["left", "right"],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: {
            kind: "function",
            parameter: signedInteger64,
            result: signedInteger64,
          },
        },
        body: surface.binary(
          BinaryOperator.AddSignedInteger64,
          surface.name("left"),
          surface.name("right"),
        ),
      },
    ],
    [],
    "main",
    0,
    { wasmExports: [{ name: "blot:add", definition: "add" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "blot:add",
          function: {
            parameters: [canonicalSignedInteger64, canonicalSignedInteger64],
            result: canonicalSignedInteger64,
          },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const add = instance.exports["blot:add"];
    ok(typeof add === "function");
    for (let call = 0; call < 20_000; call += 1) {
      equal(add(20n, 22n), 42n);
    }
    ok(bytes.byteLength < 256, `compact scalar canonical ABI emitted ${bytes.byteLength} bytes`);
    deepStrictEqual(Object.keys(instance.exports).sort(), [
      "blot:abi-major",
      "blot:abi-minor",
      "blot:add",
    ]);
    const major = instance.exports["blot:abi-major"];
    const minor = instance.exports["blot:abi-minor"];
    ok(major instanceof WebAssembly.Global);
    ok(minor instanceof WebAssembly.Global);
    equal(major.value, 1);
    equal(minor.value, 0);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("compact canonical exports preserve every flat scalar parameter", async () => {
  const scalarIdentity = (
    name: string,
    type: typeof float32 | typeof float64 | typeof boolean,
  ) => ({
    name,
    parameters: ["value"],
    annotation: { kind: "function" as const, parameter: type, result: type },
    body: surface.name("value"),
  });
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      scalarIdentity("single", float32),
      scalarIdentity("double", float64),
      scalarIdentity("boolean", boolean),
    ],
    [],
    "main",
    0,
    {
      wasmExports: [
        { name: "blot:single", definition: "single" },
        { name: "blot:double", definition: "double" },
        { name: "blot:boolean", definition: "boolean" },
      ],
    },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [
          {
            name: "blot:single",
            function: { parameters: [float32], result: float32 },
          },
          {
            name: "blot:double",
            function: { parameters: [float64], result: float64 },
          },
          {
            name: "blot:boolean",
            function: { parameters: [boolean], result: boolean },
          },
        ],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const single = instance.exports["blot:single"];
    const double = instance.exports["blot:double"];
    const identityBoolean = instance.exports["blot:boolean"];
    ok(typeof single === "function");
    ok(typeof double === "function");
    ok(typeof identityBoolean === "function");
    equal(single(1.25), 1.25);
    equal(double(Math.PI), Math.PI);
    equal(identityBoolean(1), 1);
    equal(identityBoolean(0), 0);
    ok(bytes.byteLength < 512, `compact scalar canonical ABI emitted ${bytes.byteLength} bytes`);
    deepStrictEqual(Object.keys(instance.exports).sort(), [
      "blot:abi-major",
      "blot:abi-minor",
      "blot:boolean",
      "blot:double",
      "blot:single",
    ]);
    throws(() => identityBoolean(2), WebAssembly.RuntimeError);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("compact canonical exports retain reachable fault evidence", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "divide",
        parameters: ["left", "right"],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: {
            kind: "function",
            parameter: signedInteger64,
            result: signedInteger64,
          },
        },
        body: surface.binary(
          BinaryOperator.DivideSignedInteger64,
          surface.name("left"),
          surface.name("right"),
        ),
      },
    ],
    [],
    "main",
    0,
    {
      wasmExports: [{ name: "blot:divide", definition: "divide" }],
    },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "blot:divide",
          function: {
            parameters: [canonicalSignedInteger64, canonicalSignedInteger64],
            result: canonicalSignedInteger64,
          },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const divide = instance.exports["blot:divide"];
    const runtimeFault = instance.exports.runtimeFault;
    const runtimeFaultNode = instance.exports.runtimeFaultNode;
    ok(typeof divide === "function");
    ok(runtimeFault instanceof WebAssembly.Global);
    ok(runtimeFaultNode instanceof WebAssembly.Global);
    equal(divide(84n, 2n), 42n);
    equal(runtimeFault.value, 0);
    throws(() => divide(1n, 0n), WebAssembly.RuntimeError);
    equal(runtimeFault.value, WasmRuntimeFaultCode.DivideByZero);
    ok(Number(runtimeFaultNode.value) >= 0);
    deepStrictEqual(Object.keys(instance.exports).sort(), [
      "blot:abi-major",
      "blot:abi-minor",
      "blot:divide",
      "runtimeFault",
      "runtimeFaultNode",
    ]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("scalar canonical exports use an internal resettable arena", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "sum",
        parameters: ["left", "right"],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: {
            kind: "function",
            parameter: signedInteger64,
            result: signedInteger64,
          },
        },
        body: surface.case(
          surface.apply(
            surface.name("SignedPair"),
            surface.name("left"),
            surface.name("right"),
          ),
          [{
            constructor: "SignedPair",
            binders: ["first", "second"],
            body: surface.binary(
              BinaryOperator.AddSignedInteger64,
              surface.name("first"),
              surface.name("second"),
            ),
          }],
        ),
      },
    ],
    [{
      name: "SignedPair",
      parameters: [],
      constructors: [{
        name: "SignedPair",
        fields: [{ name: "first", type: signedInteger64 }, {
          name: "second",
          type: signedInteger64,
        }],
      }],
    }],
    "main",
    0,
    { wasmExports: [{ name: "blot:sum", definition: "sum" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "blot:sum",
          function: {
            parameters: [canonicalSignedInteger64, canonicalSignedInteger64],
            result: canonicalSignedInteger64,
          },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const sum = instance.exports["blot:sum"];
    ok(typeof sum === "function");
    for (let call = 0; call < 20_000; call += 1) equal(sum(20n, 22n), 42n);
    ok(bytes.byteLength < 1_200, `arena-backed scalar ABI emitted ${bytes.byteLength} bytes`);
    deepStrictEqual(Object.keys(instance.exports).sort(), [
      "blot:abi-major",
      "blot:abi-minor",
      "blot:sum",
      "runtimeFault",
      "runtimeFaultNode",
    ]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI exports the standard unreachable fault category", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: signedInteger64,
      body: surface.signedInteger64(0n),
    }, {
      name: "fail",
      parameters: ["unit"],
      annotation: {
        kind: "function",
        parameter: unit,
        result: signedInteger64,
      },
      body: surface.unreachable("impossible canonical result"),
    }],
    [],
    "main",
    0,
    { wasmExports: [{ name: "blot:fail", definition: "fail" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "blot:fail",
          function: { parameters: [canonicalUnit], result: canonicalSignedInteger64 },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const fail = instance.exports["blot:fail"];
    ok(typeof fail === "function");
    let trapped = false;
    try {
      fail();
    } catch (error) {
      ok(error instanceof WebAssembly.RuntimeError);
      trapped = true;
    }
    equal(trapped, true);
    const runtimeFault = instance.exports.runtimeFault;
    ok(runtimeFault instanceof WebAssembly.Global);
    equal(runtimeFault.value, WasmRuntimeFaultCode.Unreachable);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI reuses an unchanged resolved-Core artifact", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: signedInteger64,
      body: surface.signedInteger64(42n),
    }],
    [],
    "main",
    0,
    { wasmExports: [{ name: "blot:main", definition: "main" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  const canonicalAbi = {
    version: 1 as const,
    imports: [],
    exports: [{
      name: "blot:main",
      function: { parameters: [], result: canonicalSignedInteger64 },
    }],
  };
  try {
    const bytes = await compileModuleToWasm(compilation.module, { canonicalAbi });
    const warmTrace = new CompilerPerformanceTrace();
    const warmBytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi,
      trace: warmTrace,
    });

    deepStrictEqual(warmBytes, bytes);
    const cachedArtifact = warmTrace.snapshot().find((event) =>
      event.stage === "wasm.artifact.resolved-core"
    );
    equal(cachedArtifact?.annotations.cacheHit, true);
    equal(warmTrace.snapshot().some((event) => event.stage === "wasm.emit"), false);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI host operations use the full structural boundary", async () => {
  const pairSchema = {
    kind: "named" as const,
    name: "Pair",
    arguments: [signedInteger64, signedInteger64],
  };
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "exchange",
        parameters: [],
        annotation: {
          kind: "function",
          parameter: pairSchema,
          result: pairSchema,
        },
        body: surface.runtimeFault("host operation Exchange.exchange"),
      },
      {
        name: "roundtrip",
        parameters: ["pair"],
        annotation: {
          kind: "function",
          parameter: pairSchema,
          result: pairSchema,
        },
        effects: effectSet("Exchange"),
        body: surface.apply(
          surface.name("exchange"),
          surface.name("pair"),
        ),
      },
    ],
    [{
      name: "Pair",
      parameters: ["left", "right"],
      constructors: [{
        name: "Pair",
        fields: [
          { name: "left", type: { kind: "parameter", name: "left" } },
          { name: "right", type: { kind: "parameter", name: "right" } },
        ],
      }],
    }],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Exchange",
        fields: [{
          kind: "operation",
          name: "exchange",
          effects: effectSet("Exchange"),
          parameter: pairSchema,
          result: pairSchema,
        }],
      }],
      hostDefinitions: [{
        definition: "exchange",
        capability: "Exchange",
        field: "exchange",
      }],
      wasmExports: [{ name: "blot:roundtrip", definition: "roundtrip" }],
    },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  const pair = {
    kind: "record" as const,
    constructor: "Pair",
    fields: [
      { name: "left", type: canonicalSignedInteger64, coreIndex: 0 },
      { name: "right", type: canonicalSignedInteger64, coreIndex: 1 },
    ],
  };
  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [{
          capability: "Exchange",
          operation: "exchange",
          module: "blot:host/Exchange",
          name: "exchange",
          function: {
            parameters: [pair],
            result: pair,
          },
        }],
        exports: [{
          name: "blot:roundtrip",
          postReturn: "cabi_post_blot:roundtrip",
          function: {
            parameters: [pair],
            result: pair,
          },
        }],
      },
    });
    const memoryReference: { current?: WebAssembly.Memory } = {};
    const { instance } = await WebAssembly.instantiate(bytes, {
      "blot:host/Exchange": {
        exchange(left: bigint, right: bigint, result: number) {
          const memory = memoryReference.current;
          if (memory === undefined) throw new Error("memory is not initialized");
          const view = new DataView(memory.buffer);
          view.setBigInt64(result, right, true);
          view.setBigInt64(result + 8, left, true);
        },
      },
    });
    const exportedMemory = instance.exports.memory;
    ok(exportedMemory instanceof WebAssembly.Memory);
    memoryReference.current = exportedMemory;
    const roundtrip = instance.exports["blot:roundtrip"];
    const postReturn = instance.exports["cabi_post_blot:roundtrip"];
    ok(typeof roundtrip === "function");
    ok(typeof postReturn === "function");
    const result = roundtrip(20n, 22n);
    const view = new DataView(exportedMemory.buffer);
    equal(view.getBigInt64(result, true), 22n);
    equal(view.getBigInt64(result + 8, true), 20n);
    postReturn(result);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI rejects descriptors that disagree with compiled representations", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "exchange",
        parameters: [],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: signedInteger64,
        },
        body: surface.runtimeFault("host operation Exchange.exchange"),
      },
      {
        name: "roundtrip",
        parameters: ["value"],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: signedInteger64,
        },
        effects: effectSet("Exchange"),
        body: surface.apply(surface.name("exchange"), surface.name("value")),
      },
    ],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Exchange",
        fields: [{
          kind: "operation",
          name: "exchange",
          effects: effectSet("Exchange"),
          parameter: signedInteger64,
          result: signedInteger64,
          parameterRepresentation: HostTypes.erased,
          resultRepresentation: HostTypes.erased,
        }],
      }],
      hostDefinitions: [{
        definition: "exchange",
        capability: "Exchange",
        field: "exchange",
      }],
      wasmExports: [{ name: "blot:roundtrip", definition: "roundtrip" }],
    },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    await rejects(
      () =>
        compileModuleToWasm(compilation.module, {
          canonicalAbi: {
            version: 1,
            imports: [{
              capability: "Exchange",
              operation: "exchange",
              module: "blot:host/Exchange",
              name: "exchange",
              function: {
                parameters: [canonicalSignedInteger64],
                result: canonicalSignedInteger64,
              },
            }],
            exports: [{
              name: "blot:roundtrip",
              function: {
                parameters: [canonicalSignedInteger64],
                result: canonicalSignedInteger64,
              },
            }],
          },
        }),
      /host operation "Exchange\.exchange" parameter describes signed-integer-64, but compiled type is \$FunctionalErased/,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI rejects boolean descriptors for signed i64 exports", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: signedInteger64,
      body: surface.signedInteger64(0n),
    }, {
      name: "identity",
      parameters: ["value"],
      annotation: {
        kind: "function",
        parameter: signedInteger64,
        result: signedInteger64,
      },
      body: surface.name("value"),
    }],
    [],
    "main",
    0,
    { wasmExports: [{ name: "blot:identity", definition: "identity" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    await rejects(
      () =>
        compileModuleToWasm(compilation.module, {
          canonicalAbi: {
            version: 1,
            imports: [],
            exports: [{
              name: "blot:identity",
              function: {
                parameters: [{ kind: "boolean" }],
                result: canonicalSignedInteger64,
              },
            }],
          },
        }),
      /export "blot:identity" parameter 0 describes boolean, but compiled type is signed i64/,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("compact canonical exports bypass global thunk allocation", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: signedInteger64,
      body: surface.signedInteger64(0n),
    }, {
      name: "computed",
      parameters: [],
      annotation: signedInteger64,
      body: surface.binary(
        BinaryOperator.AddSignedInteger64,
        surface.signedInteger64(20n),
        surface.signedInteger64(22n),
      ),
    }],
    [],
    "main",
    0,
    { wasmExports: [{ name: "blot:computed", definition: "computed" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "blot:computed",
          function: { parameters: [], result: canonicalSignedInteger64 },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const computed = instance.exports["blot:computed"];
    ok(typeof computed === "function");
    equal(computed(), 42n);
    ok(bytes.byteLength < 256, `compact scalar canonical ABI emitted ${bytes.byteLength} bytes`);
    deepStrictEqual(Object.keys(instance.exports).sort(), [
      "blot:abi-major",
      "blot:abi-minor",
      "blot:computed",
    ]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI text validates UTF-8 before entering Core", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "identity",
        parameters: ["value"],
        annotation: {
          kind: "function",
          parameter: HostTypes.text,
          result: HostTypes.text,
        },
        body: surface.name("value"),
      },
    ],
    [],
    "main",
    0,
    { wasmExports: [{ name: "blot:identity", definition: "identity" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const text = { kind: "text" as const };
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "blot:identity",
          postReturn: "cabi_post_blot:identity",
          function: {
            parameters: [text],
            result: text,
          },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const memory = instance.exports.memory;
    const reallocate = instance.exports.cabi_realloc;
    const identity = instance.exports["blot:identity"];
    const postReturn = instance.exports["cabi_post_blot:identity"];
    ok(memory instanceof WebAssembly.Memory);
    ok(typeof reallocate === "function");
    ok(typeof identity === "function");
    ok(typeof postReturn === "function");
    const pointer = reallocate(0, 0, 1, 4);
    new Uint8Array(memory.buffer, pointer, 4).set([0xf0, 0x9f, 0x98, 0x80]);
    const resultPointer = identity(pointer, 4);
    const view = new DataView(memory.buffer);
    const resultBytes = view.getUint32(resultPointer, true);
    const resultLength = view.getUint32(resultPointer + 4, true);
    equal(
      new TextDecoder().decode(
        new Uint8Array(memory.buffer, resultBytes, resultLength),
      ),
      "😀",
    );
    postReturn(resultPointer);
    new Uint8Array(memory.buffer, pointer, 4).set([0x61, 0xf0, 0x9f, 0x98]);
    let trapped = false;
    try {
      identity(pointer, 4);
    } catch (error) {
      trapped = error instanceof WebAssembly.RuntimeError;
    }
    ok(trapped, "an incomplete UTF-8 sequence did not trap");
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI accepts and releases empty host text", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "read",
        parameters: [],
        annotation: {
          kind: "function",
          parameter: unit,
          result: HostTypes.text,
        },
        body: surface.runtimeFault("host operation Source.read"),
      },
      {
        name: "read_once",
        parameters: ["unit"],
        annotation: {
          kind: "function",
          parameter: unit,
          result: HostTypes.text,
        },
        effects: effectSet("Source"),
        body: surface.apply(
          surface.name("read"),
          surface.name(UNIT_CONSTRUCTOR_NAME),
        ),
      },
    ],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Source",
        fields: [{
          kind: "operation",
          name: "read",
          effects: effectSet("Source"),
          parameter: unit,
          result: HostTypes.text,
        }],
      }],
      hostDefinitions: [{
        definition: "read",
        capability: "Source",
        field: "read",
      }],
      wasmExports: [{ name: "blot:read", definition: "read_once" }],
    },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(
    compilation.ok,
    compilation.ok ? undefined : compilation.diagnostics[0].message,
  );
  if (!compilation.ok) return;

  const text = { kind: "text" as const };
  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [{
          capability: "Source",
          operation: "read",
          module: "blot:host/Source",
          name: "read",
          function: {
            parameters: [unit],
            result: text,
          },
        }],
        exports: [{
          name: "blot:read",
          postReturn: "cabi_post_blot:read",
          function: {
            parameters: [canonicalUnit],
            result: text,
          },
        }],
      },
    });
    const memoryReference: { current?: WebAssembly.Memory } = {};
    const { instance } = await WebAssembly.instantiate(bytes, {
      "blot:host/Source": {
        read(resultPointer: number) {
          const memory = memoryReference.current;
          ok(memory instanceof WebAssembly.Memory);
          const view = new DataView(memory.buffer);
          view.setUint32(resultPointer, 0, true);
          view.setUint32(resultPointer + 4, 0, true);
        },
      },
    });
    const read = instance.exports["blot:read"];
    const postReturn = instance.exports["cabi_post_blot:read"];
    const memory = instance.exports.memory;
    ok(typeof read === "function");
    ok(typeof postReturn === "function");
    ok(memory instanceof WebAssembly.Memory);
    memoryReference.current = memory;
    for (let call = 0; call < 2; call += 1) {
      const resultPointer: number = Number(read());
      const view: DataView = new DataView(memory.buffer);
      equal(view.getUint32(resultPointer + 4, true), 0);
      postReturn(resultPointer);
    }
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI aggregate results are released by post-return", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "values",
        parameters: ["unit"],
        annotation: {
          kind: "function",
          parameter: unit,
          result: storeType(signedInteger64),
        },
        body: surface.storeNew(
          surface.integer(2),
          surface.signedInteger64(7n),
        ),
      },
    ],
    [],
    "main",
    0,
    { wasmExports: [{ name: "blot:values", definition: "values" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const bytes = await compileModuleToWasm(compilation.module, {
      canonicalAbi: {
        version: 1,
        imports: [],
        exports: [{
          name: "blot:values",
          postReturn: "cabi_post_blot:values",
          function: {
            parameters: [canonicalUnit],
            result: {
              kind: "array",
              element: canonicalSignedInteger64,
            },
          },
        }],
      },
    });
    const { instance } = await WebAssembly.instantiate(bytes);
    const values = instance.exports["blot:values"];
    const postReturn = instance.exports["cabi_post_blot:values"];
    const memory = instance.exports.memory;
    ok(typeof values === "function");
    ok(
      typeof postReturn === "function",
      `exports were ${JSON.stringify(Object.keys(instance.exports))}`,
    );
    ok(memory instanceof WebAssembly.Memory);
    const resultPointer = values();
    equal(typeof resultPointer, "number");
    const view = new DataView(memory.buffer);
    const elementsPointer = view.getUint32(resultPointer, true);
    equal(view.getUint32(resultPointer + 4, true), 2);
    deepStrictEqual(
      [
        view.getBigInt64(elementsPointer, true),
        view.getBigInt64(elementsPointer + 8, true),
      ],
      [7n, 7n],
    );
    postReturn(resultPointer);
    const warmByteLength = memory.buffer.byteLength;
    for (let call = 0; call < 2_000; call += 1) {
      const repeatedResult = values();
      postReturn(repeatedResult);
    }
    equal(memory.buffer.byteLength, warmByteLength);

    const outstandingResult = values();
    let overlapTrapped = false;
    try {
      values();
    } catch (error) {
      overlapTrapped = error instanceof WebAssembly.RuntimeError;
    }
    ok(overlapTrapped, "an overlapping canonical call did not trap");

    let mismatchedPostReturnTrapped = false;
    try {
      postReturn(outstandingResult + 8);
    } catch (error) {
      mismatchedPostReturnTrapped = error instanceof WebAssembly.RuntimeError;
    }
    ok(mismatchedPostReturnTrapped, "a mismatched post-return pointer did not trap");
    postReturn(outstandingResult);
  } finally {
    compilation.module.destroy();
  }
});
