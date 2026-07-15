import type { GpuLazuliModule, LazuliCoreNode } from "../lazuli/compiler_module.ts";
import {
  GpuLazuliEvaluator,
  type LazuliDeepEvaluationResult,
  type LazuliEvaluationResult,
  type LazuliRuntimeFault,
} from "../lazuli/evaluator.ts";
import type { GpuFunctionalModule } from "./compiler_module.ts";

export interface FunctionalEvaluationOptions {
  readonly maximumSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly heapSlots?: number;
  readonly stackFrames?: number;
  readonly signal?: AbortSignal;
  readonly input?: FunctionalInputValue;
  readonly resultForm?: "weak-head" | "deep";
  readonly maximumResultNodes?: number;
}

export interface FunctionalDeepEvaluationOptions extends FunctionalEvaluationOptions {
  readonly resultForm: "deep";
}

export interface FunctionalBatchEvaluationOptions
  extends Omit<FunctionalEvaluationOptions, "input"> {
  readonly inputs?: readonly (FunctionalInputValue | undefined)[];
}

export interface FunctionalDeepBatchEvaluationOptions extends FunctionalBatchEvaluationOptions {
  readonly resultForm: "deep";
}

export type FunctionalInputValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" }
  | {
    readonly kind: "tuple";
    readonly values: readonly [FunctionalInputValue, FunctionalInputValue];
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fields: readonly FunctionalInputValue[];
  };

export type FunctionalValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" }
  | { readonly kind: "tuple"; readonly fieldCount: 2 }
  | { readonly kind: "closure" }
  | { readonly kind: "constructor"; readonly name: string; readonly fieldCount: number };

export type FunctionalDeepValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "closure" }
  | { readonly kind: "unit" }
  | {
    readonly kind: "tuple";
    readonly fieldCount: 2;
    readonly fields: readonly FunctionalDeepValue[];
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fieldCount: number;
    readonly fields: readonly FunctionalDeepValue[];
  };

export interface FunctionalEvaluationStats {
  readonly steps: number;
  readonly allocations: number;
  readonly peakStack: number;
  readonly thunkEvaluations: number;
}

interface FunctionalFault<Kind extends string, Code extends string> {
  readonly kind: Kind;
  readonly code: Code;
  readonly message: string;
  readonly sourceByteOffset: number | null;
}

export type FunctionalRuntimeFault =
  | FunctionalFault<"bad-module", "F3001">
  | FunctionalFault<"out-of-fuel", "F3002">
  | FunctionalFault<"out-of-heap", "F3003">
  | FunctionalFault<"stack-overflow", "F3004">
  | FunctionalFault<"blackhole", "F3005">
  | FunctionalFault<"type-error", "F3006">
  | FunctionalFault<"divide-by-zero", "F3007">
  | FunctionalFault<"non-exhaustive-case", "F3008">
  | (FunctionalFault<"bad-input", "F3009"> & { readonly fieldPath: readonly number[] })
  | FunctionalFault<"result-too-large", "F3010">
  | FunctionalFault<"cyclic-result", "F3011">;

export type FunctionalEvaluationResult =
  | {
    readonly ok: true;
    readonly value: FunctionalValue;
    readonly stats: FunctionalEvaluationStats;
  }
  | {
    readonly ok: false;
    readonly fault: FunctionalRuntimeFault;
    readonly stats: FunctionalEvaluationStats;
  };

export type FunctionalDeepEvaluationResult =
  | {
    readonly ok: true;
    readonly value: FunctionalDeepValue;
    readonly stats: FunctionalEvaluationStats;
  }
  | {
    readonly ok: false;
    readonly fault: FunctionalRuntimeFault;
    readonly stats: FunctionalEvaluationStats;
  };

type AnyFunctionalEvaluationResult =
  | FunctionalEvaluationResult
  | FunctionalDeepEvaluationResult;

export class GpuFunctionalEvaluator {
  readonly #evaluator: GpuLazuliEvaluator;

  private constructor(evaluator: GpuLazuliEvaluator) {
    this.#evaluator = evaluator;
  }

  static async create(device: GPUDevice): Promise<GpuFunctionalEvaluator> {
    return new GpuFunctionalEvaluator(
      await GpuLazuliEvaluator.createFunctionalBackend(device),
    );
  }

  async evaluate(
    module: GpuFunctionalModule,
    options: FunctionalDeepEvaluationOptions,
  ): Promise<FunctionalDeepEvaluationResult>;
  async evaluate(
    module: GpuFunctionalModule,
    options?: FunctionalEvaluationOptions,
  ): Promise<FunctionalEvaluationResult>;
  async evaluate(
    module: GpuFunctionalModule,
    options: FunctionalEvaluationOptions = {},
  ): Promise<AnyFunctionalEvaluationResult> {
    const result = await this.#evaluator.evaluate(
      lazuliRuntimeModule(module),
      options as Parameters<GpuLazuliEvaluator["evaluate"]>[1],
    );
    return functionalResult(result);
  }

  async evaluateBatch(
    modules: readonly GpuFunctionalModule[],
    options: FunctionalDeepBatchEvaluationOptions,
  ): Promise<readonly FunctionalDeepEvaluationResult[]>;
  async evaluateBatch(
    modules: readonly GpuFunctionalModule[],
    options?: FunctionalBatchEvaluationOptions,
  ): Promise<readonly FunctionalEvaluationResult[]>;
  async evaluateBatch(
    modules: readonly GpuFunctionalModule[],
    options: FunctionalBatchEvaluationOptions = {},
  ): Promise<readonly AnyFunctionalEvaluationResult[]> {
    const results = await this.#evaluator.evaluateBatch(
      modules.map(lazuliRuntimeModule),
      options as Parameters<GpuLazuliEvaluator["evaluateBatch"]>[1],
    );
    return results.map(functionalResult);
  }
}

function lazuliRuntimeModule(module: GpuFunctionalModule): GpuLazuliModule {
  return {
    nodeBuffer: module.nodeBuffer,
    definitionBuffer: module.definitionBuffer,
    constructorBuffer: module.constructorBuffer,
    nodeCount: module.nodeCount,
    definitionCount: module.definitionCount,
    constructorCount: module.constructorCount,
    typeCount: module.typeCount,
    constructorNames: module.constructorNames,
    constructorArities: module.constructorArities,
    entryDefinition: module.entryDefinition,
    mainType: module.entryType,
    typeDeclarations: module.typeDeclarations,
    readCoreNodes: async () => await module.readCoreNodes() as readonly LazuliCoreNode[],
    destroy: () => module.destroy(),
  };
}

function functionalResult(
  result: LazuliEvaluationResult | LazuliDeepEvaluationResult,
): AnyFunctionalEvaluationResult {
  if (result.ok) return result as AnyFunctionalEvaluationResult;
  return {
    ok: false,
    fault: functionalFault(result.fault),
    stats: result.stats,
  };
}

function functionalFault(fault: LazuliRuntimeFault): FunctionalRuntimeFault {
  return {
    ...fault,
    code: `F${fault.code.slice(1)}`,
    message: fault.message.replaceAll("Lazuli", "functional"),
  } as FunctionalRuntimeFault;
}
