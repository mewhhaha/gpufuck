import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  compileModuleToWasm,
  EvaluationProfile,
  f32x4,
  F32x4Definition,
  FIXED_VECTOR_DEFINITIONS,
  FIXED_VECTOR_TYPE_DECLARATIONS,
  GpuCompiler,
  linkModules,
  requestWebGpuDevice,
  runWasmModule,
  surface,
  type WasmCompilationOptions,
} from "../functional.ts";
import { compileWasmArtifact } from "../src/functional/wasm_codegen.ts";

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

function functionalWasmCompiler(): GpuCompiler {
  if (compiler === undefined) throw new Error("functional SIMD test compiler is not initialized");
  return compiler;
}

Deno.test("fixed F32x4 builders reject lanes outside the four-lane shape", () => {
  const vector = f32x4.splat(surface.float32(0));
  throws(
    () => f32x4.extractLane(vector, -1),
    /lane must be an integer within \[0, 3\]; received -1/,
  );
  throws(
    () => f32x4.replaceLane(vector, 4, surface.float32(0)),
    /lane must be an integer within \[0, 3\]; received 4/,
  );
  throws(
    () => f32x4.shuffle(vector, vector, [0, 1, 2, 8]),
    /shuffle lane must be an integer within \[0, 7\]; received 8/,
  );
  throws(
    () => f32x4.swizzle(vector, [0, 1, 2, 4]),
    /lane must be an integer within \[0, 3\]; received 4/,
  );
});

