import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  FUNCTIONAL_FIXED_VECTOR_DEFINITIONS,
  FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS,
  FunctionalEvaluationProfile,
  functionalF32x4,
  FunctionalNumericConversion,
  type FunctionalSurfaceExpression,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  surface,
} from "../functional.ts";

const OPERATION_COUNT = 4;
const EXPECTED_RESULT = 10 + OPERATION_COUNT * 4;

let vector: FunctionalSurfaceExpression = functionalF32x4.make([
  surface.convert(
    FunctionalNumericConversion.SignedInteger32ToFloat32,
    surface.name("value"),
  ),
  surface.float32(2),
  surface.float32(3),
  surface.float32(4),
]);
for (let operation = 0; operation < OPERATION_COUNT; operation += 1) {
  vector = functionalF32x4.add(vector, functionalF32x4.splat(surface.float32(1)));
}

const encoded = buildFunctionalSurfaceModule(
  [
    ...FUNCTIONAL_FIXED_VECTOR_DEFINITIONS,
    {
      name: "main",
      parameters: ["value"],
      annotation: {
        kind: "function",
        parameter: { kind: "integer" },
        result: { kind: "float-32" },
      },
      body: functionalF32x4.reduceAdd(vector),
    },
  ],
  FUNCTIONAL_FIXED_VECTOR_TYPE_DECLARATIONS,
  "main",
  0,
  { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
);

const device = await requestWebGpuDevice();
const compiler = await GpuFunctionalCompiler.create(device);
const compilation = await compiler.compileModule(encoded);
if (!compilation.ok) {
  device.destroy();
  throw new Error(`F32x4 benchmark did not compile: ${compilation.diagnostics[0].message}`);
}

const portableBytes = await compileFunctionalModuleToWasm(compilation.module, {
  simd: "portable-scalar",
});
const simdBytes = await compileFunctionalModuleToWasm(compilation.module, {
  simd: "wasm-simd",
});
const portableMain = instantiateMain(portableBytes, "portable F32x4");
const simdMain = instantiateMain(simdBytes, "native F32x4");
requireExpectedResult(portableMain(9n), "portable F32x4");
requireExpectedResult(simdMain(9n), "native F32x4");

globalThis.addEventListener("unload", () => {
  compilation.module.destroy();
  device.destroy();
}, { once: true });

Deno.bench("reuse emitted WebAssembly: portable F32x4 chain", async () => {
  const bytes = await compileFunctionalModuleToWasm(compilation.module, {
    simd: "portable-scalar",
  });
  if (!WebAssembly.validate(bytes)) throw new Error("portable F32x4 artifact is invalid");
});

Deno.bench("reuse emitted WebAssembly: native F32x4 chain", async () => {
  const bytes = await compileFunctionalModuleToWasm(compilation.module, {
    simd: "wasm-simd",
  });
  if (!WebAssembly.validate(bytes)) throw new Error("native F32x4 artifact is invalid");
});

Deno.bench("run WebAssembly: portable F32x4 chain", () => {
  requireExpectedResult(portableMain(9n), "portable F32x4");
});

Deno.bench("run WebAssembly: native F32x4 chain", () => {
  requireExpectedResult(simdMain(9n), "native F32x4");
});

function instantiateMain(
  bytes: Uint8Array<ArrayBuffer>,
  context: string,
): (argument: bigint) => unknown {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  const main = instance.exports.main;
  if (typeof main !== "function") throw new Error(`${context} artifact omitted main`);
  return main as (argument: bigint) => unknown;
}

function requireExpectedResult(value: unknown, context: string): void {
  if (value !== EXPECTED_RESULT) {
    throw new Error(`${context} returned ${String(value)}; expected ${EXPECTED_RESULT}`);
  }
}
