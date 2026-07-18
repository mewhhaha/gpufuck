import { FUNCTIONAL_NO_INDEX, FunctionalCoreTag, FunctionalEvaluationMode } from "./abi.ts";
import type { FunctionalCoreNode, GpuFunctionalModule } from "./compiler_module.ts";
import {
  FunctionalPersistentSharing,
  type FunctionalStorageCoreOperation,
  type FunctionalStorageCoreProgram,
  type FunctionalStorageVerification,
  verifyFunctionalStorageCore,
} from "./storage_core.ts";
import { FunctionalWasmCaptureAnalysis } from "./wasm_capture_analysis.ts";

export const FunctionalStorageClass = {
  Static: "static",
  ScalarLocal: "scalar-local",
  InvocationArena: "invocation-arena",
  Owned: "owned",
  HostManaged: "host-managed",
} as const;

export type FunctionalStorageClass =
  (typeof FunctionalStorageClass)[keyof typeof FunctionalStorageClass];

export type FunctionalStoredValueKind = "closure" | "constructor" | "thunk";

export interface FunctionalStorageDecision {
  readonly coreNode: number;
  readonly valueKind: FunctionalStoredValueKind;
  readonly storage: FunctionalStorageClass;
  readonly escapeStorage?: FunctionalStorageClass;
  readonly capturedLocalCount: number;
  readonly reason: string;
}

export interface FunctionalBoundaryStorageDecision {
  readonly path: string;
  readonly direction: "host-to-module" | "module-to-host";
  readonly storage: FunctionalStorageClass;
  readonly reason: string;
}

export interface FunctionalStoragePlanSummary {
  readonly staticValues: number;
  readonly scalarLocalValues: number;
  readonly invocationArenaValues: number;
  readonly ownedBoundaries: number;
  readonly hostManagedBoundaries: number;
  readonly automaticArenaReset: boolean;
}

export interface FunctionalStoragePlan {
  readonly values: readonly FunctionalStorageDecision[];
  readonly boundaries: readonly FunctionalBoundaryStorageDecision[];
  readonly core: FunctionalStorageCoreProgram;
  readonly verification: FunctionalStorageVerification & { readonly ok: true };
  readonly summary: FunctionalStoragePlanSummary;
}

export interface FunctionalStoragePlanningOptions {
  readonly persistentSharing?: FunctionalPersistentSharing;
}

export async function planFunctionalModuleStorage(
  module: GpuFunctionalModule,
  options: FunctionalStoragePlanningOptions = {},
): Promise<FunctionalStoragePlan> {
  const nodes = await module.readCoreNodes();
  return createFunctionalStoragePlan(
    module,
    nodes,
    new FunctionalWasmCaptureAnalysis(nodes),
    options,
  );
}

