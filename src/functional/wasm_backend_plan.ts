import { CoreTag, EvaluationMode, EvaluationProfile, NO_INDEX } from "./abi.ts";
import {
  type CompilerPerformanceTrace,
  measureCompilerStage,
} from "../compiler_performance_trace.ts";
import type { CompiledModule, CoreNode } from "./compiler_module.ts";
import {
  functionalHostScalarType,
  functionalWasmEntry,
  type WasmEntry,
} from "./wasm_host_boundary.ts";
import {
  canonicalFixedVectorName,
  F32X4_CONSTRUCTOR_NAME,
  F32X4_TYPE_NAME,
  F32x4Definition,
  MASK32X4_CONSTRUCTOR_NAME,
} from "./fixed_vector_contract.ts";
import { WasmCaptureAnalysis } from "./wasm_capture_analysis.ts";
import type { WasmCompilationOptions } from "./wasm_contract.ts";
import { WasmConstantAnalysis } from "./wasm_constant_analysis.ts";
import { WasmFunctionAnalysis } from "./wasm_function_analysis.ts";
import { createLoweredCoreStoragePlan } from "./storage_plan.ts";
import { requireFirstOrderWasmType } from "./wasm_value_codec.ts";
import { WasmUniqueReuseAnalysis } from "./wasm_unique_reuse_analysis.ts";
import { lowerCoreForWasm } from "./wasm_core_lowering.ts";
import { indexWasmCore, type WasmCoreIndex } from "./wasm_core_index.ts";

export interface WasmBackendPlan {
  readonly module: CompiledModule;
  readonly nodes: readonly CoreNode[];
  readonly captureAnalysis: WasmCaptureAnalysis;
  readonly constantAnalysis: WasmConstantAnalysis;
  readonly functionAnalysis: WasmFunctionAnalysis;
  readonly uniqueReuseAnalysis: WasmUniqueReuseAnalysis;
  readonly coreIndex: WasmCoreIndex;
  readonly entry: WasmEntry;
  readonly compactScalarEligible: boolean;
  readonly instrumentedFuel: boolean;
  readonly options: WasmCompilationOptions;
  readonly trace: CompilerPerformanceTrace | undefined;
}

