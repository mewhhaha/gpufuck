import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";

import {
  GpuLazuliCompiler,
  GpuLazuliEvaluator,
  type GpuLazuliModule,
  LAZULI_NO_INDEX,
  LazuliCoreTag,
  type LazuliEvaluationOptions,
  type LazuliEvaluationResult,
  parseLazuliSource,
  requestWebGpuDevice,
} from "../mod.ts";

interface LazuliRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuLazuliCompiler;
  readonly evaluator: GpuLazuliEvaluator;
}

async function withLazuliRuntime(
  test: (runtime: LazuliRuntime) => Promise<void>,
): Promise<void> {
  const device = await requestWebGpuDevice();
  try {
    await test({
      device,
      compiler: await GpuLazuliCompiler.create(device),
      evaluator: await GpuLazuliEvaluator.create(device),
    });
  } finally {
    device.destroy();
  }
}

async function compileModule(
  compiler: GpuLazuliCompiler,
  source: string,
): Promise<GpuLazuliModule> {
  const compilation = await compiler.compile(source);
  ok(
    compilation.ok,
    `expected Lazuli source to compile: ${JSON.stringify(compilation)}`,
  );
  return compilation.module;
}

async function evaluateSource(
  runtime: LazuliRuntime,
  source: string,
  options: LazuliEvaluationOptions = {},
): Promise<LazuliEvaluationResult> {
  const module = await compileModule(runtime.compiler, source);
  try {
    return await runtime.evaluator.evaluate(module, options);
  } finally {
    module.destroy();
  }
}

Deno.test("evaluates integer arithmetic with precedence and wrapping i32 overflow", async () => {
  await withLazuliRuntime(async (runtime) => {
    const arithmetic = await evaluateSource(runtime, "fn main = 2 + 5 * 8;");
    deepStrictEqual(arithmetic.ok && arithmetic.value, { kind: "integer", value: 42 });

    const overflow = await evaluateSource(runtime, "fn main = 2147483647 + 1;");
    deepStrictEqual(overflow.ok && overflow.value, {
      kind: "integer",
      value: -2_147_483_648,
    });
  });
});

Deno.test("accepts the minimum signed i32 literal", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = -2147483648;");

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: -2_147_483_648 });
  });
});

Deno.test("accepts leading zeros in the minimum signed i32 literal", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = -0002147483648;");

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: -2_147_483_648 });
  });
});

Deno.test("does not force unused expressions and evaluates a shared thunk once", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "fn main = let unused = 1 / 0 in let shared = 20 + 1 in shared + shared;",
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
    equal(result.stats.thunkEvaluations, 2);
  });
});

Deno.test("captures lexical bindings in escaping immutable closures", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "fn makeAdder x = fun y -> x + y; fn main = makeAdder(40)(2);",
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("resolves shadowed bindings by lexical depth", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "fn main = let x = 40 in (fun x -> let y = 2 in x + y)(x);",
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("supports recursive top-level functions", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "fn factorial n = if n == 0 then 1 else n * factorial(n - 1); fn main = factorial(6);",
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 720 });
  });
});

Deno.test("forces only the selected conditional branch", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = if false then 1 / 0 else 42;");

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("reports malformed syntax as a parse diagnostic", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile("fn main = ;");

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L1001");
    equal(compilation.diagnostics[0].stage, "parse");
  });
});

Deno.test("does not throw on deeply nested parser input", () => {
  const parentheses = "(".repeat(375);
  const parsing = parseLazuliSource(`fn main = ${parentheses}0${")".repeat(375)};`);

  if (parsing.ok) return;
  equal(parsing.diagnostics[0].code, "L1003");
  match(parsing.diagnostics[0].message, /stack-safe limit/);
});

