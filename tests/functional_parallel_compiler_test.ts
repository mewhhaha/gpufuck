import { deepStrictEqual, equal, ok } from "node:assert/strict";

import {
  buildSurfaceModule,
  compileModulesToWasm,
  compileModuleToWasm,
  CpuCompiler,
  ParallelFunctionalCompilerService,
  surface,
} from "../functional.ts";

const modules = Array.from({ length: 24 }, (_, index) =>
  buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.integer(index),
    }],
    [],
    "main",
    0,
  ));

Deno.test("parallel functional compiler preserves Core order and contents", async () => {
  const parallelCompiler = ParallelFunctionalCompilerService.create(3);
  try {
    const parallel = await parallelCompiler.compileBatch(modules);
    const serial = await new CpuCompiler().compileBatch(modules);
    equal(parallel.length, modules.length);
    for (const [index, parallelResult] of parallel.entries()) {
      const serialResult = serial[index]!;
      ok(parallelResult.ok, parallelResult.ok ? undefined : parallelResult.diagnostics[0].message);
      ok(serialResult.ok, serialResult.ok ? undefined : serialResult.diagnostics[0].message);
      if (!parallelResult.ok || !serialResult.ok) continue;
      deepStrictEqual(
        await parallelResult.module.readCoreNodes(),
        await serialResult.module.readCoreNodes(),
      );
      deepStrictEqual(parallelResult.module.entryType, serialResult.module.entryType);
      parallelResult.module.destroy();
      serialResult.module.destroy();
    }
  } finally {
    parallelCompiler.terminate();
  }
});

Deno.test("parallel functional compiler assembles one deterministic shared Wasm artifact", async () => {
  const parallelCompiler = ParallelFunctionalCompilerService.create(4);
  const serialCompiler = new CpuCompiler();
  try {
    const parallel = await parallelCompiler.compileBatchToSharedWasm(modules);
    ok(parallel.ok, parallel.ok ? undefined : parallel.failures[0]?.diagnostics[0].message);
    if (!parallel.ok) return;

    const serialResults = await serialCompiler.compileBatch(modules);
    const serialModules = serialResults.map((result) => {
      if (!result.ok) throw new Error(result.diagnostics[0].message);
      return result.module;
    });
    try {
      const serial = await compileModulesToWasm(serialModules);
      deepStrictEqual(parallel.artifact.bytes, serial.bytes);
      deepStrictEqual(parallel.artifact.exports, serial.exports);
      const parallelArtifacts = await parallelCompiler.emitWasmBatch(serialModules);
      for (const [index, bytes] of parallelArtifacts.entries()) {
        deepStrictEqual(bytes, await compileModuleToWasm(serialModules[index]!));
      }
    } finally {
      for (const module of serialModules) module.destroy();
    }
  } finally {
    parallelCompiler.terminate();
  }
});

Deno.test("parallel functional compiler emits deterministic Wasm in input order", async () => {
  const parallelCompiler = ParallelFunctionalCompilerService.create(4);
  try {
    const parallel = await parallelCompiler.compileBatchToWasm(modules);
    const compiler = new CpuCompiler();
    for (const [index, parallelResult] of parallel.entries()) {
      ok(parallelResult.ok, parallelResult.ok ? undefined : parallelResult.diagnostics[0].message);
      if (!parallelResult.ok) continue;
      const serial = await compiler.compileModule(modules[index]!);
      ok(serial.ok, serial.ok ? undefined : serial.diagnostics[0].message);
      if (!serial.ok) continue;
      try {
        deepStrictEqual(parallelResult.bytes, await compileModuleToWasm(serial.module));
      } finally {
        serial.module.destroy();
      }
    }
  } finally {
    parallelCompiler.terminate();
  }
});
