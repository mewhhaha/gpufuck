/**
 * Ducklang (`../binned`) compiles through this backend and imports it by relative path, so a
 * gpufuck change reaches it with no version pin. Nothing else in this suite emits WebAssembly;
 * without these tests the code generator can be deleted or broken and the suite stays green.
 */
import {
  deepStrictEqual,
  equal,
  notStrictEqual,
  ok,
  rejects,
  strictEqual,
} from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  type CompiledModule,
  compileModulesToWasm,
  compileModuleToWasm,
  CpuCompiler,
  extendRecordType,
  FunctionalCompilerService,
  GpuCompiler,
  hasFieldType,
  HostTypes,
  requestWebGpuDevice,
  runWasmModule,
  structuralRecordTypeDeclarations,
  surface,
  type SurfaceExpression,
  type TypeSchema,
} from "../functional.ts";
import { decodeWasmValue } from "../src/functional/wasm_value_codec.ts";

let device: GPUDevice | undefined;
let compiler: GpuCompiler | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  compiler = await GpuCompiler.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  compiler = undefined;
});

function functionalCompiler(): GpuCompiler {
  if (compiler === undefined) throw new Error("functional compiler was not initialized");
  return compiler;
}

async function compileEntry(body: Parameters<typeof surface.apply>[0]) {
  const module = buildSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body }],
    [],
    "main",
    0,
  );
  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) throw new Error("smoke module did not compile");
  return compilation;
}

async function compileCpuEntry(
  compiler: CpuCompiler,
  name: string,
  annotation: TypeSchema,
  body: SurfaceExpression,
): Promise<CompiledModule> {
  const encoded = buildSurfaceModule(
    [{ name, parameters: [], annotation, body }],
    [],
    name,
    0,
  );
  const compilation = await compiler.compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) throw new Error(`CPU entry ${JSON.stringify(name)} did not compile`);
  return compilation.module;
}

