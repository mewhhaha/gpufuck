import { deepStrictEqual, equal, ok, strictEqual } from "node:assert/strict";
import { lowerGleamSource, ParallelGleamFrontend } from "../gleam.ts";

const program = (index: number) =>
  `pub type Option(a) {
  None
  Some(a)
}

fn map(option, transform) {
  case option {
    None -> None
    Some(value) -> Some(transform(value))
  }
}

pub fn main() -> Int {
  case map(Some(${index % 41 + 1}), fn(value) { value * 2 }) {
    None -> 0
    Some(value) -> value
  }
}
`;

/**
 * The pool must agree with the single-threaded frontend byte for byte on the packed surface, or
 * a batch compiled through it is not the same program.
 */
Deno.test("parallel Gleam frontend packs the same surface as the serial frontend", async () => {
  const pool = ParallelGleamFrontend.create(3);
  try {
    // Above MINIMUM_PARALLEL_UNITS, so this exercises the worker path rather than the fallback.
    const units = Array.from({ length: 24 }, (_, index) => ({
      name: "p",
      source: program(index),
    }));
    const parallel = await pool.lower(units);
    equal(parallel.length, units.length);

    for (const [index, result] of parallel.entries()) {
      ok(result.ok, result.ok ? undefined : result.diagnostic);
      if (!result.ok) continue;
      const serial = lowerGleamSource(units[index]!.name, units[index]!.source);
      ok(serial.ok, serial.ok ? undefined : serial.diagnostics[0].message);
      if (!serial.ok) continue;
      equal(result.module.nodeCount, serial.lowered.module.nodeCount);
      equal(result.module.entrySymbol, serial.lowered.module.entrySymbol);
      deepStrictEqual(result.module.nodeWords, serial.lowered.module.nodeWords);
      deepStrictEqual(result.module.definitionWords, serial.lowered.module.definitionWords);
      deepStrictEqual(result.module.symbolNames, serial.lowered.module.symbolNames);
      deepStrictEqual(
        result.module.declaredDefinitionEffects.map((effects) => [...effects]),
        serial.lowered.module.declaredDefinitionEffects.map((effects) => [...effects]),
      );
    }
  } finally {
    pool.terminate();
  }
});

/** Below the threshold the pool runs inline; the results must be indistinguishable. */
Deno.test("parallel Gleam frontend falls back inline for small batches", async () => {
  const pool = ParallelGleamFrontend.create(3);
  try {
    const results = await pool.lower([{ name: "p", source: program(0) }]);
    equal(results.length, 1);
    ok(results[0]!.ok);
  } finally {
    pool.terminate();
  }
});

Deno.test("parallel Gleam frontend reuses unchanged units", async () => {
  const pool = ParallelGleamFrontend.create(2);
  try {
    const units = [{ name: "p", source: program(0) }];
    const first = await pool.lower(units);
    const second = await pool.lower(units);
    ok(first[0]?.ok);
    ok(second[0]?.ok);
    if (!first[0]?.ok || !second[0]?.ok) return;
    strictEqual(second[0].module, first[0].module);
  } finally {
    pool.terminate();
  }
});

/** Unbound names are resolved on the GPU, so the failing unit here has to be a syntax error. */
Deno.test("parallel Gleam frontend reports a diagnostic per failing unit", async () => {
  const pool = ParallelGleamFrontend.create(2);
  try {
    const units = Array.from({ length: 20 }, (_, index) => ({
      name: "p",
      source: index === 7 ? "pub fn main() -> Int { case { } }\n" : program(index),
    }));
    const results = await pool.lower(units);
    equal(results.length, 20);
    ok(!results[7]!.ok, "the malformed unit should fail");
    // A failure in one unit must not take its neighbours with it.
    ok(results[6]!.ok);
    ok(results[8]!.ok);
  } finally {
    pool.terminate();
  }
});
