import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";

import {
  GpuLazuliCompiler,
  GpuLazuliEvaluator,
  type GpuLazuliModule,
  LAZULI_NO_INDEX,
  LazuliCoreTag,
  type LazuliEvaluationOptions,
  type LazuliEvaluationResult,
  type LazuliInputValue,
  parseLazuliSource,
  requestWebGpuDevice,
} from "../mod.ts";
import { LAZULI_TYPE_WORD_LENGTH, LazuliTypeWord } from "../src/lazuli/abi.ts";

interface LazuliRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuLazuliCompiler;
  readonly evaluator: GpuLazuliEvaluator;
}

let lazuliRuntime: LazuliRuntime | undefined;

Deno.test.beforeAll(async () => {
  const device = await requestWebGpuDevice();
  const [compiler, evaluator] = await Promise.all([
    GpuLazuliCompiler.create(device),
    GpuLazuliEvaluator.create(device),
  ]);
  lazuliRuntime = { device, compiler, evaluator };
});

Deno.test.afterAll(() => {
  lazuliRuntime?.device.destroy();
  lazuliRuntime = undefined;
});

async function withLazuliRuntime(
  test: (runtime: LazuliRuntime) => Promise<void>,
): Promise<void> {
  if (!lazuliRuntime) throw new Error("Lazuli test runtime was not initialized");
  await test(lazuliRuntime);
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

async function readCoreNodeWords(
  device: GPUDevice,
  module: GpuLazuliModule,
): Promise<Uint32Array> {
  const byteLength = module.nodeCount * 8 * Uint32Array.BYTES_PER_ELEMENT;
  const readback = device.createBuffer({
    label: "Raw Lazuli core node test readback",
    size: byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const commands = device.createCommandEncoder();
    commands.copyBufferToBuffer(module.nodeBuffer, 0, readback, 0, byteLength);
    device.queue.submit([commands.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    return new Uint32Array(readback.getMappedRange().slice(0));
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    readback.destroy();
  }
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

Deno.test("infers primitive and let-polymorphic expression types", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const primitive = await compiler.compile("fn main = 42;");
    ok(primitive.ok);
    if (!primitive.ok) return;
    equal(primitive.module.mainType.kind, "integer");
    primitive.module.destroy();

    const polymorphic = await compiler.compile(
      "let identity = value => value; let main = (identity 1, identity true);",
    );
    ok(polymorphic.ok);
    if (!polymorphic.ok) return;
    deepStrictEqual(polymorphic.module.mainType, {
      kind: "tuple",
      values: [{ kind: "integer" }, { kind: "boolean" }],
    });
    polymorphic.module.destroy();
  });
});

Deno.test("accepts matching annotations and rejects mismatches", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const success = await compiler.compile("let main : Int = 42;");
    ok(success.ok);
    if (success.ok) {
      deepStrictEqual(success.module.mainType, { kind: "integer" });
      success.module.destroy();
    }

    const mismatch = await compiler.compile("let main : Bool = 42;");
    equal(mismatch.ok, false);
    if (!mismatch.ok) equal(mismatch.diagnostics[0].code, "L2102");
  });
});

Deno.test("reports an occurs-check failure for self-application", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile("let main = value => value value;");

    equal(compilation.ok, false);
    if (!compilation.ok) equal(compilation.diagnostics[0].code, "L2103");
  });
});

Deno.test("bounds diagnostics for exponentially shared inferred types and remains reusable", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    let nested = "x";
    for (let depth = 0; depth < 20; depth++) nested = `duplicate (${nested})`;
    const failed = await compiler.compile(
      `let duplicate = value => (value, value); let bad = x => x (${nested}); let main = 0;`,
    );

    equal(failed.ok, false);
    if (failed.ok) return;
    equal(failed.diagnostics[0].code, "L2103");
    ok(failed.diagnostics[0].message.length <= 9_000);

    const recovered = await compiler.compile("let main = 42;");
    ok(recovered.ok);
    if (recovered.ok) recovered.module.destroy();
  });
});

Deno.test("rejects a nonconcrete polymorphic main type", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile("let main = value => value;");

    equal(compilation.ok, false);
    if (!compilation.ok) equal(compilation.diagnostics[0].code, "L2104");
  });
});

Deno.test("retains frozen inferred main and algebraic type metadata", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "data Box a = Box(value: a); let main = Box 42;",
    );

    ok(compilation.ok);
    if (!compilation.ok) return;
    const { module } = compilation;
    ok(Object.isFrozen(module.mainType));
    ok(Object.isFrozen(module.typeDeclarations));
    const declaration = module.typeDeclarations.find((type) => type.name === "Box");
    ok(declaration);
    ok(Object.isFrozen(declaration));
    ok(Object.isFrozen(declaration.constructors));
    ok(Object.isFrozen(declaration.constructors[0]));
    deepStrictEqual(module.mainType, {
      kind: "named",
      name: "Box",
      arguments: [{ kind: "integer" }],
    });
    module.destroy();
  });
});

Deno.test("retains explicit indexed constructor results in compiled metadata", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "data Equal a b = Refl : Equal a a; let main : Equal Int Int = Refl;",
    );

    ok(compilation.ok);
    if (!compilation.ok) return;
    try {
      const declaration = compilation.module.typeDeclarations.find((type) => type.name === "Equal");
      ok(declaration);
      const result = declaration.constructors[0]?.result;
      ok(result);
      ok(Object.isFrozen(result));
      deepStrictEqual(result, {
        kind: "named",
        name: "Equal",
        arguments: [
          { kind: "parameter", name: "a" },
          { kind: "parameter", name: "a" },
        ],
      });
    } finally {
      compilation.module.destroy();
    }
  });
});

Deno.test("encodes empty algebraic types without constructors", () => {
  const parsing = parseLazuliSource("data False = ;");

  ok(parsing.ok);
  if (!parsing.ok) return;
  const typeIndex = parsing.surface.typeDeclarations.findIndex((type) => type.name === "False");
  ok(typeIndex >= 0);
  deepStrictEqual(parsing.surface.typeDeclarations[typeIndex]?.constructors, []);
  equal(
    parsing.surface.typeWords[
      typeIndex * LAZULI_TYPE_WORD_LENGTH + LazuliTypeWord.ConstructorCount
    ],
    0,
  );
});

