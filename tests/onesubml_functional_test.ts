import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";

import {
  FunctionalTypecheckingProfile,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../functional.ts";
import {
  type LoweredOneSubmlFunctionalProgram,
  lowerOneSubmlFunctionalSource,
  renderOneSubmlFunctionalTrace,
} from "../onesubml_functional.ts";

interface OneSubmlFunctionalRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly evaluator: GpuFunctionalEvaluator;
}

let runtime: OneSubmlFunctionalRuntime | undefined;

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

Deno.test("runs recursive 1SubML syntax through GPU compilation and WebAssembly", async () => {
  const value = await runExample("examples/onesubml-functional/factorial.ml");

  deepStrictEqual(value, { kind: "integer", value: 120 });
});

Deno.test("runs 1SubML modules as immutable record values", async () => {
  const value = await runExample("examples/onesubml-functional/modules.ml");

  deepStrictEqual(value, { kind: "integer", value: 42 });
});

Deno.test("preserves 1SubML right-associative function application", async () => {
  const value = await runExample("examples/onesubml-functional/combinators.ml");

  deepStrictEqual(value, { kind: "integer", value: 42 });
});

Deno.test("passes one rank-1 generic function through a rank-2 parameter", async () => {
  const source = await Deno.readTextFile("examples/onesubml-functional/rank2.ml");
  const lowered = requireLowered(source);
  equal(
    lowered.module.typecheckingProfile,
    FunctionalTypecheckingProfile.PredicativeRank2Indexed,
  );
  const value = await runSource(source);

  deepStrictEqual(value, { kind: "integer", value: 42 });
});

Deno.test("instantiates every parameter of a multi-parameter rank-2 scheme", async () => {
  const value = await runSource(`let first = fun[A; B] (left, right): (A, B) :: A -> left;
let use = fun f: ([A; B]. (A, B) -> A) :: (int, bool) ->
  (f (42, true), f (true, 42));
let gpu_main = (
  let (answer, condition) = use first;
  if condition then answer else 0
);
`);

  deepStrictEqual(value, { kind: "integer", value: 42 });
});

Deno.test("rejects a monomorphic function at a rank-2 parameter", async () => {
  const lowered = requireLowered(`let integer_identity = fun value -> value + 0;
let use = fun f: ([T]. T -> T) :: (int, bool) -> (f 42, f true);
let gpu_main = (
  let (answer, condition) = use integer_identity;
  if condition then answer else 0
);
`);
  const compilation = await onesubmlRuntime().compiler.compileModule(lowered.module);

  equal(compilation.ok, false);
  if (!compilation.ok) {
    equal(compilation.diagnostics[0].code, "F2102");
    match(compilation.diagnostics[0].message, /type mismatch/);
  }
});

Deno.test("rank-2 compilation is invariant across dispatch quanta", async () => {
  const source = await Deno.readTextFile("examples/onesubml-functional/rank2.ml");
  const lowered = requireLowered(source);
  const values = [];
  for (const maximumStepsPerDispatch of [7, 4_096]) {
    const compilation = await onesubmlRuntime().compiler.compileModule(lowered.module, {
      maximumStepsPerDispatch,
    });
    ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
    if (!compilation.ok) throw new Error("rank-2 module did not compile");
    try {
      values.push((await runFunctionalWasmModule(compilation.module)).value);
    } finally {
      compilation.module.destroy();
    }
  }

  deepStrictEqual(values, [
    { kind: "integer", value: 42 },
    { kind: "integer", value: 42 },
  ]);
});

Deno.test("rank-2 compilation succeeds exactly at its fuel threshold", async () => {
  const source = await Deno.readTextFile("examples/onesubml-functional/rank2.ml");
  const lowered = requireLowered(source);
  const compiler = onesubmlRuntime().compiler;
  let exhaustedSteps = 0;
  let completingSteps = 1;
  while (true) {
    const compilation = await compiler.compileModule(lowered.module, {
      maximumSteps: completingSteps,
      maximumStepsPerDispatch: 4_096,
    });
    if (compilation.ok) {
      compilation.module.destroy();
      break;
    }
    equal(compilation.diagnostics[0].code, "F1003");
    exhaustedSteps = completingSteps;
    completingSteps *= 2;
  }
  while (completingSteps - exhaustedSteps > 1) {
    const candidate = Math.floor((exhaustedSteps + completingSteps) / 2);
    const compilation = await compiler.compileModule(lowered.module, {
      maximumSteps: candidate,
      maximumStepsPerDispatch: 4_096,
    });
    if (compilation.ok) {
      compilation.module.destroy();
      completingSteps = candidate;
    } else {
      equal(compilation.diagnostics[0].code, "F1003");
      exhaustedSteps = candidate;
    }
  }

  for (const maximumStepsPerDispatch of [7, 4_096]) {
    const exhausted = await compiler.compileModule(lowered.module, {
      maximumSteps: completingSteps - 1,
      maximumStepsPerDispatch,
    });
    equal(exhausted.ok, false);
    if (!exhausted.ok) equal(exhausted.diagnostics[0].code, "F1003");

    const exact = await compiler.compileModule(lowered.module, {
      maximumSteps: completingSteps,
      maximumStepsPerDispatch,
    });
    ok(exact.ok, exact.ok ? undefined : exact.diagnostics[0].message);
    if (exact.ok) exact.module.destroy();
  }
});

