import type { Type } from "./schema_contract.ts";
import type { StorageCoreProgram } from "./storage_core.ts";

export type { WasmExportDeclaration } from "./module_contract.ts";

export interface WasmOwnedTypeExport {
  readonly name: string;
  readonly storageValue: string;
  readonly type: Type;
}

export type WasmBackend = "linear-memory" | "wasm-gc";
export type WasmSimdMode = "portable-scalar" | "wasm-simd";

export interface WasmCompilationOptions {
  readonly backend?: WasmBackend;
  readonly simd?: WasmSimdMode;
  readonly storageCore?: StorageCoreProgram;
  readonly ownedTypeExports?: readonly WasmOwnedTypeExport[];
}

export interface ComponentBoundaryOptions {
  readonly packageName?: string;
  readonly worldName?: string;
}

export interface ComponentBoundaryArtifact {
  readonly coreWasm: Uint8Array<ArrayBuffer>;
  readonly wit: string;
}

export type WasmRuntimeDiagnosticCode =
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

export type WasmRuntimeFaultKind =
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

export interface WasmRuntimeErrorDetails {
  readonly code: WasmRuntimeDiagnosticCode;
  readonly kind: WasmRuntimeFaultKind;
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

export type WasmBoundaryDiagnosticCode = "F4101" | "F4102";

export type WasmBoundaryFaultKind = "invalid-argument" | "invalid-init";

export interface WasmBoundaryErrorDetails {
  readonly code: WasmBoundaryDiagnosticCode;
  readonly kind: WasmBoundaryFaultKind;
  readonly message: string;
  readonly path?: string;
}

export type WasmHostOperation = (
  argument: WasmHostValue,
) => WasmHostValue;

export type RuntimeTypeDescriptor = Type;

export type WasmAsyncHostOperation = (
  argument: WasmHostValue,
) => WasmHostValue | PromiseLike<WasmHostValue>;

export type WasmHostValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "array"; readonly values: readonly WasmHostValue[] }
  | { readonly kind: "slice"; readonly values: readonly WasmHostValue[] }
  | { readonly kind: "resource"; readonly id: number }
  | {
    readonly kind: "erased";
    readonly type: RuntimeTypeDescriptor;
    readonly value: WasmHostValue;
  }
  | {
    readonly kind: "tuple";
    readonly values: readonly [WasmHostValue, WasmHostValue];
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fields: readonly WasmHostValue[];
  };

export type WasmInitBinding = WasmHostValue | WasmHostOperation;

export interface WasmInit {
  readonly [capability: string]: Readonly<Record<string, WasmInitBinding>>;
}

export interface WasmAsyncInit {
  readonly [capability: string]: Readonly<
    Record<string, WasmHostValue | WasmAsyncHostOperation>
  >;
}
