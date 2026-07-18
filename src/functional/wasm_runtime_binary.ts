import { FunctionalWasmValueAbi } from "./wasm_abi.ts";
import {
  FunctionalWasmFunctionType,
  type WasmFunctionBody,
  WasmInstructions,
  WasmValueType,
} from "./wasm_binary.ts";
import {
  FUNCTIONAL_WASM_ALLOCATION_MAGIC,
  FUNCTIONAL_WASM_FREE_BLOCK_MAGIC,
  FUNCTIONAL_WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH,
  FUNCTIONAL_WASM_MINIMUM_ALLOCATION_BYTE_LENGTH,
  FunctionalWasmRuntimeGlobal,
} from "./wasm_runtime_layout.ts";

export const WASM_FAULT_BLACKHOLE = 1;
export const WASM_FAULT_DIVIDE_BY_ZERO = 2;
export const WASM_FAULT_OUT_OF_MEMORY = 3;
export const WASM_FAULT_OUT_OF_FUEL = 4;
export const WASM_FAULT_INVALID_NUMERIC_CONVERSION = 5;
export const WASM_FAULT_OUT_OF_BOUNDS = 6;

export const THUNK_UNEVALUATED = 0;
export const THUNK_EVALUATING = 1;
export const THUNK_EVALUATED = 2;

const OBJECT_HEADER_BYTE_LENGTH = FunctionalWasmValueAbi.objectHeaderByteLength;
const VALUE_BYTE_LENGTH = FunctionalWasmValueAbi.valueByteLength;
const THUNK_HEADER_BYTE_LENGTH = OBJECT_HEADER_BYTE_LENGTH + VALUE_BYTE_LENGTH;

export function allocateFunction(heapStart: number): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const previousFree = instructions.addLocal(WasmValueType.I32);
  const currentFree = instructions.addLocal(WasmValueType.I32);
  const freeByteLength = instructions.addLocal(WasmValueType.I32);
  const remainderByteLength = instructions.addLocal(WasmValueType.I32);
  const replacementFree = instructions.addLocal(WasmValueType.I32);
  const previousTop = instructions.addLocal(WasmValueType.I32);
  const nextTop = instructions.addLocal(WasmValueType.I32);
  const requiredPages = instructions.addLocal(WasmValueType.I32);
  const currentPages = instructions.addLocal(WasmValueType.I32);
  emitNormalizeAllocationByteLength(instructions, 0);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.FreeListHead);
  instructions.localSet(currentFree);
  instructions.emit(0x02, 0x40, 0x03, 0x40);
  instructions.localGet(currentFree);
  instructions.emit(0x45, 0x0d);
  instructions.unsigned(1);
  emitFreeBlockGuard(instructions, currentFree, heapStart);
  instructions.localGet(currentFree);
  instructions.i32Load(4);
  instructions.localTee(freeByteLength);
  instructions.localGet(0);
  instructions.emit(0x4f, 0x04, 0x40);
  instructions.localGet(freeByteLength);
  instructions.localGet(0);
  instructions.emit(0x6b);
  instructions.localTee(remainderByteLength);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.localGet(currentFree);
  instructions.i32Load(8);
  instructions.localSet(replacementFree);
  instructions.emit(0x05);
  instructions.localGet(remainderByteLength);
  instructions.i32Const(FUNCTIONAL_WASM_MINIMUM_ALLOCATION_BYTE_LENGTH);
  instructions.emit(0x49, 0x04, 0x40);
  instructions.localGet(currentFree);
  instructions.localSet(previousFree);
  instructions.localGet(currentFree);
  instructions.i32Load(8);
  instructions.localSet(currentFree);
  instructions.branch(3);
  instructions.emit(0x05);
  instructions.localGet(currentFree);
  instructions.localGet(0);
  instructions.emit(0x6a);
  instructions.localTee(replacementFree);
  instructions.i32Const(FUNCTIONAL_WASM_FREE_BLOCK_MAGIC);
  instructions.i32Store(0);
  instructions.localGet(replacementFree);
  instructions.localGet(remainderByteLength);
  instructions.i32Store(4);
  instructions.localGet(replacementFree);
  instructions.localGet(currentFree);
  instructions.i32Load(8);
  instructions.i32Store(8);
  instructions.localGet(replacementFree);
  instructions.i32Const(0);
  instructions.i32Store(12);
  instructions.emit(0x0b, 0x0b);
  instructions.localGet(previousFree);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.localGet(replacementFree);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.FreeListHead);
  instructions.emit(0x05);
  instructions.localGet(previousFree);
  instructions.localGet(replacementFree);
  instructions.i32Store(8);
  instructions.emit(0x0b);
  emitInitializeAllocation(instructions, currentFree, 0);
  instructions.localGet(currentFree);
  instructions.emit(0x0f);
  instructions.emit(0x0b);
  instructions.localGet(currentFree);
  instructions.localSet(previousFree);
  instructions.localGet(currentFree);
  instructions.i32Load(8);
  instructions.localSet(currentFree);
  instructions.emit(0x0c);
  instructions.unsigned(0);
  instructions.emit(0x0b, 0x0b);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.HeapTop);
  instructions.localTee(previousTop);
  instructions.localGet(0);
  instructions.emit(0x6a);
  instructions.localTee(nextTop);
  instructions.localGet(previousTop);
  instructions.emit(0x49, 0x04, 0x40);
  emitOutOfMemory(instructions);
  instructions.emit(0x0b);
  instructions.localGet(nextTop);
  instructions.i32Const(FUNCTIONAL_WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH);
  instructions.emit(0x4b, 0x04, 0x40);
  emitOutOfMemory(instructions);
  instructions.emit(0x0b);
  instructions.localGet(nextTop);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.HeapCapacityByteLength);
  instructions.emit(0x4b, 0x04, 0x40);
  instructions.localGet(nextTop);
  instructions.i32Const(1);
  instructions.emit(0x6b);
  instructions.i32Const(16);
  instructions.emit(0x76);
  instructions.i32Const(1);
  instructions.emit(0x6a);
  instructions.localTee(requiredPages);
  instructions.memorySize();
  instructions.localTee(currentPages);
  instructions.emit(0x4b, 0x04, 0x40);
  instructions.localGet(requiredPages);
  instructions.localGet(currentPages);
  instructions.emit(0x6b);
  instructions.memoryGrow();
  instructions.i32Const(-1);
  instructions.emit(0x46, 0x04, 0x40);
  emitOutOfMemory(instructions);
  instructions.emit(0x0b, 0x0b);
  instructions.localGet(requiredPages);
  instructions.i32Const(16);
  instructions.emit(0x74);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.HeapCapacityByteLength);
  instructions.emit(0x0b);
  instructions.localGet(nextTop);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.HeapTop);
  emitInitializeAllocation(instructions, previousTop, 0);
  instructions.localGet(previousTop);
  return functionBody(FunctionalWasmFunctionType.Allocator, instructions, "allocator");
}

