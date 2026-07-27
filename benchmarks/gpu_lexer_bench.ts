/**
 * baba's WebGPU lexer against the CPU parser, on the Gleam grammar.
 *
 * Only runnable since baba 7.2.0. Before it, the kernel expanded the plan into a dense
 * `states x classes` table in workgroup storage and Gleam needed 53,216 B against this device's
 * 49,152 B; 7.2.0 keeps that table in device storage and needs `512 + 36 * states`, so all three of
 * this repository's grammars fit. `deno task check:gpu-lexer` reports the fit.
 *
 * **This is not a like-for-like comparison, and the factor is known.** The kernel emits a token record
 * array; `parseGleamModule` emits tokens *and* a Gleam AST. Measured separately, baba's own lexer is
 * 1.13 ms of a 29.16 ms parse and of a 133 ms frontend — so the CPU column here carries roughly
 * twenty-six times the work the GPU column does. **The ratio below is not a frontend speedup and must
 * not be quoted as one:** a free GPU lexer is worth 1.01x on the frontend, because lexing is 1% of it.
 *
 * What the numbers are still good for is bounding the kernel itself, and showing it scaling past the
 * point where baba's parser refuses input outright.
 *
 * Two things it is measuring for:
 *
 *   - **the crossover**, which decides whether this is usable at all. It is a band rather than a
 *     point, because the GPU side is a flat submit-and-sync floor and the CPU side is what moves.
 *   - **the ceiling**, where the GPU keeps going and the CPU cannot follow: baba's own parser refuses
 *     a source past roughly 147 KiB with `PARSER_TRACE_LIMIT`.
 *
 * Usage: deno task bench:gpu-lexer
 *
 * @module
 */
import { WebGpuLexer } from "@mewhhaha/baba/runtime/webgpu-lexer";
import { parseGleamModule } from "../src/gleam/parser.ts";
import { generateGleamCorpus } from "../tools/generate_gleam_corpus.ts";

const PLAN = new URL("../language/gleam/generated/wasm/parser.plan", import.meta.url);

/** Best-of, not median: interference can only add time, so the minimum is the honest estimator. */
const SAMPLES = 9;

function best(run: () => void): number {
  let fastest = Infinity;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const started = performance.now();
    run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

async function bestAsync(run: () => Promise<void>): Promise<number> {
  let fastest = Infinity;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const started = performance.now();
    await run();
    fastest = Math.min(fastest, performance.now() - started);
  }
  return fastest;
}

/** One Gleam module with `groups` function groups, which is ~976 bytes each. */
function source(groups: number): string {
  return generateGleamCorpus(1, groups).modules[0]!.source;
}

const load = (await Deno.readTextFile("/proc/loadavg").catch(() => "")).split(" ")[0] || "unknown";
console.log(
  `1-minute load average ${load}. The GPU column is stable under load; the CPU column is not, and ` +
    `the crossover depends on it.\n`,
);

const planBytes = await Deno.readFile(PLAN);
const setupStart = performance.now();
const lexer = await WebGpuLexer.create(planBytes);
const setupMilliseconds = performance.now() - setupStart;

try {
  console.log(
    `WebGpuLexer.create ${setupMilliseconds.toFixed(1)} ms, one-time, chunk ${lexer.chunkSize}`,
  );
  console.log(`storage tables: ${lexer.usesStorageTables}\n`);

  console.log("  source     GPU lex   CPU parse    ratio   tokens");
  console.log("  ---------  --------  ----------  -------  -------");

  // Up to the point the CPU parser gives up. 120 groups is a little over 117 KiB.
  for (const groups of [8, 12, 16, 24, 32, 64, 120]) {
    const text = source(groups);
    const units = new Uint16Array(text.length);
    for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index);
    const kib = new TextEncoder().encode(text).byteLength / 1024;

    let tokenCount = 0;
    const gpu = await bestAsync(async () => {
      const result = await lexer.lex(units);
      tokenCount = result.tokenCount;
    });

    let cpu: number | undefined;
    try {
      cpu = best(() => void parseGleamModule("bench", text));
    } catch {
      cpu = undefined; // PARSER_TRACE_LIMIT; the CPU cannot take this size at all.
    }

    console.log(
      `  ${kib.toFixed(1).padStart(7)} KiB  ${gpu.toFixed(2).padStart(8)}  ` +
        `${(cpu === undefined ? "refused" : cpu.toFixed(2)).padStart(10)}  ` +
        `${(cpu === undefined ? "—" : `${(cpu / gpu).toFixed(2)}x`).padStart(7)}  ` +
        `${tokenCount.toLocaleString().padStart(7)}`,
    );
  }

  // Past the CPU's reach entirely. The GPU number is the only one that exists here.
  console.log("\n  Past the CPU parser's limit — GPU only:");
  console.log("  source      GPU lex     MB/s   tokens");
  console.log("  ----------  --------  -------  ----------");
  for (const groups of [256, 1024, 4096]) {
    const text = source(groups);
    const units = new Uint16Array(text.length);
    for (let index = 0; index < text.length; index++) units[index] = text.charCodeAt(index);
    const mib = new TextEncoder().encode(text).byteLength / 1024 / 1024;
    let tokenCount = 0;
    const gpu = await bestAsync(async () => {
      const result = await lexer.lex(units);
      tokenCount = result.tokenCount;
    });
    console.log(
      `  ${mib.toFixed(3).padStart(6)} MiB  ${gpu.toFixed(2).padStart(8)}  ` +
        `${(mib / (gpu / 1000)).toFixed(1).padStart(7)}  ${
          tokenCount.toLocaleString().padStart(10)
        }`,
    );
  }
} finally {
  lexer.destroy();
}