Deno.test("does not throw when source exceeds the generated parser capacity", () => {
  const definitions = Array.from(
    { length: 12_000 },
    (_, index) => `fn x${index.toString(36)}=0;`,
  ).join("");
  const parsing = parseLazuliSource(`${definitions}fn main=0;`);

  if (parsing.ok) return;
  equal(parsing.diagnostics[0].code, "L1003");
  match(parsing.diagnostics[0].message, /parser's capacity|memory pages/);
});

Deno.test("rejects reserved words as declaration names", () => {
  const parsing = parseLazuliSource("fn true = 42; fn main = true;");

  equal(parsing.ok, false);
  if (parsing.ok) return;
  equal(parsing.diagnostics[0].code, "L1001");
  match(parsing.diagnostics[0].message, /Reserved word \"true\"/);
});

Deno.test("reports integer literals outside the i32 range", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile("fn main = 2147483648;");

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L1002");
    match(compilation.diagnostics[0].message, /outside the signed i32 range/);
  });
});

Deno.test("reports an unknown name with its UTF-8 byte span", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const source = "-- 🧊\nfn main = absent;";
    const compilation = await compiler.compile(source);

    equal(compilation.ok, false);
    if (compilation.ok) return;
    const diagnostic = compilation.diagnostics[0];
    const startByte = new TextEncoder().encode(source.slice(0, source.indexOf("absent"))).length;
    equal(diagnostic.code, "L2001");
    deepStrictEqual(diagnostic.span, { startByte, endByte: startByte + "absent".length });
  });
});

Deno.test("reports duplicate top-level definitions", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "fn answer = 1; fn answer = 2; fn main = answer;",
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2002");
    match(compilation.diagnostics[0].message, /duplicate top-level definition "answer"/);
  });
});

Deno.test("rejects excessive serial semantic work before GPU submission", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const definitions = Array.from(
      { length: 1_500 },
      (_, index) => `fn x${index.toString(36)}=0;`,
    ).join("");
    const compilation = await compiler.compile(`${definitions}fn main=0;`);

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L1003");
    match(compilation.diagnostics[0].message, /serial semantic work estimate/);

    const retry = await compiler.compile("fn main = 42;");
    ok(retry.ok);
    retry.module.destroy();
  });
});

Deno.test("requires a top-level main definition", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const source = "fn answer = 42;";
    const compilation = await compiler.compile(source);

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2003");
    deepStrictEqual(compilation.diagnostics[0].span, {
      startByte: source.length,
      endByte: source.length,
    });
  });
});

Deno.test("reports demanded cyclic globals as blackholes", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = main;");

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "blackhole");
    equal(result.fault.code, "L3005");
  });
});

