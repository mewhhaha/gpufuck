/**
 * Does batching still win at a module size somebody might actually write?
 *
 * BASELINE records batch throughput as ~17x `gleam build`, measured on two-definition modules. At
 * that size the comparison is almost entirely against Gleam's ~11 ms per-package floor rather than
 * against its compiler, so the number flatters the GPU by construction. This measures the same claim
 * on modules of a few hundred nodes each.
 *
 * Both shapes are reported, because gpufuck behaves oppositely on them and quoting one without the
 * other is how a benchmark lies:
 *
 *   - **latency** — the corpus linked into one module, which is what a real project becomes. gpufuck
 *     loses this case.
 *   - **throughput** — the same modules compiled independently in one batch. gpufuck wins this case.
 *
 * The Gleam side is a floor, not a measurement: `gleam build` is 146 ms for the 257 KB standard
 * library and has no cross-package batching, so N independent packages cost at least N x 11 ms. That
 * is generous to Gleam on latency and generous to gpufuck on throughput, and it is stated rather than
 * hidden.
 *
 * Usage: deno task bench:gleam-corpus [module-count]
 *
 * @module
 */
import { GpuCompiler, requestWebGpuDevice } from "../functional.ts";
import { lowerGleamSource, lowerGleamSources } from "../gleam.ts";
import { generateGleamCorpus } from "../tools/generate_gleam_corpus.ts";

/** `gleam build`'s per-package cost with nothing to compile; the floor N packages cannot beat. */
const GLEAM_PACKAGE_FLOOR_MILLISECONDS = 11;

/**
 * Gleam's measured rate on real input: 257.3 KB of standard library in 146 ms.
 *
 * The per-package floor alone is the generous comparison and it stops being the honest one as modules
 * grow — a 1,174-node module is not a package Gleam compiles in 11 ms either. Reporting both bounds
 * means the reader can see which one is actually binding.
 */
const GLEAM_KILOBYTES_PER_MILLISECOND = 257.3 / 146;

const REPETITIONS = 5;

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const moduleCount = Number.parseInt(Deno.args[0] ?? "256", 10);
const corpus = generateGleamCorpus(moduleCount, 6);

const device = await requestWebGpuDevice();
const compiler = await GpuCompiler.create(device);

