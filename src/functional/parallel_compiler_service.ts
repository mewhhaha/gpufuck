import type { Diagnostic, EncodedModule } from "./abi.ts";
import { CpuCompiler } from "./compiler.ts";
import type { CompiledModule, CpuCompileResult } from "./compiler_module.ts";
import {
  compiledModuleTransferables,
  decodeTransferredCompiledModule,
  encodeCompiledModuleForTransfer,
} from "./compiled_module_transfer.ts";
import { encodeModuleForTransfer } from "./module_transfer.ts";
import { compileModuleToWasm } from "./wasm_artifacts.ts";
import {
  compileModulesToWasm,
  type WasmBatchArtifact,
  type WasmBatchCompilationOptions,
} from "./wasm_batch.ts";
import type {
  ParallelCompileRequest,
  ParallelCompileResponse,
  ParallelCompileWorkerResult,
} from "./parallel_compiler_worker.ts";

const MINIMUM_PARALLEL_MODULES = 16;

export type ParallelWasmCompileResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  };

export type ParallelSharedWasmCompileResult =
  | { readonly ok: true; readonly artifact: WasmBatchArtifact }
  | {
    readonly ok: false;
    readonly failures: readonly {
      readonly index: number;
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    }[];
  };

/**
 * Compiles independent packed modules across resident host workers.
 *
 * `compileBatchToWasm` is the throughput path because Core stays inside each worker. Returning Core
 * is supported for callers that need it, while `compileBatchToSharedWasm` trades serial final
 * assembly for one smaller artifact with a shared runtime.
 */
export class ParallelFunctionalCompilerService {
  readonly #compiler = new CpuCompiler();
  readonly #workerCount: number;
  readonly #workers: Worker[] = [];
  #active = false;
  #terminated = false;

  private constructor(workerCount: number) {
    this.#workerCount = workerCount;
  }

  static create(workerCount?: number): ParallelFunctionalCompilerService {
    const available = navigator.hardwareConcurrency ?? 4;
    const count = Math.max(1, workerCount ?? Math.max(1, Math.ceil(available / 2)));
    return new ParallelFunctionalCompilerService(count);
  }

  async compileBatch(
    modules: readonly EncodedModule[],
  ): Promise<readonly CpuCompileResult[]> {
    this.#requireActive();
    if (modules.length < MINIMUM_PARALLEL_MODULES) {
      return await this.#compiler.compileBatch(modules);
    }
    const results = await this.#run(modules, "core");
    return results.map((result, index): CpuCompileResult => {
      if (!result.ok) return result;
      if (!("module" in result)) {
        throw new Error(`parallel compiler returned Wasm for Core module ${index}`);
      }
      return { ok: true, module: decodeTransferredCompiledModule(result.module) };
    });
  }

  async compileBatchToWasm(
    modules: readonly EncodedModule[],
  ): Promise<readonly ParallelWasmCompileResult[]> {
    this.#requireActive();
    if (modules.length < MINIMUM_PARALLEL_MODULES) {
      return await Promise.all(modules.map(async (module): Promise<ParallelWasmCompileResult> => {
        const compilation = await this.#compiler.compileModule(module);
        if (!compilation.ok) return compilation;
        try {
          return { ok: true, bytes: await compileModuleToWasm(compilation.module) };
        } finally {
          compilation.module.destroy();
        }
      }));
    }
    const results = await this.#run(modules, "wasm");
    return results.map((result, index): ParallelWasmCompileResult => {
      if (!result.ok) return result;
      if (!("wasm" in result)) {
        throw new Error(`parallel compiler returned Core for Wasm module ${index}`);
      }
      return { ok: true, bytes: result.wasm };
    });
  }

  async compileBatchToSharedWasm(
    modules: readonly EncodedModule[],
    options: WasmBatchCompilationOptions = {},
  ): Promise<ParallelSharedWasmCompileResult> {
    const compilations = await this.compileBatch(modules);
    const failures = compilations.flatMap((result, index) =>
      result.ok ? [] : [{ index, diagnostics: result.diagnostics }]
    );
    if (failures.length > 0) {
      for (const result of compilations) if (result.ok) result.module.destroy();
      return { ok: false, failures };
    }
    const compiled = compilations.map((result, index) => {
      if (!result.ok) {
        throw new Error(`parallel shared Wasm compilation retained failed module ${index}`);
      }
      return result.module;
    });
    try {
      return {
        ok: true,
        artifact: await compileModulesToWasm(compiled, options),
      };
    } finally {
      for (const module of compiled) module.destroy();
    }
  }

