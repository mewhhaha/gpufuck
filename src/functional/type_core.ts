import { GpuFunctionalCompiler, type GpuFunctionalModule } from "./compiler.ts";
import { GpuFunctionalEvaluator } from "./evaluator.ts";
import type {
  TypeCoreExecutionOptions,
  TypeCoreExecutionResult,
  TypeCoreProgram,
} from "./type_core_contract.ts";
import { lowerTypeCoreProgram } from "./type_core_lowering.ts";
import { decodeTypeCoreValue } from "./type_core_value_decoder.ts";
import { validateTypeCoreProgram } from "./type_core_validation.ts";

export class GpuTypeCoreExecutor {
  private constructor(
    private readonly compiler: GpuFunctionalCompiler,
    private readonly evaluator: GpuFunctionalEvaluator,
  ) {}

  static async create(device: GPUDevice): Promise<GpuTypeCoreExecutor> {
    const [compiler, evaluator] = await Promise.all([
      GpuFunctionalCompiler.create(device),
      GpuFunctionalEvaluator.create(device),
    ]);
    return new GpuTypeCoreExecutor(compiler, evaluator);
  }

  async execute(
    program: TypeCoreProgram,
    options: TypeCoreExecutionOptions = {},
  ): Promise<TypeCoreExecutionResult> {
    options.signal?.throwIfAborted();
    const lowered = lowerTypeCoreProgram(validateTypeCoreProgram(program));
    const compilation = await this.compiler.compileModule(lowered.module, {
      ...(options.maximumCompilationSteps === undefined
        ? {}
        : { maximumSteps: options.maximumCompilationSteps }),
      ...(options.maximumStepsPerDispatch === undefined
        ? {}
        : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!compilation.ok) {
      return { ok: false, stage: "compile", diagnostics: compilation.diagnostics };
    }

    try {
      const evaluation = await this.evaluator.evaluate(compilation.module, {
        resultForm: "deep",
        ...(options.maximumExecutionSteps === undefined
          ? {}
          : { maximumSteps: options.maximumExecutionSteps }),
        ...(options.maximumStepsPerDispatch === undefined
          ? {}
          : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
        ...(options.heapSlots === undefined ? {} : { heapSlots: options.heapSlots }),
        ...(options.stackFrames === undefined ? {} : { stackFrames: options.stackFrames }),
        ...(options.maximumResultNodes === undefined
          ? {}
          : { maximumResultNodes: options.maximumResultNodes }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      if (!evaluation.ok) {
        return {
          ok: false,
          stage: "execute",
          fault: evaluation.fault,
          stats: evaluation.stats,
        };
      }
      return {
        ok: true,
        value: decodeTypeCoreValue(
          evaluation.value,
          lowered.symbolValues,
          lowered.entryKind,
        ),
        stats: evaluation.stats,
      };
    } finally {
      compilation.module.destroy();
    }
  }

  async executeBatch(
    programs: readonly TypeCoreProgram[],
    options: TypeCoreExecutionOptions = {},
  ): Promise<readonly TypeCoreExecutionResult[]> {
    options.signal?.throwIfAborted();
    if (programs.length === 0) return [];
    if (programs.length === 1) return [await this.execute(programs[0]!, options)];

    const uniquePrograms: {
      readonly program: TypeCoreProgram;
      readonly resultIndices: number[];
    }[] = [];
    const uniqueProgramIndices = new Map<TypeCoreProgram, number>();
    for (const [resultIndex, program] of programs.entries()) {
      const uniqueProgramIndex = uniqueProgramIndices.get(program);
      if (uniqueProgramIndex === undefined) {
        uniqueProgramIndices.set(program, uniquePrograms.length);
        uniquePrograms.push({ program, resultIndices: [resultIndex] });
        continue;
      }
      uniquePrograms[uniqueProgramIndex]!.resultIndices.push(resultIndex);
    }

    const lowered = uniquePrograms.map(({ program }) =>
      lowerTypeCoreProgram(validateTypeCoreProgram(program))
    );
    const compilations = await this.compiler.compileBatch(
      lowered.map((program) => program.module),
      {
        ...(options.maximumCompilationSteps === undefined
          ? {}
          : { maximumSteps: options.maximumCompilationSteps }),
        ...(options.maximumStepsPerDispatch === undefined
          ? {}
          : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (compilations.length !== lowered.length) {
      for (const compilation of compilations) {
        if (compilation.ok) compilation.module.destroy();
      }
      throw new Error(
        `Type Core batch compiler returned ${compilations.length} results for ${lowered.length} programs`,
      );
    }

    const results: (TypeCoreExecutionResult | undefined)[] = new Array(programs.length);
    const successful: {
      readonly uniqueProgramIndex: number;
      readonly module: GpuFunctionalModule;
    }[] = [];
    for (const [uniqueProgramIndex, compilation] of compilations.entries()) {
      if (compilation === undefined) {
        for (const result of compilations) {
          if (result?.ok) result.module.destroy();
        }
        throw new Error(`Type Core batch compiler omitted result ${uniqueProgramIndex}`);
      }
      if (compilation.ok) {
        successful.push({ uniqueProgramIndex, module: compilation.module });
        continue;
      }
      const uniqueProgram = uniquePrograms[uniqueProgramIndex];
      if (uniqueProgram === undefined) {
        for (const result of compilations) {
          if (result.ok) result.module.destroy();
        }
        throw new Error(`Type Core batch omitted program ${uniqueProgramIndex}`);
      }
      for (const resultIndex of uniqueProgram.resultIndices) {
        results[resultIndex] = {
          ok: false,
          stage: "compile",
          diagnostics: compilation.diagnostics,
        };
      }
    }

    try {
      const evaluations = await this.evaluator.evaluateBatch(
        successful.map(({ module }) => module),
        {
          resultForm: "deep",
          ...(options.maximumExecutionSteps === undefined
            ? {}
            : { maximumSteps: options.maximumExecutionSteps }),
          ...(options.maximumStepsPerDispatch === undefined
            ? {}
            : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
          ...(options.heapSlots === undefined ? {} : { heapSlots: options.heapSlots }),
          ...(options.stackFrames === undefined ? {} : { stackFrames: options.stackFrames }),
          ...(options.maximumResultNodes === undefined
            ? {}
            : { maximumResultNodes: options.maximumResultNodes }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
      if (evaluations.length !== successful.length) {
        throw new Error(
          `Type Core batch evaluator returned ${evaluations.length} results for ${successful.length} modules`,
        );
      }
      for (const [successfulIndex, entry] of successful.entries()) {
        const evaluation = evaluations[successfulIndex];
        if (evaluation === undefined) {
          throw new Error(`Type Core batch evaluator omitted result ${successfulIndex}`);
        }
        const uniqueProgram = uniquePrograms[entry.uniqueProgramIndex];
        const program = lowered[entry.uniqueProgramIndex];
        if (uniqueProgram === undefined || program === undefined) {
          throw new Error(`Type Core batch lowering omitted program ${entry.uniqueProgramIndex}`);
        }
        if (!evaluation.ok) {
          for (const resultIndex of uniqueProgram.resultIndices) {
            results[resultIndex] = {
              ok: false,
              stage: "execute",
              fault: evaluation.fault,
              stats: evaluation.stats,
            };
          }
          continue;
        }
        for (const resultIndex of uniqueProgram.resultIndices) {
          results[resultIndex] = {
            ok: true,
            value: decodeTypeCoreValue(
              evaluation.value,
              program.symbolValues,
              program.entryKind,
            ),
            stats: evaluation.stats,
          };
        }
      }
      return results.map((result, resultIndex) => {
        if (result === undefined) throw new Error(`Type Core batch omitted result ${resultIndex}`);
        return result;
      });
    } finally {
      for (const { module } of successful) module.destroy();
    }
  }
}
