import {
  FUNCTIONAL_NO_INDEX,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalCoreTag,
  FunctionalEvaluationMode,
  FunctionalEvaluationProfile,
  FunctionalNumericConversion,
  type FunctionalType,
  FunctionalUnaryOperator,
} from "./abi.ts";
import type {
  FunctionalCoreNode,
  FunctionalWasmExport,
  GpuFunctionalModule,
} from "./compiler_module.ts";
import {
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_INIT_TYPE_NAME,
  type FunctionalHostFieldDeclaration,
  type FunctionalHostScalarType,
  type FunctionalHostType,
} from "./host_contract.ts";
import type {
  FunctionalWasmAsyncInit,
  FunctionalWasmBoundaryErrorDetails,
  FunctionalWasmHostValue,
  FunctionalWasmInit,
  FunctionalWasmInitBinding,
  FunctionalWasmRuntimeErrorDetails,
} from "./wasm_contract.ts";
import { locateFunctionalSpan } from "./diagnostics.ts";
import {
  encodeCompactScalarWasmModule,
  encodeWasmModule,
  type WasmFunctionBody,
  type WasmFunctionImport,
  type WasmFunctionType,
  WasmInstructions,
  WasmValueType,
} from "./wasm_binary.ts";
import { FunctionalWasmValueAbi } from "./wasm_abi.ts";
import {
  concreteFunctionalType,
  decodeFunctionalWasmValue,
  describeFunctionalType,
  encodeFunctionalWasmValue,
  type FunctionalWasmValue,
  FunctionalWasmValueError,
  releaseEncodedFunctionalWasmValue,
  requireFirstOrderFunctionalWasmType,
} from "./wasm_value_codec.ts";
import { FunctionalWasmCaptureAnalysis } from "./wasm_capture_analysis.ts";
import { FunctionalLambdaSetAnalysis } from "./wasm_lambda_sets.ts";
import {
  type FunctionalCallArgument,
  type FunctionalFunctionShape,
  type FunctionalNumericFold,
  FunctionalWasmFunctionAnalysis,
} from "./wasm_function_analysis.ts";

const HOST_IMPORT_MODULE_PREFIX = "functional_init:";
const CLOSURE_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.closure;
const CONSTRUCTOR_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.constructor;
const THUNK_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.thunk;
const NUMERIC_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.numeric;
const THUNK_UNEVALUATED = 0;
const THUNK_EVALUATING = 1;
const THUNK_EVALUATED = 2;
const WASM_FAULT_BLACKHOLE = 1;
const WASM_FAULT_DIVIDE_BY_ZERO = 2;
const WASM_FAULT_OUT_OF_MEMORY = 3;
const WASM_FAULT_OUT_OF_FUEL = 4;
const WASM_FAULT_INVALID_NUMERIC_CONVERSION = 5;
const OBJECT_HEADER_BYTE_LENGTH = FunctionalWasmValueAbi.objectHeaderByteLength;
const THUNK_HEADER_BYTE_LENGTH = 24;
const VALUE_BYTE_LENGTH = FunctionalWasmValueAbi.valueByteLength;
const BASE_WASM_FUNCTION_TYPE_COUNT = 5;
// Specialization is optional for correctness; this cap bounds generated code for recursive input.
const MAXIMUM_SPECIALIZED_INLINE_SITES = 512;
const MAXIMUM_RESOLVED_CORE_WASM_ARTIFACTS = 64;
const wasmBytesByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<Uint8Array<ArrayBuffer>>
>();
const executableWasmByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<WebAssembly.Module>
>();
const instrumentedWasmByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly executable: WebAssembly.Module }>
>();
const resolvedCoreFingerprintByModule = new WeakMap<GpuFunctionalModule, Promise<string>>();
const instrumentedWasmByResolvedCore = new Map<
  string,
  Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly executable: WebAssembly.Module }>
>();

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
  readonly environment: FunctionalEnvironment;
}

type FunctionalBinding = ValueSource | VirtualLambda;

// A missing source preserves de Bruijn depth for a binding that this closure does not capture.
type FunctionalEnvironment = readonly (FunctionalBinding | undefined)[];

interface HostField {
  readonly capability: string;
  readonly declaration: FunctionalHostFieldDeclaration;
  readonly importIndex: number;
  readonly closureSlot?: number;
}

interface FunctionalWasmEntry {
  readonly takesInit: boolean;
  readonly parameter?: FunctionalType;
  readonly result: FunctionalType;
}

interface ConstructorApplication {
  readonly constructorIndex: number;
  readonly arguments: readonly FunctionalCallArgument[];
}

interface UncurriedApplication {
  readonly baseNode: number;
  readonly arguments: readonly FunctionalCallArgument[];
  readonly functionShape: FunctionalFunctionShape;
}

export type { FunctionalWasmValue } from "./wasm_value_codec.ts";

export interface FunctionalWasmStats {
  readonly thunkEvaluations: number;
  readonly allocatedBytes: number;
  readonly specializedCallSites: number;
}

export interface FunctionalWasmExecution {
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly instance: WebAssembly.Instance;
  readonly value: FunctionalWasmValue;
  readonly stats: FunctionalWasmStats;
}

export interface FunctionalBoundedWasmExecution extends FunctionalWasmExecution {
  readonly semanticSteps: number;
}

export interface FunctionalWasmRunOptions {
  readonly init?: FunctionalWasmInit;
  readonly argument?: FunctionalWasmValue;
  readonly maximumResultNodes?: number;
  readonly argumentOwnership?: "bounded-borrow" | "ownership-transfer";
}

export interface FunctionalWasmAsyncRunOptions extends Omit<FunctionalWasmRunOptions, "init"> {
  readonly init: FunctionalWasmAsyncInit;
  readonly maximumSuspensions?: number;
}

export class FunctionalWasmBoundaryError extends TypeError {
  readonly code: FunctionalWasmBoundaryErrorDetails["code"];
  readonly kind: FunctionalWasmBoundaryErrorDetails["kind"];
  readonly path: string | undefined;

  constructor(details: FunctionalWasmBoundaryErrorDetails, cause?: unknown) {
    super(`${details.code}: ${details.message}`, { cause });
    this.name = "FunctionalWasmBoundaryError";
    this.code = details.code;
    this.kind = details.kind;
    this.path = details.path;
  }
}

export class FunctionalWasmRuntimeError extends Error {
  readonly code: FunctionalWasmRuntimeErrorDetails["code"];
  readonly kind: FunctionalWasmRuntimeErrorDetails["kind"];
  readonly entryDefinition: number;
  readonly entryName: string;
  readonly coreNode: number | undefined;
  readonly span: FunctionalWasmRuntimeErrorDetails["span"] | undefined;
  readonly location: FunctionalWasmRuntimeErrorDetails["location"] | undefined;
  readonly capability: string | undefined;
  readonly operation: string | undefined;

  constructor(entryDefinition: number, cause: unknown);
  constructor(details: FunctionalWasmRuntimeErrorDetails, cause?: unknown);
  constructor(
    detailsOrEntryDefinition: FunctionalWasmRuntimeErrorDetails | number,
    cause?: unknown,
  ) {
    const details: FunctionalWasmRuntimeErrorDetails = typeof detailsOrEntryDefinition === "number"
      ? {
        code: "F3005",
        kind: "blackhole",
        entryDefinition: detailsOrEntryDefinition,
        entryName: `d${detailsOrEntryDefinition}`,
        message:
          `functional WASM entry d${detailsOrEntryDefinition} recursively forced an evaluating thunk`,
      }
      : detailsOrEntryDefinition;
    super(`${details.code}: ${details.message}`, { cause });
    this.name = "FunctionalWasmRuntimeError";
    this.code = details.code;
    this.kind = details.kind;
    this.entryDefinition = details.entryDefinition;
    this.entryName = details.entryName;
    this.coreNode = details.coreNode;
    this.span = details.span;
    this.location = details.location;
    this.capability = details.capability;
    this.operation = details.operation;
  }
}

export async function compileFunctionalModuleToWasm(
  module: GpuFunctionalModule,
): Promise<Uint8Array<ArrayBuffer>> {
  return (await cachedFunctionalWasmBytes(module)).slice();
}

async function cachedFunctionalWasmBytes(
  module: GpuFunctionalModule,
): Promise<Uint8Array<ArrayBuffer>> {
  functionalWasmEntry(module);
  const cached = wasmBytesByModule.get(module);
  if (cached !== undefined) return await cached;
  const nodes = await module.readCoreNodes();
  const compilation = Promise.resolve().then(() => {
    const compactModule = new FunctionalWasmCompiler(module, nodes, true)
      .compileCompactScalar();
    return compactModule ??
      new FunctionalWasmCompiler(module, nodes, false).compile();
  });
  wasmBytesByModule.set(module, compilation);
  try {
    return await compilation;
  } catch (error) {
    if (wasmBytesByModule.get(module) === compilation) {
      wasmBytesByModule.delete(module);
    }
    throw error;
  }
}

async function cachedExecutableWasm(
  module: GpuFunctionalModule,
): Promise<WebAssembly.Module> {
  const cached = executableWasmByModule.get(module);
  if (cached !== undefined) return await cached;
  const compilation = cachedFunctionalWasmBytes(module).then((bytes) =>
    new WebAssembly.Module(bytes)
  );
  executableWasmByModule.set(module, compilation);
  try {
    return await compilation;
  } catch (error) {
    if (executableWasmByModule.get(module) === compilation) {
      executableWasmByModule.delete(module);
    }
    throw error;
  }
}

async function fuelInstrumentedWasm(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly executable: WebAssembly.Module }> {
  const cached = instrumentedWasmByModule.get(module);
  if (cached !== undefined) return await cached;
  const compilation = sharedFuelInstrumentedWasm(module, nodes);
  instrumentedWasmByModule.set(module, compilation);
  try {
    return await compilation;
  } catch (error) {
    if (instrumentedWasmByModule.get(module) === compilation) {
      instrumentedWasmByModule.delete(module);
    }
    throw error;
  }
}

async function sharedFuelInstrumentedWasm(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
): Promise<{ readonly bytes: Uint8Array<ArrayBuffer>; readonly executable: WebAssembly.Module }> {
  const fingerprint = await resolvedCoreFingerprint(module, nodes);
  const cached = instrumentedWasmByResolvedCore.get(fingerprint);
  if (cached !== undefined) {
    instrumentedWasmByResolvedCore.delete(fingerprint);
    instrumentedWasmByResolvedCore.set(fingerprint, cached);
    return await cached;
  }
  const compilation = Promise.resolve().then(() => {
    const compactModule = new FunctionalWasmCompiler(module, nodes, true, true)
      .compileCompactScalar();
    const bytes = compactModule ?? new FunctionalWasmCompiler(module, nodes, false, true).compile();
    return { bytes, executable: new WebAssembly.Module(bytes) };
  });
  instrumentedWasmByResolvedCore.set(fingerprint, compilation);
  evictOldestResolvedCoreArtifacts();
  try {
    return await compilation;
  } catch (error) {
    if (instrumentedWasmByResolvedCore.get(fingerprint) === compilation) {
      instrumentedWasmByResolvedCore.delete(fingerprint);
    }
    throw error;
  }
}

function evictOldestResolvedCoreArtifacts(): void {
  while (instrumentedWasmByResolvedCore.size > MAXIMUM_RESOLVED_CORE_WASM_ARTIFACTS) {
    const oldest = instrumentedWasmByResolvedCore.keys().next().value;
    if (oldest === undefined) return;
    instrumentedWasmByResolvedCore.delete(oldest);
  }
}

async function resolvedCoreFingerprint(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
): Promise<string> {
  const cached = resolvedCoreFingerprintByModule.get(module);
  if (cached !== undefined) return await cached;
  const fingerprint = sha256(JSON.stringify({
    format: 1,
    nodes,
    definitionNames: module.definitionNames,
    definitionRoots: module.definitionRoots,
    constructorNames: module.constructorNames,
    constructorArities: module.constructorArities,
    entryDefinition: module.entryDefinition,
    entryType: module.entryType,
    entryEffects: module.entryEffects,
    typeDeclarations: module.typeDeclarations,
    hostCapabilities: module.hostCapabilities,
    wasmExports: module.wasmExports,
    sources: module.sources,
    evaluationProfile: module.evaluationProfile,
  }));
  resolvedCoreFingerprintByModule.set(module, fingerprint);
  try {
    return await fingerprint;
  } catch (error) {
    if (resolvedCoreFingerprintByModule.get(module) === fingerprint) {
      resolvedCoreFingerprintByModule.delete(module);
    }
    throw error;
  }
}

