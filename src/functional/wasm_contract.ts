import type { FunctionalType } from "./abi.ts";
import type { FunctionalStorageCoreProgram } from "./storage_core.ts";

export interface FunctionalWasmOwnedTypeExport {
  readonly name: string;
  readonly storageValue: string;
  readonly type: FunctionalType;
}

export interface FunctionalWasmCompilationOptions {
  readonly storageCore?: FunctionalStorageCoreProgram;
  readonly ownedTypeExports?: readonly FunctionalWasmOwnedTypeExport[];
}

export type FunctionalWasmRuntimeDiagnosticCode =
  | "F3002"
  | "F3003"
  | "F3005"
  | "F3007"
  | "F3010"
  | "F3011"
  | "F3012"
  | "F3013"
  | "F3101"
  | "F3102"
  | "F3103"
  | "F3104";

export type FunctionalWasmRuntimeFaultKind =
  | "out-of-fuel"
  | "out-of-memory"
  | "blackhole"
  | "divide-by-zero"
  | "result-too-large"
  | "cyclic-result"
  | "invalid-numeric-conversion"
  | "explicit-fault"
  | "out-of-bounds"
  | "host-operation"
  | "async-replay-diverged"
  | "trap"
  | "suspension-limit";

export interface FunctionalWasmRuntimeErrorDetails {
  readonly code: FunctionalWasmRuntimeDiagnosticCode;
  readonly kind: FunctionalWasmRuntimeFaultKind;
  readonly entryDefinition: number;
  readonly entryName: string;
  readonly coreNode?: number;
  readonly span?: { readonly startByte: number; readonly endByte: number };
  readonly location?: {
    readonly module: string;
    readonly span: { readonly startByte: number; readonly endByte: number };
  };
  readonly capability?: string;
  readonly operation?: string;
  readonly message: string;
}

export type FunctionalWasmBoundaryDiagnosticCode = "F4101" | "F4102";

export type FunctionalWasmBoundaryFaultKind = "invalid-argument" | "invalid-init";

export interface FunctionalWasmBoundaryErrorDetails {
  readonly code: FunctionalWasmBoundaryDiagnosticCode;
  readonly kind: FunctionalWasmBoundaryFaultKind;
  readonly message: string;
  readonly path?: string;
}

export interface FunctionalWasmExportDeclaration {
  readonly name: string;
  readonly definition: string;
}

export type FunctionalWasmHostOperation = (
  argument: FunctionalWasmHostValue,
) => FunctionalWasmHostValue;

export type FunctionalWasmAsyncHostOperation = (
  argument: FunctionalWasmHostValue,
) => FunctionalWasmHostValue | PromiseLike<FunctionalWasmHostValue>;

export type FunctionalWasmHostValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "array"; readonly values: readonly FunctionalWasmHostValue[] }
  | { readonly kind: "slice"; readonly values: readonly FunctionalWasmHostValue[] }
  | { readonly kind: "resource"; readonly id: number }
  | {
    readonly kind: "tuple";
    readonly values: readonly [FunctionalWasmHostValue, FunctionalWasmHostValue];
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fields: readonly FunctionalWasmHostValue[];
  };

export type FunctionalWasmInitBinding = FunctionalWasmHostValue | FunctionalWasmHostOperation;

export interface FunctionalWasmInit {
  readonly [capability: string]: Readonly<Record<string, FunctionalWasmInitBinding>>;
}

export interface FunctionalWasmAsyncInit {
  readonly [capability: string]: Readonly<
    Record<string, FunctionalWasmHostValue | FunctionalWasmAsyncHostOperation>
  >;
}
