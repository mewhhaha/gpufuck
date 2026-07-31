import {
  configureSourceLexerRecords,
  configureSources,
  load,
} from "../playground/blot/src/load.ts";
import {
  dispose as disposeBlotParser,
  initializeBlotParser,
} from "../playground/blot/src/syntax/parse.ts";
import { resetBlotSyntaxSession, validateBlotSyntax } from "../playground/blot/gpu_frontend.ts";

const SAMPLE_COUNT = 5;
const DEFINITION_COUNTS = [
  16,
  64,
  256,
  1_024,
  2_048,
  4_096,
  8_192,
] as const;
const path = "/bench/syntax.blot";
const blot = new URL("../playground/blot/", import.meta.url);
const parserWasmUrl = new URL("generated/wasm/parser.wasm", blot);
const parserPlanUrl = new URL("generated/wasm/parser.plan", blot);

function sourceWithDefinitions(definitionCount: number): string {
  const definitions = Array.from({ length: definitionCount }, (_, index) => {
    const name = index.toString().padStart(4, "0");
    return `let step_${name} = value => value;`;
  });
  return [
    "module {};",
    ...definitions,
    `return { .run = step_${(definitionCount - 1).toString().padStart(4, "0")}; };`,
    "",
  ].join("\n");
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function parseOnCpu(source: string): Promise<number> {
  const start = performance.now();
  configureSources({ [path]: source }, { cache: "clear" });
  await load(path);
  return performance.now() - start;
}

async function validateOnGpuThenParse(source: string): Promise<number> {
  const start = performance.now();
  const syntax = await validateBlotSyntax(source, parserPlanUrl);
  if (!syntax.ok) {
    throw new Error(syntax.diagnostics[0]?.message ?? "GPU syntax validation failed");
  }
  configureSources({ [path]: source }, { cache: "clear" });
  configureSourceLexerRecords(path, source, syntax.lexerRecords);
  await load(path);
  return performance.now() - start;
}

await initializeBlotParser(parserWasmUrl, parserPlanUrl);
const warmup = await validateBlotSyntax("module {}; return {};", parserPlanUrl);
if (!warmup.ok) throw new Error("Blot syntax benchmark warmup failed");

console.log("Warm syntax path; Baba runtime and Blot parser initialization are excluded.");
console.log(
  `${"definitions".padStart(11)} ${"bytes".padStart(9)} ${"CPU parse".padStart(10)} ` +
    `${"GPU + parse".padStart(12)} ${"GPU / CPU".padStart(10)}`,
);
for (const definitionCount of DEFINITION_COUNTS) {
  const source = sourceWithDefinitions(definitionCount);
  const cpuSamples: number[] = [];
  const gpuSamples: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const changedSource = `${source}// sample ${sample}\n`;
    if (sample % 2 === 0) {
      cpuSamples.push(await parseOnCpu(changedSource));
      gpuSamples.push(await validateOnGpuThenParse(changedSource));
    } else {
      gpuSamples.push(await validateOnGpuThenParse(changedSource));
      cpuSamples.push(await parseOnCpu(changedSource));
    }
  }
  const cpuMilliseconds = median(cpuSamples);
  const gpuMilliseconds = median(gpuSamples);
  console.log(
    `${definitionCount.toLocaleString().padStart(11)} ${
      new TextEncoder().encode(source).byteLength.toLocaleString().padStart(9)
    } ${(cpuMilliseconds.toFixed(2) + " ms").padStart(10)} ${
      (gpuMilliseconds.toFixed(2) + " ms").padStart(12)
    } ${(gpuMilliseconds / cpuMilliseconds).toFixed(2).padStart(10)}`,
  );
}

disposeBlotParser();
await resetBlotSyntaxSession();
