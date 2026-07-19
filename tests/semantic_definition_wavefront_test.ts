import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";

import { FunctionalCoreTag, FunctionalEvaluationMode, requestWebGpuDevice } from "../functional.ts";
import type { LazuliCoreNode } from "../src/semantic/compiler_module.ts";
import {
  GpuSemanticDefinitionWavefrontPlan,
  GpuSemanticDefinitionWavefrontScheduler,
  scheduleSemanticDefinitionWavefronts,
  type SemanticDefinitionDependencyGraph,
  semanticDefinitionDependencyGraph,
} from "../src/semantic/definition_wavefront.ts";

let device: GPUDevice | undefined;
let gpuScheduler: GpuSemanticDefinitionWavefrontScheduler | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  gpuScheduler = await GpuSemanticDefinitionWavefrontScheduler.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  gpuScheduler = undefined;
});

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
    graphFromDependencies([[], [], [1, 0], [2]]),
  ];
  const expected = graphs.map(scheduleSemanticDefinitionWavefronts);
  const plan = await semanticGpuScheduler().prepareBatch(graphs);
  try {
    const first = await plan.scheduleAndReadback();
    await plan.execute(4);
    const afterRepeatedExecution = await plan.scheduleAndReadback();
    deepStrictEqual(first, expected);
    deepStrictEqual(afterRepeatedExecution, expected);
    await rejects(plan.execute(0), /integer from 1 through 256; received 0/);
    await rejects(plan.execute(257), /integer from 1 through 256; received 257/);
    const pendingExecution = plan.execute(4);
    plan.destroy();
    await pendingExecution;
  } finally {
    plan.destroy();
  }
  await rejects(plan.execute(), /cannot be used after destroy/);
});

Deno.test("GPU wavefront plans reject malformed and oversized graphs before dispatch", async () => {
  await rejects(
    semanticGpuScheduler().prepareBatch([]),
    /require at least one dependency graph/,
  );
  await rejects(
    semanticGpuScheduler().prepareBatch([graphFromDependencies([[0]])]),
    /component 0 depends on itself after SCC planning/,
  );
  await rejects(
    semanticGpuScheduler().prepareBatch([
      graphFromDependencies(Array.from({ length: 257 }, () => [])),
    ]),
    /has 257 components but the bounded kernel supports at most 256/,
  );
  await rejects(
    semanticGpuScheduler().schedule(graphFromDependencies([[1], [0]])),
    /did not schedule component 0 of 2/,
  );
});

Deno.test("GPU wavefront scheduling matches the host across deterministic DAG shapes", async () => {
  const graphs = [
    graphFromDependencies([]),
    ...deterministicDependencyGraphs(64),
    graphFromDependencies(
      Array.from({ length: 256 }, (_, component) => component === 0 ? [] : [component - 1]),
    ),
  ];
  const expected = graphs.map(scheduleSemanticDefinitionWavefronts);
  const actual = await semanticGpuScheduler().scheduleBatch(graphs);
  deepStrictEqual(actual, expected);
});

Deno.test("GPU wavefront plan allocation failure destroys every partial buffer", async () => {
  const allocationFailure = new Error("forced third allocation failure");
  const destroyedBuffers: number[] = [];
  let allocation = 0;
  const failingDevice = {
    limits: {
      maxBufferSize: 1 << 20,
      maxStorageBufferBindingSize: 1 << 20,
      maxComputeWorkgroupsPerDimension: 65_535,
    },
    queue: { writeBuffer() {} },
    pushErrorScope() {},
    popErrorScope: () => Promise.resolve(null),
    createBuffer: () => {
      const bufferIndex = allocation++;
      if (bufferIndex === 2) throw allocationFailure;
      return {
        size: 4,
        destroy: () => destroyedBuffers.push(bufferIndex),
      };
    },
  } as unknown as GPUDevice;

  await rejects(
    GpuSemanticDefinitionWavefrontPlan.create(
      failingDevice,
      {} as GPUComputePipeline,
      {} as GPUBindGroupLayout,
      [graphFromDependencies([[]])],
    ),
    (error: Error) => {
      match(error.message, /forced third allocation failure/);
      equal(error.cause, allocationFailure);
      return true;
    },
  );
  deepStrictEqual(destroyedBuffers, [0, 1]);
});

function semanticGpuScheduler(): GpuSemanticDefinitionWavefrontScheduler {
  if (gpuScheduler === undefined) throw new Error("semantic GPU scheduler was not initialized");
  return gpuScheduler;
}

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

function deterministicDependencyGraphs(count: number): SemanticDefinitionDependencyGraph[] {
  let state = 0x6d2b_79f5;
  const next = (): number => {
    state = Math.imul(state ^ state >>> 15, 1 | state);
    state ^= state + Math.imul(state ^ state >>> 7, 61 | state);
    return (state ^ state >>> 14) >>> 0;
  };
  return Array.from({ length: count }, (_, graphIndex) => {
    const componentCount = 1 + (next() % (graphIndex + 1));
    const dependencies = Array.from({ length: componentCount }, (_, component) => {
      if (component === 0) return [];
      const selected = new Set<number>();
      const dependencyCount = next() % Math.min(4, component + 1);
      while (selected.size < dependencyCount) selected.add(next() % component);
      return [...selected];
    });
    return graphFromDependencies(dependencies);
  });
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
