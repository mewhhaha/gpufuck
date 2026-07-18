import { FunctionalWasmValueAbi } from "./wasm_abi.ts";
import { type WasmFunctionBody, WasmInstructions, WasmValueType } from "./wasm_binary.ts";
import { functionBody } from "./wasm_runtime_binary.ts";

const CONSTRUCTOR_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.constructor;
const NUMERIC_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.numeric;
const TEXT_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.text;
const BYTES_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.bytes;
const ARRAY_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.array;
const SLICE_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.slice;
const RESOURCE_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.resource;
const IMMEDIATE_TAG_MASK = FunctionalWasmValueAbi.immediateTags.bitMask;
const OBJECT_HEADER_BYTE_LENGTH = FunctionalWasmValueAbi.objectHeaderByteLength;
const VALUE_BYTE_LENGTH = FunctionalWasmValueAbi.valueByteLength;

export function structuralEqualityFunction(options: {
  readonly typeIndex: number;
  readonly functionIndex: number;
  readonly emitForceValue: (instructions: WasmInstructions) => void;
}): WasmFunctionBody {
  const instructions = new WasmInstructions(2);
  const left = instructions.addLocal(WasmValueType.I64);
  const right = instructions.addLocal(WasmValueType.I64);
  const leftPointer = instructions.addLocal(WasmValueType.I32);
  const rightPointer = instructions.addLocal(WasmValueType.I32);
  const kind = instructions.addLocal(WasmValueType.I32);
  const count = instructions.addLocal(WasmValueType.I32);
  const index = instructions.addLocal(WasmValueType.I32);

  instructions.localGet(0);
  options.emitForceValue(instructions);
  instructions.localSet(left);
  instructions.localGet(1);
  options.emitForceValue(instructions);
  instructions.localSet(right);

  instructions.localGet(left);
  instructions.i64Const(BigInt(IMMEDIATE_TAG_MASK));
  instructions.emit(0x83);
  instructions.localGet(right);
  instructions.i64Const(BigInt(IMMEDIATE_TAG_MASK));
  instructions.emit(0x83, 0x84, 0x50, 0x45, 0x04, 0x40);
  instructions.localGet(left);
  instructions.localGet(right);
  instructions.emit(0x51, 0x0f, 0x0b);

  instructions.localGet(left);
  instructions.emit(0xa7);
  instructions.localTee(leftPointer);
  instructions.i32Load(0);
  instructions.localSet(kind);
  instructions.localGet(right);
  instructions.emit(0xa7);
  instructions.localTee(rightPointer);
  instructions.i32Load(0);
  instructions.localGet(kind);
  instructions.emit(0x47, 0x04, 0x40);
  instructions.i32Const(0);
  instructions.emit(0x0f, 0x0b);

  instructions.localGet(left);
  instructions.localGet(right);
  instructions.emit(0x51);
  instructions.localGet(kind);
  instructions.i32Const(NUMERIC_OBJECT_KIND);
  instructions.emit(0x47, 0x71, 0x04, 0x40);
  instructions.i32Const(1);
  instructions.emit(0x0f, 0x0b);

  instructions.localGet(kind);
  instructions.i32Const(NUMERIC_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40);
  emitNumericEquality(instructions, leftPointer, rightPointer);
  instructions.emit(0x0b);

  instructions.localGet(kind);
  instructions.i32Const(CONSTRUCTOR_OBJECT_KIND);
  instructions.emit(0x46);
  instructions.localGet(kind);
  instructions.i32Const(ARRAY_OBJECT_KIND);
  instructions.emit(0x46, 0x72);
  instructions.localGet(kind);
  instructions.i32Const(SLICE_OBJECT_KIND);
  instructions.emit(0x46, 0x72, 0x04, 0x40);
  emitAggregateEquality(
    instructions,
    options.functionIndex,
    leftPointer,
    rightPointer,
    kind,
    count,
    index,
  );
  instructions.emit(0x0b);

  instructions.localGet(kind);
  instructions.i32Const(TEXT_OBJECT_KIND);
  instructions.emit(0x46);
  instructions.localGet(kind);
  instructions.i32Const(BYTES_OBJECT_KIND);
  instructions.emit(0x46, 0x72, 0x04, 0x40);
  emitBufferEquality(instructions, leftPointer, rightPointer, count, index);
  instructions.emit(0x0b);

  instructions.localGet(kind);
  instructions.i32Const(RESOURCE_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.localGet(leftPointer);
  instructions.i32Load(4);
  instructions.localGet(rightPointer);
  instructions.i32Load(4);
  instructions.emit(0x46, 0x0f, 0x0b);
  instructions.i32Const(0);

  return functionBody(options.typeIndex, instructions, "structural equality");
}

function emitNumericEquality(
  instructions: WasmInstructions,
  leftPointer: number,
  rightPointer: number,
): void {
  instructions.localGet(leftPointer);
  instructions.i32Load(4);
  const numericKind = instructions.addLocal(WasmValueType.I32);
  instructions.localTee(numericKind);
  instructions.localGet(rightPointer);
  instructions.i32Load(4);
  instructions.emit(0x47, 0x04, 0x40);
  instructions.i32Const(0);
  instructions.emit(0x0f, 0x0b);

  instructions.localGet(numericKind);
  instructions.i32Const(FunctionalWasmValueAbi.numericKinds.signedInteger64);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.localGet(leftPointer);
  instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(rightPointer);
  instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.emit(0x51, 0x0f, 0x0b);
  instructions.localGet(numericKind);
  instructions.i32Const(FunctionalWasmValueAbi.numericKinds.float32);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.localGet(leftPointer);
  instructions.f32Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(rightPointer);
  instructions.f32Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.emit(0x5b, 0x0f, 0x0b);
  instructions.localGet(leftPointer);
  instructions.f64Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(rightPointer);
  instructions.f64Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.emit(0x61, 0x0f);
}

function emitAggregateEquality(
  instructions: WasmInstructions,
  functionIndex: number,
  leftPointer: number,
  rightPointer: number,
  kind: number,
  count: number,
  index: number,
): void {
  instructions.localGet(kind);
  instructions.i32Const(CONSTRUCTOR_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.localGet(leftPointer);
  instructions.i32Load(4);
  instructions.localGet(rightPointer);
  instructions.i32Load(4);
  instructions.emit(0x47, 0x04, 0x40);
  instructions.i32Const(0);
  instructions.emit(0x0f, 0x0b, 0x0b);
  emitEqualObjectCount(instructions, leftPointer, rightPointer, count);
  instructions.i32Const(0);
  instructions.localSet(index);
  instructions.emit(0x02, 0x40, 0x03, 0x40);
  instructions.localGet(index);
  instructions.localGet(count);
  instructions.emit(0x4f);
  instructions.branchIf(1);
  instructions.localGet(leftPointer);
  instructions.localGet(index);
  instructions.i32Const(VALUE_BYTE_LENGTH);
  instructions.emit(0x6c, 0x6a);
  instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(rightPointer);
  instructions.localGet(index);
  instructions.i32Const(VALUE_BYTE_LENGTH);
  instructions.emit(0x6c, 0x6a);
  instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.call(functionIndex);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.i32Const(0);
  instructions.emit(0x0f, 0x0b);
  instructions.localGet(index);
  instructions.i32Const(1);
  instructions.emit(0x6a);
  instructions.localSet(index);
  instructions.branch(0);
  instructions.emit(0x0b, 0x0b);
  instructions.i32Const(1);
  instructions.emit(0x0f);
}

function emitBufferEquality(
  instructions: WasmInstructions,
  leftPointer: number,
  rightPointer: number,
  count: number,
  index: number,
): void {
  emitEqualObjectCount(instructions, leftPointer, rightPointer, count);
  instructions.i32Const(0);
  instructions.localSet(index);
  instructions.emit(0x02, 0x40, 0x03, 0x40);
  instructions.localGet(index);
  instructions.localGet(count);
  instructions.emit(0x4f);
  instructions.branchIf(1);
  instructions.localGet(leftPointer);
  instructions.localGet(index);
  instructions.emit(0x6a);
  instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(rightPointer);
  instructions.localGet(index);
  instructions.emit(0x6a);
  instructions.i32Load8Unsigned(OBJECT_HEADER_BYTE_LENGTH);
  instructions.emit(0x47, 0x04, 0x40);
  instructions.i32Const(0);
  instructions.emit(0x0f, 0x0b);
  instructions.localGet(index);
  instructions.i32Const(1);
  instructions.emit(0x6a);
  instructions.localSet(index);
  instructions.branch(0);
  instructions.emit(0x0b, 0x0b);
  instructions.i32Const(1);
  instructions.emit(0x0f);
}

function emitEqualObjectCount(
  instructions: WasmInstructions,
  leftPointer: number,
  rightPointer: number,
  count: number,
): void {
  instructions.localGet(leftPointer);
  instructions.i32Load(8);
  instructions.localTee(count);
  instructions.localGet(rightPointer);
  instructions.i32Load(8);
  instructions.emit(0x47, 0x04, 0x40);
  instructions.i32Const(0);
  instructions.emit(0x0f, 0x0b);
}
