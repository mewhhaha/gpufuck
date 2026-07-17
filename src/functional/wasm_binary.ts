export const WasmValueType = {
  I32: 0x7f,
  I64: 0x7e,
  F32: 0x7d,
  F64: 0x7c,
} as const;

export interface WasmFunctionBody {
  readonly typeIndex: number;
  readonly localTypes: readonly number[];
  readonly instructions: readonly number[];
  readonly usesMemory: boolean;
  readonly usesIndirectCalls: boolean;
}

export interface WasmFunctionImport {
  readonly module: string;
  readonly name: string;
  readonly typeIndex: number;
}

export interface WasmFunctionType {
  readonly parameters: readonly number[];
  readonly results: readonly number[];
}

export class WasmInstructions {
  readonly bytes: number[] = [];
  readonly localTypes: number[] = [];
  usesMemory = false;
  usesIndirectCalls = false;

  readonly #parameterCount: number;

  constructor(parameterCount: number) {
    this.#parameterCount = parameterCount;
  }

  addLocal(type: number): number {
    const index = this.#parameterCount + this.localTypes.length;
    this.localTypes.push(type);
    return index;
  }

  emit(...bytes: number[]): void {
    this.bytes.push(...bytes);
  }

  unsigned(value: number): void {
    this.bytes.push(...encodeUnsigned(value));
  }

  signed32(value: number): void {
    this.bytes.push(...encodeSigned(BigInt(value | 0)));
  }

  signed64(value: bigint): void {
    this.bytes.push(...encodeSigned(value));
  }

  localGet(index: number): void {
    this.emit(0x20);
    this.unsigned(index);
  }

  localSet(index: number): void {
    this.emit(0x21);
    this.unsigned(index);
  }

  localTee(index: number): void {
    this.emit(0x22);
    this.unsigned(index);
  }

  call(index: number): void {
    this.emit(0x10);
    this.unsigned(index);
  }

  callIndirect(typeIndex: number, tableIndex = 0): void {
    this.usesIndirectCalls = true;
    this.emit(0x11);
    this.unsigned(typeIndex);
    this.unsigned(tableIndex);
  }

  globalGet(index: number): void {
    this.emit(0x23);
    this.unsigned(index);
  }

  globalSet(index: number): void {
    this.emit(0x24);
    this.unsigned(index);
  }

  branch(depth: number): void {
    this.emit(0x0c);
    this.unsigned(depth);
  }

  i32Const(value: number): void {
    this.emit(0x41);
    this.signed32(value);
  }

  i64Const(value: bigint): void {
    this.emit(0x42);
    this.signed64(value);
  }

  f32Const(value: number): void {
    const bytes = new ArrayBuffer(4);
    const view = new DataView(bytes);
    view.setFloat32(0, value, true);
    this.emit(0x43, ...new Uint8Array(bytes));
  }

  f64Const(value: number): void {
    const bytes = new ArrayBuffer(8);
    const view = new DataView(bytes);
    view.setFloat64(0, value, true);
    this.emit(0x44, ...new Uint8Array(bytes));
  }

  i32Load(offset: number, alignment = 2): void {
    this.usesMemory = true;
    this.emit(0x28);
    this.unsigned(alignment);
    this.unsigned(offset);
  }

  i64Load(offset: number, alignment = 3): void {
    this.usesMemory = true;
    this.emit(0x29);
    this.unsigned(alignment);
    this.unsigned(offset);
  }

  f32Load(offset: number, alignment = 2): void {
    this.usesMemory = true;
    this.emit(0x2a);
    this.unsigned(alignment);
    this.unsigned(offset);
  }

  f64Load(offset: number, alignment = 3): void {
    this.usesMemory = true;
    this.emit(0x2b);
    this.unsigned(alignment);
    this.unsigned(offset);
  }

  i32Store(offset: number, alignment = 2): void {
    this.usesMemory = true;
    this.emit(0x36);
    this.unsigned(alignment);
    this.unsigned(offset);
  }

  i64Store(offset: number, alignment = 3): void {
    this.usesMemory = true;
    this.emit(0x37);
    this.unsigned(alignment);
    this.unsigned(offset);
  }

  f32Store(offset: number, alignment = 2): void {
    this.usesMemory = true;
    this.emit(0x38);
    this.unsigned(alignment);
    this.unsigned(offset);
  }

  f64Store(offset: number, alignment = 3): void {
    this.usesMemory = true;
    this.emit(0x39);
    this.unsigned(alignment);
    this.unsigned(offset);
  }
}

