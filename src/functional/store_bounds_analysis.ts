import { BinaryOperator, CoreTag, NO_INDEX } from "./abi.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";

type Reference =
  | { readonly kind: "binding"; readonly binding: number }
  | { readonly kind: "global"; readonly definition: number };

type Index = Reference | { readonly kind: "constant"; readonly value: number };

interface UpperBound {
  readonly store: Reference;
  readonly index: Index;
}

interface ExactLength {
  readonly store: Reference;
  readonly length: number;
}

interface BoundsFacts {
  readonly upperBounds: readonly UpperBound[];
  readonly nonNegative: readonly Index[];
  readonly exactLengths: readonly ExactLength[];
}

const NO_FACTS: BoundsFacts = {
  upperBounds: [],
  nonNegative: [],
  exactLengths: [],
};

/**
 * Finds Store reads whose enclosing conditions prove both sides of the runtime bounds check.
 * The result is conservative: a shared Core node is returned only when every traversal proves it.
 */
export function analyzeProvenStoreReads(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): ReadonlySet<number> {
  if (!nodes.some((node) => node.tag === CoreTag.StoreRead)) return new Set();
  const analysis = new StoreBoundsAnalysis(module, nodes);
  return analysis.analyze();
}

class StoreBoundsAnalysis {
  readonly #module: CompiledModule;
  readonly #nodes: readonly CoreNode[];
  readonly #provenReads = new Set<number>();
  readonly #unprovenReads = new Set<number>();
  #nextBinding = 0;

  constructor(module: CompiledModule, nodes: readonly CoreNode[]) {
    this.#module = module;
    this.#nodes = nodes;
  }

  analyze(): ReadonlySet<number> {
    for (const root of this.#module.definitionRoots) {
      this.#visit(root, [], NO_FACTS);
    }
    for (const node of this.#unprovenReads) this.#provenReads.delete(node);
    return new Set(this.#provenReads);
  }

  #visit(nodeIndex: number, environment: readonly number[], facts: BoundsFacts): void {
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.StoreRead) {
      if (this.#readIsProven(node, environment, facts)) this.#provenReads.add(nodeIndex);
      else this.#unprovenReads.add(nodeIndex);
    }

    switch (node.tag) {
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
        return;
      case CoreTag.Lambda:
      case CoreTag.PatternBind:
        this.#visit(node.child0, this.#extend(environment, 1), facts);
        return;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        this.#visit(node.child0, environment, facts);
        return;
      case CoreTag.Apply:
        this.#visit(node.child0, environment, facts);
        this.#visit(node.child1, environment, facts);
        return;
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
        this.#visit(node.child0, environment, facts);
        this.#visit(node.child1, environment, facts);
        return;
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        this.#visit(node.child0, environment, facts);
        this.#visit(node.child1, environment, facts);
        this.#visit(node.child2, environment, facts);
        return;
      case CoreTag.Let:
        this.#visit(node.child0, environment, facts);
        this.#visit(node.child1, this.#extend(environment, 1), facts);
        return;
      case CoreTag.LetRec: {
        const recursiveEnvironment = this.#extend(environment, 1);
        this.#visit(node.child0, recursiveEnvironment, facts);
        this.#visit(node.child1, recursiveEnvironment, facts);
        return;
      }
      case CoreTag.If:
        this.#visit(node.child0, environment, facts);
        this.#visit(
          node.child1,
          environment,
          mergeFacts(facts, this.#conditionFacts(node.child0, environment)),
        );
        this.#visit(node.child2, environment, facts);
        return;
      case CoreTag.Case:
        this.#visit(node.child0, environment, facts);
        for (const alternative of this.#caseAlternatives(node)) {
          this.#visit(
            alternative.body,
            this.#extend(environment, alternative.binderCount),
            facts,
          );
        }
        return;
      case CoreTag.CaseArm:
        this.#visit(node.child0, environment, facts);
        if (node.child1 !== NO_INDEX) this.#visit(node.child1, environment, facts);
        return;
      case CoreTag.Prim:
        throw new Error("Store bounds analysis received an unlowered primop");
    }
  }

