import { CoreTag, NO_INDEX } from "./abi.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";

const MAXIMUM_UNIQUE_REUSE_ANALYSIS_DEPTH = 256;

interface LocalConsumption {
  readonly valid: boolean;
  readonly maximumPerPath: number;
  readonly caseNodes: ReadonlySet<number>;
}

const EMPTY_CONSUMPTION: LocalConsumption = Object.freeze({
  valid: true,
  maximumPerPath: 0,
  caseNodes: new Set<number>(),
});

export class WasmUniqueReuseAnalysis {
  readonly #module: CompiledModule;
  readonly #nodes: readonly CoreNode[];
  readonly #resultFieldCounts: (number | null | undefined)[];

  constructor(module: CompiledModule, nodes: readonly CoreNode[]) {
    this.#module = module;
    this.#nodes = nodes;
    this.#resultFieldCounts = Array.from({ length: nodes.length }, () => undefined);
  }

  reusableCases(nodeIndex: number, localDepth: number): ReadonlySet<number> | undefined {
    const consumption = this.#localConsumption(nodeIndex, localDepth, false, 0);
    if (
      !consumption.valid || consumption.maximumPerPath > 1 ||
      consumption.caseNodes.size === 0
    ) return undefined;
    return consumption.caseNodes;
  }

  uniqueConstructorFieldCount(nodeIndex: number, analysisDepth = 0): number | undefined {
    if (analysisDepth > MAXIMUM_UNIQUE_REUSE_ANALYSIS_DEPTH) return undefined;
    const cached = this.#resultFieldCounts[nodeIndex];
    if (cached !== undefined) return cached === null ? undefined : cached;

    const node = this.#node(nodeIndex);
    const constructor = this.#constructorApplication(nodeIndex);
    let fieldCount: number | undefined;
    if (constructor !== undefined) {
      fieldCount = constructor.fieldCount;
    } else if (node.tag === CoreTag.If) {
      fieldCount = matchingFieldCount(
        this.uniqueConstructorFieldCount(node.child1, analysisDepth + 1),
        this.uniqueConstructorFieldCount(node.child2, analysisDepth + 1),
      );
    } else if (node.tag === CoreTag.Let) {
      fieldCount = this.uniqueConstructorFieldCount(node.child1, analysisDepth + 1);
    } else if (node.tag === CoreTag.Case) {
      fieldCount = this.#caseAlternativeFieldCount(node, analysisDepth + 1);
    }
    this.#resultFieldCounts[nodeIndex] = fieldCount ?? null;
    return fieldCount;
  }

