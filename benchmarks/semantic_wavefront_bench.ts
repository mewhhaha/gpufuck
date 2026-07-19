import { deepStrictEqual } from "node:assert/strict";

import { requestWebGpuDevice } from "../functional.ts";
import {
  GpuSemanticDefinitionWavefrontScheduler,
  scheduleSemanticDefinitionWavefronts,
  type SemanticDefinitionDependencyGraph,
} from "../src/semantic/definition_wavefront.ts";

const graph = layeredGraph(16, 8);
const expected = scheduleSemanticDefinitionWavefronts(graph);
const batchGraphs = Array.from({ length: 256 }, () => graph);
const residentRepetitions = 64;
const device = await requestWebGpuDevice();
const scheduler = await GpuSemanticDefinitionWavefrontScheduler.create(device);
const residentPlan = await scheduler.prepareBatch(batchGraphs);
globalThis.addEventListener("unload", () => {
  residentPlan.destroy();
  device.destroy();
}, { once: true });

deepStrictEqual((await scheduler.schedule(graph)).componentWaves, expected.componentWaves);
for (const schedule of await scheduler.scheduleBatch(batchGraphs)) {
  deepStrictEqual(schedule.componentWaves, expected.componentWaves);
}

Deno.bench("schedule 128 definition components on CPU", () => {
  scheduleSemanticDefinitionWavefronts(graph);
});

Deno.bench("schedule and read back 128 definition components on GPU", async () => {
  await scheduler.schedule(graph);
});

Deno.bench("schedule 256 independent graphs on CPU", () => {
  for (const graph of batchGraphs) scheduleSemanticDefinitionWavefronts(graph);
});

Deno.bench("schedule 256 independent graphs in one GPU dispatch", async () => {
  await scheduler.scheduleBatch(batchGraphs);
});

Deno.bench("schedule 64 batches of 256 graphs on CPU", () => {
  for (let repetition = 0; repetition < residentRepetitions; repetition++) {
    for (const graph of batchGraphs) scheduleSemanticDefinitionWavefronts(graph);
  }
});

Deno.bench("schedule 64 resident batches of 256 graphs on GPU", async () => {
  await residentPlan.execute(residentRepetitions);
});

function layeredGraph(width: number, depth: number): SemanticDefinitionDependencyGraph {
  const componentCount = width * depth;
  const components = Array.from({ length: componentCount }, (_, component) => {
    const layer = Math.floor(component / width);
    return Object.freeze({
      definitions: Object.freeze([component]),
      dependencies: Object.freeze(layer === 0 ? [] : [component - width]),
    });
  });
  return Object.freeze({
    definitionCount: componentCount,
    components: Object.freeze(components),
    componentByDefinition: Object.freeze(
      Array.from({ length: componentCount }, (_, definition) => definition),
    ),
  });
}
