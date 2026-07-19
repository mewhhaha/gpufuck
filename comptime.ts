/** Required compile-time execution, constants, generated IR, and incremental reuse. */

export { GpuFunctionalComptimeExecutor } from "./src/functional/comptime.ts";
export * from "./src/functional/comptime_constant.ts";
export * from "./src/functional/comptime_ir.ts";
export type * from "./src/functional/comptime_contract.ts";
export {
  type FunctionalIncrementalComptimeResult,
  type FunctionalIncrementalComptimeStats,
  IncrementalGpuFunctionalComptimeExecutor,
} from "./src/functional/comptime_incremental.ts";
export { partiallyEvaluateFunctionalModule } from "./src/functional/partial_evaluation.ts";