export function freeFunction(typeIndex: number, heapStart: number): WasmFunctionBody {
  const instructions = new WasmInstructions(2);
  const end = instructions.addLocal(WasmValueType.I32);
  const kind = instructions.addLocal(WasmValueType.I32);
  const valueCount = instructions.addLocal(WasmValueType.I32);
  const expectedByteLength = instructions.addLocal(WasmValueType.I32);
  instructions.localGet(0);
  instructions.emit(0x45, 0x04, 0x40, 0x0f, 0x0b);
  emitNormalizeAllocationByteLength(instructions, 1);
  instructions.localGet(0);
  instructions.i32Const(7);
  instructions.emit(0x71, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(0);
  instructions.i32Const(heapStart);
  instructions.emit(0x49, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(0);
  instructions.localGet(1);
  instructions.emit(0x6a);
  instructions.localTee(end);
  instructions.localGet(0);
  instructions.emit(0x49, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(end);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.HeapTop);
  instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(0);
  instructions.i32Load(0);
  instructions.localSet(kind);
  emitAllocationByteLength(
    instructions,
    0,
    kind,
    valueCount,
    expectedByteLength,
  );
  emitNormalizeAllocationByteLength(instructions, expectedByteLength);
  instructions.localGet(expectedByteLength);
  instructions.localGet(1);
  instructions.emit(0x47, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(0);
  instructions.i32Const(FUNCTIONAL_WASM_FREE_BLOCK_MAGIC);
  instructions.i32Store(0);
  instructions.localGet(0);
  instructions.localGet(1);
  instructions.i32Store(4);
  instructions.localGet(0);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.FreeListHead);
  instructions.i32Store(8);
  instructions.localGet(0);
  instructions.i32Const(0);
  instructions.i32Store(12);
  instructions.localGet(0);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.FreeListHead);
  return functionBody(typeIndex, instructions, "free-list release");
}

function emitNormalizeAllocationByteLength(
  instructions: WasmInstructions,
  byteLength: number,
): void {
  instructions.localGet(byteLength);
  instructions.i32Const(FUNCTIONAL_WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH);
  instructions.emit(0x4b, 0x04, 0x40);
  emitOutOfMemory(instructions);
  instructions.emit(0x0b);
  instructions.localGet(byteLength);
  instructions.i32Const(7);
  instructions.emit(0x6a);
  instructions.i32Const(-8);
  instructions.emit(0x71);
  instructions.localSet(byteLength);
  instructions.localGet(byteLength);
  instructions.i32Const(FUNCTIONAL_WASM_MINIMUM_ALLOCATION_BYTE_LENGTH);
  instructions.emit(0x49, 0x04, 0x40);
  instructions.i32Const(FUNCTIONAL_WASM_MINIMUM_ALLOCATION_BYTE_LENGTH);
  instructions.localSet(byteLength);
  instructions.emit(0x0b);
}

function emitOutOfMemory(instructions: WasmInstructions): void {
  instructions.i32Const(WASM_FAULT_OUT_OF_MEMORY);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.RuntimeFault);
  instructions.i32Const(-1);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.RuntimeFaultNode);
  instructions.emit(0x00);
}

