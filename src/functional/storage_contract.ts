import type {
  FunctionalPersistentSharing,
  FunctionalStorageCoreProgram,
  FunctionalStorageVerification,
} from "./storage_core.ts";

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

export interface FunctionalStorageReference {
  readonly owner: string;
  readonly target: string;
  readonly coreNode: number;
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
  readonly references: readonly FunctionalStorageReference[];
  readonly boundaries: readonly FunctionalBoundaryStorageDecision[];
  readonly core: FunctionalStorageCoreProgram;
  readonly verification: FunctionalStorageVerification & { readonly ok: true };
  readonly summary: FunctionalStoragePlanSummary;
}

export interface FunctionalStoragePlanningOptions {
  readonly persistentSharing?: FunctionalPersistentSharing;
  readonly storageCore?: FunctionalStorageCoreProgram;
}
