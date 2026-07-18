import { FunctionalBinaryOperator, FunctionalCoreTag } from "./abi.ts";
import type { FunctionalCoreNode } from "./compiler_module.ts";
import type { WasmInstructions } from "./wasm_binary.ts";
import { numericConversion } from "./wasm_numeric.ts";
import { WASM_FAULT_OUT_OF_FUEL } from "./wasm_runtime_binary.ts";
import {
  type FunctionalWasmCompactRuntimeGlobals,
  FunctionalWasmRuntimeGlobal,
} from "./wasm_runtime_layout.ts";

export class FunctionalWasmRuntimeEmitter {
  readonly compactGlobals: FunctionalWasmCompactRuntimeGlobals;

  readonly #compactScalar: boolean;
  readonly #instrumentedFuel: boolean;

  constructor(
    nodes: readonly FunctionalCoreNode[],
    options: {
      readonly compactScalar: boolean;
      readonly instrumentedFuel: boolean;
    },
  ) {
    this.#compactScalar = options.compactScalar;
    this.#instrumentedFuel = options.instrumentedFuel;
    this.compactGlobals = options.compactScalar
      ? compactRuntimeGlobals(nodes, options.instrumentedFuel)
      : Object.freeze({});
  }

  emitFuelCharge(instructions: WasmInstructions, nodeIndex: number): void {
    if (!this.#instrumentedFuel) return;
    const fuel = this.compactGlobals.fuel;
    const remainingFuelGlobal = this.#compactScalar
      ? requiredCompactGlobal(fuel?.remaining, "remaining fuel")
      : FunctionalWasmRuntimeGlobal.ComptimeFuel;
    const stepsGlobal = this.#compactScalar
      ? requiredCompactGlobal(fuel?.steps, "semantic steps")
      : FunctionalWasmRuntimeGlobal.ComptimeSteps;
    instructions.globalGet(remainingFuelGlobal);
    instructions.emit(0x45, 0x04, 0x40);
    this.emitFault(instructions, WASM_FAULT_OUT_OF_FUEL, nodeIndex);
    instructions.emit(0x0b);
    instructions.globalGet(remainingFuelGlobal);
    instructions.i32Const(1);
    instructions.emit(0x6b);
    instructions.globalSet(remainingFuelGlobal);
    instructions.globalGet(stepsGlobal);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.globalSet(stepsGlobal);
  }

  emitFault(
    instructions: WasmInstructions,
    fault: number,
    nodeIndex: number,
  ): void {
    const compactFault = this.compactGlobals.fault;
    const faultGlobal = this.#compactScalar
      ? requiredCompactGlobal(compactFault?.code, "runtime fault")
      : FunctionalWasmRuntimeGlobal.RuntimeFault;
    const faultNodeGlobal = this.#compactScalar
      ? requiredCompactGlobal(compactFault?.node, "runtime fault node")
      : FunctionalWasmRuntimeGlobal.RuntimeFaultNode;
    instructions.i32Const(fault);
    instructions.globalSet(faultGlobal);
    instructions.i32Const(nodeIndex);
    instructions.globalSet(faultNodeGlobal);
    instructions.emit(0x00);
  }
}

function compactRuntimeGlobals(
  nodes: readonly FunctionalCoreNode[],
  instrumentedFuel: boolean,
): FunctionalWasmCompactRuntimeGlobals {
  let nextIndex = 0;
  const mayFault = instrumentedFuel || nodes.some((node) => {
    if (node.tag === FunctionalCoreTag.Binary) {
      return node.payload === FunctionalBinaryOperator.Divide ||
        node.payload === FunctionalBinaryOperator.DivideSignedInteger64 ||
        node.payload === FunctionalBinaryOperator.Remainder ||
        node.payload === FunctionalBinaryOperator.RemainderSignedInteger64;
    }
    if (node.tag !== FunctionalCoreTag.NumericConvert) return false;
    const conversion = numericConversion(node.payload);
    return (conversion.source === "float-32" || conversion.source === "float-64") &&
      (conversion.result === "integer" || conversion.result === "signed-integer-64");
  });
  const fault = mayFault ? Object.freeze({ code: nextIndex++, node: nextIndex++ }) : undefined;
  const fuel = instrumentedFuel
    ? Object.freeze({ remaining: nextIndex++, steps: nextIndex++ })
    : undefined;
  return Object.freeze({
    ...(fault === undefined ? {} : { fault }),
    ...(fuel === undefined ? {} : { fuel }),
  });
}

function requiredCompactGlobal(index: number | undefined, name: string): number {
  if (index !== undefined) return index;
  throw new Error(`functional WASM compact module omitted required ${name} global`);
}
