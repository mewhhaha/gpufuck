import {
  completeFunctionalTypeDeclarations,
  type FunctionalCoreNode,
  type GpuFunctionalModule,
} from "./compiler_module.ts";
import { compileFunctionalWasmArtifact, type FunctionalWasmArtifact } from "./wasm_codegen.ts";
import type { FunctionalWasmCompilationOptions } from "./wasm_contract.ts";
import { compileFunctionalWasmGc } from "./wasm_gc_codegen.ts";

const MAXIMUM_RESOLVED_CORE_WASM_ARTIFACTS = 64;

const wasmArtifactsByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<FunctionalWasmArtifact>
>();
const executableWasmByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<WebAssembly.Module>
>();
const wasmGcArtifactsByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<{
    readonly bytes: Uint8Array<ArrayBuffer>;
    readonly nodes: readonly FunctionalCoreNode[];
  }>
>();
const instrumentedWasmByModule = new WeakMap<
  GpuFunctionalModule,
  Promise<FunctionalWasmArtifact & { readonly executable: WebAssembly.Module }>
>();
const resolvedCoreFingerprintByModule = new WeakMap<GpuFunctionalModule, Promise<string>>();
const instrumentedWasmByResolvedCore = new Map<
  string,
  Promise<FunctionalWasmArtifact & { readonly executable: WebAssembly.Module }>
>();

export async function compileFunctionalModuleToWasm(
  module: GpuFunctionalModule,
  options: FunctionalWasmCompilationOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("functional WASM compilation options must be an object");
  }
  const backend = options.backend ?? "linear-memory";
  if (backend !== "linear-memory" && backend !== "wasm-gc") {
    throw new TypeError(
      `functional WASM backend must be linear-memory or wasm-gc; received ${
        JSON.stringify(backend)
      }`,
    );
  }
  if (backend === "wasm-gc") {
    if (options.storageCore !== undefined || options.ownedTypeExports !== undefined) {
      throw new TypeError(
        "functional WasmGC compilation does not accept linear-memory storage options",
      );
    }
    return (await cachedFunctionalWasmGcArtifact(module)).bytes.slice();
  }
  if (options.storageCore !== undefined || options.ownedTypeExports !== undefined) {
    return compileFunctionalWasmArtifact(
      module,
      await module.readCoreNodes(),
      false,
      options,
    ).bytes.slice();
  }
  return (await cachedFunctionalWasmArtifact(module)).bytes.slice();
}

export async function cachedFunctionalWasmGcArtifact(
  module: GpuFunctionalModule,
): Promise<{
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly nodes: readonly FunctionalCoreNode[];
}> {
  const cached = wasmGcArtifactsByModule.get(module);
  if (cached !== undefined) return await cached;
  const compilation = module.readCoreNodes().then((nodes) => ({
    bytes: compileFunctionalWasmGc(module, nodes),
    nodes,
  }));
  wasmGcArtifactsByModule.set(module, compilation);
  try {
    return await compilation;
  } catch (error) {
    if (wasmGcArtifactsByModule.get(module) === compilation) {
      wasmGcArtifactsByModule.delete(module);
    }
    throw error;
  }
}

export async function cachedFunctionalWasmArtifact(
  module: GpuFunctionalModule,
): Promise<FunctionalWasmArtifact> {
  const cached = wasmArtifactsByModule.get(module);
  if (cached !== undefined) return await cached;
  const compilation = module.readCoreNodes().then((nodes) =>
    compileFunctionalWasmArtifact(module, nodes)
  );
  wasmArtifactsByModule.set(module, compilation);
  try {
    return await compilation;
  } catch (error) {
    if (wasmArtifactsByModule.get(module) === compilation) {
      wasmArtifactsByModule.delete(module);
    }
    throw error;
  }
}

export async function cachedExecutableWasm(
  module: GpuFunctionalModule,
): Promise<WebAssembly.Module> {
  const cached = executableWasmByModule.get(module);
  if (cached !== undefined) return await cached;
  const compilation = cachedFunctionalWasmArtifact(module).then((artifact) =>
    new WebAssembly.Module(artifact.bytes)
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

export async function fuelInstrumentedWasm(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
): Promise<FunctionalWasmArtifact & { readonly executable: WebAssembly.Module }> {
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
): Promise<FunctionalWasmArtifact & { readonly executable: WebAssembly.Module }> {
  const fingerprint = await resolvedCoreFingerprint(module, nodes);
  const cached = instrumentedWasmByResolvedCore.get(fingerprint);
  if (cached !== undefined) {
    instrumentedWasmByResolvedCore.delete(fingerprint);
    instrumentedWasmByResolvedCore.set(fingerprint, cached);
    return await cached;
  }
  const compilation = Promise.resolve().then(() => {
    const artifact = compileFunctionalWasmArtifact(module, nodes, true);
    return { ...artifact, executable: new WebAssembly.Module(artifact.bytes) };
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
    typeDeclarations: completeFunctionalTypeDeclarations(module),
    hostCapabilities: module.hostCapabilities,
    hostDefinitions: module.hostDefinitions,
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
