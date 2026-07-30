import { CpuCompiler } from "../functional/compiler.ts";
import type { Diagnostic } from "../functional/abi.ts";
import { compileModuleToWasm } from "../functional/wasm_artifacts.ts";
import type { GleamDiagnostic } from "./diagnostic.ts";
import { lowerGleamSource } from "./frontend.ts";
import type {
  ParallelGleamCompileRequest,
  ParallelGleamCompileResponse,
} from "./parallel_compiler_worker.ts";
import type { ParallelGleamUnit } from "./parallel_frontend.ts";
import { sizeBalancedBatches } from "./worker_batches.ts";

const MINIMUM_PARALLEL_UNITS = 16;

export type ParallelGleamCompileResult =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | {
    readonly ok: false;
    readonly diagnostics: readonly (GleamDiagnostic | Diagnostic)[];
  };

/**
 * Compiles independent Gleam entries from source to separate Wasm artifacts in resident workers.
 *
 * Keeping every intermediate representation inside one worker avoids copying packed Surface and
 * Core between stages. Results are restored to input order after size-balanced scheduling.
 */
export class ParallelGleamCompiler {
  readonly #compiler = new CpuCompiler();
  readonly #workerCount: number;
  readonly #workers: Worker[] = [];
  readonly #cache = new Map<
    string,
    { readonly source: string; readonly result: ParallelGleamCompileResult }
  >();
  #active = false;
  #terminated = false;

  private constructor(workerCount: number) {
    this.#workerCount = workerCount;
  }

  static create(workerCount?: number): ParallelGleamCompiler {
    const available = navigator.hardwareConcurrency ?? 4;
    const count = Math.max(1, workerCount ?? Math.max(1, Math.ceil(available / 2)));
    return new ParallelGleamCompiler(count);
  }

  async compile(
    units: readonly ParallelGleamUnit[],
  ): Promise<readonly ParallelGleamCompileResult[]> {
    if (this.#terminated) throw new Error("parallel Gleam compiler was already terminated");
    if (this.#active) throw new Error("parallel Gleam compiler cannot compile concurrent batches");
    if (units.length === 0) return [];

    const results = new Array<ParallelGleamCompileResult | undefined>(units.length);
    const missing: { readonly resultIndex: number; readonly unit: ParallelGleamUnit }[] = [];
    for (const [resultIndex, unit] of units.entries()) {
      const cached = this.#cache.get(unit.name);
      if (cached?.source === unit.source) {
        results[resultIndex] = cached.result;
      } else {
        missing.push({ resultIndex, unit });
      }
    }
    if (missing.length === 0) return results as ParallelGleamCompileResult[];

    this.#active = true;
    try {
      if (missing.length < MINIMUM_PARALLEL_UNITS) {
        for (const { resultIndex, unit } of missing) {
          results[resultIndex] = await this.#compileInline(unit);
        }
      } else {
        const workers = this.#ensureWorkers();
        const batches = sizeBalancedBatches(
          missing,
          workers.length,
          ({ unit }) => unit.source.length,
        );
        const responses = await Promise.all(
          workers.slice(0, batches.length).map((worker, workerIndex) =>
            this.#request(worker, {
              units: (batches[workerIndex] ?? []).map(({ index, value }) => ({
                index,
                name: value.unit.name,
                source: value.unit.source,
              })),
            })
          ),
        );
        for (const response of responses) {
          for (const result of response.results) {
            const target = missing[result.index];
            if (target === undefined) {
              throw new Error(`parallel Gleam compiler returned unknown unit ${result.index}`);
            }
            results[target.resultIndex] = result.ok
              ? { ok: true, bytes: result.bytes }
              : { ok: false, diagnostics: result.diagnostics };
          }
        }
      }
      return results.map((result, index) => {
        if (result === undefined) throw new Error(`parallel Gleam compiler dropped unit ${index}`);
        const unit = units[index]!;
        this.#cache.set(unit.name, { source: unit.source, result });
        return result;
      });
    } finally {
      this.#active = false;
    }
  }

  terminate(): void {
    for (const worker of this.#workers) worker.terminate();
    this.#workers.length = 0;
    this.#cache.clear();
    this.#terminated = true;
  }

  async #compileInline(unit: ParallelGleamUnit): Promise<ParallelGleamCompileResult> {
    const frontend = lowerGleamSource(unit.name, unit.source);
    if (!frontend.ok) return frontend;
    const compilation = await this.#compiler.compileModule(frontend.lowered.module);
    if (!compilation.ok) return compilation;
    try {
      return { ok: true, bytes: await compileModuleToWasm(compilation.module) };
    } finally {
      compilation.module.destroy();
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

  #request(
    worker: Worker,
    request: ParallelGleamCompileRequest,
  ): Promise<ParallelGleamCompileResponse> {
    return new Promise((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<ParallelGleamCompileResponse>) => resolve(event.data);
      worker.onerror = (event) =>
        reject(new Error(`parallel Gleam compiler worker failed: ${event.message}`));
      worker.postMessage(request);
    });
  }
}