Deno.test("F32x4 shuffle agrees in portable and native SIMD modes", async () => {
  const shuffled = f32x4.shuffle(
    f32x4.make([
      surface.float32(1),
      surface.float32(2),
      surface.float32(3),
      surface.float32(4),
    ]),
    f32x4.make([
      surface.float32(5),
      surface.float32(6),
      surface.float32(7),
      surface.float32(8),
    ]),
    [0, 5, 2, 7],
  );
  const encoded = buildSurfaceModule(
    [...FIXED_VECTOR_DEFINITIONS, {
      name: "main",
      parameters: [],
      annotation: { kind: "float-32" },
      body: f32x4.reduceAdd(shuffled),
    }],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional shuffle module did not compile");
  try {
    const portable = await runWasmModule(compilation.module);
    deepStrictEqual(portable.value, { kind: "float-32", value: 18 });
    const nativeBytes = await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    ok(nativeBytes.includes(0xfd), "native shuffle omitted its SIMD instruction prefix");
    const { instance } = await WebAssembly.instantiate(nativeBytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 18);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("canonical fixed-vector definitions are deeply immutable", () => {
  const definition = FIXED_VECTOR_DEFINITIONS.find((candidate) =>
    candidate.name === F32x4Definition.Add
  );
  if (definition === undefined) throw new Error("canonical F32x4 addition definition is missing");
  throws(
    () => {
      (definition.body as { kind: string }).kind = "integer";
    },
    TypeError,
  );
  const body = definition.body;
  if (body.kind !== "case") {
    throw new Error(`canonical F32x4 addition has unexpected ${body.kind} body`);
  }
  throws(
    () => {
      (body.arms as unknown as unknown[]).push(body.arms[0]);
    },
    TypeError,
  );
});

Deno.test("linked fixed-vector definitions retain native SIMD lowering", async () => {
  const vector = f32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const linked = linkModules([{
    name: "vectors",
    definitions: [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "identityMask",
        parameters: ["mask"],
        annotation: {
          kind: "function",
          parameter: f32x4.maskType,
          result: f32x4.maskType,
        },
        body: surface.name("mask"),
      },
      {
        name: "second",
        parameters: ["ignored", "vector"],
        annotation: {
          kind: "function",
          parameter: { kind: "integer" },
          result: {
            kind: "function",
            parameter: f32x4.type,
            result: f32x4.type,
          },
        },
        body: surface.name("vector"),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.reduceAdd(
          f32x4.select(
            surface.apply(
              surface.name("identityMask"),
              f32x4.equal(vector, vector),
            ),
            surface.apply(
              surface.name("second"),
              surface.integer(0),
              f32x4.multiply(
                vector,
                f32x4.splat(surface.float32(2)),
              ),
            ),
            f32x4.splat(surface.float32(0)),
          ),
        ),
      },
    ],
    typeDeclarations: FIXED_VECTOR_TYPE_DECLARATIONS,
    imports: [],
    exports: [{
      name: "main",
      definition: "main",
      type: { kind: "float-32" },
    }],
    sourceByteLength: 0,
    options: { evaluationProfile: EvaluationProfile.StrictEager },
  }], { module: "vectors", exportName: "main" });

  const compilation = await functionalWasmCompiler().compileModule(linked.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("linked functional fixed-vector module did not compile");
  try {
    const simdBytes = await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    ok(simdBytes.includes(0xfd), "linked fixed-vector output omitted native SIMD instructions");
    const { instance } = await WebAssembly.instantiate(simdBytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 20);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("fixed F32x4 operations agree in portable and native SIMD modes", async () => {
  const vector = f32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const selected = f32x4.select(
    f32x4.less(vector, f32x4.splat(surface.float32(3))),
    f32x4.add(vector, f32x4.splat(surface.float32(10))),
    f32x4.multiply(vector, f32x4.splat(surface.float32(2))),
  );
  const mapped = f32x4.map(
    surface.lambda(
      "value",
      surface.binary(
        BinaryOperator.MultiplyFloat32,
        surface.name("value"),
        surface.float32(2),
      ),
    ),
    selected,
  );
  const zipped = f32x4.zip(
    surface.lambda(
      "left",
      surface.lambda(
        "right",
        surface.binary(
          BinaryOperator.AddFloat32,
          surface.name("left"),
          surface.name("right"),
        ),
      ),
    ),
    mapped,
    f32x4.replaceLane(vector, 2, surface.float32(20)),
  );
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.fold(
          surface.lambda(
            "accumulator",
            surface.lambda(
              "lane",
              surface.binary(
                BinaryOperator.AddFloat32,
                surface.name("accumulator"),
                surface.name("lane"),
              ),
            ),
          ),
          surface.float32(0),
          zipped,
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );

  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional fixed-vector module did not compile");
  try {
    const portableExecution = await runWasmModule(compilation.module);
    deepStrictEqual(portableExecution.value, { kind: "float-32", value: 101 });
    const explicitlyPortableBytes = await compileModuleToWasm(compilation.module, {
      simd: "portable-scalar",
    });
    deepStrictEqual(explicitlyPortableBytes, portableExecution.bytes);

    const simdBytes = await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    equal(WebAssembly.validate(simdBytes), true);
    ok(simdBytes.includes(0xfd), "native SIMD output omitted every SIMD instruction prefix");
    const wasmModule = new WebAssembly.Module(simdBytes);
    deepStrictEqual(
      WebAssembly.Module.exports(wasmModule).map((exported) => exported.name),
      ["main"],
    );
    const instance = await WebAssembly.instantiate(wasmModule);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 101);
    simdBytes[0] = 0xff;
    const secondSimdBytes = await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    equal(WebAssembly.validate(secondSimdBytes), true);
    await rejects(
      () =>
        compileModuleToWasm(compilation.module, {
          simd: "unknown",
        } as unknown as WasmCompilationOptions),
      /SIMD mode must be portable-scalar or wasm-simd; received "unknown"/,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("native F32x4 lane operations, comparisons, and reductions preserve Float32 results", async () => {
  const quotient = f32x4.divide(
    f32x4.subtract(
      f32x4.make([
        surface.float32(8),
        surface.float32(12),
        surface.float32(16),
        surface.float32(20),
      ]),
      f32x4.splat(surface.float32(4)),
    ),
    f32x4.splat(surface.float32(4)),
  );
  const selected = f32x4.select(
    f32x4.equal(
      quotient,
      f32x4.make([
        surface.float32(1),
        surface.float32(2),
        surface.float32(0),
        surface.float32(4),
      ]),
    ),
    quotient,
    f32x4.splat(surface.float32(10)),
  );
  const repaired = f32x4.replaceLane(selected, 2, surface.float32(3));
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: surface.binary(
          BinaryOperator.AddFloat32,
          f32x4.reduceAdd(repaired),
          f32x4.extractLane(repaired, 1),
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional fixed-vector module did not compile");
  try {
    const simdBytes = await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    equal(WebAssembly.validate(simdBytes), true);
    const { instance } = await WebAssembly.instantiate(simdBytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 12);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("strict F32x4 functions use an allocation-free internal vector worker", async () => {
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "doubleVector",
        parameters: ["vector"],
        annotation: {
          kind: "function",
          parameter: f32x4.type,
          result: f32x4.type,
        },
        body: f32x4.multiply(
          surface.name("vector"),
          f32x4.splat(surface.float32(2)),
        ),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.reduceAdd(
          surface.apply(
            surface.name("doubleVector"),
            f32x4.make([
              surface.float32(1),
              surface.float32(2),
              surface.float32(3),
              surface.float32(4),
            ]),
          ),
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional F32x4 worker module did not compile");
  try {
    const simdBytes = await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    const wasmModule = new WebAssembly.Module(simdBytes);
    const exportedNames = WebAssembly.Module.exports(wasmModule).map((exported) => exported.name);
    deepStrictEqual(exportedNames, ["main"]);
    const instance = await WebAssembly.instantiate(wasmModule);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 20);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("strict F32x4 values stay native across let-bound multi-function chains", async () => {
  const vector = f32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "second",
        parameters: ["ignored", "vector"],
        annotation: {
          kind: "function",
          parameter: { kind: "integer" },
          result: {
            kind: "function",
            parameter: f32x4.type,
            result: f32x4.type,
          },
        },
        body: surface.name("vector"),
      },
      {
        name: "doubleVector",
        parameters: ["vector"],
        annotation: {
          kind: "function",
          parameter: f32x4.type,
          result: f32x4.type,
        },
        body: f32x4.multiply(surface.name("vector"), f32x4.splat(surface.float32(2))),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.reduceAdd(
          surface.let(
            "vector",
            vector,
            surface.apply(
              surface.name("doubleVector"),
              surface.apply(surface.name("second"), surface.integer(0), surface.name("vector")),
            ),
          ),
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional F32x4 chain module did not compile");
  try {
    const artifact = compileWasmArtifact(
      compilation.module,
      await compilation.module.readCoreNodes(),
      false,
      { simd: "wasm-simd" },
    );
    equal(artifact.nativeF32x4CallSites, 2);
    const { instance } = await WebAssembly.instantiate(artifact.bytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 20);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("mixed boxed and native callers keep the whole F32x4 worker region boxed", async () => {
  const readerType = {
    kind: "function" as const,
    parameter: { kind: "integer" as const },
    result: f32x4.type,
  };
  const vector = f32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "doubleVector",
        parameters: ["vector"],
        annotation: {
          kind: "function",
          parameter: f32x4.type,
          result: f32x4.type,
        },
        body: f32x4.multiply(surface.name("vector"), f32x4.splat(surface.float32(2))),
      },
      {
        name: "throughWorker",
        parameters: ["vector"],
        annotation: {
          kind: "function",
          parameter: f32x4.type,
          result: f32x4.type,
        },
        body: surface.apply(surface.name("doubleVector"), surface.name("vector")),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: surface.let(
          "vector",
          vector,
          surface.let(
            "boxedReader",
            surface.apply(
              surface.name("VectorReader"),
              surface.lambda(
                "ignored",
                surface.apply(surface.name("doubleVector"), surface.name("vector")),
              ),
            ),
            f32x4.reduceAdd(
              f32x4.add(
                surface.apply(surface.name("throughWorker"), surface.name("vector")),
                surface.case(surface.name("boxedReader"), [{
                  constructor: "VectorReader",
                  binders: ["read"],
                  body: surface.apply(surface.name("read"), surface.integer(0)),
                }]),
              ),
            ),
          ),
        ),
      },
    ],
    [
      ...FIXED_VECTOR_TYPE_DECLARATIONS,
      {
        name: "VectorReaderBox",
        parameters: [],
        constructors: [{
          name: "VectorReader",
          fields: [{ name: "read", type: readerType }],
        }],
      },
    ],
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("mixed F32x4 worker module did not compile");
  try {
    const artifact = compileWasmArtifact(
      compilation.module,
      await compilation.module.readCoreNodes(),
      false,
      { simd: "wasm-simd" },
    );
    equal(artifact.nativeF32x4CallSites, 0);
    const { instance } = await WebAssembly.instantiate(artifact.bytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 40);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("projected record fields keep F32x4 workers boxed at their representation boundary", async () => {
  const vectorPairType = {
    kind: "named" as const,
    name: "VectorPair",
    arguments: [],
  };
  const vector = f32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "addProjected",
        parameters: ["left", "pair"],
        annotation: {
          kind: "function",
          parameter: f32x4.type,
          result: {
            kind: "function",
            parameter: vectorPairType,
            result: f32x4.type,
          },
        },
        body: f32x4.add(
          surface.name("left"),
          surface.case(surface.name("pair"), [{
            constructor: "VectorPair",
            binders: ["ignored", "right"],
            body: surface.name("right"),
          }]),
        ),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.reduceAdd(
          surface.apply(
            surface.name("addProjected"),
            vector,
            surface.apply(surface.name("VectorPair"), vector, vector),
          ),
        ),
      },
    ],
    [
      ...FIXED_VECTOR_TYPE_DECLARATIONS,
      {
        name: "VectorPair",
        parameters: [],
        constructors: [{
          name: "VectorPair",
          fields: [
            { name: "left", type: f32x4.type },
            { name: "right", type: f32x4.type },
          ],
        }],
      },
    ],
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional F32x4 projection module did not compile");
  try {
    const artifact = compileWasmArtifact(
      compilation.module,
      await compilation.module.readCoreNodes(),
      false,
      { simd: "wasm-simd" },
    );
    equal(artifact.nativeF32x4CallSites, 0);
    const { instance } = await WebAssembly.instantiate(artifact.bytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 20);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("strict F32x4 values stay native in let-bound body locals", async () => {
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: surface.let(
          "vector",
          f32x4.make([
            surface.float32(1),
            surface.float32(2),
            surface.float32(3),
            surface.float32(4),
          ]),
          surface.let(
            "doubled",
            f32x4.multiply(
              surface.name("vector"),
              f32x4.splat(surface.float32(2)),
            ),
            f32x4.reduceAdd(surface.name("doubled")),
          ),
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional F32x4 local module did not compile");
  try {
    const artifact = compileWasmArtifact(
      compilation.module,
      await compilation.module.readCoreNodes(),
      false,
      { simd: "wasm-simd" },
    );
    equal(artifact.nativeF32x4LetBindings, 2);
    equal(artifact.nativeF32x4CallSites, 0);
    const { instance } = await WebAssembly.instantiate(artifact.bytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 20);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("materialized closures box captured native F32x4 values", async () => {
  const readerType = {
    kind: "function" as const,
    parameter: { kind: "integer" as const },
    result: f32x4.type,
  };
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: surface.let(
          "vector",
          f32x4.make([
            surface.float32(1),
            surface.float32(2),
            surface.float32(3),
            surface.float32(4),
          ]),
          surface.let(
            "boxedReader",
            surface.apply(
              surface.name("VectorReader"),
              surface.lambda("ignored", surface.name("vector")),
            ),
            f32x4.reduceAdd(
              surface.case(surface.name("boxedReader"), [{
                constructor: "VectorReader",
                binders: ["read"],
                body: surface.apply(surface.name("read"), surface.integer(0)),
              }]),
            ),
          ),
        ),
      },
    ],
    [
      ...FIXED_VECTOR_TYPE_DECLARATIONS,
      {
        name: "VectorReaderBox",
        parameters: [],
        constructors: [{
          name: "VectorReader",
          fields: [{ name: "read", type: readerType }],
        }],
      },
    ],
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("captured F32x4 closure module did not compile");
  try {
    const bytes = await compileModuleToWasm(compilation.module, { simd: "wasm-simd" });
    const { instance } = await WebAssembly.instantiate(bytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 10);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("recursive closures box captured native F32x4 values", async () => {
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.reduceAdd(
          surface.let(
            "vector",
            f32x4.make([
              surface.float32(1),
              surface.float32(2),
              surface.float32(3),
              surface.float32(4),
            ]),
            {
              kind: "let-rec",
              name: "loop",
              value: surface.lambda(
                "iteration",
                surface.if(
                  surface.equal(surface.name("iteration"), surface.integer(0)),
                  surface.name("vector"),
                  surface.apply(
                    surface.name("loop"),
                    surface.binary(
                      BinaryOperator.Subtract,
                      surface.name("iteration"),
                      surface.integer(1),
                    ),
                  ),
                ),
              ),
              body: surface.apply(surface.name("loop"), surface.integer(1)),
            },
          ),
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("recursive captured F32x4 module did not compile");
  try {
    const bytes = await compileModuleToWasm(compilation.module, { simd: "wasm-simd" });
    const { instance } = await WebAssembly.instantiate(bytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 10);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("SIMD scalar entries fall back when compact emission needs the runtime", async () => {
  const vector = f32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.reduceAdd(
          surface.let(
            "mapped",
            f32x4.map(
              surface.lambda(
                "lane",
                surface.binary(
                  BinaryOperator.MultiplyFloat32,
                  surface.name("lane"),
                  surface.float32(2),
                ),
              ),
              vector,
            ),
            surface.name("mapped"),
          ),
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("SIMD compact fallback module did not compile");
  try {
    const bytes = await compileModuleToWasm(compilation.module, { simd: "wasm-simd" });
    const { instance } = await WebAssembly.instantiate(bytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 20);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("native vectors preserve values across ordinary boxed function boundaries", async () => {
  const vector = f32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "identityMask",
        parameters: ["mask"],
        annotation: {
          kind: "function",
          parameter: f32x4.maskType,
          result: f32x4.maskType,
        },
        body: surface.name("mask"),
      },
      {
        name: "second",
        parameters: ["ignored", "vector"],
        annotation: {
          kind: "function",
          parameter: { kind: "integer" },
          result: {
            kind: "function",
            parameter: f32x4.type,
            result: f32x4.type,
          },
        },
        body: surface.name("vector"),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.reduceAdd(
          f32x4.select(
            surface.apply(
              surface.name("identityMask"),
              f32x4.equal(vector, vector),
            ),
            surface.apply(surface.name("second"), surface.integer(0), vector),
            f32x4.splat(surface.float32(0)),
          ),
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional boxed-vector module did not compile");
  try {
    const simdBytes = await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    equal(WebAssembly.validate(simdBytes), true);
    const { instance } = await WebAssembly.instantiate(simdBytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 10);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("requested SIMD preserves lazy lane evaluation through scalar fallback", async () => {
  const encoded = buildSurfaceModule(
    [
      ...FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: f32x4.extractLane(
          f32x4.make([
            surface.float32(42),
            surface.runtimeFault("unused vector lane was forced"),
            surface.float32(0),
            surface.float32(0),
          ]),
          0,
        ),
      },
    ],
    FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: EvaluationProfile.LazyCallByNeed },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("lazy functional fixed-vector module did not compile");
  try {
    const simdBytes = await compileModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    equal(WebAssembly.validate(simdBytes), true);
    const { instance } = await WebAssembly.instantiate(simdBytes);
    const main = instance.exports.main;
    ok(typeof main === "function");
    equal(main(), 42);
  } finally {
    compilation.module.destroy();
  }
});
