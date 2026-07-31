/**
 * Ducklang (`../binned`) compiles through this backend and imports it by relative path, so a
 * gpufuck change reaches it with no version pin. Nothing else in this suite emits WebAssembly;
 * without these tests the code generator can be deleted or broken and the suite stays green.
 */
import { equal, notStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  compileModulesToWasm,
  compileModuleToWasm,
  CpuCompiler,
  EvaluationProfile,
  FunctionalCompilerService,
  GpuCompiler,
  planModuleStorage,
  requestWebGpuDevice,
  runWasmModule,
  surface,
} from "../functional.ts";

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
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) throw new Error("smoke module did not compile");
  return compilation;
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
      { evaluationProfile: EvaluationProfile.LazyCallByNeed },
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
      { evaluationProfile: EvaluationProfile.LazyCallByNeed },
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

Deno.test("caller-supplied Storage Core retains the verified compilation path", async () => {
  const compilation = await compileEntry(surface.integer(7));
  try {
    const storage = await planModuleStorage(compilation.module);
    const bytes = await compileModuleToWasm(compilation.module, {
      storageCore: storage.core,
    });
    ok(WebAssembly.validate(bytes), "Storage Core artifact failed WebAssembly.validate");
    const { instance } = await WebAssembly.instantiate(bytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 7);
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

Deno.test("an empty Store grows to hold a value in WasmGC", async () => {
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
    const bytes = await compileModuleToWasm(compilation.module, { backend: "wasm-gc" });
    const { instance } = await WebAssembly.instantiate(bytes);
    const main = instance.exports.main as unknown as () => unknown;
    const valueKind = instance.exports.valueKind as unknown as (value: unknown) => number;
    const valuePayload = instance.exports.valuePayload as unknown as (value: unknown) => number;
    const value = main();

    equal(valueKind(value), 0);
    equal(valuePayload(value), 42);
  } finally {
    compilation.module.destroy();
  }
});
