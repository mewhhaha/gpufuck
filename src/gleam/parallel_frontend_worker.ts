/// <reference lib="deno.worker" />

/**
 * One worker of the parallel Gleam frontend. Parsing and lowering are pure functions of a source
 * string, so they parallelise across compilation units with no shared state — the only cost is
 * that each worker instantiates its own baba parser.
 *
 * @module
 */
import { lowerGleamSource } from "../../gleam.ts";
import {
  encodeModuleForTransfer,
  type TransferEncodedModule,
} from "../functional/module_transfer.ts";

interface LowerRequest {
  readonly id: number;
  readonly name: string;
  readonly source: string;
}

export interface LowerResponse {
  readonly id: number;
  readonly module?: TransferEncodedModule;
  readonly diagnostic?: string;
}

self.onmessage = (event: MessageEvent<readonly LowerRequest[]>) => {
  const responses: LowerResponse[] = [];
  for (const request of event.data) {
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