  #conditionFacts(nodeIndex: number, environment: readonly number[]): BoundsFacts {
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.If) {
      const alternate = this.#node(node.child2);
      if (alternate.tag === CoreTag.Boolean && alternate.payload === 0) {
        return mergeFacts(
          this.#conditionFacts(node.child0, environment),
          this.#conditionFacts(node.child1, environment),
        );
      }
      return NO_FACTS;
    }
    if (node.tag !== CoreTag.Binary) return NO_FACTS;

    const left = this.#index(node.child0, environment);
    const right = this.#index(node.child1, environment);
    const leftStore = this.#storeLength(node.child0, environment);
    const rightStore = this.#storeLength(node.child1, environment);
    if (node.payload === BinaryOperator.Less && left !== undefined && rightStore !== undefined) {
      return { ...NO_FACTS, upperBounds: [{ store: rightStore, index: left }] };
    }
    if (node.payload === BinaryOperator.Greater && leftStore !== undefined && right !== undefined) {
      return { ...NO_FACTS, upperBounds: [{ store: leftStore, index: right }] };
    }
    if (
      node.payload === BinaryOperator.LessEqual && isZero(left) && right !== undefined ||
      node.payload === BinaryOperator.GreaterEqual && left !== undefined && isZero(right)
    ) {
      const index = node.payload === BinaryOperator.LessEqual ? right : left;
      return index === undefined ? NO_FACTS : { ...NO_FACTS, nonNegative: [index] };
    }
    if (node.payload !== BinaryOperator.Equal) return NO_FACTS;
    const exact = exactLength(leftStore, right) ?? exactLength(rightStore, left);
    return exact === undefined ? NO_FACTS : { ...NO_FACTS, exactLengths: [exact] };
  }

  #readIsProven(node: CoreNode, environment: readonly number[], facts: BoundsFacts): boolean {
    const store = this.#reference(node.child0, environment);
    const index = this.#index(node.child1, environment);
    if (store === undefined || index === undefined) return false;

    if (index.kind === "constant") {
      if (index.value < 0) return false;
      return facts.exactLengths.some((fact) =>
        sameReference(fact.store, store) && index.value < fact.length
      ) || facts.upperBounds.some((fact) =>
        sameReference(fact.store, store) && sameIndex(fact.index, index)
      );
    }
    return facts.upperBounds.some((fact) =>
      sameReference(fact.store, store) && sameIndex(fact.index, index)
    ) && facts.nonNegative.some((fact) => sameIndex(fact, index));
  }

  #storeLength(nodeIndex: number, environment: readonly number[]): Reference | undefined {
    const node = this.#node(nodeIndex);
    if (node.tag !== CoreTag.StoreLength) return undefined;
    return this.#reference(node.child0, environment);
  }

  #index(nodeIndex: number, environment: readonly number[]): Index | undefined {
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.Integer) return { kind: "constant", value: node.payload | 0 };
    return this.#reference(nodeIndex, environment);
  }

  #reference(nodeIndex: number, environment: readonly number[]): Reference | undefined {
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.Global) return { kind: "global", definition: node.payload };
    if (node.tag !== CoreTag.Local) return undefined;
    const binding = environment[node.payload];
    return binding === undefined ? undefined : { kind: "binding", binding };
  }

  #extend(environment: readonly number[], count: number): readonly number[] {
    const bindings: number[] = [];
    for (let index = 0; index < count; index += 1) {
      bindings.push(this.#nextBinding);
      this.#nextBinding += 1;
    }
    return [...bindings.reverse(), ...environment];
  }

  #caseAlternatives(node: CoreNode): CompiledModule["caseAlternatives"] {
    if (
      node.payload > this.#module.caseAlternatives.length ||
      node.child1 > this.#module.caseAlternatives.length - node.payload
    ) {
      throw new Error(
        `Store bounds analysis case alternatives ${node.payload}..${
          node.payload + node.child1
        } exceed ${this.#module.caseAlternatives.length}`,
      );
    }
    return this.#module.caseAlternatives.slice(node.payload, node.payload + node.child1);
  }

  #node(nodeIndex: number): CoreNode {
    const node = this.#nodes[nodeIndex];
    if (node === undefined) {
      throw new Error(`Store bounds analysis references missing Core node ${nodeIndex}`);
    }
    return node;
  }
}

function mergeFacts(left: BoundsFacts, right: BoundsFacts): BoundsFacts {
  return {
    upperBounds: [...left.upperBounds, ...right.upperBounds],
    nonNegative: [...left.nonNegative, ...right.nonNegative],
    exactLengths: [...left.exactLengths, ...right.exactLengths],
  };
}

function exactLength(
  store: Reference | undefined,
  length: Index | undefined,
): ExactLength | undefined {
  if (store === undefined || length?.kind !== "constant" || length.value < 0) return undefined;
  return { store, length: length.value };
}

function isZero(index: Index | undefined): boolean {
  return index?.kind === "constant" && index.value === 0;
}

function sameIndex(left: Index, right: Index): boolean {
  if (left.kind === "constant" || right.kind === "constant") {
    return left.kind === "constant" && right.kind === "constant" && left.value === right.value;
  }
  return sameReference(left, right);
}

function sameReference(left: Reference, right: Reference): boolean {
  if (left.kind === "binding" || right.kind === "binding") {
    return left.kind === "binding" && right.kind === "binding" && left.binding === right.binding;
  }
  return left.definition === right.definition;
}
