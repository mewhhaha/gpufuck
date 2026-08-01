import { CpuCompiler } from "./compiler.ts";
import {
  compiledModuleTransferables,
  decodeTransferredCompiledModule,
  encodeCompiledModuleForTransfer,
  type TransferCompiledModule,
} from "./compiled_module_transfer.ts";
import type { Diagnostic } from "./abi.ts";
import { decodeTransferredModule, type TransferEncodedModule } from "./module_transfer.ts";
import { compileWasmArtifact } from "./wasm_codegen.ts";

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

interface ParallelCompilerWorkerScope {
  onmessage: ((event: MessageEvent<ParallelCompileRequest>) => void | Promise<void>) | null;
  postMessage(
    response: ParallelCompileResponse,
    options: { readonly transfer: readonly ArrayBuffer[] },
  ): void;
}

const workerScope = globalThis as unknown as ParallelCompilerWorkerScope;
const compiler = new CpuCompiler();

workerScope.onmessage = async (event) => {
  const request = event.data;
  if (request.mode === "compiled-wasm") {
    const results: ParallelCompileWorkerResult[] = [];
    const transferables: ArrayBuffer[] = [];
    for (const { index, module: transferred } of request.modules) {
      const module = decodeTransferredCompiledModule(transferred);
      const wasm = compileWasmArtifact(module, await module.readCoreNodes()).bytes;
      results.push({ index, ok: true, wasm });
      transferables.push(wasm.buffer);
    }
    workerScope.postMessage({ results }, {
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
      const module = await encodeCompiledModuleForTransfer(compilation.module);
      results.push({
        index,
        ok: true,
        module,
      });
      transferables.push(...compiledModuleTransferables(module));
    } else {
      const wasm = compileWasmArtifact(
        compilation.module,
        await compilation.module.readCoreNodes(),
      ).bytes;
      results.push({ index, ok: true, wasm });
      transferables.push(wasm.buffer);
    }
    compilation.module.destroy();
  }
  workerScope.postMessage({ results }, {
    transfer: transferables,
  });
};
