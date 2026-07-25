import { CoreTag, EvaluationMode, NO_INDEX } from "./abi.ts";
import type { CoreNode, GpuModule } from "./compiler_module.ts";
import {
  PersistentSharing,
  StorageCoreError,
  type StorageCoreLifetime,
  type StorageCoreOperation,
  type StorageCoreProgram,
  verifyStorageCore,
} from "./storage_core.ts";
import {
  type BoundaryStorageDecision,
  StorageClass,
  type StorageDecision,
  type StoragePlan,
  type StoragePlanningOptions,
  type StorageReference,
} from "./storage_contract.ts";
import { analyzeStorageReferences } from "./storage_reference_analysis.ts";
import { WasmCaptureAnalysis } from "./wasm_capture_analysis.ts";

export {
  type BoundaryStorageDecision,
  StorageClass,
  type StorageDecision,
  type StoragePlan,
  type StoragePlanningOptions,
  type StoragePlanSummary,
  type StoredValueKind,
} from "./storage_contract.ts";

export async function planModuleStorage(
  module: GpuModule,
  options: StoragePlanningOptions = {},
): Promise<StoragePlan> {
  const nodes = await module.readCoreNodes();
  return createStoragePlan(
    module,
    nodes,
    new WasmCaptureAnalysis(nodes),
    options,
  );
}

