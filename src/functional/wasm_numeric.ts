import { FunctionalBinaryOperator, FunctionalNumericConversion } from "./abi.ts";
import type { FunctionalCoreNode } from "./compiler_module.ts";

export function isComparisonOperator(operator: number): boolean {
  return operator >= 1 && operator <= 40 && (operator - 1) % 10 < 6 ||
    operator >= FunctionalBinaryOperator.EqualWholeNumberF64 &&
      operator <= FunctionalBinaryOperator.GreaterEqualWholeNumberF64;
}

export type NumericPrimitiveKind =
  | "integer"
  | "signed-integer-64"
  | "float-32"
  | "float-64"
  | "whole-number-f64";

export function numericOperatorGroup(operator: number): NumericPrimitiveKind {
  if (operator >= 1 && operator <= 10) return "integer";
  if (operator <= 20) return "signed-integer-64";
  if (operator <= 30) return "float-32";
  if (operator <= 40) return "float-64";
  if (operator <= 46) return "integer";
  if (operator <= 52) return "signed-integer-64";
  if (
    operator >= FunctionalBinaryOperator.EqualWholeNumberF64 &&
    operator <= FunctionalBinaryOperator.RemainderWholeNumberF64
  ) return "whole-number-f64";
  throw new RangeError(
    `functional numeric operator must be within [1, 52] or [55, 65]; received ${operator}`,
  );
}

export function numericBinaryOpcode(operator: number): number | undefined {
  switch (operator) {
    case FunctionalBinaryOperator.Remainder:
      return undefined;
    case FunctionalBinaryOperator.BitwiseAnd:
      return 0x71;
    case FunctionalBinaryOperator.BitwiseOr:
      return 0x72;
    case FunctionalBinaryOperator.BitwiseXor:
      return 0x73;
    case FunctionalBinaryOperator.ShiftLeft:
      return 0x74;
    case FunctionalBinaryOperator.ShiftRightUnsigned:
      return 0x76;
    case FunctionalBinaryOperator.RemainderSignedInteger64:
      return 0x81;
    case FunctionalBinaryOperator.DivideWholeNumberF64:
    case FunctionalBinaryOperator.RemainderWholeNumberF64:
      return undefined;
    case FunctionalBinaryOperator.BitwiseAndSignedInteger64:
      return 0x83;
    case FunctionalBinaryOperator.BitwiseOrSignedInteger64:
      return 0x84;
    case FunctionalBinaryOperator.BitwiseXorSignedInteger64:
      return 0x85;
    case FunctionalBinaryOperator.ShiftLeftSignedInteger64:
      return 0x86;
    case FunctionalBinaryOperator.ShiftRightUnsignedSignedInteger64:
      return 0x88;
  }
  const group = numericOperatorGroup(operator);
  const position = group === "whole-number-f64"
    ? operator - FunctionalBinaryOperator.EqualWholeNumberF64
    : (operator - 1) % 10;
  const opcodes = group === "integer"
    ? [0x46, 0x47, 0x48, 0x4c, 0x4a, 0x4e, 0x6a, 0x6b, 0x6c, undefined]
    : group === "signed-integer-64"
    ? [0x51, 0x52, 0x53, 0x57, 0x55, 0x59, 0x7c, 0x7d, 0x7e, 0x7f]
    : group === "float-32"
    ? [0x5b, 0x5c, 0x5d, 0x5f, 0x5e, 0x60, 0x92, 0x93, 0x94, 0x95]
    : [0x61, 0x62, 0x63, 0x65, 0x64, 0x66, 0xa0, 0xa1, 0xa2, 0xa3];
  return opcodes[position];
}

export function numericConversion(
  conversion: number,
): {
  readonly source: NumericPrimitiveKind;
  readonly result: NumericPrimitiveKind;
  readonly opcode: number;
} {
  switch (conversion) {
    case FunctionalNumericConversion.SignedInteger32ToSignedInteger64:
      return { source: "integer", result: "signed-integer-64", opcode: 0xac };
    case FunctionalNumericConversion.SignedInteger64ToSignedInteger32:
      return { source: "signed-integer-64", result: "integer", opcode: 0xa7 };
    case FunctionalNumericConversion.SignedInteger32ToFloat32:
      return { source: "integer", result: "float-32", opcode: 0xb2 };
    case FunctionalNumericConversion.SignedInteger32ToFloat64:
      return { source: "integer", result: "float-64", opcode: 0xb7 };
    case FunctionalNumericConversion.SignedInteger64ToFloat32:
      return { source: "signed-integer-64", result: "float-32", opcode: 0xb4 };
    case FunctionalNumericConversion.SignedInteger64ToFloat64:
      return { source: "signed-integer-64", result: "float-64", opcode: 0xb9 };
    case FunctionalNumericConversion.Float32ToSignedInteger32:
      return { source: "float-32", result: "integer", opcode: 0xa8 };
    case FunctionalNumericConversion.Float32ToSignedInteger64:
      return { source: "float-32", result: "signed-integer-64", opcode: 0xae };
    case FunctionalNumericConversion.Float32ToFloat64:
      return { source: "float-32", result: "float-64", opcode: 0xbb };
    case FunctionalNumericConversion.Float64ToSignedInteger32:
      return { source: "float-64", result: "integer", opcode: 0xaa };
    case FunctionalNumericConversion.Float64ToSignedInteger64:
      return { source: "float-64", result: "signed-integer-64", opcode: 0xb0 };
    case FunctionalNumericConversion.Float64ToFloat32:
      return { source: "float-64", result: "float-32", opcode: 0xb6 };
    case FunctionalNumericConversion.ReinterpretFloat32AsSignedInteger32:
      return { source: "float-32", result: "integer", opcode: 0xbc };
    case FunctionalNumericConversion.ReinterpretSignedInteger32AsFloat32:
      return { source: "integer", result: "float-32", opcode: 0xbe };
    default:
      throw new RangeError(
        `functional numeric conversion must be within [1, 14]; received ${conversion}`,
      );
  }
}

export function wideLiteralBits(node: FunctionalCoreNode): bigint {
  return BigInt.asIntN(64, BigInt(node.payload) | BigInt(node.child0) << 32n);
}

export function float32FromBits(bits: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
}

export function float64FromBits(bits: bigint): number {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return view.getFloat64(0, true);
}
