import type { CoreNode, GpuSemanticModule } from "../semantic/compiler_module.ts";
import {
  GpuSemanticEvaluator,
  type SemanticDeepEvaluationResult,
  type SemanticEvaluationResult,
  type SemanticRuntimeFault,
} from "../semantic/evaluator.ts";
import type { CompiledModule, GpuModule } from "./compiler_module.ts";
import { BinaryOperator, CoreTag, NumericConversion, type Type, UnaryOperator } from "./abi.ts";
import { primopDeclaration, PrimopFamily } from "../semantic/primops.ts";
import { runBoundedWasmModule, type WasmExecution } from "./wasm_execution.ts";
import { WasmRuntimeError } from "./wasm_host_boundary.ts";
import type { WasmValue } from "./wasm_value_codec.ts";
import type { WasmInit } from "./wasm_contract.ts";

export interface EvaluationOptions {
  readonly maximumSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly heapSlots?: number;
  readonly stackFrames?: number;
  readonly signal?: AbortSignal;
  readonly input?: InputValue;
  readonly resultForm?: "weak-head" | "deep";
  readonly maximumResultNodes?: number;
  readonly maximumResultBytes?: number;
  /** Host implementations used when evaluation selects the bounded-Wasm path. */
  readonly wasmInit?: WasmInit;
}

export interface DeepEvaluationOptions extends EvaluationOptions {
  readonly resultForm: "deep";
}

export interface BatchEvaluationOptions extends Omit<EvaluationOptions, "input"> {
  readonly inputs?: readonly (InputValue | undefined)[];
}

export interface DeepBatchEvaluationOptions extends BatchEvaluationOptions {
  readonly resultForm: "deep";
}

export type InputValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unit" }
  | {
    readonly kind: "tuple";
    readonly values: readonly [InputValue, InputValue];
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fields: readonly InputValue[];
  };

export type Value =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "unit" }
  | { readonly kind: "tuple"; readonly fieldCount: 2 }
  | { readonly kind: "closure" }
  | { readonly kind: "constructor"; readonly name: string; readonly fieldCount: number };

export type DeepValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "signed-integer-64"; readonly value: bigint }
  | { readonly kind: "float-32"; readonly value: number }
  | { readonly kind: "float-64"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "closure" }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: Uint8Array }
  | { readonly kind: "unit" }
  | { readonly kind: "array"; readonly values: readonly DeepValue[] }
  | { readonly kind: "slice"; readonly values: readonly DeepValue[] }
  | { readonly kind: "resource"; readonly id: number }
  | {
    readonly kind: "erased";
    readonly type: Type;
    readonly value: DeepValue;
  }
  | {
    readonly kind: "tuple";
    readonly fieldCount: 2;
    readonly fields: readonly DeepValue[];
  }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fieldCount: number;
    readonly fields: readonly DeepValue[];
  };

export interface EvaluationStats {
  readonly steps: number;
  readonly allocations: number;
  readonly peakStack: number;
  readonly thunkEvaluations: number;
}

interface Fault<Kind extends string, Code extends string> {
  readonly kind: Kind;
  readonly code: Code;
  readonly message: string;
  readonly sourceByteOffset: number | null;
}

export type RuntimeFault =
  | Fault<"bad-module", "F3001">
  | Fault<"out-of-fuel", "F3002">
  | Fault<"out-of-heap", "F3003">
  | Fault<"stack-overflow", "F3004">
  | Fault<"blackhole", "F3005">
  | Fault<"type-error", "F3006">
  | Fault<"divide-by-zero", "F3007">
  | Fault<"non-exhaustive-case", "F3008">
  | (Fault<"bad-input", "F3009"> & { readonly fieldPath: readonly number[] })
  | Fault<"result-too-large", "F3010">
  | Fault<"cyclic-result", "F3011">
  | Fault<"invalid-numeric-conversion", "F3012">;

export type EvaluationResult =
  | {
    readonly ok: true;
    readonly value: Value;
    readonly stats: EvaluationStats;
  }
  | {
    readonly ok: false;
    readonly fault: RuntimeFault;
    readonly stats: EvaluationStats;
  };

export type DeepEvaluationResult =
  | {
    readonly ok: true;
    readonly value: DeepValue;
    readonly stats: EvaluationStats;
  }
  | {
    readonly ok: false;
    readonly fault: RuntimeFault;
    readonly stats: EvaluationStats;
  };