export async function functionalResolvedCoreFingerprint(
  module: GpuFunctionalModule,
): Promise<string> {
  return await resolvedCoreFingerprint(module, await module.readCoreNodes());
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function runFunctionalWasmModule(
  module: GpuFunctionalModule,
  options: FunctionalWasmRunOptions = {},
): Promise<FunctionalWasmExecution> {
  return await runFunctionalWasmAttempt(module, options, false);
}

export async function runBoundedFunctionalWasmModule(
  module: GpuFunctionalModule,
  maximumSteps: number,
  options: FunctionalWasmRunOptions = {},
): Promise<FunctionalBoundedWasmExecution> {
  if (!Number.isSafeInteger(maximumSteps) || maximumSteps < 1 || maximumSteps > 1_000_000) {
    throw new RangeError(
      `bounded functional WASM maximumSteps must be within [1, 1000000]; received ${maximumSteps}`,
    );
  }
  const execution = await runFunctionalWasmAttempt(module, options, false, maximumSteps);
  if (execution.semanticSteps === undefined) {
    throw new Error("bounded functional WASM execution omitted its semantic step count");
  }
  return execution as FunctionalBoundedWasmExecution;
}

async function runFunctionalWasmAttempt(
  module: GpuFunctionalModule,
  options: FunctionalWasmRunOptions,
  allowSuspendingHostOperations: boolean,
  maximumSteps?: number,
): Promise<FunctionalWasmExecution & { readonly semanticSteps?: number }> {
  if (!allowSuspendingHostOperations) {
    for (const capability of module.hostCapabilities) {
      for (const declaration of capability.fields) {
        if (
          declaration.kind === "operation" &&
          declaration.execution === "suspending"
        ) {
          throw new TypeError(
            `functional WASM host operation ${
              JSON.stringify(`${capability.name}.${declaration.name}`)
            } is suspending; the direct WASM ABI is synchronous, so use runFunctionalWasmModuleAsync()`,
          );
        }
      }
    }
  }
  const nodes = await module.readCoreNodes();
  const entry = functionalWasmEntry(module);
  const instrumented = maximumSteps === undefined
    ? undefined
    : await fuelInstrumentedWasm(module, nodes);
  const [bytes, executable] = instrumented === undefined
    ? await Promise.all([cachedFunctionalWasmBytes(module), cachedExecutableWasm(module)])
    : [instrumented.bytes, instrumented.executable] as const;
  const host = functionalWasmImports(module, options.init);
  const instance = new WebAssembly.Instance(executable, host.imports);
  host.bindInstance(instance);
  const comptimeFuel = instance.exports.comptimeFuel;
  const comptimeSteps = instance.exports.comptimeSteps;
  if (maximumSteps !== undefined) {
    if (
      !(comptimeFuel instanceof WebAssembly.Global) ||
      !(comptimeSteps instanceof WebAssembly.Global)
    ) {
      throw new Error("fuel-instrumented functional WASM omitted its counter globals");
    }
    comptimeFuel.value = maximumSteps;
    comptimeSteps.value = 0;
  }
  const exportedMain = instance.exports.main;
  if (typeof exportedMain !== "function") {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} did not export a callable main function`,
    );
  }
  const heapTop = instance.exports.heapTop;
  if (!(heapTop instanceof WebAssembly.Global)) {
    throw new Error(
      `functional WASM entry d${module.entryDefinition} did not export its allocator heap top`,
    );
  }
  let argument: bigint | undefined;
  if (entry.parameter !== undefined) {
    const initialize = instance.exports.initialize;
    if (typeof initialize !== "function") {
      throw new Error(
        "functional WASM input module omitted its initialize export",
      );
    }
    initialize();
    if (options.argument === undefined) {
      throw new FunctionalWasmBoundaryError({
        code: "F4101",
        kind: "invalid-argument",
        path: "argument",
        message: `functional WASM entry requires ${
          describeFunctionalType(entry.parameter)
        } argument; received undefined`,
      });
    }
    try {
      argument = encodeFunctionalWasmValue(
        instance,
        module,
        entry.parameter,
        options.argument,
      );
    } catch (cause) {
      if (cause instanceof WebAssembly.RuntimeError) {
        throwFunctionalWasmTrap(module, nodes, instance, cause);
      }
      throw new FunctionalWasmBoundaryError({
        code: "F4101",
        kind: "invalid-argument",
        path: "argument",
        message: cause instanceof Error
          ? cause.message
          : `functional WASM argument encoding failed with ${String(cause)}`,
      }, cause);
    }
  } else if (options.argument !== undefined) {
    throw new FunctionalWasmBoundaryError({
      code: "F4101",
      kind: "invalid-argument",
      path: "argument",
      message: "functional WASM entry does not accept an argument",
    });
  }
  const argumentOwnership = options.argumentOwnership ?? "bounded-borrow";
  if (
    argumentOwnership !== "bounded-borrow" &&
    argumentOwnership !== "ownership-transfer"
  ) {
    throw new FunctionalWasmBoundaryError({
      code: "F4101",
      kind: "invalid-argument",
      path: "argumentOwnership",
      message:
        `functional WASM argumentOwnership must be bounded-borrow or ownership-transfer; received ${
          JSON.stringify(argumentOwnership)
        }`,
    });
  }
  try {
    const heapBase = Number(heapTop.value) >>> 0;
    let result: number | bigint;
    try {
      result = (argument === undefined ? exportedMain() : exportedMain(argument)) as
        | number
        | bigint;
    } catch (cause) {
      throwFunctionalWasmTrap(module, nodes, instance, cause);
    }
    let value: FunctionalWasmValue;
    try {
      value = decodeFunctionalWasmValue(
        instance,
        module,
        entry.result,
        result,
        options.maximumResultNodes ?? 2_047,
      );
    } catch (cause) {
      if (cause instanceof FunctionalWasmValueError) {
        throw new FunctionalWasmRuntimeError({
          code: cause.kind === "result-too-large" ? "F3010" : "F3011",
          kind: cause.kind,
          entryDefinition: module.entryDefinition,
          entryName: functionalEntryName(module),
          message: cause.message,
        }, cause);
      }
      throwFunctionalWasmTrap(module, nodes, instance, cause);
    }
    const thunkEvaluations = instance.exports.thunkEvaluations;
    if (!(thunkEvaluations instanceof WebAssembly.Global)) {
      throw new Error(
        `functional WASM entry d${module.entryDefinition} did not export thunk evaluation stats`,
      );
    }
    const specializedCallSites = instance.exports.specializedCallSites;
    if (!(specializedCallSites instanceof WebAssembly.Global)) {
      throw new Error(
        `functional WASM entry d${module.entryDefinition} did not export lambda-set specialization stats`,
      );
    }
    const finalHeapTop = Number(heapTop.value) >>> 0;
    if (finalHeapTop < heapBase) {
      throw new Error(
        `functional WASM entry d${module.entryDefinition} wrapped its allocator heap top from ${heapBase} to ${finalHeapTop}`,
      );
    }
    return {
      bytes: bytes.slice(),
      instance,
      value,
      stats: {
        thunkEvaluations: Number(thunkEvaluations.value),
        allocatedBytes: finalHeapTop - heapBase,
        specializedCallSites: Number(specializedCallSites.value),
      },
      ...(comptimeSteps instanceof WebAssembly.Global
        ? { semanticSteps: Number(comptimeSteps.value) }
        : {}),
    };
  } finally {
    if (argument !== undefined && argumentOwnership === "ownership-transfer") {
      releaseEncodedFunctionalWasmValue(instance, argument);
    }
  }
}

interface FunctionalWasmReplayRecord {
  readonly field: string;
  readonly argument: FunctionalWasmHostValue;
  readonly result: FunctionalWasmHostValue;
}

class FunctionalWasmSuspension extends Error {
  constructor(readonly pending: Promise<void>) {
    super("functional WASM host operation suspended");
  }
}

export async function runFunctionalWasmModuleAsync(
  module: GpuFunctionalModule,
  options: FunctionalWasmAsyncRunOptions,
): Promise<FunctionalWasmExecution> {
  const maximumSuspensions = options.maximumSuspensions ?? 1_024;
  if (!Number.isSafeInteger(maximumSuspensions) || maximumSuspensions < 1) {
    throw new RangeError(
      `functional WASM maximumSuspensions must be a positive safe integer; received ${maximumSuspensions}`,
    );
  }
  const records: FunctionalWasmReplayRecord[] = [];
  let cursor = 0;
  const init: Record<string, Record<string, FunctionalWasmInitBinding>> = {};
  for (const capability of module.hostCapabilities) {
    const suppliedCapability = options.init[capability.name];
    if (suppliedCapability === undefined) {
      throw invalidFunctionalWasmInit(
        capability.name,
        `functional WASM async init omitted capability ${JSON.stringify(capability.name)}`,
      );
    }
    const bindings: Record<string, FunctionalWasmInitBinding> = {};
    init[capability.name] = bindings;
    for (const declaration of capability.fields) {
      const supplied = suppliedCapability[declaration.name];
      const field = hostFieldKey(capability.name, declaration.name);
      if (declaration.kind === "value") {
        if (supplied === undefined || typeof supplied === "function") {
          throw invalidFunctionalWasmInit(
            field,
            `functional WASM async init omitted value ${JSON.stringify(field)}`,
          );
        }
        bindings[declaration.name] = supplied;
        continue;
      }
      if (typeof supplied !== "function") {
        throw invalidFunctionalWasmInit(
          field,
          `functional WASM async init omitted operation ${JSON.stringify(field)}`,
        );
      }
      bindings[declaration.name] = (argument) => {
        const recordIndex = cursor;
        cursor += 1;
        const recorded = records[recordIndex];
        if (recorded !== undefined) {
          if (
            recorded.field !== field ||
            !sameFunctionalWasmHostValue(recorded.argument, argument)
          ) {
            throw new FunctionalWasmRuntimeError({
              code: "F3102",
              kind: "async-replay-diverged",
              entryDefinition: module.entryDefinition,
              entryName: functionalEntryName(module),
              capability: capability.name,
              operation: declaration.name,
              message:
                `functional WASM suspension replay diverged at operation ${recordIndex}: expected ${
                  JSON.stringify(recorded.field)
                } with ${describeFunctionalWasmHostValue(recorded.argument)}, received ${
                  JSON.stringify(field)
                } with ${describeFunctionalWasmHostValue(argument)}`,
            });
          }
          return copyFunctionalWasmHostValue(recorded.result);
        }
        if (recordIndex !== records.length) {
          throw new FunctionalWasmRuntimeError({
            code: "F3102",
            kind: "async-replay-diverged",
            entryDefinition: module.entryDefinition,
            entryName: functionalEntryName(module),
            capability: capability.name,
            operation: declaration.name,
            message: `functional WASM suspension replay omitted operation ${recordIndex}`,
          });
        }
        const stableArgument = copyFunctionalWasmHostValue(argument);
        let returned:
          | FunctionalWasmHostValue
          | PromiseLike<FunctionalWasmHostValue>;
        try {
          returned = supplied(argument);
        } catch (cause) {
          throw functionalHostOperationError(
            module,
            capability.name,
            declaration.name,
            cause,
          );
        }
        if (
          returned !== null && typeof returned === "object" &&
          "then" in returned
        ) {
          const pending = Promise.resolve(returned).then(
            (result) => {
              records.push({
                field,
                argument: stableArgument,
                result: copyFunctionalWasmHostValue(result),
              });
            },
            (cause) => {
              throw functionalHostOperationError(
                module,
                capability.name,
                declaration.name,
                cause,
              );
            },
          );
          throw new FunctionalWasmSuspension(pending);
        }
        records.push({
          field,
          argument: stableArgument,
          result: copyFunctionalWasmHostValue(returned),
        });
        return returned;
      };
    }
  }
  for (
    let suspensionCount = 0;
    suspensionCount <= maximumSuspensions;
    suspensionCount++
  ) {
    cursor = 0;
    try {
      return await runFunctionalWasmAttempt(
        module,
        {
          ...options,
          init,
        },
        true,
      );
    } catch (error) {
      if (!(error instanceof FunctionalWasmSuspension)) throw error;
      if (suspensionCount === maximumSuspensions) {
        throw new FunctionalWasmRuntimeError({
          code: "F3104",
          kind: "suspension-limit",
          entryDefinition: module.entryDefinition,
          entryName: functionalEntryName(module),
          message: `functional WASM execution exceeded maximumSuspensions ${maximumSuspensions}`,
        });
      }
      await error.pending;
    }
  }
  throw new Error("functional WASM suspension loop exited without a result");
}

function sameFunctionalWasmHostValue(
  left: FunctionalWasmHostValue,
  right: FunctionalWasmHostValue,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "unit") return true;
  if (left.kind === "resource" && right.kind === "resource") {
    return left.id === right.id;
  }
  if (left.kind === "bytes" && right.kind === "bytes") {
    if (left.value.length !== right.value.length) return false;
    return left.value.every((value, index) => value === right.value[index]);
  }
  if (left.kind === "tuple" && right.kind === "tuple") {
    return sameFunctionalWasmHostValue(left.values[0], right.values[0]) &&
      sameFunctionalWasmHostValue(left.values[1], right.values[1]);
  }
  if (
    (left.kind === "array" && right.kind === "array") ||
    (left.kind === "slice" && right.kind === "slice")
  ) {
    return left.values.length === right.values.length &&
      left.values.every((value, index) => {
        const other = right.values[index];
        return other !== undefined && sameFunctionalWasmHostValue(value, other);
      });
  }
  if (left.kind === "constructor" && right.kind === "constructor") {
    return left.name === right.name &&
      left.fields.length === right.fields.length &&
      left.fields.every((value, index) => {
        const other = right.fields[index];
        return other !== undefined && sameFunctionalWasmHostValue(value, other);
      });
  }
  if ("value" in left && "value" in right) {
    return Object.is(left.value, right.value);
  }
  return false;
}

function copyFunctionalWasmHostValue(
  value: FunctionalWasmHostValue,
): FunctionalWasmHostValue {
  if (value.kind === "bytes") {
    return { kind: "bytes", value: value.value.slice() };
  }
  if (value.kind === "tuple") {
    return {
      kind: "tuple",
      values: [
        copyFunctionalWasmHostValue(value.values[0]),
        copyFunctionalWasmHostValue(value.values[1]),
      ],
    };
  }
  if (value.kind === "array" || value.kind === "slice") {
    return {
      kind: value.kind,
      values: value.values.map(copyFunctionalWasmHostValue),
    };
  }
  if (value.kind === "constructor") {
    return {
      kind: "constructor",
      name: value.name,
      fields: value.fields.map(copyFunctionalWasmHostValue),
    };
  }
  return { ...value };
}

function describeFunctionalWasmHostValue(
  value: FunctionalWasmHostValue,
): string {
  try {
    return JSON.stringify(value, (_key, member: unknown) => {
      if (typeof member === "bigint") return `${member}n`;
      if (member instanceof Uint8Array) return [...member];
      return member;
    });
  } catch {
    return `value with kind ${JSON.stringify(value.kind)}`;
  }
}

class FunctionalWasmCompiler {
  readonly #module: GpuFunctionalModule;
  readonly #nodes: readonly FunctionalCoreNode[];
  readonly #captureAnalysis: FunctionalWasmCaptureAnalysis;
  readonly #lambdaSetAnalysis: FunctionalLambdaSetAnalysis;
  readonly #functionAnalysis: FunctionalWasmFunctionAnalysis;
  readonly #indirectFunctions: (WasmFunctionBody | undefined)[] = [];
  readonly #lambdaSlots: (number | undefined)[];
  readonly #recursiveLambdaOwners = new Map<number, number>();
  readonly #uncurriedWorkerSlots = new Map<number, number>();
  readonly #additionalFunctionTypes: WasmFunctionType[] = [];
  readonly #additionalFunctionTypeIndices = new Map<string, number>();
  readonly #constructorClosureSlots: (number | undefined)[][];
  readonly #nullaryConstructorOffsets: readonly (number | undefined)[];
  readonly #globalThunkSlots: readonly (number | undefined)[];
  readonly #entry: FunctionalWasmEntry;
  readonly #hostFields: readonly HostField[];
  readonly #functionImports: readonly WasmFunctionImport[];
  readonly #activeSpecializedLambdas = new Set<number>();
  readonly #compactScalar: boolean;
  readonly #hasLazyEvaluationBoundary: boolean;
  readonly #instrumentedFuel: boolean;
  #remainingSpecializedInlineSites = MAXIMUM_SPECIALIZED_INLINE_SITES;
  #specializedCallSiteCount = 0;
  #requestedAllocator = false;
  #requestedThunkForce = false;

  constructor(
    module: GpuFunctionalModule,
    nodes: readonly FunctionalCoreNode[],
    compactScalar: boolean,
    instrumentedFuel = false,
  ) {
    this.#module = module;
    this.#nodes = nodes;
    this.#compactScalar = compactScalar;
    this.#instrumentedFuel = instrumentedFuel;
    this.#hasLazyEvaluationBoundary = nodes.some((node) =>
      (node.tag === FunctionalCoreTag.Apply ||
        node.tag === FunctionalCoreTag.Let) &&
      node.evaluationMode === FunctionalEvaluationMode.LazyCallByNeed
    );
    this.#captureAnalysis = new FunctionalWasmCaptureAnalysis(nodes);
    this.#lambdaSetAnalysis = new FunctionalLambdaSetAnalysis(module, nodes);
    this.#functionAnalysis = new FunctionalWasmFunctionAnalysis(
      nodes,
      module.definitionRoots,
    );
    this.#lambdaSlots = Array.from({ length: nodes.length }, () => undefined);
    for (const [nodeIndex, node] of nodes.entries()) {
      if (node.tag === FunctionalCoreTag.LetRec) {
        this.#recursiveLambdaOwners.set(node.child0, nodeIndex);
      }
    }
    this.#entry = functionalWasmEntry(module);
    const hostFields: HostField[] = [];
    const functionImports: WasmFunctionImport[] = [];
    for (const capability of module.hostCapabilities) {
      for (const declaration of capability.fields) {
        if (declaration.kind === "value") {
          requireFirstOrderFunctionalWasmType(
            module,
            concreteFunctionalType(declaration.type),
            `host value ${JSON.stringify(`${capability.name}.${declaration.name}`)}`,
          );
        } else {
          requireFirstOrderFunctionalWasmType(
            module,
            concreteFunctionalType(declaration.parameter),
            `host operation ${JSON.stringify(`${capability.name}.${declaration.name}`)} parameter`,
          );
          requireFirstOrderFunctionalWasmType(
            module,
            concreteFunctionalType(declaration.result),
            `host operation ${JSON.stringify(`${capability.name}.${declaration.name}`)} result`,
          );
        }
        const importIndex = functionImports.length;
        functionImports.push({
          module: hostImportModule(capability.name),
          name: declaration.name,
          typeIndex: declaration.kind === "value"
            ? this.functionTypeIndex([], [wasmValueType(declaration.type)])
            : this.functionTypeIndex(
              [wasmValueType(declaration.parameter)],
              [wasmValueType(declaration.result)],
            ),
        });
        hostFields.push({
          capability: capability.name,
          declaration,
          importIndex,
          ...(declaration.kind === "operation"
            ? { closureSlot: this.reserveIndirectFunction() }
            : {}),
        });
      }
    }
    this.#hostFields = Object.freeze(hostFields);
    this.#functionImports = Object.freeze(functionImports);
    this.#constructorClosureSlots = module.constructorArities.map((arity) =>
      Array.from({ length: arity }, () => undefined)
    );
    const referencedNullaryConstructors = new Set<number>();
    for (const node of nodes) {
      if (
        node.tag === FunctionalCoreTag.Constructor &&
        module.constructorArities[node.payload] === 0
      ) {
        referencedNullaryConstructors.add(node.payload);
      }
    }
    if (
      hostFields.some((field) =>
        field.declaration.kind === "value"
          ? field.declaration.type.kind === "unit"
          : field.declaration.result.kind === "unit"
      )
    ) {
      const unitConstructor = module.constructorNames.indexOf(
        FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
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
    this.#globalThunkSlots = compactScalar
      ? module.definitionRoots.map(() => undefined)
      : module.definitionRoots.map((rootNode) =>
        this.expressionIsWhnf(rootNode) ? undefined : this.reserveIndirectFunction()
      );
  }

  compileCompactScalar(): Uint8Array<ArrayBuffer> | undefined {
    const scalarResult = functionalHostScalarType(this.#entry.result);
    if (
      !this.#compactScalar ||
      this.#module.evaluationProfile !==
        FunctionalEvaluationProfile.StrictEager ||
      this.#module.entryEffects.length !== 0 ||
      this.#module.wasmExports.length !== 0 ||
      this.#hostFields.length !== 0 ||
      this.#entry.takesInit ||
      this.#entry.parameter !== undefined ||
      scalarResult === undefined || scalarResult.kind === "unit"
    ) return undefined;

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
    const emittedFunctions = [
      ...this.#indirectFunctions.map((body, slot) => {
        if (body === undefined) {
          throw new Error(
            `functional WASM compact function slot ${slot} was not emitted`,
          );
        }
        return body;
      }),
      entryBody,
    ];
    const requiresRuntime = this.#requestedAllocator ||
      this.#requestedThunkForce ||
      emittedFunctions.some((body) => body.usesMemory || body.usesIndirectCalls);
    if (requiresRuntime) return undefined;

    return encodeCompactScalarWasmModule(
      emittedFunctions,
      emittedFunctions.length - 1,
      this.#specializedCallSiteCount,
      this.#additionalFunctionTypes,
      this.#instrumentedFuel,
    );
  }

  compile(): Uint8Array<ArrayBuffer> {
    this.compileHostOperationClosures();
    this.compileGlobalThunks();
    const entryInstructions = new WasmInstructions(
      this.#entry.parameter === undefined ? 0 : 1,
    );
    this.emitGlobalInitialization(entryInstructions);
    this.emitEntryCall(entryInstructions);
    const scalarResult = functionalHostScalarType(this.#entry.result);
    this.emitPublicResult(entryInstructions, this.#entry.result);
    const indirectFunctions = this.#indirectFunctions.map((body, slot) => {
      if (body === undefined) {
        throw new Error(
          `functional WASM indirect function slot ${slot} was not emitted`,
        );
      }
      return body;
    });
    const forceValueInstructions = new WasmInstructions(1);
    forceValueInstructions.localGet(0);
    this.emitForceValue(forceValueInstructions);
    const forceValueType = this.functionTypeIndex([WasmValueType.I64], [
      WasmValueType.I64,
    ]);
    const entryResultType = scalarResult === undefined
      ? WasmValueType.I64
      : wasmValueType(scalarResult);
    const initializeInstructions = new WasmInstructions(0);
    this.emitGlobalInitialization(initializeInstructions);
    initializeInstructions.i32Const(0);
    const initializeType = this.functionTypeIndex([], [WasmValueType.I32]);
    const freeType = this.functionTypeIndex(
      [WasmValueType.I32, WasmValueType.I32],
      [],
    );
    const callableFunctions = this.#module.wasmExports.map((exported) =>
      this.compileWasmExport(exported)
    );
    const functions = [
      allocateFunction(),
      forceThunkFunction(),
      freeFunction(freeType),
      ...indirectFunctions,
      functionBody(
        forceValueType,
        forceValueInstructions,
        "public value force",
      ),
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
    ];
    const indirectFunctionIndices = indirectFunctions.map((_, slot) =>
      this.indirectFunctionOffset() + slot
    );
    const entryFunctionIndex = this.#functionImports.length + 5 +
      indirectFunctions.length;
    return encodeWasmModule(
      this.#functionImports,
      functions,
      indirectFunctionIndices,
      entryFunctionIndex,
      this.heapStart(),
      this.#specializedCallSiteCount,
      this.#additionalFunctionTypes,
      this.#functionImports.length + 3 + indirectFunctions.length,
      this.#functionImports.length + 4 + indirectFunctions.length,
      this.#functionImports.length,
      this.#functionImports.length + 2,
      this.#module.wasmExports.map((exported, index) => ({
        name: exported.name,
        functionIndex: entryFunctionIndex + 1 + index,
      })),
      this.#instrumentedFuel,
    );
  }

  compileWasmExport(exported: FunctionalWasmExport): WasmFunctionBody {
    const parameters: FunctionalType[] = [];
    let result = exported.type;
    while (result.kind === "function") {
      parameters.push(result.parameter);
      result = result.result;
    }
    for (const [index, parameter] of parameters.entries()) {
      requireFirstOrderFunctionalWasmType(
        this.#module,
        parameter,
        `export ${exported.name} input ${index}`,
      );
    }
    requireFirstOrderFunctionalWasmType(
      this.#module,
      result,
      `export ${exported.name} result`,
    );
    const instructions = new WasmInstructions(parameters.length);
    this.emitGlobalInitialization(instructions);
    this.emitGlobalReference(instructions, exported.definitionIndex);
    for (let index = 0; index < parameters.length; index += 1) {
      instructions.emit(0xa7);
      const closure = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(closure);
      instructions.localGet(closure);
      instructions.localGet(index);
      instructions.localGet(closure);
      instructions.i32Load(4);
      instructions.callIndirect(2);
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

  emitPublicResult(
    instructions: WasmInstructions,
    result: FunctionalType,
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
      this.emitHostArgument(instructions, field.declaration.parameter);
      instructions.call(field.importIndex);
      this.emitHostResult(instructions, field.declaration.result);
      this.#indirectFunctions[field.closureSlot] = functionBody(
        2,
        instructions,
        `host operation ${hostFieldKey(field.capability, field.declaration.name)}`,
      );
    }
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
      instructions.callIndirect(2);
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
    instructions.callIndirect(2);
  }

  emitHostInit(instructions: WasmInstructions): void {
    const constructorIndex = this.#module.constructorNames.indexOf(
      FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
    );
    if (constructorIndex < 0) {
      throw new Error(
        `functional WASM entry d${this.#module.entryDefinition} accepts ${FUNCTIONAL_INIT_TYPE_NAME} but the module omits constructor ${FUNCTIONAL_INIT_CONSTRUCTOR_NAME}`,
      );
    }
    const fields: ValueSource[] = [];
    for (const field of this.#hostFields) {
      if (field.declaration.kind === "value") {
        instructions.call(field.importIndex);
        this.emitHostResult(instructions, field.declaration.type);
      } else {
        if (field.closureSlot === undefined) {
          throw new Error(
            `functional WASM host operation ${
              hostFieldKey(field.capability, field.declaration.name)
            } omitted its closure slot`,
          );
        }
        this.emitClosure(instructions, field.closureSlot, []);
      }
      const value = instructions.addLocal(WasmValueType.I64);
      instructions.localSet(value);
      fields.push({ kind: "i64-local", index: value });
    }
    this.emitConstructor(instructions, constructorIndex, fields);
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
        4,
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
      instructions.i32Const(definitionIndex * VALUE_BYTE_LENGTH);
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
    instructions.i32Const(definitionIndex * VALUE_BYTE_LENGTH);
    instructions.i64Load(0);
    this.emitForceValue(instructions);
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

  emitFuelCharge(instructions: WasmInstructions, nodeIndex: number): void {
    if (!this.#instrumentedFuel) return;
    const fuelGlobal = this.#compactScalar ? 5 : 7;
    const stepsGlobal = fuelGlobal + 1;
    const runtimeFaultNodeGlobal = this.#compactScalar ? 4 : 6;
    instructions.globalGet(fuelGlobal);
    instructions.emit(0x45, 0x04, 0x40);
    instructions.i32Const(WASM_FAULT_OUT_OF_FUEL);
    instructions.globalSet(2);
    instructions.i32Const(nodeIndex);
    instructions.globalSet(runtimeFaultNodeGlobal);
    instructions.emit(0x00, 0x0b);
    instructions.globalGet(fuelGlobal);
    instructions.i32Const(1);
    instructions.emit(0x6b);
    instructions.globalSet(fuelGlobal);
    instructions.globalGet(stepsGlobal);
    instructions.i32Const(1);
    instructions.emit(0x6a);
    instructions.globalSet(stepsGlobal);
  }

  compileExpression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): void {
    this.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
        instructions.i64Const((BigInt(node.payload | 0) << 3n) | 1n);
        return;
      case FunctionalCoreTag.SignedInteger64:
        this.compileSignedInteger64Expression(
          instructions,
          nodeIndex,
          environment,
        );
        this.emitBoxSignedInteger64(instructions);
        return;
      case FunctionalCoreTag.Float32:
        this.compileFloat32Expression(instructions, nodeIndex, environment);
        this.emitBoxFloat32(instructions);
        return;
      case FunctionalCoreTag.Float64:
        this.compileFloat64Expression(instructions, nodeIndex, environment);
        this.emitBoxFloat64(instructions);
        return;
      case FunctionalCoreTag.Boolean:
        instructions.i64Const((BigInt(node.payload) << 3n) | 2n);
        return;
      case FunctionalCoreTag.Local:
        {
          const source = this.localSource(environment, node.payload, nodeIndex);
          this.emitBinding(instructions, source);
          if (source.kind === "i64-local" || source.kind === "capture") {
            this.emitForceValue(instructions);
          }
        }
        return;
      case FunctionalCoreTag.Global:
        if (node.payload >= this.#module.definitionCount) {
          throw new Error(
            `functional WASM global d${node.payload} at core node ${nodeIndex} exceeds ${this.#module.definitionCount} definitions`,
          );
        }
        this.emitGlobalReference(instructions, node.payload);
        return;
      case FunctionalCoreTag.Constructor:
        this.compileConstructorReference(instructions, node.payload, nodeIndex);
        return;
      case FunctionalCoreTag.Lambda:
        this.compileLambda(instructions, nodeIndex, environment);
        return;
      case FunctionalCoreTag.Apply:
        this.compileApply(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.Let:
        this.compileLet(instructions, node, environment);
        return;
      case FunctionalCoreTag.LetRec:
        this.compileLetRec(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.If:
        this.compileIf(instructions, node, environment);
        return;
      case FunctionalCoreTag.Unary:
        this.compileUnary(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.Binary:
        this.compileBinary(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.NumericConvert:
        this.compileNumericConversionExpression(
          instructions,
          node,
          nodeIndex,
          environment,
        );
        return;
      case FunctionalCoreTag.Case:
        this.compileCase(instructions, node, environment, nodeIndex);
        return;
      case FunctionalCoreTag.CaseArm:
      case FunctionalCoreTag.PatternBind:
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
      2,
      instructions,
      `constructor ${constructorIndex} stage ${stage}`,
    );
    return slot;
  }

  compileLambda(
    instructions: WasmInstructions,
    lambdaNode: number,
    environment: FunctionalEnvironment,
  ): void {
    const lambda = this.node(lambdaNode);
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WASM lambda compilation received core tag ${lambda.tag} at node ${lambdaNode}`,
      );
    }
    const slot = this.lambdaSlot(lambdaNode);
    const captured = this.prunedCaptures(
      lambda.child0,
      1,
      environment,
      OBJECT_HEADER_BYTE_LENGTH,
    );
    this.emitClosure(instructions, slot, captured.captureSources);
  }

  compileApply(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
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
    if (callee.tag === FunctionalCoreTag.Lambda) {
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

    const lambdaSet = this.#lambdaSetAnalysis.lambdaSet(node.child0);
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
    instructions.callIndirect(2);
  }

  uncurriedApplication(
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): UncurriedApplication | undefined {
    const reverseArguments: FunctionalCallArgument[] = [];
    let baseNode = nodeIndex;
    let node = this.node(baseNode);
    while (node.tag === FunctionalCoreTag.Apply) {
      reverseArguments.push({
        node: node.child1,
        evaluationMode: node.evaluationMode,
      });
      baseNode = node.child0;
      node = this.node(baseNode);
    }
    if (reverseArguments.length === 0) return undefined;
    if (
      reverseArguments.some((argument) => this.virtualLambda(argument.node, environment))
    ) {
      return undefined;
    }
    const virtualBase = this.virtualLambda(baseNode, environment);
    if (virtualBase !== undefined && node.tag !== FunctionalCoreTag.Global) {
      return undefined;
    }

    const lambdaSet = this.#lambdaSetAnalysis.lambdaSet(baseNode);
    if (!lambdaSet.complete || lambdaSet.lambdaNodes.length !== 1) {
      return undefined;
    }
    const outerLambdaNode = lambdaSet.lambdaNodes[0]!;
    const functionShape = this.#functionAnalysis.function(outerLambdaNode);
    if (
      functionShape === undefined ||
      functionShape.parameterCount !== reverseArguments.length
    ) {
      return undefined;
    }
    return {
      baseNode,
      arguments: Object.freeze(reverseArguments.reverse()),
      functionShape,
    };
  }

  compileUncurriedApplication(
    instructions: WasmInstructions,
    application: UncurriedApplication,
    environment: FunctionalEnvironment,
  ): void {
    const base = this.node(application.baseNode);
    const localBase = base.tag === FunctionalCoreTag.Local
      ? this.localSource(environment, base.payload, application.baseNode)
      : undefined;
    if (localBase?.kind === "i32-pointer") {
      instructions.localGet(localBase.index);
    } else if (
      this.#compactScalar &&
      base.tag === FunctionalCoreTag.Global &&
      this.#module.definitionRoots[base.payload] ===
        application.functionShape.outerLambdaNode
    ) {
      instructions.i32Const(0);
    } else {
      this.compileExpression(instructions, application.baseNode, environment);
      instructions.emit(0xa7);
    }
    const closure = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(closure);

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

    instructions.localGet(closure);
    for (const argument of argumentLocals) instructions.localGet(argument);
    this.#specializedCallSiteCount += 1;
    instructions.call(
      this.indirectFunctionOffset() +
        this.uncurriedWorkerSlot(application.functionShape),
    );
  }

  uncurriedWorkerSlot(functionShape: FunctionalFunctionShape): number {
    const existing = this.#uncurriedWorkerSlots.get(
      functionShape.outerLambdaNode,
    );
    if (existing !== undefined) return existing;

    const slot = this.reserveIndirectFunction();
    this.#uncurriedWorkerSlots.set(functionShape.outerLambdaNode, slot);
    const parameterTypes = [
      WasmValueType.I32,
      ...functionShape.strictParameters.map((_, parameter) =>
        this.isUnboxedNumericParameter(functionShape, parameter)
          ? WasmValueType.I32
          : WasmValueType.I64
      ),
    ];
    const instructions = new WasmInstructions(parameterTypes.length);
    const bodyEnvironment: (FunctionalBinding | undefined)[] = [];
    for (
      let parameter = 0;
      parameter < functionShape.parameterCount;
      parameter += 1
    ) {
      const depth = functionShape.parameterCount - parameter - 1;
      bodyEnvironment[depth] = this.isUnboxedNumericParameter(functionShape, parameter)
        ? { kind: "i32-integer", index: parameter + 1 }
        : { kind: "i64-local", index: parameter + 1 };
    }

    const outerLambda = this.node(functionShape.outerLambdaNode);
    if (outerLambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WASM uncurried worker origin ${functionShape.outerLambdaNode} has core tag ${outerLambda.tag}`,
      );
    }
    const recursive = this.#recursiveLambdaOwners.has(
      functionShape.outerLambdaNode,
    );
    const outerFreeDepths = this.#captureAnalysis.freeLocalDepths(
      outerLambda.child0,
    );
    const capturesSelf = recursive && outerFreeDepths.includes(1);
    const captureBinderDepth = recursive ? 2 : 1;
    const firstCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
      (capturesSelf ? VALUE_BYTE_LENGTH : 0);
    if (recursive) {
      bodyEnvironment[functionShape.parameterCount] = {
        kind: "i32-pointer",
        index: 0,
      };
    }
    const capturedDepths = outerFreeDepths.filter((depth) => depth >= captureBinderDepth);
    for (const [captureIndex, freeDepth] of capturedDepths.entries()) {
      const bodyDepth = freeDepth + functionShape.parameterCount - 1;
      bodyEnvironment[bodyDepth] = {
        kind: "capture",
        byteOffset: firstCaptureByteOffset + captureIndex * VALUE_BYTE_LENGTH,
      };
    }

    const tailLoop = this.#functionAnalysis.loop(functionShape.innerLambdaNode);
    if (tailLoop === undefined) {
      const numericFold = this.#compactScalar &&
          this.isUnboxedNumericParameter(functionShape, 0)
        ? this.#functionAnalysis.numericFold(functionShape.innerLambdaNode)
        : undefined;
      if (numericFold === undefined) {
        this.compileExpression(
          instructions,
          functionShape.bodyNode,
          bodyEnvironment,
        );
      } else {
        this.compileNumericFoldLoop(instructions, bodyEnvironment, numericFold);
      }
    } else {
      this.compileTailLoop(
        instructions,
        functionShape.bodyNode,
        bodyEnvironment,
        tailLoop,
      );
    }
    const resultTypes = [WasmValueType.I64];
    const functionTypeKey = `${parameterTypes.join(",")}->${resultTypes.join(",")}`;
    let functionTypeIndex = this.#additionalFunctionTypeIndices.get(
      functionTypeKey,
    );
    if (functionTypeIndex === undefined) {
      functionTypeIndex = BASE_WASM_FUNCTION_TYPE_COUNT +
        this.#additionalFunctionTypes.length;
      this.#additionalFunctionTypes.push({
        parameters: [...parameterTypes],
        results: resultTypes,
      });
      this.#additionalFunctionTypeIndices.set(
        functionTypeKey,
        functionTypeIndex,
      );
    }
    this.#indirectFunctions[slot] = functionBody(
      functionTypeIndex,
      instructions,
      `uncurried worker for lambda core node ${functionShape.outerLambdaNode}`,
    );
    return slot;
  }

  compileNumericFoldLoop(
    instructions: WasmInstructions,
    environment: FunctionalEnvironment,
    fold: FunctionalNumericFold,
  ): void {
    const parameterSource = environment[0];
    if (parameterSource?.kind !== "i32-integer") {
      throw new Error(
        `functional WASM numeric fold ${fold.functionShape.outerLambdaNode} omitted its unboxed parameter`,
      );
    }
    const accumulator = instructions.addLocal(WasmValueType.I32);
    instructions.i32Const(
      fold.operator === FunctionalBinaryOperator.Add ? 0 : 1,
    );
    instructions.localSet(accumulator);

    instructions.emit(0x02, WasmValueType.I64, 0x03, 0x40);
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
    );
    instructions.emit(0x05);
    this.compileNumericFoldBranch(
      instructions,
      environment,
      fold,
      parameterSource.index,
      accumulator,
      !fold.recurseWhenTrue,
    );
    instructions.emit(0x0b, 0x0b, 0x00, 0x0b);
  }

  compileNumericFoldBranch(
    instructions: WasmInstructions,
    environment: FunctionalEnvironment,
    fold: FunctionalNumericFold,
    parameter: number,
    accumulator: number,
    recursive: boolean,
  ): void {
    if (!recursive) {
      instructions.localGet(accumulator);
      this.compileIntegerExpression(instructions, fold.baseNode, environment);
      instructions.emit(
        fold.operator === FunctionalBinaryOperator.Add ? 0x6a : 0x6c,
      );
      this.emitEncodeInteger(instructions);
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
      fold.operator === FunctionalBinaryOperator.Add ? 0x6a : 0x6c,
    );
    instructions.localSet(accumulator);
    instructions.localGet(nextParameter);
    instructions.localSet(parameter);
    instructions.branch(1);
  }

  isUnboxedNumericParameter(
    functionShape: FunctionalFunctionShape,
    parameter: number,
  ): boolean {
    const profileMakesParameterStrict = this.#module.evaluationProfile ===
        FunctionalEvaluationProfile.StrictEager &&
      !this.#hasLazyEvaluationBoundary;
    return this.#module.entryEffects.length === 0 &&
      (profileMakesParameterStrict ||
        functionShape.strictParameters[parameter] === true) &&
      functionShape.numericParameters[parameter] === true;
  }

  compileVirtualLambdaApplication(
    instructions: WasmInstructions,
    callee: VirtualLambda,
    argumentNode: number,
    argumentEvaluation: FunctionalCoreNode["evaluationMode"],
    environment: FunctionalEnvironment,
  ): void {
    const lambda = this.node(callee.node);
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WASM virtual callee ${callee.node} has core tag ${lambda.tag}`,
      );
    }
    const virtualArgument = this.virtualLambda(argumentNode, environment);
    const hasCaptures = this.#captureAnalysis.freeLocalDepths(lambda.child0)
      .some((depth) => depth >= 1);
    const canInline = this.#remainingSpecializedInlineSites > 0 &&
      !this.#activeSpecializedLambdas.has(callee.node) &&
      (this.#compactScalar || virtualArgument !== undefined || hasCaptures);
    const functionShape = this.#functionAnalysis.function(callee.node);
    const unboxedNumericArgument = canInline &&
      functionShape?.parameterCount === 1 &&
      this.isUnboxedNumericParameter(functionShape, 0);

    let argument: FunctionalBinding;
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
      const argumentIsEager = argumentEvaluation === FunctionalEvaluationMode.StrictEager ||
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
    environment: FunctionalEnvironment,
  ): VirtualLambda | undefined {
    const node = this.node(nodeIndex);
    if (node.tag === FunctionalCoreTag.Lambda) {
      if (this.#recursiveLambdaOwners.has(nodeIndex)) return undefined;
      return { kind: "virtual-lambda", node: nodeIndex, environment };
    }
    if (node.tag === FunctionalCoreTag.Local) {
      const binding = environment[node.payload];
      return binding?.kind === "virtual-lambda" ? binding : undefined;
    }
    if (
      node.tag !== FunctionalCoreTag.Global ||
      node.payload >= this.#module.definitionCount
    ) {
      return undefined;
    }
    const root = this.#module.definitionRoots[node.payload];
    if (
      root === undefined || this.node(root).tag !== FunctionalCoreTag.Lambda
    ) return undefined;
    return { kind: "virtual-lambda", node: root, environment: [] };
  }

  compileLet(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
  ): void {
    const virtualValue = this.virtualLambda(node.child0, environment);
    if (virtualValue !== undefined) {
      this.compileExpression(instructions, node.child1, [
        virtualValue,
        ...environment,
      ]);
      return;
    }
    const eager = node.evaluationMode === FunctionalEvaluationMode.StrictEager ||
      this.expressionIsWhnf(node.child0) ||
      this.immediatelyForcesLocal(node.child1, 0);
    if (eager) {
      this.compileExpression(instructions, node.child0, environment);
    } else {
      this.compileLazyValue(instructions, node.child0, environment);
    }
    const value = instructions.addLocal(WasmValueType.I64);
    instructions.localSet(value);
    this.compileExpression(
      instructions,
      node.child1,
      [
        { kind: eager ? "i64-value" : "i64-local", index: value },
        ...environment,
      ],
    );
  }

  compileLetRec(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
    const lambda = this.node(node.child0);
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
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
    if (
      this.#compactScalar &&
      captured.captureSources.length === 0 &&
      functionShape !== undefined &&
      this.#functionAnalysis.hasOnlySaturatedSelfReferences(functionShape)
    ) {
      instructions.i32Const(0);
      const closure = instructions.addLocal(WasmValueType.I32);
      instructions.localSet(closure);
      this.compileExpression(
        instructions,
        node.child1,
        [{ kind: "i32-pointer", index: closure }, ...environment],
      );
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
    this.compileExpression(
      instructions,
      node.child1,
      [{ kind: "i32-pointer", index: pointer }, ...environment],
    );
  }

  compileIf(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
  ): void {
    this.compileBooleanExpression(instructions, node.child0, environment);
    instructions.emit(0x04, WasmValueType.I64);
    this.compileExpression(instructions, node.child1, environment);
    instructions.emit(0x05);
    this.compileExpression(instructions, node.child2, environment);
    instructions.emit(0x0b);
  }

  compileUnary(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
    if (node.payload === FunctionalUnaryOperator.Negate) {
      this.compileIntegerExpression(instructions, node.child0, environment);
      instructions.i32Const(-1);
      instructions.emit(0x6c);
      this.emitEncodeInteger(instructions);
      return;
    }
    if (node.payload === FunctionalUnaryOperator.NegateSignedInteger64) {
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
    if (node.payload === FunctionalUnaryOperator.NegateFloat32) {
      this.compileFloat32Expression(instructions, node.child0, environment);
      instructions.emit(0x8c);
      this.emitBoxFloat32(instructions);
      return;
    }
    if (node.payload === FunctionalUnaryOperator.NegateFloat64) {
      this.compileFloat64Expression(instructions, node.child0, environment);
      instructions.emit(0x9a);
      this.emitBoxFloat64(instructions);
      return;
    }
    if (node.payload === FunctionalUnaryOperator.SquareRootFloat32) {
      this.compileFloat32Expression(instructions, node.child0, environment);
      instructions.emit(0x91);
      this.emitBoxFloat32(instructions);
      return;
    }
    throw new Error(
      `functional WASM unary operator ${node.payload} at core node ${nodeIndex} is unsupported`,
    );
  }

  compileIntegerExpression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): void {
    this.emitFuelCharge(instructions, nodeIndex);
    const constant = this.constantIntegerExpression(nodeIndex, environment);
    if (constant !== undefined) {
      instructions.i32Const(constant);
      return;
    }
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
        instructions.i32Const(node.payload | 0);
        return;
      case FunctionalCoreTag.Local: {
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
      case FunctionalCoreTag.Unary:
        if (node.payload !== FunctionalUnaryOperator.Negate) {
          throw new Error(
            `functional WASM unary operator ${node.payload} at core node ${nodeIndex} is unsupported`,
          );
        }
        this.compileIntegerExpression(instructions, node.child0, environment);
        instructions.i32Const(-1);
        instructions.emit(0x6c);
        return;
      case FunctionalCoreTag.Binary: {
        if (
          node.payload !== FunctionalBinaryOperator.Add &&
          node.payload !== FunctionalBinaryOperator.Subtract &&
          node.payload !== FunctionalBinaryOperator.Multiply &&
          node.payload !== FunctionalBinaryOperator.Divide &&
          node.payload !== FunctionalBinaryOperator.Remainder &&
          node.payload !== FunctionalBinaryOperator.BitwiseAnd &&
          node.payload !== FunctionalBinaryOperator.BitwiseOr &&
          node.payload !== FunctionalBinaryOperator.BitwiseXor &&
          node.payload !== FunctionalBinaryOperator.ShiftLeft &&
          node.payload !== FunctionalBinaryOperator.ShiftRightUnsigned
        ) {
          this.compileExpression(instructions, nodeIndex, environment);
          this.emitDecodeInteger(instructions);
          return;
        }
        this.compileIntegerExpression(instructions, node.child0, environment);
        if (
          node.payload === FunctionalBinaryOperator.Divide ||
          node.payload === FunctionalBinaryOperator.Remainder
        ) {
          instructions.emit(0xac);
        }
        this.compileIntegerExpression(instructions, node.child1, environment);
        if (
          node.payload === FunctionalBinaryOperator.Divide ||
          node.payload === FunctionalBinaryOperator.Remainder
        ) {
          const divisor = instructions.addLocal(WasmValueType.I32);
          instructions.localSet(divisor);
          this.emitDivisionByZeroGuard(instructions, nodeIndex, divisor, "i32");
          instructions.localGet(divisor);
        }
        if (node.payload === FunctionalBinaryOperator.Add) {
          instructions.emit(0x6a);
        } else if (node.payload === FunctionalBinaryOperator.Subtract) {
          instructions.emit(0x6b);
        } else if (node.payload === FunctionalBinaryOperator.Multiply) {
          instructions.emit(0x6c);
        } else if (node.payload === FunctionalBinaryOperator.Remainder) {
          instructions.emit(0xac, 0x81, 0xa7);
        } else if (node.payload === FunctionalBinaryOperator.BitwiseAnd) {
          instructions.emit(0x71);
        } else if (node.payload === FunctionalBinaryOperator.BitwiseOr) {
          instructions.emit(0x72);
        } else if (node.payload === FunctionalBinaryOperator.BitwiseXor) {
          instructions.emit(0x73);
        } else if (node.payload === FunctionalBinaryOperator.ShiftLeft) {
          instructions.emit(0x74);
        } else if (
          node.payload === FunctionalBinaryOperator.ShiftRightUnsigned
        ) {
          instructions.emit(0x76);
        } else {
          instructions.emit(0xac, 0x7f, 0xa7);
        }
        return;
      }
      case FunctionalCoreTag.NumericConvert:
        this.compileNumericConversion(
          instructions,
          node,
          nodeIndex,
          environment,
          "integer",
        );
        return;
      case FunctionalCoreTag.If:
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.I32);
        this.compileIntegerExpression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileIntegerExpression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
      case FunctionalCoreTag.Let: {
        const virtualValue = this.virtualLambda(node.child0, environment);
        if (virtualValue !== undefined) {
          this.compileIntegerExpression(
            instructions,
            node.child1,
            [virtualValue, ...environment],
          );
          return;
        }
        const eager = node.evaluationMode === FunctionalEvaluationMode.StrictEager ||
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
        if (eager && this.canCompileIntegerExpression(node.child0)) {
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
      default:
        this.compileExpression(instructions, nodeIndex, environment);
        this.emitDecodeInteger(instructions);
    }
  }

  compileBooleanExpression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): void {
    this.emitFuelCharge(instructions, nodeIndex);
    const constant = this.constantBooleanExpression(nodeIndex, environment);
    if (constant !== undefined) {
      instructions.i32Const(constant ? 1 : 0);
      return;
    }
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Boolean:
        instructions.i32Const(node.payload === 0 ? 0 : 1);
        return;
      case FunctionalCoreTag.Local: {
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
      case FunctionalCoreTag.Binary:
        if (!isComparisonOperator(node.payload)) break;
        this.compileComparisonOperands(
          instructions,
          node,
          environment,
          nodeIndex,
        );
        return;
      case FunctionalCoreTag.If:
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.I32);
        this.compileBooleanExpression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileBooleanExpression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
      case FunctionalCoreTag.Let: {
        const eager = node.evaluationMode === FunctionalEvaluationMode.StrictEager ||
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
    environment: FunctionalEnvironment,
  ): void {
    this.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.SignedInteger64:
        instructions.i64Const(wideLiteralBits(node));
        return;
      case FunctionalCoreTag.Unary:
        if (node.payload !== FunctionalUnaryOperator.NegateSignedInteger64) {
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
      case FunctionalCoreTag.Binary:
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
      case FunctionalCoreTag.NumericConvert:
        this.compileNumericConversion(
          instructions,
          node,
          nodeIndex,
          environment,
          "signed-integer-64",
        );
        return;
      case FunctionalCoreTag.If:
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
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxSignedInteger64(instructions);
  }

  compileFloat32Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): void {
    this.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Float32:
        instructions.f32Const(float32FromBits(node.payload));
        return;
      case FunctionalCoreTag.Unary:
        if (
          node.payload !== FunctionalUnaryOperator.NegateFloat32 &&
          node.payload !== FunctionalUnaryOperator.SquareRootFloat32
        ) break;
        this.compileFloat32Expression(instructions, node.child0, environment);
        if (node.payload === FunctionalUnaryOperator.NegateFloat32) {
          instructions.emit(0x8c);
        } else {
          instructions.emit(0x91);
        }
        return;
      case FunctionalCoreTag.Binary:
        if (numericOperatorGroup(node.payload) !== "float-32") break;
        this.compileFloat32Expression(instructions, node.child0, environment);
        this.compileFloat32Expression(instructions, node.child1, environment);
        this.emitNumericBinary(instructions, node.payload, nodeIndex);
        return;
      case FunctionalCoreTag.NumericConvert:
        this.compileNumericConversion(
          instructions,
          node,
          nodeIndex,
          environment,
          "float-32",
        );
        return;
      case FunctionalCoreTag.If:
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.F32);
        this.compileFloat32Expression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileFloat32Expression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
    }
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxFloat32(instructions);
  }

  compileFloat64Expression(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): void {
    this.emitFuelCharge(instructions, nodeIndex);
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Float64:
        instructions.f64Const(float64FromBits(wideLiteralBits(node)));
        return;
      case FunctionalCoreTag.Unary:
        if (node.payload !== FunctionalUnaryOperator.NegateFloat64) break;
        this.compileFloat64Expression(instructions, node.child0, environment);
        instructions.emit(0x9a);
        return;
      case FunctionalCoreTag.Binary:
        if (numericOperatorGroup(node.payload) !== "float-64") break;
        this.compileFloat64Expression(instructions, node.child0, environment);
        this.compileFloat64Expression(instructions, node.child1, environment);
        this.emitNumericBinary(instructions, node.payload, nodeIndex);
        return;
      case FunctionalCoreTag.NumericConvert:
        this.compileNumericConversion(
          instructions,
          node,
          nodeIndex,
          environment,
          "float-64",
        );
        return;
      case FunctionalCoreTag.If:
        this.compileBooleanExpression(instructions, node.child0, environment);
        instructions.emit(0x04, WasmValueType.F64);
        this.compileFloat64Expression(instructions, node.child1, environment);
        instructions.emit(0x05);
        this.compileFloat64Expression(instructions, node.child2, environment);
        instructions.emit(0x0b);
        return;
    }
    this.compileExpression(instructions, nodeIndex, environment);
    this.emitUnboxFloat64(instructions);
  }

  compileComparisonOperands(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
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
    } else {
      this.compileFloat64Expression(instructions, node.child0, environment);
      this.compileFloat64Expression(instructions, node.child1, environment);
    }
    this.emitNumericBinary(instructions, node.payload, nodeIndex);
  }

  compileNumericConversion(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    nodeIndex: number,
    environment: FunctionalEnvironment,
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
    instructions.i32Const(WASM_FAULT_INVALID_NUMERIC_CONVERSION);
    instructions.globalSet(2);
    instructions.i32Const(nodeIndex);
    instructions.globalSet(this.#compactScalar ? 4 : 6);
    instructions.emit(0x00, 0x0b);
    instructions.localGet(value);
  }

  compileNumericConversionExpression(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    nodeIndex: number,
    environment: FunctionalEnvironment,
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
    const opcode = numericBinaryOpcode(operator);
    if (opcode === undefined) {
      throw new Error(
        `functional WASM numeric operator ${operator} at core node ${nodeIndex} is unsupported`,
      );
    }
    if (
      operator === FunctionalBinaryOperator.DivideSignedInteger64 ||
      operator === FunctionalBinaryOperator.RemainderSignedInteger64
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
        operator === FunctionalBinaryOperator.DivideSignedInteger64 ? -0x8000000000000000n : 0n,
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
    instructions.i32Const(WASM_FAULT_DIVIDE_BY_ZERO);
    instructions.globalSet(2);
    instructions.i32Const(nodeIndex);
    instructions.globalSet(this.#compactScalar ? 4 : 6);
    instructions.emit(0x00, 0x0b);
  }

  compileBinary(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
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
      else if (group === "float-64") this.emitBoxFloat64(instructions);
      else {throw new Error(
          `functional WASM operator ${node.payload} has invalid numeric group`,
        );}
      return;
    }
    if (isComparisonOperator(node.payload)) {
      switch (node.payload) {
        case FunctionalBinaryOperator.Equal:
        case FunctionalBinaryOperator.NotEqual:
        case FunctionalBinaryOperator.Less:
        case FunctionalBinaryOperator.LessEqual:
        case FunctionalBinaryOperator.Greater:
        case FunctionalBinaryOperator.GreaterEqual:
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

  compileCase(
    instructions: WasmInstructions,
    node: FunctionalCoreNode,
    environment: FunctionalEnvironment,
    nodeIndex: number,
  ): void {
    this.compileExpression(instructions, node.child0, environment);
    instructions.emit(0xa7);
    const constructor = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(constructor);
    this.compileCaseArm(
      instructions,
      node.child1,
      constructor,
      environment,
      nodeIndex,
    );
  }

  compileCaseArm(
    instructions: WasmInstructions,
    armIndex: number,
    constructor: number,
    environment: FunctionalEnvironment,
    caseNodeIndex: number,
  ): void {
    let currentArmIndex = armIndex;
    let openArmCount = 0;
    while (currentArmIndex !== FUNCTIONAL_NO_INDEX) {
      const arm = this.node(currentArmIndex);
      if (arm.tag !== FunctionalCoreTag.CaseArm) {
        throw new Error(
          `functional WASM case at core node ${caseNodeIndex} links tag ${arm.tag} at node ${currentArmIndex}; expected a case arm`,
        );
      }
      const arity = this.#module.constructorArities[arm.payload];
      if (arity === undefined) {
        throw new Error(
          `functional WASM case arm ${currentArmIndex} refers to missing constructor ${arm.payload}`,
        );
      }
      instructions.localGet(constructor);
      instructions.i32Load(4);
      instructions.i32Const(arm.payload);
      instructions.emit(0x46, 0x04, WasmValueType.I64);
      let bodyNode = arm.child0;
      let armEnvironment = [...environment];
      for (let bindingIndex = 0; bindingIndex < arity; bindingIndex++) {
        const binding = this.node(bodyNode);
        if (binding.tag !== FunctionalCoreTag.PatternBind) {
          throw new Error(
            `functional WASM case arm ${currentArmIndex} has ${bindingIndex} bindings before tag ${binding.tag}; expected ${arity}`,
          );
        }
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
        bodyNode = binding.child0;
      }
      this.compileExpression(instructions, bodyNode, armEnvironment);
      instructions.emit(0x05);
      openArmCount += 1;
      currentArmIndex = arm.child1;
    }
    instructions.emit(0x00);
    for (let index = 0; index < openArmCount; index++) instructions.emit(0x0b);
  }

  compileThunk(
    instructions: WasmInstructions,
    expressionNode: number,
    environment: FunctionalEnvironment,
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
    environment: FunctionalEnvironment,
  ): void {
    if (this.expressionIsWhnf(nodeIndex)) {
      this.compileExpression(instructions, nodeIndex, environment);
      return;
    }
    const node = this.node(nodeIndex);
    if (node.tag === FunctionalCoreTag.Local) {
      this.emitBinding(
        instructions,
        this.localSource(environment, node.payload, nodeIndex),
      );
      return;
    }
    if (node.tag === FunctionalCoreTag.Global) {
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
    argument: FunctionalCallArgument,
    environment: FunctionalEnvironment,
    demandedImmediately: boolean,
  ): void {
    if (
      argument.evaluationMode === FunctionalEvaluationMode.StrictEager ||
      demandedImmediately
    ) {
      this.compileExpression(instructions, argument.node, environment);
      return;
    }
    this.compileLazyValue(instructions, argument.node, environment);
  }

  localSource(
    environment: FunctionalEnvironment,
    depth: number,
    nodeIndex: number,
  ): FunctionalBinding {
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
    environment: FunctionalEnvironment,
    firstCaptureByteOffset: number,
  ): {
    readonly captureSources: readonly FunctionalBinding[];
    readonly bodyEnvironment: FunctionalEnvironment;
  } {
    const captureSources: FunctionalBinding[] = [];
    const bodyEnvironment: (FunctionalBinding | undefined)[] = Array.from(
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
    const reverseArguments: FunctionalCallArgument[] = [];
    let calleeIndex = nodeIndex;
    let callee = this.node(calleeIndex);
    while (callee.tag === FunctionalCoreTag.Apply) {
      reverseArguments.push({
        node: callee.child1,
        evaluationMode: callee.evaluationMode,
      });
      calleeIndex = callee.child0;
      callee = this.node(calleeIndex);
    }
    if (callee.tag !== FunctionalCoreTag.Constructor) return undefined;
    const arity = this.#module.constructorArities[callee.payload];
    if (
      arity === undefined || reverseArguments.length === 0 ||
      reverseArguments.length > arity
    ) {
      return undefined;
    }
    return {
      constructorIndex: callee.payload,
      arguments: Object.freeze(reverseArguments.reverse()),
    };
  }

  emitThunkObject(
    instructions: WasmInstructions,
    slot: number,
    captures: readonly FunctionalBinding[],
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
    instructions.localGet(pointer);
    instructions.i32Const(captures.length);
    instructions.i32Store(12);
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

  emitForceValue(instructions: WasmInstructions): void {
    const value = instructions.addLocal(WasmValueType.I64);
    const pointer = instructions.addLocal(WasmValueType.I32);
    instructions.localSet(value);
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
      case FunctionalCoreTag.Integer:
      case FunctionalCoreTag.SignedInteger64:
      case FunctionalCoreTag.Float32:
      case FunctionalCoreTag.Float64:
      case FunctionalCoreTag.Boolean:
      case FunctionalCoreTag.Lambda:
      case FunctionalCoreTag.Constructor:
        return true;
      default:
        return false;
    }
  }

  canCompileIntegerExpression(nodeIndex: number): boolean {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
        return true;
      case FunctionalCoreTag.Unary:
        return node.payload === FunctionalUnaryOperator.Negate &&
          this.canCompileIntegerExpression(node.child0);
      case FunctionalCoreTag.Binary:
        return !isComparisonOperator(node.payload) &&
          this.canCompileIntegerExpression(node.child0) &&
          this.canCompileIntegerExpression(node.child1);
      case FunctionalCoreTag.If:
        return this.canCompileIntegerExpression(node.child1) &&
          this.canCompileIntegerExpression(node.child2);
      case FunctionalCoreTag.Let:
      case FunctionalCoreTag.LetRec:
        return this.canCompileIntegerExpression(node.child1);
      default:
        return false;
    }
  }

  canCompileBooleanExpression(nodeIndex: number): boolean {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Boolean:
        return true;
      case FunctionalCoreTag.Binary:
        return isComparisonOperator(node.payload) &&
          this.canCompileIntegerExpression(node.child0) &&
          this.canCompileIntegerExpression(node.child1);
      case FunctionalCoreTag.If:
        return this.canCompileBooleanExpression(node.child1) &&
          this.canCompileBooleanExpression(node.child2);
      case FunctionalCoreTag.Let:
      case FunctionalCoreTag.LetRec:
        return this.canCompileBooleanExpression(node.child1);
      default:
        return false;
    }
  }

  constantIntegerExpression(
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): number | undefined {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Integer:
        return node.payload | 0;
      case FunctionalCoreTag.Local: {
        const source = environment[node.payload];
        return source?.kind === "i32-integer-constant" ? source.literal : undefined;
      }
      case FunctionalCoreTag.Unary: {
        if (node.payload !== FunctionalUnaryOperator.Negate) return undefined;
        const operand = this.constantIntegerExpression(
          node.child0,
          environment,
        );
        return operand === undefined ? undefined : Math.imul(operand, -1);
      }
      case FunctionalCoreTag.Binary: {
        if (isComparisonOperator(node.payload)) return undefined;
        const left = this.constantIntegerExpression(node.child0, environment);
        const right = this.constantIntegerExpression(node.child1, environment);
        if (left === undefined || right === undefined) return undefined;
        if (node.payload === FunctionalBinaryOperator.Add) {
          return (left + right) | 0;
        }
        if (node.payload === FunctionalBinaryOperator.Subtract) {
          return (left - right) | 0;
        }
        if (node.payload === FunctionalBinaryOperator.Multiply) {
          return Math.imul(left, right);
        }
        if (node.payload === FunctionalBinaryOperator.Divide && right !== 0) {
          return Math.trunc(left / right) | 0;
        }
        if (
          node.payload === FunctionalBinaryOperator.Remainder && right !== 0
        ) {
          return (left % right) | 0;
        }
        if (node.payload === FunctionalBinaryOperator.BitwiseAnd) {
          return left & right;
        }
        if (node.payload === FunctionalBinaryOperator.BitwiseOr) {
          return left | right;
        }
        if (node.payload === FunctionalBinaryOperator.BitwiseXor) {
          return left ^ right;
        }
        if (node.payload === FunctionalBinaryOperator.ShiftLeft) {
          return left << right;
        }
        if (node.payload === FunctionalBinaryOperator.ShiftRightUnsigned) {
          return left >>> right;
        }
        return undefined;
      }
      case FunctionalCoreTag.If: {
        const condition = this.constantBooleanExpression(
          node.child0,
          environment,
        );
        if (condition === undefined) return undefined;
        return this.constantIntegerExpression(
          condition ? node.child1 : node.child2,
          environment,
        );
      }
      default:
        return undefined;
    }
  }

  constantBooleanExpression(
    nodeIndex: number,
    environment: FunctionalEnvironment,
  ): boolean | undefined {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Boolean:
        return node.payload !== 0;
      case FunctionalCoreTag.Local: {
        const source = environment[node.payload];
        return source?.kind === "i32-boolean-constant" ? source.literal : undefined;
      }
      case FunctionalCoreTag.Binary: {
        if (!isComparisonOperator(node.payload)) return undefined;
        const left = this.constantIntegerExpression(node.child0, environment);
        const right = this.constantIntegerExpression(node.child1, environment);
        if (left === undefined || right === undefined) return undefined;
        if (node.payload === FunctionalBinaryOperator.Equal) {
          return left === right;
        }
        if (node.payload === FunctionalBinaryOperator.NotEqual) {
          return left !== right;
        }
        if (node.payload === FunctionalBinaryOperator.Less) return left < right;
        if (node.payload === FunctionalBinaryOperator.LessEqual) {
          return left <= right;
        }
        if (node.payload === FunctionalBinaryOperator.Greater) {
          return left > right;
        }
        return left >= right;
      }
      case FunctionalCoreTag.If: {
        const condition = this.constantBooleanExpression(
          node.child0,
          environment,
        );
        if (condition === undefined) return undefined;
        return this.constantBooleanExpression(
          condition ? node.child1 : node.child2,
          environment,
        );
      }
      default:
        return undefined;
    }
  }

  calleeImmediatelyForcesArgument(nodeIndex: number): boolean {
    const node = this.node(nodeIndex);
    return node.tag === FunctionalCoreTag.Lambda &&
      this.immediatelyForcesLocal(node.child0, 0);
  }

  lambdaSetImmediatelyForcesArgument(lambdaNodes: readonly number[]): boolean {
    return lambdaNodes.every((lambdaNode) => {
      const lambda = this.node(lambdaNode);
      return lambda.tag === FunctionalCoreTag.Lambda &&
        this.immediatelyForcesLocal(lambda.child0, 0);
    });
  }

  immediatelyForcesLocal(nodeIndex: number, localDepth: number): boolean {
    const node = this.node(nodeIndex);
    switch (node.tag) {
      case FunctionalCoreTag.Local:
        return node.payload === localDepth;
      case FunctionalCoreTag.Unary:
      case FunctionalCoreTag.NumericConvert:
      case FunctionalCoreTag.Case:
      case FunctionalCoreTag.If:
        return this.immediatelyForcesLocal(node.child0, localDepth);
      case FunctionalCoreTag.Binary:
      case FunctionalCoreTag.Apply:
        return this.immediatelyForcesLocal(node.child0, localDepth);
      case FunctionalCoreTag.Let:
      case FunctionalCoreTag.LetRec:
        return this.immediatelyForcesLocal(node.child1, localDepth + 1);
      default:
        return false;
    }
  }

  emitClosure(
    instructions: WasmInstructions,
    slot: number,
    captures: readonly FunctionalBinding[],
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
    fields: readonly FunctionalBinding[],
  ): void {
    const pointer = this.allocateObject(
      instructions,
      CONSTRUCTOR_OBJECT_KIND,
      constructorIndex,
      fields.length,
    );
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
    instructions.localGet(pointer);
    instructions.i32Const(valueCount);
    instructions.i32Store(8);
    return pointer;
  }

  emitBinding(instructions: WasmInstructions, source: FunctionalBinding): void {
    switch (source.kind) {
      case "i64-local":
      case "i64-value":
        instructions.localGet(source.index);
        return;
      case "i32-integer":
        instructions.localGet(source.index);
        this.emitEncodeInteger(instructions);
        return;
      case "i32-integer-constant":
        instructions.i32Const(source.literal);
        this.emitEncodeInteger(instructions);
        return;
      case "i32-boolean":
        instructions.localGet(source.index);
        this.emitEncodeBoolean(instructions);
        return;
      case "i32-boolean-constant":
        instructions.i32Const(source.literal ? 1 : 0);
        this.emitEncodeBoolean(instructions);
        return;
      case "i32-pointer":
        instructions.localGet(source.index);
        instructions.emit(0xad);
        return;
      case "capture":
        instructions.localGet(0);
        instructions.i64Load(source.byteOffset);
        return;
      case "virtual-lambda": {
        const lambda = this.node(source.node);
        if (lambda.tag !== FunctionalCoreTag.Lambda) {
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
      case FunctionalBinaryOperator.Equal:
        instructions.emit(0x46);
        return;
      case FunctionalBinaryOperator.NotEqual:
        instructions.emit(0x47);
        return;
      case FunctionalBinaryOperator.Less:
        instructions.emit(0x48);
        return;
      case FunctionalBinaryOperator.LessEqual:
        instructions.emit(0x4c);
        return;
      case FunctionalBinaryOperator.Greater:
        instructions.emit(0x4a);
        return;
      case FunctionalBinaryOperator.GreaterEqual:
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
    type: FunctionalHostType,
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
    type: FunctionalHostType,
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
      FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
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
      FunctionalWasmValueAbi.numericKinds.signedInteger64,
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
      FunctionalWasmValueAbi.numericKinds.float32,
      1,
    );
    instructions.localGet(pointer);
    instructions.localGet(value);
    instructions.f32Store(OBJECT_HEADER_BYTE_LENGTH);
    instructions.localGet(pointer);
    instructions.emit(0xad);
  }

  emitBoxFloat64(instructions: WasmInstructions): void {
    const value = instructions.addLocal(WasmValueType.F64);
    instructions.localSet(value);
    const pointer = this.allocateObject(
      instructions,
      NUMERIC_OBJECT_KIND,
      FunctionalWasmValueAbi.numericKinds.float64,
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
    if (lambda.tag !== FunctionalCoreTag.Lambda) {
      throw new Error(
        `functional WASM lambda-set origin ${lambdaNode} has core tag ${lambda.tag}; expected a lambda`,
      );
    }

    const slot = this.reserveIndirectFunction();
    this.#lambdaSlots[lambdaNode] = slot;
    const recursiveOwner = this.#recursiveLambdaOwners.get(lambdaNode);
    const bodyInstructions = new WasmInstructions(2);
    let bodyEnvironment: FunctionalEnvironment;
    if (recursiveOwner === undefined) {
      bodyEnvironment = [
        { kind: "i64-local", index: 1 },
        ...this.lambdaCaptureEnvironment(
          lambda.child0,
          1,
          OBJECT_HEADER_BYTE_LENGTH,
        ),
      ];
    } else {
      const capturesSelf = this.#captureAnalysis.freeLocalDepths(lambda.child0)
        .includes(1);
      const firstOuterCaptureByteOffset = OBJECT_HEADER_BYTE_LENGTH +
        (capturesSelf ? VALUE_BYTE_LENGTH : 0);
      bodyEnvironment = [
        { kind: "i64-local", index: 1 },
        capturesSelf ? { kind: "capture", byteOffset: OBJECT_HEADER_BYTE_LENGTH } : undefined,
        ...this.lambdaCaptureEnvironment(
          lambda.child0,
          2,
          firstOuterCaptureByteOffset,
        ),
      ];
    }
    const tailLoop = this.#functionAnalysis.loop(lambdaNode);
    if (tailLoop === undefined) {
      this.compileExpression(bodyInstructions, lambda.child0, bodyEnvironment);
    } else {
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
      const closure = bodyInstructions.addLocal(WasmValueType.I32);
      bodyInstructions.localSet(closure);
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
      bodyInstructions.localGet(closure);
      for (const argument of argumentLocals) {
        bodyInstructions.localGet(argument);
      }
      bodyInstructions.call(
        this.indirectFunctionOffset() + this.uncurriedWorkerSlot(tailLoop),
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
    environment: FunctionalEnvironment,
    loop: FunctionalFunctionShape,
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
        instructions.localGet(source.index);
      } else {
        this.emitBinding(instructions, source);
        if (unboxed) {
          this.emitForceValue(instructions);
          this.emitDecodeInteger(instructions);
        }
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

    instructions.emit(0x02, WasmValueType.I64, 0x03, 0x40);
    this.compileTailPosition(
      instructions,
      bodyNode,
      loopEnvironment,
      loop,
      parameterLocals,
      0,
      0,
      1,
    );
    instructions.emit(0x0b, 0x00, 0x0b);
  }

  compileTailPosition(
    instructions: WasmInstructions,
    nodeIndex: number,
    environment: FunctionalEnvironment,
    loop: FunctionalFunctionShape,
    parameterLocals: readonly (number | undefined)[],
    binderDepth: number,
    loopBranchDepth: number,
    resultBranchDepth: number,
  ): void {
    const tailArguments = this.#functionAnalysis.tailArguments(
      nodeIndex,
      loop,
      binderDepth,
    );
    if (tailArguments !== undefined) {
      const argumentLocals: (number | undefined)[] = [];
      for (const [parameter, argumentExpression] of tailArguments.entries()) {
        if (parameterLocals[parameter] === undefined) {
          argumentLocals.push(undefined);
          continue;
        }
        const unboxed = this.isUnboxedNumericParameter(loop, parameter);
        if (unboxed) {
          this.compileIntegerExpression(
            instructions,
            argumentExpression.node,
            environment,
          );
        } else if (
          argumentExpression.evaluationMode ===
            FunctionalEvaluationMode.StrictEager
        ) {
          this.compileExpression(
            instructions,
            argumentExpression.node,
            environment,
          );
        } else if (
          this.#module.entryEffects.length === 0 &&
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
        const argument = instructions.addLocal(
          unboxed ? WasmValueType.I32 : WasmValueType.I64,
        );
        instructions.localSet(argument);
        argumentLocals.push(argument);
      }
      for (const [parameter, argument] of argumentLocals.entries()) {
        const target = parameterLocals[parameter];
        if (argument === undefined || target === undefined) continue;
        instructions.localGet(argument);
        instructions.localSet(target);
      }
      instructions.branch(loopBranchDepth);
      return;
    }

    const node = this.node(nodeIndex);
    if (node.tag === FunctionalCoreTag.If) {
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
      );
      instructions.emit(0x0b);
      return;
    }

    this.compileExpression(instructions, nodeIndex, environment);
    instructions.branch(resultBranchDepth);
  }

  lambdaCaptureEnvironment(
    bodyNode: number,
    binderDepth: number,
    firstCaptureByteOffset: number,
  ): FunctionalEnvironment {
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
    const index = BASE_WASM_FUNCTION_TYPE_COUNT +
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
    return this.#functionImports.length + (this.#compactScalar ? 0 : 3);
  }

  node(index: number): FunctionalCoreNode {
    const node = this.#nodes[index];
    if (node === undefined) {
      throw new Error(
        `functional WASM core node ${index} is outside ${this.#nodes.length} resolved nodes`,
      );
    }
    return node;
  }
}

