/**
 * Ducklang (`../binned`) compiles through this backend and imports it by relative path, so a
 * gpufuck change reaches it with no version pin. Nothing else in this suite emits WebAssembly;
 * without these tests the code generator can be deleted or broken and the suite stays green.
 */
import { equal, ok } from "node:assert/strict";

import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
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

function functionalCompiler(): GpuFunctionalCompiler {
  if (compiler === undefined) throw new Error("functional compiler was not initialized");
  return compiler;
}

async function compileEntry(body: Parameters<typeof surface.apply>[0]) {
  const module = buildFunctionalSurfaceModule(
    [{ name: "main", parameters: [], annotation: null, body }],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
  const compilation = await functionalCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) throw new Error("smoke module did not compile");
  return compilation;
}

Deno.test("emits a WebAssembly artifact that runs to the expected value", async () => {
  const compilation = await compileEntry(
    surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(20),
      surface.binary(FunctionalBinaryOperator.Multiply, surface.integer(11), surface.integer(2)),
    ),
  );
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("emits a well-formed WebAssembly binary that instantiates standalone", async () => {
  const compilation = await compileEntry(surface.integer(7));
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
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
      FunctionalBinaryOperator.AddFloat64,
      surface.float64(1.5),
      surface.float64(2.25),
    ),
  );
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    equal(execution.value.kind, "float-64");
    equal(execution.value.kind === "float-64" ? execution.value.value : undefined, 3.75);
  } finally {
    compilation.module.destroy();
  }
});
