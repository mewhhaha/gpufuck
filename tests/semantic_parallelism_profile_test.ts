import { deepStrictEqual } from "node:assert/strict";

import { FunctionalCoreTag, FunctionalEvaluationMode } from "../functional.ts";
import type { LazuliCoreNode } from "../src/semantic/compiler_module.ts";
import { semanticDefinitionParallelismProfile } from "../src/semantic/definition_wavefront.ts";

Deno.test("definition parallelism profiles report work, span, width, and recursive bottlenecks", () => {
  const nodes = [
    globalNode(1),
    globalNode(2),
    integerNode(),
    globalNode(2),
    globalNode(5),
    globalNode(4),
  ];

  deepStrictEqual(
    semanticDefinitionParallelismProfile([0, 1, 2, 3, 4, 5], nodes),
    {
      definitionCount: 6,
      componentCount: 5,
      waveCount: 3,
      totalWork: 6,
      criticalPathWork: 3,
      availableParallelism: 2,
      maximumWavefrontComponents: 2,
      maximumWavefrontDefinitions: 3,
      largestComponentDefinitions: 2,
      wavefrontWork: [3, 2, 1],
    },
  );
});

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