Deno.test("encodes explicit constructor results without changing regular constructor shapes", () => {
  const source = "data Box a = Box(value: a); data Equal a b = Refl : Equal a a; let main = Refl;";
  const parsing = parseLazuliSource(source);

  ok(parsing.ok);
  if (!parsing.ok) return;
  const box = parsing.surface.typeDeclarations.find((type) => type.name === "Box");
  const equalType = parsing.surface.typeDeclarations.find((type) => type.name === "Equal");
  ok(box && equalType);
  const boxConstructor = box.constructors[0];
  ok(boxConstructor);
  equal("result" in boxConstructor, false);
  const result = equalType.constructors[0]?.result;
  ok(result);
  const resultStart = source.indexOf("Equal a a");
  deepStrictEqual(result, {
    kind: "named",
    name: "Equal",
    arguments: [
      { kind: "parameter", name: "a" },
      { kind: "parameter", name: "a" },
    ],
    startByte: resultStart,
    endByte: resultStart + "Equal a a".length,
  });
});

Deno.test("compiles annotated elimination from an empty type with no case arms", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      "data False = ; let main : False -> Int = impossible => case impossible of end;",
      { maximumStepsPerDispatch: 1 },
    );

    ok(compilation.ok);
    if (!compilation.ok) return;
    try {
      deepStrictEqual(compilation.module.mainType, {
        kind: "function",
        parameter: { kind: "named", name: "False", arguments: [] },
        result: { kind: "integer" },
      });
      const declaration = compilation.module.typeDeclarations.find((type) => type.name === "False");
      ok(declaration);
      deepStrictEqual(declaration.constructors, []);
      const nodes = await compilation.module.readCoreNodes();
      const emptyCase = nodes.find((node) => node.tag === LazuliCoreTag.Case);
      ok(emptyCase);
      equal(emptyCase.child1, LAZULI_NO_INDEX);
    } finally {
      compilation.module.destroy();
    }
  });
});

Deno.test("accepts typed list input and deeply reifies the result", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      "let main : List Int -> List Int = values => values;",
    );
    try {
      const result = await runtime.evaluator.evaluate(module, {
        input: { kind: "list", values: [{ kind: "integer", value: 20 }] },
        resultForm: "deep",
      });

      ok(result.ok);
      deepStrictEqual(result.value, {
        kind: "list",
        values: [{ kind: "integer", value: 20 }],
      });
    } finally {
      module.destroy();
    }
  });
});

Deno.test("prepares large host inputs without repeated traversal", async () => {
  await withLazuliRuntime(async (runtime) => {
    const listModule = await compileModule(
      runtime.compiler,
      "let main : List Int -> Int = values => 42;",
    );
    try {
      const largeList = Array.from(
        { length: 4_096 },
        (_, value) => ({ kind: "integer" as const, value }),
      );
      const listResult = await runtime.evaluator.evaluate(listModule, {
        input: { kind: "list", values: largeList },
        heapSlots: 20_000,
      });
      ok(listResult.ok);
      if (listResult.ok) deepStrictEqual(listResult.value, { kind: "integer", value: 42 });
    } finally {
      listModule.destroy();
    }
  });
});

Deno.test("accepts a shared host input value outside its active ancestry", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      "data Box = Box(value: Int); let main : (Box, Box) -> Int = values => 42;",
    );
    try {
      const shared = {
        kind: "constructor" as const,
        name: "Box",
        fields: [{ kind: "integer" as const, value: 1 }],
      };
      const result = await runtime.evaluator.evaluate(module, {
        input: { kind: "tuple", values: [shared, shared] },
      });
      ok(result.ok);
      if (result.ok) deepStrictEqual(result.value, { kind: "integer", value: 42 });
    } finally {
      module.destroy();
    }
  });
});

