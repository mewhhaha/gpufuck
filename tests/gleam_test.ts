import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";

import {
  type EvaluationOptions,
  GpuCompiler,
  GpuEvaluator,
  requestWebGpuDevice,
  runWasmModule,
} from "../functional.ts";
import {
  type GleamSourceModule,
  type LoweredGleamProgram,
  lowerGleamSource,
  lowerGleamSources,
  renderGleamTrace,
} from "../gleam.ts";
import { generateGleamCorpus } from "../tools/generate_gleam_corpus.ts";

interface GleamRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuCompiler;
  readonly evaluator: GpuEvaluator;
}

let runtime: GleamRuntime | undefined;

/**
 * Gleam `Int` lowers to boxed i64, so the kernel example allocates past the evaluator's default
 * heap of 256 slots. It completes within 512; this leaves headroom.
 */
const KERNEL_HEAP_SLOTS = 1024;

Deno.test.beforeAll(async () => {
  const device = await requestWebGpuDevice();
  const [compiler, evaluator] = await Promise.all([
    GpuCompiler.create(device),
    GpuEvaluator.create(device),
  ]);
  runtime = { device, compiler, evaluator };
});

Deno.test.afterAll(() => {
  runtime?.device.destroy();
  runtime = undefined;
});

Deno.test("infers and evaluates a generic Gleam algebraic transformation", async () => {
  const evaluation = await evaluateSingleExample("examples/gleam/option_map.gleam");

  deepStrictEqual(evaluation, { kind: "signed-integer-64", value: 42n });
});

Deno.test("infers a recursive higher-order Gleam list fold", async () => {
  const evaluation = await evaluateSingleExample("examples/gleam/list_fold.gleam");

  deepStrictEqual(evaluation, { kind: "signed-integer-64", value: 42n });
});

Deno.test("desugars Gleam pipelines in source order", async () => {
  const evaluation = await evaluateSingleExample("examples/gleam/pipeline.gleam");

  deepStrictEqual(evaluation, { kind: "signed-integer-64", value: 42n });
});

Deno.test("evaluates a recursive Gleam factorial through a wildcard arm", async () => {
  const evaluation = await evaluateSingleExample("examples/gleam/factorial.gleam");

  deepStrictEqual(evaluation, { kind: "signed-integer-64", value: 3628800n });
});

/**
 * Text was the one runtime value the evaluator produced but its `Value` union could not name, so a
 * `String` entry point threw on the way out rather than at compile time.
 */
Deno.test("returns a Gleam String result as a text boundary value", async () => {
  const evaluation = await evaluateSingleExample("examples/gleam/guards.gleam");

  deepStrictEqual(evaluation, { kind: "text", value: "negative zero small large" });
});

