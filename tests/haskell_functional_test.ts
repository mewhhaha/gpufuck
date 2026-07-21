import { deepStrictEqual, equal, match, ok } from "node:assert/strict";

import {
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
  runFunctionalWasmGcModule,
} from "../functional.ts";
import {
  type LoweredHaskellFunctionalProgram,
  lowerHaskellFunctionalSource,
  renderHaskellFunctionalTrace,
} from "../haskell_functional.ts";

interface HaskellFunctionalRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly evaluator: GpuFunctionalEvaluator;
}

let runtime: HaskellFunctionalRuntime | undefined;

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

Deno.test("infers and evaluates a higher-order Haskell algebraic data function", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/option_map.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("compiles recursive Haskell functions through the functional core", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/factorial.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 120 });
});

Deno.test("generalizes an unannotated Haskell function for distinct argument types", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/tuple.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("infers a recursive generic Haskell tree transformation", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/tree.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("evaluates polymorphic Haskell combinators and partial applications", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/combinators.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("maps, filters, folds, and zips a recursive Haskell list", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/list.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("maps, binds, and folds a Haskell result value", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/result.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("constructs and transforms pure Haskell Reader functions", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/reader.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("maps and binds pure Haskell State functions", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/state.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("passes and composes manual Haskell typeclass dictionaries", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/dictionary.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("desugars Haskell lambdas and built-in list syntax", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/lambda_list.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("refines indexed types through Haskell GADT patterns", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/gadt.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("desugars Haskell record construction, patterns, and selectors", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/records.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("desugars Haskell equations, guards, nested patterns, and where bindings", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/pattern_guards.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("resolves first-order Haskell instances into explicit dictionary evidence", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/classes.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("runs expanded Haskell frontend constructs through GPU compilation and WasmGC", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/frontend.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("preserves Unicode code points in Haskell character and string literals", async () => {
  const evaluation = await evaluateExample("examples/haskell-functional/unicode.hs");

  deepStrictEqual(evaluation, { kind: "integer", value: 42 });
});

Deno.test("reports recursive Haskell type synonyms with the expansion path", () => {
  const frontend = lowerHaskellFunctionalSource(`module AliasCycle where
type First = Second
type Second = First
gpuMain :: First
gpuMain = 42
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /type synonyms form a cycle: First -> Second -> First/);
});

Deno.test("reports an unknown type referenced only by an unused Haskell synonym", () => {
  const frontend = lowerHaskellFunctionalSource(`module UnknownAliasType where
type Broken = Missing
gpuMain = 42
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /Type synonym "Broken" references unknown type "Missing"/);
});

Deno.test("reports a Haskell newtype with more than one field", () => {
  const frontend = lowerHaskellFunctionalSource(`module InvalidNewtype where
newtype Pair = Pair Int Int
gpuMain = 42
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(
    frontend.diagnostics[0].message,
    /Newtype "Pair" must have exactly one constructor and one field/,
  );
});

Deno.test("reports unsupported Haskell string escapes at the literal span", () => {
  const frontend = lowerHaskellFunctionalSource(String.raw`module InvalidEscape where
gpuMain = "\q"
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /string literal contains unsupported escape \\q/);
});

Deno.test("reports repeated explicit Haskell type parameters", () => {
  const frontend = lowerHaskellFunctionalSource(`module RepeatedForall where
identity :: forall a a. a -> a
identity value = value
gpuMain = identity 42
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /forall repeats type parameter "a"/);
});

Deno.test("reports a constrained Haskell call with no matching instance", () => {
  const frontend = lowerHaskellFunctionalSource(`module Missing where
class Equal a where
    equal :: a -> a -> Bool
instance Equal Int where
    equal left right = left == right
same :: Equal a => a -> a -> Bool
same left right = equal left right
gpuMain = if same True True then 42 else 0
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /Cannot resolve Equal for Bool/);
});

Deno.test("accepts Haskell layout syntax without explicit braces", () => {
  const frontend = lowerHaskellFunctionalSource("module Layout where\ngpuMain = 42\n");

  equal(frontend.ok, true);
});

Deno.test("accepts multiple Haskell equations in source order", () => {
  const frontend = lowerHaskellFunctionalSource(
    "module Equations where { gpuMain = 41; gpuMain = 42 }",
  );

  equal(frontend.ok, true);
});

Deno.test("renders Haskell source and both functional IR stages side by side", async () => {
  const source = await Deno.readTextFile("examples/haskell-functional/tree.hs");
  const lowered = requireLowered(source);
  const { compiler, evaluator } = haskellRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const trace = renderHaskellFunctionalTrace({
      title: "tree",
      source,
      lowered,
      compiledModule: compilation.module,
      coreNodes: await compilation.module.readCoreNodes(),
      evaluation: await evaluator.evaluate(compilation.module),
    });

    match(trace, /Haskell source<\/th><th>Normalized functional surface/);
    match(trace, /Encoded functional ABI<\/th><th>GPU-resolved core IR/);
    match(trace, /fn mapTree\(\$argument0, \$argument1\) : &lt;inferred&gt;/);
    match(trace, /d1 mapTree[^\n]+ : &lt;inferred&gt;/);
    match(trace, /Constructor constructor=c\d+:Branch/);
  } finally {
    compilation.module.destroy();
  }
});

async function evaluateExample(
  path: string,
): Promise<{ readonly kind: string; readonly value: unknown }> {
  const source = await Deno.readTextFile(path);
  const lowered = requireLowered(source);
  const { compiler, evaluator } = haskellRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error(`Haskell example ${JSON.stringify(path)} did not compile.`);
  try {
    const evaluation = await evaluator.evaluate(compilation.module);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (!evaluation.ok) {
      throw new Error(`Haskell example ${JSON.stringify(path)} did not evaluate.`);
    }
    if (
      evaluation.value.kind === "closure" || evaluation.value.kind === "unit" ||
      evaluation.value.kind === "constructor" || evaluation.value.kind === "tuple"
    ) {
      throw new Error(`Haskell example ${JSON.stringify(path)} returned ${evaluation.value.kind}.`);
    }
    const wasmExecution = await runFunctionalWasmGcModule(compilation.module);
    deepStrictEqual(
      wasmExecution.value,
      evaluation.value,
      `${path} returned different GPU and WasmGC values`,
    );
    return evaluation.value;
  } finally {
    compilation.module.destroy();
  }
}

function requireLowered(source: string): LoweredHaskellFunctionalProgram {
  const frontend = lowerHaskellFunctionalSource(source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error("Haskell example did not lower.");
  return frontend.lowered;
}

function haskellRuntime(): HaskellFunctionalRuntime {
  if (runtime === undefined) throw new Error("Haskell functional test runtime was not initialized");
  return runtime;
}
