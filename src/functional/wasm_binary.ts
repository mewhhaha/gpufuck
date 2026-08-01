import { type WasmCompactRuntimeGlobals, WasmRuntimeGlobal } from "./wasm_runtime_layout.ts";

export const WasmValueType = {
  I32: 0x7f,
  I64: 0x7e,
  F32: 0x7d,
  F64: 0x7c,
  V128: 0x7b,
} as const;

export const WasmFunctionTypeIndex = Object.freeze(
  {
    Allocator: 0,
    NullaryValue: 1,
    ClosureCall: 2,
    NullaryI32: 3,
    ThunkForce: 4,
  } as const,
);

export interface WasmFunctionBody {
  readonly typeIndex: number;
  readonly localTypes: readonly number[];
  readonly instructions: readonly number[];
  readonly branchHints: readonly WasmBranchHint[];
  readonly signedInteger64Literals: readonly WasmSignedInteger64Literal[];
  readonly usesMemory: boolean;
  readonly usesIndirectCalls: boolean;
}

export interface WasmBranchHint {
  readonly instructionOffset: number;
  readonly conditionLikely: boolean;
}

export interface WasmSignedInteger64Literal {
  readonly nodeIndex: number;
  readonly immediateOffset: number;
  readonly immediateLength: number;
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

export interface WasmModuleEncoding {
  readonly imports: readonly WasmFunctionImport[];
  readonly functions: readonly WasmFunctionBody[];
  readonly indirectFunctionIndices: readonly number[];
  readonly entryFunctionIndex: number;
  readonly heapStart: number;
  readonly additionalFunctionTypes: readonly WasmFunctionType[];
  readonly valueForceFunctionIndex?: number;
  readonly initializeFunctionIndex?: number;
  readonly allocateFunctionIndex?: number;
  readonly freeFunctionIndex?: number;
  readonly functionExports?: readonly {
    readonly name: string;
    readonly functionIndex: number;
  }[];
  readonly instrumentedFuel?: boolean;
  readonly canonicalAbiVersion?: {
    readonly major: number;
    readonly minor: number;
  };
}

export interface CachedWasmFunctionBody {
  readonly body: WasmFunctionBody;
  readonly encoded: readonly number[];
}

export interface EncodedWasmModule {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly functionBodies: readonly CachedWasmFunctionBody[];
  readonly sectionsBeforeCode: readonly (readonly number[])[];
  readonly reusedFunctionBodies: number;
  readonly reusedSectionsBeforeCode: boolean;
}

export const WASM_BASE_FUNCTION_TYPES: readonly WasmFunctionType[] = Object.freeze([
  { parameters: [WasmValueType.I32], results: [WasmValueType.I32] },
  { parameters: [], results: [WasmValueType.I64] },
  { parameters: [WasmValueType.I32, WasmValueType.I64], results: [WasmValueType.I64] },
  { parameters: [], results: [WasmValueType.I32] },
  { parameters: [WasmValueType.I32], results: [WasmValueType.I64] },
]);

export const WASM_BASE_FUNCTION_TYPE_COUNT = WASM_BASE_FUNCTION_TYPES.length;

export class WasmInstructions {
  readonly bytes: number[] = [];
  readonly localTypes: number[] = [];
  readonly signedInteger64Literals: WasmSignedInteger64Literal[] = [];
  readonly branchHints: WasmBranchHint[] = [];
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

  // Rest parameters allocate at every opcode site; fixed slots keep this hot path allocation-free.
  emit(
    first: number,
    second?: number,
    third?: number,
    fourth?: number,
    fifth?: number,
    sixth?: number,
    seventh?: number,
    eighth?: number,
    ninth?: number,
  ): void {
    this.bytes.push(first);
    if (second === undefined) return;
    this.bytes.push(second);
    if (third === undefined) return;
    this.bytes.push(third);
    if (fourth === undefined) return;
    this.bytes.push(fourth);
    if (fifth === undefined) return;
    this.bytes.push(fifth);
    if (sixth === undefined) return;
    this.bytes.push(sixth);
    if (seventh === undefined) return;
    this.bytes.push(seventh);
    if (eighth === undefined) return;
    this.bytes.push(eighth);
    if (ninth !== undefined) this.bytes.push(ninth);
  }