type AnyEvaluationResult =
  | EvaluationResult
  | DeepEvaluationResult;

const numericRequirementsByModule = new WeakMap<
  GpuModule,
  Promise<NumericRequirements>
>();

export class GpuEvaluator {
  readonly #evaluator: GpuSemanticEvaluator;

  private constructor(evaluator: GpuSemanticEvaluator) {
    this.#evaluator = evaluator;
  }

  static async create(device: GPUDevice): Promise<GpuEvaluator> {
    return new GpuEvaluator(
      await GpuSemanticEvaluator.createBackend(device),
    );
  }

  async evaluate(
    module: GpuModule,
    options: DeepEvaluationOptions,
  ): Promise<DeepEvaluationResult>;
  async evaluate(
    module: GpuModule,
    options?: EvaluationOptions,
  ): Promise<EvaluationResult>;
  async evaluate(
    module: GpuModule,
    options: EvaluationOptions = {},
  ): Promise<AnyEvaluationResult> {
    const numerics = await moduleNumericRequirements(module);
    if (numerics.boundedWasm) {
      // Which path a module takes is a property of its Core, not of the caller, so a caller cannot
      // know in advance whether the GPU-only controls apply. Drop them here rather than failing on
      // a choice this method made. Calling `evaluateModuleWithBoundedWasm` directly still rejects
      // them, because that caller picked the path.
      const {
        maximumStepsPerDispatch: _dispatch,
        heapSlots: _heap,
        stackFrames: _stack,
        ...rest
      } = options;
      return await evaluateModuleWithBoundedWasm(module, rest);
    }
    const { wasmInit: _wasmInit, ...semanticOptions } = options;
    const result = await this.#evaluator.evaluate(
      semanticRuntimeModule(module),
      {
        ...semanticOptions,
        ...(numerics.signedInteger64 && options.resultForm !== "deep"
          ? { resultForm: "deep" as const }
          : {}),
      } as Parameters<GpuSemanticEvaluator["evaluate"]>[1],
    );
    const converted = functionalResult(result);
    return numerics.signedInteger64 && options.resultForm !== "deep" && converted.ok
      ? { ...converted, value: shallowValue(converted.value) }
      : converted;
  }

  async evaluateBatch(
    modules: readonly GpuModule[],
    options: DeepBatchEvaluationOptions,
  ): Promise<readonly DeepEvaluationResult[]>;
  async evaluateBatch(
    modules: readonly GpuModule[],
    options?: BatchEvaluationOptions,
  ): Promise<readonly EvaluationResult[]>;
  async evaluateBatch(
    modules: readonly GpuModule[],
    options: BatchEvaluationOptions = {},
  ): Promise<readonly AnyEvaluationResult[]> {
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
        } as EvaluationOptions)
      ));
    }
    const { wasmInit: _wasmInit, ...semanticOptions } = options;
    const results = await this.#evaluator.evaluateBatch(
      modules.map(semanticRuntimeModule),
      semanticOptions as Parameters<GpuSemanticEvaluator["evaluateBatch"]>[1],
    );
    return results.map(functionalResult);
  }
}

interface NumericRequirements {
  readonly signedInteger64: boolean;
  readonly boundedWasm: boolean;
}

