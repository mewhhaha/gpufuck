import { GpuFunctionalCompiler } from "./compiler.ts";
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
}
