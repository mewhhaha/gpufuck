import {
  FunctionalPersistentSharing,
  type FunctionalStorageCoreOperation,
  type FunctionalStorageCoreProgram,
  requireVerifiedFunctionalStorageCore,
} from "./storage_core.ts";

export interface FunctionalUniqueOwnershipOptions {
  readonly escapingValues?: readonly string[];
}

export interface FunctionalUniqueOwnershipRelease {
  readonly value: string;
  readonly lastUseOperation: number;
  readonly releaseOperation: number;
}

export interface FunctionalUniqueOwnershipResolution {
  readonly core: FunctionalStorageCoreProgram;
  readonly releases: readonly FunctionalUniqueOwnershipRelease[];
}

interface UniqueOwnedValue {
  readonly targets: Set<string>;
  retainedByNonownedValue: boolean;
  owner: string | undefined;
  lastUseOperation: number;
}

export function resolveFunctionalUniqueOwnership(
  core: FunctionalStorageCoreProgram,
  options: FunctionalUniqueOwnershipOptions = {},
): FunctionalUniqueOwnershipResolution {
  if (options === null || typeof options !== "object") {
    throw new TypeError("functional unique ownership options must be an object");
  }
  requireVerifiedFunctionalStorageCore(core);
  if (core.persistentSharing !== FunctionalPersistentSharing.Reject) {
    throw new TypeError(
      `functional unique ownership resolution requires persistent sharing policy ${
        JSON.stringify(FunctionalPersistentSharing.Reject)
      }; received ${JSON.stringify(core.persistentSharing)}`,
    );
  }
  const ownedValues = uniqueOwnedValues(core);
  const escapingRoots = uniqueEscapingRoots(ownedValues, options.escapingValues ?? []);
  const releasesByLastUse = new Map<number, string[]>();
  for (const [value, ownership] of ownedValues) {
    if (ownership.owner !== undefined || escapingRoots.has(value)) continue;
    const lastUseOperation = uniqueGraphLastUse(value, ownedValues);
    const releases = releasesByLastUse.get(lastUseOperation) ?? [];
    releases.push(value);
    releasesByLastUse.set(lastUseOperation, releases);
  }

  const operations: FunctionalStorageCoreOperation[] = [];
  const releases: FunctionalUniqueOwnershipRelease[] = [];
  for (const [operationIndex, operation] of core.operations.entries()) {
    operations.push(operation);
    for (const value of releasesByLastUse.get(operationIndex) ?? []) {
      const releaseOperation = operations.length;
      operations.push(Object.freeze({
        kind: "release",
        value,
        reason: "unique immutable ownership ends after the graph's final use",
      }));
      releases.push(Object.freeze({
        value,
        lastUseOperation: operationIndex,
        releaseOperation,
      }));
    }
  }
  const resolvedCore = Object.freeze({
    persistentSharing: core.persistentSharing,
    operations: Object.freeze(operations),
  });
  requireVerifiedFunctionalStorageCore(resolvedCore);
  return Object.freeze({
    core: resolvedCore,
    releases: Object.freeze(releases),
  });
}

function uniqueOwnedValues(
  core: FunctionalStorageCoreProgram,
): ReadonlyMap<string, UniqueOwnedValue> {
  const ownedValues = new Map<string, UniqueOwnedValue>();
  const lifetimes = new Map<string, string>();
  const touch = (value: string, operation: number): void => {
    const ownership = ownedValues.get(value);
    if (ownership !== undefined) ownership.lastUseOperation = operation;
  };
  for (const [operationIndex, operation] of core.operations.entries()) {
    if (operation.kind === "retain" || operation.kind === "release") {
      throw new TypeError(
        `functional unique ownership resolution operation ${operationIndex} already contains ${
          JSON.stringify(operation.kind)
        }; resolve explicit reference-counted traces with planFunctionalStorageReuse()`,
      );
    }
    if (operation.kind === "declare") {
      lifetimes.set(operation.value, operation.lifetime);
      if (operation.lifetime === "owned") {
        ownedValues.set(operation.value, {
          targets: new Set(),
          retainedByNonownedValue: false,
          owner: undefined,
          lastUseOperation: operationIndex,
        });
      }
      continue;
    }
    if (operation.kind === "promote") {
      lifetimes.set(
        operation.target,
        operation.targetLifetime === "owned" ? "owned" : "invocation-arena",
      );
      if (operation.targetLifetime === "owned") {
        ownedValues.set(operation.target, {
          targets: new Set(),
          retainedByNonownedValue: false,
          owner: undefined,
          lastUseOperation: operationIndex,
        });
      }
      continue;
    }
    if (operation.kind === "use") {
      touch(operation.value, operationIndex);
      continue;
    }
    if (operation.kind !== "reference") continue;
    touch(operation.owner, operationIndex);
    touch(operation.target, operationIndex);
    const ownerLifetime = lifetimes.get(operation.owner);
    const targetLifetime = lifetimes.get(operation.target);
    if (ownerLifetime !== "owned" && targetLifetime === "owned") {
      ownedValues.get(operation.target)!.retainedByNonownedValue = true;
      continue;
    }
    if (ownerLifetime !== "owned" || targetLifetime !== "owned") {
      continue;
    }
    const owner = ownedValues.get(operation.owner);
    const target = ownedValues.get(operation.target);
    if (owner === undefined || target === undefined) {
      throw new Error(
        `verified Functional Storage Core omitted unique ownership state for ${
          JSON.stringify(operation.owner)
        } -> ${JSON.stringify(operation.target)} at operation ${operationIndex}`,
      );
    }
    owner.targets.add(operation.target);
    target.owner = operation.owner;
  }
  return ownedValues;
}