export function createWasmBackendPlan(
  module: CompiledModule,
  nodes: readonly CoreNode[],
  instrumentedFuel: boolean,
  options: WasmCompilationOptions,
  trace?: CompilerPerformanceTrace,
): WasmBackendPlan {
  measureCompilerStage(trace, "wasm.plan.validate", {}, () => validateWasmSimdMode(options.simd));
  const loweringAnnotations = {
    inputNodes: nodes.length,
    outputNodes: 0,
    addedApplications: 0,
    addedLambdas: 0,
    addedCaseArms: 0,
    addedPatternBinders: 0,
  };
  const loweredNodes = measureCompilerStage(
    trace,
    "wasm.plan.lower-core",
    loweringAnnotations,
    () => lowerCoreForWasm(module, nodes),
    (result) => {
      loweringAnnotations.outputNodes = result.length;
      for (let nodeIndex = nodes.length; nodeIndex < result.length; nodeIndex++) {
        const tag = result[nodeIndex]!.tag;
        if (tag === CoreTag.Apply) loweringAnnotations.addedApplications += 1;
        else if (tag === CoreTag.Lambda) loweringAnnotations.addedLambdas += 1;
        else if (tag === CoreTag.CaseArm) loweringAnnotations.addedCaseArms += 1;
        else if (tag === CoreTag.PatternBind) loweringAnnotations.addedPatternBinders += 1;
      }
    },
  );
  const coreIndexAnnotations = {
    nodes: loweredNodes.length,
    directOnlyDefinitions: 0,
  };
  const coreIndex = measureCompilerStage(
    trace,
    "wasm.plan.index-core",
    coreIndexAnnotations,
    () => indexWasmCore(module, loweredNodes),
    (result) => {
      coreIndexAnnotations.directOnlyDefinitions = result.directOnlyDefinitions.size;
    },
  );
  const analysisAnnotations = { nodes: loweredNodes.length, definitions: module.definitionCount };
  const [captureAnalysis, constantAnalysis] = measureCompilerStage(
    trace,
    "wasm.plan.static-analysis",
    analysisAnnotations,
    () =>
      [
        new WasmCaptureAnalysis(loweredNodes),
        new WasmConstantAnalysis(loweredNodes),
      ] as const,
  );
  const storageAnnotations = {
    nodes: loweredNodes.length,
    values: 0,
    closureValues: 0,
    constructorValues: 0,
    thunkValues: 0,
    references: 0,
    boundaries: 0,
    skipped: options.storageCore === undefined,
  };
  measureCompilerStage(
    trace,
    "wasm.plan.storage",
    storageAnnotations,
    () =>
      options.storageCore === undefined
        ? undefined
        : createLoweredCoreStoragePlan(module, loweredNodes, captureAnalysis, {
          storageCore: options.storageCore,
        }, coreIndex),
    (result) => {
      if (result === undefined) return;
      storageAnnotations.values = result.values.length;
      storageAnnotations.closureValues =
        result.values.filter((value) => value.valueKind === "closure").length;
      storageAnnotations.constructorValues =
        result.values.filter((value) => value.valueKind === "constructor").length;
      storageAnnotations.thunkValues =
        result.values.filter((value) => value.valueKind === "thunk").length;
      storageAnnotations.references = result.references.length;
      storageAnnotations.boundaries = result.boundaries.length;
    },
  );
  const entry = measureCompilerStage(trace, "wasm.plan.boundary", {}, () => {
    const result = functionalWasmEntry(module);
    validateOwnedTypeExports(module, loweredNodes, options);
    return result;
  });
  const scalarResult = functionalHostScalarType(entry.result);
  const compactScalarEligible = module.evaluationProfile ===
      EvaluationProfile.StrictEager &&
    module.entryEffects.size === 0 &&
    module.hostCapabilities.every((capability) => capability.fields.length === 0) &&
    !coreIndex.hasLazyEvaluationBoundary &&
    !entry.takesInit &&
    entry.parameter === undefined &&
    scalarResult !== undefined &&
    scalarResult.kind !== "unit" &&
    options.storageCore === undefined &&
    (options.ownedTypeExports?.length ?? 0) === 0 &&
    module.wasmExports.every(compactIntegerExportIsProvable) &&
    (compactScalarProgramIsProvable(module, loweredNodes) ||
      options.simd === "wasm-simd" &&
        compactFixedVectorProgramIsProvable(module, loweredNodes));
  const functionAnalysis = measureCompilerStage(
    trace,
    "wasm.plan.function-analysis",
    analysisAnnotations,
    () =>
      new WasmFunctionAnalysis(
        loweredNodes,
        module.definitionRoots,
        constantAnalysis,
        coreIndex,
      ),
  );
  const uniqueReuseAnalysis = measureCompilerStage(
    trace,
    "wasm.plan.unique-reuse",
    analysisAnnotations,
    () => new WasmUniqueReuseAnalysis(module, loweredNodes),
  );
  return Object.freeze({
    module,
    nodes: loweredNodes,
    captureAnalysis,
    constantAnalysis,
    functionAnalysis,
    uniqueReuseAnalysis,
    coreIndex,
    entry,
    compactScalarEligible,
    instrumentedFuel,
    options,
    trace,
  });
}

