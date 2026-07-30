import { CoreTag, EvaluationMode } from "./abi.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";

export interface WasmCoreIndex {
  readonly directCallees: ReadonlySet<number>;
  readonly recursiveLambdas: ReadonlySet<number>;
  readonly recursiveLambdaOwners: ReadonlyMap<number, number>;
  readonly referencedNullaryConstructors: ReadonlySet<number>;
  readonly hasLazyEvaluationBoundary: boolean;
}

export function indexWasmCore(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): WasmCoreIndex {
  const directCallees = new Set<number>();
  const recursiveLambdas = new Set<number>();
  const recursiveLambdaOwners = new Map<number, number>();
  const referencedNullaryConstructors = new Set<number>();
  let hasLazyEvaluationBoundary = false;

  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.tag === CoreTag.Apply) directCallees.add(node.child0);
    if (node.tag === CoreTag.LetRec) {
      recursiveLambdas.add(node.child0);
      recursiveLambdaOwners.set(node.child0, nodeIndex);
    }
    if (
      node.tag === CoreTag.Constructor &&
      module.constructorArities[node.payload] === 0
    ) {
      referencedNullaryConstructors.add(node.payload);
    }
    if (
      (node.tag === CoreTag.Apply || node.tag === CoreTag.Let) &&
      node.evaluationMode === EvaluationMode.LazyCallByNeed
    ) {
      hasLazyEvaluationBoundary = true;
    }
  }

  return Object.freeze({
    directCallees,
    recursiveLambdas,
    recursiveLambdaOwners,
    referencedNullaryConstructors,
    hasLazyEvaluationBoundary,
  });
}
