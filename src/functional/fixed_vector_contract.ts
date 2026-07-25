import { matchesFunctionalQualifiedName } from "./module_contract.ts";

export const F32X4_TYPE_NAME = "$FunctionalF32x4";
export const F32X4_CONSTRUCTOR_NAME = "$FunctionalF32x4Value";
export const MASK32X4_TYPE_NAME = "$FunctionalMask32x4";
export const MASK32X4_CONSTRUCTOR_NAME = "$FunctionalMask32x4Value";

const F32X4_DEFINITION_NAMES = {
  Splat: "$F32x4Splat",
  Add: "$F32x4Add",
  Subtract: "$F32x4Subtract",
  Multiply: "$F32x4Multiply",
  Divide: "$F32x4Divide",
  Equal: "$F32x4Equal",
  Less: "$F32x4Less",
  Select: "$F32x4Select",
  ExtractLane0: "$F32x4ExtractLane0",
  ExtractLane1: "$F32x4ExtractLane1",
  ExtractLane2: "$F32x4ExtractLane2",
  ExtractLane3: "$F32x4ExtractLane3",
  ReplaceLane0: "$F32x4ReplaceLane0",
  ReplaceLane1: "$F32x4ReplaceLane1",
  ReplaceLane2: "$F32x4ReplaceLane2",
  ReplaceLane3: "$F32x4ReplaceLane3",
  ReduceAdd: "$F32x4ReduceAdd",
  Map: "$F32x4Map",
  Zip: "$F32x4Zip",
  Fold: "$F32x4Fold",
} as const;

export const F32x4Definition: Readonly<
  typeof F32X4_DEFINITION_NAMES
> = Object.freeze(F32X4_DEFINITION_NAMES);

const FIXED_VECTOR_NAMES: readonly string[] = Object.freeze([
  F32X4_TYPE_NAME,
  F32X4_CONSTRUCTOR_NAME,
  MASK32X4_TYPE_NAME,
  MASK32X4_CONSTRUCTOR_NAME,
  ...Object.values(F32x4Definition),
]);

export function canonicalFunctionalFixedVectorName(name: string): string | undefined {
  return FIXED_VECTOR_NAMES.find((candidate) => matchesFunctionalQualifiedName(name, candidate));
}

export function correspondingFunctionalFixedVectorName(
  reference: string,
  sibling: string,
): string | undefined {
  const canonicalReference = canonicalFunctionalFixedVectorName(reference);
  if (canonicalReference === undefined) return undefined;
  return `${reference.slice(0, -canonicalReference.length)}${sibling}`;
}
