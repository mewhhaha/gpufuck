import { FUNCTIONAL_NO_INDEX, FunctionalCoreTag } from "./abi.ts";
import type { FunctionalCoreNode } from "./compiler_module.ts";

export class FunctionalWasmCaptureAnalysis {
  readonly #nodes: readonly FunctionalCoreNode[];
  readonly #freeLocalDepths: (readonly number[] | undefined)[];

  constructor(nodes: readonly FunctionalCoreNode[]) {
    this.#nodes = nodes;
    this.#freeLocalDepths = Array.from({ length: nodes.length }, () => undefined);
  }

  freeLocalDepths(nodeIndex: number): readonly number[] {
    const cached = this.#freeLocalDepths[nodeIndex];
    if (cached !== undefined) return cached;

    const node = this.#node(nodeIndex);
    let depths: readonly number[];
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.SignedInteger64:
      case FunctionalCoreTag.Float32:
      case FunctionalCoreTag.Float64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Global:
      case FunctionalCoreTag.Constructor:
        depths = [];
        break;
      case FunctionalCoreTag.Local:
        depths = [node.payload];
        break;
      case FunctionalCoreTag.Lambda:
      case FunctionalCoreTag.PatternBind:
        depths = removeBoundLocals(this.freeLocalDepths(node.child0), 1);
        break;
      case FunctionalCoreTag.Apply:
      case FunctionalCoreTag.Binary:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          this.freeLocalDepths(node.child1),
        );
        break;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
        depths = this.freeLocalDepths(node.child0);
        break;
      case FunctionalCoreTag.Let:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          removeBoundLocals(this.freeLocalDepths(node.child1), 1),
        );
        break;
      case FunctionalCoreTag.LetRec:
        depths = mergeLocalDepths(
          removeBoundLocals(this.freeLocalDepths(node.child0), 1),
          removeBoundLocals(this.freeLocalDepths(node.child1), 1),
        );
        break;
      case FunctionalCoreTag.If:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          this.freeLocalDepths(node.child1),
          this.freeLocalDepths(node.child2),
        );
        break;
      case FunctionalCoreTag.Case:
      case FunctionalCoreTag.CaseArm:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          node.child1 === FUNCTIONAL_NO_INDEX ? [] : this.freeLocalDepths(node.child1),
        );
        break;
    }
    const result = Object.freeze([...depths]);
    this.#freeLocalDepths[nodeIndex] = result;
    return result;
  }

  localReferenceCount(nodeIndex: number, localDepth: number): number {
    const node = this.#node(nodeIndex);
    if (node.tag === FunctionalCoreTag.Local) {
      return node.payload === localDepth ? 1 : 0;
    }
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.SignedInteger64:
      case FunctionalCoreTag.Float32:
      case FunctionalCoreTag.Float64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Global:
      case FunctionalCoreTag.Constructor:
        return 0;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
        return this.localReferenceCount(node.child0, localDepth);
      case FunctionalCoreTag.Apply:
      case FunctionalCoreTag.Binary:
        return this.localReferenceCount(node.child0, localDepth) +
          this.localReferenceCount(node.child1, localDepth);
      case FunctionalCoreTag.If:
        return this.localReferenceCount(node.child0, localDepth) +
          this.localReferenceCount(node.child1, localDepth) +
          this.localReferenceCount(node.child2, localDepth);
      case FunctionalCoreTag.Lambda:
      case FunctionalCoreTag.PatternBind:
        return this.localReferenceCount(node.child0, localDepth + 1);
      case FunctionalCoreTag.Let:
        return this.localReferenceCount(node.child0, localDepth) +
          this.localReferenceCount(node.child1, localDepth + 1);
      case FunctionalCoreTag.LetRec:
        return this.localReferenceCount(node.child0, localDepth + 1) +
          this.localReferenceCount(node.child1, localDepth + 1);
      case FunctionalCoreTag.Case:
      case FunctionalCoreTag.CaseArm:
        return this.localReferenceCount(node.child0, localDepth) +
          (node.child1 === FUNCTIONAL_NO_INDEX
            ? 0
            : this.localReferenceCount(node.child1, localDepth));
    }
  }

  #node(index: number): FunctionalCoreNode {
    const node = this.#nodes[index];
    if (node === undefined) {
      throw new Error(
        `functional WASM capture analysis node ${index} is outside ${this.#nodes.length} resolved nodes`,
      );
    }
    return node;
  }
}

function mergeLocalDepths(...groups: readonly (readonly number[])[]): readonly number[] {
  const merged = new Set<number>();
  for (const depths of groups) {
    for (const depth of depths) merged.add(depth);
  }
  return [...merged].sort((left, right) => left - right);
}

function removeBoundLocals(depths: readonly number[], binderCount: number): readonly number[] {
  const free: number[] = [];
  for (const depth of depths) {
    if (depth >= binderCount) free.push(depth - binderCount);
  }
  return free;
}
