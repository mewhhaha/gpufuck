import { deepStrictEqual, equal, ok } from "node:assert/strict";

import { GpuLazuliCompiler, requestWebGpuDevice } from "../mod.ts";
import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import { inferLazuliTypes } from "../src/lazuli/type_inference.ts";

interface CorpusProgram {
  readonly name: string;
  readonly source: string;
}

function sourcePrefix(index: number): string {
  return index % 8 === 0 ? `-- UTF-8 corpus prefix é ${index}\n` : "";
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

const singleFaultCorpus = Array.from({ length: 64 }, (_, index) => singleFaultSource(index));

Deno.test("GPU diagnostics match the host oracle for the 64-program single-fault corpus", async () => {
  equal(singleFaultCorpus.length, 64);

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuLazuliCompiler.create(device);
    for (const program of singleFaultCorpus) {
      const parsing = parseLazuliSource(program.source);
      ok(parsing.ok, `expected ${program.name} to parse`);
      if (!parsing.ok) throw new Error("unreachable");

      const expected = inferLazuliTypes(parsing.surface);
      ok(!expected.ok, `expected host inference to reject ${program.name}`);
      if (expected.ok) throw new Error("unreachable");

      const compilation = await compiler.compile(program.source);
      if (compilation.ok) {
        compilation.module.destroy();
        throw new Error(`expected GPU inference to reject ${program.name}`);
      }
      deepStrictEqual(compilation.diagnostics, [expected.diagnostic], program.name);
    }
  } finally {
    device.destroy();
  }
});
