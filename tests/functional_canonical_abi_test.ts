import { deepStrictEqual, equal, ok } from "node:assert/strict";

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
} from "../functional.ts";

const signedInteger64 = { kind: "signed-integer-64" as const };
const canonicalSignedInteger64 = { kind: "signed-integer-64" as const };

Deno.test("canonical ABI exports use caller-facing scalar signatures", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
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
    equal(add(20n, 22n), 42n);
    ok(typeof instance.exports.cabi_realloc === "function");
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
    new Uint8Array(memory.buffer, pointer, 4).set([0x61, 0xf0, 0x9f, 0x98]);
    let trapped = false;
    try {
      identity(pointer, 4);
    } catch (error) {
      trapped = error instanceof WebAssembly.RuntimeError;
    }
    ok(trapped, "an incomplete UTF-8 sequence did not trap");

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
    reallocate(pointer, 4, 1, 0);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical ABI accepts and releases empty host text", async () => {
  const unit = { kind: "unit" as const };
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
        parameters: [],
        annotation: HostTypes.text,
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
            parameters: [],
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
        parameters: [],
        annotation: storeType(signedInteger64),
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
            parameters: [],
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
  } finally {
    compilation.module.destroy();
  }
});
