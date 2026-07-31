import type { CompiledModule, CoreNode } from "./compiler_module.ts";
import {
  type CompilerPerformanceAnnotation,
  type CompilerPerformanceTrace,
  measureCompilerStage,
  measureCompilerStageAsync,
} from "../compiler_performance_trace.ts";
import { compiledLiteralUpdate } from "./compiled_module_rebinding.ts";
import {
  compileWasmArtifact,
  compileWasmArtifactWithSignedLiteralUpdate,
  type WasmArtifact,
} from "./wasm_codegen.ts";
import { resolvedCoreStructuralFingerprint } from "./semantic_fingerprint.ts";
import { validateWasmSimdMode } from "./wasm_backend_plan.ts";
import type { WasmCompilationOptions } from "./wasm_contract.ts";
import { compileWasmGc } from "./wasm_gc_codegen.ts";

const MAXIMUM_RESOLVED_CORE_WASM_ARTIFACTS = 64;

const wasmArtifactsByModule = new WeakMap<
  CompiledModule,
  Promise<WasmArtifact>
>();
const simdWasmArtifactsByModule = new WeakMap<
  CompiledModule,
  Promise<WasmArtifact>
>();
const executableWasmByModule = new WeakMap<
  CompiledModule,
  Promise<WebAssembly.Module>
>();
const wasmGcArtifactsByModule = new WeakMap<
  CompiledModule,
  Promise<{
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly nodes: readonly CoreNode[];
  }>
>();
const instrumentedWasmByModule = new WeakMap<
  CompiledModule,
  Promise<WasmArtifact & { readonly executable: WebAssembly.Module }>
>();
const resolvedCoreFingerprintByModule = new WeakMap<CompiledModule, Promise<string>>();
const instrumentedWasmByResolvedCore = new Map<
  string,
  Promise<WasmArtifact & { readonly executable: WebAssembly.Module }>
>();
const wasmArtifactsByResolvedCore = new Map<
  string,
  Promise<WasmArtifact>
>();

export async function compileModuleToWasm(
  module: CompiledModule,
  options: WasmCompilationOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("functional WASM compilation options must be an object");
  }
  validateWasmSimdMode(options.simd);
  const backend = options.backend ?? "linear-memory";
  if (backend !== "linear-memory" && backend !== "wasm-gc") {
    throw new TypeError(
      `functional WASM backend must be linear-memory or wasm-gc; received ${
        JSON.stringify(backend)
      }`,
    );
  }
  const customStorage = options.storageCore !== undefined ||
    options.ownedTypeExports !== undefined ||
    options.canonicalAbi !== undefined;
  const totalAnnotations = {
    backend,
    cacheEligible: backend === "wasm-gc" || !customStorage,
    bytes: 0,
  };
  return await measureCompilerStageAsync(
    options.trace,
    "wasm.total",
    totalAnnotations,
    async () => {
      if (backend === "wasm-gc") {
        if (
          options.storageCore !== undefined || options.ownedTypeExports !== undefined ||
          options.simd !== undefined || options.canonicalAbi !== undefined
        ) {
          throw new TypeError(
            "functional WasmGC compilation does not accept linear-memory storage, canonical ABI, or SIMD options",
          );
        }
        return (await cachedWasmGcArtifact(module, options.trace)).bytes.slice();
      }
      if (options.simd === "wasm-simd" && !customStorage) {
        return (await cachedSimdWasmArtifact(module, options.trace)).bytes.slice();
      }
      if (customStorage) {
        const nodes = await measureCompilerStageAsync(
          options.trace,
          "wasm.read-core",
          { nodes: module.nodeCount },
          () => module.readCoreNodes(),
        );
        return compileWasmArtifact(module, nodes, false, options, options.trace).bytes.slice();
      }
      return (await cachedWasmArtifact(module, options.trace)).bytes.slice();
    },
    (bytes) => totalAnnotations.bytes = bytes.byteLength,
  );
}

