import { FunctionalCoreTag, FunctionalEvaluationMode, FunctionalEvaluationProfile } from "./abi.ts";
import type { FunctionalCoreNode, GpuFunctionalModule } from "./compiler_module.ts";
import {
  functionalHostScalarType,
  type FunctionalWasmEntry,
  functionalWasmEntry,
} from "./wasm_host_boundary.ts";
import { FunctionalWasmCaptureAnalysis } from "./wasm_capture_analysis.ts";
import type { FunctionalWasmCompilationOptions } from "./wasm_contract.ts";
import { FunctionalWasmFunctionAnalysis } from "./wasm_function_analysis.ts";
import type { FunctionalStoragePlan } from "./storage_contract.ts";
import { createFunctionalStoragePlan } from "./storage_plan.ts";
import { requireFirstOrderFunctionalWasmType } from "./wasm_value_codec.ts";

export interface FunctionalWasmBackendPlan {
  readonly module: GpuFunctionalModule;
  readonly nodes: readonly FunctionalCoreNode[];
  readonly captureAnalysis: FunctionalWasmCaptureAnalysis;
  readonly functionAnalysis: FunctionalWasmFunctionAnalysis;
  readonly storage: FunctionalStoragePlan;
  readonly entry: FunctionalWasmEntry;
  readonly compactScalarEligible: boolean;
  readonly instrumentedFuel: boolean;
  readonly options: FunctionalWasmCompilationOptions;
}

export function createFunctionalWasmBackendPlan(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  instrumentedFuel: boolean,
  options: FunctionalWasmCompilationOptions,
): FunctionalWasmBackendPlan {
  const captureAnalysis = new FunctionalWasmCaptureAnalysis(nodes);
  const storage = createFunctionalStoragePlan(module, nodes, captureAnalysis, {
    ...(options.storageCore === undefined ? {} : { storageCore: options.storageCore }),
  });
  const entry = functionalWasmEntry(module);
  validateOwnedTypeExports(module, nodes, options);
  const scalarResult = functionalHostScalarType(entry.result);
  const compactScalarEligible = module.evaluationProfile ===
      FunctionalEvaluationProfile.StrictEager &&
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
    functionAnalysis: new FunctionalWasmFunctionAnalysis(nodes, module.definitionRoots),
    storage,
    entry,
    compactScalarEligible,
    instrumentedFuel,
    options,
  });
}

function validateOwnedTypeExports(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  options: FunctionalWasmCompilationOptions,
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
    module.evaluationProfile !== FunctionalEvaluationProfile.StrictEager ||
    nodes.some((node) =>
      (node.tag === FunctionalCoreTag.Apply || node.tag === FunctionalCoreTag.Let) &&
      node.evaluationMode === FunctionalEvaluationMode.LazyCallByNeed
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
