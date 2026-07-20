import { deepStrictEqual, equal, ok } from "node:assert/strict";

import {
  GpuLazuliCompiler,
  type LazuliCompilationOptions,
  type LazuliDiagnostic,
  type LazuliType,
  type LazuliTypeDeclaration,
  requestWebGpuDevice,
} from "../mod.ts";
import { buildFunctionalSurfaceModule, surface } from "../functional.ts";
import { semanticSurfaceFromModule } from "../src/functional/compiler.ts";
import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import { inferLazuliTypes } from "../src/lazuli/type_inference.ts";

interface InferenceSnapshotSuccess {
  readonly ok: true;
  readonly mainType: LazuliType;
  readonly typeDeclarations: readonly LazuliTypeDeclaration[];
}

interface InferenceSnapshotFailure {
  readonly ok: false;
  readonly diagnostics: readonly LazuliDiagnostic[];
}

interface CorpusProgram {
  readonly name: string;
  readonly source: string;
}

type InferenceSnapshot = InferenceSnapshotSuccess | InferenceSnapshotFailure;

async function withCompiler(test: (compiler: GpuLazuliCompiler) => Promise<void>): Promise<void> {
  const device = await requestWebGpuDevice();
  try {
    await test(await GpuLazuliCompiler.create(device));
  } finally {
    device.destroy();
  }
}

function inferWithHostOracle(source: string) {
  const parsing = parseLazuliSource(source);
  ok(parsing.ok, `expected parity fixture to parse: ${source}`);
  if (!parsing.ok) throw new Error("unreachable");
  return inferLazuliTypes(parsing.surface);
}

async function compilerInferenceSnapshot(
  compiler: GpuLazuliCompiler,
  source: string,
  options: LazuliCompilationOptions,
): Promise<InferenceSnapshot> {
  const expected = inferWithHostOracle(source);
  const compilation = await compiler.compile(source, options);

  if (expected.ok) {
    ok(compilation.ok, `GPU compiler rejected host-inferable source: ${source}`);
    if (!compilation.ok) throw new Error("unreachable");
    try {
      deepStrictEqual(compilation.module.mainType, expected.mainType);
      deepStrictEqual(compilation.module.typeDeclarations, expected.typeDeclarations);
      return {
        ok: true,
        mainType: compilation.module.mainType,
        typeDeclarations: compilation.module.typeDeclarations,
      };
    } finally {
      compilation.module.destroy();
    }
  }

  if (compilation.ok) {
    compilation.module.destroy();
    throw new Error(`GPU compiler accepted host-rejected source: ${source}`);
  }
  deepStrictEqual(compilation.diagnostics, [expected.diagnostic]);
  return { ok: false, diagnostics: compilation.diagnostics };
}

function sourcePrefix(index: number): string {
  return index % 8 === 0 ? `-- UTF-8 corpus prefix é ${index}\n` : "";
}

function successfulSource(index: number): CorpusProgram {
  const value = index + 1;
  const suffix = index.toString(36);
  const source = [
    `let identity${suffix} = value => value; let main = (identity${suffix} ${value}, identity${suffix} true);`,
    `fn even${suffix} value = if value == 0 then true else odd${suffix} (value - 1); fn odd${suffix} value = if value == 0 then false else even${suffix} (value - 1); fn main = even${suffix} ${value};`,
    `data Box${suffix} a = Box${suffix}(value: a); let main : Box${suffix} Int = Box${suffix} ${value};`,
    `data Maybe${suffix} a = Nothing${suffix} | Just${suffix}(value: a); let main = case Just${suffix} ${value} of | Nothing${suffix} -> 0 | Just${suffix}(value) -> value end;`,
    `let add${suffix} = pair => case pair of | (left, right) -> left + right end; let main = add${suffix} (${value}, 1);`,
    `let answer${suffix} = unit => case unit of | () -> ${value} end; let main = answer${suffix} ();`,
    `let increment${suffix} : Int -> Int = value => value + 1; let main = increment${suffix} ${value};`,
    `data Pair${suffix} a b = Pair${suffix}(first: a, second: b); let main = Pair${suffix} ${value} true;`,
  ][index % 8];
  if (source === undefined) throw new Error(`missing successful template ${index % 8}`);

  return {
    name: `successful program ${index + 1}`,
    source: `${sourcePrefix(index)}${source}`,
  };
}

