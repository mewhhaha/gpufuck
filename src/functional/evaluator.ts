import type { GpuLazuliModule, LazuliCoreNode } from "../semantic/compiler_module.ts";
import {
  GpuLazuliEvaluator,
  type LazuliDeepEvaluationResult,
  type LazuliEvaluationResult,
  type LazuliRuntimeFault,
} from "../semantic/evaluator.ts";
import type { GpuFunctionalModule } from "./compiler_module.ts";
import {
  FunctionalBinaryOperator,
  FunctionalCoreTag,
  FunctionalNumericConversion,
  FunctionalUnaryOperator,
} from "./abi.ts";
import { type FunctionalWasmExecution, runBoundedFunctionalWasmModule } from "./wasm_execution.ts";
import { FunctionalWasmRuntimeError } from "./wasm_host_boundary.ts";
import type { FunctionalWasmValue } from "./wasm_value_codec.ts";

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
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "whole-number-f64"; readonly value: number }
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
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" }
  | { readonly kind: "tuple"; readonly fieldCount: 2 }
  | { readonly kind: "closure" }
  | { readonly kind: "constructor"; readonly name: string; readonly fieldCount: number };

export type FunctionalDeepValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
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
  | FunctionalFault<"cyclic-result", "F3011">
  | FunctionalFault<"invalid-numeric-conversion", "F3012">;

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

const numericRequirementsByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<FunctionalNumericRequirements>
>();

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
    const numerics = await moduleNumericRequirements(module);
    if (numerics.boundedWasm) {
      return await evaluateFunctionalModuleWithBoundedWasm(module, options);
    }
    const result = await this.#evaluator.evaluate(
      lazuliRuntimeModule(module),
      {
        ...options,
        ...(numerics.signedInteger64 && options.resultForm !== "deep"
          ? { resultForm: "deep" as const }
          : {}),
      } as Parameters<GpuLazuliEvaluator["evaluate"]>[1],
    );
    const converted = functionalResult(result);
    return numerics.signedInteger64 && options.resultForm !== "deep" && converted.ok
      ? { ...converted, value: shallowFunctionalValue(converted.value) }
      : converted;
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
    const numericRequirements = await Promise.all(modules.map(moduleNumericRequirements));
    if (
      numericRequirements.some((requirements) =>
        requirements.boundedWasm ||
        (requirements.signedInteger64 && options.resultForm !== "deep")
      )
    ) {
      return await Promise.all(modules.map((module, index) =>
        this.evaluate(module, {
          ...options,
          ...(options.inputs?.[index] === undefined ? {} : { input: options.inputs[index] }),
        } as FunctionalEvaluationOptions)
      ));
    }
    const results = await this.#evaluator.evaluateBatch(
      modules.map(lazuliRuntimeModule),
      options as Parameters<GpuLazuliEvaluator["evaluateBatch"]>[1],
    );
    return results.map(functionalResult);
  }
}

interface FunctionalNumericRequirements {
  readonly signedInteger64: boolean;
  readonly boundedWasm: boolean;
}

async function moduleNumericRequirements(
  module: GpuFunctionalModule,
): Promise<FunctionalNumericRequirements> {
  const cached = numericRequirementsByModule.get(module);
  if (cached !== undefined) return await cached;
  const inspection = inspectModuleNumericRequirements(module);
  numericRequirementsByModule.set(module, inspection);
  try {
    return await inspection;
  } catch (error) {
    if (numericRequirementsByModule.get(module) === inspection) {
      numericRequirementsByModule.delete(module);
    }
    throw error;
  }
}