export function createStoragePlan(
  module: GpuModule,
  nodes: readonly CoreNode[],
  captureAnalysis: WasmCaptureAnalysis = new WasmCaptureAnalysis(nodes),
  options: StoragePlanningOptions = {},
): StoragePlan {
  const definitionByRoot = new Map<number, number>();
  for (const [definition, root] of module.definitionRoots.entries()) {
    if (root >= nodes.length) {
      throw new Error(
        `functional storage plan definition d${definition} root ${root} exceeds ${nodes.length} resolved nodes`,
      );
    }
    definitionByRoot.set(root, definition);
  }

  const directCallees = new Set<number>();
  const recursiveLambdas = new Set<number>();
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.tag === CoreTag.Apply) directCallees.add(node.child0);
    if (node.tag === CoreTag.LetRec) recursiveLambdas.add(node.child0);
    requireCoreChildren(nodes.length, nodeIndex, node);
  }

  const values: StorageDecision[] = [];
  const recorded = new Map<string, StorageDecision>();
  const record = (decision: StorageDecision): void => {
    const key = `${decision.valueKind}:${decision.coreNode}`;
    const existing = recorded.get(key);
    if (existing !== undefined) {
      if (
        existing.storage !== decision.storage ||
        existing.escapeStorage !== decision.escapeStorage ||
        existing.capturedLocalCount !== decision.capturedLocalCount
      ) {
        throw new Error(
          `functional storage plan gives ${JSON.stringify(key)} conflicting ${
            JSON.stringify(existing.storage)
          } and ${JSON.stringify(decision.storage)} decisions`,
        );
      }
      return;
    }
    recorded.set(key, decision);
    values.push(Object.freeze(decision));
  };

  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.tag === CoreTag.Lambda) {
      const capturedLocalCount = captureAnalysis.freeLocalDepths(node.child0)
        .filter((depth) => depth >= 1).length;
      const definition = definitionByRoot.get(nodeIndex);
      if (definition !== undefined) {
        record({
          coreNode: nodeIndex,
          valueKind: "closure",
          storage: StorageClass.Static,
          capturedLocalCount,
          reason: `definition d${definition} has module lifetime`,
        });
      } else if (recursiveLambdas.has(nodeIndex)) {
        record({
          coreNode: nodeIndex,
          valueKind: "closure",
          storage: StorageClass.InvocationArena,
          capturedLocalCount,
          reason: "a local recursive closure may contain a self reference",
        });
      } else {
        record({
          coreNode: nodeIndex,
          valueKind: "closure",
          storage: StorageClass.ScalarLocal,
          escapeStorage: StorageClass.InvocationArena,
          capturedLocalCount,
          reason: directCallees.has(nodeIndex)
            ? "the lambda is directly applied and can remain virtual"
            : "the lambda remains virtual until a first-class use requires an environment",
        });
      }
      continue;
    }

    if (node.tag === CoreTag.Constructor) {
      const arity = module.constructorArities[node.payload];
      if (arity === undefined) {
        throw new Error(
          `functional storage plan constructor ${node.payload} at core node ${nodeIndex} exceeds ${module.constructorCount} constructors`,
        );
      }
      record({
        coreNode: nodeIndex,
        valueKind: "constructor",
        storage: arity === 0 ? StorageClass.Static : StorageClass.InvocationArena,
        capturedLocalCount: 0,
        reason: arity === 0
          ? "a nullary constructor uses one module-lifetime value"
          : `a constructor function with arity ${arity} retains supplied fields when partially applied`,
      });
      continue;
    }

    if (
      node.tag === CoreTag.Let &&
      node.evaluationMode === EvaluationMode.LazyCallByNeed &&
      !expressionIsWeakHeadNormalForm(nodes, node.child0)
    ) {
      record({
        coreNode: node.child0,
        valueKind: "thunk",
        storage: StorageClass.InvocationArena,
        capturedLocalCount: captureAnalysis.freeLocalDepths(node.child0).length,
        reason: `lazy let at core node ${nodeIndex} memoizes within one invocation`,
      });
      continue;
    }

    if (
      node.tag === CoreTag.Apply &&
      node.evaluationMode === EvaluationMode.LazyCallByNeed &&
      !expressionIsWeakHeadNormalForm(nodes, node.child1)
    ) {
      record({
        coreNode: node.child1,
        valueKind: "thunk",
        storage: StorageClass.InvocationArena,
        capturedLocalCount: captureAnalysis.freeLocalDepths(node.child1).length,
        reason:
          `lazy application at core node ${nodeIndex} memoizes its argument within one invocation`,
      });
    }
  }

  for (const [definition, root] of module.definitionRoots.entries()) {
    if (expressionIsWeakHeadNormalForm(nodes, root)) continue;
    record({
      coreNode: root,
      valueKind: "thunk",
      storage: StorageClass.Static,
      capturedLocalCount: 0,
      reason: `definition d${definition} memoizes for the module instance lifetime`,
    });
  }

  const boundaries = boundaryStorageDecisions(module);
  const references = analyzeStorageReferences(
    module,
    nodes,
    values,
    captureAnalysis,
  );
  const derivedCore = storageCore(values, references, boundaries, options.persistentSharing);
  const core = options.storageCore ?? derivedCore;
  if (
    options.storageCore !== undefined && options.persistentSharing !== undefined &&
    options.storageCore.persistentSharing !== options.persistentSharing
  ) {
    throw new Error(
      `frontend Functional Storage Core uses ${
        JSON.stringify(options.storageCore.persistentSharing)
      } persistent sharing while storage planning requested ${
        JSON.stringify(options.persistentSharing)
      }`,
    );
  }
  const verification = verifyStorageCore(core);
  if (!verification.ok) {
    if (options.storageCore !== undefined) {
      throw new StorageCoreError(verification.diagnostic);
    }
    throw new Error(
      `derived Functional Storage Core failed at operation ${verification.diagnostic.operation}: ${verification.diagnostic.message}`,
    );
  }
  if (options.storageCore !== undefined) {
    requireCompleteStorageCore(derivedCore, options.storageCore);
  }
  const summary = Object.freeze({
    staticValues: values.filter((value) => value.storage === StorageClass.Static).length,
    scalarLocalValues: values.filter((value) => value.storage === StorageClass.ScalarLocal).length,
    invocationArenaValues: values.filter((value) =>
      value.storage === StorageClass.InvocationArena ||
      value.escapeStorage === StorageClass.InvocationArena
    ).length,
    ownedBoundaries: boundaries.filter((boundary) =>
      boundary.storage === StorageClass.Owned
    ).length,
    hostManagedBoundaries: boundaries.filter((boundary) =>
      boundary.storage === StorageClass.HostManaged
    )
      .length,
    automaticArenaReset: !values.some((value) =>
      value.valueKind === "thunk" && value.storage === StorageClass.Static
    ),
  });
  return Object.freeze({
    values: Object.freeze(values),
    references,
    boundaries,
    core,
    verification,
    summary,
  });
}

