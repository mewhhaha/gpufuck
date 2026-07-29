/// <reference lib="webworker" />

/**
 * One worker of the playground's parallel frontend.
 *
 * `src/gleam/parallel_frontend_worker.ts` cannot be reused here: it lets the parser load its Wasm
 * from disk, which only works under Deno. In a browser the parser has to be handed URLs, and the
 * bundle has to be a separate entry point so `new Worker` has something to fetch.
 *
 * Parsing and lowering are pure functions of a source string, so nothing is shared across workers
 * beyond the parser each one instantiates for itself.
 *
 * Measured on 2026-07-27: this is the whole of the win. Lexing is 1% of the frontend and tree
 * building plus lowering is the other 99%, so moving lexing to the GPU caps out at 1.01x while
 * spreading the whole frontend across cores is worth several times that.
 *
 * @module
 */
import {
  encodeModuleForTransfer,
  type TransferEncodedModule,
} from "../src/functional/module_transfer.ts";
import { lowerGleamSource } from "../src/gleam/frontend.ts";
import { initializeGleamParser } from "../src/gleam/parser.ts";

interface LowerRequest {
  readonly id: number;
  readonly name: string;
  readonly source: string;
  /** Where to fetch the parser from; the worker has no filesystem to fall back on. */
  readonly wasmUrl: string;
  readonly planUrl: string;
}

export interface WorkerResponse {
  readonly id: number;
  readonly module?: TransferEncodedModule;
  readonly diagnostic?: string;
}

let ready: Promise<void> | undefined;

self.onmessage = async (event: MessageEvent<readonly LowerRequest[]>) => {
  const batch = event.data;
  const first = batch[0];
  if (first === undefined) {
    self.postMessage([]);
    return;
  }
  // Instantiated once per worker and reused; the promise is cached so a second batch does not refetch.
  ready ??= initializeGleamParser(new URL(first.wasmUrl), new URL(first.planUrl)).then(() => {});
  await ready;

  const responses: WorkerResponse[] = [];
  for (const request of batch) {
    try {
      const lowered = lowerGleamSource(request.name, request.source);
      responses.push(
        lowered.ok
          ? { id: request.id, module: encodeModuleForTransfer(lowered.lowered.module) }
          : { id: request.id, diagnostic: lowered.diagnostics[0]?.message ?? "lowering failed" },
      );
    } catch (error) {
      responses.push({
        id: request.id,
        diagnostic: error instanceof Error ? error.message : String(error),
      });
    }
  }
  self.postMessage(responses);
};
