/**
 * The regression benchmark suite: one command, comparable output, a stored baseline to diff against.
 *
 * The design follows the one lesson this repository keeps relearning. **Counters are exact and
 * timings are not.** Node counts, inference transition counts and emitted byte lengths reproduce to
 * the digit, and every real defect found so far showed up in one of them — the or-pattern explosion
 * as a node count, the uncompressed union-find as a transition count. Wall times on this machine
 * swing about 30% run to run and needed a quiet machine before they meant anything at all.
 *
 * So the two are treated differently, and that is the whole point of the file:
 *
 *   - **counters** are compared exactly against the baseline, and a change fails the run.
 *   - **timings** are reported with their delta and never fail anything.
 *
 * A benchmark that failed on timings would cry wolf until it was ignored; one that only reported
 * counters would have missed nothing today. Everything is self-contained — no external checkout, no
 * hand-made entry file — so the numbers are reproducible by anyone with the repository and a GPU.
 *
 * Usage:
 *   deno task bench              # run and diff against benchmarks/baseline.json
 *   deno task bench:save         # run and overwrite the baseline
 *
 * @module
 */
import { GpuCompiler, requestWebGpuDevice } from "../functional.ts";
import { compileModuleToWasm } from "../functional.ts";
import { type GleamSourceModule, lowerGleamSource, lowerGleamSources } from "../gleam.ts";
import { generateGleamCorpus } from "../tools/generate_gleam_corpus.ts";
import { orPatternProgram } from "../tools/or_pattern_program.ts";
import { GpuSemanticCompiler } from "../src/semantic/gpu_semantic_compiler.ts";
import { semanticSurfaceFromModule } from "../src/functional/compiler.ts";
import type { GpuCompilationDispatchObservation } from "../src/semantic/gpu_type_inference_contract.ts";

const BASELINE_PATH = new URL("./baseline.json", import.meta.url);

/** Timings below this relative change are not worth reading; the machine's own spread is ~30%. */
const TIMING_NOISE = 0.3;

const REPETITIONS = 5;

interface Case {
  /** Exactly reproducible. A change here is a real change and fails the run. */
  readonly counters: Readonly<Record<string, number>>;
  /** Machine- and load-dependent. Reported, never asserted. */
  readonly timings: Readonly<Record<string, number>>;
}

type Suite = Readonly<Record<string, Case>>;

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(1));
}

