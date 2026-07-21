import { matchesFunctionalQualifiedName } from "./module_contract.ts";

export const FUNCTIONAL_F32X4_TYPE_NAME = "$FunctionalF32x4";
export const FUNCTIONAL_F32X4_CONSTRUCTOR_NAME = "$FunctionalF32x4Value";
export const FUNCTIONAL_MASK32X4_TYPE_NAME = "$FunctionalMask32x4";
export const FUNCTIONAL_MASK32X4_CONSTRUCTOR_NAME = "$FunctionalMask32x4Value";

const FUNCTIONAL_F32X4_DEFINITION_NAMES = {
  Splat: "$FunctionalF32x4Splat",
  Add: "$FunctionalF32x4Add",
  Subtract: "$FunctionalF32x4Subtract",
  Multiply: "$FunctionalF32x4Multiply",
  Divide: "$FunctionalF32x4Divide",
  Equal: "$FunctionalF32x4Equal",
  Less: "$FunctionalF32x4Less",
  Select: "$FunctionalF32x4Select",
  ExtractLane0: "$FunctionalF32x4ExtractLane0",
  ExtractLane1: "$FunctionalF32x4ExtractLane1",
  ExtractLane2: "$FunctionalF32x4ExtractLane2",
  ExtractLane3: "$FunctionalF32x4ExtractLane3",
  ReplaceLane0: "$FunctionalF32x4ReplaceLane0",
  ReplaceLane1: "$FunctionalF32x4ReplaceLane1",
  ReplaceLane2: "$FunctionalF32x4ReplaceLane2",
  ReplaceLane3: "$FunctionalF32x4ReplaceLane3",
  ReduceAdd: "$FunctionalF32x4ReduceAdd",
  Map: "$FunctionalF32x4Map",
  Zip: "$FunctionalF32x4Zip",
  Fold: "$FunctionalF32x4Fold",
} as const;

export const FunctionalF32x4Definition: Readonly<
  typeof FUNCTIONAL_F32X4_DEFINITION_NAMES
> = Object.freeze(FUNCTIONAL_F32X4_DEFINITION_NAMES);

const FUNCTIONAL_FIXED_VECTOR_NAMES: readonly string[] = Object.freeze([
  FUNCTIONAL_F32X4_TYPE_NAME,
  FUNCTIONAL_F32X4_CONSTRUCTOR_NAME,
  FUNCTIONAL_MASK32X4_TYPE_NAME,
  FUNCTIONAL_MASK32X4_CONSTRUCTOR_NAME,
  ...Object.values(FunctionalF32x4Definition),
]);

export function canonicalFunctionalFixedVectorName(name: string): string | undefined {
  return FUNCTIONAL_FIXED_VECTOR_NAMES.find((candidate) =>
    matchesFunctionalQualifiedName(name, candidate)
  );
}

export function correspondingFunctionalFixedVectorName(
  reference: string,
  sibling: string,
): string | undefined {
  const canonicalReference = canonicalFunctionalFixedVectorName(reference);
  if (canonicalReference === undefined) return undefined;
  return `${reference.slice(0, -canonicalReference.length)}${sibling}`;
}
