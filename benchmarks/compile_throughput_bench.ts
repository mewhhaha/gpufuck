/**
 * The benchmark the retarget is judged against.
 *
 * Reports marginal cost per module rather than totals, because totals hide the crossover: both
 * paths pay the same CPU parse, so a total-wall-time ratio flatters the GPU. The CPU baseline is
 * `inferLazuliTypes`, the host Hindley-Milner implementation the GPU shader is differentially
 * tested against, so the two columns do the same work.
 */
import { GpuLazuliCompiler } from "../src/lazuli/compiler.ts";
import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import { createLazuliSymbolLookup } from "../src/semantic/symbol_lookup.ts";
import { inferLazuliTypes } from "../src/semantic/type_inference.ts";
import { requestWebGpuDevice } from "../src/webgpu.ts";

const SIZES = [1, 16, 64, 256, 1024] as const;
/**
 * GPU batch timings spread roughly 30% run to run, so a handful of samples cannot distinguish a
 * real change from noise. Compare medians across repeated runs before believing any delta.
 */
const REPETITIONS = 15;

function program(index: number): string {
  return `fn helper${index} n = n * ${index % 7 + 1};\nfn main = helper${index} ${index};`;
}

async function median(samples: number, run: () => Promise<void> | void): Promise<number> {
  const timings: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const start = performance.now();
    await run();
    timings.push(performance.now() - start);
  }
  timings.sort((left, right) => left - right);
  return timings[Math.floor(timings.length / 2)]!;
}

/** Marginal cost excludes fixed overhead, which is what a throughput claim rests on. */
function marginalMicroseconds(
  measurements: readonly { readonly size: number; readonly milliseconds: number }[],
): number {
  const last = measurements.at(-1)!;
  const previous = measurements.at(-2);
  if (previous === undefined) return (last.milliseconds * 1000) / last.size;
  return ((last.milliseconds - previous.milliseconds) * 1000) / (last.size - previous.size);
}

const device = await requestWebGpuDevice();
const compiler = await GpuLazuliCompiler.create(device);

const cpuTotals: { size: number; milliseconds: number }[] = [];
const cpuInference: { size: number; milliseconds: number }[] = [];
const hostLookup: { size: number; milliseconds: number }[] = [];
const gpuTotals: { size: number; milliseconds: number }[] = [];

const rows: string[] = [];
for (const size of SIZES) {
  const sources = Array.from({ length: size }, (_, index) => program(index));
  const surfaces = sources.map((source) => {
    const parsed = parseLazuliSource(source);
    if (!parsed.ok) throw new Error(`benchmark corpus failed to parse: ${source}`);
    return parsed.surface;
  });

  const cpu = await median(REPETITIONS, () => {
    for (const source of sources) {
      const parsed = parseLazuliSource(source);
      if (parsed.ok) inferLazuliTypes(parsed.surface);
    }
  });
  const inference = await median(REPETITIONS, () => {
    for (const surface of surfaces) inferLazuliTypes(surface);
  });
  const lookup = await median(REPETITIONS, () => {
    for (const surface of surfaces) createLazuliSymbolLookup(surface);
  });
  const gpu = await median(REPETITIONS, async () => {
    const results = await compiler.compileBatch(sources);
    for (const result of results) {
      if (!result.ok) throw new Error(`GPU compilation failed: ${result.diagnostics[0]?.message}`);
      result.module.destroy();
    }
  });

  cpuTotals.push({ size, milliseconds: cpu });
  cpuInference.push({ size, milliseconds: inference });
  hostLookup.push({ size, milliseconds: lookup });
  gpuTotals.push({ size, milliseconds: gpu });

  rows.push(
    `| ${size} | ${cpu.toFixed(2)} | ${inference.toFixed(2)} | ${lookup.toFixed(2)} | ${
      gpu.toFixed(2)
    } | ${(gpu / cpu).toFixed(1)}x |`,
  );
}

console.log(
  "| modules | CPU parse+infer (ms) | CPU infer (ms) | host lookup (ms) | GPU batch (ms) | GPU slower |",
);
console.log("|---|---|---|---|---|---|");
for (const row of rows) console.log(row);

const cpuMarginal = marginalMicroseconds(cpuTotals);
const inferenceMarginal = marginalMicroseconds(cpuInference);
const lookupMarginal = marginalMicroseconds(hostLookup);
const gpuMarginal = marginalMicroseconds(gpuTotals);

console.log(`\nMarginal cost per module at N=${SIZES.at(-1)}:`);
console.log(`  CPU parse+infer      ${cpuMarginal.toFixed(1)} us`);
console.log(`  CPU inference alone  ${inferenceMarginal.toFixed(1)} us   <- what the GPU replaces`);
console.log(
  `  host symbol lookup   ${lookupMarginal.toFixed(1)} us   <- the GPU path pays this too`,
);
console.log(`  GPU batch total      ${gpuMarginal.toFixed(1)} us`);
console.log(
  `  GPU inference share  ${(gpuMarginal - lookupMarginal).toFixed(1)} us   ` +
    `(${((gpuMarginal - lookupMarginal) / inferenceMarginal).toFixed(1)}x the CPU it replaces)`,
);
console.log(
  `\nAmdahl ceiling: a free GPU inference would take the CPU path from ` +
    `${cpuMarginal.toFixed(1)} to ${(cpuMarginal - inferenceMarginal).toFixed(1)} us/module ` +
    `(${(cpuMarginal / (cpuMarginal - inferenceMarginal)).toFixed(2)}x).`,
);

device.destroy();
