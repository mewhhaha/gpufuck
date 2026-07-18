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

interface GlobalReferenceOwner {
  readonly name: string;
  readonly coreNode: number;
  readonly parent: GlobalReferenceOwner | undefined;
}

interface StorageEnvironment {
  readonly storageName: string | undefined;
  readonly parent: StorageEnvironment | undefined;
}

interface StorageTraversal {
  readonly nodeIndex: number;
  readonly environment: StorageEnvironment | undefined;
  readonly globalOwners: GlobalReferenceOwner | undefined;
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
    storageTarget(root, undefined, nodes, storageNameByNode, [])
  );
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

  const pending: StorageTraversal[] = [];
  for (let definition = module.definitionRoots.length - 1; definition >= 0; definition--) {
    pending.push({
      nodeIndex: module.definitionRoots[definition]!,
      environment: undefined,
      globalOwners: undefined,
    });
  }
  while (pending.length !== 0) {
    const traversal = pending.pop();
    if (traversal === undefined) continue;
    const { nodeIndex, environment, globalOwners } = traversal;
    const node = requiredNode(nodes, nodeIndex);
    const storageName = storageNameByNode.get(nodeIndex);
    let childGlobalOwners = globalOwners;
    if (storageName !== undefined && decisionByNode.get(nodeIndex)?.valueKind === "thunk") {
      for (const depth of captureAnalysis.freeLocalDepths(nodeIndex)) {
        record(
          storageName,
          storageNameAtDepth(environment, depth),
          nodeIndex,
          `thunk at core node ${nodeIndex} captures lexical depth ${depth}`,
        );
      }
      childGlobalOwners = {
        name: storageName,
        coreNode: nodeIndex,
        parent: globalOwners,
      };
    }

    switch (node.tag) {
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.SignedInteger64:
      case FunctionalCoreTag.Float32:
      case FunctionalCoreTag.Float64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Local:
      case FunctionalCoreTag.Constructor:
        continue;
      case FunctionalCoreTag.Global: {
        let owner = childGlobalOwners;
        while (owner !== undefined) {
          record(
            owner.name,
            globalStorageNames[node.payload],
            owner.coreNode,
            `${owner.name} references global definition d${node.payload}`,
          );
          owner = owner.parent;
        }
        continue;
      }
      case FunctionalCoreTag.Lambda: {
        let bodyGlobalOwners = childGlobalOwners;
        if (storageName !== undefined) {
          for (const depth of captureAnalysis.freeLocalDepths(node.child0)) {
            if (depth < 1) continue;
            record(
              storageName,
              storageNameAtDepth(environment, depth - 1),
              nodeIndex,
              `closure at core node ${nodeIndex} captures lexical depth ${depth - 1}`,
            );
          }
          bodyGlobalOwners = {
            name: storageName,
            coreNode: nodeIndex,
            parent: childGlobalOwners,
          };
        }
        pending.push({
          nodeIndex: node.child0,
          environment: { storageName: undefined, parent: environment },
          globalOwners: bodyGlobalOwners,
        });
        continue;
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
        pending.push({
          nodeIndex: node.child1,
          environment,
          globalOwners: childGlobalOwners,
        });
        pending.push({
          nodeIndex: node.child0,
          environment,
          globalOwners: childGlobalOwners,
        });
        continue;
      }
      case FunctionalCoreTag.Let: {
        const bound = storageTarget(
          node.child0,
          environment,
          nodes,
          storageNameByNode,
          globalStorageNames,
        );
        pending.push({
          nodeIndex: node.child1,
          environment: { storageName: bound, parent: environment },
          globalOwners: childGlobalOwners,
        });
        pending.push({
          nodeIndex: node.child0,
          environment,
          globalOwners: childGlobalOwners,
        });
        continue;
      }
      case FunctionalCoreTag.LetRec: {
        const bound = storageNameByNode.get(node.child0) ?? storageTarget(
          node.child0,
          environment,
          nodes,
          storageNameByNode,
          globalStorageNames,
        );
        const recursiveEnvironment = { storageName: bound, parent: environment };
        pending.push({
          nodeIndex: node.child1,
          environment: recursiveEnvironment,
          globalOwners: childGlobalOwners,
        });
        pending.push({
          nodeIndex: node.child0,
          environment: recursiveEnvironment,
          globalOwners: childGlobalOwners,
        });
        continue;
      }
      case FunctionalCoreTag.If:
        pending.push({
          nodeIndex: node.child2,
          environment,
          globalOwners: childGlobalOwners,
        });
        pending.push({
          nodeIndex: node.child1,
          environment,
          globalOwners: childGlobalOwners,
        });
        pending.push({
          nodeIndex: node.child0,
          environment,
          globalOwners: childGlobalOwners,
        });
        continue;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
        pending.push({
          nodeIndex: node.child0,
          environment,
          globalOwners: childGlobalOwners,
        });
        continue;
      case FunctionalCoreTag.Binary:
        pending.push({
          nodeIndex: node.child1,
          environment,
          globalOwners: childGlobalOwners,
        });
        pending.push({
          nodeIndex: node.child0,
          environment,
          globalOwners: childGlobalOwners,
        });
        continue;
      case FunctionalCoreTag.Case:
      case FunctionalCoreTag.CaseArm:
        if (node.child1 !== FUNCTIONAL_NO_INDEX) {
          pending.push({
            nodeIndex: node.child1,
            environment,
            globalOwners: childGlobalOwners,
          });
        }
        pending.push({
          nodeIndex: node.child0,
          environment,
          globalOwners: childGlobalOwners,
        });
        continue;
      case FunctionalCoreTag.PatternBind:
        pending.push({
          nodeIndex: node.child0,
          environment: { storageName: undefined, parent: environment },
          globalOwners: childGlobalOwners,
        });
        continue;
    }
  }

  return Object.freeze(references.map((reference) => Object.freeze(reference)));
}

function storageTarget(
  nodeIndex: number,
  environment: StorageEnvironment | undefined,
  nodes: readonly FunctionalCoreNode[],
  storageNameByNode: ReadonlyMap<number, string>,
  globalStorageNames: readonly (string | undefined)[],
): string | undefined {
  const direct = storageNameByNode.get(nodeIndex);
  if (direct !== undefined) return direct;
  const node = requiredNode(nodes, nodeIndex);
  if (node.tag === FunctionalCoreTag.Local) {
    return storageNameAtDepth(environment, node.payload);
  }
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

function storageNameAtDepth(
  environment: StorageEnvironment | undefined,
  depth: number,
): string | undefined {
  let current = environment;
  for (let remaining = depth; remaining > 0 && current !== undefined; remaining--) {
    current = current.parent;
  }
  return current?.storageName;
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
