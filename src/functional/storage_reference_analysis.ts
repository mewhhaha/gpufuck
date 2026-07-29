import { CoreTag, NO_INDEX } from "./abi.ts";
import type { CoreNode, GpuModule } from "./compiler_module.ts";
import type { StorageDecision, StorageReference } from "./storage_contract.ts";
import type { WasmCaptureAnalysis } from "./wasm_capture_analysis.ts";

export type { StorageReference } from "./storage_contract.ts";

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

export function analyzeStorageReferences(
  module: GpuModule,
  nodes: readonly CoreNode[],
  decisions: readonly StorageDecision[],
  captureAnalysis: WasmCaptureAnalysis,
): readonly StorageReference[] {
  const storageNameByNode = new Map<number, string>();
  const decisionByNode = new Map<number, StorageDecision>();
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
  const references: StorageReference[] = [];
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
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Local:
      case CoreTag.Constructor:
      case CoreTag.StoreEmpty:
        continue;
      case CoreTag.Global: {
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
      case CoreTag.Lambda: {
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
      case CoreTag.Apply: {
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
      case CoreTag.Let: {
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
      case CoreTag.LetRec: {
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
      case CoreTag.If:
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
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.StoreLength:
        pending.push({
          nodeIndex: node.child0,
          environment,
          globalOwners: childGlobalOwners,
        });
        continue;
      case CoreTag.Binary:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreRead:
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
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
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
      case CoreTag.Case:
      case CoreTag.CaseArm:
        if (node.child1 !== NO_INDEX) {
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
      case CoreTag.PatternBind:
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
  nodes: readonly CoreNode[],
  storageNameByNode: ReadonlyMap<number, string>,
  globalStorageNames: readonly (string | undefined)[],
): string | undefined {
  const direct = storageNameByNode.get(nodeIndex);
  if (direct !== undefined) return direct;
  const node = requiredNode(nodes, nodeIndex);
  if (node.tag === CoreTag.Local) {
    return storageNameAtDepth(environment, node.payload);
  }
  if (node.tag === CoreTag.Global) return globalStorageNames[node.payload];
  if (node.tag !== CoreTag.Apply) return undefined;
  let calleeIndex = nodeIndex;
  let callee = node;
  while (callee.tag === CoreTag.Apply) {
    calleeIndex = callee.child0;
    callee = requiredNode(nodes, calleeIndex);
  }
  return callee.tag === CoreTag.Constructor ? storageNameByNode.get(calleeIndex) : undefined;
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
  nodes: readonly CoreNode[],
  constructorArities: readonly number[],
): { readonly constructorNode: number; readonly arguments: readonly number[] } | undefined {
  const reversedArguments: number[] = [];
  let calleeIndex = nodeIndex;
  let callee = requiredNode(nodes, calleeIndex);
  while (callee.tag === CoreTag.Apply) {
    reversedArguments.push(callee.child1);
    calleeIndex = callee.child0;
    callee = requiredNode(nodes, calleeIndex);
  }
  if (callee.tag !== CoreTag.Constructor) return undefined;
  const arity = constructorArities[callee.payload];
  if (arity === undefined || reversedArguments.length > arity) return undefined;
  return {
    constructorNode: calleeIndex,
    arguments: Object.freeze(reversedArguments.reverse()),
  };
}

function requiredNode(
  nodes: readonly CoreNode[],
  nodeIndex: number,
): CoreNode {
  const node = nodes[nodeIndex];
  if (node === undefined) {
    throw new Error(
      `functional storage reference analysis core node ${nodeIndex} exceeds ${nodes.length} resolved nodes`,
    );
  }
  return node;
}
