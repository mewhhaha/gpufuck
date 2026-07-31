import {
  deepStrictEqual,
  equal,
  notDeepStrictEqual,
  ok,
  rejects,
  throws,
} from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  compileModuleToWasm,
  CompilerPerformanceTrace,
  CpuCompiler,
  defineEffectOperation,
  effectSet,
  FunctionalCompilerService,
  renderCompilerPerformanceTrace,
  runWasmModule,
  summarizeCompilerPerformance,
  surface,
  WASM_PROVEN_STORE_READS_TRACE_ANNOTATION,
  WASM_STATIC_ANALYSIS_TRACE_STAGE,
  WASM_STORE_READS_TRACE_ANNOTATION,
} from "../functional.ts";
import { compileWasmArtifact } from "../src/functional/wasm_codegen.ts";
import { GleamFrontendService, lowerGleamSources } from "../gleam.ts";

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

Deno.test("compiler performance trace counts Store reads with discharged bounds checks", async () => {
  const store = "values";
  const encoded = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.let(
        store,
        surface.storeNew(surface.integer(2), surface.integer(42)),
        surface.if(
          surface.binary(
            BinaryOperator.Equal,
            surface.storeLength(surface.name(store)),
            surface.integer(2),
          ),
          surface.storeRead(surface.name(store), surface.integer(1)),
          surface.runtimeFault("unexpected Store length"),
        ),
      ),
    }],
    [],
    "main",
    0,
  );
  const compilation = await new CpuCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const trace = new CompilerPerformanceTrace();
    await compileModuleToWasm(compilation.module, { trace });
    const analysis = trace.snapshot().find((event) =>
      event.stage === WASM_STATIC_ANALYSIS_TRACE_STAGE
    );
    equal(analysis?.annotations[WASM_STORE_READS_TRACE_ANNOTATION], 1);
    equal(analysis?.annotations[WASM_PROVEN_STORE_READS_TRACE_ANNOTATION], 1);
    const execution = await runWasmModule(compilation.module);
    equal(execution.value.kind, "integer");
    equal(execution.value.kind === "integer" ? execution.value.value : undefined, 42);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("Store bounds facts do not cross between stores", async () => {
  const shortStore = "short";
  const longStore = "long";
  const encoded = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.let(
        shortStore,
        surface.storeNew(surface.integer(1), surface.integer(42)),
        surface.let(
          longStore,
          surface.storeNew(surface.integer(2), surface.integer(42)),
          surface.if(
            surface.binary(
              BinaryOperator.Less,
              surface.integer(1),
              surface.storeLength(surface.name(longStore)),
            ),
            surface.storeRead(surface.name(shortStore), surface.integer(1)),
            surface.integer(0),
          ),
        ),
      ),
    }],
    [],
    "main",
    0,
  );
  const compilation = await new CpuCompiler().compileModule(encoded);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const trace = new CompilerPerformanceTrace();
    await compileModuleToWasm(compilation.module, { trace });
    const analysis = trace.snapshot().find((event) =>
      event.stage === WASM_STATIC_ANALYSIS_TRACE_STAGE
    );
    equal(analysis?.annotations[WASM_STORE_READS_TRACE_ANNOTATION], 1);
    equal(analysis?.annotations[WASM_PROVEN_STORE_READS_TRACE_ANNOTATION], 0);
    await rejects(
      () => runWasmModule(compilation.module),
      /invalid buffer or store bound/,
    );
  } finally {
    compilation.module.destroy();
  }
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
      "wasm.total",
      "wasm.artifact.module",
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
  const storage = trace.snapshot().find((event) => event.stage === "wasm.plan.storage");
  equal(storage?.annotations.skipped, true);
  equal(storage?.annotations.values, 0);

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

