import { type FunctionalDiagnostic } from "../../../src/functional/abi.ts";
import { GpuFunctionalCompiler } from "../../../src/functional/compiler.ts";
import {
  type FunctionalWasmValue,
  runFunctionalWasmModule,
} from "../../../src/functional/wasm_execution.ts";
import { describeFunctionalType } from "../../../src/functional/wasm_value_codec.ts";
import { type LazuliDiagnostic } from "../../../src/lazuli/abi.ts";
import {
  initializeLazuliParser,
  parseLazuliSourceForCompilation,
} from "../../../src/lazuli/frontend.ts";
import { lazuliSurfaceToFunctionalModule } from "../../../src/lazuli/functional_adapter.ts";

export interface CompilationTimings {
  readonly parseMilliseconds: number;
  readonly gpuMilliseconds?: number;
  readonly wasmMilliseconds?: number;
}

export type PlaygroundDiagnostic = LazuliDiagnostic | FunctionalDiagnostic;

export type BrowserCompilationResult =
  | {
      readonly kind: "diagnostics";
      readonly label: "Parse failed" | "Typecheck failed";
      readonly diagnostics: readonly PlaygroundDiagnostic[];
      readonly timings: CompilationTimings;
    }
  | {
      readonly kind: "success";
      readonly value: FunctionalWasmValue;
      readonly type: string;
      readonly nodeCount: number;
      readonly wasm: Uint8Array<ArrayBuffer>;
      readonly allocatedBytes: number;
      readonly thunkEvaluations: number;
      readonly adapterName: string;
      readonly startupMilliseconds: number;
      readonly timings: Required<CompilationTimings>;
    };

export type CompilationProgress =
  | "Loading parser"
  | "Initializing WebGPU"
  | "Compiling on GPU"
  | "Emitting Wasm";

interface BrowserCompilerRuntime {
  readonly compiler: GpuFunctionalCompiler;
  readonly device: GPUDevice;
  readonly adapterName: string;
  readonly startupMilliseconds: number;
}

let runtimeInitialization: Promise<BrowserCompilerRuntime> | undefined;
let activeDevice: GPUDevice | undefined;

export async function compileBrowserSource(
  source: string,
  reportProgress: (progress: CompilationProgress) => void,
): Promise<BrowserCompilationResult> {
  reportProgress("Loading parser");
  await initializeLazuliParser(
    playgroundAssetUrl("generated/lazuli-parser.wasm"),
    playgroundAssetUrl("generated/lazuli-parser.plan"),
  );

  const parseStartedAt = performance.now();
  const parsed = parseLazuliSourceForCompilation(source);
  const parseMilliseconds = performance.now() - parseStartedAt;
  if (!parsed.frontend.ok) {
    return {
      kind: "diagnostics",
      label: "Parse failed",
      diagnostics: parsed.frontend.diagnostics,
      timings: { parseMilliseconds },
    };
  }

  reportProgress("Initializing WebGPU");
  const runtime = await browserCompilerRuntime();
  const surfaceModule = lazuliSurfaceToFunctionalModule(
    parsed.frontend.surface,
    parsed.sourceByteLength,
  );

  reportProgress("Compiling on GPU");
  const gpuStartedAt = performance.now();
  const compilation = await runtime.compiler.compileModule(surfaceModule);
  const gpuMilliseconds = performance.now() - gpuStartedAt;
  if (!compilation.ok) {
    return {
      kind: "diagnostics",
      label: "Typecheck failed",
      diagnostics: compilation.diagnostics,
      timings: { parseMilliseconds, gpuMilliseconds },
    };
  }

  try {
    reportProgress("Emitting Wasm");
    const wasmStartedAt = performance.now();
    const execution = await runFunctionalWasmModule(compilation.module);
    const wasmMilliseconds = performance.now() - wasmStartedAt;
    return {
      kind: "success",
      value: execution.value,
      type: describeFunctionalType(compilation.module.entryType),
      nodeCount: compilation.module.nodeCount,
      wasm: execution.bytes.slice(),
      allocatedBytes: execution.stats.allocatedBytes,
      thunkEvaluations: execution.stats.thunkEvaluations,
      adapterName: runtime.adapterName,
      startupMilliseconds: runtime.startupMilliseconds,
      timings: { parseMilliseconds, gpuMilliseconds, wasmMilliseconds },
    };
  } finally {
    compilation.module.destroy();
  }
}

export function disposeBrowserCompiler(): void {
  activeDevice?.destroy();
  activeDevice = undefined;
  runtimeInitialization = undefined;
}

function playgroundAssetUrl(path: string): URL {
  return new URL(`${import.meta.env.BASE_URL}${path}`, globalThis.location.href);
}

async function browserCompilerRuntime(): Promise<BrowserCompilerRuntime> {
  if (runtimeInitialization !== undefined) return await runtimeInitialization;
  const initialization = createBrowserCompilerRuntime();
  runtimeInitialization = initialization;
  try {
    return await initialization;
  } catch (cause) {
    if (runtimeInitialization === initialization) runtimeInitialization = undefined;
    throw cause;
  }
}

async function createBrowserCompilerRuntime(): Promise<BrowserCompilerRuntime> {
  const startedAt = performance.now();
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) {
    throw new Error("WebGPU found no compatible adapter on this browser and device");
  }
  const adapterName =
    adapter.info.description || adapter.info.device || adapter.info.vendor || "WebGPU adapter";
  let device: GPUDevice | undefined;
  try {
    device = await adapter.requestDevice();
    activeDevice = device;
    const compiler = await GpuFunctionalCompiler.create(device);
    const initializedDevice = device;
    void initializedDevice.lost.then(() => {
      if (activeDevice === initializedDevice) activeDevice = undefined;
      runtimeInitialization = undefined;
    });
    return {
      compiler,
      device,
      adapterName,
      startupMilliseconds: performance.now() - startedAt,
    };
  } catch (cause) {
    device?.destroy();
    if (activeDevice === device) activeDevice = undefined;
    throw new Error(`could not initialize compiler on ${JSON.stringify(adapterName)}`, { cause });
  }
}
