import type { PersistentSharing, StorageCoreProgram, StorageVerification } from "./storage_core.ts";

export const StorageClass = {
  Static: "static",
  ScalarLocal: "scalar-local",
  InvocationArena: "invocation-arena",
  Owned: "owned",
  HostManaged: "host-managed",
} as const;

export type StorageClass = (typeof StorageClass)[keyof typeof StorageClass];

export type StoredValueKind = "closure" | "constructor" | "thunk";

export interface StorageDecision {
  readonly coreNode: number;
  readonly valueKind: StoredValueKind;
  readonly storage: StorageClass;
  readonly escapeStorage?: StorageClass;
  readonly capturedLocalCount: number;
  readonly reason: string;
}

export interface BoundaryStorageDecision {
  readonly path: string;
  readonly direction: "host-to-module" | "module-to-host";
  readonly storage: StorageClass;
  readonly reason: string;
}

export interface StorageReference {
  readonly owner: string;
  readonly target: string;
  readonly coreNode: number;
  readonly reason: string;
}

export interface StoragePlanSummary {
  readonly staticValues: number;
  readonly scalarLocalValues: number;
  readonly invocationArenaValues: number;
  readonly ownedBoundaries: number;
  readonly hostManagedBoundaries: number;
  readonly automaticArenaReset: boolean;
}

export interface StoragePlan {
  readonly values: readonly StorageDecision[];
  readonly references: readonly StorageReference[];
  readonly boundaries: readonly BoundaryStorageDecision[];
  readonly core: StorageCoreProgram;
  readonly verification: StorageVerification & { readonly ok: true };
  readonly summary: StoragePlanSummary;
}

export interface StoragePlanningOptions {
  readonly persistentSharing?: PersistentSharing;
  readonly storageCore?: StorageCoreProgram;
}
