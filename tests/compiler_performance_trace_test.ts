import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";

import {
  compileModuleToWasm,
  CompilerPerformanceTrace,
  CpuCompiler,
  renderCompilerPerformanceTrace,
  summarizeCompilerPerformance,
} from "../functional.ts";
import { lowerGleamSources } from "../gleam.ts";

Deno.test("compiler performance trace records nested stages and work annotations", () => {
  const ticks = [100, 105, 112, 118, 125];
  const trace = new CompilerPerformanceTrace(() => ticks.shift()!);
  const outerAnnotations = { units: 2, result: 0 };

  const result = trace.measure(
    "outer",
    outerAnnotations,
    () => trace.measure("inner", { nodes: 7 }, () => 21),
    (value) => {
      outerAnnotations.result = value;
    },
  );

  equal(result, 21);
  deepStrictEqual(trace.snapshot(), [
    {
      stage: "outer",
      startMilliseconds: 5,
      durationMilliseconds: 20,
      annotations: { units: 2, result: 21 },
    },
    {
      stage: "inner",
      startMilliseconds: 12,
      durationMilliseconds: 6,
      annotations: { nodes: 7 },
    },
  ]);
  deepStrictEqual(summarizeCompilerPerformance(trace.snapshot()), [
    {
      stage: "outer",
      calls: 1,
      totalMilliseconds: 20,
      maximumMilliseconds: 20,
    },
    {
      stage: "inner",
      calls: 1,
      totalMilliseconds: 6,
      maximumMilliseconds: 6,
    },
  ]);

  const chromeTrace = JSON.parse(renderCompilerPerformanceTrace(trace.snapshot()));
  deepStrictEqual(chromeTrace.traceEvents[0], {
    name: "outer",
    cat: "compiler",
    ph: "X",
    ts: 5_000,
    dur: 20_000,
    pid: 1,
    tid: 1,
    args: { units: 2, result: 21 },
  });
});

Deno.test("compiler performance trace records a phase before rethrowing its failure", () => {
  const ticks = [0, 1, 2];
  const trace = new CompilerPerformanceTrace(() => ticks.shift()!);

  throws(
    () =>
      trace.measure("semantic.solve", { components: 4 }, () => {
        throw new Error("inference failed");
      }),
    /inference failed/,
  );
  deepStrictEqual(trace.snapshot(), [{
    stage: "semantic.solve",
    startMilliseconds: 1,
    durationMilliseconds: 1,
    annotations: { components: 4, failed: true },
  }]);
});

Deno.test("performance tracing preserves Gleam Core and Wasm output", async () => {
  const sources = [{
    name: "main",
    source: "pub fn twice(value: Int) -> Int { value * 2 }\npub fn main() -> Int { twice(21) }\n",
  }];
  const entry = { module: "main", exportName: "main" };
  const trace = new CompilerPerformanceTrace();
  const tracedFrontend = lowerGleamSources(sources, entry, { trace });
  const plainFrontend = lowerGleamSources(sources, entry);
  ok(tracedFrontend.ok);
  ok(plainFrontend.ok);
  if (!tracedFrontend.ok || !plainFrontend.ok) return;
  deepStrictEqual(tracedFrontend.lowered.module.nodeWords, plainFrontend.lowered.module.nodeWords);

  const compiler = new CpuCompiler();
  const tracedCompilation = await compiler.compileModule(
    tracedFrontend.lowered.module,
    { trace },
  );
  const plainCompilation = await compiler.compileModule(plainFrontend.lowered.module);
  ok(tracedCompilation.ok);
  ok(plainCompilation.ok);
  if (!tracedCompilation.ok || !plainCompilation.ok) return;

  const tracedNodes = await tracedCompilation.module.readCoreNodes();
  const plainNodes = await plainCompilation.module.readCoreNodes();
  deepStrictEqual(tracedNodes, plainNodes);
  const tracedWasm = await compileModuleToWasm(tracedCompilation.module, { trace });
  const plainWasm = await compileModuleToWasm(plainCompilation.module);
  deepStrictEqual(tracedWasm, plainWasm);

  const stages = new Set(trace.snapshot().map((event) => event.stage));
  for (
    const stage of [
      "frontend.parse",
      "frontend.parse.syntax",
      "frontend.parse.materialize",
      "frontend.lower",
      "frontend.link",
      "semantic.symbol-index",
      "semantic.inference.graph",
      "semantic.inference.solve",
      "semantic.effects",
      "wasm.plan.storage",
      "wasm.emit",
      "wasm.encode",
    ]
  ) {
    ok(stages.has(stage), `trace omitted ${stage}`);
  }
  const link = trace.snapshot().find((event) => event.stage === "frontend.link");
  equal(link?.annotations.nodes, tracedFrontend.lowered.module.nodeCount);
  const emitted = trace.snapshot().find((event) => event.stage === "wasm.emit");
  equal(emitted?.annotations.bytes, tracedWasm.byteLength);
  const coreIndex = trace.snapshot().find((event) => event.stage === "wasm.plan.index-core");
  equal(coreIndex?.annotations.directOnlyDefinitions, 1);

  const gcTrace = new CompilerPerformanceTrace();
  const tracedWasmGc = await compileModuleToWasm(tracedCompilation.module, {
    backend: "wasm-gc",
    trace: gcTrace,
  });
  const plainWasmGc = await compileModuleToWasm(plainCompilation.module, {
    backend: "wasm-gc",
  });
  deepStrictEqual(tracedWasmGc, plainWasmGc);
  ok(gcTrace.snapshot().some((event) => event.stage === "wasm.gc.emit"));

  tracedCompilation.module.destroy();
  plainCompilation.module.destroy();
});
