import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { GpuCompiler, GpuEvaluator, requestWebGpuDevice, runWasmModule } from "../functional.ts";
import type { WasmHostValue } from "../functional.ts";
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

/**
 * Rule 5 is scoped per path, not per function. Sibling `match` arms are disjoint — only one is ever
 * live — so reusing a binder across them threatens no scope chain, and the two branches of an `if`
 * are disjoint for the same reason. Rejecting these was stricter than DESIGN requires.
 */
Deno.test("Sweep allows a binder reused across disjoint scopes", () => {
  const arms = compileSweepSource(
    "t",
    `type T = One(value: Int) | Two(value: Int);
fn pick(t: T) -> Int =
  match t {
    One(inner) -> inner + 1;
    Two(inner) -> inner + 2;
  };
fn main() -> Int = pick(One(1));
`,
  );
  ok(arms.ok, arms.ok ? undefined : arms.diagnostics[0]!.message);

  const branches = compileSweepSource(
    "t",
    `fn choose(flag: Bool) -> Int =
  if flag then let value: Int = 1 in value else let value: Int = 2 in value;
fn main() -> Int = choose(true);
`,
  );
  ok(branches.ok, branches.ok ? undefined : branches.diagnostics[0]!.message);
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

/**
 * The vim example is the largest Sweep program and the only one driven from outside, so it is worth
 * a test that exercises the same path the terminal host uses: build a key history as a constructor
 * tree, hand it to WebAssembly, and read the document back out.
 */
Deno.test("Sweep vim replays a scripted session", async () => {
  const source = await Deno.readTextFile("examples/sweep/vim.sweep");
  const lowered = compileSweepSource("vim", source);
  ok(lowered.ok, lowered.ok ? undefined : lowered.diagnostics[0]!.message);
  if (!lowered.ok) return;

  RUNTIME.device ??= await requestWebGpuDevice();
  RUNTIME.compiler ??= await GpuCompiler.create(RUNTIME.device);
  const compilation = await RUNTIME.compiler.compileModule(lowered.module, {
    maximumSteps: 10_000_000,
  });
  ok(
    compilation.ok,
    compilation.ok
      ? undefined
      : `${compilation.diagnostics[0]!.code}: ${compilation.diagnostics[0]!.message}`,
  );
  if (!compilation.ok) return;

  try {
    const keys = (codes: readonly number[]): WasmHostValue => {
      let list: WasmHostValue = { kind: "constructor", name: "NoKeys", fields: [] };
      for (let index = codes.length - 1; index >= 0; index--) {
        list = {
          kind: "constructor",
          name: "Press",
          fields: [{ kind: "integer", value: codes[index]! }, list],
        };
      }
      return list;
    };
    const line = (value: WasmHostValue): string => {
      let text = "";
      let at = value;
      while (at.kind === "constructor" && at.name === "Char") {
        const code = at.fields[0]!;
        if (code.kind !== "integer") throw new Error("not an integer");
        text += String.fromCharCode(code.value);
        at = at.fields[1]!;
      }
      return text;
    };
    const at = (value: WasmHostValue, index: number): WasmHostValue => {
      if (value.kind !== "constructor") {
        throw new Error(`expected a constructor, got ${value.kind}`);
      }
      return value.fields[index]!;
    };
    const nameOf = (value: WasmHostValue): string => {
      if (value.kind !== "constructor") {
        throw new Error(`expected a constructor, got ${value.kind}`);
      }
      return value.name;
    };
    const currentLine = (state: WasmHostValue): string => {
      const zipper = at(at(state, 0), 1);
      return [...line(at(zipper, 0))].reverse().join("") + line(at(zipper, 1));
    };
    const mode = (state: WasmHostValue): string => nameOf(at(state, 1));

    const codes = (text: string) => [...text].map((character) => character.charCodeAt(0));
    const run = async (script: readonly number[]) =>
      (await runWasmModule(compilation.module, {
        argument: keys(script),
        maximumResultNodes: 200_000,
      }))
        .value as WasmHostValue;

    // `i` enters insert, ESC leaves it.
    equal(currentLine(await run([...codes("ihello"), 27])), "hello");
    equal(mode(await run([...codes("ihello"), 27])), "Normal");
    equal(mode(await run(codes("ihello"))), "Insert");

    // `0` home then `x` deletes under the cursor; `$` end then `x` is a no-op past the last column.
    equal(currentLine(await run([...codes("ihello"), 27, ...codes("0x")])), "ello");

    // `A` appends at end of line.
    equal(currentLine(await run([...codes("ihi"), 27, ...codes("A!"), 27])), "hi!");

    // `q` in normal mode sets the quit flag the host watches.
    const quit = await run([...codes("ihi"), 27, ...codes("q")]);
    deepStrictEqual(at(quit, 2), { kind: "boolean", value: true });
  } finally {
    compilation.module.destroy();
  }
});
