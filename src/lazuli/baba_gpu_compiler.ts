import type {
  GpuFrontendTimings,
  WebGpuFrontend,
  WebGpuRuntime,
} from "@mewhhaha/baba/runtime/webgpu";

import type {
  SemanticCompilationOptions,
  SemanticCompileResult,
} from "../semantic/compiler_module.ts";
import { GpuLazuliCompiler } from "./compiler.ts";
import { lowerLazuliGpuFrontendResult } from "./frontend.ts";

export interface BabaGpuLazuliCompilation {
  readonly result: SemanticCompileResult;
  readonly frontendTimings: GpuFrontendTimings;
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
    const ingested = await this.frontend.ingest(source);
    const parsed = lowerLazuliGpuFrontendResult(source, ingested, this.frontend.plan);
    return {
      result: await this.compiler.compileParsedSource(parsed, options),
      frontendTimings: ingested.timings,
    };
  }
}