Deno.test("returns a labeled Gleam constructor with its fields in the deep form", async () => {
  const source = await Deno.readTextFile("examples/gleam/records.gleam");
  const frontend = lowerGleamSource("records", source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;
  const { compiler, evaluator } = gleamRuntime();
  const compilation = await compiler.compileModule(frontend.lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const evaluation = await evaluator.evaluate(compilation.module, { resultForm: "deep" });
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (!evaluation.ok) return;

    deepStrictEqual(evaluation.value, {
      kind: "constructor",
      name: "records::Rectangle",
      fieldCount: 2,
      fields: [
        { kind: "signed-integer-64", value: 6n },
        { kind: "signed-integer-64", value: 7n },
      ],
    });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("compares the completed Gleam pipeline result", async () => {
  const frontend = lowerGleamSource(
    "pipeline_comparison",
    `
fn increment(value: Int) -> Int {
  value + 1
}

pub fn main() -> Int {
  assert 40
    |> increment
    |> increment
    == 42
  42
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("evaluates Gleam float arithmetic with native f64 operators", async () => {
  const frontend = lowerGleamSource(
    "float_arithmetic",
    `
pub fn main() -> Float {
  case 2.5 >. 2.0 && 2.0 <=. 2.0 {
    True -> (-2.5 +. 5.0) *. 4.0 /. 2.0 -. 1.0 +. (10.0 /. 0.0)
    _ -> 0.0
  }
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "float-64", value: 4 });
});

Deno.test("matches exhaustive Gleam float patterns", async () => {
  const frontend = lowerGleamSource(
    "float_pattern",
    `
pub fn main() -> Int {
  case -0.5 {
    -0.5 -> 42
    _ -> 0
  }
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("preserves UTF-8 Gleam string literals through WASM", async () => {
  const frontend = lowerGleamSource(
    "string_literal",
    `pub fn main() -> String { "Zażółć 🦆" }\n`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluateWasm(frontend.lowered), {
    kind: "text",
    value: "Zażółć 🦆",
  });
});

Deno.test("distinguishes Gleam Unicode escapes from escaped backslashes", async () => {
  const frontend = lowerGleamSource(
    "string_escapes",
    `pub fn main() -> String { "\\u{1F986}" <> "\\\\u{41}" }\n`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluateWasm(frontend.lowered), {
    kind: "text",
    value: "🦆\\u{41}",
  });
});

Deno.test("evaluates portable Gleam integers beyond the i32 range", async () => {
  const frontend = lowerGleamSource(
    "wide_integers",
    `
pub fn main() -> Int {
  let quotient = 4_000_000_009 / 3
  let remainder = 4_000_000_009 % 3
  quotient + remainder
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), {
    kind: "signed-integer-64",
    value: 1333333337n,
  });
});

Deno.test("lowers Gleam string concatenation and exact string patterns", async () => {
  const frontend = lowerGleamSource(
    "string_patterns",
    `
fn classify(value: String) -> String {
  case value {
    "gpufuck" -> "exact"
    "gpu" <> rest -> rest
    _ -> "other"
  }
}

pub fn main() -> String {
  classify("gpu" <> "fuck") <> classify("gpu-fast")
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluateWasm(frontend.lowered), { kind: "text", value: "exact-fast" });
});

Deno.test("destructures Gleam tuples and constructors in let bindings", async () => {
  const frontend = lowerGleamSource(
    "let_patterns",
    `
pub type Box(value) { Box(value) }

pub fn main() -> Int {
  let #(left, Box(right)) = #(20, Box(22))
  left + right
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("projects pair fields with Gleam tuple indices", async () => {
  const frontend = lowerGleamSource(
    "tuple_indices",
    `
fn total(pair: #(Int, Int)) -> Int {
  pair.0 + pair.1
}

pub fn main() -> Int {
  total(#(20, 22))
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("evaluates the final value after sequential Gleam block expressions", async () => {
  const frontend = lowerGleamSource(
    "block_sequence",
    `pub fn main() -> Int { 20 + 20 42 }\n`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("selects JavaScript-targeted declarations before lowering", async () => {
  const frontend = lowerGleamSource(
    "target_selection",
    `
@target(erlang)
fn answer() -> Int { 0 }

@target(javascript)
fn answer() -> Int { 42 }

pub fn main() -> Int { answer() }
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("infers missing pieces of partially annotated Gleam functions", async () => {
  const frontend = lowerGleamSource(
    "partial_annotations",
    `
fn choose(left: Int, right) -> Int { right }

pub fn main() -> Int { choose(0, 42) }
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("projects keyword-named fields after function calls", async () => {
  const frontend = lowerGleamSource(
    "postfix_fields",
    `
pub type Decoder { Decoder(function: fn(Int) -> Int) }

fn decoder() -> Decoder { Decoder(fn(value: Int) -> Int { value + 2 }) }

pub fn main() -> Int { decoder().function(40) }
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("compares nested Gleam algebraic values structurally", async () => {
  const frontend = lowerGleamSource(
    "structural_equality",
    `
pub type Tree(value) {
  Leaf(value)
  Branch(Tree(value), Tree(value))
}

pub fn main() {
  let first = Branch(Leaf([1, 2]), Leaf([3]))
  let same = Branch(Leaf([1, 2]), Leaf([3]))
  let different = Branch(Leaf([1, 2]), Leaf([4]))
  first == same && first != different && Leaf(1) != Branch(Leaf(1), Leaf(1))
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "boolean", value: true });
});

Deno.test("matches multiple subjects, alternatives, and guards in source order", async () => {
  const frontend = lowerGleamSource(
    "case_features",
    `
fn classify(left: Int, right: Int) -> Int {
  case left, right {
    0, 0 -> 100
    0, _ | _, 0 -> 50
    left, right if left > right -> left - right
    _, _ -> 0
  }
}

pub fn main() -> Int {
  classify(47, 5)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("matches nested exact lists and accepts a final list spread", async () => {
  const frontend = lowerGleamSource(
    "list_patterns",
    `
fn sum(values: List(Int), total: Int) -> Int {
  case values {
    [] -> total
    [head, ..tail] -> sum(tail, total + head)
  }
}

fn score(values: List(Int)) -> Int {
  case values {
    [first, second] as pair if first < second -> first + second
    _ -> 0
  }
}

pub fn main() -> Int {
  score([20, ..[22]]) + sum([1, 2, ..[3, 4]], 0)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 52n });
});

Deno.test("recognizes exhaustive nested constructor patterns without a catch-all", async () => {
  const frontend = lowerGleamSource(
    "nested_coverage",
    `
pub type Maybe(value) { None Some(value) }

fn sum(values: List(Maybe(Int)), total: Int) -> Int {
  case values {
    [] -> total
    [None, ..rest] -> sum(rest, total)
    [Some(value), ..rest] -> sum(rest, total + value)
  }
}

pub fn main() -> Int {
  sum([Some(20), None, Some(22)], 0)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("keeps nested Gleam constructor recursion stack safe", async () => {
  const frontend = lowerGleamSource(
    "nested_tail_recursion",
    `
fn repeat(value, count, values) {
  case count <= 0 {
    True -> values
    False -> repeat(value, count - 1, [value, ..values])
  }
}

fn count(values, total) {
  case values {
    [] -> total
    [Ok(_), ..rest] -> count(rest, total + 1)
    [Error(_), ..rest] -> count(rest, total + 1)
  }
}

pub fn main() -> Int {
  repeat(Ok(1), 100_000, [])
  |> count(0)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(
    await evaluateWasm(frontend.lowered),
    { kind: "signed-integer-64", value: 100000n },
  );
});

Deno.test("keeps multiple-subject Gleam recursion stack safe", async () => {
  const frontend = lowerGleamSource(
    "multiple_subject_tail_recursion",
    `
fn repeat(value, count, values) {
  case count <= 0 {
    True -> values
    False -> repeat(value, count - 1, [value, ..values])
  }
}

fn count_pairs(left, right, total) {
  case left, right {
    [], _ -> total
    _, [] -> total
    [_, ..left_rest], [_, ..right_rest] ->
      count_pairs(left_rest, right_rest, total + 1)
  }
}

pub fn main() -> Int {
  let values = repeat(0, 100_000, [])
  count_pairs(values, values, 0)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(
    await evaluateWasm(frontend.lowered),
    { kind: "signed-integer-64", value: 100000n },
  );
});

/**
 * A guard sends the case down `lowerSequentialCase`, which binds every later arm to a fallback
 * lambda — so the recursive call sits inside a lambda rather than directly in the arm. That used to
 * lose tail recursion outright and overflow here, because the analysis stopped its tail walk at
 * `Lambda`. Contification makes the fallback a label instead of a closure, which puts its body back
 * in tail position.
 */
/**
 * A packed-ABI limit used to escape `lowerGleamSources` as a bare `RangeError`, which ended a batch
 * run and reported nothing about the remaining modules. Every failure a caller can be handed now
 * comes back as a result.
 *
 * Reached by linking rather than by one huge module, because baba's own trace limit stops a single
 * source long before the node cap does — the ABI ceiling is only reachable through imports, which is
 * also the shape a real project has.
 */
Deno.test("reports a surface-node limit as a diagnostic rather than throwing", () => {
  const modules = [...generateGleamCorpus(64, 6).modules];
  const entry: GleamSourceModule = {
    name: "limit_entry",
    source: `${modules.map((module, index) => `import ${module.name} as m${index}`).join("\n")}

pub fn main() -> Int {
${modules.map((_, index) => `  let v${index} = m${index}.main()`).join("\n")}
  ${modules.map((_, index) => `v${index}`).join(" + ")}
}
`,
  };
  const frontend = lowerGleamSources([...modules, entry], {
    module: entry.name,
    exportName: "main",
  });
  ok(!frontend.ok);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "G1004");
  equal(frontend.diagnostics[0].stage, "limit");
  match(frontend.diagnostics[0].message, /exceeds 65536/);
});

Deno.test("keeps guarded Gleam scalar recursion stack safe", async () => {
  const frontend = lowerGleamSource(
    "guarded_scalar_tail_recursion",
    `
fn countdown(n, total) {
  case n {
    m if m <= 0 -> total
    _ -> countdown(n - 1, total + 1)
  }
}

pub fn main() -> Int {
  countdown(100_000, 0)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(
    await evaluateWasm(frontend.lowered),
    { kind: "signed-integer-64", value: 100000n },
  );
});

Deno.test("keeps guarded Gleam constructor recursion stack safe", async () => {
  const frontend = lowerGleamSource(
    "guarded_tail_recursion",
    `
fn repeat(value, count, values) {
  case count <= 0 {
    True -> values
    False -> repeat(value, count - 1, [value, ..values])
  }
}

fn contains(values, expected) {
  case values {
    [] -> False
    [first, ..] if first == expected -> True
    [_, ..rest] -> contains(rest, expected)
  }
}

pub fn main() -> Bool {
  repeat(0, 100_000, [])
  |> contains(1)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluateWasm(frontend.lowered), { kind: "boolean", value: false });
});

Deno.test("keeps recursive names outside exact-list pattern bindings", async () => {
  const frontend = lowerGleamSource(
    "exact_list_binding_scope",
    `
fn last(values) {
  case values {
    [] -> Error(Nil)
    [last] -> Ok(last)
    [_, ..rest] -> last(rest)
  }
}

pub fn main() -> Int {
  case last([1, 2, 42]) {
    Ok(value) -> value
    Error(_) -> 0
  }
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluateWasm(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("desugars use bindings and function captures to ordinary callbacks", async () => {
  const frontend = lowerGleamSource(
    "callbacks",
    `
fn with_value(value, callback) {
  callback(value)
}

fn add(left, right) {
  left + right
}

pub fn main() -> Int {
  use value <- with_value(40)
  let add_two = add(_, 2)
  add_two(value)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("lowers arbitrary tuple arity through nested portable pairs", async () => {
  const frontend = lowerGleamSource(
    "tuples",
    `
fn middle(value: #(Int, Int, Int)) -> Int {
  case value {
    #(_, answer, _) -> answer
    _ -> 0
  }
}

pub fn main() -> Int {
  middle(#(1, 42, 3))
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("lowers zero and one element Gleam tuples", async () => {
  const frontend = lowerGleamSource(
    "small_tuples",
    `
pub fn main() -> Int {
  let assert #() = #()
  let assert #(value) = #(42)
  value
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("orders local, constructor, and imported labeled arguments", async () => {
  const frontend = lowerGleamSources([
    {
      name: "labels/library",
      source: `
pub fn calculate(base: Int, add addend: Int, multiply multiplier: Int) -> Int {
  base * multiplier + addend
}
`,
    },
    {
      name: "labels/main",
      source: `
import labels/library

pub type Answer {
  Answer(primary: Int, adjustment: Int)
}

pub fn main() -> Int {
  let add = 2
  let value = library.calculate(8, multiply: 5, add:)
  let answer = Answer(adjustment: add, primary: value)
  case answer {
    Answer(adjustment: adjustment, primary: primary) -> primary + adjustment
  }
}
`,
    },
  ], { module: "labels/main", exportName: "main" });
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 44n });
});

Deno.test("links annotated public constants as ordinary immutable definitions", async () => {
  const frontend = lowerGleamSources([
    {
      name: "constants/library",
      source: `pub const forty: Int = 40\n`,
    },
    {
      name: "constants/main",
      source: `
import constants/library.{forty}

const two = 2

pub fn main() -> Int {
  forty + two
}
`,
    },
  ], { module: "constants/main", exportName: "main" });
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("links public Gleam types and constructors through nominal imports", async () => {
  const frontend = lowerGleamSources([
    {
      name: "option/library",
      source: `
pub type Option(value) {
  Some(value)
  None
}

pub fn answer() -> Option(Int) {
  Some(42)
}
`,
    },
    {
      name: "option/main",
      source: `
import option/library.{type Option, Some, None}

fn unwrap(value: Option(Int)) -> Int {
  case value {
    Some(answer) -> answer
    None -> 0
  }
}

pub fn main() -> Int {
  unwrap(Some(42))
}
`,
    },
  ], { module: "option/main", exportName: "main" });
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("keeps opaque Gleam constructors private across modules", () => {
  const frontend = lowerGleamSources([
    {
      name: "secret/library",
      source: `pub opaque type Secret { Secret(Int) }\n`,
    },
    {
      name: "secret/main",
      source: `import secret/library.{Secret}\npub fn main() -> Int { 42 }\n`,
    },
  ], { module: "secret/main", exportName: "main" });

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /missing public value or constructor/);
});

Deno.test("reports Gleam panic messages as located runtime faults", async () => {
  const source = `pub fn main() -> Int { panic as "missing duck" }\n`;
  const frontend = lowerGleamSource("panic/main", source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;
  const { compiler } = gleamRuntime();
  const compilation = await compiler.compileModule(frontend.lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    await rejects(
      () => runWasmModule(compilation.module),
      (error) => {
        ok(error instanceof Error);
        match(error.message, /F3013/);
        match(error.message, /missing duck/);
        return true;
      },
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("evaluates a dynamic Gleam panic message before the outer panic", async () => {
  const frontend = lowerGleamSource(
    "panic/dynamic",
    `pub fn main() -> Int { panic as panic as "inner panic" }\n`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;
  const { compiler } = gleamRuntime();
  const compilation = await compiler.compileModule(frontend.lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    await rejects(
      () => runWasmModule(compilation.module),
      /inner panic/,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("constructs and exactly matches portable Gleam bit arrays", async () => {
  const frontend = lowerGleamSource(
    "bit_arrays",
    `
pub fn main() -> Int {
  case <<"duck":utf8, -1:7, 0:1, 42:int>> {
    <<"duck":utf8, 127:7, 0:1, 42:int>> -> 42
    _ -> 0
  }
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("rejects unsupported Gleam bit-array segment encodings", () => {
  const frontend = lowerGleamSource(
    "bit_arrays",
    `pub fn main() { <<"duck":utf16>> }\n`,
  );

  ok(!frontend.ok);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /supports only|must use the utf8 encoding/);
});

/**
 * A negative segment size is legal Gleam contributing no bits, not a syntax error. Upstream's own
 * suite pins it: `bit_array_test.gleam` asserts `bit_size(<<0:-8>>) == 0` and
 * `bit_size(<<0:-1>>) == 0`. This test used to assert the opposite, which rejected the whole
 * module.
 */
Deno.test("treats a negative static Gleam bit-array segment size as empty", async () => {
  const frontend = lowerGleamSource(
    "bit_arrays",
    `pub fn main() { bit_array_size(<<1:-1, 2:-8, 3:8>>) }

@external(javascript, "", "")
fn bit_array_size(array: BitArray) -> Int {
  case array {
    <<>> -> 0
    _ -> 1
  }
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  // Only the 3:8 segment contributes, so the array is one byte rather than empty or rejected.
  const evaluation = await evaluate(frontend.lowered);
  deepStrictEqual(evaluation, { kind: "signed-integer-64", value: 1n });
});

Deno.test("merges Gleam externals from one host module into one capability", async () => {
  const frontend = lowerGleamSources([
    {
      name: "external/add",
      source: `
@external(javascript, "./math.mjs", "add")
pub fn add(left: Int, right: Int) -> Int
`,
    },
    {
      name: "external/subtract",
      source: `
@external(javascript, "./math.mjs", "subtract")
pub fn subtract(left: Int, right: Int) -> Int
`,
    },
    {
      name: "external/main",
      source: `
import external/add.{add}
import external/subtract.{subtract}

pub fn main() -> Int {
  add(subtract(50, 8), 0)
}
`,
    },
  ], { module: "external/main", exportName: "main" });
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;
  const { compiler } = gleamRuntime();
  const compilation = await compiler.compileModule(frontend.lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const execution = await runWasmModule(compilation.module, {
      init: {
        "GleamExternal:./math.mjs": {
          "add@external/add.add": (argument) => {
            if (argument.kind !== "tuple") {
              throw new TypeError(`external add expected a tuple; received ${argument.kind}`);
            }
            const [left, right] = argument.values;
            if (left.kind !== "signed-integer-64" || right.kind !== "signed-integer-64") {
              throw new TypeError("external add expected two integers");
            }
            return { kind: "signed-integer-64", value: left.value + right.value };
          },
          "subtract@external/subtract.subtract": (argument) => {
            if (argument.kind !== "tuple") {
              throw new TypeError(`external subtract expected a tuple; received ${argument.kind}`);
            }
            const [left, right] = argument.values;
            if (left.kind !== "signed-integer-64" || right.kind !== "signed-integer-64") {
              throw new TypeError("external subtract expected two integers");
            }
            return { kind: "signed-integer-64", value: left.value - right.value };
          },
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "signed-integer-64", value: 42n });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("expands generic type aliases before creating module contracts", async () => {
  const frontend = lowerGleamSource(
    "aliases",
    `
type PairOf(value) = #(value, value)
type Numbers = PairOf(Int)

pub fn total(values: Numbers) -> Int {
  case values {
    #(left, right) -> left + right
    _ -> 0
  }
}

pub fn main() -> Int {
  total(#(20, 22))
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("rejects cyclic Gleam type aliases with their expansion path", () => {
  const frontend = lowerGleamSource(
    "alias_cycle",
    `
type First = Second
type Second = First

pub fn main() -> Int {
  42
}
`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /First -> Second -> First/);
});

Deno.test("preserves labeled Gleam constructor fields through Baba parsing", async () => {
  const frontend = lowerGleamSource(
    "labeled",
    `
pub type Box {
  Box(value: Int)
}

pub fn main() -> Int {
  case Box(value: 42) {
    Box(value: answer) -> answer
  }
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  const evaluation = await evaluate(frontend.lowered);
  deepStrictEqual(evaluation, { kind: "signed-integer-64", value: 42n });
});

Deno.test("resolves local Gleam record access and update", async () => {
  const frontend = lowerGleamSource(
    "record_access",
    `
pub type Person {
  Person(name: Int, age: Int)
}

fn age(person) {
  person.age
}

pub fn main() {
  let child = Person(name: 7, age: 8)
  let adult = Person(..child, age: 42)
  age(adult)
}
`,
  );
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;

  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("links and evaluates a recursive three-module Gleam program", async () => {
  const sources = await readKernelSources();
  const lowered = requireLinked(sources, "kernel/main");
  const evaluation = await evaluate(lowered, { heapSlots: KERNEL_HEAP_SLOTS });

  deepStrictEqual(evaluation, { kind: "signed-integer-64", value: 1109720n });
});

Deno.test("infers unannotated public types across Gleam module boundaries", async () => {
  const frontend = lowerGleamSources([
    {
      name: "inferred/library",
      source: `
pub const offset = 2

pub fn add(left, right) {
  left + right
}
`,
    },
    {
      name: "inferred/main",
      source: `
import inferred/library

pub fn main() {
  library.add(40, library.offset)
}
`,
    },
  ], { module: "inferred/main", exportName: "main" });

  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) return;
  deepStrictEqual(await evaluate(frontend.lowered), { kind: "signed-integer-64", value: 42n });
});

Deno.test("maps Baba lexical failures to Gleam UTF-8 byte spans", () => {
  const source = `// λ\npub fn main() -> Int { @ }\n`;
  const frontend = lowerGleamSource("invalid", source);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "G1001");
  const invalidByte = new TextEncoder().encode(source.slice(0, source.indexOf("@"))).byteLength;
  deepStrictEqual(frontend.diagnostics[0].span, {
    startByte: invalidByte,
    endByte: invalidByte + 1,
  });
  match(frontend.diagnostics[0].message, /PARSE_LEXICAL_ERROR/);
});

Deno.test("reports a missing imported Gleam function with its module name", () => {
  const frontend = lowerGleamSources([
    { name: "library", source: `pub fn present(value: Int) -> Int { value }\n` },
    {
      name: "application",
      source: `import library.{missing}\npub fn main() -> Int { missing(42) }\n`,
    },
  ], { module: "application", exportName: "main" });

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].module, "application");
  match(frontend.diagnostics[0].message, /"library.missing"/);
});

Deno.test("rejects a constructor arm after a Gleam catch-all", () => {
  const frontend = lowerGleamSource(
    "case_order",
    `
pub type Choice {
  First
  Second
}

pub fn main() -> Int {
  case First {
    _ -> 1
    Second -> 2
  }
}
`,
  );

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /catch-all case arm must be last/);
});

async function evaluateSingleExample(
  path: string,
): Promise<{ readonly kind: string; readonly value: unknown }> {
  const source = await Deno.readTextFile(path);
  const moduleName = path.split("/").at(-1)!.replace(".gleam", "");
  const frontend = lowerGleamSource(moduleName, source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error(`Gleam example ${JSON.stringify(path)} did not lower.`);
  return await evaluate(frontend.lowered);
}

async function evaluate(
  lowered: LoweredGleamProgram,
  options: EvaluationOptions = {},
): Promise<{ readonly kind: string; readonly value: unknown }> {
  const { compiler, evaluator } = gleamRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("Gleam example did not compile.");
  try {
    const evaluation = await evaluator.evaluate(compilation.module, options);
    ok(evaluation.ok, evaluation.ok ? undefined : evaluation.fault.message);
    if (!evaluation.ok) throw new Error("Gleam example did not evaluate.");
    if (
      evaluation.value.kind === "closure" || evaluation.value.kind === "unit" ||
      evaluation.value.kind === "constructor" || evaluation.value.kind === "tuple"
    ) {
      throw new Error(`Gleam example returned ${evaluation.value.kind}.`);
    }
    return evaluation.value;
  } finally {
    compilation.module.destroy();
  }
}

async function evaluateWasm(
  lowered: LoweredGleamProgram,
): Promise<{ readonly kind: string; readonly value?: unknown }> {
  const { compiler } = gleamRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("Gleam example did not compile.");
  try {
    return (await runWasmModule(compilation.module)).value;
  } finally {
    compilation.module.destroy();
  }
}

Deno.test("renders linked Gleam source and both functional IR stages side by side", async () => {
  const sources = await readKernelSources();
  const lowered = requireLinked(sources, "kernel/main");
  const { compiler, evaluator } = gleamRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const trace = renderGleamTrace({
      title: "linked kernel",
      source: sources.map((module) => `// ${module.name}\n${module.source}`).join("\n"),
      lowered,
      compiledModule: compilation.module,
      coreNodes: await compilation.module.readCoreNodes(),
      evaluation: await evaluator.evaluate(compilation.module, { heapSlots: 1024 }),
    });

    match(trace, /Gleam source modules<\/th><th>Normalized functional surface/);
    match(trace, /Encoded functional ABI<\/th><th>GPU-resolved core IR/);
    match(trace, /kernel\/program::run/);
    match(trace, /"value": 1109720/);
  } finally {
    compilation.module.destroy();
  }
});

async function readKernelSources(): Promise<readonly GleamSourceModule[]> {
  return await Promise.all(
    ["math", "program", "main"].map(async (name) => ({
      name: `kernel/${name}`,
      source: await Deno.readTextFile(`examples/gleam/kernel/${name}.gleam`),
    })),
  );
}

function requireLinked(
  sources: readonly GleamSourceModule[],
  entryModule: string,
): LoweredGleamProgram {
  const frontend = lowerGleamSources(sources, {
    module: entryModule,
    exportName: "main",
  });
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error("Linked Gleam example did not lower.");
  return frontend.lowered;
}

function gleamRuntime(): GleamRuntime {
  if (runtime === undefined) throw new Error("Gleam functional test runtime was not initialized");
  return runtime;
}
