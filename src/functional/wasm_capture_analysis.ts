import { CoreTag, NO_INDEX } from "./abi.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";

export class WasmCaptureAnalysis {
  readonly #module: CompiledModule;
  readonly #nodes: readonly CoreNode[];
  readonly #freeLocalDepths: (readonly number[] | undefined)[];

  constructor(module: CompiledModule, nodes: readonly CoreNode[]) {
    this.#module = module;
    this.#nodes = nodes;
    this.#freeLocalDepths = Array.from({ length: nodes.length }, () => undefined);
  }

  freeLocalDepths(nodeIndex: number): readonly number[] {
    const cached = this.#freeLocalDepths[nodeIndex];
    if (cached !== undefined) return cached;

    const node = this.#node(nodeIndex);
    let depths: readonly number[];
    switch (node.tag) {
      case CoreTag.Prim:
        throw new Error("functional Wasm capture analysis received an unlowered primop");
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Text:
      case CoreTag.Bytes:
      case CoreTag.RuntimeFault:
      case CoreTag.StoreEmpty:
      case CoreTag.Global:
      case CoreTag.Constructor:
        depths = [];
        break;
      case CoreTag.Local:
        depths = [node.payload];
        break;
      case CoreTag.Lambda:
      case CoreTag.PatternBind:
        depths = removeBoundLocals(this.freeLocalDepths(node.child0), 1);
        break;
      case CoreTag.Apply:
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          this.freeLocalDepths(node.child1),
        );
        break;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        depths = this.freeLocalDepths(node.child0);
        break;
      case CoreTag.Let:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          removeBoundLocals(this.freeLocalDepths(node.child1), 1),
        );
        break;
      case CoreTag.LetRec:
        depths = mergeLocalDepths(
          removeBoundLocals(this.freeLocalDepths(node.child0), 1),
          removeBoundLocals(this.freeLocalDepths(node.child1), 1),
        );
        break;
      case CoreTag.If:
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          this.freeLocalDepths(node.child1),
          this.freeLocalDepths(node.child2),
        );
        break;
      case CoreTag.CaseArm:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          node.child1 === NO_INDEX ? [] : this.freeLocalDepths(node.child1),
        );
        break;
      case CoreTag.Case:
        depths = mergeLocalDepths(
          this.freeLocalDepths(node.child0),
          ...this.#caseAlternatives(node).map((alternative) =>
            removeBoundLocals(
              this.freeLocalDepths(alternative.body),
              alternative.binderCount,
            )
          ),
        );
        break;
    }
    const result = Object.freeze([...depths]);
    this.#freeLocalDepths[nodeIndex] = result;
    return result;
  }

  localReferenceCount(nodeIndex: number, localDepth: number): number {
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.Local) {
      return node.payload === localDepth ? 1 : 0;
    }
    switch (node.tag) {
      case CoreTag.Prim:
        throw new Error("functional Wasm capture analysis received an unlowered primop");
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Text:
      case CoreTag.Bytes:
      case CoreTag.RuntimeFault:
      case CoreTag.StoreEmpty:
      case CoreTag.Global:
      case CoreTag.Constructor:
        return 0;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        return this.localReferenceCount(node.child0, localDepth);
      case CoreTag.Apply:
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
        return this.localReferenceCount(node.child0, localDepth) +
          this.localReferenceCount(node.child1, localDepth);
      case CoreTag.If:
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        return this.localReferenceCount(node.child0, localDepth) +
          this.localReferenceCount(node.child1, localDepth) +
          this.localReferenceCount(node.child2, localDepth);
      case CoreTag.Lambda:
      case CoreTag.PatternBind:
        return this.localReferenceCount(node.child0, localDepth + 1);
      case CoreTag.Let:
        return this.localReferenceCount(node.child0, localDepth) +
          this.localReferenceCount(node.child1, localDepth + 1);
      case CoreTag.LetRec:
        return this.localReferenceCount(node.child0, localDepth + 1) +
          this.localReferenceCount(node.child1, localDepth + 1);
      case CoreTag.CaseArm:
        return this.localReferenceCount(node.child0, localDepth) +
          (node.child1 === NO_INDEX ? 0 : this.localReferenceCount(node.child1, localDepth));
      case CoreTag.Case:
        return this.localReferenceCount(node.child0, localDepth) +
          this.#caseAlternatives(node).reduce(
            (total, alternative) =>
              total +
              this.localReferenceCount(
                alternative.body,
                localDepth + alternative.binderCount,
              ),
            0,
          );
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
    while (base.tag === CoreTag.Apply) {
      arguments_.push(base.child1);
      baseIndex = base.child0;
      base = this.#node(baseIndex);
    }
    if (
      base.tag === CoreTag.Local && base.payload === localDepth &&
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
    if (base.tag === CoreTag.Local && base.payload === localDepth) {
      return true;
    }

    const node = this.#node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Prim:
        throw new Error("functional Wasm capture analysis received an unlowered primop");
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Text:
      case CoreTag.Bytes:
      case CoreTag.RuntimeFault:
      case CoreTag.StoreEmpty:
      case CoreTag.Local:
      case CoreTag.Global:
      case CoreTag.Constructor:
        return false;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth,
          parameterCount,
          insideLambda,
        );
      case CoreTag.Apply:
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
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
      case CoreTag.If:
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
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
      case CoreTag.Lambda:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth + 1,
          parameterCount,
          true,
        );
      case CoreTag.PatternBind:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth + 1,
          parameterCount,
          insideLambda,
        );
      case CoreTag.Let:
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
      case CoreTag.LetRec:
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
      case CoreTag.CaseArm:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth,
          parameterCount,
          insideLambda,
        ) || node.child1 !== NO_INDEX &&
            this.#containsUnsaturatedLocalReference(
              node.child1,
              localDepth,
              parameterCount,
              insideLambda,
            );
      case CoreTag.Case:
        return this.#containsUnsaturatedLocalReference(
          node.child0,
          localDepth,
          parameterCount,
          insideLambda,
        ) || this.#caseAlternatives(node).some((alternative) =>
          this.#containsUnsaturatedLocalReference(
            alternative.body,
            localDepth + alternative.binderCount,
            parameterCount,
            insideLambda,
          )
        );
    }
  }

  #caseAlternatives(
    node: CoreNode,
  ): readonly CompiledModule["caseAlternatives"][number][] {
    if (
      node.payload > this.#module.caseAlternatives.length ||
      node.child1 > this.#module.caseAlternatives.length - node.payload
    ) {
      throw new Error(
        `functional WASM capture analysis case alternatives ${node.payload}..${
          node.payload + node.child1
        } exceed ${this.#module.caseAlternatives.length}`,
      );
    }
    return this.#module.caseAlternatives.slice(node.payload, node.payload + node.child1);
  }

  #node(index: number): CoreNode {
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