function isComparisonOperator(operator: number): boolean {
  return operator >= 1 && operator <= 40 && (operator - 1) % 10 < 6;
}

type NumericPrimitiveKind =
  | "integer"
  | "signed-integer-64"
  | "float-32"
  | "float-64";

function numericOperatorGroup(operator: number): NumericPrimitiveKind {
  if (operator >= 1 && operator <= 10) return "integer";
  if (operator <= 20) return "signed-integer-64";
  if (operator <= 30) return "float-32";
  if (operator <= 40) return "float-64";
  if (operator <= 46) return "integer";
  if (operator <= 52) return "signed-integer-64";
  throw new RangeError(
    `functional numeric operator must be within [1, 52]; received ${operator}`,
  );
}

function numericBinaryOpcode(operator: number): number | undefined {
  switch (operator) {
    case FunctionalBinaryOperator.Remainder:
      return undefined;
    case FunctionalBinaryOperator.BitwiseAnd:
      return 0x71;
    case FunctionalBinaryOperator.BitwiseOr:
      return 0x72;
    case FunctionalBinaryOperator.BitwiseXor:
      return 0x73;
    case FunctionalBinaryOperator.ShiftLeft:
      return 0x74;
    case FunctionalBinaryOperator.ShiftRightUnsigned:
      return 0x76;
    case FunctionalBinaryOperator.RemainderSignedInteger64:
      return 0x81;
    case FunctionalBinaryOperator.BitwiseAndSignedInteger64:
      return 0x83;
    case FunctionalBinaryOperator.BitwiseOrSignedInteger64:
      return 0x84;
    case FunctionalBinaryOperator.BitwiseXorSignedInteger64:
      return 0x85;
    case FunctionalBinaryOperator.ShiftLeftSignedInteger64:
      return 0x86;
    case FunctionalBinaryOperator.ShiftRightUnsignedSignedInteger64:
      return 0x88;
  }
  const position = (operator - 1) % 10;
  const group = numericOperatorGroup(operator);
  const opcodes = group === "integer"
    ? [0x46, 0x47, 0x48, 0x4c, 0x4a, 0x4e, 0x6a, 0x6b, 0x6c, undefined]
    : group === "signed-integer-64"
    ? [0x51, 0x52, 0x53, 0x57, 0x55, 0x59, 0x7c, 0x7d, 0x7e, 0x7f]
    : group === "float-32"
    ? [0x5b, 0x5c, 0x5d, 0x5f, 0x5e, 0x60, 0x92, 0x93, 0x94, 0x95]
    : [0x61, 0x62, 0x63, 0x65, 0x64, 0x66, 0xa0, 0xa1, 0xa2, 0xa3];
  return opcodes[position];
}

