/**
 * GPU-backed semantic compilation for functional-language frontends.
 *
 * Frontends lower their syntax into the portable surface module and compile it through WebGPU to a
 * resolved Functional Core. Core programs are executed by the GPU evaluator.
 *
 * @module
 */

export * from "./src/functional/abi.ts";
export * from "./src/functional/compilation_admission.ts";
export * from "./src/functional/compilation_trace.ts";
export * from "./src/functional/compiler.ts";
export * from "./src/functional/compiler_module.ts";
export * from "./src/functional/core_artifact.ts";
export * from "./src/functional/diagnostics.ts";
export * from "./src/functional/evaluator.ts";
export * from "./src/semantic/gpu_dispatch_scheduler.ts";
export * from "./src/functional/host_contract.ts";
export * from "./src/functional/recursive_groups.ts";
export * from "./src/functional/store_contract.ts";
export * from "./src/functional/surface_builder.ts";
export * from "./src/functional/surface_contract.ts";
export * from "./src/functional/surface_reachability.ts";
export * from "./src/webgpu.ts";
export * from "./src/functional/module_linker.ts";
export * from "./src/functional/storage_contract.ts";
export * from "./src/functional/storage_plan.ts";
export * from "./src/functional/wasm_arena.ts";
export * from "./src/functional/wasm_artifacts.ts";
export * from "./src/functional/wasm_contract.ts";
export * from "./src/functional/wasm_execution.ts";
export * from "./src/functional/comptime.ts";
export * from "./src/functional/comptime_contract.ts";
export * from "./src/functional/capability_contract.ts";
export * from "./src/functional/capability_resolver.ts";
export * from "./src/functional/fixed_vector.ts";
export * from "./src/functional/type_core.ts";
export * from "./src/functional/type_core_contract.ts";