Deno.test("rejects malformed core child edges as invalid modules", async () => {
  await withLazuliRuntime(async ({ device, evaluator }) => {
    const coreNodeWordLength = 8;
    const uploadStorageBuffer = (label: string, words: Uint32Array<ArrayBuffer>): GPUBuffer => {
      const buffer = device.createBuffer({
        label,
        size: words.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
      });
      device.queue.writeBuffer(buffer, 0, words);
      return buffer;
    };
    const evaluateMalformedCore = async (
      nodeWords: Uint32Array<ArrayBuffer>,
      rootNode: number,
    ): Promise<LazuliEvaluationResult> => {
      const nodeBuffer = uploadStorageBuffer("Malformed Lazuli core nodes", nodeWords);
      const definitionBuffer = uploadStorageBuffer(
        "Malformed Lazuli definitions",
        new Uint32Array([0, rootNode, 0, 0]),
      );
      const constructorBuffer = uploadStorageBuffer(
        "Malformed Lazuli constructors",
        new Uint32Array(5),
      );
      let destroyed = false;
      const malformedModule: GpuLazuliModule = {
        nodeBuffer,
        definitionBuffer,
        constructorBuffer,
        nodeCount: nodeWords.length / coreNodeWordLength,
        definitionCount: 1,
        constructorCount: 0,
        typeCount: 0,
        constructorNames: [],
        constructorArities: [],
        entryDefinition: 0,
        readCoreNodes: () => Promise.resolve([]),
        destroy() {
          if (destroyed) return;
          destroyed = true;
          nodeBuffer.destroy();
          definitionBuffer.destroy();
          constructorBuffer.destroy();
        },
      };

      try {
        return await evaluator.evaluate(malformedModule, {
          maximumSteps: 32,
          stackFrames: 8,
        });
      } finally {
        malformedModule.destroy();
      }
    };

    const selfEdge = await evaluateMalformedCore(
      new Uint32Array([
        LazuliCoreTag.Apply,
        0,
        0,
        1,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
        LazuliCoreTag.Integer,
        42,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
      ]),
      0,
    );
    const backwardEdge = await evaluateMalformedCore(
      new Uint32Array([
        LazuliCoreTag.Integer,
        1,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
        LazuliCoreTag.Apply,
        0,
        0,
        2,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
        LazuliCoreTag.Integer,
        42,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
      ]),
      1,
    );
    const extraneousLeafChild = await evaluateMalformedCore(
      new Uint32Array([
        LazuliCoreTag.Integer,
        42,
        1,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
        LazuliCoreTag.Integer,
        0,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
      ]),
      0,
    );

    for (
      const [description, result] of [
        ["self edge", selfEdge],
        ["backward edge", backwardEdge],
        ["extraneous leaf child", extraneousLeafChild],
      ] as const
    ) {
      equal(result.ok, false, `${description} should be rejected`);
      if (result.ok) continue;
      equal(result.fault.kind, "bad-module", description);
      equal(result.fault.code, "L3001", description);
    }
  });
});

Deno.test("reports strict primitive type errors", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = true + 1;");

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "type-error");
    match(result.fault.message, /expected integer, received boolean/);
  });
});

Deno.test("reports division by zero only when demanded", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = 1 / 0;");

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "divide-by-zero");
    equal(result.fault.code, "L3007");
  });
});

Deno.test("stops evaluation at its transition fuel limit", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = 42;", { maximumSteps: 1 });

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "out-of-fuel");
    equal(result.stats.steps, 1);
  });
});

Deno.test("reports deterministic exhaustion of its per-run region", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "fn main = let x = 20 + 1 in x + x;",
      { heapSlots: 1 },
    );

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "out-of-heap");
    equal(result.stats.allocations, 1);
  });
});

Deno.test("reports continuation stack exhaustion", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = 1 + 2;", { stackFrames: 1 });

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "stack-overflow");
    equal(result.stats.peakStack, 1);
  });
});

Deno.test("destroys GPU Lazuli modules idempotently", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const module = await compileModule(compiler, "fn main = 42;");
    module.destroy();
    module.destroy();

    await rejects(() => module.readCoreNodes(), /cannot read a destroyed GPU Lazuli module/);
  });
});

Deno.test("recurses over immutable algebraic lists", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data List = Nil | Cons(head, tail);
       fn sum values = case values of
         | Nil -> 0
         | Cons(head, tail) -> head + sum(tail)
       end;
       fn main = sum(Cons(20, Cons(22, Nil)));`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("keeps constructor fields lazy and shares matched field thunks", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Pair = Pair(first, second);
       fn main = case Pair(20 + 1, 1 / 0) of
         | Pair(shared, unused) -> shared + shared
       end;`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
    equal(result.stats.thunkEvaluations, 2);
  });
});

Deno.test("passes partially applied constructors as first-class functions", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Pair = Pair(first, second);
       fn complete partial = partial(32);
       fn main = let withTen = Pair(10) in case complete(withTen) of
         | Pair(first, second) -> first * 100 + second
       end;`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 1032 });
  });
});

Deno.test("selects a nullary constructor arm without evaluating other arms", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Maybe = Nothing | Just(value);
       fn main = case Nothing of
         | Just(value) -> 1 / 0
         | Nothing -> 42
       end;`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("returns a constructor in weak-head normal form without forcing its fields", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "data Box = Box(value); fn main = Box(1 / 0);",
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "constructor", name: "Box", fieldCount: 1 });
  });
});