async function inspectModuleNumericRequirements(
  module: GpuFunctionalModule,
): Promise<FunctionalNumericRequirements> {
  const nodes = await module.readCoreNodes();
  let signedInteger64 = false;
  let boundedWasm = false;
  for (const node of nodes) {
    if (node.tag === FunctionalCoreTag.SignedInteger64) signedInteger64 = true;
    if (
      node.tag === FunctionalCoreTag.Float64 ||
      node.tag === FunctionalCoreTag.WholeNumberF64
    ) boundedWasm = true;
    if (
      node.tag === FunctionalCoreTag.Text || node.tag === FunctionalCoreTag.Bytes ||
      node.tag === FunctionalCoreTag.RuntimeFault || node.tag === FunctionalCoreTag.BufferAppend
    ) {
      boundedWasm = true;
    }
    if (node.tag === FunctionalCoreTag.Unary) {
      if (node.payload === FunctionalUnaryOperator.NegateSignedInteger64) signedInteger64 = true;
      if (
        node.payload === FunctionalUnaryOperator.NegateFloat64 ||
        node.payload === FunctionalUnaryOperator.NegateWholeNumberF64 ||
        node.payload === FunctionalUnaryOperator.SquareRootFloat32
      ) boundedWasm = true;
    }
    if (node.tag === FunctionalCoreTag.Binary) {
      if (
        node.payload === FunctionalBinaryOperator.StructuralEqual ||
        node.payload === FunctionalBinaryOperator.StructuralNotEqual
      ) boundedWasm = true;
      if (
        (node.payload >= FunctionalBinaryOperator.EqualSignedInteger64 &&
          node.payload <= FunctionalBinaryOperator.DivideSignedInteger64) ||
        node.payload >= FunctionalBinaryOperator.RemainderSignedInteger64
      ) signedInteger64 = true;
      if (
        node.payload >= FunctionalBinaryOperator.EqualFloat64 &&
        node.payload <= FunctionalBinaryOperator.DivideFloat64
      ) boundedWasm = true;
      if (
        node.payload >= FunctionalBinaryOperator.EqualWholeNumberF64 &&
        node.payload <= FunctionalBinaryOperator.RemainderWholeNumberF64
      ) boundedWasm = true;
      if (node.payload === FunctionalBinaryOperator.DivideFloat32) boundedWasm = true;
    }
    if (node.tag === FunctionalCoreTag.NumericConvert) {
      if (
        node.payload === FunctionalNumericConversion.SignedInteger32ToSignedInteger64 ||
        node.payload === FunctionalNumericConversion.SignedInteger64ToSignedInteger32 ||
        node.payload === FunctionalNumericConversion.SignedInteger64ToFloat32 ||
        node.payload === FunctionalNumericConversion.Float32ToSignedInteger64
      ) signedInteger64 = true;
      if (
        node.payload === FunctionalNumericConversion.SignedInteger32ToFloat64 ||
        node.payload === FunctionalNumericConversion.SignedInteger64ToFloat64 ||
        node.payload === FunctionalNumericConversion.Float32ToFloat64 ||
        node.payload === FunctionalNumericConversion.Float64ToSignedInteger32 ||
        node.payload === FunctionalNumericConversion.Float64ToSignedInteger64 ||
        node.payload === FunctionalNumericConversion.Float64ToFloat32
      ) boundedWasm = true;
    }
  }
  return { signedInteger64, boundedWasm };
}

function shallowFunctionalValue(
  value: FunctionalValue | FunctionalDeepValue,
): FunctionalValue {
  switch (value.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
    case "closure":
      return value;
    case "tuple":
      return { kind: "tuple", fieldCount: 2 };
    case "constructor":
      return { kind: "constructor", name: value.name, fieldCount: value.fieldCount };
  }
}

