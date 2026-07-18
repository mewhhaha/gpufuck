import {
  FUNCTIONAL_BYTES_TYPE_NAME,
  FUNCTIONAL_TEXT_TYPE_NAME,
  type FunctionalHostType,
  FunctionalWasmIntrinsic,
} from "./host_contract.ts";
import { FunctionalWasmValueAbi } from "./wasm_abi.ts";
import { type WasmInstructions, WasmValueType } from "./wasm_binary.ts";
import { WASM_FAULT_OUT_OF_BOUNDS, WASM_FAULT_OUT_OF_MEMORY } from "./wasm_runtime_binary.ts";

const TEXT_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.text;
const BYTES_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.bytes;
const OBJECT_HEADER_BYTE_LENGTH = FunctionalWasmValueAbi.objectHeaderByteLength;
const OBJECT_REFERENCE_COUNT_BYTE_OFFSET = FunctionalWasmValueAbi.objectReferenceCountByteOffset;
const VALUE_BYTE_LENGTH = FunctionalWasmValueAbi.valueByteLength;

interface FunctionalWasmHostEmitterContext {
  readonly ownedRuntimeEnabled: boolean;
  allocateFunctionIndex(): number;
  emitDecodeInteger(instructions: WasmInstructions): void;
  emitEncodeBoolean(instructions: WasmInstructions): void;
  emitEncodeInteger(instructions: WasmInstructions): void;
  emitForceValue(instructions: WasmInstructions): void;
  emitRuntimeFault(instructions: WasmInstructions, fault: number): void;
}

export class FunctionalWasmHostEmitter {
  readonly #context: FunctionalWasmHostEmitterContext;

  constructor(context: FunctionalWasmHostEmitterContext) {
    this.#context = context;
  }

  emitIntrinsic(
    instructions: WasmInstructions,
    intrinsic: FunctionalWasmIntrinsic,
    parameter: FunctionalHostType,
    resultType: FunctionalHostType,
  ): void {
    const argument = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(argument);
    if (intrinsic === FunctionalWasmIntrinsic.BufferByteLength) {
      const pointer = this.bufferPointer(instructions, argument, parameter);
      instructions.localGet(pointer);
      instructions.i32Load(8);
      this.#context.emitEncodeInteger(instructions);
      return;
    }
    if (intrinsic === FunctionalWasmIntrinsic.BufferConvert) {
      const pointer = this.bufferPointer(instructions, argument, parameter);
      const length = instructions.addLocal(WasmValueType.I32);
      instructions.localGet(pointer);
      instructions.i32Load(8);
      instructions.localSet(length);
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
    if (intrinsic === FunctionalWasmIntrinsic.BufferByteGet) {
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
    if (intrinsic === FunctionalWasmIntrinsic.BufferGenerate) {
      const length = this.decodedInteger(instructions, first);
      instructions.localGet(length);
      instructions.i32Const(0);
      instructions.emit(0x48, 0x04, 0x40);
      this.#context.emitRuntimeFault(instructions, WASM_FAULT_OUT_OF_BOUNDS);
      instructions.emit(0x0b);
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
      instructions.callIndirect(2);
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
    if (intrinsic === FunctionalWasmIntrinsic.BufferByteSlice) {
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
    if (intrinsic === FunctionalWasmIntrinsic.BufferAppend) {
      this.emitBufferAppend(instructions, left, right, bufferType);
      return;
    }
    if (intrinsic === FunctionalWasmIntrinsic.BufferEqual) {
      this.emitBufferEquality(instructions, left, right);
      return;
    }
    intrinsic satisfies never;
    throw new Error(`functional WASM intrinsic ${intrinsic} is unsupported`);
  }

  emitLiteral(
    instructions: WasmInstructions,
    literal: { readonly kind: "text"; readonly value: string } | {
      readonly kind: "bytes";
      readonly value: readonly number[];
    },
  ): void {
    const bytes = literal.kind === "text" ? new TextEncoder().encode(literal.value) : literal.value;
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(bytes.length);
    instructions.localSet(length);
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
    type: FunctionalHostType,
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

  private bufferObjectKind(type: FunctionalHostType): number {
    if (type.kind === "named" && type.name === FUNCTIONAL_TEXT_TYPE_NAME) {
      return TEXT_OBJECT_KIND;
    }
    if (type.kind === "named" && type.name === FUNCTIONAL_BYTES_TYPE_NAME) {
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
    if (this.#context.ownedRuntimeEnabled) {
      instructions.localGet(pointer);
      instructions.i32Const(1);
      instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
    }
    return pointer;
  }

  private emitBufferAppend(
    instructions: WasmInstructions,
    left: number,
    right: number,
    type: FunctionalHostType,
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