function singleFaultSource(index: number): CorpusProgram {
  const value = index + 1;
  const suffix = index.toString(36);
  const source = [
    `let main : Bool = ${value};`,
    `let main = value${suffix} => value${suffix} value${suffix};`,
    `let main = value${suffix} => value${suffix};`,
    `data Box${suffix} a = Box${suffix}(value: a); let main : Box${suffix} Bool = Box${suffix} ${value};`,
    `data Pair${suffix} a = Pair${suffix}(value: a); let main : Pair${suffix} Int Bool = Pair${suffix} ${value};`,
    `data Maybe${suffix} = None${suffix} | Some${suffix}(value: Int); let main = case None${suffix} of | Some${suffix}(value) -> value end;`,
    `let main = if true then ${value} else false;`,
    `let main : Int -> Bool = value${suffix} => value${suffix} + ${value};`,
  ][index % 8];
  if (source === undefined) throw new Error(`missing fault template ${index % 8}`);

  return {
    name: `single-fault program ${index + 1}`,
    source: `${sourcePrefix(index)}${source}`,
  };
}

const successfulCorpus = Array.from({ length: 64 }, (_, index) => successfulSource(index));
const singleFaultCorpus = Array.from({ length: 64 }, (_, index) => singleFaultSource(index));
const representativeCorpus = [
  ...successfulCorpus.slice(0, 8),
  ...singleFaultCorpus.slice(0, 8),
];

Deno.test("host type inference treats runtime faults as dependency leaves", () => {
  const module = buildFunctionalSurfaceModule(
    [
      {
        name: "failure",
        parameters: [],
        annotation: null,
        body: surface.runtimeFault("broken"),
      },
      {
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.integer(42),
      },
    ],
    [],
    "main",
    0,
  );

  const inference = inferLazuliTypes(semanticSurfaceFromModule(module));

  ok(inference.ok, inference.ok ? undefined : inference.diagnostic.message);
  if (!inference.ok) return;
  deepStrictEqual(inference.mainType, { kind: "integer" });
});

Deno.test("GPU type inference matches the host oracle for the 64-program successful corpus", async () => {
  equal(successfulCorpus.length, 64);

  await withCompiler(async (compiler) => {
    for (const program of successfulCorpus) {
      const snapshot = await compilerInferenceSnapshot(compiler, program.source, {
        maximumStepsPerDispatch: 4_096,
      });
      equal(snapshot.ok, true, program.name);
    }
  });
});

