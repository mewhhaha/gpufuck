import { deepStrictEqual, equal } from "node:assert/strict";

import { FunctionalCoreTag, FunctionalEvaluationMode, requestWebGpuDevice } from "../functional.ts";
import type { LazuliCoreNode } from "../src/semantic/compiler_module.ts";
import {
  GpuSemanticDefinitionWavefrontPrototype,
  scheduleSemanticDefinitionWavefronts,
  type SemanticDefinitionDependencyGraph,
  semanticDefinitionDependencyGraph,
} from "../src/semantic/definition_wavefront.ts";

Deno.test("definition wavefronts schedule dependencies before consumers and keep SCCs together", () => {
  const nodes = [
    globalNode(1),
    globalNode(2),
    integerNode(),
    globalNode(2),
    globalNode(5),
    globalNode(4),
  ];
  const graph = semanticDefinitionDependencyGraph([0, 1, 2, 3, 4, 5], nodes);
  const schedule = scheduleSemanticDefinitionWavefronts(graph);
  const definitionWaves = graph.componentByDefinition.map((component) =>
    schedule.componentWaves[component]
  );

  deepStrictEqual(definitionWaves, [2, 1, 0, 1, 0, 0]);
  equal(graph.componentByDefinition[4], graph.componentByDefinition[5]);
});

Deno.test("resident GPU wavefront plans reset and reproduce host schedules", async () => {
  const graphs = [
    graphFromDependencies([[], [0], [0], [1, 2]]),
    graphFromDependencies([[], [], [0, 1], [2]]),
  ];
  const expected = graphs.map(scheduleSemanticDefinitionWavefronts);
  const device = await requestWebGpuDevice();
  const scheduler = await GpuSemanticDefinitionWavefrontPrototype.create(device);
  const plan = scheduler.prepareBatch(graphs);
  try {
    const first = await plan.scheduleAndReadback();
    await plan.execute(4);
    const afterRepeatedExecution = await plan.scheduleAndReadback();
    deepStrictEqual(first, expected);
    deepStrictEqual(afterRepeatedExecution, expected);
  } finally {
    plan.destroy();
    device.destroy();
  }
});

function graphFromDependencies(
  dependencies: readonly (readonly number[])[],
): SemanticDefinitionDependencyGraph {
  return {
    definitionCount: dependencies.length,
    components: dependencies.map((componentDependencies, component) => ({
      definitions: [component],
      dependencies: componentDependencies,
    })),
    componentByDefinition: dependencies.map((_, definition) => definition),
  };
}

function globalNode(definition: number): LazuliCoreNode {
  return {
    tag: FunctionalCoreTag.Global,
    payload: definition,
    child0: 0xffff_ffff,
    child1: 0xffff_ffff,
    child2: 0xffff_ffff,
    sourceByteOffset: 0,
    sourceEndByte: 0,
    evaluationMode: FunctionalEvaluationMode.StrictEager,
  };
}

function integerNode(): LazuliCoreNode {
  return {
    tag: FunctionalCoreTag.Integer,
    payload: 42,
    child0: 0xffff_ffff,
    child1: 0xffff_ffff,
    child2: 0xffff_ffff,
    sourceByteOffset: 0,
    sourceEndByte: 0,
    evaluationMode: FunctionalEvaluationMode.StrictEager,
  };
}