function numericConversion(
  conversion: number,
): {
  readonly source: NumericPrimitiveKind;
  readonly result: NumericPrimitiveKind;
  readonly opcode: number;
} {
  switch (conversion) {
    case FunctionalNumericConversion.SignedInteger32ToSignedInteger64:
      return { source: "integer", result: "signed-integer-64", opcode: 0xac };
    case FunctionalNumericConversion.SignedInteger64ToSignedInteger32:
      return { source: "signed-integer-64", result: "integer", opcode: 0xa7 };
    case FunctionalNumericConversion.SignedInteger32ToFloat32:
      return { source: "integer", result: "float-32", opcode: 0xb2 };
    case FunctionalNumericConversion.SignedInteger32ToFloat64:
      return { source: "integer", result: "float-64", opcode: 0xb7 };
    case FunctionalNumericConversion.SignedInteger64ToFloat32:
      return { source: "signed-integer-64", result: "float-32", opcode: 0xb4 };
    case FunctionalNumericConversion.SignedInteger64ToFloat64:
      return { source: "signed-integer-64", result: "float-64", opcode: 0xb9 };
    case FunctionalNumericConversion.Float32ToSignedInteger32:
      return { source: "float-32", result: "integer", opcode: 0xa8 };
    case FunctionalNumericConversion.Float32ToSignedInteger64:
      return { source: "float-32", result: "signed-integer-64", opcode: 0xae };
    case FunctionalNumericConversion.Float32ToFloat64:
      return { source: "float-32", result: "float-64", opcode: 0xbb };
    case FunctionalNumericConversion.Float64ToSignedInteger32:
      return { source: "float-64", result: "integer", opcode: 0xaa };
    case FunctionalNumericConversion.Float64ToSignedInteger64:
      return { source: "float-64", result: "signed-integer-64", opcode: 0xb0 };
    case FunctionalNumericConversion.Float64ToFloat32:
      return { source: "float-64", result: "float-32", opcode: 0xb6 };
    case FunctionalNumericConversion.ReinterpretFloat32AsSignedInteger32:
      return { source: "float-32", result: "integer", opcode: 0xbc };
    case FunctionalNumericConversion.ReinterpretSignedInteger32AsFloat32:
      return { source: "integer", result: "float-32", opcode: 0xbe };
    default:
      throw new RangeError(
        `functional numeric conversion must be within [1, 14]; received ${conversion}`,
      );
  }
}

