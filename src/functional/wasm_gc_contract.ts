export const FUNCTIONAL_WASM_GC_ABI_VERSION = 2;

export const FunctionalWasmGcValueKind = {
  Integer: 0,
  Boolean: 1,
  Constructor: 2,
  SignedInteger64: 3,
  Float32: 4,
  Float64: 5,
  WholeNumberF64: 6,
  Closure: 7,
  Thunk: 8,
  Store: 9,
} as const;
