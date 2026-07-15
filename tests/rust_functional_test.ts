import { deepStrictEqual, equal, match, ok } from "node:assert/strict";

import {
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
} from "../functional.ts";
import {
  type LoweredRustFunctionalProgram,
  lowerRustFunctionalSource,
  renderRustFunctionalTrace,
} from "../rust_functional.ts";

interface RustFunctionalRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly evaluator: GpuFunctionalEvaluator;
}

let runtime: RustFunctionalRuntime | undefined;

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

Deno.test("compiles and evaluates a generic Rust enum match", async () => {
  const evaluation = await evaluateExample("examples/rust-functional/option_map.rs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("orders Rust struct fields by their declaration", async () => {
  const evaluation = await evaluateExample("examples/rust-functional/point.rs");

  deepStrictEqual(evaluation, { kind: "integer", value: 2_022 });
});

Deno.test("compiles recursive Rust functions through the functional core", async () => {
  const evaluation = await evaluateExample("examples/rust-functional/factorial.rs");

  deepStrictEqual(evaluation, { kind: "integer", value: 120 });
});

Deno.test("lowers Rust tuples, immutable bindings, and conditionals", async () => {
  const evaluation = await evaluateExample("examples/rust-functional/tuple.rs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("rejects mutable Rust bindings at the frontend boundary", () => {
  const frontend = lowerRustFunctionalSource(
    "fn gpu_main() -> i32 { let mut value = 41; value + 1 }",
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "R1001");
  match(frontend.diagnostics[0].message, /mutable bindings are outside/i);
});

Deno.test("reports unknown Rust struct fields before GPU compilation", () => {
  const frontend = lowerRustFunctionalSource(
    "struct Point { x: i32, y: i32 } fn gpu_main() -> Point { Point { x: 1, y: 2, z: 3 } }",
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "R1002");
  match(frontend.diagnostics[0].message, /unknown field "z"/i);
});

Deno.test("renders Rust source and both functional IR stages side by side", async () => {
  const source = await Deno.readTextFile("examples/rust-functional/option_map.rs");
  const lowered = requireLowered(source);
  const { compiler, evaluator } = rustRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const trace = renderRustFunctionalTrace({
      title: "option map",
      source,
      lowered,
      compiledModule: compilation.module,
      coreNodes: await compilation.module.readCoreNodes(),
      evaluation: await evaluator.evaluate(compilation.module),
    });

    match(trace, /Rust source<\/th><th>Normalized functional surface/);
    match(trace, /Encoded functional ABI<\/th><th>GPU-resolved core IR/);
    match(trace, /Option::Some/);
    match(trace, /Local depth=/);
  } finally {
    compilation.module.destroy();
  }
});

async function evaluateExample(
  path: string,
): Promise<{ readonly kind: string; readonly value: unknown }> {
  const source = await Deno.readTextFile(path);
  const lowered = requireLowered(source);
  const { compiler, evaluator } = rustRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error(`Rust example ${JSON.stringify(path)} did not compile.`);
  try {
    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (!evaluation.ok) throw new Error(`Rust example ${JSON.stringify(path)} did not evaluate.`);
    if (
      evaluation.value.kind === "closure" || evaluation.value.kind === "unit" ||
      evaluation.value.kind === "constructor" || evaluation.value.kind === "tuple"
    ) {
      throw new Error(`Rust example ${JSON.stringify(path)} returned ${evaluation.value.kind}.`);
    }
    return evaluation.value;
  } finally {
    compilation.module.destroy();
  }
}

function requireLowered(source: string): LoweredRustFunctionalProgram {
  const frontend = lowerRustFunctionalSource(source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error("Rust example did not lower.");
  return frontend.lowered;
}

function rustRuntime(): RustFunctionalRuntime {
  if (runtime === undefined) throw new Error("Rust functional test runtime was not initialized");
  return runtime;
}