function requireCompleteStorageCore(
  derived: StorageCoreProgram,
  supplied: StorageCoreProgram,
): void {
  const suppliedDeclarations = new Map<string, StorageCoreLifetime>();
  const suppliedReferences = new Set<string>();
  for (const operation of supplied.operations) {
    if (operation.kind === "declare") {
      suppliedDeclarations.set(operation.value, operation.lifetime);
    } else if (operation.kind === "reference") {
      suppliedReferences.add(JSON.stringify([operation.owner, operation.target]));
    }
  }
  for (const operation of derived.operations) {
    if (operation.kind === "declare") {
      const lifetime = suppliedDeclarations.get(operation.value);
      if (lifetime === undefined) {
        throw new Error(
          `frontend Functional Storage Core omits required value ${
            JSON.stringify(operation.value)
          }`,
        );
      }
      if (lifetime !== operation.lifetime) {
        throw new Error(
          `frontend Functional Storage Core gives ${JSON.stringify(operation.value)} ${
            JSON.stringify(lifetime)
          } lifetime; resolved Core requires ${JSON.stringify(operation.lifetime)}`,
        );
      }
      continue;
    }
    if (
      operation.kind === "reference" &&
      !suppliedReferences.has(JSON.stringify([operation.owner, operation.target]))
    ) {
      throw new Error(
        `frontend Functional Storage Core omits required reference ${
          JSON.stringify(operation.owner)
        } -> ${JSON.stringify(operation.target)} from core node ${operation.coreNode ?? "unknown"}`,
      );
    }
  }
}

function storageCore(
  values: readonly StorageDecision[],
  references: readonly StorageReference[],
  boundaries: readonly BoundaryStorageDecision[],
  persistentSharing: PersistentSharing | undefined,
): StorageCoreProgram {
  const operations: StorageCoreOperation[] = [];
  for (const value of values) {
    if (value.storage !== StorageClass.Static) continue;
    operations.push({
      kind: "declare",
      value: `${value.valueKind}:${value.coreNode}`,
      lifetime: value.storage,
      coreNode: value.coreNode,
      reason: value.reason,
    });
  }
  for (const boundary of boundaries) {
    if (
      boundary.storage !== StorageClass.Owned &&
      boundary.storage !== StorageClass.HostManaged
    ) continue;
    operations.push({
      kind: "declare",
      value: `boundary:${boundary.path}`,
      lifetime: boundary.storage,
      reason: boundary.reason,
    });
  }
  operations.push({ kind: "enter-arena", arena: "invocation" });
  for (const value of values) {
    if (value.storage === StorageClass.Static) continue;
    operations.push({
      kind: "declare",
      value: `${value.valueKind}:${value.coreNode}`,
      lifetime: value.storage,
      ...(value.storage === StorageClass.ScalarLocal ||
          value.storage === StorageClass.InvocationArena
        ? { arena: "invocation" }
        : {}),
      coreNode: value.coreNode,
      reason: value.reason,
    });
  }
  for (const boundary of boundaries) {
    if (boundary.storage !== StorageClass.InvocationArena) continue;
    operations.push({
      kind: "declare",
      value: `boundary:${boundary.path}`,
      lifetime: boundary.storage,
      arena: "invocation",
      reason: boundary.reason,
    });
  }
  for (const reference of references) {
    operations.push({
      kind: "reference",
      owner: reference.owner,
      target: reference.target,
      coreNode: reference.coreNode,
      reason: reference.reason,
    });
  }
  operations.push({ kind: "leave-arena", arena: "invocation" });
  return Object.freeze({
    persistentSharing: persistentSharing ?? PersistentSharing.Reject,
    operations: Object.freeze(operations),
  });
}