Deno.test("indexed constructor results match the host across dispatch quanta", async () => {
  const fixtures = [
    {
      source: "data Equal a b = Refl : Equal a a; let main : Equal Int Int = Refl;",
      ok: true,
    },
    {
      source:
        "data Witness a b = Witness : Witness a (b, b); let main : Witness Int (Bool, Bool) = Witness;",
      ok: true,
    },
    {
      source: "data Select a b = Keep(value: a) : Select a a; let main : Select Int Int = Keep 1;",
      ok: true,
    },
    {
      source: "data Equal a b = Refl : Equal a a; let main : Equal Int Bool = Refl;",
      ok: false,
      code: "L2102",
      message: "type mismatch: expected Bool, received Int",
    },
    {
      source: "data Equal a b = Refl : Bool; let main = 0;",
      ok: false,
      code: "L2101",
      message:
        'constructor "Refl" result must have head "Equal" with 2 arguments; received a boolean result',
    },
    {
      source: "data Equal a b = Refl : Equal a; let main = 0;",
      ok: false,
      code: "L2101",
      message: 'type "Equal" expects 2 arguments; received 1',
    },
    {
      source: "-- żółć\ndata Indexed a b = Mk(value: b) : Indexed a (b, b); let main = 0;",
      ok: true,
    },
    {
      source:
        "data Indexed a b = Mk(value: b) : Indexed a (b, b); let main : Indexed Int (Bool, Bool) = Mk true;",
      ok: true,
    },
    {
      source: "data Indexed a b = Mk(value: b) : Indexed a Int; let main = 0;",
      ok: false,
      code: "L2101",
      message: 'constructor "Mk" field parameter "b" does not occur in its result',
    },
  ] as const;

  for (const fixture of fixtures) {
    const expected = inferWithHostOracle(fixture.source);
    equal(expected.ok, fixture.ok);
    if (!expected.ok && !fixture.ok) {
      equal(expected.diagnostic.code, fixture.code);
      equal(expected.diagnostic.message, fixture.message);
      if ("span" in fixture) deepStrictEqual(expected.diagnostic.span, fixture.span);
    }
  }

  await withCompiler(async (compiler) => {
    for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex++) {
      const fixture = fixtures[fixtureIndex];
      if (fixture === undefined) throw new Error(`missing indexed constructor ${fixtureIndex}`);
      const dispatchQuanta = fixtureIndex === 0 || fixtureIndex === 7 ? [1, 7, 4_096] : [4_096];
      for (const maximumStepsPerDispatch of dispatchQuanta) {
        const snapshot = await compilerInferenceSnapshot(compiler, fixture.source, {
          maximumStepsPerDispatch,
        });
        equal(snapshot.ok, fixture.ok);
      }
    }
  });
});

Deno.test("indexed elimination infers safe results and scopes refinements on host and GPU", async () => {
  const successes = [
    {
      source:
        "data Equal a b = Refl : Equal a a; let cast : Equal a b -> a -> b = proof => value => case proof of | Refl -> value end; let main = cast Refl 42;",
      mainType: { kind: "integer" },
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; let trans : Equal a b -> Equal b c -> Equal a c = left => right => case left of | Refl -> case right of | Refl -> Refl end end; let main : Equal Int Int = trans Refl Refl;",
      mainType: {
        kind: "named",
        name: "Equal",
        arguments: [{ kind: "integer" }, { kind: "integer" }],
      },
    },
    {
      source:
        "data Tag a = TagInt : Tag Int | TagBool : Tag Bool; let untag : Tag a -> a = tag => case tag of | TagInt -> 1 | TagBool -> true end; let main = (untag TagInt, untag TagBool);",
      mainType: {
        kind: "tuple",
        values: [{ kind: "integer" }, { kind: "boolean" }],
      },
    },
    {
      source:
        "data Tag a = TagInt : Tag Int | TagBool : Tag Bool; let onlyInt : Tag Int -> Int = tag => case tag of | TagInt -> 1 end; let main = onlyInt TagInt;",
      mainType: { kind: "integer" },
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; let absurd : Equal Int Bool -> Int = proof => case proof of end; let main = 0;",
      mainType: { kind: "integer" },
    },
    {
      source:
        "data Swap a b = Swapped(first: a, second: b) : Swap b a; let restore : Swap a b -> (b, a) = value => case value of | Swapped(first, second) -> (first, second) end; let main = restore (Swapped true 1);",
      mainType: {
        kind: "tuple",
        values: [{ kind: "boolean" }, { kind: "integer" }],
      },
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; let add : Equal a Int -> a -> Int = proof => value => (case proof of | Refl -> value end) + 1; let main = add Refl 41;",
      mainType: { kind: "integer" },
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; let choose : Equal a Bool -> a -> Bool = proof => value => if case proof of | Refl -> value end then true else false; let main = choose Refl true;",
      mainType: { kind: "boolean" },
    },
    {
      source:
        "data Flag a = Any | IsInt : Flag Int; let onlyAny : Flag Bool -> Int = flag => case flag of | Any -> 1 end; let main = onlyAny Any;",
      mainType: { kind: "integer" },
    },
    {
      source: "data Equal a b = Refl : Equal a a; let main = case Refl of | Refl -> 42 end;",
      mainType: { kind: "integer" },
    },
    {
      source:
        "data Tag a = TagInt : Tag Int | TagBool : Tag Bool; let classify = tag => case tag of | TagInt -> 1 | TagBool -> 0 end; let main = (classify TagInt, classify TagBool);",
      mainType: {
        kind: "tuple",
        values: [{ kind: "integer" }, { kind: "integer" }],
      },
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; let loop : Equal a b -> a -> b = proof => value => if true then case proof of | Refl -> value end else loop proof value; let main = loop Refl 42;",
      mainType: { kind: "integer" },
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; fn loop proof = if true then case proof of | Refl -> loop proof end else 0; let main = loop Refl;",
      mainType: { kind: "integer" },
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; let main = let rec loop proof = case proof of | Refl -> loop proof end in 0;",
      mainType: { kind: "integer" },
    },
  ] as const;

  for (const fixture of successes) {
    const result = inferWithHostOracle(fixture.source);
    ok(result.ok, result.ok ? undefined : result.diagnostic.message);
    if (result.ok) deepStrictEqual(result.mainType, fixture.mainType);
  }

  await withCompiler(async (compiler) => {
    for (let fixtureIndex = 0; fixtureIndex < successes.length; fixtureIndex++) {
      const fixture = successes[fixtureIndex];
      if (fixture === undefined) throw new Error(`missing indexed success ${fixtureIndex}`);
      const dispatchQuanta = fixtureIndex === 0 ? [1, 7, 4_096] : [4_096];
      for (const maximumStepsPerDispatch of dispatchQuanta) {
        const snapshot = await compilerInferenceSnapshot(compiler, fixture.source, {
          maximumStepsPerDispatch,
        });
        equal(snapshot.ok, true);
      }
    }
  });
});

