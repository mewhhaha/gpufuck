export const FUNCTIONAL_WASM_VALUE_ABI_VERSION = 1;

export interface FunctionalWasmValueAbiLayout {
  readonly version: number;
  readonly valueByteLength: number;
  readonly objectAlignment: number;
  readonly objectHeaderByteLength: number;
  readonly objectKindByteOffset: number;
  readonly objectPayloadByteOffset: number;
  readonly objectValueCountByteOffset: number;
  readonly objectValuesByteOffset: number;
  readonly objectKinds: Readonly<{
    closure: number;
    constructor: number;
    thunk: number;
    numeric: number;
    text: number;
    bytes: number;
    array: number;
    slice: number;
    resource: number;
  }>;
  readonly numericKinds: Readonly<{
    signedInteger64: number;
    float32: number;
    float64: number;
  }>;
  readonly immediateTags: Readonly<{
    integer: number;
    boolean: number;
    bitMask: number;
    payloadShift: number;
  }>;
}

export const FunctionalWasmValueAbi: FunctionalWasmValueAbiLayout = Object.freeze(
  {
    version: FUNCTIONAL_WASM_VALUE_ABI_VERSION,
    valueByteLength: 8,
    objectAlignment: 8,
    objectHeaderByteLength: 16,
    objectKindByteOffset: 0,
    objectPayloadByteOffset: 4,
    objectValueCountByteOffset: 8,
    objectValuesByteOffset: 16,
    objectKinds: Object.freeze({
      closure: 1,
      constructor: 2,
      thunk: 3,
      numeric: 4,
      text: 5,
      bytes: 6,
      array: 7,
      slice: 8,
      resource: 9,
    }),
    numericKinds: Object.freeze({
      signedInteger64: 1,
      float32: 2,
      float64: 3,
    }),
    immediateTags: Object.freeze({
      integer: 1,
      boolean: 2,
      bitMask: 7,
      payloadShift: 3,
    }),
  } as const,
);
