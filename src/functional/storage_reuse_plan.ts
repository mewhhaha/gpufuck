import {
  type FunctionalStorageCoreProgram,
  requireVerifiedFunctionalStorageCore,
} from "./storage_core.ts";

export interface FunctionalStorageAllocationShape {
  readonly value: string;
  readonly byteLength: number;
}

export interface FunctionalStorageReferenceCountStep {
  readonly operation: number;
  readonly value: string;
  readonly kind: "retain" | "release";
  readonly references: number;
}

export interface FunctionalStorageReuseDecision {
  readonly releasedValue: string;
  readonly reusedBy: string;
  readonly byteLength: number;
  readonly releaseOperation: number;
  readonly allocationOperation: number;
}

export interface FunctionalStorageReusePlan {
  readonly referenceCounts: readonly FunctionalStorageReferenceCountStep[];
  readonly reuses: readonly FunctionalStorageReuseDecision[];
}

export function planFunctionalStorageReuse(
  core: FunctionalStorageCoreProgram,
  allocations: readonly FunctionalStorageAllocationShape[],
): FunctionalStorageReusePlan {
  requireVerifiedFunctionalStorageCore(core);
  const byteLengths = allocationByteLengths(allocations);
  const references = new Map<string, number>();
  const ownedTargets = new Map<string, Set<string>>();
  const releasedByByteLength = new Map<
    number,
    { readonly value: string; readonly operation: number }[]
  >();
  const referenceCounts: FunctionalStorageReferenceCountStep[] = [];
  const reuses: FunctionalStorageReuseDecision[] = [];
  for (const [operationIndex, operation] of core.operations.entries()) {
    const allocatedValue = operation.kind === "declare" && operation.lifetime === "owned"
      ? operation.value
      : operation.kind === "promote" && operation.targetLifetime === "owned"
      ? operation.target
      : undefined;
    if (allocatedValue !== undefined) {
      references.set(allocatedValue, 1);
      ownedTargets.set(allocatedValue, new Set());
      const byteLength = byteLengths.get(allocatedValue);
      if (byteLength === undefined) continue;
      const released = releasedByByteLength.get(byteLength)?.pop();
      if (released === undefined) continue;
      reuses.push(Object.freeze({
        releasedValue: released.value,
        reusedBy: allocatedValue,
        byteLength,
        releaseOperation: released.operation,
        allocationOperation: operationIndex,
      }));
      continue;
    }
    if (operation.kind === "reference") {
      if (ownedTargets.has(operation.owner) && ownedTargets.has(operation.target)) {
        ownedTargets.get(operation.owner)!.add(operation.target);
      }
      continue;
    }
    if (operation.kind === "retain") {
      const current = requiredReferenceCount(references, operation.value, operationIndex);
      const next = current + 1;
      references.set(operation.value, next);
      referenceCounts.push(Object.freeze({
        operation: operationIndex,
        value: operation.value,
        kind: "retain",
        references: next,
      }));
      continue;
    }
    if (operation.kind !== "release") continue;
    const pending = [operation.value];
    while (pending.length !== 0) {
      const value = pending.pop()!;
      const current = requiredReferenceCount(references, value, operationIndex);
      const next = current - 1;
      references.set(value, next);
      referenceCounts.push(Object.freeze({
        operation: operationIndex,
        value,
        kind: "release",
        references: next,
      }));
      if (next !== 0) continue;
      pending.push(...ownedTargets.get(value) ?? []);
      const byteLength = byteLengths.get(value);
      if (byteLength === undefined) continue;
      const released = releasedByByteLength.get(byteLength) ?? [];
      released.push({ value, operation: operationIndex });
      releasedByByteLength.set(byteLength, released);
    }
  }
  return Object.freeze({
    referenceCounts: Object.freeze(referenceCounts),
    reuses: Object.freeze(reuses),
  });
}

function requiredReferenceCount(
  references: ReadonlyMap<string, number>,
  value: string,
  operation: number,
): number {
  const count = references.get(value);
  if (count !== undefined) return count;
  throw new Error(
    `verified Functional Storage Core omitted owned reference count for ${
      JSON.stringify(value)
    } at operation ${operation}`,
  );
}

function allocationByteLengths(
  allocations: readonly FunctionalStorageAllocationShape[],
): ReadonlyMap<string, number> {
  if (!Array.isArray(allocations)) {
    throw new TypeError("functional storage reuse allocations must be an array");
  }
  const byteLengths = new Map<string, number>();
  for (const [allocationIndex, allocation] of allocations.entries()) {
    if (allocation === null || typeof allocation !== "object") {
      throw new TypeError(
        `functional storage reuse allocation ${allocationIndex} must be an object`,
      );
    }
    if (typeof allocation.value !== "string" || allocation.value.length === 0) {
      throw new TypeError(
        `functional storage reuse allocation ${allocationIndex} value must be nonempty`,
      );
    }
    if (!Number.isSafeInteger(allocation.byteLength) || allocation.byteLength <= 0) {
      throw new RangeError(
        `functional storage reuse allocation ${
          JSON.stringify(allocation.value)
        } byte length must be positive; received ${allocation.byteLength}`,
      );
    }
    if (byteLengths.has(allocation.value)) {
      throw new Error(
        `functional storage reuse allocations repeat ${JSON.stringify(allocation.value)}`,
      );
    }
    byteLengths.set(allocation.value, allocation.byteLength);
  }
  return byteLengths;
}