function uniqueEscapingRoots(
  ownedValues: ReadonlyMap<string, UniqueOwnedValue>,
  escapingValues: readonly string[],
): ReadonlySet<string> {
  if (!Array.isArray(escapingValues)) {
    throw new TypeError("functional unique ownership escapingValues must be an array");
  }
  const escapingRoots = new Set<string>();
  for (const [value, ownership] of ownedValues) {
    if (ownership.retainedByNonownedValue) {
      escapingRoots.add(uniqueOwnershipRoot(value, ownedValues));
    }
  }
  const seen = new Set<string>();
  for (const [escapeIndex, value] of escapingValues.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(
        `functional unique ownership escaping value ${escapeIndex} must be a nonempty string`,
      );
    }
    if (seen.has(value)) {
      throw new TypeError(
        `functional unique ownership escaping values repeat ${JSON.stringify(value)}`,
      );
    }
    seen.add(value);
    if (!ownedValues.has(value)) {
      throw new TypeError(
        `functional unique ownership escaping value ${JSON.stringify(value)} is not owned`,
      );
    }
    escapingRoots.add(uniqueOwnershipRoot(value, ownedValues));
  }
  return escapingRoots;
}

function uniqueOwnershipRoot(
  value: string,
  ownedValues: ReadonlyMap<string, UniqueOwnedValue>,
): string {
  let root = value;
  let ownership = ownedValues.get(root);
  while (ownership?.owner !== undefined) {
    root = ownership.owner;
    ownership = ownedValues.get(root);
  }
  if (ownership !== undefined) return root;
  throw new Error(
    `verified Functional Storage Core omitted owner ${JSON.stringify(root)} for ${
      JSON.stringify(value)
    }`,
  );
}

function uniqueGraphLastUse(
  root: string,
  ownedValues: ReadonlyMap<string, UniqueOwnedValue>,
): number {
  const lastUses = new Map<string, number>();
  const pending: { readonly value: string; readonly expanded: boolean }[] = [{
    value: root,
    expanded: false,
  }];
  while (pending.length !== 0) {
    const current = pending.pop()!;
    if (lastUses.has(current.value)) continue;
    const ownership = ownedValues.get(current.value);
    if (ownership === undefined) {
      throw new Error(
        `verified Functional Storage Core omitted unique value ${JSON.stringify(current.value)}`,
      );
    }
    if (!current.expanded) {
      pending.push({ value: current.value, expanded: true });
      for (const target of ownership.targets) {
        if (!lastUses.has(target)) pending.push({ value: target, expanded: false });
      }
      continue;
    }
    let lastUse = ownership.lastUseOperation;
    for (const target of ownership.targets) {
      const targetLastUse = lastUses.get(target);
      if (targetLastUse === undefined) {
        throw new Error(
          `verified Functional Storage Core contains a unique ownership cycle through ${
            JSON.stringify(current.value)
          } -> ${JSON.stringify(target)}`,
        );
      }
      lastUse = Math.max(lastUse, targetLastUse);
    }
    lastUses.set(current.value, lastUse);
  }
  const lastUse = lastUses.get(root);
  if (lastUse !== undefined) return lastUse;
  throw new Error(`functional unique ownership root ${JSON.stringify(root)} has no last use`);
}