function wideLiteralBits(node: FunctionalCoreNode): bigint {
  return BigInt.asIntN(64, BigInt(node.payload) | BigInt(node.child0) << 32n);
}

function float32FromBits(bits: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setUint32(0, bits, true);
  return view.getFloat32(0, true);
}

function float64FromBits(bits: bigint): number {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return view.getFloat64(0, true);
}

function wasmValueType(type: FunctionalHostType): number {
  switch (type.kind) {
    case "integer":
    case "boolean":
    case "unit":
      return WasmValueType.I32;
    case "signed-integer-64":
      return WasmValueType.I64;
    case "float-32":
      return WasmValueType.F32;
    case "float-64":
      return WasmValueType.F64;
    case "tuple":
    case "named":
      return WasmValueType.I64;
    case "parameter":
    case "function":
    case "forall":
      throw new TypeError(
        `functional WASM host type ${type.kind} is not concrete first-order`,
      );
  }
}

function functionalWasmEntry(module: GpuFunctionalModule): FunctionalWasmEntry {
  if (module.entryType.kind !== "function") {
    if (module.hostCapabilities.length !== 0) {
      throw new TypeError(
        `functional WASM entry d${module.entryDefinition} declares ${module.hostCapabilities.length} host capabilities but does not accept ${FUNCTIONAL_INIT_TYPE_NAME}`,
      );
    }
    requireFirstOrderFunctionalWasmType(
      module,
      module.entryType,
      "entry result",
    );
    return { takesInit: false, result: module.entryType };
  }
  const parameter = module.entryType.parameter;
  const takesInit = parameter.kind === "named" &&
    parameter.name === FUNCTIONAL_INIT_TYPE_NAME &&
    parameter.arguments.length === 0;
  if (module.entryType.result.kind === "function") {
    throw unsupportedWasmEntryType(module, module.entryType);
  }
  if (takesInit) {
    if (module.hostCapabilities.length === 0) {
      throw new TypeError(
        `functional WASM entry d${module.entryDefinition} accepts ${FUNCTIONAL_INIT_TYPE_NAME} but declares no host capabilities`,
      );
    }
    requireFirstOrderFunctionalWasmType(
      module,
      module.entryType.result,
      "entry result",
    );
    return { takesInit: true, result: module.entryType.result };
  }
  if (module.hostCapabilities.length !== 0) {
    throw new TypeError(
      `functional WASM entry d${module.entryDefinition} declares host capabilities but accepts ${
        describeFunctionalType(parameter)
      } instead of ${FUNCTIONAL_INIT_TYPE_NAME}`,
    );
  }
  requireFirstOrderFunctionalWasmType(module, parameter, "entry argument");
  requireFirstOrderFunctionalWasmType(
    module,
    module.entryType.result,
    "entry result",
  );
  return { takesInit: false, parameter, result: module.entryType.result };
}

