/// <reference lib="deno.worker" />

import { CpuCompiler } from "./compiler.ts";
import {
  decodeTransferredCompiledModule,
  encodeCompiledModuleForTransfer,
  type TransferCompiledModule,
} from "./compiled_module_transfer.ts";
import type { Diagnostic } from "./abi.ts";
import { decodeTransferredModule, type TransferEncodedModule } from "./module_transfer.ts";
import { compileModuleToWasm } from "./wasm_artifacts.ts";

export interface ParallelSourceCompileRequest {
  readonly mode: "core" | "wasm";
  readonly modules: readonly {
    readonly index: number;
    readonly module: TransferEncodedModule;
  }[];
}

export interface ParallelWasmEmitRequest {
  readonly mode: "compiled-wasm";
  readonly modules: readonly {
    readonly index: number;
    readonly module: TransferCompiledModule;
  }[];
}

export type ParallelCompileRequest =
  | ParallelSourceCompileRequest
  | ParallelWasmEmitRequest;

export type ParallelCompileWorkerResult =
  | {
    readonly index: number;
    readonly ok: true;
    readonly module: TransferCompiledModule;
  }
  | {
    readonly index: number;
    readonly ok: true;
    readonly wasm: Uint8Array<ArrayBuffer>;
  }
  | {
    readonly index: number;
    readonly ok: false;
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  };

export interface ParallelCompileResponse {
  readonly results: readonly ParallelCompileWorkerResult[];
}

const compiler = new CpuCompiler();

self.onmessage = async (event: MessageEvent<ParallelCompileRequest>) => {
  const request = event.data;
  if (request.mode === "compiled-wasm") {
    const results: ParallelCompileWorkerResult[] = [];
    const transferables: ArrayBuffer[] = [];
    for (const { index, module: transferred } of request.modules) {
      const module = decodeTransferredCompiledModule(transferred);
      const wasm = await compileModuleToWasm(module);
      results.push({ index, ok: true, wasm });
      transferables.push(wasm.buffer);
    }
    self.postMessage({ results } satisfies ParallelCompileResponse, {
      transfer: transferables,
    });
    return;
  }
  const compilations = await compiler.compileBatch(
    request.modules.map(({ module }) => decodeTransferredModule(module)),
  );
  const results: ParallelCompileWorkerResult[] = [];
  const transferables: ArrayBuffer[] = [];
  for (const [batchIndex, compilation] of compilations.entries()) {
    const index = request.modules[batchIndex]?.index;
    if (index === undefined) {
      throw new Error(`parallel compiler worker omitted request ${batchIndex}`);
    }
    if (!compilation.ok) {
      results.push({ index, ok: false, diagnostics: compilation.diagnostics });
      continue;
    }
    if (request.mode === "core") {
      results.push({
        index,
        ok: true,
        module: await encodeCompiledModuleForTransfer(compilation.module),
      });
    } else {
      const wasm = await compileModuleToWasm(compilation.module);
      results.push({ index, ok: true, wasm });
      transferables.push(wasm.buffer);
    }
    compilation.module.destroy();
  }
  self.postMessage({ results } satisfies ParallelCompileResponse, {
    transfer: transferables,
  });
};
