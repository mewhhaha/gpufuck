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
      case FunctionalCoreTag.WholeNumberF64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Text:
      case FunctionalCoreTag.Bytes:
      case FunctionalCoreTag.RuntimeFault:
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
      case FunctionalCoreTag.BufferAppend:
      case FunctionalCoreTag.StoreNew:
      case FunctionalCoreTag.StoreRead:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          this.freeLocalDepths(node.child1),
        );
        break;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
      case FunctionalCoreTag.StoreLength:
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
      case FunctionalCoreTag.StoreWrite:
      case FunctionalCoreTag.StoreGrow:
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
      case FunctionalCoreTag.WholeNumberF64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Text:
      case FunctionalCoreTag.Bytes:
      case FunctionalCoreTag.RuntimeFault:
      case FunctionalCoreTag.Global:
      case FunctionalCoreTag.Constructor:
        return 0;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
      case FunctionalCoreTag.StoreLength:
        return this.localReferenceCount(node.child0, localDepth);
      case FunctionalCoreTag.Apply:
      case FunctionalCoreTag.Binary:
      case FunctionalCoreTag.BufferAppend:
      case FunctionalCoreTag.StoreNew:
      case FunctionalCoreTag.StoreRead:
        return this.localReferenceCount(node.child0, localDepth) +
          this.localReferenceCount(node.child1, localDepth);
      case FunctionalCoreTag.If:
      case FunctionalCoreTag.StoreWrite:
      case FunctionalCoreTag.StoreGrow:
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

  hasOnlySaturatedLocalReferences(
    nodeIndex: number,
    localDepth: number,
    parameterCount: number,
  ): boolean {
    return !this.#containsUnsaturatedLocalReference(
      nodeIndex,
      localDepth,
      parameterCount,
      false,
    );
  }

  #containsUnsaturatedLocalReference(
    nodeIndex: number,
    localDepth: number,
    parameterCount: number,
    insideLambda: boolean,
  ): boolean {
    const arguments_: number[] = [];
    let baseIndex = nodeIndex;
    let base = this.#node(baseIndex);
    while (base.tag === FunctionalCoreTag.Apply) {
      arguments_.push(base.child1);
      baseIndex = base.child0;
      base = this.#node(baseIndex);
    }
    if (
      base.tag === FunctionalCoreTag.Local && base.payload === localDepth &&
      arguments_.length === parameterCount
    ) {
      if (insideLambda) return true;
      return arguments_.some((argument) =>
        this.#containsUnsaturatedLocalReference(
          argument,
          localDepth,
          parameterCount,
          insideLambda,
        )
      );
    }
    if (base.tag === FunctionalCoreTag.Local && base.payload === localDepth) {
      return true;
    }

    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.SignedInteger64:
      case FunctionalCoreTag.Float32:
      case FunctionalCoreTag.Float64:
      case FunctionalCoreTag.WholeNumberF64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Text:
      case FunctionalCoreTag.Bytes:
      case FunctionalCoreTag.RuntimeFault:
      case FunctionalCoreTag.Local:
      case FunctionalCoreTag.Global:
      case FunctionalCoreTag.Constructor:
        return false;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
      case FunctionalCoreTag.StoreLength:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth,
          parameterCount,
          insideLambda,
        );
      case FunctionalCoreTag.Apply:
      case FunctionalCoreTag.Binary:
      case FunctionalCoreTag.BufferAppend:
      case FunctionalCoreTag.StoreNew:
      case FunctionalCoreTag.StoreRead:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth,
          parameterCount,
          insideLambda,
        ) || this.#containsUnsaturatedLocalReference(
          node.child1,
          localDepth,
          parameterCount,
          insideLambda,
        );
      case FunctionalCoreTag.If:
      case FunctionalCoreTag.StoreWrite:
      case FunctionalCoreTag.StoreGrow:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth,
          parameterCount,
          insideLambda,
        ) || this.#containsUnsaturatedLocalReference(
          node.child1,
          localDepth,
          parameterCount,
          insideLambda,
        ) || this.#containsUnsaturatedLocalReference(
          node.child2,
          localDepth,
          parameterCount,
          insideLambda,
        );
      case FunctionalCoreTag.Lambda:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth + 1,
          parameterCount,
          true,
        );
      case FunctionalCoreTag.PatternBind:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth + 1,
          parameterCount,
          insideLambda,
        );
      case FunctionalCoreTag.Let:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth,
          parameterCount,
          insideLambda,
        ) || this.#containsUnsaturatedLocalReference(
          node.child1,
          localDepth + 1,
          parameterCount,
          insideLambda,
        );
      case FunctionalCoreTag.LetRec:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth + 1,
          parameterCount,
          true,
        ) || this.#containsUnsaturatedLocalReference(
          node.child1,
          localDepth + 1,
          parameterCount,
          insideLambda,
        );
      case FunctionalCoreTag.Case:
      case FunctionalCoreTag.CaseArm:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth,
          parameterCount,
          insideLambda,
        ) || node.child1 !== FUNCTIONAL_NO_INDEX &&
            this.#containsUnsaturatedLocalReference(
              node.child1,
              localDepth,
              parameterCount,
              insideLambda,
            );
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