function functionalEntryName(module: GpuFunctionalModule): string {
  return module.definitionNames[module.entryDefinition] ??
    `d${module.entryDefinition}`;
}

function functionalWasmRuntimeErrorDetails(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  faultCode: number,
  coreNode: number,
): FunctionalWasmRuntimeErrorDetails {
  const entryName = functionalEntryName(module);
  const node = coreNode >= 0 ? nodes[coreNode] : undefined;
  const nodeContext = node === undefined ? {} : {
    coreNode,
    span: { startByte: node.sourceByteOffset, endByte: node.sourceEndByte },
  };
  const span = nodeContext.span;
  const location = span === undefined ? undefined : locateFunctionalSpan(module.sources, span);
  const context = {
    entryDefinition: module.entryDefinition,
    entryName,
    ...nodeContext,
    ...(location === undefined ? {} : { location }),
  };
  if (faultCode === WASM_FAULT_BLACKHOLE) {
    return {
      ...context,
      code: "F3005",
      kind: "blackhole",
      message: `functional WASM entry ${
        JSON.stringify(entryName)
      } recursively forced an evaluating thunk`,
    };
  }
  if (faultCode === WASM_FAULT_DIVIDE_BY_ZERO) {
    return {
      ...context,
      code: "F3007",
      kind: "divide-by-zero",
      message: `functional WASM entry ${JSON.stringify(entryName)} divided by zero`,
    };
  }
  if (faultCode === WASM_FAULT_OUT_OF_MEMORY) {
    return {
      ...context,
      code: "F3003",
      kind: "out-of-memory",
      message: `functional WASM entry ${JSON.stringify(entryName)} could not grow linear memory`,
    };
  }
  if (faultCode === WASM_FAULT_OUT_OF_FUEL) {
    return {
      ...context,
      code: "F3002",
      kind: "out-of-fuel",
      message: `functional WASM entry ${JSON.stringify(entryName)} exhausted its semantic fuel`,
    };
  }
  if (faultCode === WASM_FAULT_INVALID_NUMERIC_CONVERSION) {
    return {
      ...context,
      code: "F3012",
      kind: "invalid-numeric-conversion",
      message: `functional WASM entry ${
        JSON.stringify(entryName)
      } converted a non-finite or out-of-range float to an integer`,
    };
  }
  return {
    ...context,
    code: "F3103",
    kind: "trap",
    message: `functional WASM entry ${
      JSON.stringify(entryName)
    } reported unknown runtime fault ${faultCode}`,
  };
}

