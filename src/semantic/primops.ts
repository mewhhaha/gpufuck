import { BinaryOperator, NumericConversion, UnaryOperator } from "./abi.ts";

export const PrimopFamily = {
  Unary: 1,
  Binary: 2,
  NumericConversion: 3,
  BufferAppend: 4,
  StoreEmpty: 5,
  StoreNew: 6,
  StoreLength: 7,
  StoreRead: 8,
  StoreWrite: 9,
  StoreGrow: 10,
} as const;

export type PrimopFamily = (typeof PrimopFamily)[keyof typeof PrimopFamily];

export const StoreUpdateMode = {
  Persistent: 0,
} as const;

export type StoreUpdateMode = (typeof StoreUpdateMode)[keyof typeof StoreUpdateMode];

export interface PrimopDeclaration {
  readonly opcode: number;
  readonly name: string;
  readonly family: PrimopFamily;
  readonly operation: number;
  readonly arity: number;
  readonly typeRule: string;
  readonly fault: "none" | "arithmetic" | "bounds" | "explicit";
  readonly effects: readonly string[];
  readonly backends: {
    readonly gpu: boolean;
    readonly linearWasm: boolean;
  };
}

const UNARY_OPCODE_BASE = 0;
const BINARY_OPCODE_BASE = 32;
const CONVERSION_OPCODE_BASE = 112;
const BUFFER_APPEND_OPCODE = 144;
const STORE_EMPTY_OPCODE = 145;
const STORE_NEW_OPCODE = 146;
const STORE_LENGTH_OPCODE = 147;
const STORE_READ_OPCODE = 148;
const STORE_WRITE_OPCODE = 149;
const STORE_GROW_OPCODE = 150;

const allBackends = Object.freeze({ gpu: true, linearWasm: true });
const wasmBackends = Object.freeze({ gpu: false, linearWasm: true });
const noEffects = Object.freeze([]) as readonly string[];

function numericDeclarations(
  values: Readonly<Record<string, number>>,
  base: number,
  family: PrimopFamily,
  arity: number,
  typeRule: string,
  gpuAvailable: (operation: number) => boolean,
  fault: (operation: number) => PrimopDeclaration["fault"],
): PrimopDeclaration[] {
  return Object.entries(values).map(([name, operation]) => ({
    opcode: base + operation,
    name,
    family,
    operation,
    arity,
    typeRule,
    fault: fault(operation),
    effects: noEffects,
    backends: gpuAvailable(operation) ? allBackends : wasmBackends,
  }));
}