Deno.test("effect analysis prepares lambda flow for Wasm compilation", async () => {
  const integer = { kind: "integer" as const };
  const encoded = buildSurfaceModule(
    [
      defineEffectOperation({
        name: "tick",
        parameter: { name: "value", type: integer },
        result: integer,
        effects: effectSet("Clock.Tick"),
        body: surface.name("value"),
      }),
      {
        name: "main",
        parameters: [],
        annotation: integer,
        body: surface.apply(surface.name("tick"), surface.integer(42)),
      },
    ],
    [],
    "main",
    0,
  );
  const semanticTrace = new CompilerPerformanceTrace();
  const compilation = await new CpuCompiler().compileModule(encoded, { trace: semanticTrace });
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const semanticLowering = semanticTrace.snapshot().find((event) =>
      event.stage === "semantic.effects.lower-wasm-core"
    );
    equal(semanticLowering?.annotations.inputNodes, compilation.module.nodeCount);
    ok(Number(semanticLowering?.annotations.outputNodes) >= compilation.module.nodeCount);

    const wasmTrace = new CompilerPerformanceTrace();
    await compileModuleToWasm(compilation.module, { trace: wasmTrace });
    const wasmLowering = wasmTrace.snapshot().find((event) =>
      event.stage === "wasm.plan.lower-core"
    );
    equal(wasmLowering?.annotations.reused, true);
    equal(
      wasmTrace.snapshot().some((event) => event.stage === "wasm.emit.lambda-sets"),
      false,
    );
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("performance tracing reports compiler and Wasm cache hits", async () => {
  const frontend = lowerGleamSources(
    [{
      name: "cache_trace",
      source: "pub fn main() -> Int { 1_234_567 }\n",
    }],
    { module: "cache_trace", exportName: "main" },
  );
  ok(frontend.ok);
  if (!frontend.ok) return;

  const service = new FunctionalCompilerService({ backend: "cpu" });
  const coldSemanticTrace = new CompilerPerformanceTrace();
  const coldCompilation = await service.compileModule(frontend.lowered.module, {
    trace: coldSemanticTrace,
  });
  ok(coldCompilation.ok);
  if (!coldCompilation.ok) return;
  const coldCache = coldSemanticTrace.snapshot().find((event) =>
    event.stage === "semantic.service-cache"
  );
  equal(coldCache?.annotations.cacheHit, false);
  equal(coldCache?.annotations.cacheLevel, "none");
  ok(
    coldSemanticTrace.snapshot().some((event) => event.stage === "semantic.inference.solve"),
  );

  const warmSemanticTrace = new CompilerPerformanceTrace();
  const warmCompilation = await service.compileModule(frontend.lowered.module, {
    trace: warmSemanticTrace,
  });
  ok(warmCompilation.ok);
  if (!warmCompilation.ok) return;
  const warmCache = warmSemanticTrace.snapshot().find((event) =>
    event.stage === "semantic.service-cache"
  );
  equal(warmCache?.annotations.cacheHit, true);
  equal(warmCache?.annotations.cacheLevel, "module");
  equal(
    warmSemanticTrace.snapshot().some((event) => event.stage === "semantic.inference.solve"),
    false,
  );

  await compileModuleToWasm(coldCompilation.module, {
    trace: new CompilerPerformanceTrace(),
  });
  const editedFrontend = lowerGleamSources(
    [{
      name: "cache_trace",
      source: "pub fn main() -> Int { 1_234_567 }\n// source location changed\n",
    }],
    { module: "cache_trace", exportName: "main" },
  );
  ok(editedFrontend.ok);
  if (!editedFrontend.ok) return;
  const reboundSemanticTrace = new CompilerPerformanceTrace();
  const reboundCompilation = await service.compileModule(editedFrontend.lowered.module, {
    trace: reboundSemanticTrace,
  });
  ok(reboundCompilation.ok);
  if (!reboundCompilation.ok) return;
  const reboundCache = reboundSemanticTrace.snapshot().find((event) =>
    event.stage === "semantic.service-cache"
  );
  equal(reboundCache?.annotations.cacheHit, true);
  equal(reboundCache?.annotations.cacheLevel, "semantics");
  ok(
    reboundSemanticTrace.snapshot().some((event) => event.stage === "semantic.rebind-source"),
  );

  const reboundWasmTrace = new CompilerPerformanceTrace();
  await compileModuleToWasm(reboundCompilation.module, { trace: reboundWasmTrace });
  const reboundModuleCache = reboundWasmTrace.snapshot().find((event) =>
    event.stage === "wasm.artifact.module"
  );
  equal(reboundModuleCache?.annotations.cacheHit, false);
  const reboundCoreCache = reboundWasmTrace.snapshot().find((event) =>
    event.stage === "wasm.artifact.resolved-core"
  );
  equal(reboundCoreCache?.annotations.cacheHit, true);
  equal(
    reboundWasmTrace.snapshot().some((event) => event.stage === "wasm.emit"),
    false,
  );

  const warmWasmTrace = new CompilerPerformanceTrace();
  await compileModuleToWasm(coldCompilation.module, { trace: warmWasmTrace });
  const warmWasmCache = warmWasmTrace.snapshot().find((event) =>
    event.stage === "wasm.artifact.module"
  );
  equal(warmWasmCache?.annotations.cacheHit, true);
  equal(
    warmWasmTrace.snapshot().some((event) => event.stage === "wasm.emit"),
    false,
  );
  const wasmTotal = warmWasmTrace.snapshot().find((event) => event.stage === "wasm.total");
  equal(wasmTotal?.annotations.cacheEligible, true);

  coldCompilation.module.destroy();
  await service.destroy();
});

Deno.test("incremental project fingerprints recover prior compiled edits", async () => {
  const frontend = new GleamFrontendService();
  const compiler = new FunctionalCompilerService({ backend: "cpu" });
  const entry = { module: "main", exportName: "main" };
  const compile = async (value: number, trace?: CompilerPerformanceTrace) => {
    const lowered = frontend.lower(
      [{ name: "main", source: `pub fn main() -> Int { "λ" ${value} }\n` }],
      entry,
      trace === undefined ? {} : { trace },
    );
    if (!lowered.ok) throw new Error(lowered.diagnostics[0].message);
    const compilation = await compiler.compileModule(
      lowered.lowered.module,
      trace === undefined ? {} : { trace },
    );
    if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
    const wasm = await compileModuleToWasm(
      compilation.module,
      trace === undefined ? {} : { trace },
    );
    return { surface: lowered.lowered.module, module: compilation.module, wasm };
  };

  const first = await compile(63);
  const changedTrace = new CompilerPerformanceTrace();
  const second = await compile(64, changedTrace);
  const chainedTrace = new CompilerPerformanceTrace();
  const third = await compile(65, chainedTrace);
  const trace = new CompilerPerformanceTrace();
  const recovered = await compile(63, trace);

  const changedSemanticCache = changedTrace.snapshot().find((event) =>
    event.stage === "semantic.service-cache"
  );
  equal(changedSemanticCache?.annotations.cacheLevel, "literal-update");
  equal(
    changedTrace.snapshot().some((event) => event.stage === "semantic.inference.solve"),
    false,
  );
  const loweredUpdate = changedTrace.snapshot().find((event) =>
    event.stage === "frontend.lower.literal-update"
  );
  equal(loweredUpdate?.annotations.changedLiterals, 1);
  const parsedUpdate = changedTrace.snapshot().find((event) =>
    event.stage === "frontend.parse.materialize"
  );
  equal(parsedUpdate?.annotations.cacheHit, true);
  const signatureUpdate = changedTrace.snapshot().find((event) =>
    event.stage === "frontend.signatures.value"
  );
  equal(signatureUpdate?.annotations.cacheHit, true);
  const semanticFingerprint = changedTrace.snapshot().find((event) =>
    event.stage === "frontend.lower.semantic-fingerprint"
  );
  equal(semanticFingerprint?.annotations.incremental, true);
  const linkedUpdate = changedTrace.snapshot().find((event) =>
    event.stage === "frontend.link.literal-update"
  );
  equal(linkedUpdate?.annotations.changedNodes, 1);
  const incrementalArtifact = changedTrace.snapshot().find((event) =>
    event.stage === "wasm.artifact.resolved-core"
  );
  equal(incrementalArtifact?.annotations.incremental, true);
  equal(
    changedTrace.snapshot().some((event) => event.stage === "wasm.plan.index-core"),
    false,
  );
  const wasmPlanUpdate = changedTrace.snapshot().find((event) =>
    event.stage === "wasm.plan.literal-update"
  );
  equal(wasmPlanUpdate?.annotations.changedNodes, 1);
  const wasmEmissionUpdate = changedTrace.snapshot().find((event) =>
    event.stage === "wasm.emit.literal-update"
  );
  equal(wasmEmissionUpdate?.annotations.changedImmediates, 2);
  const wasmEncoding = changedTrace.snapshot().find((event) => event.stage === "wasm.encode");
  ok(Number(wasmEncoding?.annotations.reusedFunctionBodies) > 0);
  equal(wasmEncoding?.annotations.reusedSectionsBeforeCode, true);
  equal(
    changedTrace.snapshot().some((event) => event.stage === "wasm.emit.closures"),
    false,
  );
  notDeepStrictEqual(second.wasm, first.wasm);
  const fullyLowered = lowerGleamSources(
    [{ name: "main", source: 'pub fn main() -> Int { "λ" 64 }\n' }],
    entry,
  );
  if (!fullyLowered.ok) throw new Error(fullyLowered.diagnostics[0].message);
  deepStrictEqual(second.surface, fullyLowered.lowered.module);
  const fullArtifact = compileWasmArtifact(
    second.module,
    await second.module.readCoreNodes(),
  );
  deepStrictEqual(second.wasm, fullArtifact.bytes);
  const chainedFullArtifact = compileWasmArtifact(
    third.module,
    await third.module.readCoreNodes(),
  );
  deepStrictEqual(third.wasm, chainedFullArtifact.bytes);
  equal(
    chainedTrace.snapshot().some((event) => event.stage === "wasm.emit.literal-update"),
    true,
  );
  const execution = await runWasmModule(second.module);
  equal(execution.value.kind, "signed-integer-64");
  equal(execution.value.kind === "signed-integer-64" ? execution.value.value : undefined, 64n);

  const semanticCache = trace.snapshot().find((event) => event.stage === "semantic.service-cache");
  equal(semanticCache?.annotations.cacheHit, true);
  equal(semanticCache?.annotations.cacheLevel, "semantics");
  const coreCache = trace.snapshot().find((event) => event.stage === "wasm.artifact.resolved-core");
  equal(coreCache?.annotations.cacheHit, true);
  equal(trace.snapshot().some((event) => event.stage === "semantic.inference.solve"), false);
  equal(trace.snapshot().some((event) => event.stage === "wasm.emit"), false);
  deepStrictEqual(recovered.wasm, first.wasm);

  first.module.destroy();
  second.module.destroy();
  third.module.destroy();
  recovered.module.destroy();
  frontend.clear();
  await compiler.destroy();
});

Deno.test("incremental semantic reuse rejects structural expression edits", async () => {
  const frontend = new GleamFrontendService();
  const compiler = new FunctionalCompilerService({ backend: "cpu" });
  const entry = { module: "main", exportName: "main" };
  const first = frontend.lower(
    [{ name: "main", source: "pub fn main() -> Int { 41 + 1 }\n" }],
    entry,
  );
  if (!first.ok) throw new Error(first.diagnostics[0].message);
  const firstCompilation = await compiler.compileModule(first.lowered.module);
  if (!firstCompilation.ok) throw new Error(firstCompilation.diagnostics[0].message);

  const trace = new CompilerPerformanceTrace();
  const second = frontend.lower(
    [{ name: "main", source: "pub fn main() -> Int { 41 - 1 }\n" }],
    entry,
    { trace },
  );
  if (!second.ok) throw new Error(second.diagnostics[0].message);
  const secondCompilation = await compiler.compileModule(second.lowered.module, { trace });
  if (!secondCompilation.ok) throw new Error(secondCompilation.diagnostics[0].message);

  const semanticCache = trace.snapshot().find((event) => event.stage === "semantic.service-cache");
  equal(semanticCache?.annotations.cacheLevel, "none");
  const linkedUpdate = trace.snapshot().find((event) =>
    event.stage === "frontend.link.literal-update"
  );
  const loweredUpdate = trace.snapshot().find((event) =>
    event.stage === "frontend.lower.literal-update"
  );
  equal(loweredUpdate?.annotations.changedLiterals, 0);
  const parsedUpdate = trace.snapshot().find((event) =>
    event.stage === "frontend.parse.materialize"
  );
  equal(parsedUpdate?.annotations.cacheHit, false);
  const syntaxParse = trace.snapshot().find((event) => event.stage === "frontend.parse.syntax");
  equal(syntaxParse?.annotations.reparse, true);
  const signatureUpdate = trace.snapshot().find((event) =>
    event.stage === "frontend.signatures.value"
  );
  equal(signatureUpdate?.annotations.cacheHit, false);
  const semanticFingerprint = trace.snapshot().find((event) =>
    event.stage === "frontend.lower.semantic-fingerprint"
  );
  equal(semanticFingerprint?.annotations.incremental, false);
  equal(linkedUpdate?.annotations.changedNodes, 0);
  ok(trace.snapshot().some((event) => event.stage === "frontend.link"));
  ok(trace.snapshot().some((event) => event.stage === "semantic.inference.solve"));

  firstCompilation.module.destroy();
  secondCompilation.module.destroy();
  frontend.clear();
  await compiler.destroy();
});

Deno.test("incremental lowering rejects shifted source locations", () => {
  const frontend = new GleamFrontendService();
  const entry = { module: "main", exportName: "main" };
  const first = frontend.lower(
    [{ name: "main", source: "pub fn main() -> Int { 42 }\n" }],
    entry,
  );
  if (!first.ok) throw new Error(first.diagnostics[0].message);

  const shiftedSource = "pub fn main() -> Int {\n  42\n}\n";
  const trace = new CompilerPerformanceTrace();
  const shifted = frontend.lower(
    [{ name: "main", source: shiftedSource }],
    entry,
    { trace },
  );
  if (!shifted.ok) throw new Error(shifted.diagnostics[0].message);
  const fresh = lowerGleamSources(
    [{ name: "main", source: shiftedSource }],
    entry,
  );
  if (!fresh.ok) throw new Error(fresh.diagnostics[0].message);

  notDeepStrictEqual(
    shifted.lowered.modules[0]?.definitions,
    first.lowered.modules[0]?.definitions,
  );
  deepStrictEqual(shifted.lowered.module, fresh.lowered.module);
  const locationFingerprint = trace.snapshot().find((event) =>
    event.stage === "frontend.lower.location-fingerprint"
  );
  equal(locationFingerprint?.annotations.previousCached, false);

  frontend.clear();
});

Deno.test("incremental integer patterns match fresh lowering", () => {
  const frontend = new GleamFrontendService();
  const entry = { module: "main", exportName: "main" };
  const source = (subject: number, pattern: number) => `
pub fn main() -> Int {
  case ${subject} {
    ${pattern} -> 10
    _ -> 20
  }
}
`;
  const first = frontend.lower([{ name: "main", source: source(2, 1) }], entry);
  if (!first.ok) throw new Error(first.diagnostics[0].message);
  const trace = new CompilerPerformanceTrace();
  const updated = frontend.lower(
    [{ name: "main", source: source(3, 3) }],
    entry,
    { trace },
  );
  if (!updated.ok) throw new Error(updated.diagnostics[0].message);
  const fresh = lowerGleamSources([{ name: "main", source: source(3, 3) }], entry);
  if (!fresh.ok) throw new Error(fresh.diagnostics[0].message);

  deepStrictEqual(updated.lowered.module, fresh.lowered.module);
  const loweredUpdate = trace.snapshot().find((event) =>
    event.stage === "frontend.lower.literal-update"
  );
  equal(loweredUpdate?.annotations.changedLiterals, 2);

  frontend.clear();
});