Deno.test("reports a non-exhaustive constructor case", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Maybe = Nothing | Just(value);
       fn main = case Just(42) of | Nothing -> 0 end;`,
    );

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "non-exhaustive-case");
    equal(result.fault.code, "L3008");
  });
});

Deno.test("requires a constructor scrutinee for case", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "data Unit = Unit; fn main = case 42 of | Unit -> 0 end;",
    );

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "type-error");
    match(result.fault.message, /expected constructor, received integer/);
  });
});

Deno.test("rejects a case pattern with the wrong constructor arity", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      `data Pair = Pair(first, second);
       fn main = case Pair(20, 22) of | Pair(only) -> only end;`,
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2008");
  });
});

Deno.test("rejects an unknown constructor in a case pattern", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "data Unit = Unit; fn main = case Unit of | Missing -> 0 end;",
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2007");
  });
});

Deno.test("rejects duplicate data type declarations", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "data First = A; data First = B; fn main = A;",
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2004");
  });
});

Deno.test("rejects duplicate data constructors", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "data First = Same; data Second = Same; fn main = Same;",
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2005");
  });
});

Deno.test("rejects a constructor and function sharing a top-level name", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "data Wrapped = wrap(value); fn wrap value = value; fn main = wrap(42);",
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2006");
  });
});

Deno.test("rejects duplicate constructor arms in one case", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      `data Maybe = Nothing | Just(value);
       fn main = case Nothing of
         | Nothing -> 0
         | Nothing -> 1
       end;`,
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2009");
  });
});

Deno.test("evaluates a locally recursive function", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `fn main = let rec factorial n =
         if n == 0 then 1 else n * factorial(n - 1)
       in factorial(6);`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 720 });
  });
});

Deno.test("captures an outer binding in a locally recursive closure", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `fn main = let offset = 18 in let rec factorial n =
         if n == 0 then 1 else n * factorial(n - 1)
       in factorial(4) + offset;`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("keeps recursive parameters lexically inside the recursive name", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `fn main = let value = 40 in let rec add value =
         if value == 0 then 2 else 1 + add(value - 1)
       in add(value);`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("requires a parameter on a local recursive function", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "fn main = let rec loop = 1 in loop;",
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L1001");
  });
});

Deno.test("limits a local recursive name to its binding expression", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "fn make = let rec local x = x in local(1); fn main = local(1);",
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2001");
  });
});

Deno.test("reports region exhaustion while tying a local recursive knot", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "fn main = let rec identity value = value in identity(42);",
      { heapSlots: 2 },
    );

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "out-of-heap");
    equal(result.stats.allocations, 2);
  });
});

Deno.test("reclaims a local recursive cycle with each evaluation region", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      "fn main = let rec identity value = value in identity(42);",
    );
    try {
      const first = await runtime.evaluator.evaluate(module);
      const second = await runtime.evaluator.evaluate(module);

      ok(first.ok);
      ok(second.ok);
      deepStrictEqual(first.value, { kind: "integer", value: 42 });
      deepStrictEqual(second, first);
    } finally {
      module.destroy();
    }
  });
});

Deno.test("produces identical results and stats across dispatch quanta", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      `fn main = let rec factorial n =
         if n == 0 then 1 else n * factorial(n - 1)
       in factorial(6);`,
    );
    try {
      const oneStep = await runtime.evaluator.evaluate(module, { maximumStepsPerDispatch: 1 });
      const twoSteps = await runtime.evaluator.evaluate(module, { maximumStepsPerDispatch: 2 });
      const largeDispatch = await runtime.evaluator.evaluate(module, {
        maximumStepsPerDispatch: 4_096,
      });

      deepStrictEqual(oneStep, largeDispatch);
      deepStrictEqual(twoSteps, largeDispatch);
    } finally {
      module.destroy();
    }
  });
});

Deno.test("resumes global initialization across dispatches", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `fn one = 1; fn two = 2; fn three = 3; fn four = 4;
       fn main = 40 + two;`,
      { maximumStepsPerDispatch: 1 },
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
    ok(result.stats.allocations >= 5);
  });
});

Deno.test("resumes deep lexical lookup at one transition per dispatch", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `fn main = let answer = 42 in let b = 1 in let c = 2 in let d = 3 in
       let e = 4 in let f = 5 in answer;`,
      { maximumStepsPerDispatch: 1 },
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("resumes constructor arm search and pattern binding without forcing discarded fields", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Choice = A | B(value) | C(first, unused, last);
       fn main = case C(40, 1 / 0, 2) of
         | A -> 0
         | B(value) -> value
         | C(first, unused, last) -> first + last
       end;`,
      { maximumStepsPerDispatch: 1 },
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("applies total fuel across all dispatches", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "fn main = 40 + 2;", {
      maximumSteps: 5,
      maximumStepsPerDispatch: 2,
    });

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.fault.kind, "out-of-fuel");
    equal(result.stats.steps, 5);
  });
});

