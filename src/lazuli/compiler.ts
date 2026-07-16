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

  async compileBatch(
    sources: readonly string[],
    options: LazuliCompilationOptions = {},
  ): Promise<readonly LazuliCompileResult[]> {
    validateFunctionalCompilationOptions(options);
    options.signal?.throwIfAborted();
    if (sources.length === 0) return [];
    if (sources.length === 1) return [await this.compile(sources[0]!, options)];

    const encoder = new TextEncoder();
    const results: (LazuliCompileResult | undefined)[] = new Array(sources.length);
    const accepted: {
      readonly resultIndex: number;
      readonly module: ReturnType<typeof lazuliSurfaceToFunctionalModule>;
    }[] = [];
    for (const [resultIndex, source] of sources.entries()) {
      const sourceByteLength = encoder.encode(source).byteLength;
      if (sourceByteLength > LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH) {
        results[resultIndex] = {
          ok: false,
          diagnostics: [
            sourceTooLargeDiagnostic(sourceByteLength, LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH),
          ],
        };
        continue;
      }
      const frontend = parseLazuliSource(source);
      if (!frontend.ok) {
        results[resultIndex] = frontend;
        continue;
      }
      accepted.push({
        resultIndex,
        module: lazuliSurfaceToFunctionalModule(frontend.surface, sourceByteLength),
      });
    }
    if (accepted.length === 0) return completedBatchResults(results);

    const compiled = await this.#compiler.compileBatch(
      accepted.map(({ module }) => module),
      options,
    );
    if (compiled.length !== accepted.length) {
      for (const result of compiled) if (result.ok) result.module.destroy();
      throw new Error(
        `Lazuli batch compiler returned ${compiled.length} results for ${accepted.length} sources`,
      );
    }
    try {
      for (const [acceptedIndex, entry] of accepted.entries()) {
        const result = compiled[acceptedIndex];
        if (result === undefined) {
          throw new Error(`Lazuli batch compiler omitted accepted source ${acceptedIndex}`);
        }
        results[entry.resultIndex] = result.ok
          ? { ok: true, module: result.module as unknown as GpuLazuliModule }
          : {
            ok: false,
            diagnostics: result.diagnostics.map(lazuliDiagnosticFromFunctional) as [
              ReturnType<typeof lazuliDiagnosticFromFunctional>,
              ...ReturnType<typeof lazuliDiagnosticFromFunctional>[],
            ],
          };
      }
    } catch (error) {
      for (const result of compiled) if (result.ok) result.module.destroy();
      throw error;
    }
    return completedBatchResults(results);
  }
}

function completedBatchResults(
  results: readonly (LazuliCompileResult | undefined)[],
): readonly LazuliCompileResult[] {
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`Lazuli batch compiler omitted result ${index}`);
    return result;
  });
}