function throwFunctionalWasmTrap(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  instance: WebAssembly.Instance,
  cause: unknown,
): never {
  if (cause instanceof FunctionalWasmRuntimeError) throw cause;
  const runtimeFault = instance.exports.runtimeFault;
  const runtimeFaultNode = instance.exports.runtimeFaultNode;
  if (
    runtimeFault instanceof WebAssembly.Global &&
    Number(runtimeFault.value) !== 0 &&
    runtimeFaultNode instanceof WebAssembly.Global
  ) {
    throw new FunctionalWasmRuntimeError(
      functionalWasmRuntimeErrorDetails(
        module,
        nodes,
        Number(runtimeFault.value),
        Number(runtimeFaultNode.value),
      ),
      cause,
    );
  }
  if (cause instanceof WebAssembly.RuntimeError) {
    throw new FunctionalWasmRuntimeError({
      code: "F3103",
      kind: "trap",
      entryDefinition: module.entryDefinition,
      entryName: functionalEntryName(module),
      message: `functional WASM entry ${
        JSON.stringify(functionalEntryName(module))
      } trapped: ${cause.message}`,
    }, cause);
  }
  throw cause;
}

function unsupportedWasmEntryType(
  module: GpuFunctionalModule,
  type: FunctionalType,
): TypeError {
  return new TypeError(
    `functional WASM entry d${module.entryDefinition} has unsupported type ${
      describeFunctionalType(type)
    }; ` +
      `expected a first-order result or ${FUNCTIONAL_INIT_TYPE_NAME} -> first-order result`,
  );
}