export function encodeWasmModule(
  imports: readonly WasmFunctionImport[],
  functions: readonly WasmFunctionBody[],
  indirectFunctionIndices: readonly number[],
  entryFunctionIndex: number,
  heapStart: number,
  specializedCallSiteCount: number,
  additionalFunctionTypes: readonly WasmFunctionType[],
  valueForceFunctionIndex?: number,
  initializeFunctionIndex?: number,
): Uint8Array<ArrayBuffer> {
  const types = wasmFunctionTypes(additionalFunctionTypes);
  const sections = [
    section(1, vector(types)),
    ...(imports.length === 0 ? [] : [section(
      2,
      vector(imports.map((imported) => [
        ...name(imported.module),
        ...name(imported.name),
        0x00,
        ...encodeUnsigned(imported.typeIndex),
      ])),
    )]),
    section(3, vector(functions.map((body) => encodeUnsigned(body.typeIndex)))),
    section(4, vector([[0x70, 0x00, ...encodeUnsigned(indirectFunctionIndices.length)]])),
    section(5, vector([[0x00, 0x01]])),
    section(
      6,
      vector([
        [0x7f, 0x01, 0x41, ...encodeSigned(BigInt(heapStart)), 0x0b],
        [0x7f, 0x01, 0x41, 0x00, 0x0b],
        [0x7f, 0x01, 0x41, 0x00, 0x0b],
        [0x7f, 0x01, 0x41, ...encodeSigned(65_536n), 0x0b],
        [0x7f, 0x00, 0x41, ...encodeSigned(BigInt(specializedCallSiteCount)), 0x0b],
      ]),
    ),
    section(
      7,
      vector([
        [...name("main"), 0x00, ...encodeUnsigned(entryFunctionIndex)],
        ...(valueForceFunctionIndex === undefined
          ? []
          : [[...name("forceValue"), 0x00, ...encodeUnsigned(valueForceFunctionIndex)]]),
        ...(initializeFunctionIndex === undefined
          ? []
          : [[...name("initialize"), 0x00, ...encodeUnsigned(initializeFunctionIndex)]]),
        [...name("memory"), 0x02, 0x00],
        [...name("thunkEvaluations"), 0x03, 0x01],
        [...name("runtimeFault"), 0x03, 0x02],
        [...name("heapTop"), 0x03, 0x00],
        [...name("specializedCallSites"), 0x03, 0x04],
      ]),
    ),
    section(
      9,
      vector([
        [
          0x00,
          0x41,
          0x00,
          0x0b,
          ...vector(indirectFunctionIndices.map(encodeUnsigned)),
        ],
      ]),
    ),
    section(10, vector(functions.map(encodeFunctionBody))),
  ];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...sections.flat(),
  ]);
}

export function encodeCompactScalarWasmModule(
  functions: readonly WasmFunctionBody[],
  entryFunctionIndex: number,
  specializedCallSiteCount: number,
  additionalFunctionTypes: readonly WasmFunctionType[],
): Uint8Array<ArrayBuffer> {
  const sections = [
    section(1, vector(wasmFunctionTypes(additionalFunctionTypes))),
    section(3, vector(functions.map((body) => encodeUnsigned(body.typeIndex)))),
    section(
      6,
      vector([
        [0x7f, 0x00, 0x41, 0x00, 0x0b],
        [0x7f, 0x00, 0x41, 0x00, 0x0b],
        [0x7f, 0x00, 0x41, 0x00, 0x0b],
        [
          0x7f,
          0x00,
          0x41,
          ...encodeSigned(BigInt(specializedCallSiteCount)),
          0x0b,
        ],
      ]),
    ),
    section(
      7,
      vector([
        [...name("main"), 0x00, ...encodeUnsigned(entryFunctionIndex)],
        [...name("thunkEvaluations"), 0x03, 0x01],
        [...name("runtimeFault"), 0x03, 0x02],
        [...name("heapTop"), 0x03, 0x00],
        [...name("specializedCallSites"), 0x03, 0x03],
      ]),
    ),
    section(10, vector(functions.map(encodeFunctionBody))),
  ];
  return new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...sections.flat(),
  ]);
}

function wasmFunctionTypes(additionalFunctionTypes: readonly WasmFunctionType[]): number[][] {
  return [
    functionType([WasmValueType.I32], [WasmValueType.I32]),
    functionType([], [WasmValueType.I64]),
    functionType([WasmValueType.I32, WasmValueType.I64], [WasmValueType.I64]),
    functionType([], [WasmValueType.I32]),
    functionType([WasmValueType.I32], [WasmValueType.I64]),
    ...additionalFunctionTypes.map((type) => functionType(type.parameters, type.results)),
  ];
}

function functionType(parameters: readonly number[], results: readonly number[]): number[] {
  return [
    0x60,
    ...vector(parameters.map((type) => [type])),
    ...vector(results.map((type) => [type])),
  ];
}

function encodeFunctionBody(body: WasmFunctionBody): number[] {
  const localGroups: number[][] = [];
  for (const type of body.localTypes) {
    const last = localGroups.at(-1);
    if (last?.[1] === type) {
      last[0]! += 1;
    } else {
      localGroups.push([1, type]);
    }
  }
  const locals = vector(
    localGroups.map(([count, type]) => [...encodeUnsigned(count!), type!]),
  );
  const encoded = [...locals, ...body.instructions, 0x0b];
  return [...encodeUnsigned(encoded.length), ...encoded];
}

function section(id: number, contents: readonly number[]): number[] {
  return [id, ...encodeUnsigned(contents.length), ...contents];
}

function vector(values: readonly (readonly number[])[]): number[] {
  const encoded: number[] = [...encodeUnsigned(values.length)];
  for (const value of values) encoded.push(...value);
  return encoded;
}

function name(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [...encodeUnsigned(bytes.length), ...bytes];
}

function encodeUnsigned(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`WebAssembly unsigned integer must be non-negative; received ${value}`);
  }
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value = Math.floor(value / 128);
    bytes.push(value === 0 ? byte : byte | 0x80);
  } while (value !== 0);
  return bytes;
}

function encodeSigned(value: bigint): number[] {
  const bytes: number[] = [];
  while (true) {
    const byte = Number(value & 0x7fn);
    value >>= 7n;
    const signBit = (byte & 0x40) !== 0;
    if ((value === 0n && !signBit) || (value === -1n && signBit)) {
      bytes.push(byte);
      return bytes;
    }
    bytes.push(byte | 0x80);
  }
}
