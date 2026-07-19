/** Type normalization, evidence search, existentials, constraints, and Type Core execution. */

export * from "./src/functional/capability_contract.ts";
export { TypeCoreCapabilityResolver } from "./src/functional/capability_resolver.ts";
export {
  type FunctionalConstraintCallElaboration,
  type FunctionalConstraintElaboration,
  type FunctionalConstraintElaborationOptions,
  FunctionalConstraintElaborator,
  type FunctionalConstraintGoal,
  functionalRuntimeEvidenceExpression,
} from "./src/functional/constraint_elaboration.ts";
export {
  type FunctionalExistentialType,
  functionalExistentialType,
  packFunctionalExistential,
  unpackFunctionalExistential,
} from "./src/functional/existential.ts";
export * from "./src/functional/type_core_contract.ts";
export { GpuTypeCoreExecutor } from "./src/functional/type_core.ts";
export type * from "./src/functional/type_program_contract.ts";
export {
  functionalSchemaFromTypeCoreType,
  FunctionalTypeNormalizer,
} from "./src/functional/type_program.ts";