Deno.test("rejects a cyclic host input value before GPU evaluation", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      "let main : List (List Int) -> Int = values => 42;",
    );
    try {
      const cyclic = { kind: "list" as const, values: [] as LazuliInputValue[] };
      cyclic.values.push(cyclic);
      const result = await runtime.evaluator.evaluate(module, { input: cyclic });

      equal(result.ok, false);
      if (result.ok) return;
      equal(result.fault.kind, "bad-input");
      equal(result.fault.code, "L3009");
      deepStrictEqual(result.stats, {
        steps: 0,
        allocations: 0,
        peakStack: 0,
        thunkEvaluations: 0,
      });
    } finally {
      module.destroy();
    }
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
      "fn makeAdder x = fun y -> x + y; fn main = makeAdder 40 2;",
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("applies unary functions with space-delimited left association", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `let add = left => right => left + right;
       let double = value => value * 2;
       let main = add (double 20) 2;`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("passes tuples and unit as single function arguments", async () => {
  await withLazuliRuntime(async (runtime) => {
    const tupleResult = await evaluateSource(
      runtime,
      `let add = pair => case pair of | (left, right) -> left + right end;
       let main = add (20, 22);`,
    );
    ok(tupleResult.ok);
    deepStrictEqual(tupleResult.value, { kind: "integer", value: 42 });

    const unitResult = await evaluateSource(
      runtime,
      `let answer = unit => case unit of | () -> 42 end;
       let main = answer ();`,
    );
    ok(unitResult.ok);
    deepStrictEqual(unitResult.value, { kind: "integer", value: 42 });
  });
});

Deno.test("reifies and accepts host tuple and unit values", async () => {
  await withLazuliRuntime(async (runtime) => {
    const tuple = await evaluateSource(runtime, "let main = (20, 22);", {
      resultForm: "deep",
    });
    ok(tuple.ok);
    deepStrictEqual(tuple.value, {
      kind: "tuple",
      fieldCount: 2,
      fields: [{ kind: "integer", value: 20 }, { kind: "integer", value: 22 }],
    });

    const module = await compileModule(
      runtime.compiler,
      `let main = pair => case pair of | (left, right) -> left + right end;`,
    );
    try {
      const hostTuple = await runtime.evaluator.evaluate(module, {
        input: {
          kind: "tuple",
          values: [{ kind: "integer", value: 20 }, { kind: "integer", value: 22 }],
        },
      });
      ok(hostTuple.ok);
      deepStrictEqual(hostTuple.value, { kind: "integer", value: 42 });
    } finally {
      module.destroy();
    }

    const unit = await evaluateSource(runtime, "let main = ();", { resultForm: "deep" });
    ok(unit.ok);
    deepStrictEqual(unit.value, { kind: "unit" });
  });
});

Deno.test("rejects function declarations with more than one parameter", () => {
  const parsing = parseLazuliSource("fn add left right = left + right; let main = add 20 22;");
  equal(parsing.ok, false);
  if (!parsing.ok) equal(parsing.diagnostics[0].code, "L1001");
});

Deno.test("requires whitespace before every function argument", () => {
  const parsing = parseLazuliSource("let identity = value => value; let main = identity(42);");
  equal(parsing.ok, false);
  if (!parsing.ok) {
    equal(parsing.diagnostics[0].code, "L1001");
    match(parsing.diagnostics[0].message, /requires whitespace/i);
  }
});

Deno.test("requires whitespace before a specialization type descriptor", () => {
  const parsing = parseLazuliSource(
    "const identity a = value => value; let main = identity@Int 42;",
  );
  equal(parsing.ok, false);
  if (!parsing.ok) {
    equal(parsing.diagnostics[0].code, "L1001");
    match(parsing.diagnostics[0].message, /requires whitespace/i);
  }
});

Deno.test("resolves shadowed bindings by lexical depth", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "fn main = let x = 40 in (fun x -> let y = 2 in x + y) x;",
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("supports recursive top-level functions", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "fn factorial n = if n == 0 then 1 else n * factorial (n - 1); fn main = factorial 6;",
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

Deno.test("reports deeply nested parser input deterministically", () => {
  const parentheses = "(".repeat(375);
  const source = `fn main = ${parentheses}0${")".repeat(375)};`;
  const results = Array.from({ length: 5 }, () => parseLazuliSource(source));

  for (const parsing of results) {
    equal(parsing.ok, false);
    if (parsing.ok) return;
    equal(parsing.diagnostics[0].code, "L1003");
    match(parsing.diagnostics[0].message, /stack-safe limit/);
  }
  deepStrictEqual(results.slice(1), results.slice(0, -1));
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

Deno.test("classifies the generated parser trace limit as bounded exhaustion", () => {
  const size = 160;
  const parameters = Array.from({ length: size }, (_, index) => `p${index}`);
  let fieldType = parameters.at(-1)!;
  for (let index = parameters.length - 2; index >= 0; index--) {
    fieldType = `(${parameters[index]}, ${fieldType})`;
  }
  const fields = Array.from(
    { length: size },
    (_, index) => `f${index}: ${fieldType}`,
  ).join(", ");
  const parsing = parseLazuliSource(
    `data Product ${parameters.join(" ")} = Product(${fields}); let main = 0;`,
  );

  equal(parsing.ok, false);
  if (parsing.ok) return;
  equal(parsing.diagnostics[0].code, "L1003");
  match(parsing.diagnostics[0].message, /PARSER_TRACE_LIMIT/);
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

Deno.test("compiles a wide definition table within the default fuel limit", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const definitions = Array.from(
      { length: 1_500 },
      (_, index) => `fn x${index.toString(36)}=0;`,
    ).join("");
    const compilation = await compiler.compile(`${definitions}fn main=0;`);

    ok(compilation.ok);
    if (compilation.ok) compilation.module.destroy();

    const retry = await compiler.compile("fn main = 42;");
    ok(retry.ok);
    retry.module.destroy();
  });
});

Deno.test("validates compiler fuel, dispatch quanta, and cancellation controls", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const exhausted = await compiler.compile("let main = 42;", { maximumSteps: 1 });
    equal(exhausted.ok, false);
    if (!exhausted.ok) equal(exhausted.diagnostics[0].code, "L1003");

    await rejects(
      () => compiler.compile("let main = 42;", { maximumStepsPerDispatch: 0 }),
      /maximumStepsPerDispatch must be an integer from 1/,
    );

    const controller = new AbortController();
    controller.abort();
    await rejects(
      () => compiler.compile("let main = 42;", { signal: controller.signal }),
      (error: unknown) => error instanceof DOMException && error.name === "AbortError",
    );

    const betweenQuanta = new AbortController();
    const cancelled = compiler.compile("let main = 42;", {
      maximumStepsPerDispatch: 1,
      signal: betweenQuanta.signal,
    });
    queueMicrotask(() => betweenQuanta.abort(new Error("stop compilation between quanta")));
    await rejects(() => cancelled, /stop compilation between quanta/);

    const oneStep = await compiler.compile("let main = 42;", {
      maximumStepsPerDispatch: 1,
    });
    const largeQuantum = await compiler.compile("let main = 42;", {
      maximumStepsPerDispatch: 4_096,
    });
    ok(oneStep.ok);
    ok(largeQuantum.ok);
    if (!oneStep.ok || !largeQuantum.ok) return;
    deepStrictEqual(oneStep.module.mainType, largeQuantum.module.mainType);
    deepStrictEqual(
      await oneStep.module.readCoreNodes(),
      await largeQuantum.module.readCoreNodes(),
    );
    oneStep.module.destroy();
    largeQuantum.module.destroy();
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

Deno.test("reads UTF-8 core spans and resolved name payloads", async () => {
  await withLazuliRuntime(async ({ compiler, device }) => {
    const source =
      "-- é\ndata Box = Box; fn answer = 1; fn main = case Box of | Box -> let local = answer in local end;";
    const module = await compileModule(compiler, source);
    try {
      const nodes = await module.readCoreNodes();
      const nodeWords = await readCoreNodeWords(device, module);
      const encoder = new TextEncoder();
      const byteOffset = (utf16Offset: number): number =>
        encoder.encode(source.slice(0, utf16Offset)).byteLength;
      const nodeAt = (tag: number, payload: number, utf16Offset: number, length: number) => {
        const sourceByteOffset = byteOffset(utf16Offset);
        const sourceEndByte = sourceByteOffset + encoder.encode(source.slice(
          utf16Offset,
          utf16Offset + length,
        )).byteLength;
        const nodeIndex = nodes.findIndex((node) =>
          node.tag === tag && node.payload === payload &&
          node.sourceByteOffset === sourceByteOffset
        );
        return nodeIndex >= 0 && nodeWords[nodeIndex * 8 + 6] === sourceEndByte;
      };

      const caseOffset = source.indexOf("case Box");
      const constructorOffset = caseOffset + "case ".length;
      const caseArmOffset = source.indexOf("| Box");
      const finalLocalOffset = source.lastIndexOf("local");
      const answerOffset = source.indexOf("answer", caseOffset);

      ok(caseOffset > 0);
      ok(byteOffset(caseOffset) > caseOffset, "the leading é must shift UTF-8 byte offsets");
      ok(nodeAt(LazuliCoreTag.Constructor, 0, constructorOffset, "Box".length));
      ok(nodeAt(LazuliCoreTag.Global, 0, answerOffset, "answer".length));
      ok(nodeAt(LazuliCoreTag.Local, 0, finalLocalOffset, "local".length));

      const caseArmStartByte = byteOffset(caseArmOffset);
      const caseArmEndByte = byteOffset(source.indexOf("end"));
      const caseArmIndex = nodes.findIndex((node) =>
        node.tag === LazuliCoreTag.CaseArm && node.payload === 0 &&
        node.sourceByteOffset === caseArmStartByte
      );
      ok(caseArmIndex >= 0 && nodeWords[caseArmIndex * 8 + 6] === caseArmEndByte);
    } finally {
      module.destroy();
    }
  });
});

Deno.test("reports demanded cyclic globals as blackholes", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, "let main : Int = main;");

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
        mainType: { kind: "integer" },
        typeDeclarations: [],
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

Deno.test("faults safely if a constructor reaches a zero-arm core case", async () => {
  await withLazuliRuntime(async ({ device, evaluator }) => {
    const uploadStorageBuffer = (label: string, words: Uint32Array<ArrayBuffer>): GPUBuffer => {
      const buffer = device.createBuffer({
        label,
        size: words.byteLength,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
      });
      device.queue.writeBuffer(buffer, 0, words);
      return buffer;
    };
    const nodeBuffer = uploadStorageBuffer(
      "Hostile zero-arm Lazuli core nodes",
      new Uint32Array([
        LazuliCoreTag.Case,
        0,
        1,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
        LazuliCoreTag.Constructor,
        0,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        LAZULI_NO_INDEX,
        0,
        0,
        0,
      ]),
    );
    const definitionBuffer = uploadStorageBuffer(
      "Hostile zero-arm Lazuli definitions",
      new Uint32Array([0, 0, 0, 0]),
    );
    const constructorBuffer = uploadStorageBuffer(
      "Hostile zero-arm Lazuli constructors",
      new Uint32Array([0, 0, 0, 0, 0]),
    );
    let destroyed = false;
    const module: GpuLazuliModule = {
      nodeBuffer,
      definitionBuffer,
      constructorBuffer,
      nodeCount: 2,
      definitionCount: 1,
      constructorCount: 1,
      typeCount: 1,
      constructorNames: ["Fabricated"],
      constructorArities: [0],
      entryDefinition: 0,
      mainType: { kind: "integer" },
      typeDeclarations: [],
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
      const result = await evaluator.evaluate(module, { maximumSteps: 32, stackFrames: 8 });
      equal(result.ok, false);
      if (result.ok) return;
      equal(result.fault.kind, "non-exhaustive-case");
      equal(result.fault.code, "L3008");
      match(result.fault.message, /Fabricated/);
    } finally {
      module.destroy();
    }
  });
});

Deno.test("reports strict primitive type mismatches during compilation", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile("fn main = true + 1;");

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2102");
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

Deno.test("applies recursive functions directly to list literals", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `let sum = values => case values of
         | Nil -> 0
         | Cons(head, tail) -> head + sum tail
       end;
       fn main = sum [20, 22];`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("keeps constructor fields lazy and shares matched field thunks", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Pair a b = Pair(first: a, second: b);
       fn main = case Pair (20 + 1) (1 / 0) of
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
      `data Pair a b = Pair(first: a, second: b);
       fn complete partial = partial 32;
       fn main = let withTen = Pair 10 in case complete withTen of
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
      `data Maybe a = Nothing | Just(value: a);
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
      "data Box a = Box(value: a); fn main = Box (1 / 0);",
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "constructor", name: "Box", fieldCount: 1 });
  });
});

Deno.test("reports a non-exhaustive constructor case during compilation", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const result = await compiler.compile(
      `data Maybe a = Nothing | Just(value: a);
       fn main = case Just 42 of | Nothing -> 0 end;`,
    );

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.diagnostics[0].code, "L2010");
  });
});

