import { BYTES_TYPE_NAME, type HostType, TEXT_TYPE_NAME, WasmIntrinsic } from "./host_contract.ts";
import { WasmValueAbi } from "./wasm_abi.ts";
import { WasmFunctionTypeIndex, type WasmInstructions, WasmValueType } from "./wasm_binary.ts";
import { WASM_FAULT_OUT_OF_BOUNDS, WASM_FAULT_OUT_OF_MEMORY } from "./wasm_runtime_binary.ts";

const TEXT_OBJECT_KIND = WasmValueAbi.objectKinds.text;
const BYTES_OBJECT_KIND = WasmValueAbi.objectKinds.bytes;
const OBJECT_HEADER_BYTE_LENGTH = WasmValueAbi.objectHeaderByteLength;
const VALUE_BYTE_LENGTH = WasmValueAbi.valueByteLength;

interface WasmHostEmitterContext {
  allocateFunctionIndex(): number;
  emitDecodeInteger(instructions: WasmInstructions): void;
  emitBoxSignedInteger64(instructions: WasmInstructions): void;
  emitEncodeBoolean(instructions: WasmInstructions): void;
  emitEncodeInteger(instructions: WasmInstructions): void;
  emitForceValue(instructions: WasmInstructions): void;
  emitFuelChargeAmount(instructions: WasmInstructions, amount: number, nodeIndex: number): void;
  emitRuntimeFault(instructions: WasmInstructions, fault: number): void;
}

export class WasmHostEmitter {
  readonly #context: WasmHostEmitterContext;

  constructor(context: WasmHostEmitterContext) {
    this.#context = context;
  }