export function createFunctionalStoragePlan(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  captureAnalysis = new FunctionalWasmCaptureAnalysis(nodes),
  options: FunctionalStoragePlanningOptions = {},
): FunctionalStoragePlan {
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
    if (node.tag === FunctionalCoreTag.Apply) directCallees.add(node.child0);
    if (node.tag === FunctionalCoreTag.LetRec) recursiveLambdas.add(node.child0);
    requireCoreChildren(nodes.length, nodeIndex, node);
  }

  const values: FunctionalStorageDecision[] = [];
  const recorded = new Set<string>();
  const record = (decision: FunctionalStorageDecision): void => {
    const key = `${decision.valueKind}:${decision.coreNode}`;
    if (recorded.has(key)) return;
    recorded.add(key);
    values.push(Object.freeze(decision));
  };

  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.tag === FunctionalCoreTag.Lambda) {
      const capturedLocalCount = captureAnalysis.freeLocalDepths(node.child0)
        .filter((depth) => depth >= 1).length;
      const definition = definitionByRoot.get(nodeIndex);
      if (definition !== undefined) {
        record({
          coreNode: nodeIndex,
          valueKind: "closure",
          storage: FunctionalStorageClass.Static,
          capturedLocalCount,
          reason: `definition d${definition} has module lifetime`,
        });
      } else if (recursiveLambdas.has(nodeIndex)) {
        record({
          coreNode: nodeIndex,
          valueKind: "closure",
          storage: FunctionalStorageClass.InvocationArena,
          capturedLocalCount,
          reason: "a local recursive closure may contain a self reference",
        });
      } else {
        record({
          coreNode: nodeIndex,
          valueKind: "closure",
          storage: FunctionalStorageClass.ScalarLocal,
          escapeStorage: FunctionalStorageClass.InvocationArena,
          capturedLocalCount,
          reason: directCallees.has(nodeIndex)
            ? "the lambda is directly applied and can remain virtual"
            : "the lambda remains virtual until a first-class use requires an environment",
        });
      }
      continue;
    }

    if (node.tag === FunctionalCoreTag.Constructor) {
      const arity = module.constructorArities[node.payload];
      if (arity === undefined) {
        throw new Error(
          `functional storage plan constructor ${node.payload} at core node ${nodeIndex} exceeds ${module.constructorCount} constructors`,
        );
      }
      record({
        coreNode: nodeIndex,
        valueKind: "constructor",
        storage: arity === 0
          ? FunctionalStorageClass.Static
          : FunctionalStorageClass.InvocationArena,
        capturedLocalCount: 0,
        reason: arity === 0
          ? "a nullary constructor uses one module-lifetime value"
          : `a constructor function with arity ${arity} retains supplied fields when partially applied`,
      });
      continue;
    }

    if (
      node.tag === FunctionalCoreTag.Let &&
      node.evaluationMode === FunctionalEvaluationMode.LazyCallByNeed &&
      !expressionIsWeakHeadNormalForm(nodes, node.child0)
    ) {
      record({
        coreNode: node.child0,
        valueKind: "thunk",
        storage: FunctionalStorageClass.InvocationArena,
        capturedLocalCount: captureAnalysis.freeLocalDepths(node.child0).length,
        reason: `lazy let at core node ${nodeIndex} memoizes within one invocation`,
      });
      continue;
    }

    if (
      node.tag === FunctionalCoreTag.Apply &&
      node.evaluationMode === FunctionalEvaluationMode.LazyCallByNeed &&
      !expressionIsWeakHeadNormalForm(nodes, node.child1)
    ) {
      record({
        coreNode: node.child1,
        valueKind: "thunk",
        storage: FunctionalStorageClass.InvocationArena,
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
      storage: FunctionalStorageClass.Static,
      capturedLocalCount: 0,
      reason: `definition d${definition} memoizes for the module instance lifetime`,
    });
  }

  const boundaries = boundaryStorageDecisions(module);
  const core = storageCore(values, boundaries, options.persistentSharing);
  const verification = verifyFunctionalStorageCore(core);
  if (!verification.ok) {
    throw new Error(
      `derived Functional Storage Core failed at operation ${verification.diagnostic.operation}: ${verification.diagnostic.message}`,
    );
  }
  const summary = Object.freeze({
    staticValues: values.filter((value) => value.storage === FunctionalStorageClass.Static).length,
    scalarLocalValues: values.filter((value) =>
      value.storage === FunctionalStorageClass.ScalarLocal
    ).length,
    invocationArenaValues: values.filter((value) =>
      value.storage === FunctionalStorageClass.InvocationArena ||
      value.escapeStorage === FunctionalStorageClass.InvocationArena
    ).length,
    ownedBoundaries: boundaries.filter((boundary) =>
      boundary.storage === FunctionalStorageClass.Owned
    ).length,
    hostManagedBoundaries:
      boundaries.filter((boundary) => boundary.storage === FunctionalStorageClass.HostManaged)
        .length,
    automaticArenaReset: !values.some((value) =>
      value.valueKind === "thunk" && value.storage === FunctionalStorageClass.Static
    ),
  });
  return Object.freeze({
    values: Object.freeze(values),
    boundaries,
    core,
    verification,
    summary,
  });
}