Deno.test("indexed elimination rejects unsound or inaccessible arms on host and GPU", async () => {
  const failures = [
    {
      source:
        "-- żółć\ndata Tag a = TagInt : Tag Int | TagBool : Tag Bool; let bad : Tag Int -> Int = tag => case tag of | TagInt -> 1 | TagBool -> 0 end; let main = 0;",
      code: "L2102",
      message:
        'constructor "TagBool" is inaccessible: result Tag[Bool] is incompatible with scrutinee Tag[Int]',
      span: { startByte: 124, endByte: 139 },
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; let bad : Equal Int Bool -> Int = proof => case proof of | Refl -> 0 end; let main = 0;",
      code: "L2102",
      message:
        'constructor "Refl" is inaccessible: result Equal[a, a] is incompatible with scrutinee Equal[Int, Bool]',
    },
    {
      source:
        "data Tag a = TagInt : Tag Int | TagBool : Tag Bool; let untag = tag => case tag of | TagInt -> 1 | TagBool -> true end; let main = 0;",
      code: "L2102",
      message: "type mismatch: expected Int, received Bool",
    },
    {
      source:
        "data Tag a = TagInt : Tag Int | TagBool : Tag Bool; let bad : Tag a -> a = tag => case tag of | TagInt -> true | TagBool -> true end; let main = 0;",
      code: "L2102",
      message: "type mismatch: expected Int, received Bool",
    },
    {
      source:
        "data Equal a b = Refl : Equal a a; let bad : Int = case (value => value) of | Refl -> 0 end; let main = 0;",
      code: "L2101",
      message: 'indexed case requires scrutinee "Equal"; received a -> a',
    },
    {
      source:
        "data Choice a = First : Choice Int | Second : Choice Int; let bad : Choice Int -> Int = value => case value of | First -> 1 end; let main = 0;",
      code: "L2010",
      message: 'non-exhaustive case; missing constructor "Second"',
    },
    {
      source:
        "data Tag a = TagInt : Tag Int | TagBool : Tag Bool; fn left tag = right tag; let right : Tag a -> a = tag => case tag of | TagInt -> left tag | TagBool -> left tag end; let main = 0;",
      code: "L2101",
      message: "indexed case arm cannot solve pre-existing inference variable",
    },
  ] as const;

  for (const fixture of failures) {
    const result = inferWithHostOracle(fixture.source);
    equal(result.ok, false);
    if (result.ok) continue;
    equal(result.diagnostic.code, fixture.code);
    ok(
      result.diagnostic.message.startsWith(fixture.message),
      `${result.diagnostic.message} did not start with ${fixture.message}`,
    );
    if ("span" in fixture) deepStrictEqual(result.diagnostic.span, fixture.span);
  }

  await withCompiler(async (compiler) => {
    for (let fixtureIndex = 0; fixtureIndex < failures.length; fixtureIndex++) {
      const fixture = failures[fixtureIndex];
      if (fixture === undefined) throw new Error(`missing indexed failure ${fixtureIndex}`);
      const dispatchQuanta = fixtureIndex === 1 ? [1, 7, 4_096] : [4_096];
      for (const maximumStepsPerDispatch of dispatchQuanta) {
        const snapshot = await compilerInferenceSnapshot(compiler, fixture.source, {
          maximumStepsPerDispatch,
        });
        equal(snapshot.ok, false);
      }
    }
  });
});