function emitInitializeAllocation(
  instructions: WasmInstructions,
  pointer: number,
  byteLength: number,
): void {
  instructions.localGet(pointer);
  instructions.i32Const(FUNCTIONAL_WASM_ALLOCATION_MAGIC);
  instructions.i32Store(0);
  instructions.localGet(pointer);
  instructions.localGet(byteLength);
  instructions.i32Store(4);
  instructions.localGet(pointer);
  instructions.i32Const(0);
  instructions.i32Store(8);
  instructions.localGet(pointer);
  instructions.i32Const(0);
  instructions.i32Store(12);
}

function emitFreeBlockGuard(
  instructions: WasmInstructions,
  pointer: number,
  heapStart: number,
): void {
  const byteLength = instructions.addLocal(WasmValueType.I32);
  const end = instructions.addLocal(WasmValueType.I32);
  instructions.localGet(pointer);
  instructions.i32Const(7);
  instructions.emit(0x71, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Const(heapStart);
  instructions.emit(0x49, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Load(0);
  instructions.i32Const(FUNCTIONAL_WASM_FREE_BLOCK_MAGIC);
  instructions.emit(0x47, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(pointer);
  instructions.i32Load(4);
  instructions.localTee(byteLength);
  instructions.i32Const(FUNCTIONAL_WASM_MINIMUM_ALLOCATION_BYTE_LENGTH);
  instructions.emit(0x49, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(byteLength);
  instructions.i32Const(7);
  instructions.emit(0x71, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(pointer);
  instructions.localGet(byteLength);
  instructions.emit(0x6a);
  instructions.localTee(end);
  instructions.localGet(pointer);
  instructions.emit(0x49, 0x04, 0x40, 0x00, 0x0b);
  instructions.localGet(end);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.HeapTop);
  instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
}

function emitAllocationByteLength(
  instructions: WasmInstructions,
  pointer: number,
  kind: number,
  valueCount: number,
  byteLength: number,
): void {
  instructions.localGet(kind);
  instructions.i32Const(FUNCTIONAL_WASM_ALLOCATION_MAGIC);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.localGet(pointer);
  instructions.i32Load(4);
  instructions.localSet(byteLength);
  instructions.emit(0x05);

  instructions.localGet(kind);
  instructions.i32Const(FunctionalWasmValueAbi.objectKinds.thunk);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.localGet(pointer);
  instructions.i32Load(12);
  instructions.localSet(valueCount);
  emitScaledObjectByteLength(
    instructions,
    valueCount,
    THUNK_HEADER_BYTE_LENGTH,
    byteLength,
  );
  instructions.emit(0x05);

  instructions.localGet(pointer);
  instructions.i32Load(8);
  instructions.localSet(valueCount);
  instructions.localGet(kind);
  instructions.i32Const(FunctionalWasmValueAbi.objectKinds.text);
  instructions.emit(0x46);
  instructions.localGet(kind);
  instructions.i32Const(FunctionalWasmValueAbi.objectKinds.bytes);
  instructions.emit(0x46, 0x72, 0x04, 0x40);
  emitByteObjectByteLength(instructions, valueCount, byteLength);
  instructions.emit(0x05);

  instructions.localGet(kind);
  instructions.i32Const(FunctionalWasmValueAbi.objectKinds.numeric);
  instructions.emit(0x46, 0x04, 0x40);
  emitExpectedCount(instructions, valueCount, 1);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH + VALUE_BYTE_LENGTH);
  instructions.localSet(byteLength);
  instructions.emit(0x05);

  instructions.localGet(kind);
  instructions.i32Const(FunctionalWasmValueAbi.objectKinds.resource);
  instructions.emit(0x46, 0x04, 0x40);
  emitExpectedCount(instructions, valueCount, 0);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localSet(byteLength);
  instructions.emit(0x05);

  emitGraphObjectKindGuard(instructions, kind);
  emitScaledObjectByteLength(
    instructions,
    valueCount,
    OBJECT_HEADER_BYTE_LENGTH,
    byteLength,
  );
  instructions.emit(0x0b, 0x0b, 0x0b, 0x0b, 0x0b);
}

function emitByteObjectByteLength(
  instructions: WasmInstructions,
  valueCount: number,
  byteLength: number,
): void {
  instructions.localGet(valueCount);
  instructions.i32Const(
    FUNCTIONAL_WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH - OBJECT_HEADER_BYTE_LENGTH,
  );
  instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
  instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
  instructions.localGet(valueCount);
  instructions.emit(0x6a);
  instructions.localSet(byteLength);
}

function emitScaledObjectByteLength(
  instructions: WasmInstructions,
  valueCount: number,
  headerByteLength: number,
  byteLength: number,
): void {
  instructions.localGet(valueCount);
  instructions.i32Const(
    Math.floor(
      (FUNCTIONAL_WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH - headerByteLength) /
        VALUE_BYTE_LENGTH,
    ),
  );
  instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
  instructions.i32Const(headerByteLength);
  instructions.localGet(valueCount);
  instructions.i32Const(3);
  instructions.emit(0x74, 0x6a);
  instructions.localSet(byteLength);
}

function emitExpectedCount(
  instructions: WasmInstructions,
  valueCount: number,
  expected: number,
): void {
  instructions.localGet(valueCount);
  instructions.i32Const(expected);
  instructions.emit(0x47, 0x04, 0x40, 0x00, 0x0b);
}

function emitGraphObjectKindGuard(
  instructions: WasmInstructions,
  kind: number,
): void {
  const graphKinds = [
    FunctionalWasmValueAbi.objectKinds.closure,
    FunctionalWasmValueAbi.objectKinds.constructor,
    FunctionalWasmValueAbi.objectKinds.array,
    FunctionalWasmValueAbi.objectKinds.slice,
  ];
  for (const [index, graphKind] of graphKinds.entries()) {
    instructions.localGet(kind);
    instructions.i32Const(graphKind);
    instructions.emit(0x46);
    if (index !== 0) instructions.emit(0x72);
  }
  instructions.emit(0x45, 0x04, 0x40, 0x00, 0x0b);
}

export function forceThunkFunction(): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const value = instructions.addLocal(WasmValueType.I64);
  instructions.localGet(0);
  instructions.i32Load(4);
  instructions.i32Const(THUNK_EVALUATED);
  instructions.emit(0x46, 0x04, WasmValueType.I64);
  instructions.localGet(0);
  instructions.i64Load(16);
  instructions.emit(0x05);
  instructions.localGet(0);
  instructions.i32Load(4);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.emit(0x05);
  instructions.i32Const(WASM_FAULT_BLACKHOLE);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.RuntimeFault);
  instructions.i32Const(-1);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.RuntimeFaultNode);
  instructions.emit(0x00, 0x0b);
  instructions.localGet(0);
  instructions.i32Const(THUNK_EVALUATING);
  instructions.i32Store(4);
  instructions.globalGet(FunctionalWasmRuntimeGlobal.ThunkEvaluations);
  instructions.i32Const(1);
  instructions.emit(0x6a);
  instructions.globalSet(FunctionalWasmRuntimeGlobal.ThunkEvaluations);
  instructions.localGet(0);
  instructions.localGet(0);
  instructions.i32Load(8);
  instructions.callIndirect(FunctionalWasmFunctionType.ThunkForce);
  instructions.localSet(value);
  instructions.localGet(0);
  instructions.localGet(value);
  instructions.i64Store(16);
  instructions.localGet(0);
  instructions.i32Const(THUNK_EVALUATED);
  instructions.i32Store(4);
  instructions.localGet(value);
  instructions.emit(0x0b);
  return functionBody(
    FunctionalWasmFunctionType.ThunkForce,
    instructions,
    "thunk force slow path",
  );
}

export function functionBody(
  typeIndex: number,
  instructions: WasmInstructions,
  context: string,
): WasmFunctionBody {
  if (instructions.bytes.length === 0) {
    throw new Error(`functional WASM ${context} emitted no instructions`);
  }
  return {
    typeIndex,
    localTypes: instructions.localTypes,
    instructions: instructions.bytes,
    usesMemory: instructions.usesMemory,
    usesIndirectCalls: instructions.usesIndirectCalls,
  };
}
