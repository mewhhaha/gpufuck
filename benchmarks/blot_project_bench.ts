import { configureSources } from "../playground/blot/src/load.ts";
import { initializeBlotParser } from "../playground/blot/src/syntax/parse.ts";
import { verify, type VerifyTimings } from "../playground/blot/src/backend/compile.ts";
import { createBlotStressProject } from "../playground/blot/stress_project.ts";

const SAMPLE_COUNT = 3;
const blot = new URL("../playground/blot/", import.meta.url);
const prelude = await Deno.readTextFile(new URL("src/prelude/prelude.blot", blot));
const project = createBlotStressProject();
const compiledExample = await Deno.readTextFile(new URL("examples/compiled.blot", blot));

await initializeBlotParser(
  new URL("generated/wasm/parser.wasm", blot),
  new URL("generated/wasm/parser.plan", blot),
);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const stages: readonly [label: string, timing: keyof VerifyTimings][] = [
  ["Blot frontend", "blotFrontendMilliseconds"],
  ["GPU device", "gpuDeviceMilliseconds"],
  ["GPU compiler init", "gpuCompilerMilliseconds"],
  ["Core compile", "coreCompileMilliseconds"],
  ["GPU evaluate", "gpuEvaluateMilliseconds"],
  ["Wasm emit + run", "wasmExecuteMilliseconds"],
  ["canonical Wasm emit", "canonicalWasmMilliseconds"],
];

interface Workload {
  readonly label: string;
  readonly path: string;
  readonly sources: Readonly<Record<string, string>>;
  readonly expectedRuntimeExports: number;
}

interface Measurement {
  readonly samples: readonly VerifyTimings[];
  readonly wasmBytes: number;
}

async function measureWorkload(workload: Workload): Promise<Measurement> {
  const samples: VerifyTimings[] = [];
  let wasmBytes = 0;
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    configureSources({
      "/blot/prelude.blot": prelude,
      ...workload.sources,
    });
    const verified = await verify(workload.path);
    const runtimeExports = verified.manifest.exports.filter((entry) => entry.phase === "runtime");
    if (runtimeExports.length !== workload.expectedRuntimeExports) {
      throw new Error(
        `${workload.label} emitted ${runtimeExports.length} runtime exports; expected ${workload.expectedRuntimeExports}`,
      );
    }
    samples.push(verified.timings);
    wasmBytes = verified.wasm.byteLength;
  }
  return { samples, wasmBytes };
}

function printMeasurement(workload: Workload, measurement: Measurement): void {
  console.log(`\n${workload.label}: ${(measurement.wasmBytes / 1024).toFixed(1)} KB Wasm`);
  console.log(`${"Stage".padEnd(22)} ${"first".padStart(9)} ${"median".padStart(9)}`);
  for (const [label, timing] of stages) {
    console.log(
      `${label.padEnd(22)} ${(measurement.samples[0]![timing].toFixed(1) + " ms").padStart(9)} ${
        (median(measurement.samples.map((sample) => sample[timing])).toFixed(1) + " ms").padStart(
          9,
        )
      }`,
    );
  }
  const totals = measurement.samples.map((sample) =>
    stages.reduce((total, [, timing]) => total + sample[timing], 0)
  );
  console.log(
    `${"Measured total".padEnd(22)} ${(totals[0]!.toFixed(1) + " ms").padStart(9)} ${
      (median(totals).toFixed(1) + " ms").padStart(9)
    }`,
  );
}

const compiledWorkload: Workload = {
  label: "Compiled example",
  path: "/examples/compiled.blot",
  sources: { "/examples/compiled.blot": compiledExample },
  expectedRuntimeExports: 1,
};
const stressWorkload: Workload = {
  label: `Stress project (${project.moduleCount} modules, ${project.definitionCount} functions, ` +
    `${project.lineCount} lines, ${(project.sourceBytes / 1024).toFixed(1)} KB source)`,
  path: project.entryPath,
  sources: project.sources,
  expectedRuntimeExports: project.moduleCount - 1,
};

printMeasurement(compiledWorkload, await measureWorkload(compiledWorkload));
printMeasurement(stressWorkload, await measureWorkload(stressWorkload));