Deno.test("requires a constructor-compatible scrutinee for case", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const result = await compiler.compile(
      "data Unit = Unit; fn main = case 42 of | Unit -> 0 end;",
    );

    equal(result.ok, false);
    if (result.ok) return;
    equal(result.diagnostics[0].code, "L2102");
  });
});

Deno.test("rejects a case pattern with the wrong constructor arity", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      `data Pair a b = Pair(first: a, second: b);
       fn main = case Pair 20 22 of | Pair(only) -> only end;`,
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
      "data Wrapped a = wrap(value: a); fn wrap value = value; fn main = wrap 42;",
    );

    equal(compilation.ok, false);
    if (compilation.ok) return;
    equal(compilation.diagnostics[0].code, "L2006");
  });
});

Deno.test("rejects duplicate constructor arms in one case", async () => {
  await withLazuliRuntime(async ({ compiler }) => {
    const compilation = await compiler.compile(
      `data Maybe a = Nothing | Just(value: a);
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
         if n == 0 then 1 else n * factorial (n - 1)
       in factorial 6;`,
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
         if n == 0 then 1 else n * factorial (n - 1)
       in factorial 4 + offset;`,
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
         if value == 0 then 2 else 1 + add (value - 1)
       in add value;`,
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
      "fn make = let rec local x = x in local 1; fn main = local 1;",
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
      "fn main = let rec identity value = value in identity 42;",
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
      "fn main = let rec identity value = value in identity 42;",
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
         if n == 0 then 1 else n * factorial (n - 1)
       in factorial 6;`,
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

Deno.test("repeated deep lexical lookup uses proportional evaluator fuel", async () => {
  await withLazuliRuntime(async (runtime) => {
    const source = (size: number) => {
      let body = Array.from({ length: size }, () => "outer").join(" + ");
      for (let index = size - 1; index >= 0; index--) {
        body = `let value${index} = ${index} in ${body}`;
      }
      return `let main = let outer = 1 in ${body};`;
    };
    const small = await evaluateSource(runtime, source(64));
    const large = await evaluateSource(runtime, source(128));

    ok(small.ok);
    ok(large.ok);
    if (!small.ok || !large.ok) return;
    deepStrictEqual(large.value, { kind: "integer", value: 128 });
    ok(large.stats.steps <= small.stats.steps * 2.2);
  });
});

Deno.test("resumes constructor arm search and pattern binding without forcing discarded fields", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Choice a = A | B(value: a) | C(first: a, unused: a, last: a);
       fn main = case C 40 (1 / 0) 2 of
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

Deno.test("dispatches wide constructor cases without arm-linear evaluator fuel", async () => {
  await withLazuliRuntime(async (runtime) => {
    const constructorCount = 256;
    const constructors = Array.from(
      { length: constructorCount },
      (_, index) => `C${index}`,
    ).join(" | ");
    const arms = Array.from(
      { length: constructorCount },
      (_, index) => `| C${index} -> ${index}`,
    ).join(" ");
    const module = await compileModule(
      runtime.compiler,
      `data Wide = ${constructors}; fn main = case C255 of ${arms} end;`,
    );
    const readCoreNodes = module.readCoreNodes.bind(module);
    let coreNodeReads = 0;
    module.readCoreNodes = () => {
      coreNodeReads++;
      return readCoreNodes();
    };
    try {
      const options = { maximumSteps: 128 } as const;
      const scalar = await runtime.evaluator.evaluate(module, options);
      const batch = await runtime.evaluator.evaluateBatch([module, module], options);

      ok(scalar.ok);
      if (scalar.ok) deepStrictEqual(scalar.value, { kind: "integer", value: 255 });
      for (const result of batch) {
        ok(result.ok);
        if (result.ok) deepStrictEqual(result.value, { kind: "integer", value: 255 });
      }
      equal(coreNodeReads, 1);
    } finally {
      module.destroy();
    }
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
         if n == 0 then 42 else count (n - 1)
       in count 100;`,
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

Deno.test("evaluates empty Lazuli batches and rejects an already-aborted batch", async () => {
  await withLazuliRuntime(async ({ evaluator }) => {
    deepStrictEqual(await evaluator.evaluateBatch([]), []);

    const controller = new AbortController();
    controller.abort(new Error("batch was already cancelled"));
    await rejects(
      () => evaluator.evaluateBatch([], { signal: controller.signal }),
      /batch was already cancelled/,
    );
  });
});

Deno.test("matches scalar Lazuli evaluation in input order and isolates faults within a batch", async () => {
  await withLazuliRuntime(async (runtime) => {
    const modules = await Promise.all([
      compileModule(runtime.compiler, "fn main = 40 + 2;"),
      compileModule(
        runtime.compiler,
        "fn factorial n = if n == 0 then 1 else n * factorial (n - 1); fn main = factorial 5;",
      ),
      compileModule(
        runtime.compiler,
        `data Pair a b = Pair(first: a, unused: b);
         fn main = case Pair (20 + 1) (1 / 0) of | Pair(shared, unused) -> shared + shared end;`,
      ),
      compileModule(runtime.compiler, "fn main = 1 / 0;"),
    ]);
    try {
      const scalar = await Promise.all(modules.map((module) => runtime.evaluator.evaluate(module)));
      const batch = await runtime.evaluator.evaluateBatch(modules);

      deepStrictEqual(batch, scalar);
      ok(batch[0]?.ok);
      ok(batch[1]?.ok);
      ok(batch[2]?.ok);
      equal(batch[3]?.ok, false);
      if (batch[3]?.ok === false) {
        equal(batch[3].fault.kind, "divide-by-zero");
      }
    } finally {
      for (const module of modules) module.destroy();
    }
  });
});

Deno.test("decodes batch constructors from each module's index-zero metadata", async () => {
  await withLazuliRuntime(async (runtime) => {
    const red = await compileModule(runtime.compiler, "data Red = Red; fn main = Red;");
    const blue = await compileModule(runtime.compiler, "data Blue = Blue; fn main = Blue;");
    try {
      const results = await runtime.evaluator.evaluateBatch([red, blue]);

      deepStrictEqual(results.slice(0, 2).map((result) => result?.ok && result.value), [
        { kind: "constructor", name: "Red", fieldCount: 0 },
        { kind: "constructor", name: "Blue", fieldCount: 0 },
      ]);
    } finally {
      red.destroy();
      blue.destroy();
    }
  });
});

Deno.test("gives duplicate batch references independent regions and keeps modules reusable", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      "fn main = let rec identity value = value in identity 42;",
    );
    try {
      const options = { maximumStepsPerDispatch: 1 };
      const scalar = await runtime.evaluator.evaluate(module, options);
      const batch = await runtime.evaluator.evaluateBatch([module, module], options);

      deepStrictEqual(batch, [scalar, scalar]);
      deepStrictEqual(await runtime.evaluator.evaluate(module, options), scalar);
    } finally {
      module.destroy();
    }
  });
});

Deno.test("applies batch fuel and heap limits independently to every evaluation", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      "fn main = let shared = 20 + 1 in shared + shared;",
    );
    try {
      const baseline = await runtime.evaluator.evaluate(module);
      ok(baseline.ok);
      const options = {
        maximumSteps: baseline.stats.steps,
        heapSlots: baseline.stats.allocations,
        maximumStepsPerDispatch: 1,
      };
      const scalar = await runtime.evaluator.evaluate(module, options);
      const batch = await runtime.evaluator.evaluateBatch([module, module], options);

      deepStrictEqual(batch, [scalar, scalar]);

      const fuelFaults = await runtime.evaluator.evaluateBatch([module, module], {
        maximumSteps: baseline.stats.steps - 1,
      });
      const heapFaults = await runtime.evaluator.evaluateBatch([module, module], {
        heapSlots: 1,
      });
      for (const result of fuelFaults) {
        equal(result.ok, false);
        if (result.ok) continue;
        equal(result.fault.kind, "out-of-fuel");
      }
      for (const result of heapFaults) {
        equal(result.ok, false);
        if (result.ok) continue;
        equal(result.fault.kind, "out-of-heap");
        equal(result.stats.allocations, 1);
      }
    } finally {
      module.destroy();
    }
  });
});