  emitIntrinsic(
    instructions: WasmInstructions,
    intrinsic: WasmIntrinsic,
    parameter: HostType,
    resultType: HostType,
  ): void {
    const argument = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(argument);
    if (intrinsic === WasmIntrinsic.TextCodePointLength) {
      this.emitTextCodePointLength(instructions, argument, parameter);
      return;
    }
    if (intrinsic === WasmIntrinsic.TextFromSignedInteger64) {
      this.emitTextFromSignedInteger64(instructions, argument);
      return;
    }
    if (intrinsic === WasmIntrinsic.TextCompare) {
      this.emitTextCompare(instructions, argument);
      return;
    }
    if (intrinsic === WasmIntrinsic.TextContains) {
      this.emitTextContains(instructions, argument);
      return;
    }
    if (intrinsic === WasmIntrinsic.BufferByteLength) {
      const pointer = this.bufferPointer(instructions, argument, parameter);
      instructions.localGet(pointer);
      instructions.i32Load(8);
      this.#context.emitEncodeInteger(instructions);
      return;
    }
    if (intrinsic === WasmIntrinsic.BufferConvert) {
      const pointer = this.bufferPointer(instructions, argument, parameter);
      const length = instructions.addLocal(WasmValueType.I32);
      instructions.localGet(pointer);
      instructions.i32Load(8);
      instructions.localSet(length);
      this.#context.emitFuelChargeAmount(instructions, length, -1);
      const resultKind = this.bufferObjectKind(resultType);
      const result = this.allocateBuffer(instructions, resultKind, length);
      instructions.localGet(result);
      instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
      instructions.emit(0x6a);
      instructions.localGet(pointer);
      instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
      instructions.emit(0x6a);
      instructions.localGet(length);
      instructions.memoryCopy();
      instructions.localGet(result);
      instructions.emit(0xad);
      return;
    }
    if (parameter.kind !== "tuple") {
      throw new Error(`functional WASM intrinsic ${intrinsic} requires a tuple parameter`);
    }

    const tuple = this.objectPointer(instructions, argument);
    const first = this.objectField(instructions, tuple, 0);
    if (intrinsic === WasmIntrinsic.BufferByteGet) {
      const indexValue = this.objectField(instructions, tuple, 1);
      const pointer = this.bufferPointer(instructions, first, parameter.values[0]);
      const index = this.decodedInteger(instructions, indexValue);
      this.requireBufferIndex(instructions, pointer, index);
      instructions.localGet(pointer);
      instructions.localGet(index);
      instructions.emit(0x6a);
      instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
      this.#context.emitEncodeInteger(instructions);
      return;
    }

    const second = this.objectField(instructions, tuple, 1);
    if (intrinsic === WasmIntrinsic.BufferGenerate) {
      const length = this.decodedInteger(instructions, first);
      instructions.localGet(length);
      instructions.i32Const(0);
      instructions.emit(0x48, 0x04, 0x40);
      this.#context.emitRuntimeFault(instructions, WASM_FAULT_OUT_OF_BOUNDS);
      instructions.emit(0x0b);
      this.#context.emitFuelChargeAmount(instructions, length, -1);
      const generator = this.objectPointer(instructions, second);
      const result = this.allocateBuffer(
        instructions,
        this.bufferObjectKind(resultType),
        length,
      );
      const index = instructions.addLocal(WasmValueType.I32);
      instructions.i32Const(0);
      instructions.localSet(index);
      instructions.emit(0x02, 0x40, 0x03, 0x40);
      instructions.localGet(index);
      instructions.localGet(length);
      instructions.emit(0x4f);
      instructions.branchIf(1);
      instructions.localGet(result);
      instructions.localGet(index);
      instructions.emit(0x6a);
      instructions.localGet(generator);
      instructions.localGet(index);
      this.#context.emitEncodeInteger(instructions);
      instructions.localGet(generator);
      instructions.i32Load(4);
      instructions.callIndirect(WasmFunctionTypeIndex.ClosureCall);
      this.#context.emitForceValue(instructions);
      this.#context.emitDecodeInteger(instructions);
      instructions.i32Store8(OBJECT_HEADER_BYTE_LENGTH);
      instructions.localGet(index);
      instructions.i32Const(1);
      instructions.emit(0x6a);
      instructions.localSet(index);
      instructions.branch(0);
      instructions.emit(0x0b, 0x0b);
      instructions.localGet(result);
      instructions.emit(0xad);
      return;
    }
    const bufferType = parameter.values[0];
    const left = this.bufferPointer(instructions, first, bufferType);
    if (intrinsic === WasmIntrinsic.BufferByteSlice) {
      const bounds = this.objectPointer(instructions, second);
      const startValue = this.objectField(instructions, bounds, 0);
      const endValue = this.objectField(instructions, bounds, 1);
      const start = this.decodedInteger(instructions, startValue);
      const end = this.decodedInteger(instructions, endValue);
      this.requireBufferBounds(instructions, left, start, end);
      const length = instructions.addLocal(WasmValueType.I32);
      instructions.localGet(end);
      instructions.localGet(start);
      instructions.emit(0x6b);
      instructions.localSet(length);
      this.#context.emitFuelChargeAmount(instructions, length, -1);
      const result = this.allocateBuffer(
        instructions,
        this.bufferObjectKind(bufferType),
        length,
      );
      instructions.localGet(result);
      instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
      instructions.emit(0x6a);
      instructions.localGet(left);
      instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
      instructions.emit(0x6a);
      instructions.localGet(start);
      instructions.emit(0x6a);
      instructions.localGet(length);
      instructions.memoryCopy();
      instructions.localGet(result);
      instructions.emit(0xad);
      return;
    }

    const right = this.bufferPointer(instructions, second, parameter.values[1]);
    if (intrinsic === WasmIntrinsic.BufferAppend) {
      this.emitBufferAppend(instructions, left, right, bufferType, -1);
      return;
    }
    if (intrinsic === WasmIntrinsic.BufferEqual) {
      this.emitBufferEquality(instructions, left, right, -1);
      return;
    }
    intrinsic satisfies never;
    throw new Error(`functional WASM intrinsic ${intrinsic} is unsupported`);
  }

