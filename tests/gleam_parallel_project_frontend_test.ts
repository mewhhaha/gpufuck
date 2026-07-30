import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";

import { CpuCompiler } from "../functional.ts";
import {
  type GleamSourceModule,
  lowerGleamSources,
  ParallelGleamProjectFrontend,
} from "../gleam.ts";

const sources: readonly GleamSourceModule[] = [
  {
    name: "project/base",
    source: `
pub fn increment(value) {
  value + 1
}
`,
  },
  {
    name: "project/double",
    source: `
import project/base

pub fn double_increment(value) {
  base.increment(base.increment(value))
}
`,
  },
  {
    name: "project/offset",
    source: `
pub const offset = 40
`,
  },
  {
    name: "project/main",
    source: `
import project/double
import project/offset

pub fn main() -> Int {
  double.double_increment(offset.offset)
}
`,
  },
];

Deno.test("parallel Gleam project frontend preserves linked surface semantics", async () => {
  const frontend = ParallelGleamProjectFrontend.create(3);
  try {
    const entry = { module: "project/main", exportName: "main" };
    const parallel = await frontend.lower(sources, entry);
    const serial = lowerGleamSources(sources, entry);
    ok(parallel.ok, parallel.ok ? undefined : parallel.diagnostics[0].message);
    ok(serial.ok, serial.ok ? undefined : serial.diagnostics[0].message);
    if (!parallel.ok || !serial.ok) return;

    deepStrictEqual(parallel.lowered.module.nodeWords, serial.lowered.module.nodeWords);
    deepStrictEqual(parallel.lowered.module.definitionWords, serial.lowered.module.definitionWords);
    deepStrictEqual(parallel.lowered.module.symbolNames, serial.lowered.module.symbolNames);

    const compiled = await new CpuCompiler().compileModule(parallel.lowered.module);
    ok(compiled.ok, compiled.ok ? undefined : compiled.diagnostics[0].message);
    if (compiled.ok) compiled.module.destroy();
  } finally {
    frontend.terminate();
  }
});

Deno.test("parallel Gleam project frontend reuses an unchanged linked project", async () => {
  const frontend = ParallelGleamProjectFrontend.create(2);
  try {
    const entry = { module: "project/main", exportName: "main" };
    const first = await frontend.lower(sources, entry);
    const second = await frontend.lower(sources, entry);
    ok(first.ok);
    ok(second.ok);
    if (!first.ok || !second.ok) return;
    strictEqual(second, first);
  } finally {
    frontend.terminate();
  }
});
