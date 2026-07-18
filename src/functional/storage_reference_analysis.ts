import { FUNCTIONAL_NO_INDEX, FunctionalCoreTag } from "./abi.ts";
import type { FunctionalCoreNode, GpuFunctionalModule } from "./compiler_module.ts";
import type { FunctionalStorageDecision } from "./storage_plan.ts";
import type { FunctionalWasmCaptureAnalysis } from "./wasm_capture_analysis.ts";

export interface FunctionalStorageReference {
  readonly owner: string;
  readonly target: string;
  readonly coreNode: number;
  readonly reason: string;
}

export function analyzeFunctionalStorageReferences(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  decisions: readonly FunctionalStorageDecision[],
  captureAnalysis: FunctionalWasmCaptureAnalysis,
): readonly FunctionalStorageReference[] {
  const storageNameByNode = new Map<number, string>();
  const decisionByNode = new Map<number, FunctionalStorageDecision>();
  for (const decision of decisions) {
    const name = `${decision.valueKind}:${decision.coreNode}`;
    const existing = decisionByNode.get(decision.coreNode);
    if (
      existing !== undefined &&
      (existing.valueKind !== decision.valueKind || existing.storage !== decision.storage ||
        existing.escapeStorage !== decision.escapeStorage ||
        existing.capturedLocalCount !== decision.capturedLocalCount)
    ) {
      throw new Error(
        `functional storage reference analysis gives core node ${decision.coreNode} conflicting ${
          JSON.stringify(`${existing.valueKind}:${existing.storage}`)
        } and ${JSON.stringify(`${decision.valueKind}:${decision.storage}`)} decisions`,
      );
    }
    decisionByNode.set(decision.coreNode, decision);
    storageNameByNode.set(decision.coreNode, name);
  }
  const globalStorageNames = module.definitionRoots.map((root) =>
    storageTarget(root, [], nodes, storageNameByNode, [])
  );
  const globalReferencesByNode = new Map<number, readonly number[]>();
  const references: FunctionalStorageReference[] = [];
  const recorded = new Set<string>();
  const record = (
    owner: string,
    target: string | undefined,
    coreNode: number,
    reason: string,
  ): void => {
    if (target === undefined) return;
    const key = JSON.stringify([owner, target]);
    if (recorded.has(key)) return;
    recorded.add(key);
    references.push({ owner, target, coreNode, reason });
  };

  function recordGlobalReferences(
    owner: string,
    root: number,
    evidenceNode: number,
  ): void {
    for (const global of referencedGlobals(root, nodes, globalReferencesByNode)) {
      record(
        owner,
        globalStorageNames[global],
        evidenceNode,
        `${owner} references global definition d${global}`,
      );
    }
  }

  const walk = (nodeIndex: number, environment: readonly (string | undefined)[]): void => {
    const node = requiredNode(nodes, nodeIndex);
    const storageName = storageNameByNode.get(nodeIndex);
    if (storageName !== undefined && decisionByNode.get(nodeIndex)?.valueKind === "thunk") {
      for (const depth of captureAnalysis.freeLocalDepths(nodeIndex)) {
        record(
          storageName,
          environment[depth],
          nodeIndex,
          `thunk at core node ${nodeIndex} captures lexical depth ${depth}`,
        );
      }
      recordGlobalReferences(storageName, nodeIndex, nodeIndex);
    }

    switch (node.tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.SignedInteger64:
      case FunctionalCoreTag.Float32:
      case FunctionalCoreTag.Float64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Local:
      case FunctionalCoreTag.Global:
      case FunctionalCoreTag.Constructor:
        return;
      case FunctionalCoreTag.Lambda: {
        if (storageName !== undefined) {
          for (const depth of captureAnalysis.freeLocalDepths(node.child0)) {
            if (depth < 1) continue;
            record(
              storageName,
              environment[depth - 1],
              nodeIndex,
              `closure at core node ${nodeIndex} captures lexical depth ${depth - 1}`,
            );
          }
          recordGlobalReferences(storageName, node.child0, nodeIndex);
        }
        walk(node.child0, [undefined, ...environment]);
        return;
      }
      case FunctionalCoreTag.Apply: {
        const application = constructorApplication(nodeIndex, nodes, module.constructorArities);
        if (application !== undefined) {
          const owner = storageNameByNode.get(application.constructorNode);
          if (owner !== undefined) {
            for (const argument of application.arguments) {
              record(
                owner,
                storageTarget(
                  argument,
                  environment,
                  nodes,
                  storageNameByNode,
                  globalStorageNames,
                ),
                nodeIndex,
                `constructor at core node ${application.constructorNode} retains argument at core node ${argument}`,
              );
            }
          }
        }
        walk(node.child0, environment);
        walk(node.child1, environment);
        return;
      }
      case FunctionalCoreTag.Let: {
        walk(node.child0, environment);
        const bound = storageTarget(
          node.child0,
          environment,
          nodes,
          storageNameByNode,
          globalStorageNames,
        );
        walk(node.child1, [bound, ...environment]);
        return;
      }
      case FunctionalCoreTag.LetRec: {
        const bound = storageNameByNode.get(node.child0) ?? storageTarget(
          node.child0,
          environment,
          nodes,
          storageNameByNode,
          globalStorageNames,
        );
        const recursiveEnvironment = [bound, ...environment];
        walk(node.child0, recursiveEnvironment);
        walk(node.child1, recursiveEnvironment);
        return;
      }
      case FunctionalCoreTag.If:
        walk(node.child0, environment);
        walk(node.child1, environment);
        walk(node.child2, environment);
        return;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
        walk(node.child0, environment);
        return;
      case FunctionalCoreTag.Binary:
        walk(node.child0, environment);
        walk(node.child1, environment);
        return;
      case FunctionalCoreTag.Case:
      case FunctionalCoreTag.CaseArm:
        walk(node.child0, environment);
        if (node.child1 !== FUNCTIONAL_NO_INDEX) walk(node.child1, environment);
        return;
      case FunctionalCoreTag.PatternBind:
        walk(node.child0, [undefined, ...environment]);
        return;
    }
  };

  for (const root of module.definitionRoots) walk(root, []);
  return Object.freeze(references.map((reference) => Object.freeze(reference)));
}

