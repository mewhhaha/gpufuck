import { deepStrictEqual, equal, ok } from "node:assert/strict";

import {
  GpuLazuliCompiler,
  type LazuliCompilationOptions,
  type LazuliDiagnostic,
  type LazuliType,
  type LazuliTypeDeclaration,
  requestWebGpuDevice,
} from "../mod.ts";
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

Deno.test("representative inference corpus is dispatch-quantum invariant", async () => {
  equal(representativeCorpus.length, 16);

  await withCompiler(async (compiler) => {
    for (const program of representativeCorpus) {
      const oneStep = await compilerInferenceSnapshot(compiler, program.source, {
        maximumStepsPerDispatch: 1,
      });
      const sevenSteps = await compilerInferenceSnapshot(compiler, program.source, {
        maximumStepsPerDispatch: 7,
      });
      const largeDispatch = await compilerInferenceSnapshot(compiler, program.source, {
        maximumStepsPerDispatch: 4_096,
      });

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
  });
});
