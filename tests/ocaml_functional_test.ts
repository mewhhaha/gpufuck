import { deepStrictEqual, equal, match, ok } from "node:assert/strict";

import {
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
} from "../functional.ts";
import {
  type LoweredOcamlFunctionalProgram,
  lowerOcamlFunctionalSource,
  renderOcamlFunctionalTrace,
} from "../ocaml_functional.ts";

interface OcamlFunctionalRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly evaluator: GpuFunctionalEvaluator;
}

let runtime: OcamlFunctionalRuntime | undefined;

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

Deno.test("compiles and evaluates an inferred generic OCaml variant map", async () => {
  const evaluation = await evaluateExample("examples/ocaml-functional/option_map.ml");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("compiles a recursive OCaml function through the functional core", async () => {
  const evaluation = await evaluateExample("examples/ocaml-functional/factorial.ml");

  deepStrictEqual(evaluation, { kind: "integer", value: 120 });
});

Deno.test("lowers OCaml tuple construction and pattern matching", async () => {
  const evaluation = await evaluateExample("examples/ocaml-functional/tuple.ml");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("infers higher-order OCaml list mapping and folding", async () => {
  const evaluation = await evaluateExample("examples/ocaml-functional/list.ml");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("infers a recursive generic OCaml tree transformation", async () => {
  const evaluation = await evaluateExample("examples/ocaml-functional/tree.ml");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("rejects an OCaml forward value reference outside sequential scope", () => {
  const frontend = lowerOcamlFunctionalSource(`let first = later
let later = 42
let gpu_main = first
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "O1002");
  match(frontend.diagnostics[0].message, /"later" is not in sequential scope/);
});

Deno.test("requires rec before an OCaml definition can reference itself", () => {
  const frontend = lowerOcamlFunctionalSource(`let loop value = loop value
let gpu_main = 42
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /"loop" is not in sequential scope/);
});

Deno.test("accepts nested OCaml comments at the source boundary", () => {
  const frontend = lowerOcamlFunctionalSource("(* outer (* nested *) *)\nlet gpu_main = 42\n");

  equal(frontend.ok, true);
});

Deno.test("renders OCaml source and both functional IR stages side by side", async () => {
  const source = await Deno.readTextFile("examples/ocaml-functional/option_map.ml");
  const lowered = requireLowered(source);
  const { compiler, evaluator } = ocamlRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const trace = renderOcamlFunctionalTrace({
      title: "option map",
      source,
      lowered,
      compiledModule: compilation.module,
      coreNodes: await compilation.module.readCoreNodes(),
      evaluation: await evaluator.evaluate(compilation.module),
    });

    match(trace, /OCaml source<\/th><th>Normalized functional surface/);
    match(trace, /Encoded functional ABI<\/th><th>GPU-resolved core IR/);
    match(trace, /type option_value&lt;a&gt;/);
    match(trace, /d1 map_option root=/);
  } finally {
    compilation.module.destroy();
  }
});

async function evaluateExample(
  path: string,
): Promise<{ readonly kind: string; readonly value: unknown }> {
  const source = await Deno.readTextFile(path);
  const lowered = requireLowered(source);
  const { compiler, evaluator } = ocamlRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error(`OCaml example ${JSON.stringify(path)} did not compile.`);
  try {
    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (!evaluation.ok) throw new Error(`OCaml example ${JSON.stringify(path)} did not evaluate.`);
    if (
      evaluation.value.kind === "closure" || evaluation.value.kind === "unit" ||
      evaluation.value.kind === "constructor" || evaluation.value.kind === "tuple"
    ) {
      throw new Error(`OCaml example ${JSON.stringify(path)} returned ${evaluation.value.kind}.`);
    }
    return evaluation.value;
  } finally {
    compilation.module.destroy();
  }
}

function requireLowered(source: string): LoweredOcamlFunctionalProgram {
  const frontend = lowerOcamlFunctionalSource(source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error("OCaml example did not lower.");
  return frontend.lowered;
}

function ocamlRuntime(): OcamlFunctionalRuntime {
  if (runtime === undefined) throw new Error("OCaml functional test runtime was not initialized");
  return runtime;
}
