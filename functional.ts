/**
 * Typed semantic compilation and WebAssembly emission for functional-language frontends.
 *
 * Frontends lower their syntax into the portable surface module. The compiler resolves and checks
 * that module on the CPU or GPU, then emits WebAssembly from the resulting Functional Core.
 *
 * This is the only entry point. Everything under `src/` that is not re-exported here is internal,
 * and the frontends in `src/lazuli/`, `src/gleam/`, and `examples/` are deliberately
 * absent — they are samples, not API.
 *
 * @module
 */

// The device, and the ABI both sides of it agree on.
export * from "./src/webgpu.ts";
export * from "./src/functional/abi.ts";
export * from "./src/functional/diagnostics.ts";

// Building a surface module: expressions, types, reachability, and linking separate modules.
export * from "./src/functional/surface_builder.ts";
export * from "./src/functional/surface_contract.ts";
export * from "./src/functional/surface_reachability.ts";
export * from "./src/functional/recursive_groups.ts";
export * from "./src/functional/structural_record.ts";
export {
  createModuleArtifact,
  type LinkDiagnosticCode,
  type LinkedModule,
  type LinkedSource,
  LinkError,
  type LinkErrorDetails,
  type LinkFaultKind,
  linkModules,
  type ModuleArtifact,
  type ModuleConstructorExport,
  type ModuleConstructorImport,
  type ModuleExport,
  type ModuleImport,
  type ModuleTypeExport,
  type ModuleTypeImport,
} from "./src/functional/module_linker.ts";
export * from "./src/functional/module_transfer.ts";

// Compiling it: admission, dispatch, and the resolved Core that comes back.
export * from "./src/functional/compiler.ts";
export * from "./src/compiler_performance_trace.ts";
export * from "./src/functional/compiler_service.ts";
export * from "./src/functional/parallel_compiler_service.ts";
export * from "./src/functional/compilation_admission.ts";
export * from "./src/functional/compiler_module.ts";
export * from "./src/functional/core_artifact.ts";
export { tryRegisterLiteralModuleUpdate } from "./src/functional/incremental_module.ts";
export * from "./src/functional/effect_set.ts";
export * from "./src/semantic/gpu_dispatch_scheduler.ts";
export * from "./src/functional/compilation_trace.ts";

// Host capabilities and the portable Store and SIMD libraries.
export * from "./src/functional/host_contract.ts";
export * from "./src/functional/store_contract.ts";
export * from "./src/functional/fixed_vector.ts";

// Running it as WebAssembly: code generation, the binary, and the host engine.
export * from "./src/functional/wasm_artifacts.ts";
export * from "./src/functional/wasm_batch.ts";
export * from "./src/functional/canonical_abi.ts";
export * from "./src/functional/component_boundary.ts";
export * from "./src/functional/component_reload.ts";
export * from "./src/functional/wasm_contract.ts";
export * from "./src/functional/wasm_execution.ts";
export * from "./src/functional/wasm_arena.ts";
export { type WasmModuleEncoding } from "./src/functional/wasm_binary.ts";