function storageTarget(
  nodeIndex: number,
  environment: readonly (string | undefined)[],
  nodes: readonly FunctionalCoreNode[],
  storageNameByNode: ReadonlyMap<number, string>,
  globalStorageNames: readonly (string | undefined)[],
): string | undefined {
  const direct = storageNameByNode.get(nodeIndex);
  if (direct !== undefined) return direct;
  const node = requiredNode(nodes, nodeIndex);
  if (node.tag === FunctionalCoreTag.Local) return environment[node.payload];
  if (node.tag === FunctionalCoreTag.Global) return globalStorageNames[node.payload];
  if (node.tag !== FunctionalCoreTag.Apply) return undefined;
  let calleeIndex = nodeIndex;
  let callee = node;
  while (callee.tag === FunctionalCoreTag.Apply) {
    calleeIndex = callee.child0;
    callee = requiredNode(nodes, calleeIndex);
  }
  return callee.tag === FunctionalCoreTag.Constructor
    ? storageNameByNode.get(calleeIndex)
    : undefined;
}

function constructorApplication(
  nodeIndex: number,
  nodes: readonly FunctionalCoreNode[],
  constructorArities: readonly number[],
): { readonly constructorNode: number; readonly arguments: readonly number[] } | undefined {
  const reversedArguments: number[] = [];
  let calleeIndex = nodeIndex;
  let callee = requiredNode(nodes, calleeIndex);
  while (callee.tag === FunctionalCoreTag.Apply) {
    reversedArguments.push(callee.child1);
    calleeIndex = callee.child0;
    callee = requiredNode(nodes, calleeIndex);
  }
  if (callee.tag !== FunctionalCoreTag.Constructor) return undefined;
  const arity = constructorArities[callee.payload];
  if (arity === undefined || reversedArguments.length > arity) return undefined;
  return {
    constructorNode: calleeIndex,
    arguments: Object.freeze(reversedArguments.reverse()),
  };
}

function referencedGlobals(
  root: number,
  nodes: readonly FunctionalCoreNode[],
  referencesByNode: Map<number, readonly number[]>,
): readonly number[] {
  const cached = referencesByNode.get(root);
  if (cached !== undefined) return cached;
  const pending: { readonly nodeIndex: number; readonly expanded: boolean }[] = [{
    nodeIndex: root,
    expanded: false,
  }];
  const active = new Set<number>();
  while (pending.length !== 0) {
    const entry = pending.pop();
    if (entry === undefined || referencesByNode.has(entry.nodeIndex)) continue;
    const node = requiredNode(nodes, entry.nodeIndex);
    if (!entry.expanded) {
      active.add(entry.nodeIndex);
      pending.push({ nodeIndex: entry.nodeIndex, expanded: true });
      for (const child of childNodes(node)) {
        if (child === FUNCTIONAL_NO_INDEX || referencesByNode.has(child)) continue;
        if (active.has(child)) {
          throw new Error(
            `functional storage reference analysis found a core cycle from node ${entry.nodeIndex} to active node ${child}`,
          );
        }
        pending.push({ nodeIndex: child, expanded: false });
      }
      continue;
    }
    active.delete(entry.nodeIndex);
    const globals = new Set<number>();
    if (node.tag === FunctionalCoreTag.Global) globals.add(node.payload);
    for (const child of childNodes(node)) {
      const childReferences = referencesByNode.get(child);
      if (childReferences !== undefined) {
        for (const global of childReferences) globals.add(global);
      }
    }
    referencesByNode.set(
      entry.nodeIndex,
      Object.freeze([...globals].sort((left, right) => left - right)),
    );
  }
  return referencesByNode.get(root) ?? [];
}

function childNodes(node: FunctionalCoreNode): readonly number[] {
  switch (node.tag) {
    case FunctionalCoreTag.Integer:
    case FunctionalCoreTag.SignedInteger64:
    case FunctionalCoreTag.Float32:
    case FunctionalCoreTag.Float64:
    case FunctionalCoreTag.Boolean:
    case FunctionalCoreTag.Local:
    case FunctionalCoreTag.Global:
    case FunctionalCoreTag.Constructor:
      return [];
    case FunctionalCoreTag.Lambda:
    case FunctionalCoreTag.Unary:
    case FunctionalCoreTag.NumericConvert:
    case FunctionalCoreTag.PatternBind:
      return [node.child0];
    case FunctionalCoreTag.Apply:
    case FunctionalCoreTag.Let:
    case FunctionalCoreTag.LetRec:
    case FunctionalCoreTag.Binary:
    case FunctionalCoreTag.Case:
    case FunctionalCoreTag.CaseArm:
      return [node.child0, node.child1];
    case FunctionalCoreTag.If:
      return [node.child0, node.child1, node.child2];
  }
}

function requiredNode(
  nodes: readonly FunctionalCoreNode[],
  nodeIndex: number,
): FunctionalCoreNode {
  const node = nodes[nodeIndex];
  if (node === undefined) {
    throw new Error(
      `functional storage reference analysis core node ${nodeIndex} exceeds ${nodes.length} resolved nodes`,
    );
  }
  return node;
}