export const PRIMOPS: readonly PrimopDeclaration[] = Object.freeze([
  ...numericDeclarations(
    UnaryOperator,
    UNARY_OPCODE_BASE,
    PrimopFamily.Unary,
    1,
    "unary-numeric",
    (operation) =>
      operation !== UnaryOperator.NegateFloat64 &&
      operation !== UnaryOperator.SquareRootFloat32,
    () => "none",
  ),
  ...numericDeclarations(
    BinaryOperator,
    BINARY_OPCODE_BASE,
    PrimopFamily.Binary,
    2,
    "binary-numeric",
    (operation) =>
      operation !== BinaryOperator.StructuralEqual &&
      operation !== BinaryOperator.StructuralNotEqual &&
      operation !== BinaryOperator.DivideFloat32 &&
      !(operation >= BinaryOperator.EqualFloat64 &&
        operation <= BinaryOperator.DivideFloat64) &&
      operation !== BinaryOperator.RemainderFloat64,
    (operation) =>
      operation === BinaryOperator.Divide ||
        operation === BinaryOperator.DivideSignedInteger64 ||
        operation === BinaryOperator.DivideFloat32 ||
        operation === BinaryOperator.DivideFloat64 ||
        operation === BinaryOperator.Remainder ||
        operation === BinaryOperator.RemainderSignedInteger64 ||
        operation === BinaryOperator.RemainderFloat64
        ? "arithmetic"
        : "none",
  ),
  ...numericDeclarations(
    NumericConversion,
    CONVERSION_OPCODE_BASE,
    PrimopFamily.NumericConversion,
    1,
    "numeric-conversion",
    (operation) =>
      operation !== NumericConversion.SignedInteger32ToFloat64 &&
      operation !== NumericConversion.SignedInteger64ToFloat64 &&
      operation !== NumericConversion.Float32ToFloat64 &&
      operation !== NumericConversion.Float64ToSignedInteger32 &&
      operation !== NumericConversion.Float64ToSignedInteger64 &&
      operation !== NumericConversion.Float64ToFloat32,
    () => "none",
  ),
  {
    opcode: BUFFER_APPEND_OPCODE,
    name: "BufferAppend",
    family: PrimopFamily.BufferAppend,
    operation: 0,
    arity: 2,
    typeRule: "same-nominal-binary",
    fault: "none",
    effects: noEffects,
    backends: wasmBackends,
  },
  {
    opcode: STORE_EMPTY_OPCODE,
    name: "StoreEmpty",
    family: PrimopFamily.StoreEmpty,
    operation: 0,
    arity: 0,
    typeRule: "polymorphic-store",
    fault: "none",
    effects: noEffects,
    backends: wasmBackends,
  },
  {
    opcode: STORE_NEW_OPCODE,
    name: "StoreNew",
    family: PrimopFamily.StoreNew,
    operation: 0,
    arity: 2,
    typeRule: "store-new",
    fault: "bounds",
    effects: noEffects,
    backends: wasmBackends,
  },
  {
    opcode: STORE_LENGTH_OPCODE,
    name: "StoreLength",
    family: PrimopFamily.StoreLength,
    operation: 0,
    arity: 1,
    typeRule: "store-length",
    fault: "none",
    effects: noEffects,
    backends: wasmBackends,
  },
  {
    opcode: STORE_READ_OPCODE,
    name: "StoreRead",
    family: PrimopFamily.StoreRead,
    operation: 0,
    arity: 2,
    typeRule: "store-read",
    fault: "bounds",
    effects: noEffects,
    backends: wasmBackends,
  },
  {
    opcode: STORE_WRITE_OPCODE,
    name: "StoreWrite",
    family: PrimopFamily.StoreWrite,
    operation: StoreUpdateMode.Persistent,
    arity: 3,
    typeRule: "store-update",
    fault: "bounds",
    effects: noEffects,
    backends: wasmBackends,
  },
  {
    opcode: STORE_GROW_OPCODE,
    name: "StoreGrow",
    family: PrimopFamily.StoreGrow,
    operation: StoreUpdateMode.Persistent,
    arity: 3,
    typeRule: "store-update",
    fault: "bounds",
    effects: noEffects,
    backends: wasmBackends,
  },
]);

const declarationByOpcode = new Map(PRIMOPS.map((declaration) => [
  declaration.opcode,
  declaration,
]));

export function unaryPrimop(operator: number): number {
  return requiredPrimop(UNARY_OPCODE_BASE + operator, PrimopFamily.Unary).opcode;
}

export function binaryPrimop(operator: number): number {
  return requiredPrimop(BINARY_OPCODE_BASE + operator, PrimopFamily.Binary).opcode;
}

export function numericConversionPrimop(conversion: number): number {
  return requiredPrimop(
    CONVERSION_OPCODE_BASE + conversion,
    PrimopFamily.NumericConversion,
  ).opcode;
}

export const BufferAppendPrimop = BUFFER_APPEND_OPCODE;
export const StoreEmptyPrimop = STORE_EMPTY_OPCODE;
export const StoreNewPrimop = STORE_NEW_OPCODE;
export const StoreLengthPrimop = STORE_LENGTH_OPCODE;
export const StoreReadPrimop = STORE_READ_OPCODE;
export const StoreWritePrimop = STORE_WRITE_OPCODE;
export const StoreGrowPrimop = STORE_GROW_OPCODE;

export function primopDeclaration(opcode: number): PrimopDeclaration | undefined {
  return declarationByOpcode.get(opcode);
}

function requiredPrimop(opcode: number, family: PrimopFamily): PrimopDeclaration {
  const declaration = declarationByOpcode.get(opcode);
  if (declaration?.family !== family) {
    throw new RangeError(`unknown primop operation ${opcode} for family ${family}`);
  }
  return declaration;
}

export function primopWgslLookup(functionName: string): string {
  const cases = PRIMOPS.map((declaration) =>
    `case ${declaration.opcode}u: { return vec3<u32>(${declaration.family}u, ${declaration.operation}u, ${declaration.arity}u); }`
  ).join("\n");
  return `fn ${functionName}(opcode: u32) -> vec3<u32> {
  switch opcode {
${cases}
    default: { return vec3<u32>(0u, 0u, 0xffffffffu); }
  }
}`;
}