Deno.test("allows completion on exactly the final fuel transition", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(runtime.compiler, "fn main = 42;");
    try {
      const baseline = await runtime.evaluator.evaluate(module);
      ok(baseline.ok);

      const exact = await runtime.evaluator.evaluate(module, {
        maximumSteps: baseline.stats.steps,
        maximumStepsPerDispatch: 1,
      });
      deepStrictEqual(exact, baseline);

      const insufficient = await runtime.evaluator.evaluate(module, {
        maximumSteps: baseline.stats.steps - 1,
        maximumStepsPerDispatch: 2,
      });
      equal(insufficient.ok, false);
      if (insufficient.ok) return;
      equal(insufficient.fault.kind, "out-of-fuel");
      equal(insufficient.stats.steps, baseline.stats.steps - 1);
    } finally {
      module.destroy();
    }
  });
});

Deno.test("rejects invalid dispatch quanta", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(runtime.compiler, "fn main = 42;");
    try {
      await rejects(
        () => runtime.evaluator.evaluate(module, { maximumStepsPerDispatch: 0 }),
        /maximumStepsPerDispatch must be an integer from 1/,
      );
      await rejects(
        () => runtime.evaluator.evaluate(module, { maximumStepsPerDispatch: 1.5 }),
        /maximumStepsPerDispatch must be an integer from 1/,
      );
      await rejects(
        () => runtime.evaluator.evaluate(module, { maximumStepsPerDispatch: 65_537 }),
        /maximumStepsPerDispatch must be an integer from 1 through 65536/,
      );
    } finally {
      module.destroy();
    }
  });
});

Deno.test("honors cancellation between dispatches and leaves the module reusable", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      `fn main = let rec count n =
         if n == 0 then 42 else count(n - 1)
       in count(100);`,
    );
    try {
      const controller = new AbortController();
      const evaluation = runtime.evaluator.evaluate(module, {
        maximumStepsPerDispatch: 1,
        signal: controller.signal,
      });
      queueMicrotask(() => controller.abort(new Error("stop between GPU dispatches")));

      await rejects(() => evaluation, /stop between GPU dispatches/);

      const retry = await runtime.evaluator.evaluate(module);
      ok(retry.ok);
      deepStrictEqual(retry.value, { kind: "integer", value: 42 });
    } finally {
      module.destroy();
    }
  });
});

Deno.test("rejects a signal that is already aborted", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(runtime.compiler, "fn main = 42;");
    try {
      const controller = new AbortController();
      controller.abort(new Error("already cancelled"));

      await rejects(
        () => runtime.evaluator.evaluate(module, { signal: controller.signal }),
        /already cancelled/,
      );
    } finally {
      module.destroy();
    }
  });
});