function storageCore(
  values: readonly FunctionalStorageDecision[],
  boundaries: readonly FunctionalBoundaryStorageDecision[],
  persistentSharing: FunctionalPersistentSharing | undefined,
): FunctionalStorageCoreProgram {
  const operations: FunctionalStorageCoreOperation[] = [];
  for (const value of values) {
    if (value.storage !== FunctionalStorageClass.Static) continue;
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
      boundary.storage !== FunctionalStorageClass.Owned &&
      boundary.storage !== FunctionalStorageClass.HostManaged
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
    if (value.storage === FunctionalStorageClass.Static) continue;
    operations.push({
      kind: "declare",
      value: `${value.valueKind}:${value.coreNode}`,
      lifetime: value.storage,
      ...(value.storage === FunctionalStorageClass.ScalarLocal ||
          value.storage === FunctionalStorageClass.InvocationArena
        ? { arena: "invocation" }
        : {}),
      coreNode: value.coreNode,
      reason: value.reason,
    });
  }
  for (const boundary of boundaries) {
    if (boundary.storage !== FunctionalStorageClass.InvocationArena) continue;
    operations.push({
      kind: "declare",
      value: `boundary:${boundary.path}`,
      lifetime: boundary.storage,
      arena: "invocation",
      reason: boundary.reason,
    });
  }
  operations.push({ kind: "leave-arena", arena: "invocation" });
  return Object.freeze({
    persistentSharing: persistentSharing ?? FunctionalPersistentSharing.Reject,
    operations: Object.freeze(operations),
  });
}

function boundaryStorageDecisions(
  module: GpuFunctionalModule,
): readonly FunctionalBoundaryStorageDecision[] {
  const boundaries: FunctionalBoundaryStorageDecision[] = [];
  for (const capability of module.hostCapabilities) {
    for (const field of capability.fields) {
      const path = `${capability.name}.${field.name}`;
      if (field.kind === "value") {
        const owned = field.ownership === "ownership-transfer";
        boundaries.push(Object.freeze({
          path,
          direction: "host-to-module",
          storage: owned ? FunctionalStorageClass.Owned : FunctionalStorageClass.HostManaged,
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
        storage: transferredParameter
          ? FunctionalStorageClass.Owned
          : FunctionalStorageClass.InvocationArena,
        reason: transferredParameter
          ? "the host operation takes ownership of its argument"
          : "the host operation borrows its argument for the call",
      }));
      const hostManagedResult = field.resultOwnership === "frozen-shareable";
      boundaries.push(Object.freeze({
        path: `${path}.result`,
        direction: "host-to-module",
        storage: hostManagedResult
          ? FunctionalStorageClass.HostManaged
          : FunctionalStorageClass.Owned,
        reason: hostManagedResult
          ? "the host retains an immutable shareable result"
          : "the module receives an owned operation result",
      }));
    }
  }
  return Object.freeze(boundaries);
}

function expressionIsWeakHeadNormalForm(
  nodes: readonly FunctionalCoreNode[],
  nodeIndex: number,
): boolean {
  const node = nodes[nodeIndex];
  if (node === undefined) {
    throw new Error(
      `functional storage plan core node ${nodeIndex} exceeds ${nodes.length} resolved nodes`,
    );
  }
  return node.tag === FunctionalCoreTag.Integer ||
    node.tag === FunctionalCoreTag.SignedInteger64 ||
    node.tag === FunctionalCoreTag.Float32 ||
    node.tag === FunctionalCoreTag.Float64 ||
    node.tag === FunctionalCoreTag.Boolean ||
    node.tag === FunctionalCoreTag.Lambda ||
    node.tag === FunctionalCoreTag.Constructor;
}

function requireCoreChildren(
  nodeCount: number,
  nodeIndex: number,
  node: FunctionalCoreNode,
): void {
  for (const [name, child] of coreChildren(node)) {
    if (child === FUNCTIONAL_NO_INDEX) continue;
    if (child >= nodeCount) {
      throw new Error(
        `functional storage plan core node ${nodeIndex} ${name} ${child} exceeds ${nodeCount} resolved nodes`,
      );
    }
  }
}

function coreChildren(
  node: FunctionalCoreNode,
): readonly (readonly ["child0" | "child1" | "child2", number])[] {
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
      return [["child0", node.child0]];
    case FunctionalCoreTag.Apply:
    case FunctionalCoreTag.Let:
    case FunctionalCoreTag.LetRec:
    case FunctionalCoreTag.Binary:
    case FunctionalCoreTag.Case:
    case FunctionalCoreTag.CaseArm:
      return [["child0", node.child0], ["child1", node.child1]];
    case FunctionalCoreTag.If:
      return [["child0", node.child0], ["child1", node.child1], ["child2", node.child2]];
  }
}
