import { equal, match, ok } from "node:assert/strict";
import { GpuCompiler, GpuEvaluator, requestWebGpuDevice } from "../functional.ts";
import { compileSweepSource, parseSweepModule } from "../sweep.ts";

/**
 * Sweep exists to test DESIGN.md, so these tests assert the rules hold rather than that the
 * language is pleasant. Each rule that the grammar or the lowering enforces gets a case proving a
 * violation is rejected, because a rule the compiler does not enforce is a comment.
 */

const RUNTIME: { device?: GPUDevice; compiler?: GpuCompiler; evaluator?: GpuEvaluator } = {};

async function evaluate(source: string): Promise<unknown> {
  const lowered = compileSweepSource("t", source);
  ok(lowered.ok, lowered.ok ? undefined : lowered.diagnostics[0]!.message);
  if (!lowered.ok) throw new Error("unreachable");
  RUNTIME.device ??= await requestWebGpuDevice();
  RUNTIME.compiler ??= await GpuCompiler.create(RUNTIME.device);
  RUNTIME.evaluator ??= await GpuEvaluator.create(RUNTIME.device);
  const compilation = await RUNTIME.compiler.compileModule(lowered.module, {
    maximumSteps: 10_000_000,
  });
  ok(
    compilation.ok,
    compilation.ok
      ? undefined
      : `${compilation.diagnostics[0]!.code}: ${compilation.diagnostics[0]!.message}`,
  );
  if (!compilation.ok) throw new Error("unreachable");
  try {
    const execution = await RUNTIME.evaluator.evaluate(compilation.module);
    ok(execution.ok, execution.ok ? undefined : execution.fault.code);
    return execution.ok ? execution.value : undefined;
  } finally {
    compilation.module.destroy();
  }
}

Deno.test("Sweep compiles and runs through the GPU pipeline", async () => {
  const value = await evaluate(`type Shape = Circle(radius: Int) | Rect(width: Int, height: Int);

fn area(s: Shape) -> Int =
  match s {
    Circle(r) -> 3 * r * r;
    Rect(w, h) -> w * h;
  };

fn main() -> Int =
  let a: Int = area(Rect(6, 7)) in
  if a > 0 then a else 0;
`);
  equal((value as { value: number }).value, 42);
});

/** Rule 1: there is no syntax for an unannotated parameter, so this cannot even parse. */
Deno.test("Sweep rejects an unannotated parameter", () => {
  const parsed = parseSweepModule("t", `fn f(x) -> Int = x;\nfn main() -> Int = f(1);\n`);
  ok(!parsed.ok);
  if (parsed.ok) return;
  match(parsed.diagnostics[0]!.message, /expected ":"/);
});

/** Rule 5: locals are flat and unique, so shadowing is a diagnostic rather than a scope walk. */
Deno.test("Sweep rejects a shadowed local", () => {
  const lowered = compileSweepSource(
    "t",
    `fn main() -> Int =\n  let x: Int = 1 in\n  let x: Int = 2 in\n  x;\n`,
  );
  ok(!lowered.ok);
  if (lowered.ok) return;
  match(lowered.diagnostics[0]!.message, /already bound/);
});

/** Rule 5 again: a parameter and a local cannot collide either. */
Deno.test("Sweep rejects a local shadowing a parameter", () => {
  const lowered = compileSweepSource(
    "t",
    `fn f(n: Int) -> Int =\n  let n: Int = 2 in\n  n;\nfn main() -> Int = f(1);\n`,
  );
  ok(!lowered.ok);
  if (lowered.ok) return;
  match(lowered.diagnostics[0]!.message, /already bound/);
});

/**
 * Rule 4 is the one that pays, and it pays by exclusion: there is no or-pattern and no nesting in
 * the grammar, so the 13-16x per-arm explosion recorded in BASELINE.md has nothing to attach to.
 * A match arm binds one constructor's fields and nothing else.
 */
Deno.test("Sweep match arms lower one-to-one, with no body duplication", () => {
  const one = compileSweepSource(
    "t",
    `type T = A | B | C;
fn main() -> Int = match A { A -> 1; B -> 2; C -> 3; };
`,
  );
  ok(one.ok);
  if (!one.ok) return;
  const two = compileSweepSource(
    "t",
    `type T = A | B | C;
fn main() -> Int = match A { A -> 1 + 1; B -> 2 + 2; C -> 3 + 3; };
`,
  );
  ok(two.ok);
  if (!two.ok) return;
  // Three arms, one extra binary node each: linear in the source, not exponential in the arms.
  equal(two.module.nodeCount - one.module.nodeCount, 6);
});

/** Rule 2: type arguments are written at the call site and erased, so they cost no Core nodes. */
Deno.test("Sweep erases explicit type arguments", () => {
  const withArguments = compileSweepSource(
    "t",
    `fn pick[T](a: T, b: T) -> T = a;\nfn main() -> Int = pick[Int](7, 8);\n`,
  );
  ok(withArguments.ok, withArguments.ok ? undefined : withArguments.diagnostics[0]!.message);
  if (!withArguments.ok) return;
  const monomorphic = compileSweepSource(
    "t",
    `fn pick(a: Int, b: Int) -> Int = a;\nfn main() -> Int = pick(7, 8);\n`,
  );
  ok(monomorphic.ok);
  if (!monomorphic.ok) return;
  equal(withArguments.module.nodeCount, monomorphic.module.nodeCount);
});

/** Rule 7: an export naming nothing is a defect, not a silent no-op. */
Deno.test("Sweep rejects an export with no definition", () => {
  const lowered = compileSweepSource("t", `export missing;\nfn main() -> Int = 1;\n`);
  ok(!lowered.ok);
  if (lowered.ok) return;
  match(lowered.diagnostics[0]!.message, /is not defined/);
});

Deno.test("Sweep requires an entry point", () => {
  const lowered = compileSweepSource("t", `fn helper() -> Int = 1;\n`);
  ok(!lowered.ok);
  if (lowered.ok) return;
  match(lowered.diagnostics[0]!.message, /declares no "main"/);
});

globalThis.addEventListener("unload", () => RUNTIME.device?.destroy());
