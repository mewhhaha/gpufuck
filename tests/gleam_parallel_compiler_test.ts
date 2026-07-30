import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";

import { compileModuleToWasm, CpuCompiler } from "../functional.ts";
import { lowerGleamSource, ParallelGleamCompiler, type ParallelGleamUnit } from "../gleam.ts";

const units: readonly ParallelGleamUnit[] = Array.from({ length: 24 }, (_, index) => ({
  name: `parallel_${index}`,
  source: `pub fn main() -> Int { ${index} * 2 }\n`,
}));

Deno.test("parallel Gleam compiler preserves serial Wasm in input order", async () => {
  const compiler = ParallelGleamCompiler.create(4);
  const cpuCompiler = new CpuCompiler();
  try {
    const parallel = await compiler.compile(units);
    for (const [index, result] of parallel.entries()) {
      ok(result.ok, result.ok ? undefined : result.diagnostics[0]?.message);
      if (!result.ok) continue;
      const frontend = lowerGleamSource(units[index]!.name, units[index]!.source);
      if (!frontend.ok) throw new Error(frontend.diagnostics[0].message);
      const compiled = await cpuCompiler.compileModule(frontend.lowered.module);
      if (!compiled.ok) throw new Error(compiled.diagnostics[0].message);
      try {
        deepStrictEqual(result.bytes, await compileModuleToWasm(compiled.module));
      } finally {
        compiled.module.destroy();
      }
    }
  } finally {
    compiler.terminate();
  }
});

Deno.test("parallel Gleam compiler isolates failures and reuses unchanged outputs", async () => {
  const compiler = ParallelGleamCompiler.create(3);
  try {
    const malformed = units.map((unit, index) =>
      index === 7 ? { ...unit, source: "pub fn main() -> Int { case { } }\n" } : unit
    );
    const first = await compiler.compile(malformed);
    ok(!first[7]!.ok);
    ok(first[6]!.ok);
    ok(first[8]!.ok);

    const second = await compiler.compile(malformed);
    strictEqual(second[0], first[0]);
    strictEqual(second[7], first[7]);
  } finally {
    compiler.terminate();
  }
});
