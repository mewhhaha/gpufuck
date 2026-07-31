import type { CompilerPerformanceTrace } from "../compiler_performance_trace.ts";
import {
  BinaryOperator,
  CoreTag,
  EvaluationMode,
  EvaluationProfile,
  NO_INDEX,
  type Type,
  UnaryOperator,
  UNIT_CONSTRUCTOR_NAME,
} from "./abi.ts";
import {
  canonicalAbiCoreSignature,
  type CanonicalAbiCoreType,
  type CanonicalAbiExport,
  type CanonicalAbiImport,
  canonicalAbiLayout,
  canonicalAbiParameterRecord,
  canonicalAbiRecordLayout,
  type CanonicalAbiType,
  canonicalAbiVariantLayout,
  flattenCanonicalAbiType,
  validateCanonicalAbiInterface,
} from "./canonical_abi.ts";
import type { CompiledModule, CoreNode, WasmExport } from "./compiler_module.ts";
import {
  BYTES_TYPE_NAME,
  type HostFieldDeclaration,
  type HostType,
  INIT_CONSTRUCTOR_NAME,
  INIT_TYPE_NAME,
  TEXT_TYPE_NAME,
  WasmIntrinsic,
} from "./host_contract.ts";
import {
  type CachedWasmFunctionBody,
  encodeCompactScalarWasmModule,
  type EncodedWasmModule,
  encodeSignedWasmInteger64,
  encodeWasmModule,
  WASM_BASE_FUNCTION_TYPE_COUNT,
  WASM_BASE_FUNCTION_TYPES,
  type WasmFunctionBody,
  type WasmFunctionImport,
  type WasmFunctionType,
  WasmFunctionTypeIndex,
  WasmInstructions,
  type WasmModuleEncoding,
  type WasmSignedInteger64Literal,
  WasmValueType,
} from "./wasm_binary.ts";
import { WasmValueAbi } from "./wasm_abi.ts";
import { concreteType } from "./schema_contract.ts";
import { requireFirstOrderWasmType } from "./wasm_value_codec.ts";
import type { WasmCaptureAnalysis } from "./wasm_capture_analysis.ts";
import { type LambdaSet, LambdaSetAnalysis } from "./wasm_lambda_sets.ts";
import type {
  CallArgument,
  FunctionShape,
  NumericFold,
  WasmFunctionAnalysis,
} from "./wasm_function_analysis.ts";
import {
  functionalHostScalarType,
  hostFieldKey,
  hostImportModule,
  type WasmEntry,
  wasmValueType,
} from "./wasm_host_boundary.ts";
import { WasmHostEmitter } from "./wasm_host_emitter.ts";
import {
  allocateFunction,
  canonicalReallocateFunction,
  forceThunkFunction,
  freeFunction,
  functionBody,
  THUNK_EVALUATED,
  THUNK_UNEVALUATED,
  WASM_FAULT_DIVIDE_BY_ZERO,
  WASM_FAULT_EXPLICIT,
  WASM_FAULT_INVALID_NUMERIC_CONVERSION,
  WASM_FAULT_OUT_OF_BOUNDS,
} from "./wasm_runtime_binary.ts";
import { WasmRuntimeEmitter } from "./wasm_runtime_emitter.ts";
import { structuralEqualityFunction } from "./wasm_structural_equality.ts";
import {
  float32FromBits,
  float64FromBits,
  isComparisonOperator,
  numericBinaryOpcode,
  numericConversion,
  numericOperatorGroup,
  type NumericPrimitiveKind,
  wideLiteralBits,
} from "./wasm_numeric.ts";
import {
  ownedValueExportFunction,
  releaseOwnedValueFunction,
  retainOwnedValueFunction,
} from "./wasm_owned_runtime.ts";
import { MAXIMUM_STORE_LENGTH } from "./store_contract.ts";
import type { WasmCompilationOptions } from "./wasm_contract.ts";
import type { ConstantResolver, WasmConstantAnalysis } from "./wasm_constant_analysis.ts";
import { functionalBytesFromLiteralSymbol } from "./static_literals.ts";
import {
  canonicalFixedVectorName,
  correspondingFixedVectorName,
  F32X4_CONSTRUCTOR_NAME,
  F32x4Definition,
  MASK32X4_CONSTRUCTOR_NAME,
} from "./fixed_vector_contract.ts";
import {
  createWasmBackendPlan,
  updateWasmBackendPlanSignedLiterals,
  type WasmBackendPlan,
} from "./wasm_backend_plan.ts";
import {
  f32x4ExtractedLane,
  f32x4ReplacementLane,
  simdF32x4BinaryOpcode,
  simdF32x4ComparisonOpcode,
  simdFloat32Operator,
  WasmSimdOpcode,
} from "./wasm_simd.ts";
import type { WasmUniqueReuseAnalysis } from "./wasm_unique_reuse_analysis.ts";
import { WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH } from "./wasm_runtime_layout.ts";

const CLOSURE_OBJECT_KIND = WasmValueAbi.objectKinds.closure;
const CONSTRUCTOR_OBJECT_KIND = WasmValueAbi.objectKinds.constructor;
const THUNK_OBJECT_KIND = WasmValueAbi.objectKinds.thunk;
const NUMERIC_OBJECT_KIND = WasmValueAbi.objectKinds.numeric;
const TEXT_OBJECT_KIND = WasmValueAbi.objectKinds.text;
const STORE_OBJECT_KIND = WasmValueAbi.objectKinds.store;
const OBJECT_HEADER_BYTE_LENGTH = WasmValueAbi.objectHeaderByteLength;
const OBJECT_REFERENCE_COUNT_BYTE_OFFSET = WasmValueAbi.objectReferenceCountByteOffset;
const THUNK_HEADER_BYTE_LENGTH = 24;
const VALUE_BYTE_LENGTH = WasmValueAbi.valueByteLength;
// Specialization is optional for correctness; this cap bounds generated code for recursive input.
const MAXIMUM_SPECIALIZED_INLINE_SITES = 128;

function canonicalWasmValueType(type: CanonicalAbiCoreType): number {
  if (type === "i32") return WasmValueType.I32;
  return WasmValueType.I64;
}

type ValueSource =
  | { readonly kind: "i64-local"; readonly index: number }
  | { readonly kind: "i64-value"; readonly index: number }
  | { readonly kind: "i32-integer"; readonly index: number }
  | { readonly kind: "i32-integer-constant"; readonly literal: number }
  | { readonly kind: "i32-boolean"; readonly index: number }
  | { readonly kind: "i32-boolean-constant"; readonly literal: boolean }
  | { readonly kind: "i32-pointer"; readonly index: number }
  | { readonly kind: "capture"; readonly byteOffset: number };

interface VirtualLambda {
  readonly kind: "virtual-lambda";
  readonly node: number;
  readonly environment: Environment;
}

interface VirtualConstructor {
  readonly kind: "virtual-constructor";
  readonly constructorIndex: number;
  readonly arguments: readonly CallArgument[];
  readonly environment: Environment;
}

interface StaticRecursiveFunction {
  readonly kind: "static-recursive-function";
  readonly node: number;
  readonly environment: Environment;
  readonly inlineAtSoleCall: boolean;
}

interface UniqueConstructorSource {
  readonly kind: "unique-constructor";
  readonly index: number;
  readonly fieldCount: number;
  readonly reusableCases: ReadonlySet<number>;
}

interface ConstructorReuseTarget {
  readonly pointer: number;
  readonly fieldCount: number;
}

interface StoreUpdate {
  readonly node: CoreNode;
  readonly nodeIndex: number;
}

/**
 * A contified join point: a label, not a value. `resultBranchDepth` is the depth recorded just
 * inside its `block`, so a call site at depth `d` branches to it with `d - resultBranchDepth`.
 */
interface JoinPoint {
  readonly kind: "join-point";
  readonly resultBranchDepth: number;
}

type Binding =
  | ValueSource
  | { readonly kind: "v128-f32x4"; readonly index: number }
  | JoinPoint
  | VirtualLambda
  | VirtualConstructor
  | StaticRecursiveFunction
  | UniqueConstructorSource;

// A missing source preserves de Bruijn depth for a binding that this closure does not capture.
type Environment = readonly (Binding | undefined)[];

interface HostField {
  readonly capability: string;
  readonly declaration: HostFieldDeclaration;
  readonly importIndex: number | undefined;
  readonly canonicalAbi?: CanonicalAbiImport;
  readonly closureSlot?: number;
}

interface ConstructorApplication {
  readonly constructorNode: number;
  readonly constructorIndex: number;
  readonly arguments: readonly CallArgument[];
}

interface UncurriedApplication {
  readonly baseNode: number;
  readonly arguments: readonly CallArgument[];
  readonly functionShape: FunctionShape;
  readonly staticEnvironment?: Environment;
  readonly inlineAtSoleCall: boolean;
  readonly inlineVirtualBase: boolean;
}

interface NamedApplication {
  readonly definition: string;
  readonly arguments: readonly CallArgument[];
}

interface CompiledSimdVector {
  readonly kind: "f32x4" | "mask32x4";
  readonly constructorName: string;
}

function compiledSimdVector(
  definition: string,
  kind: CompiledSimdVector["kind"],
): CompiledSimdVector {
  const constructorName = correspondingFixedVectorName(
    definition,
    kind === "f32x4" ? F32X4_CONSTRUCTOR_NAME : MASK32X4_CONSTRUCTOR_NAME,
  );
  if (constructorName === undefined) {
    throw new Error(
      `functional SIMD definition ${
        JSON.stringify(definition)
      } is outside the fixed-vector contract`,
    );
  }
  return { kind, constructorName };
}

interface UncurriedWorker {
  readonly slot: number;
  readonly hasEnvironmentParameter: boolean;
}

export interface WasmArtifact {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly specializedCallSites: number;
  readonly automaticArenaReset: boolean;
}

const backendPlansByArtifact = new WeakMap<WasmArtifact, WasmBackendPlan>();

interface CachedLinearWasmEmission {
  readonly encoding: WasmModuleEncoding;
  readonly functionBodies: readonly CachedWasmFunctionBody[];
  readonly sectionsBeforeCode: readonly (readonly number[])[];
}

const linearEmissionsByArtifact = new WeakMap<WasmArtifact, CachedLinearWasmEmission>();

function wasmEncodingAnnotations(
  functions: readonly WasmFunctionBody[],
  imports: number,
  indirectFunctions: number,
): Record<string, number> {
  return {
    functions: functions.length,
    imports,
    indirectFunctions,
    instructionBytes: functions.reduce(
      (total, body) => total + body.instructions.length,
      0,
    ),
    locals: functions.reduce((total, body) => total + body.localTypes.length, 0),
  };
}

export function compileWasmArtifact(
  module: CompiledModule,
  nodes: readonly CoreNode[],
  instrumentedFuel = false,
  options: WasmCompilationOptions = {},
  trace?: CompilerPerformanceTrace,
): WasmArtifact {
  trace ??= options.trace;
  if (options.canonicalAbi !== undefined) {
    validateCanonicalAbiInterface(options.canonicalAbi);
  }
  const planSpan = trace?.start("wasm.plan");
  let plan: WasmBackendPlan;
  try {
    plan = createWasmBackendPlan(module, nodes, instrumentedFuel, options, trace);
  } catch (error) {
    planSpan?.finish({
      failed: true,
      nodes: nodes.length,
      definitions: module.definitionCount,
      constructors: module.constructorCount,
    });
    throw error;
  }
  planSpan?.finish({
    nodes: nodes.length,
    definitions: module.definitionCount,
    constructors: module.constructorCount,
  });
  return emitWasmArtifact(plan, trace);
}

export function compileWasmArtifactWithSignedLiteralUpdate(
  module: CompiledModule,
  nodes: readonly CoreNode[],
  referenceArtifact: WasmArtifact,
  changedNodes: readonly number[],
  trace?: CompilerPerformanceTrace,
): WasmArtifact {
  const referencePlan = backendPlansByArtifact.get(referenceArtifact);
  if (referencePlan === undefined) {
    return compileWasmArtifact(module, nodes, false, {}, trace);
  }
  const planSpan = trace?.start("wasm.plan");
  let plan: WasmBackendPlan;
  try {
    plan = updateWasmBackendPlanSignedLiterals(
      referencePlan,
      module,
      nodes,
      changedNodes,
      trace,
    );
  } catch (error) {
    planSpan?.finish({
      failed: true,
      nodes: nodes.length,
      definitions: module.definitionCount,
      constructors: module.constructorCount,
    });
    throw error;
  }
  planSpan?.finish({
    nodes: nodes.length,
    definitions: module.definitionCount,
    constructors: module.constructorCount,
    incremental: true,
  });
  const referenceEmission = linearEmissionsByArtifact.get(referenceArtifact);
  if (referenceEmission !== undefined) {
    return emitWasmSignedLiteralUpdate(
      plan,
      referenceArtifact,
      referenceEmission,
      changedNodes,
      trace,
    );
  }
  return emitWasmArtifact(plan, trace);
}

function emitWasmSignedLiteralUpdate(
  plan: WasmBackendPlan,
  referenceArtifact: WasmArtifact,
  referenceEmission: CachedLinearWasmEmission,
  changedNodes: readonly number[],
  trace?: CompilerPerformanceTrace,
): WasmArtifact {
  const emitSpan = trace?.start("wasm.emit");
  try {
    const updateAnnotations = {
      functions: referenceEmission.encoding.functions.length,
      changedNodes: changedNodes.length,
      changedImmediates: 0,
    };
    const changedValues = new Map<number, bigint>();
    for (const nodeIndex of changedNodes) {
      const node = plan.nodes[nodeIndex];
      if (node?.tag !== CoreTag.SignedInteger64) {
        throw new Error(
          `incremental WebAssembly emission received non-literal Core node ${nodeIndex}`,
        );
      }
      changedValues.set(nodeIndex, wideLiteralBits(node));
    }
    const functions = trace === undefined
      ? updateSignedInteger64Literals(
        referenceEmission.encoding.functions,
        changedValues,
        updateAnnotations,
      )
      : trace.measure(
        "wasm.emit.literal-update",
        updateAnnotations,
        () =>
          updateSignedInteger64Literals(
            referenceEmission.encoding.functions,
            changedValues,
            updateAnnotations,
          ),
      );
    const encoding = Object.freeze({ ...referenceEmission.encoding, functions });
    const encodeSpan = trace?.start("wasm.encode");
    const encoded = encodeLinearWasmEmission(
      encoding,
      referenceEmission.functionBodies,
      referenceEmission.sectionsBeforeCode,
    );
    encodeSpan?.finish({
      ...wasmEncodingAnnotations(
        functions,
        encoding.imports.length,
        encoding.indirectFunctionIndices.length,
      ),
      reusedFunctionBodies: encoded.reusedFunctionBodies,
      reusedSectionsBeforeCode: encoded.reusedSectionsBeforeCode,
    });
    const artifact = {
      bytes: encoded.bytes,
      specializedCallSites: referenceArtifact.specializedCallSites,
      automaticArenaReset: referenceArtifact.automaticArenaReset,
    };
    backendPlansByArtifact.set(artifact, plan);
    linearEmissionsByArtifact.set(artifact, {
      encoding,
      functionBodies: encoded.functionBodies,
      sectionsBeforeCode: encoded.sectionsBeforeCode,
    });
    emitSpan?.finish({
      nodes: plan.nodes.length,
      bytes: encoded.bytes.byteLength,
      specializedCallSites: artifact.specializedCallSites,
      incremental: true,
    });
    return artifact;
  } catch (error) {
    emitSpan?.finish({ failed: true, nodes: plan.nodes.length, incremental: true });
    throw error;
  }
}

function updateSignedInteger64Literals(
  functions: readonly WasmFunctionBody[],
  changedValues: ReadonlyMap<number, bigint>,
  annotations: { changedImmediates: number },
): readonly WasmFunctionBody[] {
  return functions.map((body) => {
    if (
      !body.signedInteger64Literals.some((literal) => changedValues.has(literal.nodeIndex))
    ) return body;
    const instructions: number[] = [];
    const literals: WasmSignedInteger64Literal[] = [];
    let previousOffset = 0;
    for (const literal of body.signedInteger64Literals) {
      appendInstructionRange(
        instructions,
        body.instructions,
        previousOffset,
        literal.immediateOffset,
      );
      const value = changedValues.get(literal.nodeIndex);
      const immediate = value === undefined ? undefined : encodeSignedWasmInteger64(value);
      const immediateOffset = instructions.length;
      if (immediate === undefined) {
        appendInstructionRange(
          instructions,
          body.instructions,
          literal.immediateOffset,
          literal.immediateOffset + literal.immediateLength,
        );
      } else {
        for (const byte of immediate) instructions.push(byte);
      }
      literals.push({
        nodeIndex: literal.nodeIndex,
        immediateOffset,
        immediateLength: instructions.length - immediateOffset,
      });
      if (value !== undefined) annotations.changedImmediates += 1;
      previousOffset = literal.immediateOffset + literal.immediateLength;
    }
    appendInstructionRange(
      instructions,
      body.instructions,
      previousOffset,
      body.instructions.length,
    );
    return {
      ...body,
      instructions,
      signedInteger64Literals: literals,
    };
  });
}

function appendInstructionRange(
  target: number[],
  source: readonly number[],
  start: number,
  end: number,
): void {
  for (let offset = start; offset < end; offset++) target.push(source[offset]!);
}

function encodeLinearWasmEmission(
  encoding: WasmModuleEncoding,
  functionBodies: readonly CachedWasmFunctionBody[] = [],
  sectionsBeforeCode?: readonly (readonly number[])[],
): EncodedWasmModule {
  return encodeWasmModule(encoding, functionBodies, sectionsBeforeCode);
}

function emitWasmArtifact(
  plan: WasmBackendPlan,
  trace?: CompilerPerformanceTrace,
): WasmArtifact {
  const emitSpan = trace?.start("wasm.emit");
  try {
    if (plan.compactScalarEligible && plan.options.canonicalAbi === undefined) {
      const compactCompiler = new WasmCompiler(
        plan,
        true,
      );
      const compactBytes = compactCompiler.compileCompactScalar();
      if (compactBytes === undefined) {
        throw new Error("functional compact scalar preflight accepted a runtime-dependent program");
      }
      const artifact = compactCompiler.artifact(compactBytes);
      emitSpan?.finish({
        nodes: plan.nodes.length,
        bytes: artifact.bytes.byteLength,
        specializedCallSites: artifact.specializedCallSites,
      });
      backendPlansByArtifact.set(artifact, plan);
      return artifact;
    }

    const compiler = new WasmCompiler(
      plan,
      false,
    );
    const artifact = compiler.artifact(compiler.compile());
    emitSpan?.finish({
      nodes: plan.nodes.length,
      bytes: artifact.bytes.byteLength,
      specializedCallSites: artifact.specializedCallSites,
    });
    backendPlansByArtifact.set(artifact, plan);
    return artifact;
  } catch (error) {
    emitSpan?.finish({ failed: true, nodes: plan.nodes.length });
    throw error;
  }
}

class WasmCompiler {
  readonly #module: CompiledModule;
  readonly #nodes: readonly CoreNode[];
  readonly #captureAnalysis: WasmCaptureAnalysis;
  readonly #constantAnalysis: WasmConstantAnalysis;
  readonly #functionAnalysis: WasmFunctionAnalysis;
  readonly #uniqueReuseAnalysis: WasmUniqueReuseAnalysis;
  readonly #coreIndex: WasmBackendPlan["coreIndex"];
  readonly #indirectFunctions: (WasmFunctionBody | undefined)[] = [];
  readonly #lambdaSlots: (number | undefined)[];
  readonly #recursiveLambdaOwners = new Map<number, number>();
  readonly #uncurriedWorkers = new Map<string, UncurriedWorker>();
  readonly #f32x4Workers = new Map<number, number>();
  readonly #nativeIntegerFunctionNodes = new Set<number>();
  readonly #staticEnvironmentIds = new WeakMap<object, number>();
  readonly #additionalFunctionTypes: WasmFunctionType[] = [];
  readonly #additionalFunctionTypeIndices = new Map<string, number>();
  readonly #constructorClosureSlots: (number | undefined)[][];
  readonly #nullaryConstructorOffsets: readonly (number | undefined)[];
  readonly #globalThunkSlots: (number | undefined)[];
  readonly #directOnlyDefinitions: ReadonlySet<number>;
  readonly #entry: WasmEntry;
  readonly #hostFields: readonly HostField[];
  readonly #hostDefinitionFields: ReadonlyMap<number, HostField>;
  readonly #functionImports: readonly WasmFunctionImport[];
  readonly #activeSpecializedLambdas = new Set<number>();
  readonly #activeFusedWorkers = new Set<number>();
  readonly #compactScalar: boolean;
  readonly #hasLazyEvaluationBoundary: boolean;
  readonly #instrumentedFuel: boolean;
  readonly #simdEnabled: boolean;
  readonly #runtimeEmitter: WasmRuntimeEmitter;
  #automaticArenaReset = true;
  readonly #compilationOptions: WasmCompilationOptions;
  readonly #ownedRuntimeEnabled: boolean;
  readonly #hostEmitter: WasmHostEmitter;
  readonly #trace: CompilerPerformanceTrace | undefined;
  #linearEmission: CachedLinearWasmEmission | undefined;
  #lambdaSetAnalysis: LambdaSetAnalysis | undefined;
  #runtimeDefinitionIndices: ReadonlySet<number> = new Set();
  #remainingSpecializedInlineSites = MAXIMUM_SPECIALIZED_INLINE_SITES;
  #specializedCallSiteCount = 0;
  #nextStaticEnvironmentId = 0;
  #nativeScalarWorkerDepth = 0;
  #requestedAllocator = false;
  #requestedThunkForce = false;
  #structuralEqualitySlot: number | undefined;

