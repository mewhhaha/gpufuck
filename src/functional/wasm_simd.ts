import { FunctionalBinaryOperator } from "./abi.ts";
import { FunctionalF32x4Definition } from "./fixed_vector_contract.ts";

export const FunctionalWasmSimdOpcode = Object.freeze(
  {
    I32x4Splat: 17,
    F32x4Splat: 19,
    I32x4ExtractLane: 27,
    I32x4ReplaceLane: 28,
    F32x4ExtractLane: 31,
    F32x4ReplaceLane: 32,
    F32x4Equal: 65,
    F32x4Less: 67,
    V128BitSelect: 82,
    F32x4Negate: 225,
    F32x4SquareRoot: 227,
    F32x4Add: 228,
    F32x4Subtract: 229,
    F32x4Multiply: 230,
    F32x4Divide: 231,
  } as const,
);

export function simdF32x4BinaryOpcode(definition: string): number | undefined {
  switch (definition) {
    case FunctionalF32x4Definition.Add:
      return FunctionalWasmSimdOpcode.F32x4Add;
    case FunctionalF32x4Definition.Subtract:
      return FunctionalWasmSimdOpcode.F32x4Subtract;
    case FunctionalF32x4Definition.Multiply:
      return FunctionalWasmSimdOpcode.F32x4Multiply;
    case FunctionalF32x4Definition.Divide:
      return FunctionalWasmSimdOpcode.F32x4Divide;
    default:
      return undefined;
  }
}

export function simdF32x4ComparisonOpcode(definition: string): number | undefined {
  switch (definition) {
    case FunctionalF32x4Definition.Equal:
      return FunctionalWasmSimdOpcode.F32x4Equal;
    case FunctionalF32x4Definition.Less:
      return FunctionalWasmSimdOpcode.F32x4Less;
    default:
      return undefined;
  }
}

export function f32x4ReplacementLane(definition: string): number | undefined {
  switch (definition) {
    case FunctionalF32x4Definition.ReplaceLane0:
      return 0;
    case FunctionalF32x4Definition.ReplaceLane1:
      return 1;
    case FunctionalF32x4Definition.ReplaceLane2:
      return 2;
    case FunctionalF32x4Definition.ReplaceLane3:
      return 3;
    default:
      return undefined;
  }
}

export function f32x4ExtractedLane(definition: string): number | undefined {
  switch (definition) {
    case FunctionalF32x4Definition.ExtractLane0:
      return 0;
    case FunctionalF32x4Definition.ExtractLane1:
      return 1;
    case FunctionalF32x4Definition.ExtractLane2:
      return 2;
    case FunctionalF32x4Definition.ExtractLane3:
      return 3;
    default:
      return undefined;
  }
}

export function simdFloat32Operator(operator: number): number | undefined {
  switch (operator) {
    case FunctionalBinaryOperator.AddFloat32:
      return FunctionalWasmSimdOpcode.F32x4Add;
    case FunctionalBinaryOperator.SubtractFloat32:
      return FunctionalWasmSimdOpcode.F32x4Subtract;
    case FunctionalBinaryOperator.MultiplyFloat32:
      return FunctionalWasmSimdOpcode.F32x4Multiply;
    case FunctionalBinaryOperator.DivideFloat32:
      return FunctionalWasmSimdOpcode.F32x4Divide;
    default:
      return undefined;
  }
}