export function evaluateFunctionalModuleWithBoundedWasm(
  module: GpuFunctionalModule,
  options: FunctionalDeepEvaluationOptions,
): Promise<FunctionalDeepEvaluationResult>;
export function evaluateFunctionalModuleWithBoundedWasm(
  module: GpuFunctionalModule,
  options: FunctionalEvaluationOptions,
): Promise<FunctionalEvaluationResult>;
export async function evaluateFunctionalModuleWithBoundedWasm(
  module: GpuFunctionalModule,
  options: FunctionalEvaluationOptions,
): Promise<AnyFunctionalEvaluationResult> {
  options.signal?.throwIfAborted();
  if (
    options.maximumStepsPerDispatch !== undefined || options.heapSlots !== undefined ||
    options.stackFrames !== undefined
  ) {
    throw new TypeError(
      "bounded WebAssembly evaluation does not accept GPU dispatch, heap, or stack controls",
    );
  }
  if (module.hostCapabilities.length !== 0) {
    throw new TypeError(
      "bounded IEEE evaluation with host capabilities requires a WASM runner init",
    );
  }
  const maximumSteps = options.maximumSteps ?? 1_000_000;
  let execution;
  try {
    execution = await runBoundedFunctionalWasmModule(module, maximumSteps, {
      ...(options.input === undefined ? {} : { argument: wasmInputValue(options.input) }),
      ...(options.maximumResultNodes === undefined
        ? {}
        : { maximumResultNodes: options.maximumResultNodes }),
    });
  } catch (cause) {
    if (!(cause instanceof FunctionalWasmRuntimeError)) throw cause;
    const fault = functionalFaultFromBoundedWasm(cause, maximumSteps);
    if (fault === undefined) throw cause;
    return {
      ok: false,
      fault,
      stats: {
        steps: cause.code === "F3002" ? maximumSteps : 0,
        allocations: 0,
        peakStack: 0,
        thunkEvaluations: 0,
      },
    };
  }
  options.signal?.throwIfAborted();
  return {
    ok: true,
    value: functionalValueFromWasm(execution, options.resultForm === "deep"),
    stats: {
      steps: execution.semanticSteps,
      allocations: Math.ceil(execution.stats.allocatedBytes / 8),
      peakStack: 0,
      thunkEvaluations: execution.stats.thunkEvaluations,
    },
  };
}

function wasmInputValue(value: FunctionalInputValue): FunctionalWasmValue {
  switch (value.kind) {
    case "whole-number-f64":
      return { kind: "integer", value: value.value };
    case "tuple":
      return {
        kind: "tuple",
        values: [wasmInputValue(value.values[0]), wasmInputValue(value.values[1])],
      };
    case "constructor":
      return {
        kind: "constructor",
        name: value.name,
        fields: value.fields.map(wasmInputValue),
      };
    default:
      return value;
  }
}

function functionalFaultFromBoundedWasm(
  error: FunctionalWasmRuntimeError,
  maximumSteps: number,
): FunctionalRuntimeFault | undefined {
  const sourceByteOffset = error.span?.startByte ?? null;
  if (error.code === "F3002") {
    return {
      kind: "out-of-fuel",
      code: "F3002",
      message: `evaluation exhausted its limit of ${maximumSteps} steps`,
      sourceByteOffset,
    };
  }
  if (error.code === "F3003") {
    return { kind: "out-of-heap", code: "F3003", message: error.message, sourceByteOffset };
  }
  if (error.code === "F3005") {
    return { kind: "blackhole", code: "F3005", message: error.message, sourceByteOffset };
  }
  if (error.code === "F3007") {
    return { kind: "divide-by-zero", code: "F3007", message: error.message, sourceByteOffset };
  }
  if (error.code === "F3010") {
    return { kind: "result-too-large", code: "F3010", message: error.message, sourceByteOffset };
  }
  if (error.code === "F3011") {
    return { kind: "cyclic-result", code: "F3011", message: error.message, sourceByteOffset };
  }
  if (error.code === "F3012") {
    return {
      kind: "invalid-numeric-conversion",
      code: "F3012",
      message: error.message,
      sourceByteOffset,
    };
  }
  return undefined;
}

function functionalValueFromWasm(
  execution: FunctionalWasmExecution,
  deep: boolean,
): FunctionalValue | FunctionalDeepValue {
  const convert = (value: FunctionalWasmValue): FunctionalValue | FunctionalDeepValue => {
    switch (value.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return value;
      case "tuple":
        if (!deep) return { kind: "tuple", fieldCount: 2 };
        return {
          kind: "tuple",
          fieldCount: 2,
          fields: value.values.map((field) => convert(field) as FunctionalDeepValue),
        };
      case "constructor":
        if (!deep) {
          return { kind: "constructor", name: value.name, fieldCount: value.fields.length };
        }
        return {
          kind: "constructor",
          name: value.name,
          fieldCount: value.fields.length,
          fields: value.fields.map((field) => convert(field) as FunctionalDeepValue),
        };
      case "text":
      case "bytes":
      case "array":
      case "slice":
      case "resource":
      case "erased":
        throw new TypeError(`functional evaluator cannot expose ${value.kind} boundary values`);
    }
  };
  return convert(execution.value);
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