Deno.test("rejects malformed metadata for only the affected Lazuli batch member", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(runtime.compiler, "data Unit = Unit; fn main = Unit;");
    const malformedModule: GpuLazuliModule = {
      nodeBuffer: module.nodeBuffer,
      definitionBuffer: module.definitionBuffer,
      constructorBuffer: module.constructorBuffer,
      nodeCount: module.nodeCount,
      definitionCount: module.definitionCount,
      constructorCount: module.constructorCount,
      typeCount: module.typeCount,
      constructorNames: [],
      constructorArities: module.constructorArities,
      entryDefinition: module.entryDefinition,
      mainType: module.mainType,
      typeDeclarations: module.typeDeclarations,
      readCoreNodes: () => module.readCoreNodes(),
      destroy: () => {},
    };
    try {
      const results = await runtime.evaluator.evaluateBatch([module, malformedModule]);

      ok(results[0]?.ok);
      equal(results[1]?.ok, false);
      if (results[1]?.ok === false) {
        equal(results[1].fault.kind, "bad-module");
        equal(results[1].fault.code, "L3001");
      }
    } finally {
      module.destroy();
    }
  });
});

Deno.test("validates Lazuli batch options before evaluating its members", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(runtime.compiler, "fn main = 42;");
    try {
      await rejects(
        () => runtime.evaluator.evaluateBatch([module], { maximumSteps: 0 }),
        /maximumSteps must be an integer from 1/,
      );
      await rejects(
        () => runtime.evaluator.evaluateBatch([module], { heapSlots: 0 }),
        /heapSlots must be an integer from 1/,
      );
      await rejects(
        () => runtime.evaluator.evaluateBatch([module], { stackFrames: 0 }),
        /stackFrames must be an integer from 1/,
      );
    } finally {
      module.destroy();
    }
  });
});

