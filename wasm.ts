/** WebAssembly emission, host boundaries, execution, and storage contracts. */

export { compileFunctionalModuleToWasm } from "./src/functional/wasm_artifacts.ts";
export {
  compileFunctionalComponentBoundary,
  functionalWitWorld,
} from "./src/functional/wasm_component_boundary.ts";
export {
  FunctionalPersistentSharing,
  FunctionalStorageCoreError,
  type FunctionalStorageCoreLifetime,
  type FunctionalStorageCoreOperation,
  type FunctionalStorageCoreProgram,
  type FunctionalStorageDiagnostic,
  type FunctionalStorageDiagnosticCode,
  type FunctionalStorageFaultKind,
  type FunctionalStorageVerification,
  requireVerifiedFunctionalStorageCore,
  verifyFunctionalStorageCore,
} from "./src/functional/storage_core.ts";
export {
  type FunctionalBoundaryStorageDecision,
  FunctionalStorageClass,
  type FunctionalStorageDecision,
  type FunctionalStoragePlan,
  type FunctionalStoragePlanningOptions,
  type FunctionalStoragePlanSummary,
  type FunctionalStoredValueKind,
  planFunctionalModuleStorage,
} from "./src/functional/storage_plan.ts";
export type { FunctionalStorageReference } from "./src/functional/storage_reference_analysis.ts";
export {
  type FunctionalStorageAllocationShape,
  type FunctionalStorageReferenceCountStep,
  type FunctionalStorageReuseDecision,
  type FunctionalStorageReusePlan,
  planFunctionalStorageReuse,
} from "./src/functional/storage_reuse_plan.ts";
export {
  type FunctionalWasmAsyncRunOptions,
  type FunctionalWasmExecution,
  type FunctionalWasmRunOptions,
  type FunctionalWasmStats,
  type FunctionalWasmValue,
  runFunctionalWasmModule,
  runFunctionalWasmModuleAsync,
} from "./src/functional/wasm_execution.ts";
export {
  FunctionalWasmBoundaryError,
  FunctionalWasmRuntimeError,
} from "./src/functional/wasm_host_boundary.ts";
export {
  FUNCTIONAL_WASM_VALUE_ABI_VERSION,
  FunctionalWasmValueAbi,
  type FunctionalWasmValueAbiLayout,
} from "./src/functional/wasm_abi.ts";
export {
  beginFunctionalWasmArena,
  type FunctionalWasmArena,
  markFunctionalWasmScratch,
  resetFunctionalWasmScratch,
  withFunctionalWasmArena,
} from "./src/functional/wasm_arena.ts";
export {
  encodeFunctionalWasmArenaValue,
  encodeFunctionalWasmOwnedValue,
  type FunctionalWasmOwnedValue,
  type FunctionalWasmOwnedValueOptions,
  promoteFunctionalWasmArenaValueToOwned,
  promoteFunctionalWasmArenaValueToParent,
} from "./src/functional/wasm_owned_value.ts";
export * from "./src/functional/wasm_contract.ts";
export {
  FUNCTIONAL_ARRAY_TYPE_NAME,
  FUNCTIONAL_BYTES_TYPE_NAME,
  FUNCTIONAL_ERASED_TYPE_NAME,
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  FUNCTIONAL_RESOURCE_TYPE_PREFIX,
  FUNCTIONAL_SLICE_TYPE_NAME,
  FUNCTIONAL_TEXT_TYPE_NAME,
  FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME,
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostDefinitionBinding,
  type FunctionalHostFieldDeclaration,
  type FunctionalHostOperationDeclaration,
  FunctionalHostOwnership,
  type FunctionalHostScalarType,
  type FunctionalHostType,
  FunctionalHostTypes,
  type FunctionalHostValueDeclaration,
  FunctionalWasmIntrinsic,
  type FunctionalWasmLiteral,
} from "./src/functional/host_contract.ts";
export {
  appendFunctionalBitBuffers,
  type FunctionalBitBuffer,
  functionalBitBuffer,
  functionalBitBufferFromHostValue,
  functionalBitBufferHostValue,
  functionalBitBufferStartsWith,
  sliceFunctionalBitBuffer,
} from "./src/functional/bit_buffer.ts";
export { FunctionalOpaqueResourceTable } from "./src/functional/opaque_resource.ts";
export {
  functionalRuntimeTypeDescriptor,
  functionalRuntimeTypeDescriptorKey,
  specializeFunctionalHostOperation,
} from "./src/functional/host_specialization.ts";
