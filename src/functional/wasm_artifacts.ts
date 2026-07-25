import { completeTypeDeclarations, type CoreNode, type GpuModule } from "./compiler_module.ts";
import { compileWasmArtifact, type WasmArtifact } from "./wasm_codegen.ts";
import { validateWasmSimdMode } from "./wasm_backend_plan.ts";
import type { WasmCompilationOptions } from "./wasm_contract.ts";
import { compileWasmGc } from "./wasm_gc_codegen.ts";

const MAXIMUM_RESOLVED_CORE_WASM_ARTIFACTS = 64;

const wasmArtifactsByModule = new WeakMap<
  GpuModule,
  Promise<WasmArtifact>
>();
const simdWasmArtifactsByModule = new WeakMap<
  GpuModule,
  Promise<WasmArtifact>
>();
const executableWasmByModule = new WeakMap<
  GpuModule,
  Promise<WebAssembly.Module>
>();
const wasmGcArtifactsByModule = new WeakMap<
  GpuModule,
  Promise<{
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly nodes: readonly CoreNode[];
  }>
>();
const instrumentedWasmByModule = new WeakMap<
  GpuModule,
  Promise<WasmArtifact & { readonly executable: WebAssembly.Module }>
>();
const resolvedCoreFingerprintByModule = new WeakMap<GpuModule, Promise<string>>();
const instrumentedWasmByResolvedCore = new Map<
  string,
  Promise<WasmArtifact & { readonly executable: WebAssembly.Module }>
>();
const wasmArtifactsByResolvedCore = new Map<
  string,
  Promise<WasmArtifact>
>();

export async function compileModuleToWasm(
  module: GpuModule,
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
  if (backend === "wasm-gc") {
    if (
      options.storageCore !== undefined || options.ownedTypeExports !== undefined ||
      options.simd !== undefined
    ) {
      throw new TypeError(
        "functional WasmGC compilation does not accept linear-memory storage or SIMD options",
      );
    }
    return (await cachedWasmGcArtifact(module)).bytes.slice();
  }
  const customStorage = options.storageCore !== undefined ||
    options.ownedTypeExports !== undefined;
  if (options.simd === "wasm-simd" && !customStorage) {
    return (await cachedSimdWasmArtifact(module)).bytes.slice();
  }
  if (customStorage) {
    return compileWasmArtifact(
      module,
      await module.readCoreNodes(),
      false,
      options,
    ).bytes.slice();
  }
  return (await cachedWasmArtifact(module)).bytes.slice();
}

async function cachedSimdWasmArtifact(
  module: GpuModule,
): Promise<WasmArtifact> {
  return await cachedModuleValue(
    simdWasmArtifactsByModule,
    module,
    () =>
      module.readCoreNodes().then((nodes) =>
        compileWasmArtifact(module, nodes, false, { simd: "wasm-simd" })
      ),
  );
}

export async function cachedWasmGcArtifact(
  module: GpuModule,
): Promise<{
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly nodes: readonly CoreNode[];
}> {
  return await cachedModuleValue(
    wasmGcArtifactsByModule,
    module,
    () =>
      module.readCoreNodes().then((nodes) => ({
        bytes: compileWasmGc(module, nodes),
        nodes,
      })),
  );
}

export async function cachedWasmArtifact(
  module: GpuModule,
): Promise<WasmArtifact> {
  return await cachedModuleValue(
    wasmArtifactsByModule,
    module,
    () => module.readCoreNodes().then((nodes) => sharedWasmArtifact(module, nodes)),
  );
}

async function sharedWasmArtifact(
  module: GpuModule,
  nodes: readonly CoreNode[],
): Promise<WasmArtifact> {
  const fingerprint = await resolvedCoreFingerprint(module, nodes);
  const cached = wasmArtifactsByResolvedCore.get(fingerprint);
  if (cached !== undefined) {
    wasmArtifactsByResolvedCore.delete(fingerprint);
    wasmArtifactsByResolvedCore.set(fingerprint, cached);
    return await cached;
  }
  const compilation = Promise.resolve().then(() => compileWasmArtifact(module, nodes));
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
}

export async function cachedExecutableWasm(
  module: GpuModule,
): Promise<WebAssembly.Module> {
  return await cachedModuleValue(
    executableWasmByModule,
    module,
    () => cachedWasmArtifact(module).then((artifact) => new WebAssembly.Module(artifact.bytes)),
  );
}

export async function fuelInstrumentedWasm(
  module: GpuModule,
  nodes: readonly CoreNode[],
): Promise<WasmArtifact & { readonly executable: WebAssembly.Module }> {
  return await cachedModuleValue(
    instrumentedWasmByModule,
    module,
    () => sharedFuelInstrumentedWasm(module, nodes),
  );
}

async function sharedFuelInstrumentedWasm(
  module: GpuModule,
  nodes: readonly CoreNode[],
): Promise<WasmArtifact & { readonly executable: WebAssembly.Module }> {
  const fingerprint = await resolvedCoreFingerprint(module, nodes);
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

async function resolvedCoreFingerprint(
  module: GpuModule,
  nodes: readonly CoreNode[],
): Promise<string> {
  return await cachedModuleValue(
    resolvedCoreFingerprintByModule,
    module,
    () =>
      sha256(JSON.stringify({
        format: 1,
        nodes,
        definitionNames: module.definitionNames,
        definitionRoots: module.definitionRoots,
        constructorNames: module.constructorNames,
        constructorArities: module.constructorArities,
        entryDefinition: module.entryDefinition,
        entryType: module.entryType,
        entryEffects: module.entryEffects,
        typeDeclarations: completeTypeDeclarations(module),
        hostCapabilities: module.hostCapabilities,
        hostDefinitions: module.hostDefinitions,
        wasmExports: module.wasmExports,
        sources: module.sources,
        evaluationProfile: module.evaluationProfile,
      })),
  );
}

export async function functionalResolvedCoreFingerprint(
  module: GpuModule,
): Promise<string> {
  return await resolvedCoreFingerprint(module, await module.readCoreNodes());
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function cachedModuleValue<Value>(
  cache: WeakMap<GpuModule, Promise<Value>>,
  module: GpuModule,
  create: () => Promise<Value>,
): Promise<Value> {
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
