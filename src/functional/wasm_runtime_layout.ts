export const FunctionalWasmRuntimeGlobal = Object.freeze(
  {
    HeapTop: 0,
    ThunkEvaluations: 1,
    RuntimeFault: 2,
    HeapCapacityByteLength: 3,
    FreeListHead: 4,
    RuntimeFaultNode: 5,
    ArenaDepth: 6,
    ComptimeFuel: 7,
    ComptimeSteps: 8,
  } as const,
);

export interface FunctionalWasmCompactRuntimeGlobals {
  readonly fault?: {
    readonly code: number;
    readonly node: number;
  };
  readonly fuel?: {
    readonly remaining: number;
    readonly steps: number;
  };
}

export const FUNCTIONAL_WASM_ALLOCATION_MAGIC = 0x4750_5541;
export const FUNCTIONAL_WASM_FREE_BLOCK_MAGIC = 0x4750_5546;
export const FUNCTIONAL_WASM_MINIMUM_ALLOCATION_BYTE_LENGTH = 16;
export const FUNCTIONAL_WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH = 0xffff_0000;