async function cachedSimdWasmArtifact(
  module: CompiledModule,
  trace?: CompilerPerformanceTrace,
): Promise<WasmArtifact> {
  return await cachedModuleValue(
    simdWasmArtifactsByModule,
    module,
    () =>
      measureCompilerStageAsync(
        trace,
        "wasm.read-core",
        { nodes: module.nodeCount },
        () => module.readCoreNodes(),
      ).then((nodes) =>
        compileWasmArtifact(module, nodes, false, {
          simd: "wasm-simd",
          ...(trace === undefined ? {} : { trace }),
        })
      ),
    trace === undefined ? undefined : {
      trace,
      stage: "wasm.artifact.module",
      annotations: { backend: "linear-memory", simd: true },
    },
  );
}

export async function cachedWasmGcArtifact(
  module: CompiledModule,
  trace?: CompilerPerformanceTrace,
): Promise<{
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly nodes: readonly CoreNode[];
}> {
  return await cachedModuleValue(
    wasmGcArtifactsByModule,
    module,
    () =>
      measureCompilerStageAsync(
        trace,
        "wasm.read-core",
        { nodes: module.nodeCount },
        () => module.readCoreNodes(),
      ).then((nodes) => {
        const annotations = { nodes: nodes.length, bytes: 0 };
        const bytes = measureCompilerStage(
          trace,
          "wasm.gc.emit",
          annotations,
          () => compileWasmGc(module, nodes),
          (emitted) => annotations.bytes = emitted.byteLength,
        );
        return { bytes, nodes };
      }),
    trace === undefined ? undefined : {
      trace,
      stage: "wasm.artifact.module",
      annotations: { backend: "wasm-gc" },
    },
  );
}

export async function cachedWasmArtifact(
  module: CompiledModule,
  trace?: CompilerPerformanceTrace,
): Promise<WasmArtifact> {
  return await cachedModuleValue(
    wasmArtifactsByModule,
    module,
    () =>
      measureCompilerStageAsync(
        trace,
        "wasm.read-core",
        { nodes: module.nodeCount },
        () => module.readCoreNodes(),
      ).then((nodes) => sharedWasmArtifact(module, nodes, trace)),
    trace === undefined ? undefined : {
      trace,
      stage: "wasm.artifact.module",
      annotations: { backend: "linear-memory", simd: false },
    },
  );
}

async function sharedWasmArtifact(
  module: CompiledModule,
  nodes: readonly CoreNode[],
  trace?: CompilerPerformanceTrace,
): Promise<WasmArtifact> {
  const annotations = { backend: "linear-memory", cacheHit: false, incremental: false };
  return await measureCompilerStageAsync(
    trace,
    "wasm.artifact.resolved-core",
    annotations,
    async () => {
      const fingerprint = await fingerprintResolvedCore(module, nodes, trace);
      const cached = wasmArtifactsByResolvedCore.get(fingerprint);
      if (cached !== undefined) {
        annotations.cacheHit = true;
        wasmArtifactsByResolvedCore.delete(fingerprint);
        wasmArtifactsByResolvedCore.set(fingerprint, cached);
        return await cached;
      }
      const literalUpdate = compiledLiteralUpdate(module);
      const referenceArtifact = literalUpdate === undefined
        ? undefined
        : wasmArtifactsByModule.get(literalUpdate.reference);
      const compilation = Promise.resolve().then(async () => {
        if (literalUpdate !== undefined && referenceArtifact !== undefined) {
          annotations.incremental = true;
          return compileWasmArtifactWithSignedLiteralUpdate(
            module,
            nodes,
            await referenceArtifact,
            literalUpdate.changedNodes,
            trace,
          );
        }
        return compileWasmArtifact(module, nodes, false, {}, trace);
      });
      wasmArtifactsByResolvedCore.set(fingerprint, compilation);
      evictOldestResolvedCoreArtifacts(wasmArtifactsByResolvedCore);
      try {
        return await compilation;
      } catch (error) {
        if (wasmArtifactsByResolvedCore.get(fingerprint) === compilation) {
          wasmArtifactsByResolvedCore.delete(fingerprint);
        }
        throw error;
      }
    },
  );
}

interface CachedModuleValueMeasurement {
  readonly trace: CompilerPerformanceTrace;
  readonly stage: string;
  readonly annotations: Readonly<Record<string, CompilerPerformanceAnnotation>>;
}

