import type { CompiledModule, CoreNode } from "./compiler_module.ts";
import type { LambdaSetAnalysis } from "./wasm_lambda_sets.ts";

export interface PreparedWasmLambdaAnalysis {
  readonly nodes: readonly CoreNode[];
  readonly lambdaSets: LambdaSetAnalysis;
}

const preparedAnalyses = new WeakMap<CompiledModule, PreparedWasmLambdaAnalysis>();

export function registerPreparedWasmLambdaAnalysis(
  module: CompiledModule,
  preparation: PreparedWasmLambdaAnalysis,
): void {
  if (preparedAnalyses.has(module)) {
    throw new Error("functional module Wasm lambda analysis was registered twice");
  }
  preparedAnalyses.set(module, preparation);
}

export function preparedWasmLambdaAnalysis(
  module: CompiledModule,
): PreparedWasmLambdaAnalysis | undefined {
  return preparedAnalyses.get(module);
}
