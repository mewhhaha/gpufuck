import { deepStrictEqual, equal, ok, rejects, throws } from "node:assert/strict";

import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  FUNCTIONAL_FIXED_VECTOR_DEFINITIONS,
  FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  functionalF32x4,
  type FunctionalWasmCompilationOptions,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../functional.ts";

let device: GPUDevice | undefined;
let compiler: GpuFunctionalCompiler | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  compiler = await GpuFunctionalCompiler.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  compiler = undefined;
});

function functionalWasmCompiler(): GpuFunctionalCompiler {
  if (compiler === undefined) throw new Error("functional SIMD test compiler is not initialized");
  return compiler;
}

Deno.test("fixed F32x4 builders reject lanes outside the four-lane shape", () => {
  const vector = functionalF32x4.splat(surface.float32(0));
  throws(
    () => functionalF32x4.extractLane(vector, -1),
    /lane must be an integer within \[0, 3\]; received -1/,
  );
  throws(
    () => functionalF32x4.replaceLane(vector, 4, surface.float32(0)),
    /lane must be an integer within \[0, 3\]; received 4/,
  );
});

Deno.test("fixed F32x4 operations agree in portable and native SIMD modes", async () => {
  const vector = functionalF32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const selected = functionalF32x4.select(
    functionalF32x4.less(vector, functionalF32x4.splat(surface.float32(3))),
    functionalF32x4.add(vector, functionalF32x4.splat(surface.float32(10))),
    functionalF32x4.multiply(vector, functionalF32x4.splat(surface.float32(2))),
  );
  const mapped = functionalF32x4.map(
    surface.lambda(
      "value",
      surface.binary(
        FunctionalBinaryOperator.MultiplyFloat32,
        surface.name("value"),
        surface.float32(2),
      ),
    ),
    selected,
  );
  const zipped = functionalF32x4.zip(
    surface.lambda(
      "left",
      surface.lambda(
        "right",
        surface.binary(
          FunctionalBinaryOperator.AddFloat32,
          surface.name("left"),
          surface.name("right"),
        ),
      ),
    ),
    mapped,
    functionalF32x4.replaceLane(vector, 2, surface.float32(20)),
  );
  const encoded = buildFunctionalSurfaceModule(
    [
      ...FUNCTIONAL_FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: functionalF32x4.fold(
          surface.lambda(
            "accumulator",
            surface.lambda(
              "lane",
              surface.binary(
                FunctionalBinaryOperator.AddFloat32,
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
    FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );

  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional fixed-vector module did not compile");
  try {
    const portableExecution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(portableExecution.value, { kind: "float-32", value: 101 });
    const explicitlyPortableBytes = await compileFunctionalModuleToWasm(compilation.module, {
      simd: "portable-scalar",
    });
    deepStrictEqual(explicitlyPortableBytes, portableExecution.bytes);

    const simdBytes = await compileFunctionalModuleToWasm(compilation.module, {
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
    const secondSimdBytes = await compileFunctionalModuleToWasm(compilation.module, {
      simd: "wasm-simd",
    });
    equal(WebAssembly.validate(secondSimdBytes), true);
    await rejects(
      () =>
        compileFunctionalModuleToWasm(compilation.module, {
          simd: "unknown",
        } as unknown as FunctionalWasmCompilationOptions),
      /SIMD mode must be portable-scalar or wasm-simd; received "unknown"/,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("native F32x4 lane operations, comparisons, and reductions preserve Float32 results", async () => {
  const quotient = functionalF32x4.divide(
    functionalF32x4.subtract(
      functionalF32x4.make([
        surface.float32(8),
        surface.float32(12),
        surface.float32(16),
        surface.float32(20),
      ]),
      functionalF32x4.splat(surface.float32(4)),
    ),
    functionalF32x4.splat(surface.float32(4)),
  );
  const selected = functionalF32x4.select(
    functionalF32x4.equal(
      quotient,
      functionalF32x4.make([
        surface.float32(1),
        surface.float32(2),
        surface.float32(0),
        surface.float32(4),
      ]),
    ),
    quotient,
    functionalF32x4.splat(surface.float32(10)),
  );
  const repaired = functionalF32x4.replaceLane(selected, 2, surface.float32(3));
  const encoded = buildFunctionalSurfaceModule(
    [
      ...FUNCTIONAL_FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: surface.binary(
          FunctionalBinaryOperator.AddFloat32,
          functionalF32x4.reduceAdd(repaired),
          functionalF32x4.extractLane(repaired, 1),
        ),
      },
    ],
    FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional fixed-vector module did not compile");
  try {
    const simdBytes = await compileFunctionalModuleToWasm(compilation.module, {
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
  const encoded = buildFunctionalSurfaceModule(
    [
      ...FUNCTIONAL_FIXED_VECTOR_DEFINITIONS,
      {
        name: "doubleVector",
        parameters: ["vector"],
        annotation: {
          kind: "function",
          parameter: functionalF32x4.type,
          result: functionalF32x4.type,
        },
        body: functionalF32x4.multiply(
          surface.name("vector"),
          functionalF32x4.splat(surface.float32(2)),
        ),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: functionalF32x4.reduceAdd(
          surface.apply(
            surface.name("doubleVector"),
            functionalF32x4.make([
              surface.float32(1),
              surface.float32(2),
              surface.float32(3),
              surface.float32(4),
            ]),
          ),
        ),
      },
    ],
    FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional F32x4 worker module did not compile");
  try {
    const simdBytes = await compileFunctionalModuleToWasm(compilation.module, {
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

Deno.test("native vectors preserve values across ordinary boxed function boundaries", async () => {
  const vector = functionalF32x4.make([
    surface.float32(1),
    surface.float32(2),
    surface.float32(3),
    surface.float32(4),
  ]);
  const encoded = buildFunctionalSurfaceModule(
    [
      ...FUNCTIONAL_FIXED_VECTOR_DEFINITIONS,
      {
        name: "identityMask",
        parameters: ["mask"],
        annotation: {
          kind: "function",
          parameter: functionalF32x4.maskType,
          result: functionalF32x4.maskType,
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
            parameter: functionalF32x4.type,
            result: functionalF32x4.type,
          },
        },
        body: surface.name("vector"),
      },
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: functionalF32x4.reduceAdd(
          functionalF32x4.select(
            surface.apply(
              surface.name("identityMask"),
              functionalF32x4.equal(vector, vector),
            ),
            surface.apply(surface.name("second"), surface.integer(0), vector),
            functionalF32x4.splat(surface.float32(0)),
          ),
        ),
      },
    ],
    FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("functional boxed-vector module did not compile");
  try {
    const simdBytes = await compileFunctionalModuleToWasm(compilation.module, {
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
  const encoded = buildFunctionalSurfaceModule(
    [
      ...FUNCTIONAL_FIXED_VECTOR_DEFINITIONS,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "float-32" },
        body: functionalF32x4.extractLane(
          functionalF32x4.make([
            surface.float32(42),
            surface.runtimeFault("unused vector lane was forced"),
            surface.float32(0),
            surface.float32(0),
          ]),
          0,
        ),
      },
    ],
    FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS,
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.LazyCallByNeed },
  );
  const compilation = await functionalWasmCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("lazy functional fixed-vector module did not compile");
  try {
    const simdBytes = await compileFunctionalModuleToWasm(compilation.module, {
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