  private emitTextCodePointLength(
    instructions: WasmInstructions,
    argument: number,
    parameter: HostType,
  ): void {
    const pointer = this.bufferPointer(instructions, argument, parameter);
    instructions.localGet(pointer);
    instructions.i32Load(8);
    const byteLength = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(byteLength);
    const index = instructions.addLocal(WasmValueType.I32);
    const codePoints = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(index);
    instructions.i32Const(0);
    instructions.localSet(codePoints);
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(index);
    instructions.localGet(byteLength);
    instructions.emit(0x4f);
    instructions.branchIf(1);
    instructions.localGet(pointer);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
    instructions.i32Const(0xc0);
    instructions.emit(0x71);
    instructions.i32Const(0x80);
    instructions.emit(0x47, 0x04, 0x40);
    instructions.localGet(codePoints);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(codePoints);
    instructions.emit(0x0b);
    instructions.localGet(index);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);
    instructions.localGet(codePoints);
    instructions.emit(0xac);
    this.#context.emitBoxSignedInteger64(instructions);
  }

  private emitTextFromSignedInteger64(
    instructions: WasmInstructions,
    argument: number,
  ): void {
    instructions.localGet(argument);
    instructions.emit(0xa7);
    instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
    const original = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(original);
    const remaining = instructions.addLocal(WasmValueType.I64);
    instructions.localGet(original);
    instructions.localSet(remaining);
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(length);
    instructions.localGet(remaining);
    instructions.emit(0x50, 0x04, 0x40);
    instructions.i32Const(1);
    instructions.localSet(length);
    instructions.emit(0x05);
    instructions.emit(0x03, 0x40);
    instructions.localGet(length);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(length);
    instructions.localGet(remaining);
    instructions.i64Const(10n);
    instructions.emit(0x7f);
    instructions.localTee(remaining);
    instructions.emit(0x50, 0x45);
    instructions.branchIf(0);
    instructions.emit(0x0b, 0x0b);
    instructions.localGet(original);
    instructions.i64Const(0n);
    instructions.emit(0x53, 0x04, 0x40);
    instructions.localGet(length);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(length);
    instructions.emit(0x0b);

    const result = this.allocateBuffer(
      instructions,
      TEXT_OBJECT_KIND,
      length,
    );
    const cursor = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(length);
    instructions.localSet(cursor);
    instructions.localGet(original);
    instructions.localSet(remaining);
    instructions.localGet(remaining);
    instructions.emit(0x50, 0x04, 0x40);
    instructions.localGet(cursor);
    instructions.i32Const(1);
    instructions.emit(0x6b);
    instructions.localTee(cursor);
    instructions.localGet(result);
    instructions.emit(0x6a);
    instructions.i32Const(48);
    instructions.i32Store8(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x05);
    instructions.emit(0x03, 0x40);
    instructions.localGet(remaining);
    instructions.i64Const(10n);
    instructions.emit(0x81);
    const remainder = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(remainder);
    instructions.localGet(cursor);
    instructions.i32Const(1);
    instructions.emit(0x6b);
    instructions.localTee(cursor);
    instructions.localGet(result);
    instructions.emit(0x6a);
    instructions.i32Const(48);
    instructions.localGet(original);
    instructions.i64Const(0n);
    instructions.emit(0x53, 0x04, WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localGet(remainder);
    instructions.emit(0xa7, 0x6b, 0x05);
    instructions.localGet(remainder);
    instructions.emit(0xa7, 0x0b);
    instructions.emit(0x6a);
    instructions.i32Store8(OBJECT_HEADER_BYTE_LENGTH);
    instructions.localGet(remaining);
    instructions.i64Const(10n);
    instructions.emit(0x7f);
    instructions.localTee(remaining);
    instructions.emit(0x50, 0x45);
    instructions.branchIf(0);
    instructions.emit(0x0b, 0x0b);
    instructions.localGet(original);
    instructions.i64Const(0n);
    instructions.emit(0x53, 0x04, 0x40);
    instructions.localGet(cursor);
    instructions.i32Const(1);
    instructions.emit(0x6b);
    instructions.localTee(cursor);
    instructions.localGet(result);
    instructions.emit(0x6a);
    instructions.i32Const(45);
    instructions.i32Store8(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x0b);
    instructions.localGet(result);
    instructions.emit(0xad);
  }

  private emitTextCompare(
    instructions: WasmInstructions,
    argument: number,
  ): void {
    const pair = this.objectPointer(instructions, argument);
    const leftValue = this.objectField(instructions, pair, 0);
    const rightValue = this.objectField(instructions, pair, 1);
    const textType = { kind: "named", name: TEXT_TYPE_NAME, arguments: [] } as const;
    const left = this.bufferPointer(instructions, leftValue, textType);
    const right = this.bufferPointer(instructions, rightValue, textType);
    instructions.localGet(left);
    instructions.i32Load(8);
    const leftLength = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(leftLength);
    instructions.localGet(right);
    instructions.i32Load(8);
    const rightLength = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(rightLength);
    const index = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(index);
    const ordering = instructions.addLocal(WasmValueType.I64);
    instructions.i64Const(0n);
    instructions.localSet(ordering);
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(index);
    instructions.localGet(leftLength);
    instructions.emit(0x4f);
    instructions.localGet(index);
    instructions.localGet(rightLength);
    instructions.emit(0x4f, 0x72);
    instructions.branchIf(1);
    instructions.localGet(left);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
    const leftByte = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(leftByte);
    instructions.localGet(right);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
    const rightByte = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(rightByte);
    instructions.localGet(leftByte);
    instructions.localGet(rightByte);
    instructions.emit(0x49, 0x04, 0x40);
    instructions.i64Const(-1n);
    instructions.localSet(ordering);
    instructions.branch(2);
    instructions.emit(0x0b);
    instructions.localGet(leftByte);
    instructions.localGet(rightByte);
    instructions.emit(0x4b, 0x04, 0x40);
    instructions.i64Const(1n);
    instructions.localSet(ordering);
    instructions.branch(2);
    instructions.emit(0x0b);
    instructions.localGet(index);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);
    instructions.localGet(ordering);
    instructions.emit(0x50, 0x04, 0x40);
    instructions.localGet(leftLength);
    instructions.localGet(rightLength);
    instructions.emit(0x49, 0x04, 0x40);
    instructions.i64Const(-1n);
    instructions.localSet(ordering);
    instructions.emit(0x05);
    instructions.localGet(leftLength);
    instructions.localGet(rightLength);
    instructions.emit(0x4b, 0x04, 0x40);
    instructions.i64Const(1n);
    instructions.localSet(ordering);
    instructions.emit(0x0b, 0x0b, 0x0b);
    instructions.localGet(ordering);
    this.#context.emitBoxSignedInteger64(instructions);
  }

  private emitTextContains(
    instructions: WasmInstructions,
    argument: number,
  ): void {
    const pair = this.objectPointer(instructions, argument);
    const textValue = this.objectField(instructions, pair, 0);
    const queryValue = this.objectField(instructions, pair, 1);
    const textType = {
      kind: "named",
      name: TEXT_TYPE_NAME,
      arguments: [],
    } as const;
    const text = this.bufferPointer(instructions, textValue, textType);
    const query = this.bufferPointer(instructions, queryValue, textType);
    const textLength = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(text);
    instructions.i32Load(8);
    instructions.localSet(textLength);
    const queryLength = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(query);
    instructions.i32Load(8);
    instructions.localSet(queryLength);
    this.#context.emitFuelChargeAmount(instructions, textLength, -1);

    const found = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(found);
    const lastStart = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(textLength);
    instructions.localGet(queryLength);
    instructions.emit(0x6b);
    instructions.localSet(lastStart);
    const start = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(start);
    const index = instructions.addLocal(WasmValueType.I32);

    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(start);
    instructions.localGet(lastStart);
    instructions.emit(0x4b);
    instructions.localGet(queryLength);
    instructions.localGet(textLength);
    instructions.emit(0x4b, 0x72);
    instructions.branchIf(1);

    instructions.i32Const(1);
    instructions.localSet(found);
    instructions.i32Const(0);
    instructions.localSet(index);
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(index);
    instructions.localGet(queryLength);
    instructions.emit(0x4f);
    instructions.branchIf(1);
    instructions.localGet(text);
    instructions.localGet(start);
    instructions.emit(0x6a);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
    instructions.localGet(query);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x47, 0x04, 0x40);
    instructions.i32Const(0);
    instructions.localSet(found);
    instructions.branch(2);
    instructions.emit(0x0b);
    instructions.localGet(index);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);

    instructions.localGet(found);
    instructions.branchIf(1);
    instructions.localGet(start);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(start);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);
    instructions.localGet(found);
    this.#context.emitEncodeBoolean(instructions);
  }

  emitLiteral(
    instructions: WasmInstructions,
    literal: { readonly kind: "text"; readonly value: string } | {
      readonly kind: "bytes";
      readonly value: readonly number[] | Uint8Array;
    },
    nodeIndex: number,
  ): void {
    const bytes = literal.kind === "text" ? new TextEncoder().encode(literal.value) : literal.value;
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(bytes.length);
    instructions.localSet(length);
    this.#context.emitFuelChargeAmount(instructions, length, nodeIndex);
    const pointer = this.allocateBuffer(
      instructions,
      literal.kind === "text" ? TEXT_OBJECT_KIND : BYTES_OBJECT_KIND,
      length,
    );
    for (const [index, byte] of bytes.entries()) {
      instructions.localGet(pointer);
      instructions.i32Const(byte);
      instructions.i32Store8(OBJECT_HEADER_BYTE_LENGTH + index);
    }
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitBufferAppendValues(
    instructions: WasmInstructions,
    type: HostType,
    nodeIndex: number,
  ): void {
    const rightValue = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(rightValue);
    const leftValue = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(leftValue);
    const left = this.bufferPointer(instructions, leftValue, type);
    const right = this.bufferPointer(instructions, rightValue, type);
    this.emitBufferAppend(instructions, left, right, type, nodeIndex);
  }

  private objectPointer(instructions: WasmInstructions, value: number): number {
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(value);
    instructions.emit(0xa7);
    instructions.localSet(pointer);
    return pointer;
  }

  private objectField(
    instructions: WasmInstructions,
    pointer: number,
    index: number,
  ): number {
    const value = instructions.addLocal(WasmValueType.I64);
    instructions.localGet(pointer);
    instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH);
    this.#context.emitForceValue(instructions);
    instructions.localSet(value);
    return value;
  }

  private decodedInteger(instructions: WasmInstructions, value: number): number {
    const integer = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(value);
    this.#context.emitDecodeInteger(instructions);
    instructions.localSet(integer);
    return integer;
  }

  private bufferPointer(
    instructions: WasmInstructions,
    value: number,
    type: HostType,
  ): number {
    const pointer = this.objectPointer(instructions, value);
    instructions.localGet(pointer);
    instructions.i32Load(0);
    instructions.i32Const(this.bufferObjectKind(type));
    instructions.emit(0x47, 0x04, 0x40);
    this.#context.emitRuntimeFault(instructions, WASM_FAULT_OUT_OF_BOUNDS);
    instructions.emit(0x0b);
    return pointer;
  }

  private bufferObjectKind(type: HostType): number {
    if (type.kind === "named" && type.name === TEXT_TYPE_NAME) {
      return TEXT_OBJECT_KIND;
    }
    if (type.kind === "named" && type.name === BYTES_TYPE_NAME) {
      return BYTES_OBJECT_KIND;
    }
    throw new Error(`functional WASM intrinsic received non-buffer type ${type.kind}`);
  }

  private requireBufferIndex(
    instructions: WasmInstructions,
    pointer: number,
    index: number,
  ): void {
    instructions.localGet(index);
    instructions.i32Const(0);
    instructions.emit(0x48);
    instructions.localGet(index);
    instructions.localGet(pointer);
    instructions.i32Load(8);
    instructions.emit(0x4f, 0x72, 0x04, 0x40);
    this.#context.emitRuntimeFault(instructions, WASM_FAULT_OUT_OF_BOUNDS);
    instructions.emit(0x0b);
  }

  private requireBufferBounds(
    instructions: WasmInstructions,
    pointer: number,
    start: number,
    end: number,
  ): void {
    instructions.localGet(start);
    instructions.i32Const(0);
    instructions.emit(0x48);
    instructions.localGet(end);
    instructions.localGet(start);
    instructions.emit(0x48, 0x72);
    instructions.localGet(end);
    instructions.localGet(pointer);
    instructions.i32Load(8);
    instructions.emit(0x4b, 0x72, 0x04, 0x40);
    this.#context.emitRuntimeFault(instructions, WASM_FAULT_OUT_OF_BOUNDS);
    instructions.emit(0x0b);
  }

  private allocateBuffer(
    instructions: WasmInstructions,
    kind: number,
    length: number,
  ): number {
    instructions.localGet(length);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.call(this.#context.allocateFunctionIndex());
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localTee(pointer);
    instructions.i32Const(kind);
    instructions.i32Store(0);
    instructions.localGet(pointer);
    instructions.i32Const(0);
    instructions.i32Store(4);
    instructions.localGet(pointer);
    instructions.localGet(length);
    instructions.i32Store(8);
    return pointer;
  }

  private emitBufferAppend(
    instructions: WasmInstructions,
    left: number,
    right: number,
    type: HostType,
    nodeIndex: number,
  ): void {
    const leftLength = instructions.addLocal(WasmValueType.I32);
    const rightLength = instructions.addLocal(WasmValueType.I32);
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(left);
    instructions.i32Load(8);
    instructions.localSet(leftLength);
    instructions.localGet(right);
    instructions.i32Load(8);
    instructions.localSet(rightLength);
    instructions.localGet(leftLength);
    instructions.localGet(rightLength);
    instructions.emit(0x6a);
    instructions.localSet(length);
    instructions.localGet(length);
    instructions.localGet(leftLength);
    instructions.emit(0x49, 0x04, 0x40);
    this.#context.emitRuntimeFault(instructions, WASM_FAULT_OUT_OF_MEMORY);
    instructions.emit(0x0b);
    this.#context.emitFuelChargeAmount(instructions, length, nodeIndex);
    const result = this.allocateBuffer(
      instructions,
      this.bufferObjectKind(type),
      length,
    );
    instructions.localGet(result);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(left);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(leftLength);
    instructions.memoryCopy();
    instructions.localGet(result);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(leftLength);
    instructions.emit(0x6a);
    instructions.localGet(right);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(rightLength);
    instructions.memoryCopy();
    instructions.localGet(result);
    instructions.emit(0xad);
  }

  private emitBufferEquality(
    instructions: WasmInstructions,
    left: number,
    right: number,
    nodeIndex: number,
  ): void {
    const length = instructions.addLocal(WasmValueType.I32);
    const index = instructions.addLocal(WasmValueType.I32);
    const equal = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(index);
    instructions.localGet(left);
    instructions.i32Load(8);
    instructions.localTee(length);
    instructions.localGet(right);
    instructions.i32Load(8);
    instructions.emit(0x46);
    instructions.localSet(equal);
    instructions.localGet(equal);
    instructions.emit(0x04, 0x40);
    this.#context.emitFuelChargeAmount(instructions, length, nodeIndex);
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(index);
    instructions.localGet(length);
    instructions.emit(0x4f, 0x0d);
    instructions.unsigned(1);
    instructions.localGet(equal);
    instructions.localGet(left);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
    instructions.localGet(right);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x46, 0x71);
    instructions.localSet(equal);
    instructions.localGet(index);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b, 0x0b);
    instructions.localGet(equal);
    this.#context.emitEncodeBoolean(instructions);
  }
}
