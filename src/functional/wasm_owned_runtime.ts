import { FunctionalWasmValueAbi } from "./wasm_abi.ts";
import { functionBody } from "./wasm_runtime_binary.ts";
import { type WasmFunctionBody, WasmInstructions, WasmValueType } from "./wasm_binary.ts";

const THUNK_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.thunk;
const NUMERIC_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.numeric;
const TEXT_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.text;
const BYTES_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.bytes;
const RESOURCE_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.resource;
const OBJECT_HEADER_BYTE_LENGTH = FunctionalWasmValueAbi.objectHeaderByteLength;
const VALUE_BYTE_LENGTH = FunctionalWasmValueAbi.valueByteLength;

export function retainOwnedValueFunction(
  typeIndex: number,
  heapStart: number,
): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const pointer = instructions.addLocal(WasmValueType.I32);
  const references = instructions.addLocal(WasmValueType.I32);
  emitPointerGuard(instructions, pointer, heapStart);
  instructions.localGet(pointer);
  instructions.i32Load(0);
  instructions.i32Const(THUNK_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Load(12);
  instructions.localTee(references);
  instructions.emit(0x45, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(pointer);
  instructions.localGet(references);
  instructions.i32Const(1);
  instructions.emit(0x6a);
  instructions.i32Store(12);
  return functionBody(typeIndex, instructions, "owned value retain");
}

export function releaseOwnedValueFunction(
  typeIndex: number,
  functionIndex: number,
  freeFunctionIndex: number,
  heapStart: number,
): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const pointer = instructions.addLocal(WasmValueType.I32);
  const objectKind = instructions.addLocal(WasmValueType.I32);
  const valueCount = instructions.addLocal(WasmValueType.I32);
  const references = instructions.addLocal(WasmValueType.I32);
  const fieldIndex = instructions.addLocal(WasmValueType.I32);
  const byteLength = instructions.addLocal(WasmValueType.I32);
  emitPointerGuard(instructions, pointer, heapStart);
  instructions.localGet(pointer);
  instructions.i32Load(0);
  instructions.localTee(objectKind);
  instructions.i32Const(THUNK_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Load(12);
  instructions.localTee(references);
  instructions.emit(0x45, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(references);
  instructions.i32Const(1);
  instructions.emit(0x4b, 0x04, 0x40);
  instructions.localGet(pointer);
  instructions.localGet(references);
  instructions.i32Const(1);
  instructions.emit(0x6b);
  instructions.i32Store(12);
  instructions.emit(0x0f, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Const(0);
  instructions.i32Store(12);
  instructions.localGet(pointer);
  instructions.i32Load(8);
  instructions.localSet(valueCount);

  instructions.localGet(objectKind);
  instructions.i32Const(TEXT_OBJECT_KIND);
  instructions.emit(0x46);
  instructions.localGet(objectKind);
  instructions.i32Const(BYTES_OBJECT_KIND);
  instructions.emit(0x46, 0x72, 0x04, 0x40);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(valueCount);
  instructions.emit(0x6a);
  instructions.localSet(byteLength);
  instructions.emit(0x05);
  instructions.localGet(objectKind);
  instructions.i32Const(NUMERIC_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH + VALUE_BYTE_LENGTH);
  instructions.localSet(byteLength);
  instructions.emit(0x05);
  instructions.localGet(objectKind);
  instructions.i32Const(RESOURCE_OBJECT_KIND);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localSet(byteLength);
  instructions.emit(0x05);

  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(valueCount);
  instructions.i32Const(3);
  instructions.emit(0x74, 0x6a);
  instructions.localSet(byteLength);
  instructions.localGet(pointer);
  instructions.localGet(byteLength);
  instructions.call(freeFunctionIndex);
  instructions.localGet(valueCount);
  instructions.localSet(fieldIndex);
  instructions.emit(0x02, 0x40, 0x03, 0x40);
  instructions.localGet(fieldIndex);
  instructions.emit(0x45);
  instructions.branchIf(1);
  instructions.localGet(fieldIndex);
  instructions.i32Const(1);
  instructions.emit(0x6b);
  instructions.localSet(fieldIndex);
  instructions.localGet(pointer);
  instructions.localGet(fieldIndex);
  instructions.i32Const(3);
  instructions.emit(0x74, 0x6a);
  instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
  instructions.call(functionIndex);
  instructions.branch(0);
  instructions.emit(0x0b, 0x0b);
  instructions.emit(0x0f);
  instructions.emit(0x0b, 0x0b, 0x0b);

  instructions.localGet(pointer);
  instructions.localGet(byteLength);
  instructions.call(freeFunctionIndex);
  return functionBody(typeIndex, instructions, "owned value recursive release");
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
  instructions.localGet(0);
  instructions.i64Const(BigInt(FunctionalWasmValueAbi.immediateTags.bitMask));
  instructions.emit(0x83, 0x50, 0x45, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(0);
  instructions.emit(0xa7);
  instructions.localTee(pointer);
  instructions.i32Const(heapStart);
  instructions.emit(0x49, 0x04, 0x40, 0x0f, 0x0b);
}
