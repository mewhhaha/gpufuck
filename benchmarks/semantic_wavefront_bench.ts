import { deepStrictEqual } from "node:assert/strict";

import { requestWebGpuDevice } from "../functional.ts";
import {
  GpuSemanticDefinitionWavefrontPrototype,
  scheduleSemanticDefinitionWavefronts,
  type SemanticDefinitionDependencyGraph,
} from "../src/semantic/definition_wavefront.ts";

const graph = layeredGraph(16, 8);
const expected = scheduleSemanticDefinitionWavefronts(graph);
const batchGraphs = Array.from({ length: 256 }, () => graph);
const residentRepetitions = 64;
const device = await requestWebGpuDevice();
const prototype = await GpuSemanticDefinitionWavefrontPrototype.create(device);
const residentPlan = prototype.prepareBatch(batchGraphs);
globalThis.addEventListener("unload", () => {
  residentPlan.destroy();
  device.destroy();
}, { once: true });

deepStrictEqual((await prototype.schedule(graph)).componentWaves, expected.componentWaves);
for (const schedule of await prototype.scheduleBatch(batchGraphs)) {
  deepStrictEqual(schedule.componentWaves, expected.componentWaves);
}

Deno.bench("schedule 128 definition components on CPU", () => {
  scheduleSemanticDefinitionWavefronts(graph);
});

Deno.bench("prototype 128 definition component wavefronts on GPU", async () => {
  await prototype.schedule(graph);
});

Deno.bench("schedule 256 independent graphs on CPU", () => {
  for (const graph of batchGraphs) scheduleSemanticDefinitionWavefronts(graph);
});

Deno.bench("schedule 256 independent graphs in one GPU dispatch", async () => {
  await prototype.scheduleBatch(batchGraphs);
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