Deno.test("zero-arm elimination from an empty named type matches the host oracle", async () => {
  const source =
    "data False a = ; let main : False Int -> (Int, Bool) = impossible => case impossible of end;";
  const expected = inferWithHostOracle(source);
  ok(expected.ok);
  if (!expected.ok) return;
  deepStrictEqual(expected.mainType, {
    kind: "function",
    parameter: {
      kind: "named",
      name: "False",
      arguments: [{ kind: "integer" }],
    },
    result: {
      kind: "tuple",
      values: [{ kind: "integer" }, { kind: "boolean" }],
    },
  });

  await withCompiler(async (compiler) => {
    for (const maximumStepsPerDispatch of [1, 7, 4_096]) {
      const snapshot = await compilerInferenceSnapshot(compiler, source, {
        maximumStepsPerDispatch,
      });
      ok(snapshot.ok);
    }
  });
});

Deno.test("zero-arm cases reject inhabited and unknown scrutinee types with host-GPU parity", async () => {
  const cases = [
    {
      source: "data Maybe = Nothing | Just; let main = case Nothing of end;",
      code: "L2010",
      message: 'non-exhaustive case; missing constructor "Nothing"',
    },
    {
      source: "let main : Int -> Int = value => case value of end;",
      code: "L2101",
      message: "empty case requires a zero-constructor named type; received Int",
    },
    {
      source: "let main = value => case value of end;",
      code: "L2101",
      message: "empty case requires a zero-constructor named type; received 'a",
    },
  ] as const;

  await withCompiler(async (compiler) => {
    for (const fixture of cases) {
      const expected = inferWithHostOracle(fixture.source);
      equal(expected.ok, false);
      if (expected.ok) continue;
      equal(expected.diagnostic.code, fixture.code);
      equal(expected.diagnostic.message, fixture.message);
      for (const maximumStepsPerDispatch of [1, 7, 4_096]) {
        const snapshot = await compilerInferenceSnapshot(compiler, fixture.source, {
          maximumStepsPerDispatch,
        });
        equal(snapshot.ok, false);
      }
    }
  });
});

Deno.test("representative inference corpus is dispatch-quantum invariant", async () => {
  equal(representativeCorpus.length, 16);

  await withCompiler(async (compiler) => {
    const snapshotsByQuantum: InferenceSnapshot[][] = [];
    for (const maximumStepsPerDispatch of [1, 7, 4_096]) {
      snapshotsByQuantum.push(
        await Promise.all(
          representativeCorpus.map((program) =>
            compilerInferenceSnapshot(compiler, program.source, { maximumStepsPerDispatch })
          ),
        ),
      );
    }
    for (let programIndex = 0; programIndex < representativeCorpus.length; programIndex++) {
      const program = representativeCorpus[programIndex];
      if (program === undefined) throw new Error(`missing representative program ${programIndex}`);
      const oneStep = snapshotsByQuantum[0]?.[programIndex];
      const sevenSteps = snapshotsByQuantum[1]?.[programIndex];
      const largeDispatch = snapshotsByQuantum[2]?.[programIndex];
      ok(oneStep !== undefined && sevenSteps !== undefined && largeDispatch !== undefined);
      deepStrictEqual(oneStep, sevenSteps, `${program.name} at one and seven transitions`);
      deepStrictEqual(sevenSteps, largeDispatch, `${program.name} at seven and 4096 transitions`);
    }
  });
});

