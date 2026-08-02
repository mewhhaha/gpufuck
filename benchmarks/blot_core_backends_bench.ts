/**
 * Compares the CPU and GPU Core backends after their resident compiler has been created.
 *
 * A fresh compiler is used for every sample so neither backend can restore compiled Core from its
 * semantic cache. Session creation remains outside `coreCompileMilliseconds`, which deliberately
 * gives the GPU comparison no adapter or pipeline-creation cost.
 */
import { BlotCompilerSession } from "../playground/blot/src/backend/compile.ts";
import { configureSources } from "../playground/blot/src/load.ts";
import { initializeBlotParser } from "../playground/blot/src/syntax/parse.ts";
import { createBlotStressProject } from "../playground/blot/stress_project.ts";

const SAMPLE_COUNT = 5;
const BROWSER_DISPATCH_QUANTUM = 16_384;
const MAXIMUM_DISPATCH_QUANTUM = 524_288;
const blot = new URL("../playground/blot/", import.meta.url);
const prelude = await Deno.readTextFile(new URL("src/prelude/prelude.blot", blot));

await initializeBlotParser(
  new URL("generated/wasm/parser.wasm", blot),
  new URL("generated/wasm/parser.plan", blot),
);

interface Workload {
  readonly label: string;
  readonly path: string;
  readonly sources: Readonly<Record<string, string>>;
}

interface Configuration {
  readonly label: string;
  readonly backend: "cpu" | "gpu";
  readonly maximumStepsPerDispatch?: number;
}

const stressProject = createBlotStressProject();
const workloads: readonly Workload[] = [
  {
    label: "tour",
    path: "/examples/tour.blot",
    sources: {
      "/examples/tour.blot": await Deno.readTextFile(new URL("examples/tour.blot", blot)),
    },
  },
  {
    label: "stress project",
    path: stressProject.entryPath,
    sources: stressProject.sources,
  },
];
const configurations: readonly Configuration[] = [
  { label: "CPU", backend: "cpu" },
  {
    label: "GPU responsive",
    backend: "gpu",
    maximumStepsPerDispatch: BROWSER_DISPATCH_QUANTUM,
  },
  {
    label: "GPU throughput",
    backend: "gpu",
    maximumStepsPerDispatch: MAXIMUM_DISPATCH_QUANTUM,
  },
];

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function measure(
  workload: Workload,
  configuration: Configuration,
): Promise<{ readonly milliseconds: number; readonly nodes: number }> {
  configureSources({
    "/blot/prelude.blot": prelude,
    ...workload.sources,
  }, { cache: "clear" });
  const session = await BlotCompilerSession.create(configuration.backend);
  try {
    const verified = await session.verify(workload.path, {
      ...(configuration.maximumStepsPerDispatch === undefined ? {} : {
        maximumStepsPerDispatch: configuration.maximumStepsPerDispatch,
      }),
    });
    return {
      milliseconds: verified.timings.coreCompileMilliseconds,
      nodes: verified.metrics.surfaceNodes,
    };
  } finally {
    session.destroy();
  }
}

console.log("Adapter acquisition and compiler pipeline creation are excluded.");
for (const workload of workloads) {
  console.log(`\n${workload.label}`);
  console.log(`${"backend".padEnd(18)} ${"median".padStart(10)} ${"samples".padStart(38)}`);
  for (const configuration of configurations) {
    const samples: number[] = [];
    let nodes = 0;
    for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
      const measured = await measure(workload, configuration);
      samples.push(measured.milliseconds);
      nodes = measured.nodes;
    }
    console.log(
      `${configuration.label.padEnd(18)} ${(median(samples).toFixed(1) + " ms").padStart(10)} ` +
        `${samples.map((sample) => sample.toFixed(1)).join(", ").padStart(38)}`,
    );
    if (configuration === configurations[0]) {
      console.log(`${"Surface nodes".padEnd(18)} ${nodes.toLocaleString().padStart(10)}`);
    }
  }
}
