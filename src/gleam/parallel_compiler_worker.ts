/// <reference lib="deno.worker" />

import { CpuCompiler } from "../functional/compiler.ts";
import type { Diagnostic } from "../functional/abi.ts";
import { compileWasmArtifact } from "../functional/wasm_codegen.ts";
import type { GleamDiagnostic } from "./diagnostic.ts";
import { lowerGleamSource } from "./frontend.ts";

export interface ParallelGleamCompileRequest {
  readonly units: readonly {
    readonly index: number;
    readonly name: string;
    readonly source: string;
  }[];
}

export type ParallelGleamCompileWorkerResult =
  | {
    readonly index: number;
    readonly ok: true;
    readonly bytes: Uint8Array<ArrayBuffer>;
  }
  | {
    readonly index: number;
    readonly ok: false;
    readonly diagnostics: readonly (GleamDiagnostic | Diagnostic)[];
  };

export interface ParallelGleamCompileResponse {
  readonly results: readonly ParallelGleamCompileWorkerResult[];
}

const compiler = new CpuCompiler();

self.onmessage = async (event: MessageEvent<ParallelGleamCompileRequest>) => {
  const results: ParallelGleamCompileWorkerResult[] = [];
  const transferables: ArrayBuffer[] = [];
  for (const unit of event.data.units) {
    const frontend = lowerGleamSource(unit.name, unit.source);
    if (!frontend.ok) {
      results.push({ index: unit.index, ok: false, diagnostics: frontend.diagnostics });
      continue;
    }
    const compilation = await compiler.compileModule(frontend.lowered.module);
    if (!compilation.ok) {
      results.push({ index: unit.index, ok: false, diagnostics: compilation.diagnostics });
      continue;
    }
    try {
      const bytes = compileWasmArtifact(
        compilation.module,
        await compilation.module.readCoreNodes(),
      ).bytes;
      results.push({ index: unit.index, ok: true, bytes });
      transferables.push(bytes.buffer);
    } finally {
      compilation.module.destroy();
    }
  }
  self.postMessage({ results } satisfies ParallelGleamCompileResponse, {
    transfer: transferables,
  });
};
