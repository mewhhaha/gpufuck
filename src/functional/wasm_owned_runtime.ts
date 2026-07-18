import { FunctionalWasmValueAbi } from "./wasm_abi.ts";
import { functionBody } from "./wasm_runtime_binary.ts";
import { type WasmFunctionBody, WasmInstructions, WasmValueType } from "./wasm_binary.ts";
import { FunctionalWasmRuntimeGlobal } from "./wasm_runtime_layout.ts";

const CONSTRUCTOR_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.constructor;
const NUMERIC_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.numeric;
const TEXT_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.text;
const BYTES_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.bytes;
const ARRAY_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.array;
const SLICE_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.slice;
const RESOURCE_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.resource;
const OBJECT_HEADER_BYTE_LENGTH = FunctionalWasmValueAbi.objectHeaderByteLength;
const OBJECT_REFERENCE_COUNT_BYTE_OFFSET = FunctionalWasmValueAbi.objectReferenceCountByteOffset;
const VALUE_BYTE_LENGTH = FunctionalWasmValueAbi.valueByteLength;
const MAXIMUM_BYTE_VALUE_COUNT = 0xffff_ffff - OBJECT_HEADER_BYTE_LENGTH;
const MAXIMUM_GRAPH_VALUE_COUNT = Math.floor(
  (0xffff_ffff - OBJECT_HEADER_BYTE_LENGTH) / VALUE_BYTE_LENGTH,
);
const RELEASE_FRAME_OBJECT_KIND_FLAG = 0x8000_0000;
const OWNED_OBJECT_KINDS = [
  CONSTRUCTOR_OBJECT_KIND,
  NUMERIC_OBJECT_KIND,
  TEXT_OBJECT_KIND,
  BYTES_OBJECT_KIND,
  ARRAY_OBJECT_KIND,
  SLICE_OBJECT_KIND,
  RESOURCE_OBJECT_KIND,
] as const;