function boundaryStorageDecisions(
  module: GpuModule,
): readonly BoundaryStorageDecision[] {
  const boundaries: BoundaryStorageDecision[] = [];
  for (const capability of module.hostCapabilities) {
    for (const field of capability.fields) {
      const path = `${capability.name}.${field.name}`;
      if (field.kind === "value") {
        const owned = field.ownership === "ownership-transfer";
        boundaries.push(Object.freeze({
          path,
          direction: "host-to-module",
          storage: owned ? StorageClass.Owned : StorageClass.HostManaged,
          reason: owned
            ? "the module receives ownership of the encoded host value"
            : "the host promises an immutable shareable value",
        }));
        continue;
      }

      const transferredParameter = field.parameterOwnership === "ownership-transfer";
      boundaries.push(Object.freeze({
        path: `${path}.parameter`,
        direction: "module-to-host",
        storage: transferredParameter ? StorageClass.Owned : StorageClass.InvocationArena,
        reason: transferredParameter
          ? "the host operation takes ownership of its argument"
          : "the host operation borrows its argument for the call",
      }));
      const hostManagedResult = field.resultOwnership === "frozen-shareable";
      boundaries.push(Object.freeze({
        path: `${path}.result`,
        direction: "host-to-module",
        storage: hostManagedResult ? StorageClass.HostManaged : StorageClass.Owned,
        reason: hostManagedResult
          ? "the host retains an immutable shareable result"
          : "the module receives an owned operation result",
      }));
    }
  }
  return Object.freeze(boundaries);
}

function expressionIsWeakHeadNormalForm(
  nodes: readonly CoreNode[],
  nodeIndex: number,
): boolean {
  const node = nodes[nodeIndex];
  if (node === undefined) {
    throw new Error(
      `functional storage plan core node ${nodeIndex} exceeds ${nodes.length} resolved nodes`,
    );
  }
  return node.tag === CoreTag.Integer ||
    node.tag === CoreTag.SignedInteger64 ||
    node.tag === CoreTag.Float32 ||
    node.tag === CoreTag.Float64 ||
    node.tag === CoreTag.WholeNumberF64 ||
    node.tag === CoreTag.Boolean ||
    node.tag === CoreTag.Lambda ||
    node.tag === CoreTag.Constructor;
}

function requireCoreChildren(
  nodeCount: number,
  nodeIndex: number,
  node: CoreNode,
): void {
  for (const [name, child] of coreChildren(node)) {
    if (child === NO_INDEX) continue;
    if (child >= nodeCount) {
      throw new Error(
        `functional storage plan core node ${nodeIndex} ${name} ${child} exceeds ${nodeCount} resolved nodes`,
      );
    }
  }
}

function coreChildren(
  node: CoreNode,
): readonly (readonly ["child0" | "child1" | "child2", number])[] {
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
    case CoreTag.Local:
    case CoreTag.Global:
    case CoreTag.Constructor:
      return [];
    case CoreTag.Lambda:
    case CoreTag.Unary:
    case CoreTag.NumericConvert:
    case CoreTag.PatternBind:
    case CoreTag.StoreLength:
      return [["child0", node.child0]];
    case CoreTag.Apply:
    case CoreTag.Let:
    case CoreTag.LetRec:
    case CoreTag.Binary:
    case CoreTag.BufferAppend:
    case CoreTag.Case:
    case CoreTag.CaseArm:
    case CoreTag.StoreNew:
    case CoreTag.StoreRead:
      return [["child0", node.child0], ["child1", node.child1]];
    case CoreTag.If:
    case CoreTag.StoreWrite:
    case CoreTag.StoreGrow:
      return [["child0", node.child0], ["child1", node.child1], ["child2", node.child2]];
  }
}