Deno.test("rejects a batch exceeding the device workgroup limit before submission", async () => {
  await withLazuliRuntime(async ({ device, compiler, evaluator }) => {
    const module = await compileModule(compiler, "fn main = 42;");
    try {
      const evaluationCount = device.limits.maxComputeWorkgroupsPerDimension + 1;
      const modules = Array.from({ length: evaluationCount }, () => module);

      await rejects(
        () => evaluator.evaluateBatch(modules),
        (cause: Error) => {
          ok(cause instanceof RangeError);
          match(cause.message, new RegExp(evaluationCount.toString()));
          match(cause.message, /workgroup/i);
          return true;
        },
      );
    } finally {
      module.destroy();
    }
  });
});

Deno.test("honors batch cancellation between dispatch quanta and leaves its module reusable", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      `fn main = let rec count n =
         if n == 0 then 42 else count (n - 1)
       in count 100;`,
    );
    try {
      const controller = new AbortController();
      const evaluation = runtime.evaluator.evaluateBatch([module, module], {
        maximumStepsPerDispatch: 1,
        signal: controller.signal,
      });
      queueMicrotask(() => controller.abort(new Error("cancel batch between GPU dispatches")));

      await rejects(() => evaluation, /cancel batch between GPU dispatches/);

      const retry = await runtime.evaluator.evaluate(module);
      ok(retry.ok);
      deepStrictEqual(retry.value, { kind: "integer", value: 42 });
    } finally {
      module.destroy();
    }
  });
});

Deno.test("applies scalar host inputs to main", async () => {
  await withLazuliRuntime(async (runtime) => {
    const integerModule = await compileModule(runtime.compiler, "let main = value => value + 2;");
    const booleanModule = await compileModule(
      runtime.compiler,
      "let main = value => if value then 42 else 0;",
    );
    try {
      const integer = await runtime.evaluator.evaluate(integerModule, {
        input: { kind: "integer", value: 40 },
      });
      const boolean = await runtime.evaluator.evaluate(booleanModule, {
        input: { kind: "boolean", value: true },
      });

      ok(integer.ok);
      deepStrictEqual(integer.value, { kind: "integer", value: 42 });
      ok(boolean.ok);
      deepStrictEqual(boolean.value, { kind: "integer", value: 42 });
    } finally {
      integerModule.destroy();
      booleanModule.destroy();
    }
  });
});

