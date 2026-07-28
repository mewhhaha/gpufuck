import type {
  GpuFrontendTimings,
  WebGpuFrontend,
  WebGpuRuntime,
} from "@mewhhaha/baba/runtime/webgpu";

import { validateCompilationOptions } from "../functional/compiler.ts";
import { MAXIMUM_SOURCE_BYTE_LENGTH } from "../semantic/abi.ts";
import { sourceTooLargeDiagnostic } from "../semantic/compilation_diagnostics.ts";
import type {
  SemanticCompilationOptions,
  SemanticCompileResult,
} from "../semantic/compiler_module.ts";
import { GpuLazuliCompiler } from "./compiler.ts";
import { lowerLazuliGpuFrontendResult } from "./frontend.ts";

export interface BabaGpuLazuliCompilation {
  readonly result: SemanticCompileResult;
  readonly frontendTimings: GpuFrontendTimings | null;
}

export class BabaGpuLazuliCompiler {
  private constructor(
    readonly frontend: WebGpuFrontend,
    private readonly compiler: GpuLazuliCompiler,
  ) {}

  static async create(
    runtime: WebGpuRuntime,
    planBytes: Uint8Array,
  ): Promise<BabaGpuLazuliCompiler> {
    const [frontend, compiler] = await Promise.all([
      runtime.compileFrontend(planBytes),
      GpuLazuliCompiler.create(runtime.device),
    ]);
    return new BabaGpuLazuliCompiler(frontend, compiler);
  }

  async compile(
    source: string,
    options: SemanticCompilationOptions = {},
  ): Promise<BabaGpuLazuliCompilation> {
    validateCompilationOptions(options);
    options.signal?.throwIfAborted();
    let sourceByteLength = 0;
    for (let index = 0; index < source.length; index += 1) {
      const codePoint = source.codePointAt(index)!;
      sourceByteLength += codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
        ? 2
        : codePoint <= 0xffff
        ? 3
        : 4;
      if (codePoint > 0xffff) index += 1;
    }
    if (sourceByteLength > MAXIMUM_SOURCE_BYTE_LENGTH) {
      return {
        result: {
          ok: false,
          diagnostics: [
            sourceTooLargeDiagnostic(sourceByteLength, MAXIMUM_SOURCE_BYTE_LENGTH),
          ],
        },
        frontendTimings: null,
      };
    }
    const ingested = await this.frontend.ingest(source);
    const parsed = lowerLazuliGpuFrontendResult(source, ingested, this.frontend.plan);
    return {
      result: await this.compiler.compileParsedSource(parsed, options),
      frontendTimings: ingested.timings,
    };
  }
}
