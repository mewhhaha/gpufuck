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
import {
  resolvedCoreStructuralFingerprint,
  structuralFingerprint,
} from "./semantic_fingerprint.ts";
import { validateWasmSimdMode } from "./wasm_backend_plan.ts";
import type { WasmCompilationOptions } from "./wasm_contract.ts";
import { type CanonicalAbiInterface, validateCanonicalAbiInterface } from "./canonical_abi.ts";

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
const canonicalWasmArtifactsByResolvedCore = new Map<
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
  const canonicalCacheEligible = options.canonicalAbi !== undefined;
  const totalAnnotations = {
    backend: "linear-memory",
    cacheEligible: true,
    bytes: 0,
  };
  return await measureCompilerStageAsync(
    options.trace,
    "wasm.total",
    totalAnnotations,
    async () => {
      if (options.simd === "wasm-simd" && options.canonicalAbi === undefined) {
        return (await cachedSimdWasmArtifact(module, options.trace)).bytes.slice();
      }
      if (canonicalCacheEligible) {
        return (await cachedCanonicalWasmArtifact(
          module,
          options.canonicalAbi!,
          options.simd,
          options.trace,
        ))
          .bytes.slice();
      }
      return (await cachedWasmArtifact(module, options.trace)).bytes.slice();
    },
    (bytes) => totalAnnotations.bytes = bytes.byteLength,
  );
}

async function cachedCanonicalWasmArtifact(
  module: CompiledModule,
  canonicalAbi: CanonicalAbiInterface,
  simd: WasmCompilationOptions["simd"],
  trace?: CompilerPerformanceTrace,
): Promise<WasmArtifact> {
  validateCanonicalAbiInterface(canonicalAbi);
  const nodes = await measureCompilerStageAsync(
    trace,
    "wasm.read-core",
    { nodes: module.nodeCount },
    () => module.readCoreNodes(),
  );
  const coreFingerprint = await fingerprintResolvedCore(module, nodes, trace);
  const key = `${coreFingerprint}:canonical-v1:${simd ?? "portable-scalar"}:` +
    structuralFingerprint(canonicalAbi);
  const annotations = { backend: "linear-memory", canonicalAbi: true, cacheHit: false };
  return await measureCompilerStageAsync(
    trace,
    "wasm.artifact.resolved-core",
    annotations,
    async () => {
      const cached = canonicalWasmArtifactsByResolvedCore.get(key);
      if (cached !== undefined) {
        annotations.cacheHit = true;
        canonicalWasmArtifactsByResolvedCore.delete(key);
        canonicalWasmArtifactsByResolvedCore.set(key, cached);
        return await cached;
      }
      const compilation = Promise.resolve().then(() =>
        compileWasmArtifact(module, nodes, false, {
          canonicalAbi,
          ...(simd === undefined ? {} : { simd }),
          ...(trace === undefined ? {} : { trace }),
        })
      );
      canonicalWasmArtifactsByResolvedCore.set(key, compilation);
      evictOldestResolvedCoreArtifacts(canonicalWasmArtifactsByResolvedCore);
      try {
        return await compilation;
      } catch (error) {
        if (canonicalWasmArtifactsByResolvedCore.get(key) === compilation) {
          canonicalWasmArtifactsByResolvedCore.delete(key);
        }
        throw error;
      }
    },
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