export function updateWasmBackendPlanSignedLiterals(
  reference: WasmBackendPlan,
  module: CompiledModule,
  nodes: readonly CoreNode[],
  changedNodes: readonly number[],
  trace?: CompilerPerformanceTrace,
): WasmBackendPlan {
  const annotations = {
    nodes: reference.nodes.length,
    changedNodes: changedNodes.length,
  };
  return measureCompilerStage(
    trace,
    "wasm.plan.literal-update",
    annotations,
    () => {
      if (nodes.length > reference.nodes.length) {
        throw new Error(
          `incremental WebAssembly plan has ${reference.nodes.length} lowered nodes for ${nodes.length} Core nodes`,
        );
      }
      // Signed literals are leaves, and every cached analysis depends only on their tag and edges.
      // Replacing their payloads therefore preserves indexing, captures, reachability, and reuse.
      const loweredNodes = [...reference.nodes];
      for (const nodeIndex of changedNodes) {
        const previous = reference.nodes[nodeIndex];
        const updated = nodes[nodeIndex];
        if (
          previous === undefined || updated === undefined ||
          previous.tag !== CoreTag.SignedInteger64 ||
          updated.tag !== CoreTag.SignedInteger64 ||
          previous.child1 !== updated.child1 ||
          previous.child2 !== updated.child2 ||
          previous.sourceByteOffset !== updated.sourceByteOffset ||
          previous.sourceEndByte !== updated.sourceEndByte ||
          previous.evaluationMode !== updated.evaluationMode
        ) {
          throw new Error(
            `incremental WebAssembly plan received a non-literal change at Core node ${nodeIndex}`,
          );
        }
        loweredNodes[nodeIndex] = updated;
      }
      return Object.freeze({
        ...reference,
        module,
        nodes: Object.freeze(loweredNodes),
        trace,
      });
    },
  );
}

function compactFixedVectorProgramIsProvable(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): boolean {
  if (!module.typeNames.some((name) => canonicalFixedVectorName(name) === F32X4_TYPE_NAME)) {
    return false;
  }
  const canonicalDefinitions = new Set<string>(Object.values(F32x4Definition));
  const activeDefinitions = new Set<number>();
  const verifiedDefinitions = new Map<number, boolean>();

  const visitDefinition = (definition: number): boolean => {
    const cached = verifiedDefinitions.get(definition);
    if (cached !== undefined) return cached;
    if (activeDefinitions.has(definition)) return false;
    const name = module.definitionNames[definition];
    if (
      name !== undefined &&
      canonicalDefinitions.has(canonicalFixedVectorName(name) ?? "")
    ) {
      verifiedDefinitions.set(definition, true);
      return true;
    }
    const root = module.definitionRoots[definition];
    if (root === undefined) return false;
    activeDefinitions.add(definition);
    const summary = visit(root);
    activeDefinitions.delete(definition);
    const verified = summary.safe &&
      (definition === module.entryDefinition || summary.usesVector);
    verifiedDefinitions.set(definition, verified);
    return verified;
  };

  const visit = (nodeIndex: number): { readonly safe: boolean; readonly usesVector: boolean } => {
    const node = nodes[nodeIndex];
    if (node === undefined) return { safe: false, usesVector: false };
    const children = (...indices: number[]) => {
      let usesVector = false;
      for (const index of indices) {
        if (index === NO_INDEX) continue;
        const summary = visit(index);
        if (!summary.safe) return { safe: false, usesVector: false };
        usesVector ||= summary.usesVector;
      }
      return { safe: true, usesVector };
    };
    switch (node.tag) {
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Local:
        return { safe: true, usesVector: false };
      case CoreTag.Global:
        return { safe: visitDefinition(node.payload), usesVector: true };
      case CoreTag.Constructor: {
        const name = module.constructorNames[node.payload];
        const canonical = name === undefined ? undefined : canonicalFixedVectorName(name);
        return {
          safe: canonical === F32X4_CONSTRUCTOR_NAME ||
            canonical === MASK32X4_CONSTRUCTOR_NAME,
          usesVector: true,
        };
      }
      case CoreTag.Lambda:
      case CoreTag.PatternBind:
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
        return children(node.child0);
      case CoreTag.Apply:
      case CoreTag.Let:
      case CoreTag.LetRec:
      case CoreTag.Binary:
      case CoreTag.Case:
      case CoreTag.CaseArm:
        return children(node.child0, node.child1);
      case CoreTag.If:
        return children(node.child0, node.child1, node.child2);
      case CoreTag.Text:
      case CoreTag.Bytes:
      case CoreTag.RuntimeFault:
      case CoreTag.StoreEmpty:
      case CoreTag.Prim:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreLength:
      case CoreTag.StoreRead:
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        return { safe: false, usesVector: false };
    }
  };

  return visitDefinition(module.entryDefinition) &&
    module.wasmExports.every((exported) => visitDefinition(exported.definitionIndex));
}

