import { type WasmFunctionBody, WasmInstructions, WasmValueType } from "./wasm_binary.ts";

export const WASM_FAULT_BLACKHOLE = 1;
export const WASM_FAULT_DIVIDE_BY_ZERO = 2;
export const WASM_FAULT_OUT_OF_MEMORY = 3;
export const WASM_FAULT_OUT_OF_FUEL = 4;
export const WASM_FAULT_INVALID_NUMERIC_CONVERSION = 5;

export const THUNK_UNEVALUATED = 0;
export const THUNK_EVALUATING = 1;
export const THUNK_EVALUATED = 2;

export function allocateFunction(): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const previousFree = instructions.addLocal(WasmValueType.I32);
  const currentFree = instructions.addLocal(WasmValueType.I32);
  const nextFree = instructions.addLocal(WasmValueType.I32);
  const previousTop = instructions.addLocal(WasmValueType.I32);
  const nextTop = instructions.addLocal(WasmValueType.I32);
  const requiredPages = instructions.addLocal(WasmValueType.I32);
  instructions.localGet(0);
  instructions.i32Const(7);
  instructions.emit(0x6a);
  instructions.i32Const(-8);
  instructions.emit(0x71);
  instructions.localSet(0);
  instructions.localGet(0);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.i32Const(8);
  instructions.localSet(0);
  instructions.emit(0x0b);
  instructions.globalGet(4);
  instructions.localSet(currentFree);
  instructions.emit(0x02, 0x40, 0x03, 0x40);
  instructions.localGet(currentFree);
  instructions.emit(0x45, 0x0d);
  instructions.unsigned(1);
  instructions.localGet(currentFree);
  instructions.i32Load(0);
  instructions.localGet(0);
  instructions.emit(0x4f, 0x04, 0x40);
  instructions.localGet(currentFree);
  instructions.i32Load(4);
  instructions.localSet(nextFree);
  instructions.localGet(previousFree);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.localGet(nextFree);
  instructions.globalSet(4);
  instructions.emit(0x05);
  instructions.localGet(previousFree);
  instructions.localGet(nextFree);
  instructions.i32Store(4);
  instructions.emit(0x0b);
  instructions.localGet(currentFree);
  instructions.emit(0x0f, 0x0b);
  instructions.localGet(currentFree);
  instructions.localSet(previousFree);
  instructions.localGet(currentFree);
  instructions.i32Load(4);
  instructions.localSet(currentFree);
  instructions.emit(0x0c);
  instructions.unsigned(0);
  instructions.emit(0x0b, 0x0b);
  instructions.emit(0x23, 0x00);
  instructions.localTee(previousTop);
  instructions.localGet(0);
  instructions.emit(0x6a);
  instructions.localTee(nextTop);
  instructions.emit(0x23, 0x03, 0x4b, 0x04, 0x40);
  instructions.localGet(nextTop);
  instructions.i32Const(65_535);
  instructions.emit(0x6a);
  instructions.i32Const(16);
  instructions.emit(0x76);
  instructions.localTee(requiredPages);
  instructions.emit(0x3f, 0x00, 0x6b, 0x40, 0x00);
  instructions.i32Const(-1);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.i32Const(WASM_FAULT_OUT_OF_MEMORY);
  instructions.globalSet(2);
  instructions.i32Const(-1);
  instructions.globalSet(5);
  instructions.emit(0x00, 0x0b);
  instructions.localGet(requiredPages);
  instructions.i32Const(16);
  instructions.emit(0x74, 0x24, 0x03, 0x0b);
  instructions.localGet(nextTop);
  instructions.emit(0x24, 0x00);
  instructions.localGet(previousTop);
  return functionBody(0, instructions, "allocator");
}

export function freeFunction(typeIndex: number): WasmFunctionBody {
  const instructions = new WasmInstructions(2);
  instructions.localGet(0);
  instructions.emit(0x45, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(1);
  instructions.i32Const(7);
  instructions.emit(0x6a);
  instructions.i32Const(-8);
  instructions.emit(0x71);
  instructions.localSet(1);
  instructions.localGet(0);
  instructions.localGet(1);
  instructions.i32Store(0);
  instructions.localGet(0);
  instructions.globalGet(4);
  instructions.i32Store(4);
  instructions.localGet(0);
  instructions.globalSet(4);
  return functionBody(typeIndex, instructions, "free-list release");
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
  instructions.globalSet(2);
  instructions.i32Const(-1);
  instructions.globalSet(5);
  instructions.emit(0x00, 0x0b);
  instructions.localGet(0);
  instructions.i32Const(THUNK_EVALUATING);
  instructions.i32Store(4);
  instructions.emit(0x23, 0x01);
  instructions.i32Const(1);
  instructions.emit(0x6a, 0x24, 0x01);
  instructions.localGet(0);
  instructions.localGet(0);
  instructions.i32Load(8);
  instructions.callIndirect(4);
  instructions.localSet(value);
  instructions.localGet(0);
  instructions.localGet(value);
  instructions.i64Store(16);
  instructions.localGet(0);
  instructions.i32Const(THUNK_EVALUATED);
  instructions.i32Store(4);
  instructions.localGet(value);
  instructions.emit(0x0b);
  return functionBody(4, instructions, "thunk force slow path");
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