async function measuredCachedModuleValue<Value>(
  cache: WeakMap<CompiledModule, Promise<Value>>,
  module: CompiledModule,
  create: () => Promise<Value>,
  measurement: CachedModuleValueMeasurement,
): Promise<Value> {
  const annotations = { ...measurement.annotations, cacheHit: false };
  return await measureCompilerStageAsync(
    measurement.trace,
    measurement.stage,
    annotations,
    async () => {
      const cached = cache.get(module);
      if (cached !== undefined) {
        annotations.cacheHit = true;
        return await cached;
      }
      const pending = create();
      cache.set(module, pending);
      try {
        return await pending;
      } catch (error) {
        if (cache.get(module) === pending) cache.delete(module);
        throw error;
      }
    },
  );
}

async function cachedModuleValue<Value>(
  cache: WeakMap<CompiledModule, Promise<Value>>,
  module: CompiledModule,
  create: () => Promise<Value>,
  measurement?: CachedModuleValueMeasurement,
): Promise<Value> {
  if (measurement !== undefined) {
    return await measuredCachedModuleValue(cache, module, create, measurement);
  }
  const cached = cache.get(module);
  if (cached !== undefined) return await cached;
  const pending = create();
  cache.set(module, pending);
  try {
    return await pending;
  } catch (error) {
    if (cache.get(module) === pending) cache.delete(module);
    throw error;
  }
}

async function fingerprintResolvedCore(
  module: CompiledModule,
  nodes: readonly CoreNode[],
  trace?: CompilerPerformanceTrace,
): Promise<string> {
  return await cachedModuleValue(
    resolvedCoreFingerprintByModule,
    module,
    () => Promise.resolve(resolvedCoreStructuralFingerprint(module, nodes)),
    trace === undefined ? undefined : {
      trace,
      stage: "wasm.fingerprint.module",
      annotations: { nodes: nodes.length },
    },
  );
}

export async function cachedExecutableWasm(
  module: CompiledModule,
): Promise<WebAssembly.Module> {
  return await cachedModuleValue(
    executableWasmByModule,
    module,
    () => cachedWasmArtifact(module).then((artifact) => new WebAssembly.Module(artifact.bytes)),
  );
}

export async function fuelInstrumentedWasm(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): Promise<WasmArtifact & { readonly executable: WebAssembly.Module }> {
  return await cachedModuleValue(
    instrumentedWasmByModule,
    module,
    () => sharedFuelInstrumentedWasm(module, nodes),
  );
}

async function sharedFuelInstrumentedWasm(
  module: CompiledModule,
  nodes: readonly CoreNode[],
): Promise<WasmArtifact & { readonly executable: WebAssembly.Module }> {
  const fingerprint = await fingerprintResolvedCore(module, nodes);
  const cached = instrumentedWasmByResolvedCore.get(fingerprint);
  if (cached !== undefined) {
    instrumentedWasmByResolvedCore.delete(fingerprint);
    instrumentedWasmByResolvedCore.set(fingerprint, cached);
    return await cached;
  }
  const compilation = Promise.resolve().then(() => {
    const artifact = compileWasmArtifact(module, nodes, true);
    return { ...artifact, executable: new WebAssembly.Module(artifact.bytes) };
  });
  instrumentedWasmByResolvedCore.set(fingerprint, compilation);
  evictOldestResolvedCoreArtifacts(instrumentedWasmByResolvedCore);
  try {
    return await compilation;
  } catch (error) {
    if (instrumentedWasmByResolvedCore.get(fingerprint) === compilation) {
      instrumentedWasmByResolvedCore.delete(fingerprint);
    }
    throw error;
  }
}

function evictOldestResolvedCoreArtifacts<Value>(
  artifacts: Map<string, Promise<Value>>,
): void {
  while (artifacts.size > MAXIMUM_RESOLVED_CORE_WASM_ARTIFACTS) {
    const oldest = artifacts.keys().next().value;
    if (oldest === undefined) return;
    artifacts.delete(oldest);
  }
}

export async function resolvedCoreFingerprint(
  module: CompiledModule,
): Promise<string> {
  return await fingerprintResolvedCore(module, await module.readCoreNodes());
}