async function timed(run: () => Promise<void> | void): Promise<number> {
  const samples: number[] = [];
  for (let repetition = 0; repetition < REPETITIONS; repetition++) {
    const started = performance.now();
    await run();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const device = await requestWebGpuDevice();
const compiler = await GpuCompiler.create(device);
const semantic = await GpuSemanticCompiler.create(device);
const cases: Record<string, Case> = {};

try {
  // ---------------------------------------------------------------- pattern lowering
  //
  // The regression guard for the or-pattern explosion. These were 94 / 1,214 / 19,134 and a throw at
  // four arms; anything that reintroduces body duplication shows up here first and cheapest, with no
  // GPU involved at all.
  // Recorded as -1 rather than rethrown, because the failure mode this guards against is exactly a
  // throw: before the fix, four arms exceeded the 65,536-node ABI cap. A benchmark that died on the
  // regression it exists to catch would report a stack trace instead of a diff.
  const orPatternNodes: Record<string, number> = {};
  for (const arms of [1, 2, 3, 4]) {
    try {
      const lowered = lowerGleamSource("or_patterns", orPatternProgram(arms, 1));
      orPatternNodes[`arms${arms}`] = lowered.ok ? lowered.lowered.module.nodeCount : -1;
    } catch {
      orPatternNodes[`arms${arms}`] = -1;
    }
  }
  cases["or-patterns"] = { counters: orPatternNodes, timings: {} };

  // ---------------------------------------------------------------- single module latency
  const corpus = generateGleamCorpus(256, 6);
  const single = lowerGleamSource("single", corpus.modules[0]!.source);
  if (!single.ok) throw new Error("single-module lowering failed");
  const singleModule = single.lowered.module;

  // Transition count is the most valuable counter in the file: it is exact, it scales with real work,
  // and it is what located both defects fixed today.
  let transitions = 0;
  let semanticSteps = 0;
  const surface = semanticSurfaceFromModule(singleModule);
  const compilation = await semantic.compile(
    surface,
    singleModule.sourceByteLength,
    { maximumSteps: 10_000_000, maximumStepsPerDispatch: 524_288 },
    undefined,
    {
      observeDispatch: (observation: GpuCompilationDispatchObservation) => {
        transitions = Math.max(transitions, observation.inferenceTransitions);
        semanticSteps = Math.max(semanticSteps, observation.semanticSteps);
      },
    },
  );
  if (!compilation.ok) throw new Error(`single-module compile failed: ${compilation.diagnostics[0]?.code}`);
  compilation.module.destroy();

  const singleWasm = await (async () => {
    const compiled = await compiler.compileModule(singleModule);
    if (!compiled.ok) throw new Error("single-module wasm compile failed");
    try {
      return (await compileModuleToWasm(compiled.module)).byteLength;
    } finally {
      compiled.module.destroy();
    }
  })();

  const singleGpuMilliseconds = await timed(async () => {
    const compiled = await compiler.compileModule(singleModule);
    if (!compiled.ok) throw new Error("single-module compile failed during timing");
    compiled.module.destroy();
  });

  cases["single-module"] = {
    counters: {
      nodes: singleModule.nodeCount,
      definitions: singleModule.definitionCount,
      inferenceTransitions: transitions,
      semanticSteps,
      wasmBytes: singleWasm,
    },
    timings: { gpuMilliseconds: singleGpuMilliseconds },
  };

  // ---------------------------------------------------------------- batch throughput
  for (const count of [64, 256]) {
    const slice = corpus.modules.slice(0, count);
    const modules = slice.map((module) => {
      const parsed = lowerGleamSource(module.name.replaceAll("/", "_"), module.source);
      if (!parsed.ok) throw new Error(`corpus lowering failed: ${parsed.diagnostics[0]?.message}`);
      return parsed.lowered.module;
    });
    const frontendMilliseconds = await timed(() => {
      for (const module of slice) {
        const parsed = lowerGleamSource(module.name.replaceAll("/", "_"), module.source);
        if (!parsed.ok) throw new Error("corpus lowering failed during timing");
      }
    });
    const gpuMilliseconds = await timed(async () => {
      const results = await compiler.compileBatch(modules);
      for (const result of results) {
        if (!result.ok) throw new Error(`batch failed: ${result.diagnostics[0]?.code}`);
        result.module.destroy();
      }
    });
    cases[`batch-${count}`] = {
      counters: {
        modules: count,
        nodes: modules.reduce((total, module) => total + module.nodeCount, 0),
        sourceBytes: slice.reduce(
          (total, module) => total + new TextEncoder().encode(module.source).byteLength,
          0,
        ),
      },
      timings: { frontendMilliseconds, gpuMilliseconds },
    };
  }

  // ---------------------------------------------------------------- linked project
  //
  // Capped at 51 modules by the 65,536-node surface ABI, not by choice; see BASELINE.
  const linkable = corpus.modules.slice(0, 51);
  const entry: GleamSourceModule = {
    name: "linked_entry",
    source: `${
      linkable.map((module, index) => `import ${module.name} as m${index}`).join("\n")
    }\n\npub fn main() -> Int {\n${
      linkable.map((_, index) => `  let v${index} = m${index}.main()`).join("\n")
    }\n  ${linkable.map((_, index) => `v${index}`).join(" + ")}\n}\n`,
  };
  const linked = lowerGleamSources([...linkable, entry], {
    module: entry.name,
    exportName: "main",
  });
  if (!linked.ok) throw new Error(`linking failed: ${linked.diagnostics[0]?.message}`);
  const linkedGpuMilliseconds = await timed(async () => {
    const compiled = await compiler.compileModule(linked.lowered.module, {
      maximumSteps: 10_000_000,
    });
    if (!compiled.ok) throw new Error(`linked compile failed: ${compiled.diagnostics[0]?.code}`);
    compiled.module.destroy();
  });
  cases["linked-51-modules"] = {
    counters: { modules: linkable.length, nodes: linked.lowered.module.nodeCount },
    timings: { gpuMilliseconds: linkedGpuMilliseconds },
  };
} finally {
  device.destroy();
}

const suite: Suite = cases;

// ------------------------------------------------------------------ report and compare

if (Deno.args.includes("--save")) {
  await Deno.writeTextFile(BASELINE_PATH, `${JSON.stringify(suite, null, 2)}\n`);
  console.log(`wrote ${BASELINE_PATH.pathname}`);
}

const baseline: Suite | undefined = await Deno.readTextFile(BASELINE_PATH)
  .then((text) => JSON.parse(text) as Suite)
  .catch(() => undefined);

let regressions = 0;
const width = 34;

for (const [name, result] of Object.entries(suite)) {
  console.log(`\n${name}`);
  const previous = baseline?.[name];
  for (const [key, value] of Object.entries(result.counters)) {
    const before = previous?.counters[key];
    if (before === undefined) {
      console.log(`  ${key.padEnd(width)} ${value.toLocaleString().padStart(12)}  (new)`);
      continue;
    }
    if (before === value) {
      console.log(`  ${key.padEnd(width)} ${value.toLocaleString().padStart(12)}`);
      continue;
    }
    if (value === -1) {
      regressions += 1;
      console.log(
        `  ${key.padEnd(width)} ${"failed".padStart(12)}  ` +
          `WAS ${before.toLocaleString()} — this case no longer compiles`,
      );
      continue;
    }
    regressions += 1;
    const direction = value > before ? "+" : "";
    console.log(
      `  ${key.padEnd(width)} ${value.toLocaleString().padStart(12)}  ` +
        `CHANGED from ${before.toLocaleString()} (${direction}${
          ((value / before - 1) * 100).toFixed(1)
        }%)`,
    );
  }
  for (const [key, value] of Object.entries(result.timings)) {
    const before = previous?.timings[key];
    if (before === undefined) {
      console.log(`  ${key.padEnd(width)} ${value.toFixed(1).padStart(12)} ms  (new)`);
      continue;
    }
    const delta = value / before - 1;
    const note = Math.abs(delta) < TIMING_NOISE
      ? "within noise"
      : `${delta > 0 ? "+" : ""}${(delta * 100).toFixed(0)}% vs ${before.toFixed(1)} ms`;
    console.log(`  ${key.padEnd(width)} ${value.toFixed(1).padStart(12)} ms  ${note}`);
  }
}

if (baseline === undefined) {
  console.log("\nNo baseline recorded. Run `deno task bench:save` to create one.");
} else if (regressions === 0) {
  console.log("\nEvery counter matches the baseline. Timings are advisory.");
} else {
  console.log(
    `\n${regressions} counter${regressions === 1 ? "" : "s"} changed. ` +
      "That is a real change in work done, not machine noise — explain it or fix it, and " +
      "`deno task bench:save` once it is intended.",
  );
  Deno.exit(1);
}