function functionalHostScalarType(
  type: FunctionalType,
): FunctionalHostScalarType | undefined {
  if (
    type.kind === "integer" || type.kind === "signed-integer-64" ||
    type.kind === "float-32" || type.kind === "float-64" ||
    type.kind === "boolean" || type.kind === "unit"
  ) return type;
  return undefined;
}

function functionalWasmImports(
  module: GpuFunctionalModule,
  init: FunctionalWasmInit | undefined,
): {
  readonly imports: Record<string, Record<string, CallableFunction>>;
  bindInstance(instance: WebAssembly.Instance): void;
} {
  const capabilities = module.hostCapabilities;
  let instance: WebAssembly.Instance | undefined;
  const requireInstance = (): WebAssembly.Instance => {
    if (instance === undefined) {
      throw new Error(
        "functional WASM host capability ran before module instantiation completed",
      );
    }
    return instance;
  };
  const bridge = (
    imports: Record<string, Record<string, CallableFunction>>,
  ) => ({
    imports,
    bindInstance(value: WebAssembly.Instance): void {
      if (instance !== undefined) {
        throw new Error("functional WASM host bridge was bound twice");
      }
      instance = value;
    },
  });
  if (capabilities.length === 0) return bridge({});
  if (init === undefined || init === null || typeof init !== "object") {
    throw invalidFunctionalWasmInit(
      "init",
      `functional WASM module requires init capabilities ${
        JSON.stringify(capabilities.map((capability) => capability.name))
      }; received ${describeHostBinding(init)}`,
    );
  }
  const imports = Object.create(null) as Record<
    string,
    Record<string, CallableFunction>
  >;
  for (const capability of capabilities) {
    const fields = Object.hasOwn(init, capability.name) ? init[capability.name] : undefined;
    if (fields === undefined || fields === null || typeof fields !== "object") {
      throw invalidFunctionalWasmInit(
        capability.name,
        `functional WASM init omitted capability ${JSON.stringify(capability.name)}; received ${
          describeHostBinding(fields)
        }`,
      );
    }
    const capabilityImports = Object.create(null) as Record<
      string,
      CallableFunction
    >;
    imports[hostImportModule(capability.name)] = capabilityImports;
    for (const declaration of capability.fields) {
      const binding = Object.hasOwn(fields, declaration.name)
        ? fields[declaration.name]
        : undefined;
      const key = hostFieldKey(capability.name, declaration.name);
      if (declaration.kind === "value") {
        if (typeof binding === "function" || binding === undefined) {
          throw invalidFunctionalWasmInit(
            key,
            `functional WASM init value ${
              JSON.stringify(key)
            } expected ${declaration.type.kind}; received ${describeHostBinding(binding)}`,
          );
        }
        capabilityImports[declaration.name] = () => {
          try {
            if (
              declaration.type.kind === "tuple" ||
              declaration.type.kind === "named"
            ) {
              return encodeFunctionalWasmValue(
                requireInstance(),
                module,
                concreteFunctionalType(declaration.type),
                binding,
              );
            }
            return hostValueAsNumber(binding, declaration.type, key);
          } catch (cause) {
            if (cause instanceof FunctionalWasmBoundaryError) throw cause;
            throw invalidFunctionalWasmInit(
              key,
              cause instanceof Error
                ? cause.message
                : `host value encoding failed: ${String(cause)}`,
              cause,
            );
          }
        };
        continue;
      }
      if (typeof binding !== "function") {
        throw invalidFunctionalWasmInit(
          key,
          `functional WASM init operation ${JSON.stringify(key)} expected a function; received ${
            describeHostBinding(binding)
          }`,
        );
      }
      capabilityImports[declaration.name] = (argument: number | bigint) => {
        const hostArgument = declaration.parameter.kind === "tuple" ||
            declaration.parameter.kind === "named"
          ? decodeFunctionalWasmValue(
            requireInstance(),
            module,
            concreteFunctionalType(declaration.parameter),
            argument,
            2_047,
          )
          : hostValueFromNative(argument, declaration.parameter);
        try {
          const result = binding(hostArgument);
          if (
            declaration.result.kind === "tuple" ||
            declaration.result.kind === "named"
          ) {
            return encodeFunctionalWasmValue(
              requireInstance(),
              module,
              concreteFunctionalType(declaration.result),
              result,
            );
          }
          return hostValueAsNumber(result, declaration.result, key);
        } catch (cause) {
          if (cause instanceof FunctionalWasmSuspension) throw cause;
          if (cause instanceof FunctionalWasmRuntimeError) throw cause;
          throw functionalHostOperationError(
            module,
            capability.name,
            declaration.name,
            cause,
          );
        }
      };
    }
  }
  return bridge(imports);
}

function hostValueFromNative(
  value: number | bigint,
  type: FunctionalHostType,
): FunctionalWasmHostValue {
  if (type.kind === "tuple" || type.kind === "named") {
    throw new TypeError(
      "functional WASM aggregate host values require an instantiated module",
    );
  }
  if (type.kind === "integer") {
    return { kind: "integer", value: Number(value) | 0 };
  }
  if (type.kind === "signed-integer-64") {
    return { kind: "signed-integer-64", value: BigInt(value) };
  }
  if (type.kind === "float-32") {
    return { kind: "float-32", value: Number(value) };
  }
  if (type.kind === "float-64") {
    return { kind: "float-64", value: Number(value) };
  }
  if (type.kind === "boolean") {
    return { kind: "boolean", value: value !== 0 && value !== 0n };
  }
  return { kind: "unit" };
}

function hostValueAsNumber(
  value: FunctionalWasmInitBinding,
  expectedType: FunctionalHostType,
  field: string,
): number | bigint {
  if (expectedType.kind === "tuple" || expectedType.kind === "named") {
    throw new TypeError(
      `functional WASM aggregate host field ${
        JSON.stringify(field)
      } requires an instantiated module`,
    );
  }
  if (
    value === null || typeof value !== "object" || typeof value === "function"
  ) {
    throw new TypeError(
      `functional WASM host field ${
        JSON.stringify(field)
      } expected ${expectedType.kind}; received ${describeHostBinding(value)}`,
    );
  }
  if (value.kind !== expectedType.kind) {
    throw new TypeError(
      `functional WASM host field ${
        JSON.stringify(field)
      } expected ${expectedType.kind}; received ${describeHostBinding(value)}`,
    );
  }
  if (value.kind === "unit") return 0;
  if (value.kind === "boolean") return value.value ? 1 : 0;
  if (value.kind === "signed-integer-64") {
    if (
      value.value < -0x8000000000000000n || value.value > 0x7fffffffffffffffn
    ) {
      throw new RangeError(
        `functional WASM host field ${
          JSON.stringify(field)
        } returned ${value.value}; expected signed i64`,
      );
    }
    return value.value;
  }
  if (value.kind === "float-32") return Math.fround(value.value);
  if (value.kind === "float-64") return value.value;
  if (
    !Number.isSafeInteger(value.value) || value.value < -2_147_483_648 ||
    value.value > 2_147_483_647
  ) {
    throw new RangeError(
      `functional WASM host field ${
        JSON.stringify(field)
      } returned integer ${value.value}; expected signed i32`,
    );
  }
  return value.value | 0;
}

function describeHostBinding(binding: unknown): string {
  if (binding === undefined) return "undefined";
  if (binding === null) return "null";
  if (typeof binding === "function") return "function";
  if (typeof binding !== "object") {
    return `${typeof binding} ${JSON.stringify(binding)}`;
  }
  const kind = (binding as { kind?: unknown }).kind;
  return kind === undefined ? "object without a kind" : `object with kind ${JSON.stringify(kind)}`;
}

function invalidFunctionalWasmInit(
  path: string,
  message: string,
  cause?: unknown,
): FunctionalWasmBoundaryError {
  return new FunctionalWasmBoundaryError({
    code: "F4102",
    kind: "invalid-init",
    path,
    message,
  }, cause);
}

function functionalHostOperationError(
  module: GpuFunctionalModule,
  capability: string,
  operation: string,
  cause: unknown,
): FunctionalWasmRuntimeError {
  const key = hostFieldKey(capability, operation);
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new FunctionalWasmRuntimeError({
    code: "F3101",
    kind: "host-operation",
    entryDefinition: module.entryDefinition,
    entryName: functionalEntryName(module),
    capability,
    operation,
    message: `functional WASM host operation ${JSON.stringify(key)} failed: ${reason}`,
  }, cause);
}

function hostFieldKey(capability: string, field: string): string {
  return `${capability}.${field}`;
}

function hostImportModule(capability: string): string {
  return `${HOST_IMPORT_MODULE_PREFIX}${capability}`;
}

function allocateFunction(): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const previousFree = instructions.addLocal(WasmValueType.I32);
  const currentFree = instructions.addLocal(WasmValueType.I32);
  const nextFree = instructions.addLocal(WasmValueType.I32);
  const previousTop = instructions.addLocal(WasmValueType.I32);
  const nextTop = instructions.addLocal(WasmValueType.I32);
  const requiredPages = instructions.addLocal(WasmValueType.I32);
  instructions.localGet(0);
  instructions.i32Const(7);
  instructions.emit(0x6a);
  instructions.i32Const(-8);
  instructions.emit(0x71);
  instructions.localSet(0);
  instructions.localGet(0);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.i32Const(8);
  instructions.localSet(0);
  instructions.emit(0x0b);
  instructions.globalGet(5);
  instructions.localSet(currentFree);
  instructions.emit(0x02, 0x40, 0x03, 0x40);
  instructions.localGet(currentFree);
  instructions.emit(0x45, 0x0d);
  instructions.unsigned(1);
  instructions.localGet(currentFree);
  instructions.i32Load(0);
  instructions.localGet(0);
  instructions.emit(0x4f, 0x04, 0x40);
  instructions.localGet(currentFree);
  instructions.i32Load(4);
  instructions.localSet(nextFree);
  instructions.localGet(previousFree);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.localGet(nextFree);
  instructions.globalSet(5);
  instructions.emit(0x05);
  instructions.localGet(previousFree);
  instructions.localGet(nextFree);
  instructions.i32Store(4);
  instructions.emit(0x0b);
  instructions.localGet(currentFree);
  instructions.emit(0x0f, 0x0b);
  instructions.localGet(currentFree);
  instructions.localSet(previousFree);
  instructions.localGet(currentFree);
  instructions.i32Load(4);
  instructions.localSet(currentFree);
  instructions.emit(0x0c);
  instructions.unsigned(0);
  instructions.emit(0x0b, 0x0b);
  instructions.emit(0x23, 0x00);
  instructions.localTee(previousTop);
  instructions.localGet(0);
  instructions.emit(0x6a);
  instructions.localTee(nextTop);
  instructions.emit(0x23, 0x03, 0x4b, 0x04, 0x40);
  instructions.localGet(nextTop);
  instructions.i32Const(65_535);
  instructions.emit(0x6a);
  instructions.i32Const(16);
  instructions.emit(0x76);
  instructions.localTee(requiredPages);
  instructions.emit(0x3f, 0x00, 0x6b, 0x40, 0x00);
  instructions.i32Const(-1);
  instructions.emit(0x46, 0x04, 0x40);
  instructions.i32Const(WASM_FAULT_OUT_OF_MEMORY);
  instructions.globalSet(2);
  instructions.i32Const(-1);
  instructions.globalSet(6);
  instructions.emit(0x00, 0x0b);
  instructions.localGet(requiredPages);
  instructions.i32Const(16);
  instructions.emit(0x74, 0x24, 0x03, 0x0b);
  instructions.localGet(nextTop);
  instructions.emit(0x24, 0x00);
  instructions.localGet(previousTop);
  return functionBody(0, instructions, "allocator");
}

function freeFunction(typeIndex: number): WasmFunctionBody {
  const instructions = new WasmInstructions(2);
  instructions.localGet(0);
  instructions.emit(0x45, 0x04, 0x40, 0x0f, 0x0b);
  instructions.localGet(1);
  instructions.i32Const(7);
  instructions.emit(0x6a);
  instructions.i32Const(-8);
  instructions.emit(0x71);
  instructions.localSet(1);
  instructions.localGet(0);
  instructions.localGet(1);
  instructions.i32Store(0);
  instructions.localGet(0);
  instructions.globalGet(5);
  instructions.i32Store(4);
  instructions.localGet(0);
  instructions.globalSet(5);
  return functionBody(typeIndex, instructions, "free-list release");
}

function forceThunkFunction(): WasmFunctionBody {
  const instructions = new WasmInstructions(1);
  const value = instructions.addLocal(WasmValueType.I64);
  instructions.localGet(0);
  instructions.i32Load(4);
  instructions.i32Const(THUNK_EVALUATED);
  instructions.emit(0x46, 0x04, WasmValueType.I64);
  instructions.localGet(0);
  instructions.i64Load(16);
  instructions.emit(0x05);
  instructions.localGet(0);
  instructions.i32Load(4);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.emit(0x05);
  instructions.i32Const(WASM_FAULT_BLACKHOLE);
  instructions.globalSet(2);
  instructions.i32Const(-1);
  instructions.globalSet(6);
  instructions.emit(0x00, 0x0b);
  instructions.localGet(0);
  instructions.i32Const(THUNK_EVALUATING);
  instructions.i32Store(4);
  instructions.emit(0x23, 0x01);
  instructions.i32Const(1);
  instructions.emit(0x6a, 0x24, 0x01);
  instructions.localGet(0);
  instructions.localGet(0);
  instructions.i32Load(8);
  instructions.callIndirect(4);
  instructions.localSet(value);
  instructions.localGet(0);
  instructions.localGet(value);
  instructions.i64Store(16);
  instructions.localGet(0);
  instructions.i32Const(THUNK_EVALUATED);
  instructions.i32Store(4);
  instructions.localGet(value);
  instructions.emit(0x0b);
  return functionBody(4, instructions, "thunk force slow path");
}

function functionBody(
  typeIndex: number,
  instructions: WasmInstructions,
  context: string,
): WasmFunctionBody {
  if (instructions.bytes.length === 0) {
    throw new Error(`functional WASM ${context} emitted no instructions`);
  }
  return {
    typeIndex,
    localTypes: instructions.localTypes,
    instructions: instructions.bytes,
    usesMemory: instructions.usesMemory,
    usesIndirectCalls: instructions.usesIndirectCalls,
  };
}