export function retainOwnedValueFunction(
  typeIndex: number,
  heapStart: number,
): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const pointer = instructions.addLocal(WasmValueType.I32);
  const objectKind = instructions.addLocal(WasmValueType.I32);
  const valueCount = instructions.addLocal(WasmValueType.I32);
  const byteLength = instructions.addLocal(WasmValueType.I32);
  const references = instructions.addLocal(WasmValueType.I32);
  emitPointerGuard(instructions, pointer, heapStart);
  instructions.localGet(pointer);
  instructions.i32Load(0);
  instructions.localSet(objectKind);
  emitOwnedObjectKindGuard(instructions, objectKind);
  emitOwnedObjectByteLength(
    instructions,
    pointer,
    objectKind,
    valueCount,
    byteLength,
  );
  emitObjectBoundsGuard(instructions, pointer, byteLength);
  instructions.localGet(pointer);
  instructions.i32Load(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  instructions.localTee(references);
  instructions.emit(0x45, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(references);
  instructions.i32Const(-1);
  instructions.emit(0x46, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(pointer);
  instructions.localGet(references);
  instructions.i32Const(1);
  instructions.emit(0x6a);
  instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  return functionBody(typeIndex, instructions, "owned value retain");
}

export function releaseOwnedValueFunction(
  typeIndex: number,
  freeFunctionIndex: number,
  heapStart: number,
): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const currentValue = instructions.addLocal(WasmValueType.I64);
  const pointer = instructions.addLocal(WasmValueType.I32);
  const parentPointer = instructions.addLocal(WasmValueType.I32);
  const objectKind = instructions.addLocal(WasmValueType.I32);
  const valueCount = instructions.addLocal(WasmValueType.I32);
  const references = instructions.addLocal(WasmValueType.I32);
  const byteLength = instructions.addLocal(WasmValueType.I32);
  const immediateTag = instructions.addLocal(WasmValueType.I64);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.ArenaDepth);
  instructions.emit(0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(0);
  instructions.localSet(currentValue);
  instructions.emit(0x02, 0x40, 0x03, 0x40);
  instructions.localGet(currentValue);
  instructions.i64Const(BigInt(FunctionalWasmValueAbi.immediateTags.bitMask));
  instructions.emit(0x83);
  instructions.localTee(immediateTag);
  instructions.emit(0x50, 0x45, 0x04, 0x40);
  emitImmediateTagGuard(instructions, immediateTag);
  emitReturnToReleaseParent(instructions, currentValue, parentPointer);
  instructions.emit(0x05);
  instructions.localGet(currentValue);
  instructions.emit(0xa7);
  instructions.localTee(pointer);
  instructions.i32Const(heapStart);
  instructions.emit(0x49, 0x04, 0x40);
  emitReturnToReleaseParent(instructions, currentValue, parentPointer);
  instructions.emit(0x05);
  emitDynamicPointerGuard(instructions, pointer);
  instructions.localGet(pointer);
  instructions.i32Load(0);
  instructions.localTee(objectKind);
  instructions.i32Const(RELEASE_FRAME_OBJECT_KIND_FLAG);
  instructions.emit(0x71, 0x04, 0x40);
  instructions.localGet(objectKind);
  instructions.i32Const(0x7fff_ffff);
  instructions.emit(0x71);
  instructions.localSet(objectKind);
  emitGraphObjectKindCondition(instructions, objectKind);
  instructions.emit(0x45, 0x04, 0x40, 0x00, 0x0b);
  emitOwnedObjectByteLength(
    instructions,
    pointer,
    objectKind,
    valueCount,
    byteLength,
  );
  emitObjectBoundsGuard(instructions, pointer, byteLength);
  instructions.localGet(pointer);
  instructions.i32Load(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  instructions.localTee(references);
  instructions.localGet(valueCount);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.localGet(pointer);
  instructions.i32Load(4);
  instructions.localSet(parentPointer);
  instructions.localGet(pointer);
  instructions.localGet(objectKind);
  instructions.i32Store(0);
  instructions.localGet(pointer);
  instructions.i32Const(0);
  instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  instructions.localGet(pointer);
  instructions.localGet(byteLength);
  instructions.call(freeFunctionIndex);
  emitReturnToReleaseParent(instructions, currentValue, parentPointer);
  instructions.emit(0x05);
  instructions.localGet(pointer);
  instructions.localGet(references);
  instructions.i32Const(3);
  instructions.emit(0x74);
  instructions.emit(0x6a);
  instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localSet(currentValue);
  instructions.localGet(pointer);
  instructions.localGet(references);
  instructions.i32Const(1);
  instructions.emit(0x6a);
  instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  instructions.localGet(pointer);
  instructions.localSet(parentPointer);
  instructions.emit(0x0b);
  instructions.emit(0x05);
  emitOwnedObjectKindGuard(instructions, objectKind);
  emitOwnedObjectByteLength(
    instructions,
    pointer,
    objectKind,
    valueCount,
    byteLength,
  );
  emitObjectBoundsGuard(instructions, pointer, byteLength);
  instructions.localGet(pointer);
  instructions.i32Load(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  instructions.localTee(references);
  instructions.emit(0x45, 0x04, 0x40);
  emitReturnToReleaseParent(instructions, currentValue, parentPointer);
  instructions.emit(0x05);
  instructions.localGet(references);
  instructions.i32Const(1);
  instructions.emit(0x4b, 0x04, 0x40);
  instructions.localGet(pointer);
  instructions.localGet(references);
  instructions.i32Const(1);
  instructions.emit(0x6b);
  instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  emitReturnToReleaseParent(instructions, currentValue, parentPointer);
  instructions.emit(0x05);
  emitGraphObjectKindCondition(instructions, objectKind);
  instructions.emit(0x04, 0x40);
  instructions.localGet(pointer);
  instructions.localGet(objectKind);
  instructions.i32Const(RELEASE_FRAME_OBJECT_KIND_FLAG);
  instructions.emit(0x72);
  instructions.i32Store(0);
  instructions.localGet(pointer);
  instructions.localGet(parentPointer);
  instructions.i32Store(4);
  instructions.localGet(pointer);
  instructions.i32Const(0);
  instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  instructions.emit(0x05);
  instructions.localGet(pointer);
  instructions.i32Const(0);
  instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
  instructions.localGet(pointer);
  instructions.localGet(byteLength);
  instructions.call(freeFunctionIndex);
  emitReturnToReleaseParent(instructions, currentValue, parentPointer);
  instructions.emit(0x0b, 0x0b, 0x0b, 0x0b, 0x0b, 0x0b);
  instructions.branch(0);
  instructions.emit(0x0b, 0x0b);
  return functionBody(typeIndex, instructions, "owned value iterative release");
}

export function ownedValueExportFunction(
  typeIndex: number,
  runtimeFunctionIndex: number,
  operation: "retain" | "drop",
  name: string,
): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  instructions.localGet(0);
  instructions.call(runtimeFunctionIndex);
  return functionBody(typeIndex, instructions, `${operation} export ${name}`);
}

function emitPointerGuard(
  instructions: WasmInstructions,
  pointer: number,
  heapStart: number,
): void {
  const immediateTag = instructions.addLocal(WasmValueType.I64);
  const objectEnd = instructions.addLocal(WasmValueType.I32);
  instructions.localGet(0);
  instructions.i64Const(BigInt(FunctionalWasmValueAbi.immediateTags.bitMask));
  instructions.emit(0x83);
  instructions.localTee(immediateTag);
  instructions.emit(0x50, 0x45, 0x04, 0x40);
  instructions.localGet(immediateTag);
  instructions.i64Const(BigInt(FunctionalWasmValueAbi.immediateTags.integer));
  instructions.emit(0x51);
  instructions.localGet(immediateTag);
  instructions.i64Const(BigInt(FunctionalWasmValueAbi.immediateTags.boolean));
  instructions.emit(0x51, 0x72, 0x45, 0x04, 0x40, 0x00, 0x0b, 0x0f, 0x0b);
  instructions.localGet(0);
  instructions.emit(0xa7);
  instructions.localTee(pointer);
  instructions.i32Const(heapStart);
  instructions.emit(0x49, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Const(FunctionalWasmValueAbi.objectAlignment - 1);
  instructions.emit(0x71, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.emit(0x6a);
  instructions.localTee(objectEnd);
  instructions.localGet(pointer);
  instructions.emit(0x49, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(objectEnd);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.HeapTop);
  instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
}

function emitOwnedObjectKindGuard(
  instructions: WasmInstructions,
  objectKind: number,
): void {
  for (const [index, allowedKind] of OWNED_OBJECT_KINDS.entries()) {
    instructions.localGet(objectKind);
    instructions.i32Const(allowedKind);
    instructions.emit(0x46);
    if (index !== 0) instructions.emit(0x72);
  }
  instructions.emit(0x45, 0x04, 0x40, 0x00, 0x0b);
}

function emitImmediateTagGuard(
  instructions: WasmInstructions,
  immediateTag: number,
): void {
  instructions.localGet(immediateTag);
  instructions.i64Const(BigInt(FunctionalWasmValueAbi.immediateTags.integer));
  instructions.emit(0x51);
  instructions.localGet(immediateTag);
  instructions.i64Const(BigInt(FunctionalWasmValueAbi.immediateTags.boolean));
  instructions.emit(0x51, 0x72, 0x45, 0x04, 0x40, 0x00, 0x0b);
}

function emitReturnToReleaseParent(
  instructions: WasmInstructions,
  currentValue: number,
  parentPointer: number,
): void {
  instructions.localGet(parentPointer);
  instructions.emit(0x45, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(parentPointer);
  instructions.emit(0xad);
  instructions.localSet(currentValue);
}

function emitDynamicPointerGuard(
  instructions: WasmInstructions,
  pointer: number,
): void {
  const objectEnd = instructions.addLocal(WasmValueType.I32);
  instructions.localGet(pointer);
  instructions.i32Const(FunctionalWasmValueAbi.objectAlignment - 1);
  instructions.emit(0x71, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.emit(0x6a);
  instructions.localTee(objectEnd);
  instructions.localGet(pointer);
  instructions.emit(0x49, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(objectEnd);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.HeapTop);
  instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
}

function emitGraphObjectKindCondition(
  instructions: WasmInstructions,
  objectKind: number,
): void {
  for (
    const [index, graphKind] of [
      CONSTRUCTOR_OBJECT_KIND,
      ARRAY_OBJECT_KIND,
      SLICE_OBJECT_KIND,
    ].entries()
  ) {
    instructions.localGet(objectKind);
    instructions.i32Const(graphKind);
    instructions.emit(0x46);
    if (index !== 0) instructions.emit(0x72);
  }
}

function emitOwnedObjectByteLength(
  instructions: WasmInstructions,
  pointer: number,
  objectKind: number,
  valueCount: number,
  byteLength: number,
): void {
  instructions.localGet(pointer);
  instructions.i32Load(8);
  instructions.localSet(valueCount);
  instructions.localGet(objectKind);
  instructions.i32Const(TEXT_OBJECT_KIND);
  instructions.emit(0x46);
  instructions.localGet(objectKind);
  instructions.i32Const(BYTES_OBJECT_KIND);
  instructions.emit(0x46, 0x72, 0x04, 0x40);
  emitMaximumValueCountGuard(instructions, valueCount, MAXIMUM_BYTE_VALUE_COUNT);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(valueCount);
  instructions.emit(0x6a);
  instructions.localSet(byteLength);
  instructions.emit(0x05);
  instructions.localGet(objectKind);
  instructions.i32Const(NUMERIC_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40);
  emitExpectedValueCountGuard(instructions, valueCount, 1);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH + VALUE_BYTE_LENGTH);
  instructions.localSet(byteLength);
  instructions.emit(0x05);
  instructions.localGet(objectKind);
  instructions.i32Const(RESOURCE_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40);
  emitExpectedValueCountGuard(instructions, valueCount, 0);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localSet(byteLength);
  instructions.emit(0x05);
  emitMaximumValueCountGuard(instructions, valueCount, MAXIMUM_GRAPH_VALUE_COUNT);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(valueCount);
  instructions.i32Const(3);
  instructions.emit(0x74, 0x6a);
  instructions.localSet(byteLength);
  instructions.emit(0x0b, 0x0b, 0x0b);
}

function emitMaximumValueCountGuard(
  instructions: WasmInstructions,
  valueCount: number,
  maximumValueCount: number,
): void {
  instructions.localGet(valueCount);
  instructions.i32Const(maximumValueCount);
  instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
}

function emitExpectedValueCountGuard(
  instructions: WasmInstructions,
  valueCount: number,
  expectedValueCount: number,
): void {
  instructions.localGet(valueCount);
  instructions.i32Const(expectedValueCount);
  instructions.emit(0x47, 0x04, 0x40, 0x00, 0x0b);
}

function emitObjectBoundsGuard(
  instructions: WasmInstructions,
  pointer: number,
  byteLength: number,
): void {
  const objectEnd = instructions.addLocal(WasmValueType.I32);
  instructions.localGet(pointer);
  instructions.localGet(byteLength);
  instructions.emit(0x6a);
  instructions.localTee(objectEnd);
  instructions.localGet(pointer);
  instructions.emit(0x49, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(objectEnd);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.HeapTop);
  instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
}