function compactIntegerExportIsProvable(
  exported: CompiledModule["wasmExports"][number],
): boolean {
  if (exported.effects.size !== 0) return false;
  let type = exported.type;
  while (type.kind === "function") {
    if (type.parameter.kind !== "integer") return false;
    type = type.result;
  }
  return type.kind === "integer";
}

function compactScalarProgramIsProvable(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): boolean {
  if (nodes.length > 128) return false;
  const activeDefinitions = new Set<number>();
  const verifiedDefinitions = new Set<number>();

  const visitDefinition = (definition: number): boolean => {
    if (verifiedDefinitions.has(definition)) return true;
    if (activeDefinitions.has(definition)) return false;
    const root = module.definitionRoots[definition];
    if (root === undefined) return false;
    activeDefinitions.add(definition);
    const verified = visit(root, true);
    activeDefinitions.delete(definition);
    if (verified) verifiedDefinitions.add(definition);
    return verified;
  };

  const visit = (nodeIndex: number, allowsLambda: boolean): boolean => {
    const node = nodes[nodeIndex];
    if (node === undefined) return false;
    switch (node.tag) {
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Local:
        return true;
      case CoreTag.Global:
        return visitDefinition(node.payload);
      case CoreTag.Lambda:
        return allowsLambda && visit(node.child0, false);
      case CoreTag.Apply: {
        const arguments_: number[] = [];
        let calleeIndex = nodeIndex;
        let callee = nodes[calleeIndex];
        while (callee?.tag === CoreTag.Apply) {
          arguments_.push(callee.child1);
          calleeIndex = callee.child0;
          callee = nodes[calleeIndex];
        }
        if (callee?.tag === CoreTag.Lambda) {
          if (!visit(callee.child0, false)) return false;
        } else if (callee?.tag === CoreTag.Global) {
          if (!visitDefinition(callee.payload)) return false;
        } else {
          return false;
        }
        return arguments_.every((argument) => visit(argument, true));
      }
      case CoreTag.Let:
        return visit(node.child0, true) && visit(node.child1, false);
      case CoreTag.If:
        return visit(node.child0, false) &&
          visit(node.child1, false) &&
          visit(node.child2, false);
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
        return visit(node.child0, false);
      case CoreTag.Binary:
        return visit(node.child0, false) && visit(node.child1, false);
      case CoreTag.Text:
      case CoreTag.Bytes:
      case CoreTag.RuntimeFault:
      case CoreTag.StoreEmpty:
      case CoreTag.Constructor:
      case CoreTag.LetRec:
      case CoreTag.Case:
      case CoreTag.CaseArm:
      case CoreTag.PatternBind:
      case CoreTag.Prim:
      case CoreTag.BufferAppend:
      case CoreTag.StoreNew:
      case CoreTag.StoreLength:
      case CoreTag.StoreRead:
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        return false;
    }
  };

  if (!visitDefinition(module.entryDefinition)) return false;
  return module.wasmExports.every((exported) => visitDefinition(exported.definitionIndex));
}

export function validateWasmSimdMode(
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
  module: CompiledModule,
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
    requireFirstOrderWasmType(module, owned.type, `owned type ${owned.name}`);
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
