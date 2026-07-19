/** Target-neutral effect programs, verified Effect Core, and row elaboration. */

export type * from "./src/functional/effect_contract.ts";
export type * from "./src/functional/effect_core_contract.ts";
export { lowerFunctionalEffectProgram } from "./src/functional/effect_lowering.ts";
export {
  functionalEffectOperationsFromRow,
  functionalRecordConstructorName,
  type FunctionalRow,
  type FunctionalRowField,
  type FunctionalRowKind,
  type FunctionalRowSubstitutionEntry,
  functionalRowTypeDeclaration,
  type FunctionalRowUnification,
  type FunctionalRowUnificationOptions,
  functionalVariantConstructorName,
  resolveFunctionalRow,
  unifyFunctionalRows,
} from "./src/functional/row_types.ts";
