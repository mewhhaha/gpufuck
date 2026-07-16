import { LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH } from "./abi.ts";
import { sourceTooLargeDiagnostic } from "./compilation_diagnostics.ts";
import type {
  GpuLazuliModule,
  LazuliCompilationOptions,
  LazuliCompileResult,
} from "./compiler_module.ts";
import { parseLazuliSourceForCompilation } from "./frontend.ts";
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

type PreparedLazuliSource =
  | { readonly ok: true; readonly module: ReturnType<typeof lazuliSurfaceToFunctionalModule> }
  | { readonly ok: false; readonly result: LazuliCompileResult };

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
    const parsed = parseLazuliSourceForCompilation(source);
    const sourceByteLength = parsed.sourceByteLength;
    if (sourceByteLength > LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH) {
      return {
        ok: false,
        diagnostics: [
          sourceTooLargeDiagnostic(sourceByteLength, LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH),
        ],
      };
    }

    const frontend = parsed.frontend;
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

    const results: (LazuliCompileResult | undefined)[] = new Array(sources.length);
    const accepted: {
      readonly resultIndex: number;
      readonly module: ReturnType<typeof lazuliSurfaceToFunctionalModule>;
    }[] = [];
    const preparedSources = new Map<string, PreparedLazuliSource>();
    for (const [resultIndex, source] of sources.entries()) {
      let prepared = preparedSources.get(source);
      if (prepared === undefined) {
        const parsed = parseLazuliSourceForCompilation(source);
        if (parsed.sourceByteLength > LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH) {
          prepared = {
            ok: false,
            result: {
              ok: false,
              diagnostics: [
                sourceTooLargeDiagnostic(
                  parsed.sourceByteLength,
                  LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH,
                ),
              ],
            },
          };
        } else if (!parsed.frontend.ok) {
          prepared = { ok: false, result: parsed.frontend };
        } else {
          prepared = {
            ok: true,
            module: lazuliSurfaceToFunctionalModule(
              parsed.frontend.surface,
              parsed.sourceByteLength,
            ),
          };
        }
        preparedSources.set(source, prepared);
      }
      if (!prepared.ok) {
        results[resultIndex] = prepared.result;
        continue;
      }
      accepted.push({
        resultIndex,
        module: prepared.module,
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
