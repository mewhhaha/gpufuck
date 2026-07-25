import { CoreTag, EvaluationMode, EvaluationProfile } from "./abi.ts";
import type { CoreNode, GpuModule } from "./compiler_module.ts";
import {
  functionalHostScalarType,
  functionalWasmEntry,
  type WasmEntry,
} from "./wasm_host_boundary.ts";
import { WasmCaptureAnalysis } from "./wasm_capture_analysis.ts";
import type { WasmCompilationOptions } from "./wasm_contract.ts";
import { WasmConstantAnalysis } from "./wasm_constant_analysis.ts";
import { WasmFunctionAnalysis } from "./wasm_function_analysis.ts";
import type { StoragePlan } from "./storage_contract.ts";
import { createStoragePlan } from "./storage_plan.ts";
import { requireFirstOrderFunctionalWasmType } from "./wasm_value_codec.ts";
import { WasmUniqueReuseAnalysis } from "./wasm_unique_reuse_analysis.ts";

export interface WasmBackendPlan {
  readonly module: GpuModule;
  readonly nodes: readonly CoreNode[];
  readonly captureAnalysis: WasmCaptureAnalysis;
  readonly constantAnalysis: WasmConstantAnalysis;
  readonly functionAnalysis: WasmFunctionAnalysis;
  readonly uniqueReuseAnalysis: WasmUniqueReuseAnalysis;
  readonly storage: StoragePlan;
  readonly entry: WasmEntry;
  readonly compactScalarEligible: boolean;
  readonly instrumentedFuel: boolean;
  readonly options: WasmCompilationOptions;
}

export function createWasmBackendPlan(
  module: GpuModule,
  nodes: readonly CoreNode[],
  instrumentedFuel: boolean,
  options: WasmCompilationOptions,
): WasmBackendPlan {
  validateFunctionalWasmSimdMode(options.simd);
  const captureAnalysis = new WasmCaptureAnalysis(nodes);
  const constantAnalysis = new WasmConstantAnalysis(nodes);
  const storage = createStoragePlan(module, nodes, captureAnalysis, {
    ...(options.storageCore === undefined ? {} : { storageCore: options.storageCore }),
  });
  const entry = functionalWasmEntry(module);
  validateOwnedTypeExports(module, nodes, options);
  const scalarResult = functionalHostScalarType(entry.result);
  const compactScalarEligible = module.evaluationProfile ===
      EvaluationProfile.StrictEager &&
    !nodes.some((node) =>
      node.tag === CoreTag.StoreNew ||
      node.tag === CoreTag.StoreLength ||
      node.tag === CoreTag.StoreRead ||
      node.tag === CoreTag.StoreWrite ||
      node.tag === CoreTag.StoreGrow
    ) &&
    module.entryEffects.length === 0 &&
    module.hostCapabilities.every((capability) => capability.fields.length === 0) &&
    !entry.takesInit &&
    entry.parameter === undefined &&
    scalarResult !== undefined &&
    scalarResult.kind !== "unit" &&
    options.storageCore === undefined &&
    (options.ownedTypeExports?.length ?? 0) === 0;
  return Object.freeze({
    module,
    nodes,
    captureAnalysis,
    constantAnalysis,
    functionAnalysis: new WasmFunctionAnalysis(
      nodes,
      module.definitionRoots,
      constantAnalysis,
    ),
    uniqueReuseAnalysis: new WasmUniqueReuseAnalysis(module, nodes),
    storage,
    entry,
    compactScalarEligible,
    instrumentedFuel,
    options,
  });
}

export function validateFunctionalWasmSimdMode(
  simd: WasmCompilationOptions["simd"],
): void {
  if (
    simd !== undefined && simd !== "portable-scalar" &&
    simd !== "wasm-simd"
  ) {
    throw new TypeError(
      `functional WASM SIMD mode must be portable-scalar or wasm-simd; received ${
        JSON.stringify(simd)
      }`,
    );
  }
}

function validateOwnedTypeExports(
  module: GpuModule,
  nodes: readonly CoreNode[],
  options: WasmCompilationOptions,
): void {
  const ownedTypeExports = options.ownedTypeExports ?? [];
  if (!Array.isArray(ownedTypeExports)) {
    throw new TypeError("functional WASM ownedTypeExports must be an array");
  }
  if (ownedTypeExports.length === 0) return;
  if (options.storageCore === undefined) {
    throw new TypeError("functional WASM ownedTypeExports require a verified frontend storageCore");
  }
  if (
    module.evaluationProfile !== EvaluationProfile.StrictEager ||
    nodes.some((node) =>
      (node.tag === CoreTag.Apply || node.tag === CoreTag.Let) &&
      node.evaluationMode === EvaluationMode.LazyCallByNeed
    )
  ) {
    throw new TypeError(
      "functional WASM ownedTypeExports require strict Core without lazy boundaries",
    );
  }
  const exportNames = new Set(["main", ...module.wasmExports.map((exported) => exported.name)]);
  const storageValues = new Set<string>();
  for (const owned of ownedTypeExports) {
    if (owned === null || typeof owned !== "object") {
      throw new TypeError("functional WASM owned type export must be an object");
    }
    if (typeof owned.name !== "string" || owned.name.length === 0) {
      throw new TypeError("functional WASM owned type export name must be a non-empty string");
    }
    if (typeof owned.storageValue !== "string" || owned.storageValue.length === 0) {
      throw new TypeError(
        `functional WASM owned type export ${
          JSON.stringify(owned.name)
        } storageValue must be a non-empty string`,
      );
    }
    if (storageValues.has(owned.storageValue)) {
      throw new TypeError(
        `functional WASM owned type exports repeat Storage Core value ${
          JSON.stringify(owned.storageValue)
        }`,
      );
    }
    if (
      !options.storageCore.operations.some((operation) =>
        (operation.kind === "declare" && operation.value === owned.storageValue &&
          operation.lifetime === "owned") ||
        (operation.kind === "promote" && operation.target === owned.storageValue &&
          operation.targetLifetime === "owned")
      )
    ) {
      throw new TypeError(
        `functional WASM owned type export ${
          JSON.stringify(owned.name)
        } requires owned Storage Core value ${JSON.stringify(owned.storageValue)}`,
      );
    }
    storageValues.add(owned.storageValue);
    requireFirstOrderFunctionalWasmType(module, owned.type, `owned type ${owned.name}`);
    for (const generatedName of [`retain_${owned.name}`, `drop_${owned.name}`]) {
      if (exportNames.has(generatedName)) {
        throw new TypeError(
          `functional WASM owned type export repeats ${JSON.stringify(generatedName)}`,
        );
      }
      exportNames.add(generatedName);
    }
  }
}
