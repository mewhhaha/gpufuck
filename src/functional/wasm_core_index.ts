import { CoreTag, EvaluationMode, NO_INDEX } from "./abi.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";

export interface WasmCoreIndex {
  readonly definitionByRoot: ReadonlyMap<number, number>;
  readonly directCallees: ReadonlySet<number>;
  readonly directOnlyDefinitions: ReadonlySet<number>;
  readonly parents: readonly (readonly WasmCoreParent[])[];
  readonly recursiveLambdas: ReadonlySet<number>;
  readonly recursiveLambdaOwners: ReadonlyMap<number, number>;
  readonly referencedNullaryConstructors: ReadonlySet<number>;
  readonly hasLazyEvaluationBoundary: boolean;
}

export interface WasmCoreParent {
  readonly parent: number;
  readonly child: number;
}

export function indexWasmCore(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): WasmCoreIndex {
  const definitionByRoot = new Map<number, number>();
  const directCallees = new Set<number>();
  const recursiveLambdas = new Set<number>();
  const recursiveLambdaOwners = new Map<number, number>();
  const referencedNullaryConstructors = new Set<number>();
  const globalReferences = Array.from(
    { length: module.definitionCount },
    () => [] as number[],
  );
  const parents = Array.from(
    { length: nodes.length },
    () => [] as WasmCoreParent[],
  );
  let hasLazyEvaluationBoundary = false;

  for (const [definition, root] of module.definitionRoots.entries()) {
    if (root >= nodes.length) {
      throw new Error(
        `functional Wasm Core index definition d${definition} root ${root} exceeds ${nodes.length} resolved nodes`,
      );
    }
    definitionByRoot.set(root, definition);
  }

  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.tag === CoreTag.Case) {
      addCoreParent(nodes, parents, nodeIndex, 0, node.child0);
      for (let offset = 0; offset < node.child1; offset += 1) {
        const alternativeIndex = node.payload + offset;
        const alternative = module.caseAlternatives[alternativeIndex];
        if (alternative === undefined) {
          throw new Error(
            `functional Wasm Core index node ${nodeIndex} references missing case alternative ${alternativeIndex}`,
          );
        }
        addCoreParent(nodes, parents, nodeIndex, 1, alternative.body);
      }
    } else {
      for (const [childPosition, child] of coreChildren(node)) {
        addCoreParent(nodes, parents, nodeIndex, childPosition, child);
      }
    }
    if (node.tag === CoreTag.Apply) directCallees.add(node.child0);
    if (node.tag === CoreTag.Global && node.payload < globalReferences.length) {
      globalReferences[node.payload]!.push(nodeIndex);
    }
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

  const excludedDirectDefinitions = new Set([
    module.entryDefinition,
    ...module.wasmExports.map((exported) => exported.definitionIndex),
    ...module.hostDefinitions.flatMap((binding) => {
      const definition = module.definitionNames.indexOf(binding.definition);
      return definition < 0 ? [] : [definition];
    }),
  ]);
  const directOnlyDefinitions = new Set<number>();
  for (const [definition, root] of module.definitionRoots.entries()) {
    if (excludedDirectDefinitions.has(definition)) continue;
    const parameterCount = lambdaParameterCount(nodes, root);
    if (parameterCount === undefined || parameterCount === 0) continue;
    const references = globalReferences[definition]!;
    if (
      references.length > 0 &&
      references.every((reference) =>
        everyUseIsSaturated(reference, parameterCount, nodes, parents)
      )
    ) {
      directOnlyDefinitions.add(definition);
    }
  }

  return Object.freeze({
    definitionByRoot,
    directCallees,
    directOnlyDefinitions,
    parents: Object.freeze(
      parents.map((uses) => Object.freeze(uses)),
    ),
    recursiveLambdas,
    recursiveLambdaOwners,
    referencedNullaryConstructors,
    hasLazyEvaluationBoundary,
  });
}

function addCoreParent(
  nodes: readonly CoreNode[],
  parents: WasmCoreParent[][],
  nodeIndex: number,
  childPosition: 0 | 1 | 2,
  child: number,
): void {
  if (child === NO_INDEX) return;
  if (child >= nodes.length) {
    throw new Error(
      `functional Wasm Core index node ${nodeIndex} child${childPosition} ${child} exceeds ${nodes.length} resolved nodes`,
    );
  }
  parents[child]!.push({ parent: nodeIndex, child: childPosition });
}

function lambdaParameterCount(
  nodes: readonly CoreNode[],
  root: number,
): number | undefined {
  let nodeIndex = root;
  let parameterCount = 0;
  while (nodes[nodeIndex]?.tag === CoreTag.Lambda) {
    parameterCount += 1;
    nodeIndex = nodes[nodeIndex]!.child0;
  }
  return parameterCount === 0 ? undefined : parameterCount;
}

function everyUseIsSaturated(
  reference: number,
  parameterCount: number,
  nodes: readonly CoreNode[],
  parents: readonly (readonly WasmCoreParent[])[],
): boolean {
  const pending = [{ node: reference, suppliedArguments: 0 }];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const use = pending.pop()!;
    const key = `${use.node}:${use.suppliedArguments}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (use.suppliedArguments === parameterCount) continue;
    const uses = parents[use.node]!;
    if (uses.length === 0) return false;
    for (const parent of uses) {
      if (
        parent.child !== 0 ||
        nodes[parent.parent]?.tag !== CoreTag.Apply
      ) return false;
      pending.push({
        node: parent.parent,
        suppliedArguments: use.suppliedArguments + 1,
      });
    }
  }
  return true;
}

function coreChildren(
  node: CoreNode,
): readonly (readonly [0 | 1 | 2, number])[] {
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
      return [];
    case CoreTag.Prim:
      throw new Error("functional Wasm Core index received an unlowered primop");
    case CoreTag.Lambda:
    case CoreTag.Unary:
    case CoreTag.NumericConvert:
    case CoreTag.PatternBind:
    case CoreTag.StoreLength:
      return [[0, node.child0]];
    case CoreTag.Apply:
    case CoreTag.Let:
    case CoreTag.LetRec:
    case CoreTag.Binary:
    case CoreTag.BufferAppend:
    case CoreTag.CaseArm:
    case CoreTag.StoreNew:
    case CoreTag.StoreRead:
      return [[0, node.child0], [1, node.child1]];
    case CoreTag.Case:
      throw new Error("functional Wasm Core index reached a packed case through generic children");
    case CoreTag.If:
    case CoreTag.StoreWrite:
    case CoreTag.StoreGrow:
      return [[0, node.child0], [1, node.child1], [2, node.child2]];
  }
}