  async emitWasmBatch(
    modules: readonly CompiledModule[],
  ): Promise<readonly Uint8Array<ArrayBuffer>[]> {
    this.#requireActive();
    if (modules.length < MINIMUM_PARALLEL_MODULES) {
      return await Promise.all(modules.map((module) => compileModuleToWasm(module)));
    }
    if (this.#terminated) throw new Error("parallel functional compiler was already terminated");
    if (this.#active) {
      throw new Error("parallel functional compiler cannot compile concurrent batches");
    }
    this.#active = true;
    try {
      const workers = this.#ensureWorkers();
      const batches = sizeBalancedCompiledBatches(modules, workers.length);
      const responses = await Promise.all(
        workers.slice(0, batches.length).map(async (worker, workerIndex) =>
          await this.#request(worker, {
            mode: "compiled-wasm",
            modules: await Promise.all((batches[workerIndex] ?? []).map(async ({
              index,
              module,
            }) => ({
              index,
              module: await encodeCompiledModuleForTransfer(module),
            }))),
          })
        ),
      );
      const wasm = new Array<Uint8Array<ArrayBuffer> | undefined>(modules.length);
      for (const response of responses) {
        for (const result of response.results) {
          if (!result.ok || !("wasm" in result)) {
            throw new Error(`parallel Wasm emitter returned no bytes for module ${result.index}`);
          }
          wasm[result.index] = result.wasm;
        }
      }
      return wasm.map((bytes, index) => {
        if (bytes === undefined) throw new Error(`parallel Wasm emitter dropped module ${index}`);
        return bytes;
      });
    } finally {
      this.#active = false;
    }
  }

  terminate(): void {
    for (const worker of this.#workers) worker.terminate();
    this.#workers.length = 0;
    this.#terminated = true;
  }

  async #run(
    modules: readonly EncodedModule[],
    mode: "core" | "wasm",
  ): Promise<readonly ParallelCompileWorkerResult[]> {
    if (this.#terminated) throw new Error("parallel functional compiler was already terminated");
    if (this.#active) {
      throw new Error("parallel functional compiler cannot compile concurrent batches");
    }
    if (modules.length === 0) return [];
    this.#active = true;
    try {
      const workers = this.#ensureWorkers();
      const batches = sizeBalancedBatches(modules, workers.length);
      const responses = await Promise.all(
        workers.slice(0, batches.length).map((worker, workerIndex) =>
          this.#request(worker, {
            mode,
            modules: (batches[workerIndex] ?? []).map(({ index, module }) => ({
              index,
              module: encodeModuleForTransfer(module),
            })),
          })
        ),
      );
      const ordered = new Array<ParallelCompileWorkerResult | undefined>(modules.length);
      for (const response of responses) {
        for (const result of response.results) ordered[result.index] = result;
      }
      return ordered.map((result, index) => {
        if (result === undefined) {
          throw new Error(`parallel functional compiler dropped module ${index}`);
        }
        return result;
      });
    } finally {
      this.#active = false;
    }
  }

  #ensureWorkers(): readonly Worker[] {
    if (this.#workers.length > 0) return this.#workers;
    const url = new URL("./parallel_compiler_worker.ts", import.meta.url);
    for (let index = 0; index < this.#workerCount; index++) {
      this.#workers.push(new Worker(url, { type: "module" }));
    }
    return this.#workers;
  }

  #requireActive(): void {
    if (this.#terminated) throw new Error("parallel functional compiler was already terminated");
  }

  #request(
    worker: Worker,
    request: ParallelCompileRequest,
  ): Promise<ParallelCompileResponse> {
    return new Promise((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ParallelCompileResponse>) => resolve(event.data);
      worker.onerror = (event) =>
        reject(new Error(`parallel functional compiler worker failed: ${event.message}`));
      const transferables = request.mode === "compiled-wasm"
        ? request.modules.flatMap(({ module }) => compiledModuleTransferables(module))
        : [];
      worker.postMessage(request, { transfer: transferables });
    });
  }
}

function sizeBalancedBatches(
  modules: readonly EncodedModule[],
  workerCount: number,
): readonly (readonly { readonly index: number; readonly module: EncodedModule }[])[] {
  const batches = Array.from(
    { length: Math.min(workerCount, modules.length) },
    () => ({ weight: 0, modules: [] as { index: number; module: EncodedModule }[] }),
  );
  const largestFirst = modules
    .map((module, index) => ({ index, module }))
    .sort((left, right) =>
      moduleWeight(right.module) - moduleWeight(left.module) || left.index - right.index
    );
  for (const entry of largestFirst) {
    let target = batches[0]!;
    for (const candidate of batches) {
      if (candidate.weight < target.weight) target = candidate;
    }
    target.modules.push(entry);
    target.weight += moduleWeight(entry.module);
  }
  return batches.map((batch) => batch.modules);
}

function moduleWeight(module: EncodedModule): number {
  return module.nodeCount + module.definitionCount * 8 + module.sourceByteLength / 16;
}

function sizeBalancedCompiledBatches(
  modules: readonly CompiledModule[],
  workerCount: number,
): readonly (readonly { readonly index: number; readonly module: CompiledModule }[])[] {
  const batches = Array.from(
    { length: Math.min(workerCount, modules.length) },
    () => ({ weight: 0, modules: [] as { index: number; module: CompiledModule }[] }),
  );
  const largestFirst = modules
    .map((module, index) => ({ index, module }))
    .sort((left, right) =>
      right.module.nodeCount - left.module.nodeCount || left.index - right.index
    );
  for (const entry of largestFirst) {
    let target = batches[0]!;
    for (const candidate of batches) {
      if (candidate.weight < target.weight) target = candidate;
    }
    target.modules.push(entry);
    target.weight += entry.module.nodeCount;
  }
  return batches.map((batch) => batch.modules);
}