  #caseAlternativeFieldCount(node: CoreNode, analysisDepth: number): number | undefined {
    if (analysisDepth > MAXIMUM_UNIQUE_REUSE_ANALYSIS_DEPTH) return undefined;
    let fieldCount: number | undefined;
    const alternatives = this.#caseAlternatives(node);
    for (const alternative of alternatives) {
      const armFieldCount = this.uniqueConstructorFieldCount(
        alternative.body,
        analysisDepth + 1,
      );
      if (armFieldCount === undefined) return undefined;
      fieldCount = fieldCount === undefined
        ? armFieldCount
        : matchingFieldCount(fieldCount, armFieldCount);
      if (fieldCount === undefined) return undefined;
    }
    return alternatives.length === 0 ? undefined : fieldCount;
  }

  #constructorApplication(
    nodeIndex: number,
  ): { readonly fieldCount: number } | undefined {
    let fieldCount = 0;
    let baseNode = nodeIndex;
    let base = this.#node(baseNode);
    while (base.tag === CoreTag.Apply) {
      fieldCount += 1;
      if (fieldCount > MAXIMUM_UNIQUE_REUSE_ANALYSIS_DEPTH) return undefined;
      baseNode = base.child0;
      base = this.#node(baseNode);
    }
    if (base.tag !== CoreTag.Constructor) return undefined;
    const arity = this.#module.constructorArities[base.payload];
    if (arity === undefined || arity === 0 || fieldCount !== arity) return undefined;
    return { fieldCount };
  }

  #localConsumption(
    nodeIndex: number,
    localDepth: number,
    insideLambda: boolean,
    analysisDepth: number,
  ): LocalConsumption {
    if (analysisDepth > MAXIMUM_UNIQUE_REUSE_ANALYSIS_DEPTH) {
      return { valid: false, maximumPerPath: 0, caseNodes: new Set() };
    }
    const node = this.#node(nodeIndex);
    if (node.tag === CoreTag.Local) {
      return node.payload === localDepth
        ? { valid: false, maximumPerPath: 0, caseNodes: new Set() }
        : EMPTY_CONSUMPTION;
    }
    switch (node.tag) {
      case CoreTag.Prim:
        throw new Error("WebAssembly unique-reuse analysis received an unlowered primop");
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
        return EMPTY_CONSUMPTION;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        return this.#localConsumption(node.child0, localDepth, insideLambda, analysisDepth + 1);
      case CoreTag.Apply:
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
        return sequentialConsumption(
          this.#localConsumption(node.child0, localDepth, insideLambda, analysisDepth + 1),
          this.#localConsumption(node.child1, localDepth, insideLambda, analysisDepth + 1),
        );
      case CoreTag.If:
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        return sequentialConsumption(
          this.#localConsumption(node.child0, localDepth, insideLambda, analysisDepth + 1),
          alternativeConsumption(
            this.#localConsumption(node.child1, localDepth, insideLambda, analysisDepth + 1),
            this.#localConsumption(node.child2, localDepth, insideLambda, analysisDepth + 1),
          ),
        );
      case CoreTag.Lambda: {
        const body = this.#localConsumption(
          node.child0,
          localDepth + 1,
          true,
          analysisDepth + 1,
        );
        return body.maximumPerPath === 0 && body.valid
          ? body
          : { valid: false, maximumPerPath: 0, caseNodes: new Set() };
      }
      case CoreTag.PatternBind:
        return this.#localConsumption(
          node.child0,
          localDepth + 1,
          insideLambda,
          analysisDepth + 1,
        );
      case CoreTag.Let:
        return sequentialConsumption(
          this.#localConsumption(node.child0, localDepth, insideLambda, analysisDepth + 1),
          this.#localConsumption(
            node.child1,
            localDepth + 1,
            insideLambda,
            analysisDepth + 1,
          ),
        );
      case CoreTag.LetRec:
        return sequentialConsumption(
          this.#localConsumption(node.child0, localDepth + 1, true, analysisDepth + 1),
          this.#localConsumption(
            node.child1,
            localDepth + 1,
            insideLambda,
            analysisDepth + 1,
          ),
        );
      case CoreTag.Case: {
        const scrutinee = this.#node(node.child0);
        const selected = scrutinee.tag === CoreTag.Local &&
            scrutinee.payload === localDepth && !insideLambda
          ? {
            valid: true,
            maximumPerPath: 1,
            caseNodes: new Set([nodeIndex]),
          }
          : this.#localConsumption(
            node.child0,
            localDepth,
            insideLambda,
            analysisDepth + 1,
          );
        let alternatives = EMPTY_CONSUMPTION;
        let sawAlternative = false;
        for (const alternative of this.#caseAlternatives(node)) {
          const body = this.#localConsumption(
            alternative.body,
            localDepth + alternative.binderCount,
            insideLambda,
            analysisDepth + 1,
          );
          alternatives = sawAlternative ? alternativeConsumption(alternatives, body) : body;
          sawAlternative = true;
        }
        return sequentialConsumption(selected, alternatives);
      }
      case CoreTag.CaseArm: {
        const current = this.#localConsumption(
          node.child0,
          localDepth,
          insideLambda,
          analysisDepth + 1,
        );
        if (node.child1 === NO_INDEX) return current;
        return alternativeConsumption(
          current,
          this.#localConsumption(node.child1, localDepth, insideLambda, analysisDepth + 1),
        );
      }
    }
  }

  #node(nodeIndex: number): CoreNode {
    const node = this.#nodes[nodeIndex];
    if (node !== undefined) return node;
    throw new Error(
      `functional WASM unique-reuse analysis node ${nodeIndex} is outside ${this.#nodes.length} resolved nodes`,
    );
  }

  #caseAlternatives(
    node: CoreNode,
  ): readonly CompiledModule["caseAlternatives"][number][] {
    if (
      node.payload > this.#module.caseAlternatives.length ||
      node.child1 > this.#module.caseAlternatives.length - node.payload
    ) {
      throw new Error(
        `functional WASM unique-reuse analysis case alternatives ${node.payload}..${
          node.payload + node.child1
        } exceed ${this.#module.caseAlternatives.length}`,
      );
    }
    return this.#module.caseAlternatives.slice(node.payload, node.payload + node.child1);
  }
}

function matchingFieldCount(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  return left !== undefined && left === right ? left : undefined;
}

function sequentialConsumption(
  left: LocalConsumption,
  right: LocalConsumption,
): LocalConsumption {
  return {
    valid: left.valid && right.valid,
    maximumPerPath: left.maximumPerPath + right.maximumPerPath,
    caseNodes: mergedCaseNodes(left.caseNodes, right.caseNodes),
  };
}

function alternativeConsumption(
  left: LocalConsumption,
  right: LocalConsumption,
): LocalConsumption {
  return {
    valid: left.valid && right.valid,
    maximumPerPath: Math.max(left.maximumPerPath, right.maximumPerPath),
    caseNodes: mergedCaseNodes(left.caseNodes, right.caseNodes),
  };
}

function mergedCaseNodes(
  left: ReadonlySet<number>,
  right: ReadonlySet<number>,
): ReadonlySet<number> {
  return new Set([...left, ...right]);
}