try {
  // Throughput: every module independent, one batch, nothing executed.
  const independent = corpus.modules.map((module) => {
    const parsed = lowerGleamSource(module.name.replaceAll("/", "_"), module.source);
    if (!parsed.ok) throw new Error(`lowering failed: ${parsed.diagnostics[0]?.message}`);
    return parsed.lowered.module;
  });
  const nodes = independent.reduce((total, module) => total + module.nodeCount, 0);

  const parseSamples: number[] = [];
  for (let repetition = 0; repetition < REPETITIONS; repetition++) {
    const started = performance.now();
    for (const module of corpus.modules) {
      const parsed = lowerGleamSource(module.name.replaceAll("/", "_"), module.source);
      if (!parsed.ok) throw new Error("lowering failed during warm samples");
    }
    parseSamples.push(performance.now() - started);
  }

  const batchSamples: number[] = [];
  for (let repetition = 0; repetition < REPETITIONS; repetition++) {
    const started = performance.now();
    const results = await compiler.compileBatch(independent);
    batchSamples.push(performance.now() - started);
    for (const result of results) {
      if (!result.ok) throw new Error(`batch compile failed: ${result.diagnostics[0]?.code}`);
      result.module.destroy();
    }
  }

  // Latency: the same modules as one project. An entry imports each and references its `main`, so
  // nothing is pruned and the frontend links the lot into a single module.
  //
  // Only as many modules as fit are linked. The packed surface ABI caps a module at 65,536 nodes,
  // and at roughly a thousand nodes each that ceiling arrives at about sixty modules -- so "one big
  // project" is not a shape this compiler can be given past a certain size, whatever its speed. The
  // count actually linked is reported rather than silently chosen.
  const nodesPerModule = Math.max(1, Math.round(nodes / moduleCount));
  const linkableCount = Math.max(
    1,
    Math.min(moduleCount, Math.floor(60_000 / nodesPerModule)),
  );
  const linkable = corpus.modules.slice(0, linkableCount);
  const suffix = (module: { readonly name: string }) => module.name.split("_")[1];
  const entry = {
    name: "corpus_entry",
    source: `${linkable.map((module) => `import ${module.name} as m${suffix(module)}`).join("\n")}

pub fn main() -> Int {
${linkable.map((module) => `  let v${suffix(module)} = m${suffix(module)}.main()`).join("\n")}
  ${linkable.map((module) => `v${suffix(module)}`).join(" + ")}
}
`,
  };
  const linked = lowerGleamSources([...linkable, entry], {
    module: entry.name,
    exportName: "main",
  });
  if (!linked.ok) throw new Error(`linking failed: ${linked.diagnostics[0]?.message}`);

  const latencySamples: number[] = [];
  for (let repetition = 0; repetition < REPETITIONS; repetition++) {
    const started = performance.now();
    const compilation = await compiler.compileModule(linked.lowered.module, {
      maximumSteps: 10_000_000,
    });
    if (!compilation.ok) {
      throw new Error(`linked compile failed: ${compilation.diagnostics[0]?.code}`);
    }
    latencySamples.push(performance.now() - started);
    compilation.module.destroy();
  }

  const parseMilliseconds = median(parseSamples);
  const batchMilliseconds = median(batchSamples);
  const latencyMilliseconds = median(latencySamples);
  const gleamFloor = moduleCount * GLEAM_PACKAGE_FLOOR_MILLISECONDS;
  // Whichever bound is larger is the one Gleam would actually be limited by.
  const gleamAtRate = Math.max(
    gleamFloor,
    corpus.sourceBytes / 1024 / GLEAM_KILOBYTES_PER_MILLISECOND,
  );

  console.log(JSON.stringify(
    {
      modules: moduleCount,
      sourceKilobytes: Number((corpus.sourceBytes / 1024).toFixed(1)),
      surfaceNodes: nodes,
      nodesPerModule: Math.round(nodes / moduleCount),
      linkedSurfaceNodes: linked.lowered.module.nodeCount,
      repetitions: REPETITIONS,
      throughput: {
        parseAndLowerMilliseconds: Number(parseMilliseconds.toFixed(1)),
        gpuBatchMilliseconds: Number(batchMilliseconds.toFixed(1)),
        totalMilliseconds: Number((parseMilliseconds + batchMilliseconds).toFixed(1)),
        microsecondsPerModule: Number(
          ((parseMilliseconds + batchMilliseconds) * 1000 / moduleCount).toFixed(1),
        ),
        gleamPackageFloorMilliseconds: gleamFloor,
        fasterThanGleamFloor: Number(
          (gleamFloor / (parseMilliseconds + batchMilliseconds)).toFixed(1),
        ),
        gleamAtMeasuredRateMilliseconds: Number(gleamAtRate.toFixed(1)),
        fasterThanGleamAtMeasuredRate: Number(
          (gleamAtRate / (parseMilliseconds + batchMilliseconds)).toFixed(2),
        ),
        frontendShareOfTotal: Number(
          (parseMilliseconds / (parseMilliseconds + batchMilliseconds) * 100).toFixed(1),
        ),
        gpuMicrosecondsPerNode: Number((batchMilliseconds * 1000 / nodes).toFixed(2)),
      },
      latency: {
        linkedModules: linkableCount,
        linkedCappedByAbi: linkableCount < moduleCount,
        gpuLinkedMilliseconds: Number(latencyMilliseconds.toFixed(1)),
        microsecondsPerNode: Number(
          (latencyMilliseconds * 1000 / linked.lowered.module.nodeCount).toFixed(2),
        ),
      },
    },
    null,
    2,
  ));
} finally {
  device.destroy();
}