Deno.test("specializes const values and erases forwarded type descriptors", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Box a = Box(value: a);
       const answer = 40;
       const identity a = value => value;
       const forwarded a = identity @a;
       let main = forwarded @(Box Int) (answer + 2);`,
    );

    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });
});

Deno.test("shares const specializations whose descriptors do not affect their bodies", async () => {
  const source =
    "const identity descriptor = value => value; let main = (identity @Int 1, identity @Bool true);";
  const parsing = parseLazuliSource(source);
  ok(parsing.ok);
  if (!parsing.ok) return;
  equal(parsing.surface.definitionCount, 2);

  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(runtime, source, { resultForm: "deep" });
    ok(result.ok);
    if (!result.ok) return;
    deepStrictEqual(result.value, {
      kind: "tuple",
      fieldCount: 2,
      fields: [{ kind: "integer", value: 1 }, { kind: "boolean", value: true }],
    });
  });
});

Deno.test("shares descriptor-forwarding const bodies across distinct descriptors", () => {
  const size = 64;
  const declarations = Array.from(
    { length: size },
    (_, index) => `data T${index} = C${index};`,
  ).join(" ");
  let forwardedBody = "identity @descriptor 0";
  let mainBody = `forwarded @T${size - 1}`;
  for (let index = size - 2; index >= 0; index--) {
    forwardedBody = `(identity @descriptor 0, ${forwardedBody})`;
    mainBody = `(forwarded @T${index}, ${mainBody})`;
  }
  const parsing = parseLazuliSource(
    `${declarations}
     const identity descriptor = value => value;
     const forwarded descriptor = ${forwardedBody};
     let main = ${mainBody};`,
  );

  ok(parsing.ok);
  if (!parsing.ok) return;
  equal(parsing.surface.definitionCount, 3);
  ok(parsing.surface.nodeCount < 1_000);
});

Deno.test("validates every descriptor when const bodies are shared", () => {
  const parsing = parseLazuliSource(
    `const choose (first, second) = value => value;
     const forwarded descriptor = choose @descriptor;
     let main = (forwarded @(Int, Bool) 0, forwarded @Int 0);`,
  );

  equal(parsing.ok, false);
  if (!parsing.ok) {
    match(parsing.diagnostics[0].message, /expects a tuple type descriptor/i);
  }
});

Deno.test("expands long flat const dependency chains without call-stack growth", () => {
  const size = 4_096;
  const declarations = Array.from(
    { length: size },
    (_, index) => `const value${index} = ${index + 1 === size ? "0" : `value${index + 1}`};`,
  ).join("\n");
  const parsing = parseLazuliSource(`${declarations}\nlet main = value0;`);

  ok(parsing.ok);
  if (!parsing.ok) return;
  equal(parsing.surface.definitionCount, size + 1);
  equal(parsing.surface.nodeCount, size + 1);
});

Deno.test("erases recursive descriptor changes that cannot affect validation", () => {
  const parsing = parseLazuliSource(
    "const loop descriptor = loop @(descriptor, Int); let main = loop @Int;",
  );

  ok(parsing.ok);
  if (!parsing.ok) return;
  equal(parsing.surface.definitionCount, 2);
  equal(parsing.surface.nodeCount, 2);
});

Deno.test("bounds recursively expanding const descriptor validation", () => {
  const parsing = parseLazuliSource(
    `const choose (first, second) = value => value;
     const loop descriptor = (choose @descriptor 0, loop @(descriptor, descriptor));
     let main = loop @(Int, Bool);`,
  );

  equal(parsing.ok, false);
  if (!parsing.ok) {
    match(parsing.diagnostics[0].message, /recursively produced 65 distinct descriptor/i);
  }
});

Deno.test("destructures structured const descriptors and infers holes", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Box a = Box(value: a);
       const identity a = value => value;
       const boxed a = identity @(Box a);
       const tupleChoice (a, b) = boxed @b;
       const recordChoice { fst: a, snd: b } = boxed @a;
       let main = (
         tupleChoice @(_, Bool) true,
         recordChoice @{ snd = Bool, fst = Int } 42
       );`,
      { resultForm: "deep" },
    );

    ok(result.ok);
    deepStrictEqual(result.value, {
      kind: "tuple",
      fieldCount: 2,
      fields: [{ kind: "boolean", value: true }, { kind: "integer", value: 42 }],
    });
  });
});

Deno.test("reports unknown and structurally mismatched const type descriptors", () => {
  const unknownType = parseLazuliSource(
    "const identity a = value => value; let main = identity @Missing 42;",
  );
  equal(unknownType.ok, false);
  if (!unknownType.ok) match(unknownType.diagnostics[0].message, /unknown const type descriptor/i);

  const wrongShape = parseLazuliSource(
    "const choose (a, b) = value => value; let main = choose @Int 42;",
  );
  equal(wrongShape.ok, false);
  if (!wrongShape.ok) match(wrongShape.diagnostics[0].message, /expects a tuple type descriptor/i);

  const unspecialized = parseLazuliSource(
    "const choose (a, b) = value => value; let main = choose 42;",
  );
  equal(unspecialized.ok, false);
  if (!unspecialized.ok) {
    match(unspecialized.diagnostics[0].message, /requires one type descriptor/i);
  }
});

Deno.test("lazily manipulates structured host input with top-level lets and arrows", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      `data Line = Line(price: Int, quantity: Int);
       data Order a = Order(lines: a);
       let line_total = line => case line of
         | Line(price, quantity) -> price * quantity
       end;
       let total = lines => case lines of
         | Nil -> 0
         | Cons(line, rest) -> line_total line + total rest
       end;
       let main = order => case order of
         | Order(lines) -> total lines
       end;`,
    );
    try {
      const result = await runtime.evaluator.evaluate(module, {
        input: {
          kind: "constructor",
          name: "Order",
          fields: [{
            kind: "constructor",
            name: "Cons",
            fields: [
              {
                kind: "constructor",
                name: "Line",
                fields: [
                  { kind: "integer", value: 21 },
                  { kind: "integer", value: 2 },
                ],
              },
              { kind: "constructor", name: "Nil", fields: [] },
            ],
          }],
        },
      });

      ok(result.ok);
      deepStrictEqual(result.value, { kind: "integer", value: 42 });
    } finally {
      module.destroy();
    }
  });
});

Deno.test("isolates distinct inputs for duplicate batch modules", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(runtime.compiler, "let main = value => value + 1;");
    try {
      const results = await runtime.evaluator.evaluateBatch([module, module], {
        inputs: [
          { kind: "integer", value: 20 },
          { kind: "integer", value: 41 },
        ],
      });

      deepStrictEqual(results.map((result) => result.ok && result.value), [
        { kind: "integer", value: 21 },
        { kind: "integer", value: 42 },
      ]);
    } finally {
      module.destroy();
    }
  });
});

Deno.test("reports invalid host constructors before GPU evaluation", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      "data Unit = Unit; let main : Int -> Int = value => value;",
    );
    try {
      const result = await runtime.evaluator.evaluate(module, {
        input: { kind: "constructor", name: "Missing", fields: [] },
      });

      equal(result.ok, false);
      if (result.ok) return;
      equal(result.fault.kind, "bad-input");
      equal(result.fault.code, "L3009");
      deepStrictEqual(result.stats, {
        steps: 0,
        allocations: 0,
        peakStack: 0,
        thunkEvaluations: 0,
      });
    } finally {
      module.destroy();
    }
  });
});