async function completesWithFuel(
  compiler: GpuLazuliCompiler,
  source: string,
  maximumSteps: number,
  maximumStepsPerDispatch = 7,
): Promise<boolean> {
  const compilation = await compiler.compile(source, {
    maximumSteps,
    maximumStepsPerDispatch,
  });
  if (!compilation.ok) {
    equal(compilation.diagnostics[0].code, "L1003");
    return false;
  }
  compilation.module.destroy();
  return true;
}

async function exactFuelThreshold(
  compiler: GpuLazuliCompiler,
  source: string,
): Promise<number> {
  let exhaustedSteps = 0;
  let completingSteps = 1;
  while (!(await completesWithFuel(compiler, source, completingSteps))) {
    exhaustedSteps = completingSteps;
    completingSteps *= 2;
  }

  while (completingSteps - exhaustedSteps > 1) {
    const candidate = Math.floor((exhaustedSteps + completingSteps) / 2);
    if (await completesWithFuel(compiler, source, candidate)) {
      completingSteps = candidate;
    } else {
      exhaustedSteps = candidate;
    }
  }
  return completingSteps;
}

Deno.test("GPU type inference completes exactly at its derived compiler fuel threshold", async () => {
  await withCompiler(async (compiler) => {
    const source = successfulCorpus[1]?.source;
    if (source === undefined) throw new Error("missing recursive corpus program");
    const threshold = await exactFuelThreshold(compiler, source);
    ok(threshold > 1, "recursive inference must require more than one transition");

    for (const maximumStepsPerDispatch of [1, 7, 4_096]) {
      equal(
        await completesWithFuel(
          compiler,
          source,
          threshold - 1,
          maximumStepsPerDispatch,
        ),
        false,
      );
      await compilerInferenceSnapshot(compiler, source, {
        maximumSteps: threshold,
        maximumStepsPerDispatch,
      });
    }

    const insufficientBatch = await compiler.compileBatch([source, source], {
      maximumSteps: threshold - 1,
      maximumStepsPerDispatch: 4_096,
    });
    equal(insufficientBatch.length, 2);
    for (const compilation of insufficientBatch) {
      equal(compilation.ok, false);
      if (!compilation.ok) equal(compilation.diagnostics[0].code, "L1003");
    }
    const exactBatch = await compiler.compileBatch([source, source], {
      maximumSteps: threshold,
      maximumStepsPerDispatch: 4_096,
    });
    ok(exactBatch.every((compilation) => compilation.ok));
    for (const compilation of exactBatch) if (compilation.ok) compilation.module.destroy();
  });
});

Deno.test("semantic diagnostics take precedence over speculative type inference", async () => {
  await withCompiler(async (compiler) => {
    const source = "let main : Bool = absent;";
    for (const maximumStepsPerDispatch of [1, 7, 4_096]) {
      const compilation = await compiler.compile(source, { maximumStepsPerDispatch });
      if (compilation.ok) {
        compilation.module.destroy();
        throw new Error("unreachable");
      }
      equal(compilation.ok, false);
      equal(compilation.diagnostics[0].code, "L2001");
      equal(compilation.diagnostics[0].message, 'unknown name "absent"');
    }

    const repeatedIndexedArm = await compiler.compile(
      "data Equal a b = Refl : Equal a a; let bad : Equal Int Int -> Int = proof => case proof of | Refl -> 0 | Refl -> true end; let main = 0;",
      { maximumStepsPerDispatch: 4_096 },
    );
    equal(repeatedIndexedArm.ok, false);
    if (!repeatedIndexedArm.ok) {
      equal(repeatedIndexedArm.diagnostics[0].code, "L2009");
      equal(
        repeatedIndexedArm.diagnostics[0].message,
        'duplicate case arm for constructor "Refl"',
      );
    }
  });
});