async function moduleNumericRequirements(
  module: GpuModule,
): Promise<NumericRequirements> {
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
  module: GpuModule,
): Promise<NumericRequirements> {
  const nodes = await module.readCoreNodes();
  let signedInteger64 = false;
  let boundedWasm = false;
  for (const node of nodes) {
    if (node.tag === CoreTag.SignedInteger64) signedInteger64 = true;
    if (node.tag === CoreTag.Float64) boundedWasm = true;
    if (
      node.tag === CoreTag.Text || node.tag === CoreTag.Bytes ||
      node.tag === CoreTag.RuntimeFault || node.tag === CoreTag.BufferAppend ||
      node.tag === CoreTag.StoreEmpty || node.tag === CoreTag.StoreNew ||
      node.tag === CoreTag.StoreLength ||
      node.tag === CoreTag.StoreRead || node.tag === CoreTag.StoreWrite ||
      node.tag === CoreTag.StoreGrow
    ) {
      boundedWasm = true;
    }
    if (node.tag === CoreTag.Unary) {
      if (node.payload === UnaryOperator.NegateSignedInteger64) signedInteger64 = true;
      if (
        node.payload === UnaryOperator.NegateFloat64 ||
        node.payload === UnaryOperator.SquareRootFloat32
      ) boundedWasm = true;
    }
    if (node.tag === CoreTag.Binary) {
      if (
        node.payload === BinaryOperator.StructuralEqual ||
        node.payload === BinaryOperator.StructuralNotEqual
      ) boundedWasm = true;
      if (
        (node.payload >= BinaryOperator.EqualSignedInteger64 &&
          node.payload <= BinaryOperator.DivideSignedInteger64) ||
        node.payload >= BinaryOperator.RemainderSignedInteger64
      ) signedInteger64 = true;
      if (
        node.payload >= BinaryOperator.EqualFloat64 &&
          node.payload <= BinaryOperator.DivideFloat64 ||
        node.payload === BinaryOperator.RemainderFloat64
      ) boundedWasm = true;
      if (node.payload === BinaryOperator.DivideFloat32) boundedWasm = true;
    }
    if (node.tag === CoreTag.NumericConvert) {
      if (
        node.payload === NumericConversion.SignedInteger32ToSignedInteger64 ||
        node.payload === NumericConversion.SignedInteger64ToSignedInteger32 ||
        node.payload === NumericConversion.SignedInteger64ToFloat32 ||
        node.payload === NumericConversion.Float32ToSignedInteger64
      ) signedInteger64 = true;
      if (
        node.payload === NumericConversion.SignedInteger32ToFloat64 ||
        node.payload === NumericConversion.SignedInteger64ToFloat64 ||
        node.payload === NumericConversion.Float32ToFloat64 ||
        node.payload === NumericConversion.Float64ToSignedInteger32 ||
        node.payload === NumericConversion.Float64ToSignedInteger64 ||
        node.payload === NumericConversion.Float64ToFloat32
      ) boundedWasm = true;
    }
    if (node.tag === CoreTag.Prim) {
      const declaration = primopDeclaration(node.payload);
      if (declaration === undefined || !declaration.backends.gpu) boundedWasm = true;
      const operation = declaration?.operation;
      if (declaration?.family === PrimopFamily.Unary) {
        if (operation === UnaryOperator.NegateSignedInteger64) signedInteger64 = true;
      }
      if (declaration?.family === PrimopFamily.Binary) {
        if (
          operation !== undefined &&
          ((operation >= BinaryOperator.EqualSignedInteger64 &&
            operation <= BinaryOperator.DivideSignedInteger64) ||
            operation >= BinaryOperator.RemainderSignedInteger64)
        ) signedInteger64 = true;
      }
      if (declaration?.family === PrimopFamily.NumericConversion) {
        if (
          operation === NumericConversion.SignedInteger32ToSignedInteger64 ||
          operation === NumericConversion.SignedInteger64ToSignedInteger32 ||
          operation === NumericConversion.SignedInteger64ToFloat32 ||
          operation === NumericConversion.Float32ToSignedInteger64
        ) signedInteger64 = true;
      }
    }
  }
  return { signedInteger64, boundedWasm };
}

function shallowValue(
  value: Value | DeepValue,
): Value {
  switch (value.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "text":
    case "unit":
    case "closure":
      return value;
    case "tuple":
      return { kind: "tuple", fieldCount: 2 };
    case "constructor":
      return { kind: "constructor", name: value.name, fieldCount: value.fieldCount };
    case "bytes":
    case "array":
    case "slice":
    case "resource":
    case "erased":
      throw new TypeError(
        `functional evaluator cannot expose a shallow ${value.kind} boundary value`,
      );
  }
}