Deno.test("matches indexed constructor results before decoding host fields", async () => {
  await withLazuliRuntime(async (runtime) => {
    const module = await compileModule(
      runtime.compiler,
      `data Choice a b =
         First(value: a) : Choice b a
         | OnlyBool(value: Bool) : Choice Bool Bool;
       let main : Choice Bool Int -> Int = choice => 42;`,
    );
    try {
      const accepted = await runtime.evaluator.evaluate(module, {
        input: {
          kind: "constructor",
          name: "First",
          fields: [{ kind: "integer", value: 7 }],
        },
      });
      ok(accepted.ok);
      deepStrictEqual(accepted.value, { kind: "integer", value: 42 });

      const rejected = await runtime.evaluator.evaluate(module, {
        input: {
          kind: "constructor",
          name: "OnlyBool",
          fields: [{ kind: "boolean", value: true }],
        },
      });
      equal(rejected.ok, false);
      if (rejected.ok) return;
      equal(rejected.fault.kind, "bad-input");
      equal(rejected.fault.code, "L3009");
      deepStrictEqual(rejected.stats, {
        steps: 0,
        allocations: 0,
        peakStack: 0,
        thunkEvaluations: 0,
      });
    } finally {
      module.destroy();
    }
  });
});

Deno.test("deeply reifies constructor fields in source order", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `let main = Cons (20 + 1) (Cons (6 * 7) Nil);`,
      { resultForm: "deep" },
    );

    ok(result.ok);
    deepStrictEqual(result.value, {
      kind: "list",
      values: [
        { kind: "integer", value: 21 },
        { kind: "integer", value: 42 },
      ],
    });
  });
});

Deno.test("deep results force lazy fields and enforce their node limit", async () => {
  await withLazuliRuntime(async (runtime) => {
    const fieldFault = await evaluateSource(
      runtime,
      "data Box a = Box(value: a); let main = Box (1 / 0);",
      { resultForm: "deep" },
    );
    equal(fieldFault.ok, false);
    if (!fieldFault.ok) equal(fieldFault.fault.kind, "divide-by-zero");

    const sizeFault = await evaluateSource(
      runtime,
      "data Pair a b = Pair(left: a, right: b); let main = Pair 1 2;",
      { resultForm: "deep", maximumResultNodes: 2 },
    );
    equal(sizeFault.ok, false);
    if (!sizeFault.ok) {
      equal(sizeFault.fault.kind, "result-too-large");
      equal(sizeFault.fault.code, "L3010");
    }
  });
});

Deno.test("reports cyclic deep results without changing weak-head evaluation", async () => {
  await withLazuliRuntime(async (runtime) => {
    const source = "let main = Cons 1 main;";
    const weakHead = await evaluateSource(runtime, source);
    ok(weakHead.ok);
    deepStrictEqual(weakHead.value, { kind: "constructor", name: "Cons", fieldCount: 2 });

    const deep = await evaluateSource(runtime, source, { resultForm: "deep" });
    equal(deep.ok, false);
    if (!deep.ok) {
      equal(deep.fault.kind, "cyclic-result");
      equal(deep.fault.code, "L3011");
    }
  });
});

Deno.test("deeply reifies heterogeneous batch results with lane-local metadata", async () => {
  await withLazuliRuntime(async (runtime) => {
    const red = await compileModule(
      runtime.compiler,
      "data Color a = Red(value: a); let main = Red 21;",
    );
    const blue = await compileModule(
      runtime.compiler,
      "data Color a = Blue(value: a); let main = Blue 42;",
    );
    try {
      const results = await runtime.evaluator.evaluateBatch([red, blue], {
        resultForm: "deep",
      });
      deepStrictEqual(results.map((result) => result.ok && result.value), [
        {
          kind: "constructor",
          name: "Red",
          fieldCount: 1,
          fields: [{ kind: "integer", value: 21 }],
        },
        {
          kind: "constructor",
          name: "Blue",
          fieldCount: 1,
          fields: [{ kind: "integer", value: 42 }],
        },
      ]);
    } finally {
      red.destroy();
      blue.destroy();
    }
  });
});

Deno.test("lowers list literals to lazy Cons values", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      "let main = [20, 22];",
      { resultForm: "deep" },
    );
    ok(result.ok);
    deepStrictEqual(result.value, {
      kind: "list",
      values: [
        { kind: "integer", value: 20 },
        { kind: "integer", value: 22 },
      ],
    });
  });
});

Deno.test("orders named record fields from their constructor declaration", async () => {
  await withLazuliRuntime(async (runtime) => {
    const result = await evaluateSource(
      runtime,
      `data Line = Line(price: Int, quantity: Int);
       let main = case Line { quantity: 2, price: 21 } of
         | Line(price, quantity) -> price * quantity
       end;`,
    );
    ok(result.ok);
    deepStrictEqual(result.value, { kind: "integer", value: 42 });
  });

  const missing = parseLazuliSource(
    "data Line = Line(price: Int, quantity: Int); let main = Line { price: 21 };",
  );
  equal(missing.ok, false);
  if (!missing.ok) match(missing.diagnostics[0].message, /missing field "quantity"/i);
});

Deno.test("passes UTF-8 text through the host and manipulates its bytes", async () => {
  await withLazuliRuntime(async (runtime) => {
    const declarations = "";
    const identity = await compileModule(
      runtime.compiler,
      `${declarations} let main : Text -> Text = text => text;`,
    );
    const firstByte = await compileModule(
      runtime.compiler,
      `${declarations}
       let main = text => case text of
         | Utf8(bytes) -> case bytes of
           | BytesNil -> 0
           | BytesCons(byte, rest) -> byte
         end
       end;`,
    );
    const literal = await compileModule(
      runtime.compiler,
      `${declarations} let main = "zażółć";`,
    );
    try {
      const roundTrip = await runtime.evaluator.evaluate(identity, {
        input: { kind: "text", value: "zażółć" },
        resultForm: "deep",
      });
      ok(roundTrip.ok);
      deepStrictEqual(roundTrip.value, { kind: "text", value: "zażółć" });

      const inspected = await runtime.evaluator.evaluate(firstByte, {
        input: { kind: "text", value: "Ł" },
      });
      ok(inspected.ok);
      deepStrictEqual(inspected.value, { kind: "integer", value: 197 });

      const literalResult = await runtime.evaluator.evaluate(literal, { resultForm: "deep" });
      ok(literalResult.ok);
      deepStrictEqual(literalResult.value, { kind: "text", value: "zażółć" });
    } finally {
      identity.destroy();
      firstByte.destroy();
      literal.destroy();
    }
  });
});