  simd(opcode: number, ...immediateBytes: number[]): void {
    this.emit(0xfd);
    this.unsigned(opcode);
    for (const byte of immediateBytes) this.bytes.push(byte);
  }

  hintedIf(blockType: number, conditionLikely: boolean): void {
    this.branchHints.push({
      instructionOffset: this.bytes.length,
      conditionLikely,
    });
    this.emit(0x04, blockType);
  }

  trapIf(): void {
    this.hintedIf(0x40, false);
    this.emit(0x00, 0x0b);
  }

  unsigned(value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`WebAssembly unsigned integer must be non-negative; received ${value}`);
    }
    do {
      const byte = value & 0x7f;
      value = Math.floor(value / 128);
      this.bytes.push(value === 0 ? byte : byte | 0x80);
    } while (value !== 0);
  }

  signed32(value: number): void {
    value |= 0;
    while (true) {
      const byte = value & 0x7f;
      value >>= 7;
      const signBit = (byte & 0x40) !== 0;
      if ((value === 0 && !signBit) || (value === -1 && signBit)) {
        this.bytes.push(byte);
        return;
      }
      this.bytes.push(byte | 0x80);
    }
  }

  signed64(value: bigint): void {
    appendSignedInteger64(this.bytes, value);
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

  branchIf(depth: number): void {
    this.emit(0x0d);
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

  signedInteger64Literal(nodeIndex: number, value: bigint): void {
    this.emit(0x42);
    const immediateOffset = this.bytes.length;
    this.signed64(value);
    this.signedInteger64Literals.push({
      nodeIndex,
      immediateOffset,
      immediateLength: this.bytes.length - immediateOffset,
    });
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

  i32Load8Unsigned(offset: number): void {
    this.usesMemory = true;
    this.emit(0x2d);
    this.unsigned(0);
    this.unsigned(offset);
  }

  i32Load16Unsigned(offset: number): void {
    this.usesMemory = true;
    this.emit(0x2f);
    this.unsigned(1);
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

  i32Store8(offset: number): void {
    this.usesMemory = true;
    this.emit(0x3a);
    this.unsigned(0);
    this.unsigned(offset);
  }

  i32Store16(offset: number): void {
    this.usesMemory = true;
    this.emit(0x3b);
    this.unsigned(1);
    this.unsigned(offset);
  }

  memorySize(): void {
    this.usesMemory = true;
    this.emit(0x3f, 0x00);
  }

  memoryGrow(): void {
    this.usesMemory = true;
    this.emit(0x40, 0x00);
  }

  memoryCopy(): void {
    this.usesMemory = true;
    this.emit(0xfc);
    this.unsigned(10);
    this.unsigned(0);
    this.unsigned(0);
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

export function encodeSignedWasmInteger64(value: bigint): readonly number[] {
  const bytes: number[] = [];
  appendSignedInteger64(bytes, value);
  return bytes;
}

function appendSignedInteger64(bytes: number[], value: bigint): void {
  while (true) {
    const byte = Number(value & 0x7fn);
    value >>= 7n;
    const signBit = (byte & 0x40) !== 0;
    if ((value === 0n && !signBit) || (value === -1n && signBit)) {
      bytes.push(byte);
      return;
    }
    bytes.push(byte | 0x80);
  }
}

export function encodeWasmModule(
  encoding: WasmModuleEncoding,
  cachedFunctionBodies: readonly CachedWasmFunctionBody[] = [],
  cachedSectionsBeforeCode?: readonly (readonly number[])[],
): EncodedWasmModule {
  const { functions } = encoding;
  let reusedFunctionBodies = 0;
  const functionBodies = functions.map((body, index) => {
    const cached = cachedFunctionBodies[index];
    if (cached?.body !== body) return { body, encoded: encodeFunctionBody(body) };
    reusedFunctionBodies += 1;
    return cached;
  });
  const sectionsBeforeCode = cachedSectionsBeforeCode ?? encodeSectionsBeforeCode(encoding);
  const bytes = assembleWasmModule(
    sectionsBeforeCode,
    functionBodies.length,
    functionBodies.map((body) => body.encoded),
    encodeBranchHintSection(encoding.functions, encoding.imports.length),
  );
  return {
    bytes,
    functionBodies,
    sectionsBeforeCode,
    reusedFunctionBodies,
    reusedSectionsBeforeCode: cachedSectionsBeforeCode !== undefined,
  };
}

export function encodeWasmModuleWithEncodedFunctionBodies(
  encoding: WasmModuleEncoding,
  encodedFunctionBodies: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  return assembleWasmModule(
    encodeSectionsBeforeCode(encoding),
    encoding.functions.length,
    [encodedFunctionBodies],
    encodeBranchHintSection(encoding.functions, encoding.imports.length),
  );
}

function encodeSectionsBeforeCode(
  encoding: WasmModuleEncoding,
): readonly (readonly number[])[] {
  const {
    imports,
    functions,
    indirectFunctionIndices,
    entryFunctionIndex,
    heapStart,
    additionalFunctionTypes,
    valueForceFunctionIndex,
    initializeFunctionIndex,
    allocateFunctionIndex,
    freeFunctionIndex,
    functionExports = [],
    instrumentedFuel = false,
    canonicalAbiVersion,
  } = encoding;
  const runtimeGlobalCount = instrumentedFuel ? 9 : 7;
  return [
    section(1, vector(wasmFunctionTypes(additionalFunctionTypes))),
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
        [0x7f, 0x01, 0x41, 0x00, 0x0b],
        [0x7f, 0x01, 0x41, ...encodeSigned(-1n), 0x0b],
        [0x7f, 0x01, 0x41, 0x00, 0x0b],
        ...(instrumentedFuel
          ? [
            [0x7f, 0x01, 0x41, 0x00, 0x0b],
            [0x7f, 0x01, 0x41, 0x00, 0x0b],
          ]
          : []),
        ...(canonicalAbiVersion === undefined ? [] : [
          [
            0x7f,
            0x00,
            0x41,
            ...encodeSigned(BigInt(canonicalAbiVersion.major)),
            0x0b,
          ],
          [
            0x7f,
            0x00,
            0x41,
            ...encodeSigned(BigInt(canonicalAbiVersion.minor)),
            0x0b,
          ],
        ]),
      ]),
    ),
    section(
      7,
      vector([
        ...(canonicalAbiVersion === undefined
          ? [[...name("main"), 0x00, ...encodeUnsigned(entryFunctionIndex)]]
          : []),
        ...(canonicalAbiVersion !== undefined || valueForceFunctionIndex === undefined
          ? []
          : [[...name("forceValue"), 0x00, ...encodeUnsigned(valueForceFunctionIndex)]]),
        ...(canonicalAbiVersion !== undefined || initializeFunctionIndex === undefined
          ? []
          : [[...name("initialize"), 0x00, ...encodeUnsigned(initializeFunctionIndex)]]),
        ...(canonicalAbiVersion !== undefined || allocateFunctionIndex === undefined
          ? []
          : [[...name("allocate"), 0x00, ...encodeUnsigned(allocateFunctionIndex)]]),
        ...(canonicalAbiVersion !== undefined || freeFunctionIndex === undefined
          ? []
          : [[...name("free"), 0x00, ...encodeUnsigned(freeFunctionIndex)]]),
        ...functionExports.map((exported) => [
          ...name(exported.name),
          0x00,
          ...encodeUnsigned(exported.functionIndex),
        ]),
        [...name("memory"), 0x02, 0x00],
        globalExport("runtimeFault", WasmRuntimeGlobal.RuntimeFault),
        globalExport("runtimeFaultNode", WasmRuntimeGlobal.RuntimeFaultNode),
        ...(canonicalAbiVersion === undefined
          ? [
            globalExport("thunkEvaluations", WasmRuntimeGlobal.ThunkEvaluations),
            globalExport("heapTop", WasmRuntimeGlobal.HeapTop),
            globalExport("freeListHead", WasmRuntimeGlobal.FreeListHead),
            globalExport("arenaDepth", WasmRuntimeGlobal.ArenaDepth),
            ...(instrumentedFuel
              ? [
                globalExport("comptimeFuel", WasmRuntimeGlobal.ComptimeFuel),
                globalExport("comptimeSteps", WasmRuntimeGlobal.ComptimeSteps),
              ]
              : []),
          ]
          : []),
        ...(canonicalAbiVersion === undefined ? [] : [
          globalExport("blot:abi-major", runtimeGlobalCount),
          globalExport("blot:abi-minor", runtimeGlobalCount + 1),
        ]),
      ]),
    ),
    section(
      9,
      vector([[
        0x00,
        0x41,
        0x00,
        0x0b,
        ...vector(indirectFunctionIndices.map(encodeUnsigned)),
      ]]),
    ),
  ];
}

function assembleWasmModule(
  sectionsBeforeCode: readonly (readonly number[])[],
  functionCountValue: number,
  encodedFunctionBodies: readonly ArrayLike<number>[],
  branchHintSection?: readonly number[],
): Uint8Array<ArrayBuffer> {
  const functionCount = encodeUnsigned(functionCountValue);
  const functionBodiesLength = encodedFunctionBodies.reduce(
    (total, body) => total + body.length,
    0,
  );
  const codeContentsLength = functionCount.length + functionBodiesLength;
  const encodedCodeContentsLength = encodeUnsigned(codeContentsLength);
  const sectionsLength = sectionsBeforeCode.reduce(
    (total, encodedSection) => total + encodedSection.length,
    0,
  );
  const branchHintSectionLength = branchHintSection?.length ?? 0;
  const bytes = new Uint8Array(
    8 + sectionsLength + branchHintSectionLength + 1 +
      encodedCodeContentsLength.length + codeContentsLength,
  );
  bytes.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  let offset = 8;
  for (const encodedSection of sectionsBeforeCode) {
    bytes.set(encodedSection, offset);
    offset += encodedSection.length;
  }
  if (branchHintSection !== undefined) {
    bytes.set(branchHintSection, offset);
    offset += branchHintSection.length;
  }
  bytes[offset++] = 10;
  bytes.set(encodedCodeContentsLength, offset);
  offset += encodedCodeContentsLength.length;
  bytes.set(functionCount, offset);
  offset += functionCount.length;
  for (const body of encodedFunctionBodies) {
    bytes.set(body, offset);
    offset += body.length;
  }
  return bytes;
}

function encodeBranchHintSection(
  functions: readonly WasmFunctionBody[],
  importedFunctionCount: number,
): number[] | undefined {
  const hintedFunctions = functions.flatMap((body, functionOffset) => {
    if (body.branchHints.length === 0) return [];
    const localsLength = encodeFunctionLocals(body.localTypes).length;
    const hints = body.branchHints.map((hint) => [
      ...encodeUnsigned(localsLength + hint.instructionOffset),
      0x01,
      hint.conditionLikely ? 0x01 : 0x00,
    ]);
    return [[
      ...encodeUnsigned(importedFunctionCount + functionOffset),
      ...vector(hints),
    ]];
  });
  if (hintedFunctions.length === 0) return undefined;
  return section(0, [
    ...name("metadata.code.branch_hint"),
    ...vector(hintedFunctions),
  ]);
}

export function encodeCompactScalarWasmModule(
  functions: readonly WasmFunctionBody[],
  entryFunctionIndex: number,
  additionalFunctionTypes: readonly WasmFunctionType[],
  options: {
    readonly runtimeGlobals: WasmCompactRuntimeGlobals;
  },
  functionExports: readonly {
    readonly name: string;
    readonly functionIndex: number;
  }[] = [],
): Uint8Array<ArrayBuffer> {
  const allFunctionTypes = wasmFunctionTypes(additionalFunctionTypes);
  const usedTypeIndices = [...new Set(functions.map((body) => body.typeIndex))];
  const compactTypeIndices = new Map(
    usedTypeIndices.map((typeIndex, compactIndex) => [typeIndex, compactIndex]),
  );
  const usedFunctionTypes = usedTypeIndices.map((typeIndex) => {
    const type = allFunctionTypes[typeIndex];
    if (type === undefined) {
      throw new Error(
        `compact WebAssembly function type ${typeIndex} exceeds ${allFunctionTypes.length} types`,
      );
    }
    return type;
  });
  const faultGlobals = options.runtimeGlobals.fault;
  const fuelGlobals = options.runtimeGlobals.fuel;
  const indexedGlobals: { readonly index: number; readonly definition: number[] }[] = [
    ...(faultGlobals === undefined ? [] : [
      { index: faultGlobals.code, definition: [0x7f, 0x01, 0x41, 0x00, 0x0b] },
      {
        index: faultGlobals.node,
        definition: [0x7f, 0x01, 0x41, ...encodeSigned(-1n), 0x0b],
      },
    ]),
    ...(fuelGlobals === undefined ? [] : [
      { index: fuelGlobals.remaining, definition: [0x7f, 0x01, 0x41, 0x00, 0x0b] },
      { index: fuelGlobals.steps, definition: [0x7f, 0x01, 0x41, 0x00, 0x0b] },
    ]),
  ].sort((left, right) => left.index - right.index);
  for (const [expectedIndex, global] of indexedGlobals.entries()) {
    if (global.index !== expectedIndex) {
      throw new Error(
        `compact WebAssembly global layout expected index ${expectedIndex}; received ${global.index}`,
      );
    }
  }
  const globals = indexedGlobals.map((global) => global.definition);
  const branchHintSection = encodeBranchHintSection(functions, 0);
  const sections = [
    section(1, vector(usedFunctionTypes)),
    section(
      3,
      vector(functions.map((body) => {
        const typeIndex = compactTypeIndices.get(body.typeIndex);
        if (typeIndex === undefined) {
          throw new Error(
            `compact WebAssembly omitted function type ${body.typeIndex}`,
          );
        }
        return encodeUnsigned(typeIndex);
      })),
    ),
    ...(globals.length === 0 ? [] : [section(6, vector(globals))]),
    section(
      7,
      vector([
        [...name("main"), 0x00, ...encodeUnsigned(entryFunctionIndex)],
        ...functionExports.map((exported) => [
          ...name(exported.name),
          0x00,
          ...encodeUnsigned(exported.functionIndex),
        ]),
        ...(faultGlobals === undefined ? [] : [
          [
            ...name("runtimeFault"),
            0x03,
            ...encodeUnsigned(faultGlobals.code),
          ],
          [
            ...name("runtimeFaultNode"),
            0x03,
            ...encodeUnsigned(faultGlobals.node),
          ],
        ]),
        ...(fuelGlobals === undefined ? [] : [
          [
            ...name("comptimeFuel"),
            0x03,
            ...encodeUnsigned(fuelGlobals.remaining),
          ],
          [
            ...name("comptimeSteps"),
            0x03,
            ...encodeUnsigned(fuelGlobals.steps),
          ],
        ]),
      ]),
    ),
    ...(branchHintSection === undefined ? [] : [branchHintSection]),
    section(10, vector(functions.map(encodeFunctionBody))),
  ];
  return new Uint8Array(concatenateBytes([[
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
  ], ...sections]));
}

function wasmFunctionTypes(additionalFunctionTypes: readonly WasmFunctionType[]): number[][] {
  return [...WASM_BASE_FUNCTION_TYPES, ...additionalFunctionTypes].map((type) =>
    functionType(type.parameters, type.results)
  );
}

function functionType(parameters: readonly number[], results: readonly number[]): number[] {
  return [
    0x60,
    ...vector(parameters.map((type) => [type])),
    ...vector(results.map((type) => [type])),
  ];
}

function encodeFunctionBody(body: WasmFunctionBody): number[] {
  const locals = encodeFunctionLocals(body.localTypes);
  const contentLength = locals.length + body.instructions.length + 1;
  return concatenateBytes([
    encodeUnsigned(contentLength),
    locals,
    body.instructions,
    [0x0b],
  ]);
}

function encodeFunctionLocals(localTypes: readonly number[]): number[] {
  const localGroups: number[][] = [];
  for (const type of localTypes) {
    const last = localGroups.at(-1);
    if (last?.[1] === type) {
      last[0]! += 1;
    } else {
      localGroups.push([1, type]);
    }
  }
  return vector(
    localGroups.map(([count, type]) => [...encodeUnsigned(count!), type!]),
  );
}

function section(id: number, contents: readonly number[]): number[] {
  return concatenateBytes([[id], encodeUnsigned(contents.length), contents]);
}

function vector(values: readonly (readonly number[])[]): number[] {
  return concatenateBytes([encodeUnsigned(values.length), ...values]);
}

function concatenateBytes(parts: readonly (readonly number[])[]): number[] {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const bytes = new Array<number>(length);
  let offset = 0;
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) {
      bytes[offset + index] = part[index]!;
    }
    offset += part.length;
  }
  return bytes;
}

function name(value: string): number[] {
  const bytes = new TextEncoder().encode(value);
  return [...encodeUnsigned(bytes.length), ...bytes];
}

function globalExport(exportName: string, globalIndex: number): number[] {
  return [...name(exportName), 0x03, ...encodeUnsigned(globalIndex)];
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