Deno.test("rejects a quantifier placed deeper than rank 2", async () => {
  const lowered = requireLowered(`let use = fun f: (([T]. T -> T) -> int) :: int -> 0;
let gpu_main = use;
`);

  await rejects(
    () => onesubmlRuntime().compiler.compileModule(lowered.module),
    /places forall deeper than rank 2/,
  );
});

Deno.test("runs sequential bindings inside a 1SubML expression block", async () => {
  const value = await runExample("examples/onesubml-functional/blocks.ml");

  deepStrictEqual(value, { kind: "integer", value: 42 });
});

Deno.test("treats record field order as structural within one shape", async () => {
  const value = await runSource(`let first = {b=2; a=40};
let second = {a=2; b=0};
let gpu_main = first.a + second.a;
`);

  deepStrictEqual(value, { kind: "integer", value: 42 });
});

Deno.test("rejects a 1SubML record projection when the field is absent", () => {
  const frontend = lowerOneSubmlFunctionalSource(`let value = {present=42};
let gpu_main = value.missing;
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  equal(frontend.diagnostics[0].code, "S1002");
  match(frontend.diagnostics[0].message, /no field "missing".*"present"/);
});

Deno.test("rejects structural constraints that cross an unannotated function boundary", () => {
  const frontend = lowerOneSubmlFunctionalSource(`let project = fun value -> value.answer;
let gpu_main = project {answer=42};
`);

  equal(frontend.ok, false);
  if (frontend.ok) return;
  match(frontend.diagnostics[0].message, /cannot determine the record shape.*"answer"/);
});

Deno.test("rejects a forward 1SubML value reference outside sequential scope", () => {
  const forward = lowerOneSubmlFunctionalSource(`let first = later;
let later = 42;
let gpu_main = first;
`);
  equal(forward.ok, false);
  if (!forward.ok) match(forward.diagnostics[0].message, /"later" is not in sequential scope/);
});

Deno.test("requires rec before a 1SubML definition can reference itself", () => {
  const recursion = lowerOneSubmlFunctionalSource(`let loop = fun value -> loop value;
let gpu_main = 42;
`);
  equal(recursion.ok, false);
  if (!recursion.ok) match(recursion.diagnostics[0].message, /"loop" is not in sequential scope/);
});

Deno.test("renders 1SubML source and both functional IR stages side by side", async () => {
  const source = await Deno.readTextFile("examples/onesubml-functional/modules.ml");
  const lowered = requireLowered(source);
  const { compiler, evaluator } = onesubmlRuntime();
  const compilation = await compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const trace = renderOneSubmlFunctionalTrace({
      title: "modules",
      source,
      lowered,
      compiledModule: compilation.module,
      coreNodes: await compilation.module.readCoreNodes(),
      evaluation: await evaluator.evaluate(compilation.module),
    });

    match(trace, /1SubML source<\/th><th>Normalized functional surface/);
    match(trace, /Encoded functional ABI<\/th><th>GPU-resolved core IR/);
    match(trace, /type \$OneSubmlRecord0/);
    match(trace, /entry=d1; type=i32/);
  } finally {
    compilation.module.destroy();
  }
});

async function runExample(
  path: string,
): Promise<{ readonly kind: string; readonly value?: number | boolean }> {
  return await runSource(await Deno.readTextFile(path));
}

async function runSource(
  source: string,
): Promise<{ readonly kind: string; readonly value?: number | boolean }> {
  const lowered = requireLowered(source);
  const compilation = await onesubmlRuntime().compiler.compileModule(lowered.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("1SubML example did not compile.");
  try {
    return (await runFunctionalWasmModule(compilation.module)).value;
  } finally {
    compilation.module.destroy();
  }
}

function requireLowered(source: string): LoweredOneSubmlFunctionalProgram {
  const frontend = lowerOneSubmlFunctionalSource(source);
  ok(frontend.ok, frontend.ok ? undefined : frontend.diagnostics[0].message);
  if (!frontend.ok) throw new Error("1SubML example did not lower.");
  return frontend.lowered;
}

function onesubmlRuntime(): OneSubmlFunctionalRuntime {
  if (runtime === undefined) throw new Error("1SubML functional runtime was not initialized");
  return runtime;
}
