/**
 * Parses and lowers many Gleam compilation units across worker threads.
 *
 * At batch scale the frontend, not the GPU, is the cost: measured at batch 1024, parse and lower
 * are 588 µs per module against 93 µs for GPU compilation. Both are pure functions of a source
 * string, so they parallelise across units with nothing shared — which makes this the cheapest
 * large win available on the batch path.
 *
 * Each worker instantiates its own baba parser, so the pool is worth creating once and reusing.
 * Below `MINIMUM_PARALLEL_UNITS` the pool costs more than it saves and this falls back to the
 * caller's thread.
 *
 * @module
 */
import type { EncodedModule } from "../../functional.ts";
import { lowerGleamSource } from "./frontend.ts";
import type { LowerResponse } from "./parallel_frontend_worker.ts";

export interface ParallelGleamUnit {
  readonly name: string;
  readonly source: string;
}

export type ParallelGleamResult =
  | { readonly ok: true; readonly module: EncodedModule }
  | { readonly ok: false; readonly diagnostic: string };

/** Below this, worker startup and message copying cost more than the parallelism returns. */
const MINIMUM_PARALLEL_UNITS = 16;

export class ParallelGleamFrontend {
  readonly #workers: Worker[] = [];
  readonly #workerCount: number;
  #terminated = false;

  private constructor(workerCount: number) {
    this.#workerCount = workerCount;
  }

  /**
   * `workerCount` defaults to one worker per core less one, leaving a core for the calling thread
   * and the GPU submission path.
   */
  static create(workerCount?: number): ParallelGleamFrontend {
    const available = navigator.hardwareConcurrency ?? 4;
    const count = Math.max(1, workerCount ?? Math.max(1, available - 1));
    return new ParallelGleamFrontend(count);
  }

  #ensureWorkers(): readonly Worker[] {
    if (this.#terminated) throw new Error("parallel Gleam frontend was already terminated");
    if (this.#workers.length > 0) return this.#workers;
    const url = new URL("./parallel_frontend_worker.ts", import.meta.url);
    for (let index = 0; index < this.#workerCount; index++) {
      this.#workers.push(new Worker(url, { type: "module" }));
    }
    return this.#workers;
  }

  async lower(units: readonly ParallelGleamUnit[]): Promise<readonly ParallelGleamResult[]> {
    if (units.length === 0) return [];
    if (units.length < MINIMUM_PARALLEL_UNITS) {
      return units.map((unit) => {
        const lowered = lowerGleamSource(unit.name, unit.source);
        return lowered.ok ? { ok: true as const, module: lowered.lowered.module } : {
          ok: false as const,
          diagnostic: lowered.diagnostics[0]?.message ?? "lowering failed",
        };
      });
    }

    const workers = this.#ensureWorkers();
    // Contiguous slices rather than round-robin: adjacent units in a batch tend to be similar in
    // size, so slicing keeps each worker's share comparable without a scheduler.
    const perWorker = Math.ceil(units.length / workers.length);
    const results = new Array<ParallelGleamResult | undefined>(units.length);

    await Promise.all(workers.map((worker, workerIndex) => {
      const start = workerIndex * perWorker;
      const slice = units.slice(start, start + perWorker);
      if (slice.length === 0) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<readonly LowerResponse[]>) => {
          for (const response of event.data) {
            results[response.id] = response.module === undefined
              ? { ok: false, diagnostic: response.diagnostic ?? "lowering failed" }
              : { ok: true, module: response.module };
          }
          resolve();
        };
        worker.onerror = (event) =>
          reject(new Error(`Gleam frontend worker failed: ${event.message}`));
        worker.postMessage(
          slice.map((unit, offset) => ({
            id: start + offset,
            name: unit.name,
            source: unit.source,
          })),
        );
      });
    }));

    return results.map((result, index) => {
      if (result === undefined) {
        throw new Error(`parallel Gleam frontend dropped unit ${index}`);
      }
      return result;
    });
  }

  terminate(): void {
    for (const worker of this.#workers) worker.terminate();
    this.#workers.length = 0;
    this.#terminated = true;
  }
}