export function evaluateModuleWithBoundedWasm(
  module: CompiledModule,
  options: DeepEvaluationOptions,
): Promise<DeepEvaluationResult>;
export function evaluateModuleWithBoundedWasm(
  module: CompiledModule,
  options: EvaluationOptions,
): Promise<EvaluationResult>;
export async function evaluateModuleWithBoundedWasm(
  module: CompiledModule,
  options: EvaluationOptions,
): Promise<AnyEvaluationResult> {
  options.signal?.throwIfAborted();
  if (
    options.maximumStepsPerDispatch !== undefined || options.heapSlots !== undefined ||
    options.stackFrames !== undefined
  ) {
    throw new TypeError(
      "bounded WebAssembly evaluation does not accept GPU dispatch, heap, or stack controls",
    );
  }
  if (module.hostCapabilities.length !== 0 && options.wasmInit === undefined) {
    throw new TypeError(
      "bounded WebAssembly evaluation with host capabilities requires a WASM runner init",
    );
  }
  const maximumSteps = options.maximumSteps ?? 1_000_000;
  let execution;
  try {
    execution = await runBoundedWasmModule(module, maximumSteps, {
      ...(options.wasmInit === undefined ? {} : { init: options.wasmInit }),
      ...(options.input === undefined ? {} : { argument: wasmInputValue(options.input) }),
      ...(options.maximumResultNodes === undefined
        ? {}
        : { maximumResultNodes: options.maximumResultNodes }),
      ...(options.maximumResultBytes === undefined
        ? {}
        : { maximumResultBytes: options.maximumResultBytes }),
    });
  } catch (cause) {
    if (!(cause instanceof WasmRuntimeError)) throw cause;
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
  const stats = {
    steps: execution.semanticSteps,
    allocations: Math.ceil(execution.stats.allocatedBytes / 8),
    peakStack: 0,
    thunkEvaluations: execution.stats.thunkEvaluations,
  };
  const value = functionalValueFromWasm(
    execution,
    options.resultForm === "deep",
  );
  if (options.resultForm === "deep") {
    return { ok: true, value: value as DeepValue, stats };
  }
  return {
    ok: true,
    value: value as Value,
    stats,
  };
}

function wasmInputValue(value: InputValue): WasmValue {
  switch (value.kind) {
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
  error: WasmRuntimeError,
  maximumSteps: number,
): RuntimeFault | undefined {
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
  execution: WasmExecution,
  deep: boolean,
): Value | DeepValue {
  const convert = (value: WasmValue): Value | DeepValue => {
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
          fields: value.values.map((field) => convert(field) as DeepValue),
        };
      case "constructor":
        if (!deep) {
          return { kind: "constructor", name: value.name, fieldCount: value.fields.length };
        }
        return {
          kind: "constructor",
          name: value.name,
          fieldCount: value.fields.length,
          fields: value.fields.map((field) => convert(field) as DeepValue),
        };
      case "text":
        return value;
      case "bytes":
      case "resource":
        if (!deep) {
          throw new TypeError(
            `functional evaluator cannot expose a shallow ${value.kind} boundary value`,
          );
        }
        return value;
      case "array":
      case "slice":
        if (!deep) {
          throw new TypeError(
            `functional evaluator cannot expose a shallow ${value.kind} boundary value`,
          );
        }
        return {
          kind: value.kind,
          values: value.values.map((element) => convert(element) as DeepValue),
        };
      case "erased":
        if (!deep) {
          throw new TypeError(
            "functional evaluator cannot expose a shallow erased boundary value",
          );
        }
        return {
          kind: "erased",
          type: value.type,
          value: convert(value.value) as DeepValue,
        };
    }
  };
  return convert(execution.value);
}

function semanticRuntimeModule(module: GpuModule): GpuSemanticModule {
  return {
    nodeBuffer: module.nodeBuffer,
    definitionBuffer: module.definitionBuffer,
    constructorBuffer: module.constructorBuffer,
    nodeCount: module.nodeCount,
    definitionCount: module.definitionCount,
    constructorCount: module.constructorCount,
    typeCount: module.typeCount,
    parameterCount: module.parameterCount,
    arguments: module.arguments,
    caseAlternatives: module.caseAlternatives,
    caseBinderCount: module.caseBinderCount,
    constructorNames: module.constructorNames,
    constructorArities: module.constructorArities,
    entryDefinition: module.entryDefinition,
    mainType: module.entryType,
    typeDeclarations: module.typeDeclarations,
    readCoreNodes: async () => await module.readCoreNodes() as readonly CoreNode[],
    destroy: () => module.destroy(),
  };
}

function functionalResult(
  result: SemanticEvaluationResult | SemanticDeepEvaluationResult,
): AnyEvaluationResult {
  if (result.ok) return result as AnyEvaluationResult;
  return {
    ok: false,
    fault: functionalFault(result.fault),
    stats: result.stats,
  };
}

/** The two fault types differ only in what a caller is allowed to see, not in their codes. */
function functionalFault(fault: SemanticRuntimeFault): RuntimeFault {
  return fault as RuntimeFault;
}