Deno.test("emits a WebAssembly artifact that runs to the expected value", async () => {
  const compilation = await compileEntry(
    surface.binary(
      BinaryOperator.Add,
      surface.integer(20),
      surface.binary(BinaryOperator.Multiply, surface.integer(11), surface.integer(2)),
    ),
  );
  try {
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("ordinary lets evaluate only the value selected by control flow", async () => {
  const compilation = await compileEntry(
    surface.let(
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
  );
  try {
    const execution = await runWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 1 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("a single strict use compiles a lazy let without a thunk", async () => {
  const compilation = await compileEntry(
    surface.let(
      "value",
      surface.binary(BinaryOperator.Multiply, surface.integer(6), surface.integer(7)),
      surface.binary(BinaryOperator.Add, surface.integer(0), surface.name("value")),
    ),
  );
  try {
    const execution = await runWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
    equal(execution.stats.thunkEvaluations, 0);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("sequence evaluates an unused value before its body", async () => {
  const compilation = await compileEntry(
    surface.sequence(
      "ignored",
      surface.runtimeFault("sequenced value"),
      surface.integer(42),
    ),
  );
  try {
    await rejects(() => runWasmModule(compilation.module), /sequenced value/);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("unreachable paths retain their standard category in WebAssembly", async () => {
  const compilation = await compileEntry(
    surface.if(
      surface.boolean(false),
      surface.integer(0),
      surface.unreachable("pattern invariant"),
    ),
  );
  try {
    await rejects(
      () => runWasmModule(compilation.module),
      /F3014:.*unreachable path: pattern invariant/,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("a value-carrying join returns its argument in WebAssembly", async () => {
  const compilation = await compileEntry(
    {
      kind: "let-rec-group",
      bindings: [{
        name: "loop",
        parameters: ["iteration"],
        body: surface.if(
          surface.binary(
            BinaryOperator.Less,
            surface.name("iteration"),
            surface.integer(0),
          ),
          surface.apply(surface.name("loop"), surface.name("iteration")),
          surface.join(
            "done",
            "value",
            surface.if(
              surface.boolean(true),
              surface.jump("done", surface.integer(41)),
              surface.jump("done", surface.integer(0)),
            ),
            surface.binary(
              BinaryOperator.Add,
              surface.name("value"),
              surface.integer(1),
            ),
          ),
        ),
      }],
      body: surface.apply(surface.name("loop"), surface.integer(0)),
    },
  );
  try {
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("a contified join skips an unused argument", async () => {
  const compilation = await compileEntry({
    kind: "let-rec-group",
    bindings: [{
      name: "loop",
      parameters: ["iteration"],
      body: surface.if(
        surface.binary(
          BinaryOperator.Less,
          surface.name("iteration"),
          surface.integer(0),
        ),
        surface.apply(surface.name("loop"), surface.name("iteration")),
        surface.join(
          "done",
          "ignored",
          surface.jump("done", surface.runtimeFault("strict join argument")),
          surface.integer(42),
        ),
      ),
    }],
    body: surface.apply(surface.name("loop"), surface.integer(0)),
  });
  try {
    const execution = await runWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("HasField evidence shares one open projection across record layouts", async () => {
  const firstLayout = {
    type: "FirstRecord",
    constructor: "FirstRecord",
    fields: ["x", "enabled"],
  } as const;
  const secondLayout = {
    type: "SecondRecord",
    constructor: "SecondRecord",
    fields: ["name", "x"],
  } as const;
  const declarations = [
    {
      name: firstLayout.type,
      parameters: [],
      constructors: [{
        name: firstLayout.constructor,
        fields: [
          { name: "x", type: { kind: "integer" as const } },
          { name: "enabled", type: { kind: "boolean" as const } },
        ],
      }],
    },
    {
      name: secondLayout.type,
      parameters: [],
      constructors: [{
        name: secondLayout.constructor,
        fields: [
          { name: "name", type: { kind: "integer" as const } },
          { name: "x", type: { kind: "integer" as const } },
        ],
      }],
    },
    ...structuralRecordTypeDeclarations(["x"]),
  ];
  const module = buildSurfaceModule(
    [
      {
        name: "getX",
        parameters: ["evidence", "record"],
        annotation: {
          kind: "function",
          parameter: hasFieldType(
            "x",
            { kind: "parameter", name: "record" },
            { kind: "parameter", name: "value" },
          ),
          result: {
            kind: "function",
            parameter: { kind: "parameter", name: "record" },
            result: { kind: "parameter", name: "value" },
          },
        },
        body: surface.projectField("x", surface.name("record"), surface.name("evidence")),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "integer" },
        body: surface.binary(
          BinaryOperator.Add,
          surface.apply(
            surface.name("getX"),
            surface.hasFieldEvidence(firstLayout, "x"),
            surface.structuralRecord(firstLayout, {
              x: surface.integer(20),
              enabled: surface.boolean(true),
            }),
          ),
          surface.apply(
            surface.name("getX"),
            surface.hasFieldEvidence(secondLayout, "x"),
            surface.structuralRecord(secondLayout, {
              name: surface.integer(7),
              x: surface.integer(22),
            }),
          ),
        ),
      },
    ],
    declarations,
    "main",
    0,
  );
  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) return;

  try {
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("ExtendRecord evidence shares one open extension across layouts", async () => {
  const sourceLayout = {
    type: "SourceRecord",
    constructor: "SourceRecord",
    fields: ["x", "y"],
  } as const;
  const patchLayout = {
    type: "RecordPatch",
    constructor: "RecordPatch",
    fields: ["y", "z"],
  } as const;
  const resultLayout = {
    type: "ExtendedRecord",
    constructor: "ExtendedRecord",
    fields: ["x", "y", "z"],
  } as const;
  const recordDeclaration = (
    layout: typeof sourceLayout | typeof patchLayout | typeof resultLayout,
  ) => ({
    name: layout.type,
    parameters: [],
    constructors: [{
      name: layout.constructor,
      fields: layout.fields.map((name) => ({
        name,
        type: { kind: "integer" as const },
      })),
    }],
  });
  const sourceType = { kind: "parameter" as const, name: "source" };
  const patchType = { kind: "parameter" as const, name: "patch" };
  const resultType = { kind: "parameter" as const, name: "result" };
  const module = buildSurfaceModule(
    [{
      name: "extend",
      parameters: ["evidence", "source", "patch"],
      annotation: {
        kind: "function",
        parameter: extendRecordType(sourceType, patchType, resultType),
        result: {
          kind: "function",
          parameter: sourceType,
          result: { kind: "function", parameter: patchType, result: resultType },
        },
      },
      body: surface.extendRecord(
        surface.name("source"),
        surface.name("patch"),
        surface.name("evidence"),
      ),
    }, {
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.case(
        surface.apply(
          surface.name("extend"),
          surface.extendRecordEvidence(sourceLayout, patchLayout, resultLayout),
          surface.structuralRecord(sourceLayout, {
            x: surface.integer(10),
            y: surface.integer(1),
          }),
          surface.structuralRecord(patchLayout, {
            y: surface.integer(20),
            z: surface.integer(12),
          }),
        ),
        [{
          constructor: resultLayout.constructor,
          binders: ["x", "y", "z"],
          body: surface.binary(
            BinaryOperator.Add,
            surface.name("x"),
            surface.binary(BinaryOperator.Add, surface.name("y"), surface.name("z")),
          ),
        }],
      ),
    }],
    [
      recordDeclaration(sourceLayout),
      recordDeclaration(patchLayout),
      recordDeclaration(resultLayout),
      ...structuralRecordTypeDeclarations([]),
    ],
    "main",
    0,
  );
  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) return;

  try {
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("CPU compilation emits executable Core without initializing WebGPU", async () => {
  const service = new FunctionalCompilerService();
  try {
    const encoded = buildSurfaceModule(
      [{
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.binary(
          BinaryOperator.Add,
          surface.integer(20),
          surface.integer(22),
        ),
      }],
      [],
      "main",
      0,
    );
    const compilation = await service.compileModule(encoded);
    ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
    if (!compilation.ok) return;
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
    equal("nodeBuffer" in compilation.module, false);
  } finally {
    await service.destroy();
  }
  await rejects(
    () => service.compileBatch([]),
    /functional compiler service was destroyed/,
  );
});

Deno.test("compiler service reuses an unchanged CPU compilation", async () => {
  const service = new FunctionalCompilerService({ backend: "cpu" });
  const encoded = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.integer(42),
    }],
    [],
    "main",
    0,
  );
  try {
    const first = await service.compileModule(encoded);
    const second = await service.compileModule(encoded);
    ok(first.ok);
    ok(second.ok);
    if (!first.ok || !second.ok) return;
    strictEqual(second.module, first.module);
    await rejects(
      () => service.compileModule(encoded, { maximumSteps: 0 }),
      /maximumSteps/,
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("compiler service reuses semantics while rebinding changed source spans", async () => {
  const service = new FunctionalCompilerService({ backend: "cpu" });
  const firstEncoded = buildSurfaceModule(
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
  const secondEncoded = buildSurfaceModule(
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
  try {
    const first = await service.compileModule(firstEncoded);
    const second = await service.compileModule(secondEncoded);
    ok(first.ok);
    ok(second.ok);
    if (!first.ok || !second.ok) return;
    notStrictEqual(second.module, first.module);
    strictEqual(second.module.wasmExports, first.module.wasmExports);
    const secondEntry = (await second.module.readCoreNodes())[
      second.module.definitionRoots[second.module.entryDefinition]!
    ];
    equal(secondEntry?.sourceByteOffset, 5);
    equal(secondEntry?.sourceEndByte, 7);
    equal(
      await compileModuleToWasm(first.module).then((bytes) => bytes.byteLength),
      await compileModuleToWasm(second.module).then((bytes) => bytes.byteLength),
    );
  } finally {
    await service.destroy();
  }
});

Deno.test("resolved-Core cache distinguishes text literal payloads", async () => {
  const cpuCompiler = new CpuCompiler();
  const first = await compileCpuEntry(
    cpuCompiler,
    "cached_text_entry",
    HostTypes.text,
    surface.text("alpha"),
  );
  const second = await compileCpuEntry(
    cpuCompiler,
    "cached_text_entry",
    HostTypes.text,
    surface.text("bravo"),
  );
  try {
    deepStrictEqual((await runWasmModule(first)).value, { kind: "text", value: "alpha" });
    deepStrictEqual((await runWasmModule(second)).value, { kind: "text", value: "bravo" });
  } finally {
    first.destroy();
    second.destroy();
  }
});

Deno.test("resolved-Core cache distinguishes bytes literal payloads", async () => {
  const cpuCompiler = new CpuCompiler();
  const firstValue = Uint8Array.of(0, 1, 127, 255);
  const secondValue = Uint8Array.of(2, 3, 128, 254);
  const first = await compileCpuEntry(
    cpuCompiler,
    "cached_bytes_entry",
    HostTypes.bytes,
    surface.bytes(firstValue),
  );
  const second = await compileCpuEntry(
    cpuCompiler,
    "cached_bytes_entry",
    HostTypes.bytes,
    surface.bytes(secondValue),
  );
  try {
    deepStrictEqual((await runWasmModule(first)).value, { kind: "bytes", value: firstValue });
    deepStrictEqual((await runWasmModule(second)).value, { kind: "bytes", value: secondValue });
  } finally {
    first.destroy();
    second.destroy();
  }
});

Deno.test("batch WebAssembly preserves text and bytes literal payloads", async () => {
  const cpuCompiler = new CpuCompiler();
  const firstBytes = Uint8Array.of(0, 127, 128, 255);
  const secondBytes = Uint8Array.of(1, 2, 3, 4);
  const modules = await Promise.all([
    compileCpuEntry(cpuCompiler, "first_text", HostTypes.text, surface.text("hello")),
    compileCpuEntry(cpuCompiler, "second_text", HostTypes.text, surface.text("world")),
    compileCpuEntry(cpuCompiler, "first_bytes", HostTypes.bytes, surface.bytes(firstBytes)),
    compileCpuEntry(cpuCompiler, "second_bytes", HostTypes.bytes, surface.bytes(secondBytes)),
  ]);
  try {
    const exportNames = ["firstText", "secondText", "firstBytes", "secondBytes"];
    const artifact = await compileModulesToWasm(modules, { exportNames });
    const instance = new WebAssembly.Instance(new WebAssembly.Module(artifact.bytes), {});
    const initialize = instance.exports.initialize;
    ok(typeof initialize === "function");
    initialize();

    const expected = [
      { kind: "text", value: "hello" },
      { kind: "text", value: "world" },
      { kind: "bytes", value: firstBytes },
      { kind: "bytes", value: secondBytes },
    ] as const;
    for (const [index, name] of exportNames.entries()) {
      const exported = instance.exports[name];
      ok(typeof exported === "function", `batch WebAssembly omitted export ${name}`);
      const encoded = exported() as bigint;
      const decoded = decodeWasmValue(
        instance,
        modules[index]!,
        modules[index]!.entryType,
        encoded,
        16,
        1_024,
      );
      deepStrictEqual(decoded, {
        kind: expected[index]!.kind,
        value: expected[index]!.value,
      });
    }
  } finally {
    for (const module of modules) module.destroy();
  }
});

Deno.test("batch WebAssembly exposes independent entries from one artifact", async () => {
  const cpuCompiler = new CpuCompiler();
  const modules = [];
  for (const value of [20, 22]) {
    const encoded = buildSurfaceModule(
      [{
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.case(
          surface.apply(surface.name("Wrap"), surface.integer(value)),
          [{
            constructor: "Wrap",
            binders: ["wrapped"],
            body: surface.name("wrapped"),
          }],
        ),
      }],
      [{
        name: "Box",
        parameters: [],
        constructors: [{
          name: "Wrap",
          fields: [{ name: "value", type: { kind: "integer" } }],
        }],
      }],
      "main",
      0,
    );
    const compilation = await cpuCompiler.compileModule(encoded);
    ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
    if (!compilation.ok) throw new Error("CPU batch fixture did not compile");
    modules.push(compilation.module);
  }
  try {
    const separate = await Promise.all(modules.map((module) => compileModuleToWasm(module)));
    const artifact = await compileModulesToWasm(modules, {
      exportNames: ["left", "right"],
    });
    ok(
      artifact.bytes.byteLength < separate[0]!.byteLength + separate[1]!.byteLength,
      `shared artifact was ${artifact.bytes.byteLength} bytes; separate artifacts totalled ${
        separate[0]!.byteLength + separate[1]!.byteLength
      }`,
    );
    const instantiated = await WebAssembly.instantiate(artifact.bytes);
    const left = instantiated.instance.exports.left;
    const right = instantiated.instance.exports.right;
    ok(typeof left === "function");
    ok(typeof right === "function");
    equal(left(), 20);
    equal(right(), 22);
  } finally {
    for (const module of modules) module.destroy();
  }
});

Deno.test("executes zero-arity and exact-arity calls without synthetic Core binders", async () => {
  const compilation = await compileEntry(
    surface.apply(
      surface.lambda(
        [],
        surface.apply(
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
      ),
    ),
  );
  try {
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("emits a well-formed WebAssembly binary that instantiates standalone", async () => {
  const compilation = await compileEntry(surface.integer(7));
  try {
    const bytes = await compileModuleToWasm(compilation.module);
    ok(bytes.byteLength > 8, `artifact was ${bytes.byteLength} bytes`);
    // Magic number and version: the emitted bytes must be a real module, not a stub.
    equal(Array.from(bytes.slice(0, 4)).join(","), "0,97,115,109");
    ok(WebAssembly.validate(bytes), "emitted bytes failed WebAssembly.validate");
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("executes 64-bit float arithmetic that the GPU evaluator delegates to WebAssembly", async () => {
  const compilation = await compileEntry(
    surface.binary(
      BinaryOperator.AddFloat64,
      surface.float64(1.5),
      surface.float64(2.25),
    ),
  );
  try {
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "float-64");
    equal(execution.value.kind === "float-64" ? execution.value.value : undefined, 3.75);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("an empty Store grows to hold a value in linear-memory WebAssembly", async () => {
  const compilation = await compileEntry(
    surface.storeRead(
      surface.storeGrow(
        surface.storeEmpty(),
        surface.integer(1),
        surface.integer(42),
      ),
      surface.integer(0),
    ),
  );
  try {
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("a sole write reuses its freshly allocated Store", async () => {
  const fresh = await compileEntry(
    surface.storeRead(
      surface.storeNew(surface.integer(1), surface.integer(0)),
      surface.integer(0),
    ),
  );
  const updated = await compileEntry(
    surface.let(
      "store",
      surface.storeNew(surface.integer(1), surface.integer(0)),
      surface.storeRead(
        surface.storeWrite(surface.name("store"), surface.integer(0), surface.integer(42)),
        surface.integer(0),
      ),
    ),
  );
  try {
    const freshExecution = await runWasmModule(fresh.module);
    const updatedExecution = await runWasmModule(updated.module);
    deepStrictEqual(updatedExecution.value, { kind: "integer", value: 42 });
    equal(updatedExecution.stats.allocatedBytes, freshExecution.stats.allocatedBytes);
  } finally {
    fresh.module.destroy();
    updated.module.destroy();
  }
});
