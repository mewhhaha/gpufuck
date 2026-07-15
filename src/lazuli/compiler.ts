import { LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH } from "./abi.ts";
import { sourceTooLargeDiagnostic } from "./compilation_diagnostics.ts";
import type {
  GpuLazuliModule,
  LazuliCompilationOptions,
  LazuliCompileResult,
} from "./compiler_module.ts";
import { parseLazuliSource } from "./frontend.ts";
import {
  lazuliDiagnosticFromFunctional,
  lazuliSurfaceToFunctionalModule,
} from "./functional_adapter.ts";
import {
  GpuFunctionalCompiler,
  validateFunctionalCompilationOptions,
} from "../functional/compiler.ts";

export type {
  GpuLazuliModule,
  LazuliCompilationOptions,
  LazuliCompileResult,
  LazuliCoreNode,
} from "./compiler_module.ts";

export class GpuLazuliCompiler {
  readonly #compiler: GpuFunctionalCompiler;

  private constructor(compiler: GpuFunctionalCompiler) {
    this.#compiler = compiler;
  }

  static async create(device: GPUDevice): Promise<GpuLazuliCompiler> {
    return new GpuLazuliCompiler(await GpuFunctionalCompiler.create(device));
  }

  async compile(
    source: string,
    options: LazuliCompilationOptions = {},
  ): Promise<LazuliCompileResult> {
    validateFunctionalCompilationOptions(options);
    options.signal?.throwIfAborted();
    const sourceByteLength = new TextEncoder().encode(source).byteLength;
    if (sourceByteLength > LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH) {
      return {
        ok: false,
        diagnostics: [
          sourceTooLargeDiagnostic(sourceByteLength, LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH),
        ],
      };
    }

    const frontend = parseLazuliSource(source);
    if (!frontend.ok) return frontend;
    const result = await this.#compiler.compileModule(
      lazuliSurfaceToFunctionalModule(frontend.surface, sourceByteLength),
      options,
    );
    if (result.ok) {
      return { ok: true, module: result.module as unknown as GpuLazuliModule };
    }
    return {
      ok: false,
      diagnostics: result.diagnostics.map(lazuliDiagnosticFromFunctional) as [
        ReturnType<typeof lazuliDiagnosticFromFunctional>,
        ...ReturnType<typeof lazuliDiagnosticFromFunctional>[],
      ],
    };
  }
}