  constructor(
    plan: WasmBackendPlan,
    compactScalar: boolean,
  ) {
    const { module, nodes } = plan;
    this.#module = module;
    this.#nodes = nodes;
    this.#compactScalar = compactScalar;
    for (const [index, type] of WASM_BASE_FUNCTION_TYPES.entries()) {
      this.#additionalFunctionTypeIndices.set(
        `${type.parameters.join(",")}->${type.results.join(",")}`,
        index,
      );
    }
    this.#instrumentedFuel = plan.instrumentedFuel;
    this.#runtimeEmitter = new WasmRuntimeEmitter(nodes, {
      compactScalar,
      instrumentedFuel: plan.instrumentedFuel,
    });
    this.#compilationOptions = plan.options;
    this.#trace = plan.trace;
    this.#ownedRuntimeEnabled = (plan.options.ownedTypeExports?.length ?? 0) > 0;
    this.#hostEmitter = new WasmHostEmitter({
      ownedRuntimeEnabled: this.#ownedRuntimeEnabled,
      allocateFunctionIndex: () => this.allocateFunctionIndex(),
      emitDecodeInteger: (instructions) => this.emitDecodeInteger(instructions),
      emitBoxSignedInteger64: (instructions) => this.emitBoxSignedInteger64(instructions),
      emitEncodeBoolean: (instructions) => this.emitEncodeBoolean(instructions),
      emitEncodeInteger: (instructions) => this.emitEncodeInteger(instructions),
      emitForceValue: (instructions) => this.emitForceValue(instructions),
      emitFuelChargeAmount: (instructions, amount, nodeIndex) =>
        this.#runtimeEmitter.emitFuelChargeAmount(instructions, amount, nodeIndex),
      emitRuntimeFault: (instructions, fault) =>
        this.#runtimeEmitter.emitFault(instructions, fault, -1),
    });
    this.#hasLazyEvaluationBoundary = plan.coreIndex.hasLazyEvaluationBoundary;
    this.#simdEnabled = !plan.instrumentedFuel && plan.options.simd === "wasm-simd" &&
      module.evaluationProfile === EvaluationProfile.StrictEager &&
      !this.#hasLazyEvaluationBoundary;
    this.#captureAnalysis = plan.captureAnalysis;
    this.#constantAnalysis = plan.constantAnalysis;
    this.#functionAnalysis = plan.functionAnalysis;
    this.#uniqueReuseAnalysis = plan.uniqueReuseAnalysis;
    this.#lambdaSetAnalysis = plan.lambdaSetAnalysis;
    this.#coreIndex = plan.coreIndex;
    this.#directOnlyDefinitions = plan.coreIndex.directOnlyDefinitions;
    this.#lambdaSlots = Array.from({ length: nodes.length }, () => undefined);
    for (const [lambda, owner] of plan.coreIndex.recursiveLambdaOwners) {
      this.#recursiveLambdaOwners.set(lambda, owner);
    }
    this.#entry = plan.entry;
    const hostFields: HostField[] = [];
    const functionImports: WasmFunctionImport[] = [];
    for (const capability of module.hostCapabilities) {
      for (const declaration of capability.fields) {
        const canonicalAbi = plan.options.canonicalAbi?.imports.find(
          (candidate) =>
            candidate.capability === capability.name &&
            candidate.operation === declaration.name,
        );
        if (declaration.kind === "value") {
          requireFirstOrderWasmType(
            module,
            concreteType(declaration.representation ?? declaration.type),
            `host value ${JSON.stringify(`${capability.name}.${declaration.name}`)}`,
          );
        } else {
          if (
            declaration.wasmIntrinsic !==
              WasmIntrinsic.BufferGenerate
          ) {
            requireFirstOrderWasmType(
              module,
              concreteType(
                declaration.parameterRepresentation ?? declaration.parameter,
              ),
              `host operation ${
                JSON.stringify(`${capability.name}.${declaration.name}`)
              } parameter`,
            );
          }
          requireFirstOrderWasmType(
            module,
            concreteType(declaration.resultRepresentation ?? declaration.result),
            `host operation ${JSON.stringify(`${capability.name}.${declaration.name}`)} result`,
          );
        }
        let importIndex: number | undefined;
        if (
          declaration.kind === "value"
            ? declaration.wasmLiteral === undefined
            : declaration.wasmIntrinsic === undefined
        ) {
          importIndex = functionImports.length;
          let moduleName = hostImportModule(capability.name);
          let fieldName = declaration.name;
          let typeIndex: number;
          if (canonicalAbi !== undefined) {
            const signature = canonicalAbiCoreSignature(
              canonicalAbi.function,
              "import",
            );
            moduleName = canonicalAbi.module;
            fieldName = canonicalAbi.name;
            typeIndex = this.functionTypeIndex(
              signature.parameters.map(canonicalWasmValueType),
              signature.results.map(canonicalWasmValueType),
            );
          } else if (plan.options.canonicalAbi !== undefined) {
            throw new TypeError(
              `canonical ABI omitted host operation ${
                JSON.stringify(`${capability.name}.${declaration.name}`)
              }`,
            );
          } else if (declaration.kind === "value") {
            typeIndex = this.functionTypeIndex([], [
              wasmValueType(declaration.representation ?? declaration.type),
            ]);
          } else {
            typeIndex = this.functionTypeIndex(
              [wasmValueType(
                declaration.parameterRepresentation ?? declaration.parameter,
              )],
              [wasmValueType(
                declaration.resultRepresentation ?? declaration.result,
              )],
            );
          }
          functionImports.push({
            module: moduleName,
            name: fieldName,
            typeIndex,
          });
        }
        hostFields.push({
          capability: capability.name,
          declaration,
          importIndex,
          ...(canonicalAbi === undefined ? {} : { canonicalAbi }),
          ...(declaration.kind === "operation"
            ? { closureSlot: this.reserveIndirectFunction() }
            : {}),
        });
      }
    }
    this.#hostFields = Object.freeze(hostFields);
    const hostDefinitionFields = new Map<number, HostField>();
    for (const binding of module.hostDefinitions) {
      const definitionIndex = module.definitionNames.indexOf(binding.definition);
      const field = hostFields.find((candidate) =>
        candidate.capability === binding.capability &&
        candidate.declaration.name === binding.field
      );
      if (definitionIndex < 0 || field === undefined) {
        throw new Error(
          `functional host definition ${JSON.stringify(binding.definition)} could not resolve ${
            JSON.stringify(`${binding.capability}.${binding.field}`)
          }`,
        );
      }
      hostDefinitionFields.set(definitionIndex, field);
    }
    this.#hostDefinitionFields = hostDefinitionFields;
    this.#functionImports = Object.freeze(functionImports);
    this.#constructorClosureSlots = module.constructorArities.map((arity) =>
      Array.from({ length: arity }, () => undefined)
    );
    const referencedNullaryConstructors = new Set(
      plan.coreIndex.referencedNullaryConstructors,
    );
    if (
      hostFields.some((field) =>
        field.declaration.kind === "value"
          ? field.declaration.type.kind === "unit"
          : field.declaration.result.kind === "unit"
      )
    ) {
      const unitConstructor = module.constructorNames.indexOf(
        UNIT_CONSTRUCTOR_NAME,
      );
      if (unitConstructor >= 0) {
        referencedNullaryConstructors.add(unitConstructor);
      }
    }
    let nullaryConstructorOffset = module.definitionCount * VALUE_BYTE_LENGTH;
    this.#nullaryConstructorOffsets = module.constructorArities.map(
      (arity, constructorIndex) => {
        if (
          arity !== 0 || !referencedNullaryConstructors.has(constructorIndex)
        ) return undefined;
        const offset = nullaryConstructorOffset;
        nullaryConstructorOffset += VALUE_BYTE_LENGTH;
        return offset;
      },
    );
    this.#globalThunkSlots = module.definitionRoots.map(() => undefined);
  }

  artifact(bytes: Uint8Array<ArrayBuffer>): WasmArtifact {
    const artifact = {
      bytes,
      specializedCallSites: this.#specializedCallSiteCount,
      automaticArenaReset: this.#automaticArenaReset,
    };
    if (this.#linearEmission !== undefined) {
      linearEmissionsByArtifact.set(artifact, this.#linearEmission);
    }
    return artifact;
  }

  scalarSpecializationEnabled(): boolean {
    return this.#compactScalar || this.#nativeScalarWorkerDepth > 0;
  }

  compileCompactScalar(): Uint8Array<ArrayBuffer> | undefined {
    const scalarResult = functionalHostScalarType(this.#entry.result);
    if (!this.#compactScalar || scalarResult === undefined || scalarResult.kind === "unit") {
      return undefined;
    }

    const entryRoot = this.#module.definitionRoots[this.#module.entryDefinition];
    if (entryRoot === undefined) {
      throw new Error(
        `functional WASM entry d${this.#module.entryDefinition} exceeds ${this.#module.definitionCount} definitions`,
      );
    }
    const entryInstructions = new WasmInstructions(
      this.#entry.parameter === undefined ? 0 : 1,
    );
    if (this.#entry.result.kind === "integer") {
      this.compileIntegerExpression(entryInstructions, entryRoot, []);
    } else {
      if (this.#entry.result.kind === "boolean") {
        this.compileBooleanExpression(entryInstructions, entryRoot, []);
      } else if (this.#entry.result.kind === "signed-integer-64") {
        this.compileSignedInteger64Expression(entryInstructions, entryRoot, []);
      } else if (this.#entry.result.kind === "float-32") {
        this.compileFloat32Expression(entryInstructions, entryRoot, []);
      } else if (this.#entry.result.kind === "float-64") {
        this.compileFloat64Expression(entryInstructions, entryRoot, []);
      } else {
        this.compileBooleanExpression(entryInstructions, entryRoot, []);
      }
    }

    const entryBody = functionBody(
      this.functionTypeIndex(
        this.#entry.parameter === undefined ? [] : [WasmValueType.I64],
        [wasmValueType(scalarResult)],
      ),
      entryInstructions,
      "compact scalar entry",
    );
    const callableFunctions: WasmFunctionBody[] = [];
    for (const exported of this.#module.wasmExports) {
      const { parameters, result } = this.wasmExportSignature(exported);
      const callable = this.compileDirectIntegerWasmExport(
        exported,
        parameters,
        result,
      );
      if (callable === undefined) return undefined;
      callableFunctions.push(callable);
    }
    const indirectFunctions = this.#indirectFunctions.map((body, slot) => {
      if (body === undefined) {
        throw new Error(
          `functional WASM compact function slot ${slot} was not emitted`,
        );
      }
      return body;
    });
    const entryFunctionIndex = indirectFunctions.length;
    const emittedFunctions = [
      ...indirectFunctions,
      entryBody,
      ...callableFunctions,
    ];
    const requiresRuntime = this.#requestedAllocator ||
      this.#requestedThunkForce ||
      emittedFunctions.some((body) => body.usesMemory || body.usesIndirectCalls);
    if (requiresRuntime) return undefined;

    const encodeSpan = this.#trace?.start("wasm.encode");
    const bytes = encodeCompactScalarWasmModule(
      emittedFunctions,
      entryFunctionIndex,
      this.#additionalFunctionTypes,
      {
        runtimeGlobals: this.#runtimeEmitter.compactGlobals,
      },
      this.#module.wasmExports.map((exported, index) => ({
        name: exported.name,
        functionIndex: entryFunctionIndex + 1 + index,
      })),
    );
    encodeSpan?.finish(wasmEncodingAnnotations(
      emittedFunctions,
      0,
      indirectFunctions.length,
    ));
    return bytes;
  }

  compile(): Uint8Array<ArrayBuffer> {
    this.validateCanonicalAbiModule();
    const reachabilitySpan = this.#trace?.start("wasm.emit.reachability");
    const directCallableFunctions = this.#module.wasmExports.map((exported) => {
      if (this.#compilationOptions.canonicalAbi !== undefined) return undefined;
      const { parameters, result } = this.wasmExportSignature(exported);
      return this.compileDirectIntegerWasmExport(exported, parameters, result);
    });
    this.#runtimeDefinitionIndices = this.#functionAnalysis.reachableDefinitions([
      this.#module.entryDefinition,
      ...this.#module.wasmExports.flatMap((exported, index) =>
        directCallableFunctions[index] === undefined ? [exported.definitionIndex] : []
      ),
    ], {
      constantBranches: this.#instrumentedFuel ? "preserve" : "prune",
    });
    reachabilitySpan?.finish({
      definitions: this.#module.definitionCount,
      reachableDefinitions: this.#runtimeDefinitionIndices.size,
      directExports: directCallableFunctions.filter((body) => body !== undefined).length,
    });

    const closureSpan = this.#trace?.start("wasm.emit.closures");
    for (const definitionIndex of this.#runtimeDefinitionIndices) {
      if (this.#hostDefinitionFields.has(definitionIndex)) continue;
      const rootNode = this.#module.definitionRoots[definitionIndex];
      if (rootNode === undefined || this.expressionIsWhnf(rootNode)) continue;
      this.#globalThunkSlots[definitionIndex] = this.reserveIndirectFunction();
    }
    this.#automaticArenaReset = !this.#globalThunkSlots.some((slot) => slot !== undefined);
    this.compileHostOperationClosures();
    this.compileGlobalThunks();
    closureSpan?.finish({
      reachableDefinitions: this.#runtimeDefinitionIndices.size,
      directOnlyDefinitions: [...this.#directOnlyDefinitions].filter((definition) =>
        this.#runtimeDefinitionIndices.has(definition)
      ).length,
      globalThunks: this.#globalThunkSlots.filter((slot) =>
        slot !== undefined
      ).length,
      indirectFunctions: this.#indirectFunctions.length,
    });
    const exportsSpan = this.#trace?.start("wasm.emit.exports-and-initialization");
    const scalarResult = functionalHostScalarType(this.#entry.result);
    const initializeInstructions = new WasmInstructions(0);
    this.emitGlobalInitialization(initializeInstructions);
    initializeInstructions.i32Const(0);
    const initializeFunctionIndex = this.indirectFunctionOffset() +
      this.#indirectFunctions.length;
    const callableFunctions = this.#module.wasmExports.map((exported, index) => {
      const canonical = this.#compilationOptions.canonicalAbi?.exports.find(
        (candidate) => candidate.name === exported.name,
      );
      if (canonical !== undefined) {
        return this.compileCanonicalWasmExport(
          exported,
          canonical,
          initializeFunctionIndex,
        );
      }
      if (this.#compilationOptions.canonicalAbi !== undefined) {
        throw new TypeError(
          `canonical ABI omitted export ${JSON.stringify(exported.name)}`,
        );
      }
      const direct = directCallableFunctions[index];
      if (direct !== undefined) return direct;
      const { parameters, result } = this.wasmExportSignature(exported);
      return this.compileGeneralWasmExport(
        exported,
        parameters,
        result,
        initializeFunctionIndex,
      );
    });
    const canonicalPostReturns = this.#compilationOptions.canonicalAbi?.exports
      .filter((exported) => canonicalAbiCoreSignature(exported.function, "export").indirectResult)
      .map((exported) => {
        if (exported.postReturn === undefined) {
          throw new TypeError(
            `canonical ABI export ${JSON.stringify(exported.name)} omitted its post-return name`,
          );
        }
        return {
          name: exported.postReturn,
          body: this.compileCanonicalPostReturn(exported),
        };
      }) ?? [];
    exportsSpan?.finish({
      exports: this.#module.wasmExports.length,
      functions: callableFunctions.length,
      initializationInstructionBytes: initializeInstructions.bytes.length,
      initializationLocals: initializeInstructions.localTypes.length,
    });
    const runtimeSpan = this.#trace?.start("wasm.emit.runtime-bodies");
    const indirectFunctions = this.#indirectFunctions.map((body, slot) => {
      if (body === undefined) {
        throw new Error(
          `functional WASM indirect function slot ${slot} was not emitted`,
        );
      }
      return body;
    });
    const forceValueInstructions = new WasmInstructions(1);
    this.emitForceValue(forceValueInstructions, 0);
    const forceValueType = this.functionTypeIndex([WasmValueType.I64], [
      WasmValueType.I64,
    ]);
    const entryResultType = scalarResult === undefined
      ? WasmValueType.I64
      : wasmValueType(scalarResult);
    const initializeType = this.functionTypeIndex([], [WasmValueType.I32]);
    const entryInstructions = new WasmInstructions(
      this.#entry.parameter === undefined ? 0 : 1,
    );
    entryInstructions.call(initializeFunctionIndex);
    entryInstructions.emit(0x1a);
    this.emitEntryCall(entryInstructions);
    this.emitPublicResult(entryInstructions, this.#entry.result);
    const freeType = this.functionTypeIndex(
      [WasmValueType.I32, WasmValueType.I32],
      [],
    );
    const baseFunctions = [
      allocateFunction(this.heapStart()),
      forceThunkFunction(),
      freeFunction(freeType, this.heapStart()),
      functionBody(
        forceValueType,
        forceValueInstructions,
        "public value force",
      ),
      ...indirectFunctions,
      functionBody(
        initializeType,
        initializeInstructions,
        "public runtime initialization",
      ),
      functionBody(
        this.functionTypeIndex(
          this.#entry.parameter === undefined ? [] : [WasmValueType.I64],
          [entryResultType],
        ),
        entryInstructions,
        "entry wrapper",
      ),
      ...callableFunctions,
      ...canonicalPostReturns.map((postReturn) => postReturn.body),
    ];
    runtimeSpan?.finish({
      indirectFunctions: indirectFunctions.length,
      functions: baseFunctions.length,
    });
    const ownedSpan = this.#trace?.start("wasm.emit.owned-runtime");
    const ownedTypeExports = this.#compilationOptions.ownedTypeExports ?? [];
    const ownedRuntimeType = ownedTypeExports.length === 0
      ? undefined
      : this.functionTypeIndex([WasmValueType.I64], []);
    const retainOwnedFunctionIndex = ownedRuntimeType === undefined
      ? undefined
      : this.#functionImports.length + baseFunctions.length;
    const releaseOwnedFunctionIndex = retainOwnedFunctionIndex === undefined
      ? undefined
      : retainOwnedFunctionIndex + 1;
    const ownedRuntimeFunctions = ownedRuntimeType === undefined ||
        retainOwnedFunctionIndex === undefined || releaseOwnedFunctionIndex === undefined
      ? []
      : [
        retainOwnedValueFunction(ownedRuntimeType, this.heapStart()),
        releaseOwnedValueFunction(
          ownedRuntimeType,
          this.#functionImports.length + 2,
          this.heapStart(),
        ),
        ...ownedTypeExports.flatMap((owned) => [
          ownedValueExportFunction(
            ownedRuntimeType,
            retainOwnedFunctionIndex,
            "retain",
            owned.name,
          ),
          ownedValueExportFunction(
            ownedRuntimeType,
            releaseOwnedFunctionIndex,
            "drop",
            owned.name,
          ),
        ]),
      ];
    const functions = [...baseFunctions, ...ownedRuntimeFunctions];
    const canonicalReallocateType = this.#compilationOptions.canonicalAbi === undefined
      ? undefined
      : this.functionTypeIndex(
        [
          WasmValueType.I32,
          WasmValueType.I32,
          WasmValueType.I32,
          WasmValueType.I32,
        ],
        [WasmValueType.I32],
      );
    const canonicalReallocateIndex = canonicalReallocateType === undefined
      ? undefined
      : this.#functionImports.length + functions.length;
    const emittedFunctions = canonicalReallocateType === undefined ? functions : [
      ...functions,
      canonicalReallocateFunction(
        canonicalReallocateType,
        this.#functionImports.length,
        this.#functionImports.length + 2,
      ),
    ];
    ownedSpan?.finish({
      exports: ownedTypeExports.length,
      functions: ownedRuntimeFunctions.length,
    });
    const indirectFunctionIndices = indirectFunctions.map((_, slot) =>
      this.indirectFunctionOffset() + slot
    );
    const entryFunctionIndex = this.#functionImports.length + 5 +
      indirectFunctions.length;
    const firstPostReturnFunctionIndex = entryFunctionIndex + 1 +
      callableFunctions.length;
    const functionExports = [
      ...this.#module.wasmExports.map((exported, index) => ({
        name: exported.name,
        functionIndex: entryFunctionIndex + 1 + index,
      })),
      ...canonicalPostReturns.map((postReturn, index) => ({
        name: postReturn.name,
        functionIndex: firstPostReturnFunctionIndex + index,
      })),
      ...(canonicalReallocateIndex === undefined ? [] : [{
        name: "cabi_realloc",
        functionIndex: canonicalReallocateIndex,
      }]),
      ...(releaseOwnedFunctionIndex === undefined
        ? []
        : ownedTypeExports.flatMap((owned, index) => [{
          name: `retain_${owned.name}`,
          functionIndex: releaseOwnedFunctionIndex + 1 + index * 2,
        }, {
          name: `drop_${owned.name}`,
          functionIndex: releaseOwnedFunctionIndex + 2 + index * 2,
        }])),
    ];
    const encoding = Object.freeze({
      imports: this.#functionImports,
      functions: emittedFunctions,
      indirectFunctionIndices,
      entryFunctionIndex,
      heapStart: this.heapStart(),
      additionalFunctionTypes: this.#additionalFunctionTypes,
      valueForceFunctionIndex: this.#functionImports.length + 3,
      initializeFunctionIndex: this.#functionImports.length + 4 +
        indirectFunctions.length,
      allocateFunctionIndex: this.#functionImports.length,
      freeFunctionIndex: this.#functionImports.length + 2,
      functionExports,
      instrumentedFuel: this.#instrumentedFuel,
      ...(this.#compilationOptions.canonicalAbi === undefined
        ? {}
        : { canonicalAbiVersion: { major: 1, minor: 0 } }),
    });
    const encodeSpan = this.#trace?.start("wasm.encode");
    const encoded = encodeLinearWasmEmission(encoding);
    this.#linearEmission = {
      encoding,
      functionBodies: encoded.functionBodies,
      sectionsBeforeCode: encoded.sectionsBeforeCode,
    };
    encodeSpan?.finish({
      ...wasmEncodingAnnotations(
        emittedFunctions,
        this.#functionImports.length,
        indirectFunctions.length,
      ),
      reusedFunctionBodies: encoded.reusedFunctionBodies,
      reusedSectionsBeforeCode: encoded.reusedSectionsBeforeCode,
    });
    return encoded.bytes;
  }

  validateCanonicalAbiModule(): void {
    const interface_ = this.#compilationOptions.canonicalAbi;
    if (interface_ === undefined) return;
    if (interface_.exports.length !== this.#module.wasmExports.length) {
      throw new TypeError(
        `canonical ABI declares ${interface_.exports.length} exports for ${this.#module.wasmExports.length} compiled exports`,
      );
    }
    for (const exported of this.#module.wasmExports) {
      const canonical = interface_.exports.find((candidate) => candidate.name === exported.name);
      if (canonical === undefined) {
        throw new TypeError(
          `canonical ABI omitted export ${JSON.stringify(exported.name)}`,
        );
      }
      const signature = this.wasmExportSignature(exported);
      if (canonical.function.parameters.length !== signature.parameters.length) {
        throw new TypeError(
          `canonical ABI export ${
            JSON.stringify(exported.name)
          } has ${canonical.function.parameters.length} parameters; compiled export has ${signature.parameters.length}`,
        );
      }
      for (const parameter of canonical.function.parameters) {
        this.validateCanonicalAbiConstructors(parameter);
      }
      this.validateCanonicalAbiConstructors(canonical.function.result);
    }
    const operations = this.#hostFields.filter((field) =>
      field.declaration.kind === "operation" &&
      field.declaration.wasmIntrinsic === undefined
    );
    if (interface_.imports.length !== operations.length) {
      throw new TypeError(
        `canonical ABI declares ${interface_.imports.length} imports for ${operations.length} host operations`,
      );
    }
    for (const imported of interface_.imports) {
      const field = operations.find((candidate) =>
        candidate.capability === imported.capability &&
        candidate.declaration.name === imported.operation
      );
      if (field === undefined) {
        throw new TypeError(
          `canonical ABI import ${
            JSON.stringify(`${imported.capability}.${imported.operation}`)
          } has no compiled host operation`,
        );
      }
      if (imported.function.parameters.length !== 1) {
        throw new TypeError(
          `canonical ABI host operation ${
            JSON.stringify(`${imported.capability}.${imported.operation}`)
          } must have one parameter`,
        );
      }
      this.validateCanonicalAbiConstructors(imported.function.parameters[0]!);
      this.validateCanonicalAbiConstructors(imported.function.result);
    }
  }

  validateCanonicalAbiConstructors(type: CanonicalAbiType): void {
    if (type.kind === "array") {
      this.validateCanonicalAbiConstructors(type.element);
      return;
    }
    if (type.kind === "sealed") {
      const constructor = this.requiredConstructorIndex(type.constructor);
      if (this.#module.constructorArities[constructor] !== 1) {
        throw new TypeError(
          `canonical ABI seal ${JSON.stringify(type.name)} constructor ${
            JSON.stringify(type.constructor)
          } must have one field`,
        );
      }
      this.validateCanonicalAbiConstructors(type.inner);
      return;
    }
    if (type.kind === "record") {
      const constructor = this.requiredConstructorIndex(type.constructor);
      if (this.#module.constructorArities[constructor] !== type.fields.length) {
        throw new TypeError(
          `canonical ABI record constructor ${
            JSON.stringify(type.constructor)
          } has ${type.fields.length} fields; compiled constructor has ${
            this.#module.constructorArities[constructor]
          }`,
        );
      }
      for (const field of type.fields) {
        this.validateCanonicalAbiConstructors(field.type);
      }
      return;
    }
    if (type.kind !== "variant") return;
    for (const case_ of type.cases) {
      const constructor = this.requiredConstructorIndex(case_.constructor);
      const expectedArity = case_.payload === undefined ? 0 : 1;
      if (this.#module.constructorArities[constructor] !== expectedArity) {
        throw new TypeError(
          `canonical ABI variant constructor ${
            JSON.stringify(case_.constructor)
          } has arity ${expectedArity}; compiled constructor has ${
            this.#module.constructorArities[constructor]
          }`,
        );
      }
      if (case_.payload !== undefined) {
        this.validateCanonicalAbiConstructors(case_.payload);
      }
    }
  }

  wasmExportSignature(exported: WasmExport): {
    readonly parameters: readonly Type[];
    readonly result: Type;
  } {
    const parameters: Type[] = [];
    let result = exported.type;
    while (result.kind === "function") {
      parameters.push(result.parameter);
      result = result.result;
    }
    for (const [index, parameter] of parameters.entries()) {
      requireFirstOrderWasmType(
        this.#module,
        parameter,
        `export ${exported.name} input ${index}`,
      );
    }
    requireFirstOrderWasmType(
      this.#module,
      result,
      `export ${exported.name} result`,
    );
    return { parameters, result };
  }

  compileDirectIntegerWasmExport(
    exported: WasmExport,
    parameters: readonly Type[],
    result: Type,
  ): WasmFunctionBody | undefined {
    if (
      this.#module.evaluationProfile !== EvaluationProfile.StrictEager ||
      exported.effects.size !== 0 ||
      this.#hostFields.length !== 0 ||
      this.#hasLazyEvaluationBoundary ||
      result.kind !== "integer" ||
      parameters.some((parameter) => parameter.kind !== "integer")
    ) return undefined;

    const rootNode = this.#module.definitionRoots[exported.definitionIndex];
    if (rootNode === undefined) {
      throw new Error(
        `functional WASM export ${
          JSON.stringify(exported.name)
        } definition d${exported.definitionIndex} exceeds ${this.#module.definitionCount} definitions`,
      );
    }
    if (parameters.length === 0) {
      const instructions = new WasmInstructions(0);
      this.compileIntegerExpression(instructions, rootNode, []);
      const callable = functionBody(
        this.functionTypeIndex([], [WasmValueType.I32]),
        instructions,
        `direct scalar export ${exported.name}`,
      );
      return callable.usesMemory || callable.usesIndirectCalls ? undefined : callable;
    }

    const functionShape = this.#functionAnalysis.function(rootNode);
    if (
      functionShape === undefined ||
      functionShape.parameterCount !== parameters.length
    ) return undefined;

    if (this.uncurriedWorkerHasEnvironmentParameter(functionShape, undefined)) {
      return undefined;
    }
    this.#nativeIntegerFunctionNodes.add(functionShape.outerLambdaNode);
    const worker = this.uncurriedWorker(functionShape, undefined, "integer");
    const workerBody = this.#indirectFunctions[worker.slot];
    if (workerBody === undefined) {
      throw new Error(
        `functional WASM direct export ${
          JSON.stringify(exported.name)
        } omitted worker slot ${worker.slot}`,
      );
    }
    if (workerBody.usesMemory || workerBody.usesIndirectCalls) {
      this.#nativeIntegerFunctionNodes.delete(functionShape.outerLambdaNode);
      return undefined;
    }

    const instructions = new WasmInstructions(parameters.length);
    const arguments_: number[] = [];
    for (let parameter = 0; parameter < parameters.length; parameter += 1) {
      instructions.localGet(parameter);
      this.emitDecodeInteger(instructions);
      const argument = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(argument);
      arguments_.push(argument);
    }
    for (const argument of arguments_) instructions.localGet(argument);
    instructions.call(this.indirectFunctionOffset() + worker.slot);
    this.#specializedCallSiteCount += 1;
    return functionBody(
      this.functionTypeIndex(
        parameters.map(() => WasmValueType.I64),
        [WasmValueType.I32],
      ),
      instructions,
      `direct scalar export ${exported.name}`,
    );
  }

  compileGeneralWasmExport(
    exported: WasmExport,
    parameters: readonly Type[],
    result: Type,
    initializeFunctionIndex: number,
  ): WasmFunctionBody {
    const instructions = new WasmInstructions(parameters.length);
    instructions.call(initializeFunctionIndex);
    instructions.emit(0x1a);
    this.emitGlobalReference(instructions, exported.definitionIndex);
    for (let index = 0; index < parameters.length; index += 1) {
      instructions.emit(0xa7);
      const closure = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(closure);
      instructions.localGet(closure);
      instructions.localGet(index);
      instructions.localGet(closure);
      instructions.i32Load(4);
      instructions.callIndirect(WasmFunctionTypeIndex.ClosureCall);
    }
    this.emitPublicResult(instructions, result);
    const scalarResult = functionalHostScalarType(result);
    const resultType = scalarResult === undefined ? WasmValueType.I64 : wasmValueType(scalarResult);
    return functionBody(
      this.functionTypeIndex(
        parameters.map(() => WasmValueType.I64),
        [resultType],
      ),
      instructions,
      `export ${exported.name}`,
    );
  }

  compileCanonicalWasmExport(
    exported: WasmExport,
    canonical: CanonicalAbiExport,
    initializeFunctionIndex: number,
  ): WasmFunctionBody {
    const signature = canonicalAbiCoreSignature(canonical.function, "export");
    const instructions = new WasmInstructions(signature.parameters.length);
    instructions.call(initializeFunctionIndex);
    instructions.emit(0x1a);

    const parameterRecord = canonicalAbiParameterRecord(
      canonical.function.parameters,
    );
    const parameterLayout = canonicalAbiRecordLayout(parameterRecord);
    let parameterPointer: number;
    let ownsParameterRecord = false;
    if (signature.indirectParameters) {
      parameterPointer = 0;
      this.emitCanonicalPointerAlignmentGuard(
        instructions,
        parameterPointer,
        parameterLayout.alignment,
      );
    } else {
      parameterPointer = this.allocateCanonicalRecord(
        instructions,
        parameterLayout.byteLength,
      );
      ownsParameterRecord = parameterLayout.byteLength > 0;
      this.emitCanonicalStoreFlat(
        instructions,
        parameterRecord,
        parameterPointer,
        0,
        signature.parameters.map(canonicalWasmValueType),
        0,
      );
    }

    this.emitGlobalReference(instructions, exported.definitionIndex);
    for (const field of parameterLayout.fields) {
      instructions.emit(0xa7);
      const closure = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(closure);
      instructions.localGet(closure);
      this.emitCanonicalLiftMemory(
        instructions,
        field.type,
        parameterPointer,
        field.offset,
      );
      instructions.localGet(closure);
      instructions.i32Load(4);
      instructions.callIndirect(WasmFunctionTypeIndex.ClosureCall);
    }
    const result = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(result);
    if (ownsParameterRecord) {
      this.freeCanonicalRecord(
        instructions,
        parameterPointer,
        parameterLayout.byteLength,
      );
    }

    const resultLayout = canonicalAbiLayout(canonical.function.result);
    if (signature.indirectResult) {
      const resultPointer = this.allocateCanonicalRecord(
        instructions,
        resultLayout.byteLength,
      );
      this.emitCanonicalStoreMemory(
        instructions,
        canonical.function.result,
        result,
        resultPointer,
        0,
      );
      instructions.localGet(resultPointer);
    } else {
      this.emitCanonicalLowerDirectResult(
        instructions,
        canonical.function.result,
        result,
      );
    }
    return functionBody(
      this.functionTypeIndex(
        signature.parameters.map(canonicalWasmValueType),
        signature.results.map(canonicalWasmValueType),
      ),
      instructions,
      `canonical ABI export ${canonical.name}`,
    );
  }

  compileCanonicalPostReturn(
    canonical: CanonicalAbiExport,
  ): WasmFunctionBody {
    const signature = canonicalAbiCoreSignature(canonical.function, "export");
    if (!signature.indirectResult) {
      throw new Error(
        `canonical ABI export ${JSON.stringify(canonical.name)} does not need post-return`,
      );
    }
    const layout = canonicalAbiLayout(canonical.function.result);
    const instructions = new WasmInstructions(1);
    this.emitCanonicalCleanupMemory(
      instructions,
      canonical.function.result,
      0,
      0,
    );
    this.freeCanonicalRecord(instructions, 0, layout.byteLength);
    return functionBody(
      this.functionTypeIndex([WasmValueType.I32], []),
      instructions,
      `canonical ABI post-return ${canonical.name}`,
    );
  }

  emitCanonicalLowerDirectResult(
    instructions: WasmInstructions,
    type: CanonicalAbiType,
    value: number,
  ): void {
    if (type.kind === "sealed") {
      instructions.localGet(value);
      this.emitForceValue(instructions);
      instructions.emit(0xa7);
      instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
      const inner = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(inner);
      this.emitCanonicalLowerDirectResult(instructions, type.inner, inner);
      return;
    }
    if (type.kind === "unit") return;
    instructions.localGet(value);
    this.emitForceValue(instructions);
    if (type.kind === "signed-integer-64") {
      this.emitUnboxSignedInteger64(instructions);
      return;
    }
    if (type.kind === "boolean") {
      this.emitDecodeBoolean(instructions);
      return;
    }
    if (type.kind === "variant") {
      if (type.cases.some((case_) => case_.payload !== undefined)) {
        throw new Error(
          "canonical ABI direct variant result unexpectedly carries a payload",
        );
      }
      instructions.emit(0xa7);
      const constructor = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(constructor);
      this.emitCanonicalVariantDiscriminant(instructions, type, constructor);
      return;
    }
    throw new Error(
      `canonical ABI ${type.kind} result unexpectedly flattened directly`,
    );
  }

  allocateCanonicalRecord(
    instructions: WasmInstructions,
    byteLength: number,
  ): number {
    if (byteLength === 0) {
      const empty = instructions.addLocal(WasmValueType.I32);
      instructions.i32Const(0);
      instructions.localSet(empty);
      return empty;
    }
    instructions.i32Const(byteLength + OBJECT_HEADER_BYTE_LENGTH);
    instructions.call(this.allocateFunctionIndex());
    const base = instructions.addLocal(WasmValueType.I32);
    instructions.localTee(base);
    instructions.i32Const(byteLength + OBJECT_HEADER_BYTE_LENGTH);
    instructions.i32Store(8);
    instructions.localGet(base);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(pointer);
    return pointer;
  }

  allocateCanonicalDynamic(
    instructions: WasmInstructions,
    byteLength: number,
  ): number {
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(byteLength);
    instructions.i32Const(
      WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH - OBJECT_HEADER_BYTE_LENGTH,
    );
    instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
    instructions.localGet(byteLength);
    instructions.emit(0x04, 0x40);
    instructions.localGet(byteLength);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.call(this.allocateFunctionIndex());
    const base = instructions.addLocal(WasmValueType.I32);
    instructions.localTee(base);
    instructions.localGet(byteLength);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.i32Store(8);
    instructions.localGet(base);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localSet(pointer);
    instructions.emit(0x05);
    instructions.i32Const(0);
    instructions.localSet(pointer);
    instructions.emit(0x0b);
    return pointer;
  }

  freeCanonicalRecord(
    instructions: WasmInstructions,
    pointer: number,
    byteLength: number,
  ): void {
    if (byteLength === 0) return;
    instructions.localGet(pointer);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6b);
    instructions.i32Const(byteLength + OBJECT_HEADER_BYTE_LENGTH);
    instructions.call(this.#functionImports.length + 2);
  }

  freeCanonicalDynamic(
    instructions: WasmInstructions,
    pointer: number,
    byteLength: number,
  ): void {
    instructions.localGet(byteLength);
    instructions.emit(0x04, 0x40);
    instructions.localGet(pointer);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6b);
    instructions.localGet(byteLength);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.call(this.#functionImports.length + 2);
    instructions.emit(0x0b);
  }

  emitCanonicalStoreFlat(
    instructions: WasmInstructions,
    type: CanonicalAbiType,
    pointer: number,
    offset: number,
    sourceTypes: readonly number[],
    firstSource: number,
  ): number {
    if (type.kind === "sealed") {
      return this.emitCanonicalStoreFlat(
        instructions,
        type.inner,
        pointer,
        offset,
        sourceTypes,
        firstSource,
      );
    }
    if (type.kind === "unit") return firstSource;
    if (type.kind === "signed-integer-64") {
      instructions.localGet(pointer);
      instructions.localGet(firstSource);
      instructions.i64Store(offset);
      return firstSource + 1;
    }
    if (type.kind === "boolean") {
      instructions.localGet(pointer);
      instructions.localGet(firstSource);
      if (sourceTypes[firstSource] === WasmValueType.I64) instructions.emit(0xa7);
      instructions.i32Store8(offset);
      return firstSource + 1;
    }
    if (type.kind === "text" || type.kind === "array") {
      instructions.localGet(pointer);
      instructions.localGet(firstSource);
      instructions.i32Store(offset);
      instructions.localGet(pointer);
      instructions.localGet(firstSource + 1);
      instructions.i32Store(offset + 4);
      return firstSource + 2;
    }
    if (type.kind === "record") {
      let source = firstSource;
      for (const field of canonicalAbiRecordLayout(type).fields) {
        source = this.emitCanonicalStoreFlat(
          instructions,
          field.type,
          pointer,
          offset + field.offset,
          sourceTypes,
          source,
        );
      }
      return source;
    }

    const layout = canonicalAbiVariantLayout(type);
    instructions.localGet(pointer);
    instructions.localGet(firstSource);
    this.emitCanonicalStoreDiscriminant(
      instructions,
      offset,
      layout.discriminantByteLength,
    );
    const joinedPayload = flattenCanonicalAbiType(type).slice(1);
    instructions.emit(0x02, 0x40);
    for (const [caseIndex, case_] of type.cases.entries()) {
      instructions.localGet(firstSource);
      instructions.i32Const(caseIndex);
      instructions.emit(0x46, 0x04, 0x40);
      if (case_.payload !== undefined) {
        this.emitCanonicalStoreFlat(
          instructions,
          case_.payload,
          pointer,
          offset + layout.payloadOffset,
          sourceTypes,
          firstSource + 1,
        );
      }
      instructions.branch(1);
      instructions.emit(0x0b);
    }
    instructions.emit(0x00, 0x0b);
    return firstSource + 1 + joinedPayload.length;
  }

  emitCanonicalStoreDiscriminant(
    instructions: WasmInstructions,
    offset: number,
    byteLength: 1 | 2 | 4,
  ): void {
    if (byteLength === 1) {
      instructions.i32Store8(offset);
      return;
    }
    if (byteLength === 2) {
      instructions.i32Store16(offset);
      return;
    }
    instructions.i32Store(offset);
  }

  emitCanonicalLoadDiscriminant(
    instructions: WasmInstructions,
    pointer: number,
    offset: number,
    byteLength: 1 | 2 | 4,
  ): void {
    instructions.localGet(pointer);
    if (byteLength === 1) {
      instructions.i32Load8Unsigned(offset);
      return;
    }
    if (byteLength === 2) {
      instructions.i32Load16Unsigned(offset);
      return;
    }
    instructions.i32Load(offset);
  }

  emitCanonicalLiftMemory(
    instructions: WasmInstructions,
    type: CanonicalAbiType,
    pointer: number,
    offset: number,
  ): void {
    if (type.kind === "sealed") {
      this.emitCanonicalLiftMemory(
        instructions,
        type.inner,
        pointer,
        offset,
      );
      const inner = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(inner);
      this.emitConstructor(
        instructions,
        this.requiredConstructorIndex(type.constructor),
        [{ kind: "i64-local", index: inner }],
      );
      return;
    }
    if (type.kind === "unit") {
      this.emitCanonicalUnit(instructions);
      return;
    }
    if (type.kind === "signed-integer-64") {
      instructions.localGet(pointer);
      instructions.i64Load(offset);
      this.emitBoxSignedInteger64(instructions);
      return;
    }
    if (type.kind === "boolean") {
      instructions.localGet(pointer);
      instructions.i32Load8Unsigned(offset);
      const boolean = instructions.addLocal(WasmValueType.I32);
      instructions.localTee(boolean);
      instructions.i32Const(1);
      instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
      instructions.localGet(boolean);
      this.emitEncodeBoolean(instructions);
      return;
    }
    if (type.kind === "text") {
      this.emitCanonicalLiftText(instructions, pointer, offset);
      return;
    }
    if (type.kind === "array") {
      this.emitCanonicalLiftArray(instructions, type.element, pointer, offset);
      return;
    }
    if (type.kind === "record") {
      const fields: (ValueSource | undefined)[] = type.fields.map(() => undefined);
      for (const field of canonicalAbiRecordLayout(type).fields) {
        this.emitCanonicalLiftMemory(
          instructions,
          field.type,
          pointer,
          offset + field.offset,
        );
        const fieldValue = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(fieldValue);
        fields[field.coreIndex] = {
          kind: "i64-local",
          index: fieldValue,
        };
      }
      const constructorFields = fields.map((field, index) => {
        if (field !== undefined) return field;
        throw new Error(
          `canonical ABI record ${type.constructor} omitted Core field ${index}`,
        );
      });
      this.emitConstructor(
        instructions,
        this.requiredConstructorIndex(type.constructor),
        constructorFields,
      );
      return;
    }

    const layout = canonicalAbiVariantLayout(type);
    this.emitCanonicalLoadDiscriminant(
      instructions,
      pointer,
      offset,
      layout.discriminantByteLength,
    );
    const discriminant = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(discriminant);
    const result = instructions.addLocal(WasmValueType.I64);
    instructions.emit(0x02, 0x40);
    for (const [caseIndex, case_] of type.cases.entries()) {
      instructions.localGet(discriminant);
      instructions.i32Const(caseIndex);
      instructions.emit(0x46, 0x04, 0x40);
      const fields: ValueSource[] = [];
      if (case_.payload !== undefined) {
        this.emitCanonicalLiftMemory(
          instructions,
          case_.payload,
          pointer,
          offset + layout.payloadOffset,
        );
        const payload = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(payload);
        fields.push({ kind: "i64-local", index: payload });
      }
      this.emitConstructor(
        instructions,
        this.requiredConstructorIndex(case_.constructor),
        fields,
      );
      instructions.localSet(result);
      instructions.branch(1);
      instructions.emit(0x0b);
    }
    instructions.emit(0x00, 0x0b);
    instructions.localGet(result);
  }

  emitCanonicalLiftText(
    instructions: WasmInstructions,
    pointer: number,
    offset: number,
  ): void {
    instructions.localGet(pointer);
    instructions.i32Load(offset);
    const bytes = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(bytes);
    instructions.localGet(pointer);
    instructions.i32Load(offset + 4);
    const byteLength = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(byteLength);
    this.emitRequireCanonicalUtf8(instructions, bytes, byteLength);
    instructions.localGet(byteLength);
    instructions.i32Const(
      WASM_MAXIMUM_ALLOCATION_BYTE_LENGTH - OBJECT_HEADER_BYTE_LENGTH,
    );
    instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
    instructions.localGet(byteLength);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.call(this.allocateFunctionIndex());
    const text = instructions.addLocal(WasmValueType.I32);
    instructions.localTee(text);
    instructions.i32Const(TEXT_OBJECT_KIND);
    instructions.i32Store(0);
    instructions.localGet(text);
    instructions.localGet(byteLength);
    instructions.i32Store(8);
    instructions.localGet(text);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(bytes);
    instructions.localGet(byteLength);
    instructions.memoryCopy();
    instructions.localGet(text);
    instructions.emit(0xad);
  }

  emitRequireCanonicalUtf8(
    instructions: WasmInstructions,
    bytes: number,
    byteLength: number,
  ): void {
    const index = instructions.addLocal(WasmValueType.I32);
    const lead = instructions.addLocal(WasmValueType.I32);
    const sequenceLength = instructions.addLocal(WasmValueType.I32);
    const minimumSecond = instructions.addLocal(WasmValueType.I32);
    const maximumSecond = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(index);
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(index);
    instructions.localGet(byteLength);
    instructions.emit(0x4f);
    instructions.branchIf(1);
    instructions.localGet(bytes);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(0);
    instructions.localTee(lead);
    instructions.i32Const(0x80);
    instructions.emit(0x49, 0x04, 0x40);
    instructions.localGet(index);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(1);
    instructions.emit(0x0b);

    instructions.emit(0x02, 0x40);
    this.emitCanonicalUtf8LeadCase(
      instructions,
      lead,
      0xc2,
      0xdf,
      2,
      0x80,
      0xbf,
      sequenceLength,
      minimumSecond,
      maximumSecond,
    );
    this.emitCanonicalUtf8LeadCase(
      instructions,
      lead,
      0xe0,
      0xe0,
      3,
      0xa0,
      0xbf,
      sequenceLength,
      minimumSecond,
      maximumSecond,
    );
    this.emitCanonicalUtf8LeadCase(
      instructions,
      lead,
      0xe1,
      0xec,
      3,
      0x80,
      0xbf,
      sequenceLength,
      minimumSecond,
      maximumSecond,
    );
    this.emitCanonicalUtf8LeadCase(
      instructions,
      lead,
      0xed,
      0xed,
      3,
      0x80,
      0x9f,
      sequenceLength,
      minimumSecond,
      maximumSecond,
    );
    this.emitCanonicalUtf8LeadCase(
      instructions,
      lead,
      0xee,
      0xef,
      3,
      0x80,
      0xbf,
      sequenceLength,
      minimumSecond,
      maximumSecond,
    );
    this.emitCanonicalUtf8LeadCase(
      instructions,
      lead,
      0xf0,
      0xf0,
      4,
      0x90,
      0xbf,
      sequenceLength,
      minimumSecond,
      maximumSecond,
    );
    this.emitCanonicalUtf8LeadCase(
      instructions,
      lead,
      0xf1,
      0xf3,
      4,
      0x80,
      0xbf,
      sequenceLength,
      minimumSecond,
      maximumSecond,
    );
    this.emitCanonicalUtf8LeadCase(
      instructions,
      lead,
      0xf4,
      0xf4,
      4,
      0x80,
      0x8f,
      sequenceLength,
      minimumSecond,
      maximumSecond,
    );
    instructions.emit(0x00, 0x0b);

    instructions.localGet(index);
    instructions.localGet(sequenceLength);
    instructions.emit(0x6a);
    instructions.localGet(byteLength);
    instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
    instructions.localGet(bytes);
    instructions.localGet(index);
    instructions.emit(0x6a);
    instructions.i32Load8Unsigned(1);
    const second = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(second);
    instructions.localGet(second);
    instructions.localGet(minimumSecond);
    instructions.emit(0x49);
    instructions.localGet(second);
    instructions.localGet(maximumSecond);
    instructions.emit(0x4b, 0x72, 0x04, 0x40, 0x00, 0x0b);
    for (let continuation = 2; continuation < 4; continuation += 1) {
      instructions.localGet(sequenceLength);
      instructions.i32Const(continuation);
      instructions.emit(0x4b, 0x04, 0x40);
      instructions.localGet(bytes);
      instructions.localGet(index);
      instructions.emit(0x6a);
      instructions.i32Load8Unsigned(continuation);
      instructions.i32Const(0xc0);
      instructions.emit(0x71);
      instructions.i32Const(0x80);
      instructions.emit(0x47, 0x04, 0x40, 0x00, 0x0b);
      instructions.emit(0x0b);
    }
    instructions.localGet(index);
    instructions.localGet(sequenceLength);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);
  }

  emitCanonicalUtf8LeadCase(
    instructions: WasmInstructions,
    lead: number,
    minimumLead: number,
    maximumLead: number,
    sequenceByteLength: number,
    minimumSecondByte: number,
    maximumSecondByte: number,
    sequenceLength: number,
    minimumSecond: number,
    maximumSecond: number,
  ): void {
    instructions.localGet(lead);
    instructions.i32Const(minimumLead);
    instructions.emit(0x4f);
    instructions.localGet(lead);
    instructions.i32Const(maximumLead);
    instructions.emit(0x4d, 0x71, 0x04, 0x40);
    instructions.i32Const(sequenceByteLength);
    instructions.localSet(sequenceLength);
    instructions.i32Const(minimumSecondByte);
    instructions.localSet(minimumSecond);
    instructions.i32Const(maximumSecondByte);
    instructions.localSet(maximumSecond);
    instructions.branch(1);
    instructions.emit(0x0b);
  }

  emitCanonicalLiftArray(
    instructions: WasmInstructions,
    element: CanonicalAbiType,
    pointer: number,
    offset: number,
  ): void {
    instructions.localGet(pointer);
    instructions.i32Load(offset);
    const elements = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(elements);
    instructions.localGet(pointer);
    instructions.i32Load(offset + 4);
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(length);
    const layout = canonicalAbiLayout(element);
    this.emitCanonicalPointerAlignmentGuard(
      instructions,
      elements,
      layout.alignment,
    );
    instructions.localGet(length);
    instructions.i32Const(MAXIMUM_STORE_LENGTH);
    instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
    if (layout.byteLength > 0) {
      instructions.localGet(length);
      instructions.i32Const(Math.floor(0xffff_ffff / layout.byteLength));
      instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
    }
    const store = this.allocateStore(instructions, length);
    const index = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(index);
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(index);
    instructions.localGet(length);
    instructions.emit(0x4f);
    instructions.branchIf(1);
    this.emitCanonicalLiftMemory(
      instructions,
      element,
      elements,
      0,
    );
    const value = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(value);
    instructions.localGet(store);
    instructions.localGet(index);
    instructions.i32Const(3);
    instructions.emit(0x74, 0x6a);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(value);
    instructions.i64Store(0);
    if (layout.byteLength > 0) {
      instructions.localGet(elements);
      instructions.i32Const(layout.byteLength);
      instructions.emit(0x6a);
      instructions.localSet(elements);
    }
    instructions.localGet(index);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);
    instructions.localGet(store);
    instructions.emit(0xad);
  }

  emitCanonicalPointerAlignmentGuard(
    instructions: WasmInstructions,
    pointer: number,
    alignment: number,
  ): void {
    if (alignment <= 1) return;
    instructions.localGet(pointer);
    instructions.i32Const(alignment - 1);
    instructions.emit(0x71, 0x04, 0x40, 0x00, 0x0b);
  }

  emitCanonicalStoreMemory(
    instructions: WasmInstructions,
    type: CanonicalAbiType,
    value: number,
    pointer: number,
    offset: number,
  ): void {
    instructions.localGet(value);
    this.emitForceValue(instructions);
    const forced = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(forced);
    if (type.kind === "sealed") {
      instructions.localGet(forced);
      instructions.emit(0xa7);
      instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
      const inner = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(inner);
      this.emitCanonicalStoreMemory(
        instructions,
        type.inner,
        inner,
        pointer,
        offset,
      );
      return;
    }
    if (type.kind === "unit") return;
    if (type.kind === "signed-integer-64") {
      instructions.localGet(pointer);
      instructions.localGet(forced);
      this.emitUnboxSignedInteger64(instructions);
      instructions.i64Store(offset);
      return;
    }
    if (type.kind === "boolean") {
      instructions.localGet(pointer);
      instructions.localGet(forced);
      this.emitDecodeBoolean(instructions);
      instructions.i32Store8(offset);
      return;
    }
    if (type.kind === "text") {
      this.emitCanonicalStoreText(instructions, forced, pointer, offset);
      return;
    }
    if (type.kind === "array") {
      this.emitCanonicalStoreArray(
        instructions,
        type.element,
        forced,
        pointer,
        offset,
      );
      return;
    }

    instructions.localGet(forced);
    instructions.emit(0xa7);
    const constructor = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(constructor);
    if (type.kind === "record") {
      const expected = this.requiredConstructorIndex(type.constructor);
      instructions.localGet(constructor);
      instructions.i32Load(4);
      instructions.i32Const(expected);
      instructions.emit(0x47, 0x04, 0x40, 0x00, 0x0b);
      for (const field of canonicalAbiRecordLayout(type).fields) {
        instructions.localGet(constructor);
        instructions.i64Load(
          OBJECT_HEADER_BYTE_LENGTH + field.coreIndex * VALUE_BYTE_LENGTH,
        );
        const fieldValue = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(fieldValue);
        this.emitCanonicalStoreMemory(
          instructions,
          field.type,
          fieldValue,
          pointer,
          offset + field.offset,
        );
      }
      return;
    }

    const layout = canonicalAbiVariantLayout(type);
    instructions.emit(0x02, 0x40);
    for (const [caseIndex, case_] of type.cases.entries()) {
      instructions.localGet(constructor);
      instructions.i32Load(4);
      instructions.i32Const(this.requiredConstructorIndex(case_.constructor));
      instructions.emit(0x46, 0x04, 0x40);
      instructions.localGet(pointer);
      instructions.i32Const(caseIndex);
      this.emitCanonicalStoreDiscriminant(
        instructions,
        offset,
        layout.discriminantByteLength,
      );
      if (case_.payload !== undefined) {
        instructions.localGet(constructor);
        instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
        const payload = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(payload);
        this.emitCanonicalStoreMemory(
          instructions,
          case_.payload,
          payload,
          pointer,
          offset + layout.payloadOffset,
        );
      }
      instructions.branch(1);
      instructions.emit(0x0b);
    }
    instructions.emit(0x00, 0x0b);
  }

  emitCanonicalStoreText(
    instructions: WasmInstructions,
    value: number,
    pointer: number,
    offset: number,
  ): void {
    instructions.localGet(value);
    instructions.emit(0xa7);
    const text = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(text);
    instructions.localGet(text);
    instructions.i32Load(8);
    const byteLength = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(byteLength);
    const bytes = this.allocateCanonicalDynamic(instructions, byteLength);
    instructions.localGet(bytes);
    instructions.localGet(text);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(byteLength);
    instructions.memoryCopy();
    instructions.localGet(pointer);
    instructions.localGet(bytes);
    instructions.i32Store(offset);
    instructions.localGet(pointer);
    instructions.localGet(byteLength);
    instructions.i32Store(offset + 4);
  }

  emitCanonicalStoreArray(
    instructions: WasmInstructions,
    element: CanonicalAbiType,
    value: number,
    pointer: number,
    offset: number,
  ): void {
    instructions.localGet(value);
    instructions.emit(0xa7);
    const store = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(store);
    instructions.localGet(store);
    instructions.i32Load(8);
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(length);
    const elementLayout = canonicalAbiLayout(element);
    if (elementLayout.byteLength > 0) {
      instructions.localGet(length);
      instructions.i32Const(
        Math.floor(0xffff_ffff / elementLayout.byteLength),
      );
      instructions.emit(0x4b, 0x04, 0x40, 0x00, 0x0b);
    }
    instructions.localGet(length);
    instructions.i32Const(elementLayout.byteLength);
    instructions.emit(0x6c);
    const byteLength = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(byteLength);
    const elements = this.allocateCanonicalDynamic(instructions, byteLength);
    const index = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(index);
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(index);
    instructions.localGet(length);
    instructions.emit(0x4f);
    instructions.branchIf(1);
    instructions.localGet(store);
    instructions.localGet(index);
    instructions.i32Const(3);
    instructions.emit(0x74, 0x6a);
    instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
    const elementValue = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(elementValue);
    this.emitCanonicalStoreMemory(
      instructions,
      element,
      elementValue,
      elements,
      0,
    );
    if (elementLayout.byteLength > 0) {
      instructions.localGet(elements);
      instructions.i32Const(elementLayout.byteLength);
      instructions.emit(0x6a);
      instructions.localSet(elements);
    }
    instructions.localGet(index);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);
    instructions.localGet(elements);
    instructions.localGet(length);
    instructions.i32Const(elementLayout.byteLength);
    instructions.emit(0x6c, 0x6b);
    const firstElement = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(firstElement);
    instructions.localGet(pointer);
    instructions.localGet(firstElement);
    instructions.i32Store(offset);
    instructions.localGet(pointer);
    instructions.localGet(length);
    instructions.i32Store(offset + 4);
  }

  emitCanonicalCleanupMemory(
    instructions: WasmInstructions,
    type: CanonicalAbiType,
    pointer: number,
    offset: number,
  ): void {
    if (type.kind === "sealed") {
      this.emitCanonicalCleanupMemory(
        instructions,
        type.inner,
        pointer,
        offset,
      );
      return;
    }
    if (
      type.kind === "unit" ||
      type.kind === "signed-integer-64" ||
      type.kind === "boolean"
    ) return;
    if (type.kind === "text") {
      instructions.localGet(pointer);
      instructions.i32Load(offset);
      const bytes = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(bytes);
      instructions.localGet(pointer);
      instructions.i32Load(offset + 4);
      const byteLength = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(byteLength);
      this.freeCanonicalDynamic(instructions, bytes, byteLength);
      return;
    }
    if (type.kind === "record") {
      for (const field of canonicalAbiRecordLayout(type).fields) {
        this.emitCanonicalCleanupMemory(
          instructions,
          field.type,
          pointer,
          offset + field.offset,
        );
      }
      return;
    }
    if (type.kind === "variant") {
      const layout = canonicalAbiVariantLayout(type);
      this.emitCanonicalLoadDiscriminant(
        instructions,
        pointer,
        offset,
        layout.discriminantByteLength,
      );
      const discriminant = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(discriminant);
      instructions.emit(0x02, 0x40);
      for (const [caseIndex, case_] of type.cases.entries()) {
        instructions.localGet(discriminant);
        instructions.i32Const(caseIndex);
        instructions.emit(0x46, 0x04, 0x40);
        if (case_.payload !== undefined) {
          this.emitCanonicalCleanupMemory(
            instructions,
            case_.payload,
            pointer,
            offset + layout.payloadOffset,
          );
        }
        instructions.branch(1);
        instructions.emit(0x0b);
      }
      instructions.emit(0x00, 0x0b);
      return;
    }

    instructions.localGet(pointer);
    instructions.i32Load(offset);
    const elements = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(elements);
    instructions.localGet(pointer);
    instructions.i32Load(offset + 4);
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(length);
    const elementLayout = canonicalAbiLayout(type.element);
    const index = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(index);
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(index);
    instructions.localGet(length);
    instructions.emit(0x4f);
    instructions.branchIf(1);
    this.emitCanonicalCleanupMemory(instructions, type.element, elements, 0);
    if (elementLayout.byteLength > 0) {
      instructions.localGet(elements);
      instructions.i32Const(elementLayout.byteLength);
      instructions.emit(0x6a);
      instructions.localSet(elements);
    }
    instructions.localGet(index);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(index);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);
    instructions.localGet(elements);
    instructions.localGet(length);
    instructions.i32Const(elementLayout.byteLength);
    instructions.emit(0x6c, 0x6b);
    const firstElement = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(firstElement);
    instructions.localGet(length);
    instructions.i32Const(elementLayout.byteLength);
    instructions.emit(0x6c);
    const byteLength = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(byteLength);
    this.freeCanonicalDynamic(instructions, firstElement, byteLength);
  }

  emitCanonicalVariantDiscriminant(
    instructions: WasmInstructions,
    type: Extract<CanonicalAbiType, { readonly kind: "variant" }>,
    constructor: number,
  ): void {
    instructions.emit(0x02, WasmValueType.I32);
    for (const [caseIndex, case_] of type.cases.entries()) {
      instructions.localGet(constructor);
      instructions.i32Load(4);
      instructions.i32Const(this.requiredConstructorIndex(case_.constructor));
      instructions.emit(0x46, 0x04, 0x40);
      instructions.i32Const(caseIndex);
      instructions.branch(1);
      instructions.emit(0x0b);
    }
    instructions.emit(0x00, 0x0b);
  }

  emitCanonicalUnit(instructions: WasmInstructions): void {
    const constructorIndex = this.requiredConstructorIndex(UNIT_CONSTRUCTOR_NAME);
    const offset = this.#nullaryConstructorOffsets[constructorIndex];
    if (offset === undefined) {
      throw new Error(
        `canonical ABI unit omitted its shared constructor slot for ${constructorIndex}`,
      );
    }
    instructions.i32Const(offset);
    instructions.i64Load(0);
  }

  emitPublicResult(
    instructions: WasmInstructions,
    result: Type,
  ): void {
    if (result.kind === "unit") {
      instructions.emit(0x1a);
      instructions.i32Const(0);
    } else if (result.kind === "integer" || result.kind === "boolean") {
      instructions.i64Const(3n);
      instructions.emit(0x87, 0xa7);
    } else if (result.kind === "signed-integer-64") {
      this.emitUnboxSignedInteger64(instructions);
    } else if (result.kind === "float-32") {
      this.emitUnboxFloat32(instructions);
    } else if (result.kind === "float-64") {
      this.emitUnboxFloat64(instructions);
    }
  }

  compileHostOperationClosures(): void {
    for (const field of this.#hostFields) {
      if (
        field.declaration.kind !== "operation" ||
        field.closureSlot === undefined
      ) continue;
      const instructions = new WasmInstructions(2);
      instructions.localGet(1);
      this.emitForceValue(instructions);
      if (field.declaration.wasmIntrinsic !== undefined) {
        this.#hostEmitter.emitIntrinsic(
          instructions,
          field.declaration.wasmIntrinsic,
          field.declaration.parameter,
          field.declaration.result,
        );
        this.#indirectFunctions[field.closureSlot] = functionBody(
          WasmFunctionTypeIndex.ClosureCall,
          instructions,
          `WASM intrinsic ${field.declaration.wasmIntrinsic}`,
        );
        continue;
      }
      if (field.importIndex === undefined) {
        throw new Error(
          `functional WASM host operation ${
            hostFieldKey(field.capability, field.declaration.name)
          } omitted its import`,
        );
      }
      if (field.canonicalAbi !== undefined) {
        this.emitCanonicalHostOperation(
          instructions,
          field.canonicalAbi,
          field.importIndex,
        );
        this.#indirectFunctions[field.closureSlot] = functionBody(
          WasmFunctionTypeIndex.ClosureCall,
          instructions,
          `canonical host operation ${hostFieldKey(field.capability, field.declaration.name)}`,
        );
        continue;
      }
      this.emitHostArgument(
        instructions,
        field.declaration.parameterRepresentation ?? field.declaration.parameter,
      );
      instructions.call(field.importIndex);
      this.emitHostResult(
        instructions,
        field.declaration.resultRepresentation ?? field.declaration.result,
      );
      this.#indirectFunctions[field.closureSlot] = functionBody(
        WasmFunctionTypeIndex.ClosureCall,
        instructions,
        `host operation ${hostFieldKey(field.capability, field.declaration.name)}`,
      );
    }
  }

  emitCanonicalHostOperation(
    instructions: WasmInstructions,
    canonical: CanonicalAbiImport,
    importIndex: number,
  ): void {
    if (canonical.function.parameters.length !== 1) {
      throw new TypeError(
        `canonical host operation ${
          JSON.stringify(`${canonical.capability}.${canonical.operation}`)
        } has ${canonical.function.parameters.length} parameters; gpufuck host operations are unary`,
      );
    }
    const signature = canonicalAbiCoreSignature(canonical.function, "import");
    const argumentType = canonical.function.parameters[0]!;
    const argumentLayout = canonicalAbiLayout(argumentType);
    const argument = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(argument);
    const argumentPointer = this.allocateCanonicalRecord(
      instructions,
      argumentLayout.byteLength,
    );
    this.emitCanonicalStoreMemory(
      instructions,
      argumentType,
      argument,
      argumentPointer,
      0,
    );

    if (signature.indirectParameters) {
      instructions.localGet(argumentPointer);
    } else {
      for (
        const local of this.emitCanonicalLoadFlatLocals(
          instructions,
          argumentType,
          argumentPointer,
          0,
        )
      ) {
        instructions.localGet(local);
      }
    }

    const resultLayout = canonicalAbiLayout(canonical.function.result);
    const resultPointer = this.allocateCanonicalRecord(
      instructions,
      resultLayout.byteLength,
    );
    if (signature.indirectResult) instructions.localGet(resultPointer);
    instructions.call(importIndex);

    if (!signature.indirectResult) {
      const resultLocals: number[] = [];
      for (const type of signature.results) {
        resultLocals.push(instructions.addLocal(canonicalWasmValueType(type)));
      }
      for (const local of [...resultLocals].reverse()) {
        instructions.localSet(local);
      }
      const sourceTypes: number[] = [];
      for (const [index, local] of resultLocals.entries()) {
        sourceTypes[local] = canonicalWasmValueType(signature.results[index]!);
      }
      this.emitCanonicalStoreFlat(
        instructions,
        canonical.function.result,
        resultPointer,
        0,
        sourceTypes,
        resultLocals[0] ?? 0,
      );
    }

    this.emitCanonicalCleanupMemory(
      instructions,
      argumentType,
      argumentPointer,
      0,
    );
    this.freeCanonicalRecord(
      instructions,
      argumentPointer,
      argumentLayout.byteLength,
    );
    this.emitCanonicalLiftMemory(
      instructions,
      canonical.function.result,
      resultPointer,
      0,
    );
    const result = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(result);
    this.emitCanonicalCleanupMemory(
      instructions,
      canonical.function.result,
      resultPointer,
      0,
    );
    this.freeCanonicalRecord(
      instructions,
      resultPointer,
      resultLayout.byteLength,
    );
    instructions.localGet(result);
  }

  emitCanonicalLoadFlatLocals(
    instructions: WasmInstructions,
    type: CanonicalAbiType,
    pointer: number,
    offset: number,
  ): number[] {
    if (type.kind === "sealed") {
      return this.emitCanonicalLoadFlatLocals(
        instructions,
        type.inner,
        pointer,
        offset,
      );
    }
    if (type.kind === "unit") return [];
    if (type.kind === "signed-integer-64") {
      instructions.localGet(pointer);
      instructions.i64Load(offset);
      const value = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(value);
      return [value];
    }
    if (type.kind === "boolean") {
      instructions.localGet(pointer);
      instructions.i32Load8Unsigned(offset);
      const value = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(value);
      return [value];
    }
    if (type.kind === "text" || type.kind === "array") {
      instructions.localGet(pointer);
      instructions.i32Load(offset);
      const address = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(address);
      instructions.localGet(pointer);
      instructions.i32Load(offset + 4);
      const length = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(length);
      return [address, length];
    }
    if (type.kind === "record") {
      const locals: number[] = [];
      for (const field of canonicalAbiRecordLayout(type).fields) {
        locals.push(...this.emitCanonicalLoadFlatLocals(
          instructions,
          field.type,
          pointer,
          offset + field.offset,
        ));
      }
      return locals;
    }

    const layout = canonicalAbiVariantLayout(type);
    this.emitCanonicalLoadDiscriminant(
      instructions,
      pointer,
      offset,
      layout.discriminantByteLength,
    );
    const discriminant = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(discriminant);
    const joinedTypes = flattenCanonicalAbiType(type).slice(1);
    const payloadLocals = joinedTypes.map((flatType) => {
      const local = instructions.addLocal(canonicalWasmValueType(flatType));
      if (flatType === "i64") instructions.i64Const(0n);
      else instructions.i32Const(0);
      instructions.localSet(local);
      return local;
    });
    instructions.emit(0x02, 0x40);
    for (const [caseIndex, case_] of type.cases.entries()) {
      instructions.localGet(discriminant);
      instructions.i32Const(caseIndex);
      instructions.emit(0x46, 0x04, 0x40);
      if (case_.payload !== undefined) {
        const caseLocals = this.emitCanonicalLoadFlatLocals(
          instructions,
          case_.payload,
          pointer,
          offset + layout.payloadOffset,
        );
        const caseTypes = flattenCanonicalAbiType(case_.payload);
        for (const [index, local] of caseLocals.entries()) {
          instructions.localGet(local);
          if (joinedTypes[index] === "i64" && caseTypes[index] === "i32") {
            instructions.emit(0xad);
          }
          instructions.localSet(payloadLocals[index]!);
        }
      }
      instructions.branch(1);
      instructions.emit(0x0b);
    }
    instructions.emit(0x00, 0x0b);
    return [discriminant, ...payloadLocals];
  }

  emitEntryCall(instructions: WasmInstructions): void {
    this.emitGlobalReference(instructions, this.#module.entryDefinition);
    if (this.#entry.parameter !== undefined) {
      instructions.emit(0xa7);
      const closure = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(closure);
      instructions.localGet(closure);
      instructions.localGet(0);
      instructions.localGet(closure);
      instructions.i32Load(4);
      instructions.callIndirect(WasmFunctionTypeIndex.ClosureCall);
      return;
    }
    if (!this.#entry.takesInit) return;
    instructions.emit(0xa7);
    const closure = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(closure);
    instructions.localGet(closure);
    this.emitHostInit(instructions);
    instructions.localGet(closure);
    instructions.i32Load(4);
    instructions.callIndirect(WasmFunctionTypeIndex.ClosureCall);
  }

  emitHostInit(instructions: WasmInstructions): void {
    const constructorIndex = this.#module.constructorNames.indexOf(
      INIT_CONSTRUCTOR_NAME,
    );
    if (constructorIndex < 0) {
      throw new Error(
        `functional WASM entry d${this.#module.entryDefinition} accepts ${INIT_TYPE_NAME} but the module omits constructor ${INIT_CONSTRUCTOR_NAME}`,
      );
    }
    const fields: ValueSource[] = [];
    for (const field of this.#hostFields) {
      this.emitHostFieldValue(instructions, field);
      const value = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(value);
      fields.push({ kind: "i64-local", index: value });
    }
    this.emitConstructor(instructions, constructorIndex, fields);
  }

  emitHostFieldValue(instructions: WasmInstructions, field: HostField): void {
    if (field.declaration.kind === "value") {
      if (field.declaration.wasmLiteral !== undefined) {
        this.#hostEmitter.emitLiteral(instructions, field.declaration.wasmLiteral, -1);
        return;
      }
      if (field.importIndex === undefined) {
        throw new Error(
          `functional WASM host value ${
            hostFieldKey(field.capability, field.declaration.name)
          } omitted its import`,
        );
      }
      instructions.call(field.importIndex);
      this.emitHostResult(
        instructions,
        field.declaration.representation ?? field.declaration.type,
      );
      return;
    }
    if (field.closureSlot === undefined) {
      throw new Error(
        `functional WASM host operation ${
          hostFieldKey(field.capability, field.declaration.name)
        } omitted its closure slot`,
      );
    }
    this.emitClosure(instructions, field.closureSlot, []);
  }

  compileGlobalThunks(): void {
    for (const [definitionIndex, slot] of this.#globalThunkSlots.entries()) {
      if (slot === undefined) continue;
      const instructions = new WasmInstructions(1);
      this.compileExpression(
        instructions,
        this.#module.definitionRoots[definitionIndex]!,
        [],
      );
      this.#indirectFunctions[slot] = functionBody(
        WasmFunctionTypeIndex.ThunkForce,
        instructions,
        `global thunk d${definitionIndex}`,
      );
    }
  }

  emitGlobalInitialization(instructions: WasmInstructions): void {
    instructions.i32Const(0);
    instructions.i64Load(0);
    instructions.emit(0x50, 0x04, 0x40);
    for (
      const [constructorIndex, offset] of this.#nullaryConstructorOffsets
        .entries()
    ) {
      if (offset === undefined) continue;
      instructions.i32Const(offset);
      this.emitConstructor(instructions, constructorIndex, []);
      instructions.i64Store(0);
    }
    for (
      const [definitionIndex, rootNode] of this.#module.definitionRoots
        .entries()
    ) {
      if (!this.#runtimeDefinitionIndices.has(definitionIndex)) continue;
      if (this.#directOnlyDefinitions.has(definitionIndex)) continue;
      instructions.i32Const(definitionIndex * VALUE_BYTE_LENGTH);
      const hostField = this.#hostDefinitionFields.get(definitionIndex);
      if (hostField !== undefined) {
        this.emitHostFieldValue(instructions, hostField);
        instructions.i64Store(0);
        continue;
      }
      const slot = this.#globalThunkSlots[definitionIndex];
      if (slot === undefined) {
        this.compileExpression(instructions, rootNode, []);
      } else {
        this.emitThunkObject(instructions, slot, []);
      }
      instructions.i64Store(0);
    }
    instructions.emit(0x0b);
  }

  emitGlobalReference(
    instructions: WasmInstructions,
    definitionIndex: number,
  ): void {
    if (this.#directOnlyDefinitions.has(definitionIndex)) {
      throw new Error(
        `functional WASM direct-only definition d${definitionIndex} escaped a saturated call`,
      );
    }
    instructions.i32Const(definitionIndex * VALUE_BYTE_LENGTH);
    instructions.i64Load(0);
    const root = this.#module.definitionRoots[definitionIndex]!;
    if (
      !this.#hostDefinitionFields.has(definitionIndex) &&
      !this.expressionIsWhnf(root)
    ) {
      this.emitForceValue(instructions);
    }
  }

  heapStart(): number {
    const nullaryConstructorCount =
      this.#nullaryConstructorOffsets.filter((offset) => offset !== undefined)
        .length;
    const globalByteLength = (this.#module.definitionCount + nullaryConstructorCount) *
      VALUE_BYTE_LENGTH;
    return Math.max(
      1_024,
      Math.ceil(globalByteLength / VALUE_BYTE_LENGTH) * VALUE_BYTE_LENGTH,
    );
  }

  compileExpression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
    constructorReuse?: ConstructorReuseTarget,
  ): void {
    this.#runtimeEmitter.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    if (this.#simdEnabled && node.tag === CoreTag.Apply) {
      const vectorKind = this.compileSimdVectorApplication(
        instructions,
        nodeIndex,
        environment,
      );
      if (vectorKind?.kind === "f32x4") {
        this.emitBoxF32x4(instructions, vectorKind.constructorName);
        return;
      }
      if (vectorKind?.kind === "mask32x4") {
        this.emitBoxMask32x4(instructions, vectorKind.constructorName);
        return;
      }
    }
    switch (node.tag) {
      case CoreTag.Integer:
        instructions.i64Const((BigInt(node.payload | 0) << 3n) | 1n);
        return;
      case CoreTag.SignedInteger64:
        this.compileSignedInteger64Expression(
          instructions,
          nodeIndex,
          environment,
        );
        this.emitBoxSignedInteger64(instructions);
        return;
      case CoreTag.Float32:
        this.compileFloat32Expression(instructions, nodeIndex, environment);
        this.emitBoxFloat32(instructions);
        return;
      case CoreTag.Float64:
        this.compileFloat64Expression(instructions, nodeIndex, environment);
        this.emitBoxFloat64(instructions);
        return;
      case CoreTag.WholeNumberF64:
        this.compileWholeNumberF64Expression(instructions, nodeIndex, environment);
        this.emitBoxFloat64(instructions);
        return;
      case CoreTag.BufferAppend: {
        const typeName = this.#module.typeNames[node.child2];
        if (typeName !== TEXT_TYPE_NAME && typeName !== BYTES_TYPE_NAME) {
          throw new Error(
            `functional WASM buffer append at core node ${nodeIndex} references non-buffer type ${
              JSON.stringify(typeName)
            } at index ${node.child2}`,
          );
        }
        const type: HostType = {
          kind: "named",
          name: typeName,
          arguments: [],
        };
        this.compileExpression(instructions, node.child0, environment);
        this.compileExpression(instructions, node.child1, environment);
        this.#hostEmitter.emitBufferAppendValues(instructions, type, nodeIndex);
        return;
      }
      case CoreTag.StoreEmpty:
        this.compileStoreEmpty(instructions);
        return;
      case CoreTag.StoreNew:
        this.compileStoreNew(instructions, node, nodeIndex, environment);
        return;
      case CoreTag.StoreLength:
        this.compileStoreLength(instructions, node, environment);
        return;
      case CoreTag.StoreRead:
        this.compileStoreRead(instructions, node, nodeIndex, environment);
        return;
      case CoreTag.StoreWrite:
      case CoreTag.StoreGrow:
        this.compileStoreUpdates(instructions, nodeIndex, environment);
        return;
      case CoreTag.Text:
      case CoreTag.Bytes: {
        const symbol = this.#module.symbolNames[node.payload];
        if (symbol === undefined) {
          throw new Error(
            `functional WASM literal at core node ${nodeIndex} references missing symbol ${node.payload}`,
          );
        }
        this.#hostEmitter.emitLiteral(
          instructions,
          node.tag === CoreTag.Text
            ? { kind: "text", value: symbol }
            : { kind: "bytes", value: functionalBytesFromLiteralSymbol(symbol) },
          nodeIndex,
        );
        return;
      }
      case CoreTag.RuntimeFault:
        this.#runtimeEmitter.emitFault(instructions, WASM_FAULT_EXPLICIT, nodeIndex);
        return;
      case CoreTag.Boolean:
        instructions.i64Const((BigInt(node.payload) << 3n) | 2n);
        return;
      case CoreTag.Local:
        {
          const source = this.localSource(environment, node.payload, nodeIndex);
          this.emitBinding(instructions, source);
          if (source.kind === "i64-local" || source.kind === "capture") {
            this.emitForceValue(instructions);
          }
        }
        return;
      case CoreTag.Global:
        if (node.payload >= this.#module.definitionCount) {
          throw new Error(
            `functional WASM global d${node.payload} at core node ${nodeIndex} exceeds ${this.#module.definitionCount} definitions`,
          );
        }
        this.emitGlobalReference(instructions, node.payload);
        return;
      case CoreTag.Constructor:
        this.compileConstructorReference(instructions, node.payload, nodeIndex);
        return;
      case CoreTag.Lambda:
        this.compileLambda(instructions, nodeIndex, environment);
        return;
      case CoreTag.Apply:
        this.compileApply(
          instructions,
          node,
          environment,
          nodeIndex,
          constructorReuse,
        );
        return;
      case CoreTag.Let:
        this.compileLet(instructions, node, environment, constructorReuse);
        return;
      case CoreTag.LetRec:
        this.compileLetRec(instructions, node, environment, nodeIndex);
        return;
      case CoreTag.If:
        this.compileIf(instructions, node, environment, constructorReuse);
        return;
      case CoreTag.Unary:
        this.compileUnary(instructions, node, environment, nodeIndex);
        return;
      case CoreTag.Binary:
        this.compileBinary(instructions, node, environment, nodeIndex);
        return;
      case CoreTag.NumericConvert:
        this.compileNumericConversionExpression(
          instructions,
          node,
          nodeIndex,
          environment,
        );
        return;
      case CoreTag.Case:
        this.compileCase(
          instructions,
          node,
          environment,
          nodeIndex,
          constructorReuse,
        );
        return;
      case CoreTag.CaseArm:
      case CoreTag.PatternBind:
        throw new Error(
          `functional WASM core node ${nodeIndex} has structural tag ${node.tag} in expression position`,
        );
    }
  }

  compileConstructorReference(
    instructions: WasmInstructions,
    constructorIndex: number,
    nodeIndex: number,
  ): void {
    const arity = this.#module.constructorArities[constructorIndex];
    if (arity === undefined) {
      throw new Error(
        `functional WASM constructor ${constructorIndex} at core node ${nodeIndex} exceeds ${this.#module.constructorCount} constructors`,
      );
    }
    if (arity === 0) {
      const offset = this.#nullaryConstructorOffsets[constructorIndex];
      if (offset === undefined) {
        throw new Error(
          `functional WASM nullary constructor ${constructorIndex} at core node ${nodeIndex} omitted its shared value slot`,
        );
      }
      instructions.i32Const(offset);
      instructions.i64Load(0);
      return;
    }
    this.emitClosure(
      instructions,
      this.constructorClosureSlot(constructorIndex, 0),
      [],
    );
  }

  constructorClosureSlot(constructorIndex: number, stage: number): number {
    const slots = this.#constructorClosureSlots[constructorIndex];
    if (slots === undefined || stage >= slots.length) {
      throw new Error(
        `functional WASM constructor ${constructorIndex} omitted application stage ${stage}`,
      );
    }
    const existing = slots[stage];
    if (existing !== undefined) return existing;

    const slot = this.reserveIndirectFunction();
    slots[stage] = slot;
    const instructions = new WasmInstructions(2);
    const fields: ValueSource[] = Array.from(
      { length: stage },
      (_, index) => ({
        kind: "capture",
        byteOffset: OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH,
      }),
    );
    fields.push({ kind: "i64-local", index: 1 });
    if (stage + 1 === slots.length) {
      this.emitConstructor(instructions, constructorIndex, fields);
    } else {
      this.emitClosure(
        instructions,
        this.constructorClosureSlot(constructorIndex, stage + 1),
        fields,
      );
    }
    this.#indirectFunctions[slot] = functionBody(
      WasmFunctionTypeIndex.ClosureCall,
      instructions,
      `constructor ${constructorIndex} stage ${stage}`,
    );
    return slot;
  }

  compileLambda(
    instructions: WasmInstructions,
    lambdaNode: number,
    environment: Environment,
  ): void {
    const lambda = this.node(lambdaNode);
    if (lambda.tag !== CoreTag.Lambda) {
      throw new Error(
        `functional WASM lambda compilation received core tag ${lambda.tag} at node ${lambdaNode}`,
      );
    }
    const slot = this.lambdaSlot(lambdaNode);
    const parameterCount = lambda.child1 === 0 ? 0 : 1;
    const captured = this.prunedCaptures(
      lambda.child0,
      parameterCount,
      environment,
      OBJECT_HEADER_BYTE_LENGTH,
    );
    this.emitClosure(instructions, slot, captured.captureSources);
  }

  compileApply(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    nodeIndex: number,
    constructorReuse?: ConstructorReuseTarget,
  ): void {
    if (node.payload === NO_INDEX) {
      this.compileZeroArityApply(instructions, node, environment, nodeIndex);
      return;
    }
    const uncurriedApplication = this.uncurriedApplication(
      nodeIndex,
      environment,
    );
    if (uncurriedApplication !== undefined) {
      this.compileUncurriedApplication(
        instructions,
        uncurriedApplication,
        environment,
      );
      return;
    }

    const constructorApplication = this.constructorApplication(nodeIndex);
    if (constructorApplication !== undefined) {
      const fields: ValueSource[] = [];
      for (const argument of constructorApplication.arguments) {
        const constantField = this.#instrumentedFuel
          ? undefined
          : this.scalarConstantBinding(argument.node, environment);
        if (constantField !== undefined) {
          fields.push(constantField);
          continue;
        }
        this.compileApplicationArgument(
          instructions,
          argument,
          environment,
          false,
        );
        const field = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(field);
        fields.push({ kind: "i64-local", index: field });
      }
      const arity = this.#module
        .constructorArities[constructorApplication.constructorIndex]!;
      if (fields.length === arity) {
        this.emitConstructor(
          instructions,
          constructorApplication.constructorIndex,
          fields,
          constructorReuse,
        );
      } else {
        this.emitClosure(
          instructions,
          this.constructorClosureSlot(
            constructorApplication.constructorIndex,
            fields.length,
          ),
          fields,
        );
      }
      return;
    }

    const virtualCallee = this.virtualLambda(node.child0, environment);
    if (virtualCallee !== undefined) {
      this.compileVirtualLambdaApplication(
        instructions,
        virtualCallee,
        node.child1,
        node.evaluationMode,
        environment,
      );
      return;
    }

    const callee = this.node(node.child0);
    if (callee.tag === CoreTag.Lambda) {
      this.compileApplicationArgument(
        instructions,
        { node: node.child1, evaluationMode: node.evaluationMode },
        environment,
        this.immediatelyForcesLocal(callee.child0, 0),
      );
      const argument = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(argument);
      this.compileExpression(
        instructions,
        callee.child0,
        [{ kind: "i64-local", index: argument }, ...environment],
      );
      return;
    }

    const lambdaSet = this.lambdaSet(node.child0);
    if (lambdaSet.complete && lambdaSet.lambdaNodes.length > 0) {
      this.compileExpression(instructions, node.child0, environment);
      instructions.emit(0xa7);
      const closure = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(closure);
      this.compileApplicationArgument(
        instructions,
        { node: node.child1, evaluationMode: node.evaluationMode },
        environment,
        this.lambdaSetImmediatelyForcesArgument(lambdaSet.lambdaNodes),
      );
      const argument = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(argument);
      this.emitLambdaSetCall(
        instructions,
        closure,
        argument,
        lambdaSet.lambdaNodes,
      );
      return;
    }

    this.compileExpression(instructions, node.child0, environment);
    instructions.emit(0xa7);
    const closure = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(closure);
    instructions.localGet(closure);
    this.compileApplicationArgument(
      instructions,
      { node: node.child1, evaluationMode: node.evaluationMode },
      environment,
      this.calleeImmediatelyForcesArgument(node.child0),
    );
    instructions.localGet(closure);
    instructions.i32Load(4);
    instructions.callIndirect(WasmFunctionTypeIndex.ClosureCall);
  }

  compileZeroArityApply(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    nodeIndex: number,
  ): void {
    const virtualCallee = this.virtualLambda(node.child0, environment);
    if (virtualCallee !== undefined) {
      const lambda = this.node(virtualCallee.node);
      if (lambda.tag === CoreTag.Lambda && lambda.child1 === 0) {
        this.compileExpression(instructions, lambda.child0, virtualCallee.environment);
        return;
      }
    }

    this.compileExpression(instructions, node.child0, environment);
    instructions.emit(0xa7);
    const closure = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(closure);
    instructions.localGet(closure);
    const unitConstructor = this.#module.constructorNames.indexOf("$Unit");
    const unitOffset = this.#nullaryConstructorOffsets[unitConstructor];
    if (unitConstructor < 0 || unitOffset === undefined) {
      throw new Error(
        `functional WASM zero-arity application ${nodeIndex} requires the built-in Unit constructor`,
      );
    }
    instructions.i32Const(unitOffset);
    instructions.i64Load(0);
    instructions.localGet(closure);
    instructions.i32Load(4);
    instructions.callIndirect(WasmFunctionTypeIndex.ClosureCall);
  }

  uncurriedApplication(
    nodeIndex: number,
    environment: Environment,
  ): UncurriedApplication | undefined {
    const reverseArguments: CallArgument[] = [];
    let baseNode = nodeIndex;
    let node = this.node(baseNode);
    while (node.tag === CoreTag.Apply) {
      if (node.payload === NO_INDEX) break;
      reverseArguments.push({
        node: node.child1,
        evaluationMode: node.evaluationMode,
      });
      baseNode = node.child0;
      node = this.node(baseNode);
    }
    if (reverseArguments.length === 0) return undefined;
    const virtualBase = this.virtualLambda(baseNode, environment);
    const localVirtualBase = virtualBase !== undefined && node.tag !== CoreTag.Global;
    const inlineVirtualBase = localVirtualBase && reverseArguments.length > 1;
    if (localVirtualBase && !inlineVirtualBase) return undefined;
    if (
      !inlineVirtualBase &&
      reverseArguments.some((argument) => this.virtualLambda(argument.node, environment))
    ) {
      return undefined;
    }

    let outerLambdaNode: number;
    if (virtualBase !== undefined) {
      outerLambdaNode = virtualBase.node;
    } else {
      const lambdaSet = this.lambdaSet(baseNode);
      if (!lambdaSet.complete || lambdaSet.lambdaNodes.length !== 1) {
        return undefined;
      }
      outerLambdaNode = lambdaSet.lambdaNodes[0]!;
    }
    const functionShape = this.#functionAnalysis.function(outerLambdaNode);
    if (
      functionShape === undefined ||
      functionShape.parameterCount !== reverseArguments.length
    ) {
      return undefined;
    }
    const recursiveFunction = node.tag === CoreTag.Local ? environment[node.payload] : undefined;
    let staticEnvironment: Environment | undefined;
    if (recursiveFunction?.kind === "static-recursive-function") {
      staticEnvironment = recursiveFunction.environment;
    } else if (inlineVirtualBase) {
      staticEnvironment = virtualBase.environment;
    }
    return {
      baseNode,
      arguments: Object.freeze(reverseArguments.reverse()),
      functionShape,
      inlineAtSoleCall: recursiveFunction?.kind === "static-recursive-function" &&
        recursiveFunction.inlineAtSoleCall,
      inlineVirtualBase,
      ...(staticEnvironment === undefined ? {} : { staticEnvironment }),
    };
  }

  compileUncurriedApplication(
    instructions: WasmInstructions,
    application: UncurriedApplication,
    environment: Environment,
  ): void {
    if (
      this.compileFusedUncurriedApplication(
        instructions,
        application,
        environment,
        "value",
      )
    ) return;

    const worker = this.uncurriedWorker(
      application.functionShape,
      application.staticEnvironment,
      "value",
    );
    if (worker.hasEnvironmentParameter) {
      this.emitUncurriedEnvironmentArgument(instructions, application, environment);
    }
    const argumentLocals = this.compileUncurriedArguments(
      instructions,
      application,
      environment,
    );
    for (const argument of argumentLocals) instructions.localGet(argument);
    this.#specializedCallSiteCount += 1;
    instructions.call(this.indirectFunctionOffset() + worker.slot);
  }

  lambdaSet(nodeIndex: number): LambdaSet {
    if (this.#lambdaSetAnalysis === undefined) {
      const annotations = {
        nodes: this.#nodes.length,
        definitions: this.#module.definitionCount,
      };
      this.#lambdaSetAnalysis = this.#trace === undefined
        ? LambdaSetAnalysis.forWasm(this.#module, this.#nodes, this.#coreIndex)
        : this.#trace.measure(
          "wasm.emit.lambda-sets",
          annotations,
          () => LambdaSetAnalysis.forWasm(this.#module, this.#nodes, this.#coreIndex),
        );
    }
    return this.#lambdaSetAnalysis.lambdaSet(nodeIndex);
  }

  compileNativeIntegerUncurriedApplication(
    instructions: WasmInstructions,
    application: UncurriedApplication,
    environment: Environment,
  ): void {
    if (
      this.compileFusedUncurriedApplication(
        instructions,
        application,
        environment,
        "integer",
      )
    ) return;

    const worker = this.uncurriedWorker(
      application.functionShape,
      application.staticEnvironment,
      "integer",
    );
    if (worker.hasEnvironmentParameter) {
      this.emitUncurriedEnvironmentArgument(instructions, application, environment);
    }
    const argumentLocals = this.compileUncurriedArguments(
      instructions,
      application,
      environment,
    );
    for (const argument of argumentLocals) instructions.localGet(argument);
    this.#specializedCallSiteCount += 1;
    instructions.call(this.indirectFunctionOffset() + worker.slot);
  }

  compileFusedUncurriedApplication(
    instructions: WasmInstructions,
    application: UncurriedApplication,
    environment: Environment,
    resultKind: "value" | "integer",
  ): boolean {
    if (
      application.inlineVirtualBase &&
      this.#remainingSpecializedInlineSites > 0 &&
      !this.#activeSpecializedLambdas.has(application.functionShape.outerLambdaNode)
    ) {
      const parameterBindings: Binding[] = [];
      for (const [parameter, argument] of application.arguments.entries()) {
        const virtualLambda = this.virtualLambda(argument.node, environment);
        if (virtualLambda !== undefined) {
          parameterBindings.push(virtualLambda);
          continue;
        }
        const virtualConstructor = this.virtualConstructor(argument.node, environment);
        if (virtualConstructor !== undefined) {
          parameterBindings.push(virtualConstructor);
          continue;
        }
        const integerConstant = this.constantIntegerExpression(argument.node, environment);
        if (integerConstant !== undefined) {
          parameterBindings.push({ kind: "i32-integer-constant", literal: integerConstant });
          continue;
        }
        const booleanConstant = this.constantBooleanExpression(argument.node, environment);
        if (booleanConstant !== undefined) {
          parameterBindings.push({ kind: "i32-boolean-constant", literal: booleanConstant });
          continue;
        }
        if (this.isUnboxedNumericParameter(application.functionShape, parameter)) {
          this.compileIntegerExpression(instructions, argument.node, environment);
          const local = instructions.addLocal(WasmValueType.I32);
          instructions.localSet(local);
          parameterBindings.push({ kind: "i32-integer", index: local });
          continue;
        }
        this.compileApplicationArgument(
          instructions,
          argument,
          environment,
          application.functionShape.strictParameters[parameter] === true,
        );
        const local = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(local);
        parameterBindings.push({ kind: "i64-local", index: local });
      }
      const bodyEnvironment = this.uncurriedBodyEnvironment(
        application.functionShape,
        parameterBindings,
        application.staticEnvironment,
        undefined,
        "caller",
      );
      this.#remainingSpecializedInlineSites -= 1;
      this.#specializedCallSiteCount += 1;
      this.#activeSpecializedLambdas.add(application.functionShape.outerLambdaNode);
      try {
        if (resultKind === "integer") {
          this.compileIntegerExpression(
            instructions,
            application.functionShape.bodyNode,
            bodyEnvironment,
          );
        } else {
          this.compileExpression(
            instructions,
            application.functionShape.bodyNode,
            bodyEnvironment,
          );
        }
      } finally {
        this.#activeSpecializedLambdas.delete(application.functionShape.outerLambdaNode);
      }
      return true;
    }

    const tailLoop = this.#functionAnalysis.loop(
      application.functionShape.innerLambdaNode,
    );
    if (
      application.inlineAtSoleCall &&
      tailLoop !== undefined &&
      !this.#activeFusedWorkers.has(application.functionShape.outerLambdaNode)
    ) {
      const argumentLocals = this.compileUncurriedArguments(
        instructions,
        application,
        environment,
      );
      const parameterBindings = argumentLocals.map((index, parameter) =>
        this.isUnboxedNumericParameter(application.functionShape, parameter)
          ? { kind: "i32-integer" as const, index }
          : { kind: "i64-local" as const, index }
      );
      const bodyEnvironment = this.uncurriedBodyEnvironment(
        application.functionShape,
        parameterBindings,
        application.staticEnvironment,
        undefined,
        "caller",
      );
      this.#specializedCallSiteCount += 1;
      this.#activeFusedWorkers.add(application.functionShape.outerLambdaNode);
      try {
        this.compileTailLoop(
          instructions,
          application.functionShape.bodyNode,
          bodyEnvironment,
          tailLoop,
          resultKind,
        );
      } finally {
        this.#activeFusedWorkers.delete(application.functionShape.outerLambdaNode);
      }
      return true;
    }
    return false;
  }

  emitUncurriedEnvironmentArgument(
    instructions: WasmInstructions,
    application: UncurriedApplication,
    environment: Environment,
  ): void {
    const base = this.node(application.baseNode);
    const localBase = base.tag === CoreTag.Local
      ? this.localSource(environment, base.payload, application.baseNode)
      : undefined;
    if (localBase?.kind === "i32-pointer") {
      instructions.localGet(localBase.index);
    } else if (localBase?.kind === "static-recursive-function") {
      const lambda = this.node(localBase.node);
      if (lambda.tag !== CoreTag.Lambda) {
        throw new Error(
          `functional WASM recursive environment ${localBase.node} has core tag ${lambda.tag}`,
        );
      }
      const capturesSelf = this.#captureAnalysis.freeLocalDepths(lambda.child0)
        .includes(1);
      const firstOuterCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
        (capturesSelf ? VALUE_BYTE_LENGTH : 0);
      const captured = this.prunedCaptures(
        lambda.child0,
        2,
        localBase.environment,
        firstOuterCaptureByteOffset,
      );
      const pointer = this.allocateObject(
        instructions,
        CLOSURE_OBJECT_KIND,
        this.lambdaSlot(localBase.node),
        captured.captureSources.length + (capturesSelf ? 1 : 0),
      );
      if (capturesSelf) {
        instructions.localGet(pointer);
        instructions.localGet(pointer);
        instructions.emit(0xad);
        instructions.i64Store(OBJECT_HEADER_BYTE_LENGTH);
      }
      for (const [index, source] of captured.captureSources.entries()) {
        instructions.localGet(pointer);
        this.emitBinding(instructions, source);
        instructions.i64Store(
          firstOuterCaptureByteOffset + index * VALUE_BYTE_LENGTH,
        );
      }
      instructions.localGet(pointer);
    } else if (
      this.scalarSpecializationEnabled() &&
      base.tag === CoreTag.Global &&
      this.#module.definitionRoots[base.payload] ===
        application.functionShape.outerLambdaNode
    ) {
      instructions.i32Const(0);
    } else {
      this.compileExpression(instructions, application.baseNode, environment);
      instructions.emit(0xa7);
    }
  }

  compileUncurriedArguments(
    instructions: WasmInstructions,
    application: UncurriedApplication,
    environment: Environment,
  ): readonly number[] {
    const argumentLocals: number[] = [];
    for (const [parameter, argument] of application.arguments.entries()) {
      const unboxed = this.isUnboxedNumericParameter(
        application.functionShape,
        parameter,
      );
      if (unboxed) {
        this.compileIntegerExpression(instructions, argument.node, environment);
      } else {
        this.compileApplicationArgument(
          instructions,
          argument,
          environment,
          false,
        );
      }
      const argumentLocal = instructions.addLocal(
        unboxed ? WasmValueType.I32 : WasmValueType.I64,
      );
      instructions.localSet(argumentLocal);
      argumentLocals.push(argumentLocal);
    }
    return argumentLocals;
  }

  uncurriedWorker(
    functionShape: FunctionShape,
    staticEnvironment: Environment | undefined,
    resultKind: "value" | "integer",
  ): UncurriedWorker {
    let environmentKey = "runtime";
    if (staticEnvironment !== undefined) {
      let environmentId = this.#staticEnvironmentIds.get(staticEnvironment);
      if (environmentId === undefined) {
        environmentId = this.#nextStaticEnvironmentId;
        this.#nextStaticEnvironmentId += 1;
        this.#staticEnvironmentIds.set(staticEnvironment, environmentId);
      }
      environmentKey = `static-${environmentId}`;
    }
    const parameterAbi = this.#nativeIntegerFunctionNodes.has(
        functionShape.outerLambdaNode,
      )
      ? "declared-integer"
      : "inferred";
    const workerKey =
      `${functionShape.outerLambdaNode}:${resultKind}:${environmentKey}:${parameterAbi}`;
    const existing = this.#uncurriedWorkers.get(workerKey);
    if (existing !== undefined) return existing;

    const hasEnvironmentParameter = this.uncurriedWorkerHasEnvironmentParameter(
      functionShape,
      staticEnvironment,
    );
    const slot = this.reserveIndirectFunction();
    const worker = { slot, hasEnvironmentParameter };
    this.#uncurriedWorkers.set(workerKey, worker);
    const parameterTypes = [
      ...(hasEnvironmentParameter ? [WasmValueType.I32] : []),
      ...functionShape.strictParameters.map((_, parameter) =>
        this.isUnboxedNumericParameter(functionShape, parameter)
          ? WasmValueType.I32
          : WasmValueType.I64
      ),
    ];
    const instructions = new WasmInstructions(parameterTypes.length);
    const parameterBindings: Binding[] = [];
    const parameterOffset = hasEnvironmentParameter ? 1 : 0;
    for (
      let parameter = 0;
      parameter < functionShape.parameterCount;
      parameter += 1
    ) {
      parameterBindings.push(
        this.isUnboxedNumericParameter(functionShape, parameter)
          ? { kind: "i32-integer", index: parameter + parameterOffset }
          : { kind: "i64-local", index: parameter + parameterOffset },
      );
    }
    const bodyEnvironment = this.uncurriedBodyEnvironment(
      functionShape,
      parameterBindings,
      staticEnvironment,
      hasEnvironmentParameter ? 0 : undefined,
      "worker",
    );

    if (resultKind === "integer") this.#nativeScalarWorkerDepth += 1;
    try {
      const tailLoop = this.#functionAnalysis.loop(functionShape.innerLambdaNode);
      if (tailLoop === undefined) {
        const numericFold = this.scalarSpecializationEnabled() &&
            this.isUnboxedNumericParameter(functionShape, 0)
          ? this.#functionAnalysis.numericFold(functionShape.innerLambdaNode)
          : undefined;
        if (numericFold === undefined) {
          if (resultKind === "integer") {
            this.compileIntegerExpression(instructions, functionShape.bodyNode, bodyEnvironment);
          } else {
            this.compileExpression(instructions, functionShape.bodyNode, bodyEnvironment);
          }
        } else {
          this.compileNumericFoldLoop(instructions, bodyEnvironment, numericFold, resultKind);
        }
      } else {
        this.compileTailLoop(
          instructions,
          functionShape.bodyNode,
          bodyEnvironment,
          tailLoop,
          resultKind,
        );
      }
    } finally {
      if (resultKind === "integer") this.#nativeScalarWorkerDepth -= 1;
    }
    const resultTypes = [
      resultKind === "integer" ? WasmValueType.I32 : WasmValueType.I64,
    ];
    this.#indirectFunctions[slot] = functionBody(
      this.functionTypeIndex(parameterTypes, resultTypes),
      instructions,
      `uncurried worker for lambda core node ${functionShape.outerLambdaNode}`,
    );
    return worker;
  }

  uncurriedWorkerHasEnvironmentParameter(
    functionShape: FunctionShape,
    staticEnvironment: Environment | undefined,
  ): boolean {
    const outerLambda = this.node(functionShape.outerLambdaNode);
    if (outerLambda.tag !== CoreTag.Lambda) {
      throw new Error(
        `functional WASM uncurried worker origin ${functionShape.outerLambdaNode} has core tag ${outerLambda.tag}`,
      );
    }
    const recursive = this.#recursiveLambdaOwners.has(functionShape.outerLambdaNode);
    const captureBinderDepth = recursive ? 2 : 1;
    return this.#captureAnalysis.freeLocalDepths(outerLambda.child0)
      .filter((depth) => depth >= captureBinderDepth)
      .some((depth) =>
        this.staticCaptureForWorker(
          staticEnvironment?.[depth - captureBinderDepth],
        ) === undefined
      );
  }

  uncurriedBodyEnvironment(
    functionShape: FunctionShape,
    parameterBindings: readonly Binding[],
    staticEnvironment: Environment | undefined,
    environmentParameter: number | undefined,
    staticCaptureMode: "caller" | "worker",
  ): Environment {
    const outerLambda = this.node(functionShape.outerLambdaNode);
    if (outerLambda.tag !== CoreTag.Lambda) {
      throw new Error(
        `functional WASM uncurried worker origin ${functionShape.outerLambdaNode} has core tag ${outerLambda.tag}`,
      );
    }
    const bodyEnvironment: (Binding | undefined)[] = [];
    for (const [parameter, binding] of parameterBindings.entries()) {
      bodyEnvironment[functionShape.parameterCount - parameter - 1] = binding;
    }

    const recursive = this.#recursiveLambdaOwners.has(functionShape.outerLambdaNode);
    const outerFreeDepths = this.#captureAnalysis.freeLocalDepths(outerLambda.child0);
    const capturesSelf = recursive && outerFreeDepths.includes(1);
    const captureBinderDepth = recursive ? 2 : 1;
    const firstCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
      (capturesSelf ? VALUE_BYTE_LENGTH : 0);
    if (recursive) {
      bodyEnvironment[functionShape.parameterCount] = environmentParameter === undefined
        ? {
          kind: "static-recursive-function",
          node: functionShape.outerLambdaNode,
          environment: staticEnvironment ?? [],
          inlineAtSoleCall: false,
        }
        : { kind: "i32-pointer", index: environmentParameter };
    }
    const capturedDepths = outerFreeDepths.filter((depth) => depth >= captureBinderDepth);
    for (const [captureIndex, freeDepth] of capturedDepths.entries()) {
      const bodyDepth = freeDepth + functionShape.parameterCount - 1;
      let staticCapture = staticEnvironment?.[freeDepth - captureBinderDepth];
      if (staticCaptureMode === "worker") {
        staticCapture = this.staticCaptureForWorker(staticCapture);
      }
      if (staticCapture !== undefined) {
        bodyEnvironment[bodyDepth] = staticCapture;
        continue;
      }
      if (environmentParameter === undefined) {
        throw new Error(
          `functional WASM captureless worker ${functionShape.outerLambdaNode} omitted outer local depth ${freeDepth}`,
        );
      }
      bodyEnvironment[bodyDepth] = {
        kind: "capture",
        byteOffset: firstCaptureByteOffset + captureIndex * VALUE_BYTE_LENGTH,
      };
    }
    return bodyEnvironment;
  }

  staticCaptureForWorker(
    binding: Binding | undefined,
  ): Binding | undefined {
    if (binding?.kind === "i32-integer-constant") return binding;
    if (binding?.kind === "i32-boolean-constant") return binding;
    if (binding?.kind === "static-recursive-function") return binding;
    return undefined;
  }

  canUseNativeIntegerWorker(application: UncurriedApplication): boolean {
    return this.scalarSpecializationEnabled() && application.functionShape.strictParameters.every(
      (_, parameter) => this.isUnboxedNumericParameter(application.functionShape, parameter),
    );
  }

  compileNumericFoldLoop(
    instructions: WasmInstructions,
    environment: Environment,
    fold: NumericFold,
    resultKind: "value" | "integer" = "value",
  ): void {
    const parameterSource = environment[0];
    if (parameterSource?.kind !== "i32-integer") {
      throw new Error(
        `functional WASM numeric fold ${fold.functionShape.outerLambdaNode} omitted its unboxed parameter`,
      );
    }
    const accumulator = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(
      fold.operator === BinaryOperator.Add ? 0 : 1,
    );
    instructions.localSet(accumulator);

    instructions.emit(
      0x02,
      resultKind === "integer" ? WasmValueType.I32 : WasmValueType.I64,
      0x03,
      0x40,
    );
    this.compileBooleanExpression(
      instructions,
      fold.conditionNode,
      environment,
    );
    instructions.emit(0x04, 0x40);
    this.compileNumericFoldBranch(
      instructions,
      environment,
      fold,
      parameterSource.index,
      accumulator,
      fold.recurseWhenTrue,
      resultKind,
    );
    instructions.emit(0x05);
    this.compileNumericFoldBranch(
      instructions,
      environment,
      fold,
      parameterSource.index,
      accumulator,
      !fold.recurseWhenTrue,
      resultKind,
    );
    instructions.emit(0x0b, 0x0b, 0x00, 0x0b);
  }

  compileNumericFoldBranch(
    instructions: WasmInstructions,
    environment: Environment,
    fold: NumericFold,
    parameter: number,
    accumulator: number,
    recursive: boolean,
    resultKind: "value" | "integer",
  ): void {
    if (!recursive) {
      instructions.localGet(accumulator);
      this.compileIntegerExpression(instructions, fold.baseNode, environment);
      instructions.emit(
        fold.operator === BinaryOperator.Add ? 0x6a : 0x6c,
      );
      if (resultKind === "value") this.emitEncodeInteger(instructions);
      instructions.branch(2);
      return;
    }

    this.compileIntegerExpression(
      instructions,
      fold.contributionNode,
      environment,
    );
    const contribution = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(contribution);
    this.compileIntegerExpression(
      instructions,
      fold.recursiveArgument.node,
      environment,
    );
    const nextParameter = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(nextParameter);
    instructions.localGet(accumulator);
    instructions.localGet(contribution);
    instructions.emit(
      fold.operator === BinaryOperator.Add ? 0x6a : 0x6c,
    );
    instructions.localSet(accumulator);
    instructions.localGet(nextParameter);
    instructions.localSet(parameter);
    instructions.branch(1);
  }

  isUnboxedNumericParameter(
    functionShape: FunctionShape,
    parameter: number,
  ): boolean {
    const profileMakesParameterStrict = this.#module.evaluationProfile ===
        EvaluationProfile.StrictEager &&
      !this.#hasLazyEvaluationBoundary;
    return this.#module.entryEffects.size === 0 &&
      (profileMakesParameterStrict ||
        functionShape.strictParameters[parameter] === true) &&
      (functionShape.numericParameters[parameter] === true ||
        this.#nativeIntegerFunctionNodes.has(functionShape.outerLambdaNode));
  }

  compileVirtualLambdaApplication(
    instructions: WasmInstructions,
    callee: VirtualLambda,
    argumentNode: number,
    argumentEvaluation: CoreNode["evaluationMode"],
    environment: Environment,
  ): void {
    const lambda = this.node(callee.node);
    if (lambda.tag !== CoreTag.Lambda) {
      throw new Error(
        `functional WASM virtual callee ${callee.node} has core tag ${lambda.tag}`,
      );
    }
    const virtualArgument = this.virtualLambda(argumentNode, environment);
    const hasCaptures = this.#captureAnalysis.freeLocalDepths(lambda.child0)
      .some((depth) => depth >= 1);
    const canInline = this.#remainingSpecializedInlineSites > 0 &&
      !this.#activeSpecializedLambdas.has(callee.node) &&
      (this.scalarSpecializationEnabled() || virtualArgument !== undefined || hasCaptures);
    const functionShape = this.#functionAnalysis.function(callee.node);
    const unboxedNumericArgument = canInline &&
      functionShape?.parameterCount === 1 &&
      this.isUnboxedNumericParameter(functionShape, 0);

    let argument: Binding;
    if (virtualArgument !== undefined) {
      argument = virtualArgument;
    } else if (unboxedNumericArgument) {
      const constantArgument = this.constantIntegerExpression(
        argumentNode,
        environment,
      );
      if (constantArgument !== undefined) {
        argument = { kind: "i32-integer-constant", literal: constantArgument };
      } else {
        this.compileIntegerExpression(instructions, argumentNode, environment);
        const argumentLocal = instructions.addLocal(WasmValueType.I32);
        instructions.localSet(argumentLocal);
        argument = { kind: "i32-integer", index: argumentLocal };
      }
    } else {
      const argumentIsEager = argumentEvaluation === EvaluationMode.StrictEager ||
        this.immediatelyForcesLocal(lambda.child0, 0);
      this.compileApplicationArgument(
        instructions,
        { node: argumentNode, evaluationMode: argumentEvaluation },
        environment,
        this.immediatelyForcesLocal(lambda.child0, 0),
      );
      const argumentLocal = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(argumentLocal);
      argument = {
        kind: argumentIsEager ? "i64-value" : "i64-local",
        index: argumentLocal,
      };
    }

    if (canInline) {
      this.#remainingSpecializedInlineSites -= 1;
      this.#activeSpecializedLambdas.add(callee.node);
      try {
        this.compileExpression(
          instructions,
          lambda.child0,
          [argument, ...callee.environment],
        );
      } finally {
        this.#activeSpecializedLambdas.delete(callee.node);
      }
      return;
    }

    const argumentLocal = instructions.addLocal(WasmValueType.I64);
    this.emitBinding(instructions, argument);
    instructions.localSet(argumentLocal);
    const closure = instructions.addLocal(WasmValueType.I32);
    if (hasCaptures) {
      this.emitBinding(instructions, callee);
      instructions.emit(0xa7);
    } else {
      instructions.i32Const(0);
    }
    instructions.localSet(closure);
    this.emitDirectLambdaCall(
      instructions,
      closure,
      argumentLocal,
      callee.node,
    );
  }

  virtualLambda(
    nodeIndex: number,
    environment: Environment,
    remainingDepth = 64,
  ): VirtualLambda | undefined {
    if (remainingDepth === 0) return undefined;
    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Lambda) {
      if (this.#recursiveLambdaOwners.has(nodeIndex)) return undefined;
      return { kind: "virtual-lambda", node: nodeIndex, environment };
    }
    if (node.tag === CoreTag.Local) {
      const binding = environment[node.payload];
      return binding?.kind === "virtual-lambda" ? binding : undefined;
    }
    if (node.tag === CoreTag.Global) {
      if (node.payload >= this.#module.definitionCount) return undefined;
      const root = this.#module.definitionRoots[node.payload];
      if (
        root === undefined || this.node(root).tag !== CoreTag.Lambda
      ) return undefined;
      return { kind: "virtual-lambda", node: root, environment: [] };
    }
    if (!this.#compactScalar || this.#instrumentedFuel) return undefined;
    if (node.tag === CoreTag.Let) {
      const binding = this.staticBinding(
        node.child0,
        environment,
        remainingDepth - 1,
      );
      return binding === undefined ? undefined : this.virtualLambda(
        node.child1,
        [binding, ...environment],
        remainingDepth - 1,
      );
    }
    if (node.tag === CoreTag.Apply) {
      const callee = this.virtualLambda(
        node.child0,
        environment,
        remainingDepth - 1,
      );
      if (callee === undefined) return undefined;
      const lambda = this.node(callee.node);
      if (lambda.tag !== CoreTag.Lambda) return undefined;
      const argument = this.staticBinding(
        node.child1,
        environment,
        remainingDepth - 1,
      );
      return argument === undefined ? undefined : this.virtualLambda(
        lambda.child0,
        [argument, ...callee.environment],
        remainingDepth - 1,
      );
    }
    if (node.tag === CoreTag.If) {
      const condition = this.constantBooleanExpression(node.child0, environment);
      if (condition === undefined) return undefined;
      return this.virtualLambda(
        condition ? node.child1 : node.child2,
        environment,
        remainingDepth - 1,
      );
    }
    return undefined;
  }

  compileLet(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    constructorReuse?: ConstructorReuseTarget,
  ): void {
    const virtualValue = this.virtualLambda(node.child0, environment);
    if (virtualValue !== undefined) {
      this.compileExpression(instructions, node.child1, [
        virtualValue,
        ...environment,
      ], constructorReuse);
      return;
    }
    const virtualConstructor = this.scalarSpecializationEnabled()
      ? this.virtualConstructor(node.child0, environment)
      : undefined;
    if (virtualConstructor !== undefined) {
      this.compileExpression(instructions, node.child1, [
        virtualConstructor,
        ...environment,
      ], constructorReuse);
      return;
    }
    const eager = node.evaluationMode === EvaluationMode.StrictEager ||
      this.expressionIsWhnf(node.child0) ||
      this.immediatelyForcesLocal(node.child1, 0);
    const constantValue = !this.#instrumentedFuel && eager
      ? this.scalarConstantBinding(node.child0, environment)
      : undefined;
    if (constantValue !== undefined) {
      this.compileExpression(
        instructions,
        node.child1,
        [constantValue, ...environment],
        constructorReuse,
      );
      return;
    }
    if (eager) {
      this.compileExpression(instructions, node.child0, environment);
    } else {
      this.compileLazyValue(instructions, node.child0, environment);
    }
    const value = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(value);
    const fieldCount = eager &&
        this.#module.evaluationProfile === EvaluationProfile.StrictEager &&
        !this.#hasLazyEvaluationBoundary && !this.#ownedRuntimeEnabled
      ? this.#uniqueReuseAnalysis.uniqueConstructorFieldCount(node.child0)
      : undefined;
    const reusableCases = fieldCount === undefined
      ? undefined
      : this.#uniqueReuseAnalysis.reusableCases(node.child1, 0);
    const binding: Binding = fieldCount !== undefined && reusableCases !== undefined
      ? {
        kind: "unique-constructor",
        index: value,
        fieldCount,
        reusableCases,
      }
      : { kind: eager ? "i64-value" : "i64-local", index: value };
    this.compileExpression(
      instructions,
      node.child1,
      [
        binding,
        ...environment,
      ],
      constructorReuse,
    );
  }

  compileLetRec(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    nodeIndex: number,
    resultKind: "value" | "integer" = "value",
  ): void {
    const lambda = this.node(node.child0);
    if (lambda.tag !== CoreTag.Lambda) {
      throw new Error(
        `functional WASM let-rec at core node ${nodeIndex} binds tag ${lambda.tag}; expected a lambda`,
      );
    }
    const capturesSelf = this.#captureAnalysis.freeLocalDepths(lambda.child0)
      .includes(1);
    const firstOuterCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
      (capturesSelf ? VALUE_BYTE_LENGTH : 0);
    const captured = this.prunedCaptures(
      lambda.child0,
      2,
      environment,
      firstOuterCaptureByteOffset,
    );
    const functionShape = this.#functionAnalysis.function(node.child0);
    const inlineAtSoleCall = this.#captureAnalysis.localReferenceCount(
      node.child1,
      0,
    ) === 1;
    const canFuseRuntimeCaptures = inlineAtSoleCall &&
      functionShape !== undefined &&
      this.#functionAnalysis.hasOnlyTailSelfReferences(functionShape);
    if (
      this.scalarSpecializationEnabled() &&
      functionShape !== undefined &&
      this.#functionAnalysis.hasOnlySaturatedSelfReferences(functionShape) &&
      this.#captureAnalysis.hasOnlySaturatedLocalReferences(
        node.child1,
        0,
        functionShape.parameterCount,
      ) &&
      captured.captureSources.every((source) =>
        source.kind === "i32-integer-constant" ||
        source.kind === "i32-boolean-constant" ||
        source.kind === "virtual-lambda" ||
        source.kind === "virtual-constructor" ||
        (canFuseRuntimeCaptures &&
          (source.kind === "i32-integer" || source.kind === "i32-boolean"))
      )
    ) {
      const bodyEnvironment: Environment = [{
        kind: "static-recursive-function",
        node: node.child0,
        environment,
        inlineAtSoleCall,
      }, ...environment];
      if (resultKind === "integer") {
        this.compileIntegerExpression(instructions, node.child1, bodyEnvironment);
      } else {
        this.compileExpression(instructions, node.child1, bodyEnvironment);
      }
      return;
    }
    const slot = this.lambdaSlot(node.child0);
    const pointer = this.allocateObject(
      instructions,
      CLOSURE_OBJECT_KIND,
      slot,
      captured.captureSources.length + (capturesSelf ? 1 : 0),
    );
    if (capturesSelf) {
      instructions.localGet(pointer);
      instructions.localGet(pointer);
      instructions.emit(0xad);
      instructions.i64Store(OBJECT_HEADER_BYTE_LENGTH);
    }
    for (const [index, source] of captured.captureSources.entries()) {
      instructions.localGet(pointer);
      this.emitBinding(instructions, source);
      instructions.i64Store(
        firstOuterCaptureByteOffset + index * VALUE_BYTE_LENGTH,
      );
    }
    const bodyEnvironment: Environment = [
      { kind: "i32-pointer", index: pointer },
      ...environment,
    ];
    if (resultKind === "integer") {
      this.compileIntegerExpression(instructions, node.child1, bodyEnvironment);
    } else {
      this.compileExpression(instructions, node.child1, bodyEnvironment);
    }
  }

  compileIf(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    constructorReuse?: ConstructorReuseTarget,
  ): void {
    const selectedBranch = this.constantIfBranch(node, environment);
    if (selectedBranch !== undefined) {
      this.compileExpression(instructions, selectedBranch, environment, constructorReuse);
      return;
    }
    this.compileBooleanExpression(instructions, node.child0, environment);
    instructions.emit(0x04, WasmValueType.I64);
    this.compileExpression(instructions, node.child1, environment, constructorReuse);
    instructions.emit(0x05);
    this.compileExpression(instructions, node.child2, environment, constructorReuse);
    instructions.emit(0x0b);
  }

  constantIfBranch(
    node: CoreNode,
    environment: Environment,
  ): number | undefined {
    if (this.#instrumentedFuel) return undefined;
    const condition = this.constantBooleanExpression(node.child0, environment);
    return condition === undefined ? undefined : condition ? node.child1 : node.child2;
  }

  compileUnary(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    nodeIndex: number,
  ): void {
    if (node.payload === UnaryOperator.Negate) {
      this.compileIntegerExpression(instructions, node.child0, environment);
      instructions.i32Const(-1);
      instructions.emit(0x6c);
      this.emitEncodeInteger(instructions);
      return;
    }
    if (node.payload === UnaryOperator.NegateSignedInteger64) {
      instructions.i64Const(0n);
      this.compileSignedInteger64Expression(
        instructions,
        node.child0,
        environment,
      );
      instructions.emit(0x7d);
      this.emitBoxSignedInteger64(instructions);
      return;
    }
    if (node.payload === UnaryOperator.NegateFloat32) {
      this.compileFloat32Expression(instructions, node.child0, environment);
      instructions.emit(0x8c);
      this.emitBoxFloat32(instructions);
      return;
    }
    if (node.payload === UnaryOperator.NegateFloat64) {
      this.compileFloat64Expression(instructions, node.child0, environment);
      instructions.emit(0x9a);
      this.emitBoxFloat64(instructions);
      return;
    }
    if (node.payload === UnaryOperator.NegateWholeNumberF64) {
      this.compileWholeNumberF64Expression(instructions, node.child0, environment);
      instructions.emit(0x9a);
      this.emitBoxFloat64(instructions);
      return;
    }
    if (node.payload === UnaryOperator.SquareRootFloat32) {
      this.compileFloat32Expression(instructions, node.child0, environment);
      instructions.emit(0x91);
      this.emitBoxFloat32(instructions);
      return;
    }
    throw new Error(
      `functional WASM unary operator ${node.payload} at core node ${nodeIndex} is unsupported`,
    );
  }

  compileStoreNew(
    instructions: WasmInstructions,
    node: CoreNode,
    nodeIndex: number,
    environment: Environment,
  ): void {
    this.compileIntegerExpression(instructions, node.child0, environment);
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(length);
    this.compileExpression(instructions, node.child1, environment);
    const initial = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(initial);
    this.requireStoreLength(instructions, length, nodeIndex);
    this.#runtimeEmitter.emitFuelChargeAmount(instructions, length, nodeIndex);
    const pointer = this.allocateStore(instructions, length);
    const cursor = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(cursor);
    this.emitStoreFill(instructions, pointer, cursor, length, initial);
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  compileStoreEmpty(instructions: WasmInstructions): void {
    const length = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(0);
    instructions.localSet(length);
    const pointer = this.allocateStore(instructions, length);
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  compileStoreLength(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
  ): void {
    const pointer = this.compileStorePointer(instructions, node.child0, environment);
    instructions.localGet(pointer);
    instructions.i32Load(8);
    this.emitEncodeInteger(instructions);
  }

  compileStoreRead(
    instructions: WasmInstructions,
    node: CoreNode,
    nodeIndex: number,
    environment: Environment,
  ): void {
    const pointer = this.compileStorePointer(instructions, node.child0, environment);
    this.compileIntegerExpression(instructions, node.child1, environment);
    const index = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(index);
    this.requireStoreIndex(instructions, pointer, index, nodeIndex);
    this.emitStoreElementAddress(instructions, pointer, index);
    instructions.i64Load(0);
  }

  compileStoreUpdates(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    const updates: StoreUpdate[] = [];
    let sourceNodeIndex = nodeIndex;
    while (true) {
      const sourceNode = this.node(sourceNodeIndex);
      if (
        sourceNode.tag !== CoreTag.StoreWrite &&
        sourceNode.tag !== CoreTag.StoreGrow
      ) break;
      updates.push({ node: sourceNode, nodeIndex: sourceNodeIndex });
      sourceNodeIndex = sourceNode.child0;
    }
    for (let index = 1; index < updates.length; index++) {
      this.#runtimeEmitter.emitFuelCharge(instructions, updates[index]!.nodeIndex);
    }
    updates.reverse();

    const source = this.compileStorePointer(instructions, sourceNodeIndex, environment);
    const sourceLength = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(source);
    instructions.i32Load(8);
    instructions.localSet(sourceLength);
    const currentLength = instructions.addLocal(WasmValueType.I32);
    instructions.localGet(sourceLength);
    instructions.localSet(currentLength);
    const evaluated: ({
      readonly kind: "write";
      readonly index: number;
      readonly value: number;
    } | {
      readonly kind: "grow";
      readonly previousLength: number;
      readonly newLength: number;
      readonly initial: number;
    })[] = [];
    for (const update of updates) {
      this.compileIntegerExpression(instructions, update.node.child1, environment);
      const operand = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(operand);
      this.compileExpression(instructions, update.node.child2, environment);
      const value = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(value);
      if (update.node.tag === CoreTag.StoreWrite) {
        instructions.localGet(operand);
        instructions.localGet(currentLength);
        instructions.emit(0x4f, 0x04, 0x40);
        this.#runtimeEmitter.emitFault(
          instructions,
          WASM_FAULT_OUT_OF_BOUNDS,
          update.nodeIndex,
        );
        instructions.emit(0x0b);
        evaluated.push({ kind: "write", index: operand, value });
        continue;
      }
      this.requireStoreLength(instructions, operand, update.nodeIndex);
      instructions.localGet(currentLength);
      instructions.localGet(operand);
      instructions.emit(0x4b, 0x04, 0x40);
      this.#runtimeEmitter.emitFault(instructions, WASM_FAULT_OUT_OF_BOUNDS, update.nodeIndex);
      instructions.emit(0x0b);
      const previousLength = instructions.addLocal(WasmValueType.I32);
      instructions.localGet(currentLength);
      instructions.localSet(previousLength);
      instructions.localGet(operand);
      instructions.localSet(currentLength);
      evaluated.push({
        kind: "grow",
        previousLength,
        newLength: operand,
        initial: value,
      });
    }

    this.#runtimeEmitter.emitFuelChargeAmount(instructions, currentLength, nodeIndex);
    const destination = this.allocateStore(instructions, currentLength);
    this.emitStoreCopy(instructions, destination, source, sourceLength);
    for (const update of evaluated) {
      if (update.kind === "write") {
        this.emitStoreElementAddress(instructions, destination, update.index);
        instructions.localGet(update.value);
        instructions.i64Store(0);
        continue;
      }
      const cursor = instructions.addLocal(WasmValueType.I32);
      instructions.localGet(update.previousLength);
      instructions.localSet(cursor);
      this.emitStoreFill(
        instructions,
        destination,
        cursor,
        update.newLength,
        update.initial,
      );
    }
    instructions.localGet(destination);
    instructions.emit(0xad);
  }

  compileStorePointer(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): number {
    this.compileExpression(instructions, nodeIndex, environment);
    instructions.emit(0xa7);
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(pointer);
    return pointer;
  }

  requireStoreLength(
    instructions: WasmInstructions,
    length: number,
    nodeIndex: number,
  ): void {
    instructions.localGet(length);
    instructions.i32Const(MAXIMUM_STORE_LENGTH);
    instructions.emit(0x4b, 0x04, 0x40);
    this.#runtimeEmitter.emitFault(instructions, WASM_FAULT_OUT_OF_BOUNDS, nodeIndex);
    instructions.emit(0x0b);
  }

  requireStoreIndex(
    instructions: WasmInstructions,
    pointer: number,
    index: number,
    nodeIndex: number,
  ): void {
    instructions.localGet(index);
    instructions.localGet(pointer);
    instructions.i32Load(8);
    instructions.emit(0x4f, 0x04, 0x40);
    this.#runtimeEmitter.emitFault(instructions, WASM_FAULT_OUT_OF_BOUNDS, nodeIndex);
    instructions.emit(0x0b);
  }

  allocateStore(instructions: WasmInstructions, length: number): number {
    instructions.localGet(length);
    instructions.i32Const(3);
    instructions.emit(0x74);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.call(this.allocateFunctionIndex());
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localTee(pointer);
    instructions.i32Const(STORE_OBJECT_KIND);
    instructions.i32Store(0);
    instructions.localGet(pointer);
    instructions.i32Const(0);
    instructions.i32Store(4);
    instructions.localGet(pointer);
    instructions.localGet(length);
    instructions.i32Store(8);
    if (this.#ownedRuntimeEnabled) {
      instructions.localGet(pointer);
      instructions.i32Const(1);
      instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
    }
    return pointer;
  }

  emitStoreCopy(
    instructions: WasmInstructions,
    destination: number,
    source: number,
    length: number,
  ): void {
    instructions.localGet(destination);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(source);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(length);
    instructions.i32Const(3);
    instructions.emit(0x74);
    instructions.memoryCopy();
  }

  emitStoreFill(
    instructions: WasmInstructions,
    pointer: number,
    cursor: number,
    end: number,
    value: number,
  ): void {
    instructions.emit(0x02, 0x40, 0x03, 0x40);
    instructions.localGet(cursor);
    instructions.localGet(end);
    instructions.emit(0x4f);
    instructions.branchIf(1);
    this.emitStoreElementAddress(instructions, pointer, cursor);
    instructions.localGet(value);
    instructions.i64Store(0);
    instructions.localGet(cursor);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.localSet(cursor);
    instructions.branch(0);
    instructions.emit(0x0b, 0x0b);
  }

  emitStoreElementAddress(
    instructions: WasmInstructions,
    pointer: number,
    index: number,
  ): void {
    instructions.localGet(pointer);
    instructions.i32Const(OBJECT_HEADER_BYTE_LENGTH);
    instructions.emit(0x6a);
    instructions.localGet(index);
    instructions.i32Const(3);
    instructions.emit(0x74, 0x6a);
  }

  compileIntegerExpression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    this.#runtimeEmitter.emitFuelCharge(instructions, nodeIndex);
    if (!this.#instrumentedFuel) {
      const constantLocals: number[] = [];
      let bodyNode = nodeIndex;
      let body = this.node(bodyNode);
      while (
        body.tag === CoreTag.Let &&
        body.evaluationMode === EvaluationMode.StrictEager
      ) {
        const value = this.constantIntegerExpression(
          body.child0,
          environment,
          constantLocals,
        );
        if (value === undefined) break;
        constantLocals.push(value);
        bodyNode = body.child1;
        body = this.node(bodyNode);
      }
      if (constantLocals.length > 0) {
        const folded = this.constantIntegerExpression(
          bodyNode,
          environment,
          constantLocals,
        );
        if (folded !== undefined) {
          instructions.i32Const(folded);
          return;
        }
      }
    }
    const constant = this.constantIntegerExpression(nodeIndex, environment);
    if (constant !== undefined) {
      instructions.i32Const(constant);
      return;
    }
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Integer:
        instructions.i32Const(node.payload | 0);
        return;
      case CoreTag.Local: {
        const source = this.localSource(environment, node.payload, nodeIndex);
        if (source.kind === "i32-integer") {
          instructions.localGet(source.index);
          return;
        }
        this.emitBinding(instructions, source);
        if (source.kind === "i64-local" || source.kind === "capture") {
          this.emitForceValue(instructions);
        }
        this.emitDecodeInteger(instructions);
        return;
      }
      case CoreTag.Unary:
        if (node.payload !== UnaryOperator.Negate) {
          throw new Error(
            `functional WASM unary operator ${node.payload} at core node ${nodeIndex} is unsupported`,
          );
        }
        this.compileIntegerExpression(instructions, node.child0, environment);
        instructions.i32Const(-1);
        instructions.emit(0x6c);
        return;
      case CoreTag.Binary: {
        if (
          node.payload !== BinaryOperator.Add &&
          node.payload !== BinaryOperator.Subtract &&
          node.payload !== BinaryOperator.Multiply &&
          node.payload !== BinaryOperator.Divide &&
          node.payload !== BinaryOperator.Remainder &&
          node.payload !== BinaryOperator.BitwiseAnd &&
          node.payload !== BinaryOperator.BitwiseOr &&
          node.payload !== BinaryOperator.BitwiseXor &&
          node.payload !== BinaryOperator.ShiftLeft &&
          node.payload !== BinaryOperator.ShiftRightUnsigned
        ) {
          this.compileExpression(instructions, nodeIndex, environment);
          this.emitDecodeInteger(instructions);
          return;
        }
        this.compileIntegerExpression(instructions, node.child0, environment);
        if (
          node.payload === BinaryOperator.Divide ||
          node.payload === BinaryOperator.Remainder
        ) {
          instructions.emit(0xac);
        }
        this.compileIntegerExpression(instructions, node.child1, environment);
        if (
          node.payload === BinaryOperator.Divide ||
          node.payload === BinaryOperator.Remainder
        ) {
          const divisor = instructions.addLocal(WasmValueType.I32);
          instructions.localSet(divisor);
          this.emitDivisionByZeroGuard(instructions, nodeIndex, divisor, "i32");
          instructions.localGet(divisor);
        }
        if (node.payload === BinaryOperator.Add) {
          instructions.emit(0x6a);
        } else if (node.payload === BinaryOperator.Subtract) {
          instructions.emit(0x6b);
        } else if (node.payload === BinaryOperator.Multiply) {
          instructions.emit(0x6c);
        } else if (node.payload === BinaryOperator.Remainder) {
          instructions.emit(0xac, 0x81, 0xa7);
        } else if (node.payload === BinaryOperator.BitwiseAnd) {
          instructions.emit(0x71);
        } else if (node.payload === BinaryOperator.BitwiseOr) {
          instructions.emit(0x72);
        } else if (node.payload === BinaryOperator.BitwiseXor) {
          instructions.emit(0x73);
        } else if (node.payload === BinaryOperator.ShiftLeft) {
          instructions.emit(0x74);
        } else if (
          node.payload === BinaryOperator.ShiftRightUnsigned
        ) {
          instructions.emit(0x76);
        } else {
          instructions.emit(0xac, 0x7f, 0xa7);
        }
        return;
      }
      case CoreTag.NumericConvert:
        this.compileNumericConversion(
          instructions,
          node,
          nodeIndex,
          environment,
          "integer",
        );
        return;
      case CoreTag.If: {
        const selectedBranch = this.constantIfBranch(node, environment);
        if (selectedBranch !== undefined) {
          this.compileIntegerExpression(instructions, selectedBranch, environment);
          return;
        }
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.I32);
        this.compileIntegerExpression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileIntegerExpression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
      }
      case CoreTag.Apply: {
        const application = this.uncurriedApplication(nodeIndex, environment);
        if (application !== undefined && this.canUseNativeIntegerWorker(application)) {
          this.compileNativeIntegerUncurriedApplication(
            instructions,
            application,
            environment,
          );
          return;
        }
        this.compileExpression(instructions, nodeIndex, environment);
        this.emitDecodeInteger(instructions);
        return;
      }
      case CoreTag.LetRec:
        this.compileLetRec(instructions, node, environment, nodeIndex, "integer");
        return;
      case CoreTag.Let: {
        const virtualValue = this.virtualLambda(node.child0, environment);
        if (virtualValue !== undefined) {
          this.compileIntegerExpression(
            instructions,
            node.child1,
            [virtualValue, ...environment],
          );
          return;
        }
        const virtualConstructor = this.scalarSpecializationEnabled()
          ? this.virtualConstructor(node.child0, environment)
          : undefined;
        if (virtualConstructor !== undefined) {
          this.compileIntegerExpression(
            instructions,
            node.child1,
            [virtualConstructor, ...environment],
          );
          return;
        }
        const eager = node.evaluationMode === EvaluationMode.StrictEager ||
          this.expressionIsWhnf(node.child0) ||
          this.immediatelyForcesLocal(node.child1, 0);
        const constantValue = eager
          ? this.constantIntegerExpression(node.child0, environment)
          : undefined;
        if (constantValue !== undefined) {
          this.compileIntegerExpression(
            instructions,
            node.child1,
            [
              { kind: "i32-integer-constant", literal: constantValue },
              ...environment,
            ],
          );
          return;
        }
        const uncurriedValue = eager
          ? this.uncurriedApplication(node.child0, environment)
          : undefined;
        if (
          eager &&
          (this.canCompileIntegerExpression(node.child0) ||
            (uncurriedValue !== undefined && this.canUseNativeIntegerWorker(uncurriedValue)))
        ) {
          this.compileIntegerExpression(instructions, node.child0, environment);
          const value = instructions.addLocal(WasmValueType.I32);
          instructions.localSet(value);
          this.compileIntegerExpression(
            instructions,
            node.child1,
            [{ kind: "i32-integer", index: value }, ...environment],
          );
          return;
        }
        if (eager) {
          this.compileExpression(instructions, node.child0, environment);
        } else {
          this.compileLazyValue(instructions, node.child0, environment);
        }
        const value = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(value);
        this.compileIntegerExpression(
          instructions,
          node.child1,
          [
            { kind: eager ? "i64-value" : "i64-local", index: value },
            ...environment,
          ],
        );
        return;
      }
      case CoreTag.Case: {
        const constructor = this.scalarSpecializationEnabled()
          ? this.virtualConstructor(node.child0, environment)
          : undefined;
        if (constructor !== undefined) {
          this.compileKnownCaseArm(
            instructions,
            node,
            constructor,
            environment,
            nodeIndex,
            "integer",
          );
          return;
        }
        this.compileExpression(instructions, nodeIndex, environment);
        this.emitDecodeInteger(instructions);
        return;
      }
      default:
        this.compileExpression(instructions, nodeIndex, environment);
        this.emitDecodeInteger(instructions);
    }
  }

  compileBooleanExpression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    this.#runtimeEmitter.emitFuelCharge(instructions, nodeIndex);
    const constant = this.constantBooleanExpression(nodeIndex, environment);
    if (constant !== undefined) {
      instructions.i32Const(constant ? 1 : 0);
      return;
    }
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Boolean:
        instructions.i32Const(node.payload === 0 ? 0 : 1);
        return;
      case CoreTag.Local: {
        const source = this.localSource(environment, node.payload, nodeIndex);
        if (source.kind === "i32-boolean") {
          instructions.localGet(source.index);
          return;
        }
        this.emitBinding(instructions, source);
        if (source.kind === "i64-local" || source.kind === "capture") {
          this.emitForceValue(instructions);
        }
        this.emitDecodeBoolean(instructions);
        return;
      }
      case CoreTag.Binary:
        if (
          !this.#instrumentedFuel &&
          (node.payload === BinaryOperator.Equal ||
            node.payload === BinaryOperator.NotEqual)
        ) {
          const left = this.node(node.child0);
          const right = this.node(node.child1);
          let integerBoolean: CoreNode | undefined;
          if (left.tag === CoreTag.Integer && left.payload === 0) {
            integerBoolean = right;
          } else if (
            right.tag === CoreTag.Integer && right.payload === 0
          ) {
            integerBoolean = left;
          }
          if (integerBoolean?.tag === CoreTag.If) {
            const thenBranch = this.node(integerBoolean.child1);
            const elseBranch = this.node(integerBoolean.child2);
            if (
              thenBranch.tag === CoreTag.Integer &&
              elseBranch.tag === CoreTag.Integer &&
              (thenBranch.payload === 0 || thenBranch.payload === 1) &&
              thenBranch.payload + elseBranch.payload === 1
            ) {
              this.compileBooleanExpression(
                instructions,
                integerBoolean.child0,
                environment,
              );
              const trueWhenCondition = node.payload === BinaryOperator.NotEqual
                ? thenBranch.payload === 1
                : thenBranch.payload === 0;
              if (!trueWhenCondition) instructions.emit(0x45);
              return;
            }
          }
        }
        if (
          node.payload === BinaryOperator.StructuralEqual ||
          node.payload === BinaryOperator.StructuralNotEqual
        ) {
          this.compileStructuralEquality(instructions, node, environment);
          return;
        }
        if (!isComparisonOperator(node.payload)) break;
        this.compileComparisonOperands(
          instructions,
          node,
          environment,
          nodeIndex,
        );
        return;
      case CoreTag.If: {
        const selectedBranch = this.constantIfBranch(node, environment);
        if (selectedBranch !== undefined) {
          this.compileBooleanExpression(instructions, selectedBranch, environment);
          return;
        }
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.I32);
        this.compileBooleanExpression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileBooleanExpression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
      }
      case CoreTag.Let: {
        const eager = node.evaluationMode === EvaluationMode.StrictEager ||
          this.expressionIsWhnf(node.child0) ||
          this.immediatelyForcesLocal(node.child1, 0);
        const constantValue = eager
          ? this.constantBooleanExpression(node.child0, environment)
          : undefined;
        if (constantValue !== undefined) {
          this.compileBooleanExpression(
            instructions,
            node.child1,
            [
              { kind: "i32-boolean-constant", literal: constantValue },
              ...environment,
            ],
          );
          return;
        }
        if (eager && this.canCompileBooleanExpression(node.child0)) {
          this.compileBooleanExpression(instructions, node.child0, environment);
          const value = instructions.addLocal(WasmValueType.I32);
          instructions.localSet(value);
          this.compileBooleanExpression(
            instructions,
            node.child1,
            [{ kind: "i32-boolean", index: value }, ...environment],
          );
          return;
        }
        if (eager) {
          this.compileExpression(instructions, node.child0, environment);
        } else {
          this.compileLazyValue(instructions, node.child0, environment);
        }
        const value = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(value);
        this.compileBooleanExpression(
          instructions,
          node.child1,
          [
            { kind: eager ? "i64-value" : "i64-local", index: value },
            ...environment,
          ],
        );
        return;
      }
    }
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitDecodeBoolean(instructions);
  }

  compileSignedInteger64Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    this.#runtimeEmitter.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case CoreTag.SignedInteger64:
        instructions.signedInteger64Literal(nodeIndex, wideLiteralBits(node));
        return;
      case CoreTag.Unary:
        if (node.payload !== UnaryOperator.NegateSignedInteger64) {
          break;
        }
        instructions.i64Const(0n);
        this.compileSignedInteger64Expression(
          instructions,
          node.child0,
          environment,
        );
        instructions.emit(0x7d);
        return;
      case CoreTag.Binary:
        if (numericOperatorGroup(node.payload) !== "signed-integer-64") break;
        this.compileSignedInteger64Expression(
          instructions,
          node.child0,
          environment,
        );
        this.compileSignedInteger64Expression(
          instructions,
          node.child1,
          environment,
        );
        this.emitNumericBinary(instructions, node.payload, nodeIndex);
        return;
      case CoreTag.NumericConvert:
        this.compileNumericConversion(
          instructions,
          node,
          nodeIndex,
          environment,
          "signed-integer-64",
        );
        return;
      case CoreTag.If: {
        const selectedBranch = this.constantIfBranch(node, environment);
        if (selectedBranch !== undefined) {
          this.compileSignedInteger64Expression(instructions, selectedBranch, environment);
          return;
        }
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.I64);
        this.compileSignedInteger64Expression(
          instructions,
          node.child1,
          environment,
        );
        instructions.emit(0x05);
        this.compileSignedInteger64Expression(
          instructions,
          node.child2,
          environment,
        );
        instructions.emit(0x0b);
        return;
      }
    }
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxSignedInteger64(instructions);
  }

  compileFloat32Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    this.#runtimeEmitter.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    if (
      this.#simdEnabled && node.tag === CoreTag.Apply &&
      this.compileSimdFloat32Application(instructions, nodeIndex, environment)
    ) return;
    switch (node.tag) {
      case CoreTag.Float32:
        instructions.f32Const(float32FromBits(node.payload));
        return;
      case CoreTag.Unary:
        if (
          node.payload !== UnaryOperator.NegateFloat32 &&
          node.payload !== UnaryOperator.SquareRootFloat32
        ) break;
        this.compileFloat32Expression(instructions, node.child0, environment);
        if (node.payload === UnaryOperator.NegateFloat32) {
          instructions.emit(0x8c);
        } else {
          instructions.emit(0x91);
        }
        return;
      case CoreTag.Binary:
        if (numericOperatorGroup(node.payload) !== "float-32") break;
        this.compileFloat32Expression(instructions, node.child0, environment);
        this.compileFloat32Expression(instructions, node.child1, environment);
        this.emitNumericBinary(instructions, node.payload, nodeIndex);
        return;
      case CoreTag.NumericConvert:
        this.compileNumericConversion(
          instructions,
          node,
          nodeIndex,
          environment,
          "float-32",
        );
        return;
      case CoreTag.If: {
        const selectedBranch = this.constantIfBranch(node, environment);
        if (selectedBranch !== undefined) {
          this.compileFloat32Expression(instructions, selectedBranch, environment);
          return;
        }
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.F32);
        this.compileFloat32Expression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileFloat32Expression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
      }
    }
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxFloat32(instructions);
  }

  compileSimdVectorApplication(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): CompiledSimdVector | undefined {
    const application = this.namedApplication(nodeIndex);
    if (application === undefined) return undefined;
    const { definition, arguments: arguments_ } = application;
    const canonicalDefinition = canonicalFixedVectorName(definition);
    if (canonicalDefinition === F32x4Definition.Splat && arguments_.length === 1) {
      this.compileFloat32Expression(instructions, arguments_[0]!.node, environment);
      instructions.simd(WasmSimdOpcode.F32x4Splat);
      return compiledSimdVector(definition, "f32x4");
    }
    const binaryOpcode = simdF32x4BinaryOpcode(definition);
    if (binaryOpcode !== undefined && arguments_.length === 2) {
      this.compileF32x4Expression(instructions, arguments_[0]!.node, environment);
      this.compileF32x4Expression(instructions, arguments_[1]!.node, environment);
      instructions.simd(binaryOpcode);
      return compiledSimdVector(definition, "f32x4");
    }
    const comparisonOpcode = simdF32x4ComparisonOpcode(definition);
    if (comparisonOpcode !== undefined && arguments_.length === 2) {
      this.compileF32x4Expression(instructions, arguments_[0]!.node, environment);
      this.compileF32x4Expression(instructions, arguments_[1]!.node, environment);
      instructions.simd(comparisonOpcode);
      return compiledSimdVector(definition, "mask32x4");
    }
    if (canonicalDefinition === F32x4Definition.Select && arguments_.length === 3) {
      this.compileF32x4Expression(instructions, arguments_[1]!.node, environment);
      this.compileF32x4Expression(instructions, arguments_[2]!.node, environment);
      this.compileMask32x4Expression(instructions, arguments_[0]!.node, environment);
      instructions.simd(WasmSimdOpcode.V128BitSelect);
      return compiledSimdVector(definition, "f32x4");
    }
    const replacementLane = f32x4ReplacementLane(definition);
    if (replacementLane !== undefined && arguments_.length === 2) {
      this.compileF32x4Expression(instructions, arguments_[0]!.node, environment);
      this.compileFloat32Expression(instructions, arguments_[1]!.node, environment);
      instructions.simd(WasmSimdOpcode.F32x4ReplaceLane, replacementLane);
      return compiledSimdVector(definition, "f32x4");
    }
    if (canonicalDefinition === F32x4Definition.Map && arguments_.length === 2) {
      return this.compileSimdMap(instructions, arguments_, environment)
        ? compiledSimdVector(definition, "f32x4")
        : undefined;
    }
    if (canonicalDefinition === F32x4Definition.Zip && arguments_.length === 3) {
      return this.compileSimdZip(instructions, arguments_, environment)
        ? compiledSimdVector(definition, "f32x4")
        : undefined;
    }
    return undefined;
  }

  compileSimdFloat32Application(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): boolean {
    const application = this.namedApplication(nodeIndex);
    if (application === undefined) return false;
    const { definition, arguments: arguments_ } = application;
    const canonicalDefinition = canonicalFixedVectorName(definition);
    const extractedLane = f32x4ExtractedLane(definition);
    if (extractedLane !== undefined && arguments_.length === 1) {
      this.compileF32x4Expression(instructions, arguments_[0]!.node, environment);
      instructions.simd(WasmSimdOpcode.F32x4ExtractLane, extractedLane);
      return true;
    }
    if (canonicalDefinition === F32x4Definition.ReduceAdd && arguments_.length === 1) {
      this.compileF32x4Expression(instructions, arguments_[0]!.node, environment);
      const vector = instructions.addLocal(WasmValueType.V128);
      instructions.localSet(vector);
      this.emitExtractF32x4Lane(instructions, vector, 0);
      this.emitExtractF32x4Lane(instructions, vector, 1);
      instructions.emit(0x92);
      this.emitExtractF32x4Lane(instructions, vector, 2);
      this.emitExtractF32x4Lane(instructions, vector, 3);
      instructions.emit(0x92, 0x92);
      return true;
    }
    if (canonicalDefinition === F32x4Definition.Fold && arguments_.length === 3) {
      const combine = this.float32CombineOperator(arguments_[0]!.node, environment);
      if (combine === undefined) return false;
      const combineOpcode = numericBinaryOpcode(combine);
      if (combineOpcode === undefined) return false;
      this.compileFloat32Expression(instructions, arguments_[1]!.node, environment);
      this.compileF32x4Expression(instructions, arguments_[2]!.node, environment);
      const vector = instructions.addLocal(WasmValueType.V128);
      instructions.localSet(vector);
      for (let lane = 0; lane < 4; lane += 1) {
        this.emitExtractF32x4Lane(instructions, vector, lane);
        instructions.emit(combineOpcode);
      }
      return true;
    }
    return false;
  }

  compileF32x4Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Local) {
      const binding = environment[node.payload];
      if (binding?.kind === "v128-f32x4") {
        instructions.localGet(binding.index);
        return;
      }
    }
    if (node.tag === CoreTag.Apply) {
      const kind = this.compileSimdVectorApplication(instructions, nodeIndex, environment);
      if (kind?.kind === "f32x4") return;
    }
    const constructor = this.constructorApplication(nodeIndex);
    if (
      constructor !== undefined && constructor.arguments.length === 4 &&
      canonicalFixedVectorName(
          this.#module.constructorNames[constructor.constructorIndex]!,
        ) === F32X4_CONSTRUCTOR_NAME
    ) {
      this.compileFloat32Expression(instructions, constructor.arguments[0]!.node, environment);
      instructions.simd(WasmSimdOpcode.F32x4Splat);
      for (let lane = 1; lane < 4; lane += 1) {
        this.compileFloat32Expression(instructions, constructor.arguments[lane]!.node, environment);
        instructions.simd(WasmSimdOpcode.F32x4ReplaceLane, lane);
      }
      return;
    }
    if (this.compileF32x4WorkerApplication(instructions, nodeIndex, environment)) return;
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxF32x4(instructions);
  }

  compileF32x4WorkerApplication(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): boolean {
    const application = this.uncurriedApplication(nodeIndex, environment);
    if (
      application === undefined || application.arguments.length !== 1 ||
      application.functionShape.parameterCount !== 1 ||
      application.staticEnvironment !== undefined ||
      this.#recursiveLambdaOwners.has(application.functionShape.outerLambdaNode) ||
      this.uncurriedWorkerHasEnvironmentParameter(
        application.functionShape,
        undefined,
      ) ||
      !this.isKnownF32x4Expression(application.arguments[0]!.node, environment)
    ) return false;

    const parameterBinding = { kind: "v128-f32x4" as const, index: 0 };
    const bodyEnvironment = this.uncurriedBodyEnvironment(
      application.functionShape,
      [parameterBinding],
      undefined,
      undefined,
      "worker",
    );
    if (!this.isKnownF32x4Expression(application.functionShape.bodyNode, bodyEnvironment)) {
      return false;
    }

    let slot = this.#f32x4Workers.get(application.functionShape.outerLambdaNode);
    if (slot === undefined) {
      slot = this.reserveIndirectFunction();
      this.#f32x4Workers.set(application.functionShape.outerLambdaNode, slot);
      const workerInstructions = new WasmInstructions(1);
      this.compileF32x4Expression(
        workerInstructions,
        application.functionShape.bodyNode,
        bodyEnvironment,
      );
      this.#indirectFunctions[slot] = functionBody(
        this.functionTypeIndex([WasmValueType.V128], [WasmValueType.V128]),
        workerInstructions,
        `F32x4 worker for lambda core node ${application.functionShape.outerLambdaNode}`,
      );
    }

    this.compileF32x4Expression(instructions, application.arguments[0]!.node, environment);
    instructions.call(this.indirectFunctionOffset() + slot);
    this.#specializedCallSiteCount += 1;
    return true;
  }

  isKnownF32x4Expression(
    nodeIndex: number,
    environment: Environment,
  ): boolean {
    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Local) {
      return environment[node.payload]?.kind === "v128-f32x4";
    }
    const constructor = this.constructorApplication(nodeIndex);
    if (
      constructor !== undefined && constructor.arguments.length === 4 &&
      canonicalFixedVectorName(
          this.#module.constructorNames[constructor.constructorIndex]!,
        ) === F32X4_CONSTRUCTOR_NAME
    ) return true;
    const application = this.namedApplication(nodeIndex);
    if (application === undefined) return false;
    const { definition, arguments: arguments_ } = application;
    const canonicalDefinition = canonicalFixedVectorName(definition);
    if (canonicalDefinition === F32x4Definition.Splat) return arguments_.length === 1;
    if (simdF32x4BinaryOpcode(definition) !== undefined) {
      return arguments_.length === 2 &&
        this.isKnownF32x4Expression(arguments_[0]!.node, environment) &&
        this.isKnownF32x4Expression(arguments_[1]!.node, environment);
    }
    if (canonicalDefinition === F32x4Definition.Select) {
      return arguments_.length === 3 &&
        this.isKnownMask32x4Expression(arguments_[0]!.node, environment) &&
        this.isKnownF32x4Expression(arguments_[1]!.node, environment) &&
        this.isKnownF32x4Expression(arguments_[2]!.node, environment);
    }
    return f32x4ReplacementLane(definition) !== undefined && arguments_.length === 2 &&
      this.isKnownF32x4Expression(arguments_[0]!.node, environment);
  }

  isKnownMask32x4Expression(
    nodeIndex: number,
    environment: Environment,
  ): boolean {
    const application = this.namedApplication(nodeIndex);
    if (
      application === undefined || application.arguments.length !== 2 ||
      simdF32x4ComparisonOpcode(application.definition) === undefined
    ) return false;
    return this.isKnownF32x4Expression(application.arguments[0]!.node, environment) &&
      this.isKnownF32x4Expression(application.arguments[1]!.node, environment);
  }

  compileMask32x4Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Apply) {
      const kind = this.compileSimdVectorApplication(instructions, nodeIndex, environment);
      if (kind?.kind === "mask32x4") return;
    }
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxMask32x4(instructions);
  }

  compileSimdMap(
    instructions: WasmInstructions,
    arguments_: readonly CallArgument[],
    environment: Environment,
  ): boolean {
    const transform = this.virtualLambda(arguments_[0]!.node, environment);
    if (transform === undefined) return false;
    const lambda = this.node(transform.node);
    if (
      lambda.tag !== CoreTag.Lambda ||
      !this.canVectorizeFloat32Expression(lambda.child0, 1)
    ) return false;
    this.compileF32x4Expression(instructions, arguments_[1]!.node, environment);
    const vector = instructions.addLocal(WasmValueType.V128);
    instructions.localSet(vector);
    this.compileVectorizedFloat32Expression(instructions, lambda.child0, [vector]);
    return true;
  }

  compileSimdZip(
    instructions: WasmInstructions,
    arguments_: readonly CallArgument[],
    environment: Environment,
  ): boolean {
    const combine = this.virtualLambda(arguments_[0]!.node, environment);
    if (combine === undefined) return false;
    const outerLambda = this.node(combine.node);
    if (outerLambda.tag !== CoreTag.Lambda) return false;
    const innerLambda = this.node(outerLambda.child0);
    if (
      innerLambda.tag !== CoreTag.Lambda ||
      !this.canVectorizeFloat32Expression(innerLambda.child0, 2)
    ) return false;
    this.compileF32x4Expression(instructions, arguments_[1]!.node, environment);
    const left = instructions.addLocal(WasmValueType.V128);
    instructions.localSet(left);
    this.compileF32x4Expression(instructions, arguments_[2]!.node, environment);
    const right = instructions.addLocal(WasmValueType.V128);
    instructions.localSet(right);
    this.compileVectorizedFloat32Expression(
      instructions,
      innerLambda.child0,
      [right, left],
    );
    return true;
  }

  canVectorizeFloat32Expression(nodeIndex: number, parameterCount: number): boolean {
    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Float32) return true;
    if (node.tag === CoreTag.Local) return node.payload < parameterCount;
    if (node.tag === CoreTag.Unary) {
      return (node.payload === UnaryOperator.NegateFloat32 ||
        node.payload === UnaryOperator.SquareRootFloat32) &&
        this.canVectorizeFloat32Expression(node.child0, parameterCount);
    }
    return node.tag === CoreTag.Binary &&
      numericOperatorGroup(node.payload) === "float-32" &&
      !isComparisonOperator(node.payload) &&
      this.canVectorizeFloat32Expression(node.child0, parameterCount) &&
      this.canVectorizeFloat32Expression(node.child1, parameterCount);
  }

  compileVectorizedFloat32Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    parameters: readonly number[],
  ): void {
    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Float32) {
      instructions.f32Const(float32FromBits(node.payload));
      instructions.simd(WasmSimdOpcode.F32x4Splat);
      return;
    }
    if (node.tag === CoreTag.Local) {
      const parameter = parameters[node.payload];
      if (parameter === undefined) {
        throw new Error(
          `functional SIMD expression at core node ${nodeIndex} omitted vector parameter depth ${node.payload}`,
        );
      }
      instructions.localGet(parameter);
      return;
    }
    if (node.tag === CoreTag.Unary) {
      this.compileVectorizedFloat32Expression(instructions, node.child0, parameters);
      instructions.simd(
        node.payload === UnaryOperator.NegateFloat32
          ? WasmSimdOpcode.F32x4Negate
          : WasmSimdOpcode.F32x4SquareRoot,
      );
      return;
    }
    if (node.tag === CoreTag.Binary) {
      this.compileVectorizedFloat32Expression(instructions, node.child0, parameters);
      this.compileVectorizedFloat32Expression(instructions, node.child1, parameters);
      const opcode = simdFloat32Operator(node.payload);
      if (opcode === undefined) {
        throw new Error(
          `functional SIMD expression at core node ${nodeIndex} has unsupported operator ${node.payload}`,
        );
      }
      instructions.simd(opcode);
      return;
    }
    throw new Error(
      `functional SIMD expression at core node ${nodeIndex} has unsupported tag ${node.tag}`,
    );
  }

  float32CombineOperator(
    nodeIndex: number,
    environment: Environment,
  ): number | undefined {
    const combine = this.virtualLambda(nodeIndex, environment);
    if (combine === undefined) return undefined;
    const outerLambda = this.node(combine.node);
    if (outerLambda.tag !== CoreTag.Lambda) return undefined;
    const innerLambda = this.node(outerLambda.child0);
    if (innerLambda.tag !== CoreTag.Lambda) return undefined;
    const body = this.node(innerLambda.child0);
    if (
      body.tag !== CoreTag.Binary ||
      numericOperatorGroup(body.payload) !== "float-32" ||
      isComparisonOperator(body.payload)
    ) return undefined;
    const left = this.node(body.child0);
    const right = this.node(body.child1);
    return left.tag === CoreTag.Local && left.payload === 1 &&
        right.tag === CoreTag.Local && right.payload === 0
      ? body.payload
      : undefined;
  }

  namedApplication(nodeIndex: number): NamedApplication | undefined {
    const reverseArguments: CallArgument[] = [];
    let baseNode = nodeIndex;
    let node = this.node(baseNode);
    while (node.tag === CoreTag.Apply) {
      if (node.payload === NO_INDEX) return undefined;
      reverseArguments.push({ node: node.child1, evaluationMode: node.evaluationMode });
      baseNode = node.child0;
      node = this.node(baseNode);
    }
    if (node.tag !== CoreTag.Global) return undefined;
    const definition = this.#module.definitionNames[node.payload];
    if (definition === undefined) return undefined;
    return { definition, arguments: Object.freeze(reverseArguments.reverse()) };
  }

  emitExtractF32x4Lane(
    instructions: WasmInstructions,
    vector: number,
    lane: number,
  ): void {
    instructions.localGet(vector);
    instructions.simd(WasmSimdOpcode.F32x4ExtractLane, lane);
  }

  compileFloat64Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    this.#runtimeEmitter.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Float64:
        instructions.f64Const(float64FromBits(wideLiteralBits(node)));
        return;
      case CoreTag.Unary:
        if (node.payload !== UnaryOperator.NegateFloat64) break;
        this.compileFloat64Expression(instructions, node.child0, environment);
        instructions.emit(0x9a);
        return;
      case CoreTag.Binary:
        if (numericOperatorGroup(node.payload) !== "float-64") break;
        this.compileFloat64Expression(instructions, node.child0, environment);
        this.compileFloat64Expression(instructions, node.child1, environment);
        this.emitNumericBinary(instructions, node.payload, nodeIndex);
        return;
      case CoreTag.NumericConvert:
        this.compileNumericConversion(
          instructions,
          node,
          nodeIndex,
          environment,
          "float-64",
        );
        return;
      case CoreTag.If: {
        const selectedBranch = this.constantIfBranch(node, environment);
        if (selectedBranch !== undefined) {
          this.compileFloat64Expression(instructions, selectedBranch, environment);
          return;
        }
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.F64);
        this.compileFloat64Expression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileFloat64Expression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
      }
    }
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxFloat64(instructions);
  }

  compileComparisonOperands(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    nodeIndex: number,
  ): void {
    const group = numericOperatorGroup(node.payload);
    if (group === "integer") {
      this.compileIntegerExpression(instructions, node.child0, environment);
      this.compileIntegerExpression(instructions, node.child1, environment);
    } else if (group === "signed-integer-64") {
      this.compileSignedInteger64Expression(
        instructions,
        node.child0,
        environment,
      );
      this.compileSignedInteger64Expression(
        instructions,
        node.child1,
        environment,
      );
    } else if (group === "float-32") {
      this.compileFloat32Expression(instructions, node.child0, environment);
      this.compileFloat32Expression(instructions, node.child1, environment);
    } else if (group === "float-64") {
      this.compileFloat64Expression(instructions, node.child0, environment);
      this.compileFloat64Expression(instructions, node.child1, environment);
    } else {
      this.compileWholeNumberF64Expression(instructions, node.child0, environment);
      this.compileWholeNumberF64Expression(instructions, node.child1, environment);
    }
    this.emitNumericBinary(instructions, node.payload, nodeIndex);
  }

  compileWholeNumberF64Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    this.#runtimeEmitter.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case CoreTag.WholeNumberF64:
        instructions.f64Const(float64FromBits(wideLiteralBits(node)));
        return;
      case CoreTag.Unary:
        if (node.payload !== UnaryOperator.NegateWholeNumberF64) break;
        this.compileWholeNumberF64Expression(instructions, node.child0, environment);
        instructions.emit(0x9a);
        return;
      case CoreTag.Binary:
        if (numericOperatorGroup(node.payload) !== "whole-number-f64") break;
        this.compileWholeNumberF64Expression(instructions, node.child0, environment);
        this.compileWholeNumberF64Expression(instructions, node.child1, environment);
        this.emitNumericBinary(instructions, node.payload, nodeIndex);
        return;
      case CoreTag.If: {
        const selectedBranch = this.constantIfBranch(node, environment);
        if (selectedBranch !== undefined) {
          this.compileWholeNumberF64Expression(instructions, selectedBranch, environment);
          return;
        }
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.F64);
        this.compileWholeNumberF64Expression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileWholeNumberF64Expression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
      }
    }
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxFloat64(instructions);
  }

  compileNumericConversion(
    instructions: WasmInstructions,
    node: CoreNode,
    nodeIndex: number,
    environment: Environment,
    expectedResult: NumericPrimitiveKind,
  ): void {
    const conversion = numericConversion(node.payload);
    if (conversion.result !== expectedResult) {
      throw new Error(
        `functional WASM numeric conversion ${node.payload} produces ${conversion.result}; expected ${expectedResult}`,
      );
    }
    if (conversion.source === "integer") {
      this.compileIntegerExpression(instructions, node.child0, environment);
    } else if (conversion.source === "signed-integer-64") {
      this.compileSignedInteger64Expression(
        instructions,
        node.child0,
        environment,
      );
    } else if (conversion.source === "float-32") {
      this.compileFloat32Expression(instructions, node.child0, environment);
    } else {
      this.compileFloat64Expression(instructions, node.child0, environment);
    }
    if (
      (conversion.source === "float-32" || conversion.source === "float-64") &&
      (conversion.result === "integer" || conversion.result === "signed-integer-64")
    ) {
      this.emitNumericConversionGuard(
        instructions,
        nodeIndex,
        conversion.source,
        conversion.result,
      );
    }
    instructions.emit(conversion.opcode);
  }

  emitNumericConversionGuard(
    instructions: WasmInstructions,
    nodeIndex: number,
    source: "float-32" | "float-64",
    result: "integer" | "signed-integer-64",
  ): void {
    const valueType = source === "float-32" ? WasmValueType.F32 : WasmValueType.F64;
    const value = instructions.addLocal(valueType);
    instructions.localSet(value);
    instructions.localGet(value);
    instructions.localGet(value);
    instructions.emit(source === "float-32" ? 0x5c : 0x62);
    instructions.localGet(value);
    const lower = result === "integer" ? -2_147_483_648 : -9_223_372_036_854_775_808;
    if (source === "float-32") instructions.f32Const(lower);
    else instructions.f64Const(lower);
    instructions.emit(source === "float-32" ? 0x5d : 0x63, 0x72);
    instructions.localGet(value);
    const upper = result === "integer" ? 2_147_483_648 : 9_223_372_036_854_775_808;
    if (source === "float-32") instructions.f32Const(upper);
    else instructions.f64Const(upper);
    instructions.emit(source === "float-32" ? 0x60 : 0x66, 0x72, 0x04, 0x40);
    this.#runtimeEmitter.emitFault(
      instructions,
      WASM_FAULT_INVALID_NUMERIC_CONVERSION,
      nodeIndex,
    );
    instructions.emit(0x0b);
    instructions.localGet(value);
  }

  compileNumericConversionExpression(
    instructions: WasmInstructions,
    node: CoreNode,
    nodeIndex: number,
    environment: Environment,
  ): void {
    const result = numericConversion(node.payload).result;
    if (result === "integer") {
      this.compileNumericConversion(instructions, node, nodeIndex, environment, result);
      this.emitEncodeInteger(instructions);
      return;
    }
    if (result === "signed-integer-64") {
      this.compileNumericConversion(instructions, node, nodeIndex, environment, result);
      this.emitBoxSignedInteger64(instructions);
      return;
    }
    if (result === "float-32") {
      this.compileNumericConversion(instructions, node, nodeIndex, environment, result);
      this.emitBoxFloat32(instructions);
      return;
    }
    this.compileNumericConversion(instructions, node, nodeIndex, environment, result);
    this.emitBoxFloat64(instructions);
  }

  emitNumericBinary(
    instructions: WasmInstructions,
    operator: number,
    nodeIndex: number,
  ): void {
    if (operator === BinaryOperator.RemainderFloat64) {
      const divisor = instructions.addLocal(WasmValueType.F64);
      instructions.localSet(divisor);
      const dividend = instructions.addLocal(WasmValueType.F64);
      instructions.localSet(dividend);
      instructions.localGet(divisor);
      instructions.f64Const(0);
      instructions.emit(0x61, 0x04, WasmValueType.F64);
      instructions.f64Const(Number.NaN);
      instructions.emit(0x05);
      instructions.localGet(divisor);
      instructions.localGet(divisor);
      instructions.emit(0x61, 0x04, WasmValueType.F64);
      instructions.localGet(divisor);
      instructions.f64Const(0);
      instructions.emit(0xa2);
      instructions.f64Const(0);
      instructions.emit(0x61, 0x04, WasmValueType.F64);
      instructions.localGet(dividend);
      instructions.localGet(divisor);
      instructions.emit(0xa3, 0x9d);
      instructions.localGet(divisor);
      instructions.emit(0xa2);
      instructions.localSet(divisor);
      instructions.localGet(dividend);
      instructions.localGet(divisor);
      instructions.emit(0xa1);
      instructions.localTee(divisor);
      instructions.f64Const(0);
      instructions.emit(0x61, 0x04, WasmValueType.F64);
      instructions.f64Const(0);
      instructions.localGet(dividend);
      instructions.emit(0xa6, 0x05);
      instructions.localGet(divisor);
      instructions.emit(0x0b, 0x05);
      instructions.localGet(dividend);
      instructions.f64Const(0);
      instructions.emit(0xa2);
      instructions.f64Const(0);
      instructions.emit(0x61, 0x04, WasmValueType.F64);
      instructions.localGet(dividend);
      instructions.emit(0x05);
      instructions.f64Const(Number.NaN);
      instructions.emit(0x0b, 0x0b, 0x05);
      instructions.f64Const(Number.NaN);
      instructions.emit(0x0b, 0x0b);
      return;
    }
    if (
      operator === BinaryOperator.DivideWholeNumberF64 ||
      operator === BinaryOperator.RemainderWholeNumberF64
    ) {
      const divisor = instructions.addLocal(WasmValueType.F64);
      instructions.localSet(divisor);
      const dividend = instructions.addLocal(WasmValueType.F64);
      instructions.localSet(dividend);
      instructions.localGet(divisor);
      instructions.f64Const(0);
      instructions.emit(0x61, 0x04, WasmValueType.F64);
      instructions.f64Const(0);
      instructions.emit(0x05);
      instructions.localGet(dividend);
      instructions.localGet(divisor);
      instructions.emit(0xa3, 0x9d);
      if (operator === BinaryOperator.RemainderWholeNumberF64) {
        instructions.localGet(divisor);
        instructions.emit(0xa2);
        const multiple = instructions.addLocal(WasmValueType.F64);
        instructions.localSet(multiple);
        instructions.localGet(dividend);
        instructions.localGet(multiple);
        instructions.emit(0xa1);
      }
      instructions.emit(0x0b);
      return;
    }
    const opcode = numericBinaryOpcode(operator);
    if (opcode === undefined) {
      throw new Error(
        `functional WASM numeric operator ${operator} at core node ${nodeIndex} is unsupported`,
      );
    }
    if (
      operator === BinaryOperator.DivideSignedInteger64 ||
      operator === BinaryOperator.RemainderSignedInteger64
    ) {
      const divisor = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(divisor);
      const dividend = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(dividend);
      this.emitDivisionByZeroGuard(instructions, nodeIndex, divisor, "i64");
      instructions.localGet(dividend);
      instructions.i64Const(-0x8000000000000000n);
      instructions.emit(0x51);
      instructions.localGet(divisor);
      instructions.i64Const(-1n);
      instructions.emit(0x51, 0x71, 0x04, WasmValueType.I64);
      instructions.i64Const(
        operator === BinaryOperator.DivideSignedInteger64 ? -0x8000000000000000n : 0n,
      );
      instructions.emit(0x05);
      instructions.localGet(dividend);
      instructions.localGet(divisor);
      instructions.emit(opcode, 0x0b);
      return;
    }
    instructions.emit(opcode);
  }

  emitDivisionByZeroGuard(
    instructions: WasmInstructions,
    nodeIndex: number,
    divisor: number,
    divisorType: "i32" | "i64",
  ): void {
    instructions.localGet(divisor);
    instructions.emit(divisorType === "i32" ? 0x45 : 0x50, 0x04, 0x40);
    this.#runtimeEmitter.emitFault(
      instructions,
      WASM_FAULT_DIVIDE_BY_ZERO,
      nodeIndex,
    );
    instructions.emit(0x0b);
  }

  compileBinary(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    nodeIndex: number,
  ): void {
    if (
      node.payload === BinaryOperator.StructuralEqual ||
      node.payload === BinaryOperator.StructuralNotEqual
    ) {
      this.compileStructuralEquality(instructions, node, environment);
      this.emitEncodeBoolean(instructions);
      return;
    }
    const group = numericOperatorGroup(node.payload);
    if (group !== "integer") {
      this.compileComparisonOperands(
        instructions,
        node,
        environment,
        nodeIndex,
      );
      if (isComparisonOperator(node.payload)) {
        this.emitEncodeBoolean(instructions);
        return;
      }
      if (group === "signed-integer-64") {
        this.emitBoxSignedInteger64(instructions);
      } else if (group === "float-32") this.emitBoxFloat32(instructions);
      else if (group === "float-64" || group === "whole-number-f64") {
        this.emitBoxFloat64(instructions);
      } else {
        throw new Error(
          `functional WASM operator ${node.payload} has invalid numeric group`,
        );
      }
      return;
    }
    if (isComparisonOperator(node.payload)) {
      switch (node.payload) {
        case BinaryOperator.Equal:
        case BinaryOperator.NotEqual:
        case BinaryOperator.Less:
        case BinaryOperator.LessEqual:
        case BinaryOperator.Greater:
        case BinaryOperator.GreaterEqual:
          this.compileIntegerExpression(instructions, node.child0, environment);
          this.compileIntegerExpression(instructions, node.child1, environment);
          this.emitComparison(instructions, node.payload, nodeIndex);
          this.emitEncodeBoolean(instructions);
          return;
        default:
          throw new Error(
            `functional WASM binary operator ${node.payload} at core node ${nodeIndex} is unsupported`,
          );
      }
    }
    this.compileIntegerExpression(instructions, nodeIndex, environment);
    this.emitEncodeInteger(instructions);
  }

  compileStructuralEquality(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
  ): void {
    this.compileExpression(instructions, node.child0, environment);
    this.compileExpression(instructions, node.child1, environment);
    instructions.call(this.structuralEqualityFunctionIndex());
    if (node.payload === BinaryOperator.StructuralNotEqual) instructions.emit(0x45);
  }

  structuralEqualityFunctionIndex(): number {
    if (this.#structuralEqualitySlot !== undefined) {
      return this.indirectFunctionOffset() + this.#structuralEqualitySlot;
    }
    const slot = this.reserveIndirectFunction();
    this.#structuralEqualitySlot = slot;
    const functionIndex = this.indirectFunctionOffset() + slot;
    this.#indirectFunctions[slot] = structuralEqualityFunction({
      typeIndex: this.functionTypeIndex(
        [WasmValueType.I64, WasmValueType.I64],
        [WasmValueType.I32],
      ),
      functionIndex,
      emitForceValue: (instructions) => this.emitForceValue(instructions),
      emitFuelChargeAmount: (instructions, amount) =>
        this.#runtimeEmitter.emitFuelChargeAmount(instructions, amount, -1),
    });
    return functionIndex;
  }

  compileCase(
    instructions: WasmInstructions,
    node: CoreNode,
    environment: Environment,
    nodeIndex: number,
    constructorReuse?: ConstructorReuseTarget,
  ): void {
    const virtualConstructor = this.scalarSpecializationEnabled()
      ? this.virtualConstructor(node.child0, environment)
      : undefined;
    if (virtualConstructor !== undefined) {
      this.compileKnownCaseArm(
        instructions,
        node,
        virtualConstructor,
        environment,
        nodeIndex,
        "value",
        constructorReuse,
      );
      return;
    }
    const scrutineeNode = this.node(node.child0);
    const scrutinee = scrutineeNode.tag === CoreTag.Local
      ? this.localSource(environment, scrutineeNode.payload, node.child0)
      : undefined;
    const constructor = instructions.addLocal(WasmValueType.I32);
    let resultReuse = constructorReuse;
    if (
      scrutinee?.kind === "unique-constructor" &&
      scrutinee.reusableCases.has(nodeIndex)
    ) {
      this.#runtimeEmitter.emitFuelCharge(instructions, node.child0);
      instructions.localGet(scrutinee.index);
      instructions.emit(0xa7);
      instructions.localSet(constructor);
      resultReuse = {
        pointer: constructor,
        fieldCount: scrutinee.fieldCount,
      };
    } else {
      this.compileExpression(instructions, node.child0, environment);
      instructions.emit(0xa7);
      instructions.localSet(constructor);
    }
    this.compileCaseAlternatives(
      instructions,
      node,
      constructor,
      environment,
      nodeIndex,
      resultReuse,
    );
  }

  compileKnownCaseArm(
    instructions: WasmInstructions,
    node: CoreNode,
    constructor: VirtualConstructor,
    environment: Environment,
    caseNodeIndex: number,
    resultKind: "value" | "integer" = "value",
    constructorReuse?: ConstructorReuseTarget,
  ): void {
    const arity = this.#module.constructorArities[constructor.constructorIndex];
    if (arity === undefined || constructor.arguments.length !== arity) {
      throw new Error(
        `functional WASM known constructor ${constructor.constructorIndex} at core node ${caseNodeIndex} has ${constructor.arguments.length} fields; expected ${
          String(arity)
        }`,
      );
    }
    const fields = constructor.arguments.map((argument) =>
      this.compileExpressionBinding(
        instructions,
        argument,
        constructor.environment,
      )
    );
    for (const alternative of this.caseAlternatives(node, caseNodeIndex)) {
      if (alternative.constructor === constructor.constructorIndex) {
        if (alternative.binderCount !== arity) {
          throw new Error(
            `functional WASM case at core node ${caseNodeIndex} binds ${alternative.binderCount} fields for constructor ${constructor.constructorIndex}; expected ${arity}`,
          );
        }
        let armEnvironment = [...environment];
        for (let bindingIndex = 0; bindingIndex < arity; bindingIndex += 1) {
          const field = fields[arity - bindingIndex - 1];
          if (field === undefined) {
            throw new Error(
              `functional WASM known constructor ${constructor.constructorIndex} omitted field ${
                arity - bindingIndex - 1
              }`,
            );
          }
          armEnvironment = [field, ...armEnvironment];
        }
        if (resultKind === "integer") {
          this.compileIntegerExpression(instructions, alternative.body, armEnvironment);
        } else {
          this.compileExpression(
            instructions,
            alternative.body,
            armEnvironment,
            constructorReuse,
          );
        }
        return;
      }
    }
    throw new Error(
      `functional WASM case at core node ${caseNodeIndex} has no arm for known constructor ${constructor.constructorIndex}`,
    );
  }

  compileExpressionBinding(
    instructions: WasmInstructions,
    expression: CallArgument,
    environment: Environment,
  ): Binding {
    const virtualLambda = this.virtualLambda(expression.node, environment);
    if (virtualLambda !== undefined) return virtualLambda;
    const virtualConstructor = this.virtualConstructor(
      expression.node,
      environment,
    );
    if (virtualConstructor !== undefined) return virtualConstructor;
    const integer = this.constantIntegerExpression(expression.node, environment);
    if (integer !== undefined) {
      return { kind: "i32-integer-constant", literal: integer };
    }
    const boolean = this.constantBooleanExpression(expression.node, environment);
    if (boolean !== undefined) {
      return { kind: "i32-boolean-constant", literal: boolean };
    }
    this.compileApplicationArgument(
      instructions,
      expression,
      environment,
      true,
    );
    const value = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(value);
    return { kind: "i64-value", index: value };
  }

  compileCaseAlternatives(
    instructions: WasmInstructions,
    node: CoreNode,
    constructor: number,
    environment: Environment,
    caseNodeIndex: number,
    constructorReuse?: ConstructorReuseTarget,
  ): void {
    let openArmCount = 0;
    for (const alternative of this.caseAlternatives(node, caseNodeIndex)) {
      const arity = this.#module.constructorArities[alternative.constructor];
      if (arity === undefined || alternative.binderCount !== arity) {
        throw new Error(
          `functional WASM case at core node ${caseNodeIndex} binds ${alternative.binderCount} fields for constructor ${alternative.constructor}; expected ${
            String(arity)
          }`,
        );
      }
      instructions.localGet(constructor);
      instructions.i32Load(4);
      instructions.i32Const(alternative.constructor);
      instructions.emit(0x46, 0x04, WasmValueType.I64);
      let armEnvironment = [...environment];
      for (let bindingIndex = 0; bindingIndex < arity; bindingIndex++) {
        instructions.localGet(constructor);
        instructions.i64Load(
          OBJECT_HEADER_BYTE_LENGTH +
            (arity - bindingIndex - 1) * VALUE_BYTE_LENGTH,
        );
        const field = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(field);
        armEnvironment = [
          { kind: "i64-local", index: field },
          ...armEnvironment,
        ];
      }
      this.compileExpression(
        instructions,
        alternative.body,
        armEnvironment,
        constructorReuse,
      );
      instructions.emit(0x05);
      openArmCount += 1;
    }
    instructions.emit(0x00);
    for (let index = 0; index < openArmCount; index++) instructions.emit(0x0b);
  }

  compileThunk(
    instructions: WasmInstructions,
    expressionNode: number,
    environment: Environment,
  ): void {
    const slot = this.reserveIndirectFunction();
    const captured = this.prunedCaptures(
      expressionNode,
      0,
      environment,
      THUNK_HEADER_BYTE_LENGTH,
    );
    const bodyInstructions = new WasmInstructions(1);
    this.compileExpression(
      bodyInstructions,
      expressionNode,
      captured.bodyEnvironment,
    );
    this.#indirectFunctions[slot] = functionBody(
      4,
      bodyInstructions,
      `thunk core node ${expressionNode}`,
    );
    this.emitThunkObject(instructions, slot, captured.captureSources);
  }

  compileLazyValue(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
  ): void {
    if (this.expressionIsWhnf(nodeIndex)) {
      this.compileExpression(instructions, nodeIndex, environment);
      return;
    }
    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Local) {
      this.emitBinding(
        instructions,
        this.localSource(environment, node.payload, nodeIndex),
      );
      return;
    }
    if (node.tag === CoreTag.Global) {
      if (node.payload >= this.#module.definitionCount) {
        throw new Error(
          `functional WASM global d${node.payload} at core node ${nodeIndex} exceeds ${this.#module.definitionCount} definitions`,
        );
      }
      instructions.i32Const(node.payload * VALUE_BYTE_LENGTH);
      instructions.i64Load(0);
      return;
    }
    this.compileThunk(instructions, nodeIndex, environment);
  }

  compileApplicationArgument(
    instructions: WasmInstructions,
    argument: CallArgument,
    environment: Environment,
    demandedImmediately: boolean,
  ): void {
    if (
      argument.evaluationMode === EvaluationMode.StrictEager ||
      demandedImmediately
    ) {
      this.compileExpression(instructions, argument.node, environment);
      return;
    }
    this.compileLazyValue(instructions, argument.node, environment);
  }

  localSource(
    environment: Environment,
    depth: number,
    nodeIndex: number,
  ): Binding {
    const source = environment[depth];
    if (source !== undefined) return source;
    throw new Error(
      depth < environment.length
        ? `functional WASM local depth ${depth} at core node ${nodeIndex} was pruned from its closure captures`
        : `functional WASM local depth ${depth} at core node ${nodeIndex} exceeds environment depth ${environment.length}`,
    );
  }

  prunedCaptures(
    bodyNode: number,
    binderDepth: number,
    environment: Environment,
    firstCaptureByteOffset: number,
  ): {
    readonly captureSources: readonly Binding[];
    readonly bodyEnvironment: Environment;
  } {
    const captureSources: Binding[] = [];
    const bodyEnvironment: (Binding | undefined)[] = Array.from(
      { length: environment.length },
      () => undefined,
    );
    for (const freeDepth of this.#captureAnalysis.freeLocalDepths(bodyNode)) {
      if (freeDepth < binderDepth) continue;
      const environmentDepth = freeDepth - binderDepth;
      if (environmentDepth >= environment.length) {
        throw new Error(
          `functional WASM closure at core node ${bodyNode} references local depth ${freeDepth} beyond binder depth ${binderDepth} and environment depth ${environment.length}`,
        );
      }
      const source = environment[environmentDepth];
      if (source === undefined) {
        throw new Error(
          `functional WASM closure at core node ${bodyNode} references local depth ${freeDepth} that an enclosing closure pruned`,
        );
      }
      bodyEnvironment[environmentDepth] = {
        kind: "capture",
        byteOffset: firstCaptureByteOffset +
          captureSources.length * VALUE_BYTE_LENGTH,
      };
      captureSources.push(source);
    }
    return { captureSources, bodyEnvironment };
  }

  constructorApplication(
    nodeIndex: number,
  ): ConstructorApplication | undefined {
    const reverseArguments: CallArgument[] = [];
    let calleeIndex = nodeIndex;
    let callee = this.node(calleeIndex);
    while (callee.tag === CoreTag.Apply) {
      if (callee.payload === NO_INDEX) return undefined;
      reverseArguments.push({
        node: callee.child1,
        evaluationMode: callee.evaluationMode,
      });
      calleeIndex = callee.child0;
      callee = this.node(calleeIndex);
    }
    if (callee.tag !== CoreTag.Constructor) return undefined;
    const arity = this.#module.constructorArities[callee.payload];
    if (
      arity === undefined || reverseArguments.length === 0 ||
      reverseArguments.length > arity
    ) {
      return undefined;
    }
    return {
      constructorNode: calleeIndex,
      constructorIndex: callee.payload,
      arguments: Object.freeze(reverseArguments.reverse()),
    };
  }

  virtualConstructor(
    nodeIndex: number,
    environment: Environment,
    remainingDepth = 64,
  ): VirtualConstructor | undefined {
    if (remainingDepth === 0) return undefined;
    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Local) {
      const binding = environment[node.payload];
      return binding?.kind === "virtual-constructor" ? binding : undefined;
    }
    const application = this.constructorApplication(nodeIndex);
    if (application !== undefined) {
      const arity = this.#module.constructorArities[application.constructorIndex];
      if (arity === undefined || application.arguments.length !== arity) {
        return undefined;
      }
      if (
        application.arguments.some((argument) =>
          this.staticBinding(
            argument.node,
            environment,
            remainingDepth - 1,
          ) === undefined
        )
      ) return undefined;
      return {
        kind: "virtual-constructor",
        constructorIndex: application.constructorIndex,
        arguments: application.arguments,
        environment,
      };
    }
    if (node.tag === CoreTag.Let) {
      const binding = this.staticBinding(
        node.child0,
        environment,
        remainingDepth - 1,
      );
      return binding === undefined ? undefined : this.virtualConstructor(
        node.child1,
        [binding, ...environment],
        remainingDepth - 1,
      );
    }
    if (node.tag === CoreTag.Apply) {
      const callee = this.virtualLambda(node.child0, environment);
      if (callee === undefined) return undefined;
      const lambda = this.node(callee.node);
      if (lambda.tag !== CoreTag.Lambda) return undefined;
      const argument = this.staticBinding(
        node.child1,
        environment,
        remainingDepth - 1,
      );
      return argument === undefined ? undefined : this.virtualConstructor(
        lambda.child0,
        [argument, ...callee.environment],
        remainingDepth - 1,
      );
    }
    if (node.tag === CoreTag.If) {
      const condition = this.constantBooleanExpression(node.child0, environment);
      if (condition === undefined) return undefined;
      return this.virtualConstructor(
        condition ? node.child1 : node.child2,
        environment,
        remainingDepth - 1,
      );
    }
    return undefined;
  }

  staticBinding(
    nodeIndex: number,
    environment: Environment,
    remainingDepth: number,
  ): Binding | undefined {
    const lambda = this.virtualLambda(nodeIndex, environment, remainingDepth);
    if (lambda !== undefined) return lambda;
    const constructor = this.virtualConstructor(
      nodeIndex,
      environment,
      remainingDepth,
    );
    if (constructor !== undefined) return constructor;
    const integer = this.constantIntegerExpression(nodeIndex, environment);
    if (integer !== undefined) {
      return { kind: "i32-integer-constant", literal: integer };
    }
    const boolean = this.constantBooleanExpression(nodeIndex, environment);
    return boolean === undefined ? undefined : { kind: "i32-boolean-constant", literal: boolean };
  }

  scalarConstantBinding(
    nodeIndex: number,
    environment: Environment,
  ): ValueSource | undefined {
    const constant = this.#constantAnalysis.scalar(
      nodeIndex,
      this.constantResolver(environment),
    );
    if (constant?.kind === "integer") {
      return { kind: "i32-integer-constant", literal: constant.value };
    }
    if (constant?.kind === "boolean") {
      return { kind: "i32-boolean-constant", literal: constant.value };
    }
    return undefined;
  }

  emitThunkObject(
    instructions: WasmInstructions,
    slot: number,
    captures: readonly Binding[],
  ): void {
    instructions.i32Const(
      THUNK_HEADER_BYTE_LENGTH + captures.length * VALUE_BYTE_LENGTH,
    );
    instructions.call(this.allocateFunctionIndex());
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(pointer);
    instructions.localGet(pointer);
    instructions.i32Const(THUNK_OBJECT_KIND);
    instructions.i32Store(0);
    instructions.localGet(pointer);
    instructions.i32Const(THUNK_UNEVALUATED);
    instructions.i32Store(4);
    instructions.localGet(pointer);
    instructions.i32Const(slot);
    instructions.i32Store(8);
    if (captures.length > 0) {
      instructions.localGet(pointer);
      instructions.i32Const(captures.length);
      instructions.i32Store(12);
    }
    for (const [index, source] of captures.entries()) {
      instructions.localGet(pointer);
      this.emitBinding(instructions, source);
      instructions.i64Store(
        THUNK_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH,
      );
    }
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitForceValue(
    instructions: WasmInstructions,
    sourceLocal?: number,
  ): void {
    if (!this.#compactScalar && sourceLocal === undefined) {
      instructions.call(this.#functionImports.length + 3);
      return;
    }
    const value = sourceLocal ?? instructions.addLocal(WasmValueType.I64);
    const pointer = instructions.addLocal(WasmValueType.I32);
    if (sourceLocal === undefined) instructions.localSet(value);
    instructions.localGet(value);
    instructions.i64Const(7n);
    instructions.emit(0x83, 0x50, 0x04, WasmValueType.I64);
    instructions.localGet(value);
    instructions.emit(0xa7);
    instructions.localTee(pointer);
    instructions.i32Load(0);
    instructions.i32Const(THUNK_OBJECT_KIND);
    instructions.emit(0x46, 0x04, WasmValueType.I64);
    instructions.localGet(pointer);
    instructions.i32Load(4);
    instructions.i32Const(THUNK_EVALUATED);
    instructions.emit(0x46, 0x04, WasmValueType.I64);
    instructions.localGet(pointer);
    instructions.i64Load(16);
    instructions.emit(0x05);
    instructions.localGet(pointer);
    instructions.call(this.forceThunkFunctionIndex());
    instructions.emit(0x0b, 0x05);
    instructions.localGet(value);
    instructions.emit(0x0b, 0x05);
    instructions.localGet(value);
    instructions.emit(0x0b);
  }

  expressionIsWhnf(nodeIndex: number): boolean {
    switch (this.node(nodeIndex).tag) {
      case CoreTag.Integer:
      case CoreTag.SignedInteger64:
      case CoreTag.Float32:
      case CoreTag.Float64:
      case CoreTag.WholeNumberF64:
      case CoreTag.Boolean:
      case CoreTag.Lambda:
      case CoreTag.Constructor:
        return true;
      default:
        return false;
    }
  }

  canCompileIntegerExpression(nodeIndex: number): boolean {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Integer:
        return true;
      case CoreTag.Unary:
        return node.payload === UnaryOperator.Negate &&
          this.canCompileIntegerExpression(node.child0);
      case CoreTag.Binary:
        return !isComparisonOperator(node.payload) &&
          this.canCompileIntegerExpression(node.child0) &&
          this.canCompileIntegerExpression(node.child1);
      case CoreTag.If:
        return this.canCompileIntegerExpression(node.child1) &&
          this.canCompileIntegerExpression(node.child2);
      case CoreTag.Let:
      case CoreTag.LetRec:
        return this.canCompileIntegerExpression(node.child1);
      default:
        return false;
    }
  }

  canCompileBooleanExpression(nodeIndex: number): boolean {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Boolean:
        return true;
      case CoreTag.Binary:
        return isComparisonOperator(node.payload) &&
          this.canCompileIntegerExpression(node.child0) &&
          this.canCompileIntegerExpression(node.child1);
      case CoreTag.If:
        return this.canCompileBooleanExpression(node.child1) &&
          this.canCompileBooleanExpression(node.child2);
      case CoreTag.Let:
      case CoreTag.LetRec:
        return this.canCompileBooleanExpression(node.child1);
      default:
        return false;
    }
  }

  constantIntegerExpression(
    nodeIndex: number,
    environment: Environment,
    constantLocals: readonly number[] = [],
  ): number | undefined {
    const constantResolver = this.constantResolver(environment, constantLocals);
    return this.#instrumentedFuel
      ? this.#constantAnalysis.integerWithoutLocalBindings(nodeIndex, constantResolver)
      : this.#constantAnalysis.integer(nodeIndex, constantResolver);
  }

  constantBooleanExpression(
    nodeIndex: number,
    environment: Environment,
    constantLocals: readonly number[] = [],
  ): boolean | undefined {
    const constantResolver = this.constantResolver(environment, constantLocals);
    return this.#instrumentedFuel
      ? this.#constantAnalysis.booleanWithoutLocalBindings(nodeIndex, constantResolver)
      : this.#constantAnalysis.boolean(nodeIndex, constantResolver);
  }

  constantResolver(
    environment: Environment,
    constantLocals: readonly number[] = [],
  ): ConstantResolver {
    return (localDepth) => {
      if (localDepth < constantLocals.length) {
        return {
          kind: "integer",
          value: constantLocals[constantLocals.length - localDepth - 1]!,
        };
      }
      const binding = environment[localDepth - constantLocals.length];
      if (binding?.kind === "i32-integer-constant") {
        return { kind: "integer", value: binding.literal };
      }
      if (binding?.kind === "i32-boolean-constant") {
        return { kind: "boolean", value: binding.literal };
      }
      return undefined;
    };
  }

  calleeImmediatelyForcesArgument(nodeIndex: number): boolean {
    const node = this.node(nodeIndex);
    return node.tag === CoreTag.Lambda &&
      this.immediatelyForcesLocal(node.child0, 0);
  }

  lambdaSetImmediatelyForcesArgument(lambdaNodes: readonly number[]): boolean {
    return lambdaNodes.every((lambdaNode) => {
      const lambda = this.node(lambdaNode);
      return lambda.tag === CoreTag.Lambda &&
        this.immediatelyForcesLocal(lambda.child0, 0);
    });
  }

  immediatelyForcesLocal(nodeIndex: number, localDepth: number): boolean {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case CoreTag.Local:
        return node.payload === localDepth;
      case CoreTag.Unary:
      case CoreTag.NumericConvert:
      case CoreTag.Case:
      case CoreTag.If:
        return this.immediatelyForcesLocal(node.child0, localDepth);
      case CoreTag.Binary:
      case CoreTag.Apply:
        return this.immediatelyForcesLocal(node.child0, localDepth);
      case CoreTag.Let:
      case CoreTag.LetRec:
        return this.immediatelyForcesLocal(node.child1, localDepth + 1);
      default:
        return false;
    }
  }

  emitClosure(
    instructions: WasmInstructions,
    slot: number,
    captures: readonly Binding[],
  ): void {
    const pointer = this.allocateObject(
      instructions,
      CLOSURE_OBJECT_KIND,
      slot,
      captures.length,
    );
    for (const [index, source] of captures.entries()) {
      instructions.localGet(pointer);
      this.emitBinding(instructions, source);
      instructions.i64Store(
        OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH,
      );
    }
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitConstructor(
    instructions: WasmInstructions,
    constructorIndex: number,
    fields: readonly Binding[],
    reuse?: ConstructorReuseTarget,
  ): void {
    const reusesAllocation = reuse?.fieldCount === fields.length;
    const pointer = reusesAllocation ? reuse.pointer : this.allocateObject(
      instructions,
      CONSTRUCTOR_OBJECT_KIND,
      constructorIndex,
      fields.length,
    );
    if (reusesAllocation) {
      instructions.localGet(pointer);
      instructions.i32Const(CONSTRUCTOR_OBJECT_KIND);
      instructions.i32Store(0);
      instructions.localGet(pointer);
      instructions.i32Const(constructorIndex);
      instructions.i32Store(4);
      instructions.localGet(pointer);
      instructions.i32Const(fields.length);
      instructions.i32Store(8);
    }
    for (const [index, source] of fields.entries()) {
      instructions.localGet(pointer);
      this.emitBinding(instructions, source);
      instructions.i64Store(
        OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH,
      );
    }
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  allocateObject(
    instructions: WasmInstructions,
    kind: number,
    payload: number,
    valueCount: number,
  ): number {
    instructions.i32Const(
      OBJECT_HEADER_BYTE_LENGTH + valueCount * VALUE_BYTE_LENGTH,
    );
    instructions.call(this.allocateFunctionIndex());
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localTee(pointer);
    instructions.i32Const(kind);
    instructions.i32Store(0);
    instructions.localGet(pointer);
    instructions.i32Const(payload);
    instructions.i32Store(4);
    if (valueCount > 0) {
      instructions.localGet(pointer);
      instructions.i32Const(valueCount);
      instructions.i32Store(8);
    }
    if (this.#ownedRuntimeEnabled) {
      instructions.localGet(pointer);
      instructions.i32Const(1);
      instructions.i32Store(OBJECT_REFERENCE_COUNT_BYTE_OFFSET);
    }
    return pointer;
  }

  emitBinding(instructions: WasmInstructions, source: Binding): void {
    switch (source.kind) {
      case "i64-local":
      case "i64-value":
      case "unique-constructor":
        instructions.localGet(source.index);
        return;
      case "i32-integer":
        instructions.localGet(source.index);
        this.emitEncodeInteger(instructions);
        return;
      case "i32-integer-constant":
        instructions.i64Const((BigInt(source.literal) << 3n) | 1n);
        return;
      case "i32-boolean":
        instructions.localGet(source.index);
        this.emitEncodeBoolean(instructions);
        return;
      case "i32-boolean-constant":
        instructions.i64Const(source.literal ? 10n : 2n);
        return;
      case "i32-pointer":
        instructions.localGet(source.index);
        instructions.emit(0xad);
        return;
      case "capture":
        instructions.localGet(0);
        instructions.i64Load(source.byteOffset);
        return;
      case "v128-f32x4":
        throw new Error(
          `functional WASM attempted to box an internal F32x4 local ${source.index} outside a vector boundary`,
        );
      case "join-point":
        // Unreachable by construction: `joinPointLambda` only contifies a binder whose every
        // reference is a tail call, so nothing can ask for its value.
        throw new Error(
          "functional WASM attempted to materialise a contified join point as a value",
        );
      case "virtual-lambda": {
        const lambda = this.node(source.node);
        if (lambda.tag !== CoreTag.Lambda) {
          throw new Error(
            `functional WASM virtual lambda ${source.node} has core tag ${lambda.tag}`,
          );
        }
        const captured = this.prunedCaptures(
          lambda.child0,
          1,
          source.environment,
          OBJECT_HEADER_BYTE_LENGTH,
        );
        this.emitClosure(
          instructions,
          this.lambdaSlot(source.node),
          captured.captureSources,
        );
        return;
      }
      case "virtual-constructor": {
        const fields: Binding[] = [];
        for (const argument of source.arguments) {
          fields.push(this.compileExpressionBinding(
            instructions,
            argument,
            source.environment,
          ));
        }
        this.emitConstructor(
          instructions,
          source.constructorIndex,
          fields,
        );
        return;
      }
      case "static-recursive-function": {
        const lambda = this.node(source.node);
        if (lambda.tag !== CoreTag.Lambda) {
          throw new Error(
            `functional WASM recursive closure ${source.node} has core tag ${lambda.tag}`,
          );
        }
        const capturesSelf = this.#captureAnalysis.freeLocalDepths(lambda.child0)
          .includes(1);
        const firstOuterCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
          (capturesSelf ? VALUE_BYTE_LENGTH : 0);
        const captured = this.prunedCaptures(
          lambda.child0,
          2,
          source.environment,
          firstOuterCaptureByteOffset,
        );
        const pointer = this.allocateObject(
          instructions,
          CLOSURE_OBJECT_KIND,
          this.lambdaSlot(source.node),
          captured.captureSources.length + (capturesSelf ? 1 : 0),
        );
        if (capturesSelf) {
          instructions.localGet(pointer);
          instructions.localGet(pointer);
          instructions.emit(0xad);
          instructions.i64Store(OBJECT_HEADER_BYTE_LENGTH);
        }
        for (const [index, capture] of captured.captureSources.entries()) {
          instructions.localGet(pointer);
          this.emitBinding(instructions, capture);
          instructions.i64Store(
            firstOuterCaptureByteOffset + index * VALUE_BYTE_LENGTH,
          );
        }
        instructions.localGet(pointer);
        instructions.emit(0xad);
        return;
      }
    }
  }

  emitDecodeInteger(instructions: WasmInstructions): void {
    instructions.i64Const(3n);
    instructions.emit(0x87, 0xa7);
  }

  emitDecodeBoolean(instructions: WasmInstructions): void {
    instructions.i64Const(10n);
    instructions.emit(0x51);
  }

  emitComparison(
    instructions: WasmInstructions,
    operator: number,
    nodeIndex: number,
  ): void {
    switch (operator) {
      case BinaryOperator.Equal:
        instructions.emit(0x46);
        return;
      case BinaryOperator.NotEqual:
        instructions.emit(0x47);
        return;
      case BinaryOperator.Less:
        instructions.emit(0x48);
        return;
      case BinaryOperator.LessEqual:
        instructions.emit(0x4c);
        return;
      case BinaryOperator.Greater:
        instructions.emit(0x4a);
        return;
      case BinaryOperator.GreaterEqual:
        instructions.emit(0x4e);
        return;
      default:
        throw new Error(
          `functional WASM comparison operator ${operator} at core node ${nodeIndex} is unsupported`,
        );
    }
  }

  emitHostArgument(
    instructions: WasmInstructions,
    type: HostType,
  ): void {
    if (type.kind === "tuple" || type.kind === "named") return;
    if (type.kind === "unit") {
      instructions.emit(0x1a);
      instructions.i32Const(0);
      return;
    }
    if (type.kind === "signed-integer-64") {
      this.emitUnboxSignedInteger64(instructions);
      return;
    }
    if (type.kind === "float-32") {
      this.emitUnboxFloat32(instructions);
      return;
    }
    if (type.kind === "float-64") {
      this.emitUnboxFloat64(instructions);
      return;
    }
    this.emitDecodeInteger(instructions);
  }

  emitHostResult(
    instructions: WasmInstructions,
    type: HostType,
  ): void {
    if (type.kind === "tuple" || type.kind === "named") return;
    if (type.kind === "integer") {
      this.emitEncodeInteger(instructions);
      return;
    }
    if (type.kind === "signed-integer-64") {
      this.emitBoxSignedInteger64(instructions);
      return;
    }
    if (type.kind === "float-32") {
      this.emitBoxFloat32(instructions);
      return;
    }
    if (type.kind === "float-64") {
      this.emitBoxFloat64(instructions);
      return;
    }
    if (type.kind === "boolean") {
      this.emitEncodeBoolean(instructions);
      return;
    }
    instructions.emit(0x1a);
    const constructorIndex = this.#module.constructorNames.indexOf(
      UNIT_CONSTRUCTOR_NAME,
    );
    if (constructorIndex < 0) {
      throw new Error(
        `functional WASM host unit result omitted the $Unit constructor among ${this.#module.constructorCount} constructors`,
      );
    }
    const offset = this.#nullaryConstructorOffsets[constructorIndex];
    if (offset === undefined) {
      throw new Error(
        `functional WASM host unit result omitted its shared constructor slot for ${constructorIndex}`,
      );
    }
    instructions.i32Const(offset);
    instructions.i64Load(0);
  }

  emitEncodeInteger(instructions: WasmInstructions): void {
    instructions.emit(0xac);
    instructions.i64Const(3n);
    instructions.emit(0x86);
    instructions.i64Const(1n);
    instructions.emit(0x84);
  }

  emitEncodeBoolean(instructions: WasmInstructions): void {
    instructions.emit(0xad);
    instructions.i64Const(3n);
    instructions.emit(0x86);
    instructions.i64Const(2n);
    instructions.emit(0x84);
  }

  emitBoxSignedInteger64(instructions: WasmInstructions): void {
    const value = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(value);
    const pointer = this.allocateObject(
      instructions,
      NUMERIC_OBJECT_KIND,
      WasmValueAbi.numericKinds.signedInteger64,
      1,
    );
    instructions.localGet(pointer);
    instructions.localGet(value);
    instructions.i64Store(OBJECT_HEADER_BYTE_LENGTH);
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitBoxFloat32(instructions: WasmInstructions): void {
    const value = instructions.addLocal(WasmValueType.F32);
    instructions.localSet(value);
    const pointer = this.allocateObject(
      instructions,
      NUMERIC_OBJECT_KIND,
      WasmValueAbi.numericKinds.float32,
      1,
    );
    instructions.localGet(pointer);
    instructions.localGet(value);
    instructions.f32Store(OBJECT_HEADER_BYTE_LENGTH);
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitBoxF32x4(instructions: WasmInstructions, constructorName: string): void {
    const vector = instructions.addLocal(WasmValueType.V128);
    instructions.localSet(vector);
    const fields: ValueSource[] = [];
    for (let lane = 0; lane < 4; lane += 1) {
      this.emitExtractF32x4Lane(instructions, vector, lane);
      this.emitBoxFloat32(instructions);
      const field = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(field);
      fields.push({ kind: "i64-local", index: field });
    }
    this.emitConstructor(
      instructions,
      this.requiredConstructorIndex(constructorName),
      fields,
    );
  }

  emitBoxMask32x4(instructions: WasmInstructions, constructorName: string): void {
    const vector = instructions.addLocal(WasmValueType.V128);
    instructions.localSet(vector);
    const fields: ValueSource[] = [];
    for (let lane = 0; lane < 4; lane += 1) {
      instructions.localGet(vector);
      instructions.simd(WasmSimdOpcode.I32x4ExtractLane, lane);
      instructions.emit(0x45, 0x45);
      this.emitEncodeBoolean(instructions);
      const field = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(field);
      fields.push({ kind: "i64-local", index: field });
    }
    this.emitConstructor(
      instructions,
      this.requiredConstructorIndex(constructorName),
      fields,
    );
  }

  emitBoxFloat64(instructions: WasmInstructions): void {
    const value = instructions.addLocal(WasmValueType.F64);
    instructions.localSet(value);
    const pointer = this.allocateObject(
      instructions,
      NUMERIC_OBJECT_KIND,
      WasmValueAbi.numericKinds.float64,
      1,
    );
    instructions.localGet(pointer);
    instructions.localGet(value);
    instructions.f64Store(OBJECT_HEADER_BYTE_LENGTH);
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitUnboxSignedInteger64(instructions: WasmInstructions): void {
    instructions.emit(0xa7);
    instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH);
  }

  emitUnboxFloat32(instructions: WasmInstructions): void {
    instructions.emit(0xa7);
    instructions.f32Load(OBJECT_HEADER_BYTE_LENGTH);
  }

  emitUnboxF32x4(instructions: WasmInstructions): void {
    instructions.emit(0xa7);
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(pointer);
    for (let lane = 0; lane < 4; lane += 1) {
      instructions.localGet(pointer);
      instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH + lane * VALUE_BYTE_LENGTH);
      this.emitUnboxFloat32(instructions);
      if (lane === 0) instructions.simd(WasmSimdOpcode.F32x4Splat);
      else instructions.simd(WasmSimdOpcode.F32x4ReplaceLane, lane);
    }
  }

  emitUnboxMask32x4(instructions: WasmInstructions): void {
    instructions.emit(0xa7);
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(pointer);
    for (let lane = 0; lane < 4; lane += 1) {
      instructions.localGet(pointer);
      instructions.i64Load(OBJECT_HEADER_BYTE_LENGTH + lane * VALUE_BYTE_LENGTH);
      this.emitDecodeBoolean(instructions);
      instructions.i32Const(-1);
      instructions.emit(0x6c);
      if (lane === 0) instructions.simd(WasmSimdOpcode.I32x4Splat);
      else instructions.simd(WasmSimdOpcode.I32x4ReplaceLane, lane);
    }
  }

  requiredConstructorIndex(name: string): number {
    const constructor = this.#module.constructorNames.indexOf(name);
    if (constructor >= 0) return constructor;
    throw new Error(
      `functional SIMD module omitted constructor ${
        JSON.stringify(name)
      } among ${this.#module.constructorCount} constructors`,
    );
  }

  emitUnboxFloat64(instructions: WasmInstructions): void {
    instructions.emit(0xa7);
    instructions.f64Load(OBJECT_HEADER_BYTE_LENGTH);
  }

  emitLambdaSetCall(
    instructions: WasmInstructions,
    closure: number,
    argument: number,
    lambdaNodes: readonly number[],
  ): void {
    const [lambdaNode, ...remaining] = lambdaNodes;
    if (lambdaNode === undefined) {
      throw new Error(
        "functional WASM lambda-set call omitted every lambda node",
      );
    }
    if (remaining.length === 0) {
      this.emitDirectLambdaCall(instructions, closure, argument, lambdaNode);
      return;
    }

    instructions.localGet(closure);
    instructions.i32Load(4);
    instructions.i32Const(this.lambdaSlot(lambdaNode));
    instructions.emit(0x46, 0x04, WasmValueType.I64);
    this.emitDirectLambdaCall(instructions, closure, argument, lambdaNode);
    instructions.emit(0x05);
    this.emitLambdaSetCall(instructions, closure, argument, remaining);
    instructions.emit(0x0b);
  }

  emitDirectLambdaCall(
    instructions: WasmInstructions,
    closure: number,
    argument: number,
    lambdaNode: number,
  ): void {
    this.#specializedCallSiteCount += 1;
    instructions.localGet(closure);
    instructions.localGet(argument);
    instructions.call(
      this.indirectFunctionOffset() + this.lambdaSlot(lambdaNode),
    );
  }

  lambdaSlot(lambdaNode: number): number {
    const existing = this.#lambdaSlots[lambdaNode];
    if (existing !== undefined) return existing;
    const lambda = this.node(lambdaNode);
    if (lambda.tag !== CoreTag.Lambda) {
      throw new Error(
        `functional WASM lambda-set origin ${lambdaNode} has core tag ${lambda.tag}; expected a lambda`,
      );
    }

    const slot = this.reserveIndirectFunction();
    this.#lambdaSlots[lambdaNode] = slot;
    const recursiveOwner = this.#recursiveLambdaOwners.get(lambdaNode);
    const bodyInstructions = new WasmInstructions(2);
    const hasParameter = lambda.child1 !== 0;
    let bodyEnvironment: Environment;
    if (recursiveOwner === undefined) {
      bodyEnvironment = [
        ...(hasParameter ? [{ kind: "i64-local", index: 1 } as const] : []),
        ...this.lambdaCaptureEnvironment(
          lambda.child0,
          hasParameter ? 1 : 0,
          OBJECT_HEADER_BYTE_LENGTH,
        ),
      ];
    } else {
      const selfDepth = hasParameter ? 1 : 0;
      const capturesSelf = this.#captureAnalysis.freeLocalDepths(lambda.child0)
        .includes(selfDepth);
      const firstOuterCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
        (capturesSelf ? VALUE_BYTE_LENGTH : 0);
      bodyEnvironment = [
        ...(hasParameter ? [{ kind: "i64-local", index: 1 } as const] : []),
        capturesSelf ? { kind: "capture", byteOffset: OBJECT_HEADER_BYTE_LENGTH } : undefined,
        ...this.lambdaCaptureEnvironment(
          lambda.child0,
          selfDepth + 1,
          firstOuterCaptureByteOffset,
        ),
      ];
    }
    const tailLoop = this.#functionAnalysis.loop(lambdaNode);
    if (tailLoop === undefined) {
      this.compileExpression(bodyInstructions, lambda.child0, bodyEnvironment);
    } else {
      const worker = this.uncurriedWorker(tailLoop, undefined, "value");
      if (worker.hasEnvironmentParameter) {
        if (tailLoop.recursiveLocal) {
          const self = bodyEnvironment[tailLoop.parameterCount];
          if (self === undefined) {
            throw new Error(
              `functional WASM curried tail worker ${lambdaNode} omitted recursive depth ${tailLoop.parameterCount}`,
            );
          }
          this.emitBinding(bodyInstructions, self);
          bodyInstructions.emit(0xa7);
        } else {
          bodyInstructions.i32Const(0);
        }
      }
      const argumentLocals: number[] = [];
      for (
        let parameter = 0;
        parameter < tailLoop.parameterCount;
        parameter += 1
      ) {
        const source = bodyEnvironment[tailLoop.parameterCount - parameter - 1];
        const unboxed = this.isUnboxedNumericParameter(tailLoop, parameter);
        if (source === undefined) {
          if (unboxed) {
            throw new Error(
              `functional WASM curried tail worker ${lambdaNode} pruned strict numeric parameter ${parameter}`,
            );
          }
          bodyInstructions.i64Const(0n);
        } else {
          this.emitBinding(bodyInstructions, source);
        }
        if (unboxed && source !== undefined) {
          this.emitForceValue(bodyInstructions);
          this.emitDecodeInteger(bodyInstructions);
        }
        const argument = bodyInstructions.addLocal(
          unboxed ? WasmValueType.I32 : WasmValueType.I64,
        );
        bodyInstructions.localSet(argument);
        argumentLocals.push(argument);
      }
      for (const argument of argumentLocals) {
        bodyInstructions.localGet(argument);
      }
      bodyInstructions.call(
        this.indirectFunctionOffset() + worker.slot,
      );
    }
    this.#indirectFunctions[slot] = functionBody(
      2,
      bodyInstructions,
      recursiveOwner === undefined
        ? `lambda core node ${lambdaNode}`
        : `recursive lambda core node ${lambdaNode}`,
    );
    return slot;
  }

  compileTailLoop(
    instructions: WasmInstructions,
    bodyNode: number,
    environment: Environment,
    loop: FunctionShape,
    resultKind: "value" | "integer" = "value",
  ): void {
    const parameterLocals: (number | undefined)[] = [];
    const loopEnvironment = [...environment];
    for (let parameter = 0; parameter < loop.parameterCount; parameter += 1) {
      const depth = loop.parameterCount - parameter - 1;
      const source = environment[depth];
      if (source === undefined) {
        parameterLocals.push(undefined);
        continue;
      }
      const unboxed = this.isUnboxedNumericParameter(loop, parameter);
      if (unboxed && source.kind === "i32-integer") {
        loopEnvironment[depth] = source;
        parameterLocals.push(source.index);
        continue;
      }
      if (
        !unboxed &&
        (source.kind === "i64-local" || source.kind === "i64-value")
      ) {
        loopEnvironment[depth] = { kind: "i64-local", index: source.index };
        parameterLocals.push(source.index);
        continue;
      }
      this.emitBinding(instructions, source);
      if (unboxed) {
        this.emitForceValue(instructions);
        this.emitDecodeInteger(instructions);
      }
      const local = instructions.addLocal(
        unboxed ? WasmValueType.I32 : WasmValueType.I64,
      );
      instructions.localSet(local);
      loopEnvironment[depth] = unboxed
        ? { kind: "i32-integer", index: local }
        : { kind: "i64-local", index: local };
      parameterLocals.push(local);
    }

    instructions.emit(
      0x02,
      resultKind === "integer" ? WasmValueType.I32 : WasmValueType.I64,
      0x03,
      0x40,
    );
    this.compileTailPosition(
      instructions,
      bodyNode,
      loopEnvironment,
      loop,
      parameterLocals,
      0,
      0,
      1,
      resultKind,
    );
    instructions.emit(0x0b, 0x00, 0x0b);
  }

  compileTailPosition(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: Environment,
    loop: FunctionShape,
    parameterLocals: readonly (number | undefined)[],
    binderDepth: number,
    loopBranchDepth: number,
    resultBranchDepth: number,
    resultKind: "value" | "integer",
  ): void {
    const tailArguments = this.#functionAnalysis.tailArguments(
      nodeIndex,
      loop,
      binderDepth,
    );
    if (tailArguments !== undefined) {
      const targetLocals: number[] = [];
      for (const [parameter, argumentExpression] of tailArguments.entries()) {
        const target = parameterLocals[parameter];
        if (target === undefined) continue;
        const unboxed = this.isUnboxedNumericParameter(loop, parameter);
        if (unboxed) {
          this.compileIntegerExpression(
            instructions,
            argumentExpression.node,
            environment,
          );
        } else if (
          argumentExpression.evaluationMode ===
            EvaluationMode.StrictEager
        ) {
          this.compileExpression(
            instructions,
            argumentExpression.node,
            environment,
          );
        } else if (
          this.#module.entryEffects.size === 0 &&
          loop.strictParameters[parameter] === true &&
          this.#functionAnalysis.canEvaluateEagerly(argumentExpression.node)
        ) {
          this.compileExpression(
            instructions,
            argumentExpression.node,
            environment,
          );
        } else {
          this.compileLazyValue(
            instructions,
            argumentExpression.node,
            environment,
          );
        }
        targetLocals.push(target);
      }
      for (const target of targetLocals.reverse()) {
        instructions.localSet(target);
      }
      instructions.branch(loopBranchDepth);
      return;
    }

    const node = this.node(nodeIndex);
    if (node.tag === CoreTag.Apply) {
      const callee = this.node(node.child0);
      const binding = callee.tag === CoreTag.Local ? environment[callee.payload] : undefined;
      if (binding?.kind === "join-point") {
        // The argument is a nullary constructor and the parameter is dead, so the call is a jump.
        instructions.branch(resultBranchDepth - binding.resultBranchDepth);
        return;
      }
    }
    if (node.tag === CoreTag.If) {
      const selectedBranch = this.constantIfBranch(node, environment);
      if (selectedBranch !== undefined) {
        this.compileTailPosition(
          instructions,
          selectedBranch,
          environment,
          loop,
          parameterLocals,
          binderDepth,
          loopBranchDepth,
          resultBranchDepth,
          resultKind,
        );
        return;
      }
      this.compileBooleanExpression(instructions, node.child0, environment);
      instructions.emit(0x04, 0x40);
      this.compileTailPosition(
        instructions,
        node.child1,
        environment,
        loop,
        parameterLocals,
        binderDepth,
        loopBranchDepth + 1,
        resultBranchDepth + 1,
        resultKind,
      );
      instructions.emit(0x05);
      this.compileTailPosition(
        instructions,
        node.child2,
        environment,
        loop,
        parameterLocals,
        binderDepth,
        loopBranchDepth + 1,
        resultBranchDepth + 1,
        resultKind,
      );
      instructions.emit(0x0b);
      return;
    }
    if (node.tag === CoreTag.Let) {
      const joinLambda = this.#functionAnalysis.joinPointLambda(nodeIndex);
      if (joinLambda !== undefined) {
        // block $join (void) { <let body> } <join body>
        //
        // Every leaf of a tail position branches, so control reaches the join body only through a
        // `br` to the block's end. That makes the body shared rather than duplicated, and leaves it
        // in the enclosing function's tail position so its own self-calls stay branches.
        //
        // This has to run before `virtualLambda` below, which would otherwise win and inline the
        // body at each call site through `compileExpression` -- out of tail position, which is the
        // behaviour that lost tail recursion in the first place.
        instructions.emit(0x02, 0x40);
        this.compileTailPosition(
          instructions,
          node.child1,
          [{ kind: "join-point", resultBranchDepth: resultBranchDepth + 1 }, ...environment],
          loop,
          parameterLocals,
          binderDepth + 1,
          loopBranchDepth + 1,
          resultBranchDepth + 1,
          resultKind,
        );
        instructions.emit(0x0b);
        // `Let` is non-recursive, so the join binder is not in scope in its own value; the lambda
        // contributes only its dead parameter, which stays unbound.
        this.compileTailPosition(
          instructions,
          this.node(joinLambda).child0,
          [undefined, ...environment],
          loop,
          parameterLocals,
          binderDepth + 1,
          loopBranchDepth,
          resultBranchDepth,
          resultKind,
        );
        return;
      }
      const virtualValue = this.virtualLambda(node.child0, environment) ??
        (this.scalarSpecializationEnabled()
          ? this.virtualConstructor(node.child0, environment)
          : undefined);
      if (virtualValue !== undefined) {
        this.compileTailPosition(
          instructions,
          node.child1,
          [virtualValue, ...environment],
          loop,
          parameterLocals,
          binderDepth + 1,
          loopBranchDepth,
          resultBranchDepth,
          resultKind,
        );
        return;
      }
      const eager = node.evaluationMode === EvaluationMode.StrictEager ||
        this.expressionIsWhnf(node.child0) || this.immediatelyForcesLocal(node.child1, 0);
      const constantValue = !this.#instrumentedFuel && eager
        ? this.scalarConstantBinding(node.child0, environment)
        : undefined;
      if (constantValue !== undefined) {
        this.compileTailPosition(
          instructions,
          node.child1,
          [constantValue, ...environment],
          loop,
          parameterLocals,
          binderDepth + 1,
          loopBranchDepth,
          resultBranchDepth,
          resultKind,
        );
        return;
      }
      if (eager) this.compileExpression(instructions, node.child0, environment);
      else this.compileLazyValue(instructions, node.child0, environment);
      const value = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(value);
      this.compileTailPosition(
        instructions,
        node.child1,
        [{ kind: eager ? "i64-value" : "i64-local", index: value }, ...environment],
        loop,
        parameterLocals,
        binderDepth + 1,
        loopBranchDepth,
        resultBranchDepth,
        resultKind,
      );
      return;
    }
    if (node.tag === CoreTag.Case) {
      this.compileTailCase(
        instructions,
        node,
        nodeIndex,
        environment,
        loop,
        parameterLocals,
        binderDepth,
        loopBranchDepth,
        resultBranchDepth,
        resultKind,
      );
      return;
    }

    if (resultKind === "integer") {
      this.compileIntegerExpression(instructions, nodeIndex, environment);
    } else {
      this.compileExpression(instructions, nodeIndex, environment);
    }
    instructions.branch(resultBranchDepth);
  }

  compileTailCase(
    instructions: WasmInstructions,
    node: CoreNode,
    nodeIndex: number,
    environment: Environment,
    loop: FunctionShape,
    parameterLocals: readonly (number | undefined)[],
    binderDepth: number,
    loopBranchDepth: number,
    resultBranchDepth: number,
    resultKind: "value" | "integer",
  ): void {
    const virtualConstructor = this.scalarSpecializationEnabled()
      ? this.virtualConstructor(node.child0, environment)
      : undefined;
    if (virtualConstructor !== undefined) {
      this.compileKnownTailCaseArm(
        instructions,
        node,
        virtualConstructor,
        environment,
        nodeIndex,
        loop,
        parameterLocals,
        binderDepth,
        loopBranchDepth,
        resultBranchDepth,
        resultKind,
      );
      return;
    }
    this.compileExpression(instructions, node.child0, environment);
    instructions.emit(0xa7);
    const constructor = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(constructor);
    this.compileTailCaseAlternatives(
      instructions,
      node,
      constructor,
      environment,
      nodeIndex,
      loop,
      parameterLocals,
      binderDepth,
      loopBranchDepth,
      resultBranchDepth,
      resultKind,
    );
  }

  compileKnownTailCaseArm(
    instructions: WasmInstructions,
    node: CoreNode,
    constructor: VirtualConstructor,
    environment: Environment,
    caseNodeIndex: number,
    loop: FunctionShape,
    parameterLocals: readonly (number | undefined)[],
    binderDepth: number,
    loopBranchDepth: number,
    resultBranchDepth: number,
    resultKind: "value" | "integer",
  ): void {
    const arity = this.#module.constructorArities[constructor.constructorIndex];
    if (arity === undefined || constructor.arguments.length !== arity) {
      throw new Error(
        `functional WASM known constructor ${constructor.constructorIndex} at core node ${caseNodeIndex} has ${constructor.arguments.length} fields; expected ${
          String(arity)
        }`,
      );
    }
    const fields = constructor.arguments.map((argument) =>
      this.compileExpressionBinding(instructions, argument, constructor.environment)
    );
    for (const alternative of this.caseAlternatives(node, caseNodeIndex)) {
      if (alternative.constructor === constructor.constructorIndex) {
        if (alternative.binderCount !== arity) {
          throw new Error(
            `functional WASM case at core node ${caseNodeIndex} binds ${alternative.binderCount} fields for constructor ${constructor.constructorIndex}; expected ${arity}`,
          );
        }
        let armEnvironment = [...environment];
        for (let bindingIndex = 0; bindingIndex < arity; bindingIndex++) {
          armEnvironment = [fields[arity - bindingIndex - 1]!, ...armEnvironment];
        }
        this.compileTailPosition(
          instructions,
          alternative.body,
          armEnvironment,
          loop,
          parameterLocals,
          binderDepth + arity,
          loopBranchDepth,
          resultBranchDepth,
          resultKind,
        );
        return;
      }
    }
    throw new Error(
      `functional WASM case at core node ${caseNodeIndex} has no arm for known constructor ${constructor.constructorIndex}`,
    );
  }

  compileTailCaseAlternatives(
    instructions: WasmInstructions,
    node: CoreNode,
    constructor: number,
    environment: Environment,
    caseNodeIndex: number,
    loop: FunctionShape,
    parameterLocals: readonly (number | undefined)[],
    binderDepth: number,
    loopBranchDepth: number,
    resultBranchDepth: number,
    resultKind: "value" | "integer",
  ): void {
    let openArmCount = 0;
    for (const alternative of this.caseAlternatives(node, caseNodeIndex)) {
      const arity = this.#module.constructorArities[alternative.constructor];
      if (arity === undefined || alternative.binderCount !== arity) {
        throw new Error(
          `functional WASM case at core node ${caseNodeIndex} binds ${alternative.binderCount} fields for constructor ${alternative.constructor}; expected ${
            String(arity)
          }`,
        );
      }
      instructions.localGet(constructor);
      instructions.i32Load(4);
      instructions.i32Const(alternative.constructor);
      instructions.emit(0x46, 0x04, 0x40);
      let armEnvironment = [...environment];
      for (let bindingIndex = 0; bindingIndex < arity; bindingIndex++) {
        instructions.localGet(constructor);
        instructions.i64Load(
          OBJECT_HEADER_BYTE_LENGTH + (arity - bindingIndex - 1) * VALUE_BYTE_LENGTH,
        );
        const field = instructions.addLocal(WasmValueType.I64);
        instructions.localSet(field);
        armEnvironment = [{ kind: "i64-local", index: field }, ...armEnvironment];
      }
      this.compileTailPosition(
        instructions,
        alternative.body,
        armEnvironment,
        loop,
        parameterLocals,
        binderDepth + arity,
        loopBranchDepth + openArmCount + 1,
        resultBranchDepth + openArmCount + 1,
        resultKind,
      );
      instructions.emit(0x05);
      openArmCount++;
    }
    instructions.emit(0x00);
    for (let index = 0; index < openArmCount; index++) instructions.emit(0x0b);
  }

  lambdaCaptureEnvironment(
    bodyNode: number,
    binderDepth: number,
    firstCaptureByteOffset: number,
  ): Environment {
    const freeDepths = this.#captureAnalysis.freeLocalDepths(bodyNode).filter((
      depth,
    ) => depth >= binderDepth);
    const lastFreeDepth = freeDepths.at(-1);
    if (lastFreeDepth === undefined) return [];
    const environment: (ValueSource | undefined)[] = Array.from(
      { length: lastFreeDepth - binderDepth + 1 },
      () => undefined,
    );
    for (const [captureIndex, freeDepth] of freeDepths.entries()) {
      environment[freeDepth - binderDepth] = {
        kind: "capture",
        byteOffset: firstCaptureByteOffset + captureIndex * VALUE_BYTE_LENGTH,
      };
    }
    return environment;
  }

  reserveIndirectFunction(): number {
    const slot = this.#indirectFunctions.length;
    this.#indirectFunctions.push(undefined);
    return slot;
  }

  functionTypeIndex(
    parameters: readonly number[],
    results: readonly number[],
  ): number {
    const key = `${parameters.join(",")}->${results.join(",")}`;
    const existing = this.#additionalFunctionTypeIndices.get(key);
    if (existing !== undefined) return existing;
    const index = WASM_BASE_FUNCTION_TYPE_COUNT +
      this.#additionalFunctionTypes.length;
    this.#additionalFunctionTypes.push({
      parameters: [...parameters],
      results: [...results],
    });
    this.#additionalFunctionTypeIndices.set(key, index);
    return index;
  }

  allocateFunctionIndex(): number {
    this.#requestedAllocator = true;
    return this.#functionImports.length;
  }

  forceThunkFunctionIndex(): number {
    this.#requestedThunkForce = true;
    return this.#functionImports.length + 1;
  }

  indirectFunctionOffset(): number {
    return this.#functionImports.length + (this.#compactScalar ? 0 : 4);
  }

  node(index: number): CoreNode {
    const node = this.#nodes[index];
    if (node === undefined) {
      throw new Error(
        `functional WASM core node ${index} is outside ${this.#nodes.length} resolved nodes`,
      );
    }
    return node;
  }

  caseAlternatives(
    node: CoreNode,
    nodeIndex: number,
  ): readonly CompiledModule["caseAlternatives"][number][] {
    if (
      node.payload > this.#module.caseAlternatives.length ||
      node.child1 > this.#module.caseAlternatives.length - node.payload
    ) {
      throw new Error(
        `functional WASM case at core node ${nodeIndex} references alternatives ${node.payload}..${
          node.payload + node.child1
        } outside ${this.#module.caseAlternatives.length}`,
      );
    }
    return this.#module.caseAlternatives.slice(node.payload, node.payload + node.child1);
  }
}
