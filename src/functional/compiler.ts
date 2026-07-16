import type { EncodedLazuliSurface, LazuliDiagnostic } from "../lazuli/abi.ts";
import type { GpuLazuliModule } from "../lazuli/compiler_module.ts";
import {
  constructorLimitDiagnostic,
  definitionLimitDiagnostic,
  nodeLimitDiagnostic,
  typeLimitDiagnostic,
} from "../lazuli/compilation_diagnostics.ts";
import {
  GpuLazuliSemanticCompiler,
  type LazuliSemanticCompilationLimits,
} from "../lazuli/gpu_semantic_compiler.ts";
import {
  type EncodedFunctionalModule,
  FUNCTIONAL_CONSTRUCTOR_BYTE_LENGTH,
  FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
  FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES,
  FUNCTIONAL_DEFINITION_BYTE_LENGTH,
  FUNCTIONAL_DEFINITION_WORD_LENGTH,
  FUNCTIONAL_MAXIMUM_EXPRESSION_NODES,
  FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH,
  FUNCTIONAL_MODULE_ABI_VERSION,
  FUNCTIONAL_NODE_BYTE_LENGTH,
  FUNCTIONAL_NODE_WORD_LENGTH,
  FUNCTIONAL_TYPE_BYTE_LENGTH,
  FUNCTIONAL_TYPE_WORD_LENGTH,
  FunctionalDefinitionWord,
  type FunctionalDiagnostic,
  type FunctionalDiagnosticCode,
  FunctionalEvaluationProfile,
  FunctionalTypecheckingProfile,
  type FunctionalTypeSchema,
} from "./abi.ts";
import { CompilationAdmissionQueue } from "./compilation_admission.ts";
import type { FunctionalEffectCoreModule } from "./effect_core_contract.ts";
import { GpuFunctionalEffectCoreVerifier } from "./effect_core.ts";
import { normalizeFunctionalHostCapabilities } from "./host_contract.ts";
import { buildFunctionalSurfaceModule } from "./surface_builder.ts";
import type {
  FunctionalCompilationOptions,
  FunctionalCompileResult,
  GpuFunctionalModule,
} from "./compiler_module.ts";

export type {
  FunctionalCompilationOptions,
  FunctionalCompileResult,
  FunctionalCoreNode,
  GpuFunctionalModule,
} from "./compiler_module.ts";

const DEFAULT_MAXIMUM_COMPILATION_STEPS = 1_000_000;
const HARD_MAXIMUM_COMPILATION_STEPS = 10_000_000;
const DEFAULT_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH = 65_536;
const DEFAULT_CANCELLABLE_COMPILATION_STEPS_PER_DISPATCH = 16_384;
const HARD_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH = 65_536;
// One source byte upper-bounds one schema or type-parameter record. Six KiB covers its
// semantic storage, inference metadata/workspace/output/readback, and one workspace growth.
const COMPILATION_TRANSIENT_BYTES_PER_INPUT = 6_144;
const COMPILATION_FIXED_TRANSIENT_BYTE_LENGTH = 16_384;

export class GpuFunctionalCompiler {
  readonly #semanticCompiler: GpuLazuliSemanticCompiler;
  readonly #effectVerifier: GpuFunctionalEffectCoreVerifier;
  readonly #compilationAdmission: CompilationAdmissionQueue;
  readonly #maximumNodeCount: number;
  readonly #maximumDefinitionCount: number;
  readonly #maximumTypeCount: number;
  readonly #maximumConstructorCount: number;

  private constructor(
    semanticCompiler: GpuLazuliSemanticCompiler,
    effectVerifier: GpuFunctionalEffectCoreVerifier,
    maximumNodeCount: number,
    maximumDefinitionCount: number,
    maximumTypeCount: number,
    maximumConstructorCount: number,
    maximumConcurrentCompilationWeight: number,
  ) {
    this.#semanticCompiler = semanticCompiler;
    this.#effectVerifier = effectVerifier;
    this.#compilationAdmission = new CompilationAdmissionQueue(
      maximumConcurrentCompilationWeight,
    );
    this.#maximumNodeCount = maximumNodeCount;
    this.#maximumDefinitionCount = maximumDefinitionCount;
    this.#maximumTypeCount = maximumTypeCount;
    this.#maximumConstructorCount = maximumConstructorCount;
  }

  static async create(device: GPUDevice): Promise<GpuFunctionalCompiler> {
    const maximumNodeCount = Math.min(
      FUNCTIONAL_MAXIMUM_EXPRESSION_NODES,
      Math.floor(device.limits.maxStorageBufferBindingSize / FUNCTIONAL_NODE_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / FUNCTIONAL_NODE_BYTE_LENGTH),
    );
    const maximumDefinitionCount = Math.min(
      maximumNodeCount,
      Math.floor(device.limits.maxStorageBufferBindingSize / FUNCTIONAL_DEFINITION_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / FUNCTIONAL_DEFINITION_BYTE_LENGTH),
    );
    const maximumTypeCount = Math.min(
      Math.floor(device.limits.maxStorageBufferBindingSize / FUNCTIONAL_TYPE_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / FUNCTIONAL_TYPE_BYTE_LENGTH),
    );
    const maximumConstructorCount = Math.min(
      Math.floor(device.limits.maxStorageBufferBindingSize / FUNCTIONAL_CONSTRUCTOR_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / FUNCTIONAL_CONSTRUCTOR_BYTE_LENGTH),
    );
    const maximumConcurrentCompilationWeight = Math.min(
      device.limits.maxBufferSize,
      device.limits.maxStorageBufferBindingSize,
    );

    if (
      maximumNodeCount === 0 || maximumDefinitionCount === 0 || maximumTypeCount === 0 ||
      maximumConstructorCount === 0
    ) {
      throw new Error(
        "WebGPU device limits cannot store functional module ABI records: " +
          `maxStorageBufferBindingSize=${device.limits.maxStorageBufferBindingSize}, ` +
          `maxBufferSize=${device.limits.maxBufferSize}`,
      );
    }

    const [semanticCompiler, effectVerifier] = await Promise.all([
      GpuLazuliSemanticCompiler.create(device),
      GpuFunctionalEffectCoreVerifier.create(device),
    ]);
    return new GpuFunctionalCompiler(
      semanticCompiler,
      effectVerifier,
      maximumNodeCount,
      maximumDefinitionCount,
      maximumTypeCount,
      maximumConstructorCount,
      maximumConcurrentCompilationWeight,
    );
  }

  async compileEffectModule(
    effectModule: FunctionalEffectCoreModule,
    options: FunctionalCompilationOptions = {},
  ): Promise<FunctionalCompileResult> {
    const limits = compilationLimits(options);
    options.signal?.throwIfAborted();
    if (!Number.isSafeInteger(effectModule.sourceByteLength) || effectModule.sourceByteLength < 0) {
      throw new Error(
        `functional effect module has invalid source byte length ${effectModule.sourceByteLength}`,
      );
    }
    if (effectModule.sourceByteLength > FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH) {
      return failedLimit(
        `module spans ${effectModule.sourceByteLength} UTF-8 source bytes; this compiler accepts at most ${FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH}`,
        FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH,
        effectModule.sourceByteLength,
      );
    }
    const effect = await this.#effectVerifier.verifyAndLower(effectModule, {
      maximumTransitions: limits.maximumSteps,
      maximumTransitionsPerDispatch: limits.maximumStepsPerDispatch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!effect.ok) return { ok: false, diagnostics: [effect.diagnostic] };
    const remainingSteps = limits.maximumSteps - effect.transitions;
    if (remainingSteps < 1) {
      return failedLimit(
        `Functional Effect Core used all ${limits.maximumSteps} compiler transitions before semantic inference`,
        0,
        effectModule.sourceByteLength,
      );
    }
    const encoded = buildFunctionalSurfaceModule(
      effect.lowered.definitions,
      effect.lowered.typeDeclarations,
      effect.lowered.entryName,
      effect.lowered.sourceByteLength,
      { hostCapabilities: effect.lowered.hostCapabilities },
    );
    const compilation = await this.compileModule(encoded, {
      maximumSteps: remainingSteps,
      maximumStepsPerDispatch: limits.maximumStepsPerDispatch,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!compilation.ok) return compilation;
    return {
      ok: true,
      module: {
        ...compilation.module,
        entryEffects: effect.lowered.computationType.effects,
      },
    };
  }

  async compileModule(
    module: EncodedFunctionalModule,
    options: FunctionalCompilationOptions = {},
  ): Promise<FunctionalCompileResult> {
    const limits = compilationLimits(options);
    options.signal?.throwIfAborted();
    validateEncodedModule(module);

    if (module.sourceByteLength > FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH) {
      return failedLimit(
        `module spans ${module.sourceByteLength} UTF-8 source bytes; this compiler accepts at most ${FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH}`,
        FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH,
        module.sourceByteLength,
      );
    }
    if (module.nodeCount > this.#maximumNodeCount) {
      return functionalFailure(nodeLimitDiagnostic(module.nodeCount, this.#maximumNodeCount));
    }
    if (module.definitionCount > this.#maximumDefinitionCount) {
      return functionalFailure(
        definitionLimitDiagnostic(module.definitionCount, this.#maximumDefinitionCount),
      );
    }
    if (module.typeCount > this.#maximumTypeCount) {
      return functionalFailure(typeLimitDiagnostic(module.typeCount, this.#maximumTypeCount));
    }
    if (module.constructorCount > this.#maximumConstructorCount) {
      return functionalFailure(
        constructorLimitDiagnostic(module.constructorCount, this.#maximumConstructorCount),
      );
    }

    const estimatedTransientByteLength = COMPILATION_FIXED_TRANSIENT_BYTE_LENGTH +
      COMPILATION_TRANSIENT_BYTES_PER_INPUT *
        (module.sourceByteLength + module.nodeCount + module.definitionCount + module.typeCount +
          module.constructorCount);
    const semanticSurface = semanticSurfaceFromModule(module);

    return await this.#compilationAdmission.admit(
      async () => {
        options.signal?.throwIfAborted();
        const result = await this.#semanticCompiler.compile(
          semanticSurface,
          module.sourceByteLength,
          limits,
          options.signal,
        );
        try {
          options.signal?.throwIfAborted();
        } catch (error) {
          if (result.ok) result.module.destroy();
          throw error;
        }
        if (!result.ok) {
          return {
            ok: false,
            diagnostics: result.diagnostics.map(functionalDiagnostic) as [
              FunctionalDiagnostic,
              ...FunctionalDiagnostic[],
            ],
          };
        }
        return { ok: true, module: functionalModule(result.module, module) };
      },
      estimatedTransientByteLength,
      options.signal,
    );
  }

  async compileBatch(
    modules: readonly EncodedFunctionalModule[],
    options: FunctionalCompilationOptions = {},
  ): Promise<readonly FunctionalCompileResult[]> {
    const limits = compilationLimits(options);
    options.signal?.throwIfAborted();
    if (modules.length === 0) return [];
    if (modules.length === 1) return [await this.compileModule(modules[0]!, options)];

    const results: (FunctionalCompileResult | undefined)[] = new Array(modules.length);
    const accepted: { readonly resultIndex: number; readonly module: EncodedFunctionalModule }[] =
      [];
    let estimatedTransientByteLength = 0;
    for (const [resultIndex, module] of modules.entries()) {
      validateEncodedModule(module);
      if (module.sourceByteLength > FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH) {
        results[resultIndex] = failedLimit(
          `module spans ${module.sourceByteLength} UTF-8 source bytes; this compiler accepts at most ${FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH}`,
          FUNCTIONAL_MAXIMUM_SOURCE_BYTE_LENGTH,
          module.sourceByteLength,
        );
        continue;
      }
      if (module.nodeCount > this.#maximumNodeCount) {
        results[resultIndex] = functionalFailure(
          nodeLimitDiagnostic(module.nodeCount, this.#maximumNodeCount),
        );
        continue;
      }
      if (module.definitionCount > this.#maximumDefinitionCount) {
        results[resultIndex] = functionalFailure(
          definitionLimitDiagnostic(module.definitionCount, this.#maximumDefinitionCount),
        );
        continue;
      }
      if (module.typeCount > this.#maximumTypeCount) {
        results[resultIndex] = functionalFailure(
          typeLimitDiagnostic(module.typeCount, this.#maximumTypeCount),
        );
        continue;
      }
      if (module.constructorCount > this.#maximumConstructorCount) {
        results[resultIndex] = functionalFailure(
          constructorLimitDiagnostic(module.constructorCount, this.#maximumConstructorCount),
        );
        continue;
      }
      accepted.push({ resultIndex, module });
      estimatedTransientByteLength += COMPILATION_FIXED_TRANSIENT_BYTE_LENGTH +
        COMPILATION_TRANSIENT_BYTES_PER_INPUT *
          (module.sourceByteLength + module.nodeCount + module.definitionCount +
            module.typeCount + module.constructorCount);
    }
    if (accepted.length === 0) return completedBatchResults(results);

    const compiled = await this.#compilationAdmission.admit(
      async () => {
        options.signal?.throwIfAborted();
        return await this.#semanticCompiler.compileBatch(
          accepted.map(({ module }) => ({
            surface: semanticSurfaceFromModule(module),
            sourceByteLength: module.sourceByteLength,
            ...limits,
          })),
          options.signal,
        );
      },
      estimatedTransientByteLength,
      options.signal,
    );
    try {
      options.signal?.throwIfAborted();
    } catch (error) {
      for (const result of compiled) if (result.ok) result.module.destroy();
      throw error;
    }
    if (compiled.length !== accepted.length) {
      for (const result of compiled) if (result.ok) result.module.destroy();
      throw new Error(
        `functional batch compiler returned ${compiled.length} results for ${accepted.length} modules`,
      );
    }
    try {
      for (const [acceptedIndex, entry] of accepted.entries()) {
        const result = compiled[acceptedIndex];
        if (result === undefined) {
          throw new Error(`functional batch compiler omitted accepted module ${acceptedIndex}`);
        }
        results[entry.resultIndex] = result.ok
          ? { ok: true, module: functionalModule(result.module, entry.module) }
          : {
            ok: false,
            diagnostics: result.diagnostics.map(functionalDiagnostic) as [
              FunctionalDiagnostic,
              ...FunctionalDiagnostic[],
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
  results: readonly (FunctionalCompileResult | undefined)[],
): readonly FunctionalCompileResult[] {
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`functional batch compiler omitted result ${index}`);
    return result;
  });
}

function functionalModule(
  module: GpuLazuliModule,
  encodedModule: EncodedFunctionalModule,
): GpuFunctionalModule {
  const definitionRoots = Array.from(
    { length: encodedModule.definitionCount },
    (_, definitionIndex) =>
      encodedModule.definitionWords[
        definitionIndex * FUNCTIONAL_DEFINITION_WORD_LENGTH + FunctionalDefinitionWord.RootNode
      ]!,
  );
  return {
    ...module,
    definitionRoots: Object.freeze(definitionRoots),
    hostCapabilities: normalizeFunctionalHostCapabilities(encodedModule.hostCapabilities),
    entryType: module.mainType,
    entryEffects: Object.freeze([]),
    readCoreNodes: async () => await module.readCoreNodes(),
    destroy: () => module.destroy(),
  };
}

export function validateFunctionalCompilationOptions(
  options: FunctionalCompilationOptions,
): void {
  compilationLimits(options);
}

function compilationLimits(
  options: FunctionalCompilationOptions,
): LazuliSemanticCompilationLimits {
  return {
    maximumSteps: boundedCompilationOption(
      "maximumSteps",
      options.maximumSteps,
      DEFAULT_MAXIMUM_COMPILATION_STEPS,
      HARD_MAXIMUM_COMPILATION_STEPS,
    ),
    maximumStepsPerDispatch: boundedCompilationOption(
      "maximumStepsPerDispatch",
      options.maximumStepsPerDispatch,
      options.signal === undefined
        ? DEFAULT_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH
        : DEFAULT_CANCELLABLE_COMPILATION_STEPS_PER_DISPATCH,
      HARD_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH,
    ),
  };
}

function boundedCompilationOption(
  name: string,
  value: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const resolved = value ?? defaultValue;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    throw new RangeError(
      `${name} must be an integer from 1 through ${maximum}; received ${resolved}`,
    );
  }
  return resolved;
}

function validateEncodedModule(module: EncodedFunctionalModule): void {
  if (module.abiVersion !== FUNCTIONAL_MODULE_ABI_VERSION) {
    throw new Error(
      `functional module ABI version ${module.abiVersion} is unsupported; expected ${FUNCTIONAL_MODULE_ABI_VERSION}`,
    );
  }
  if (!Number.isSafeInteger(module.sourceByteLength) || module.sourceByteLength < 0) {
    throw new Error(
      `functional module has invalid source byte length ${module.sourceByteLength}`,
    );
  }
  if (module.evaluationProfile !== FunctionalEvaluationProfile.LazyCallByNeed) {
    throw new Error(
      `functional module evaluation profile ${
        JSON.stringify(module.evaluationProfile)
      } is unsupported; expected ${JSON.stringify(FunctionalEvaluationProfile.LazyCallByNeed)}`,
    );
  }
  if (
    module.typecheckingProfile !== FunctionalTypecheckingProfile.HindleyMilnerIndexed &&
    module.typecheckingProfile !== FunctionalTypecheckingProfile.PredicativeRankNIndexed
  ) {
    throw new Error(
      `functional module typechecking profile ${
        JSON.stringify(module.typecheckingProfile)
      } is unsupported; expected ${
        JSON.stringify(FunctionalTypecheckingProfile.HindleyMilnerIndexed)
      } or ${JSON.stringify(FunctionalTypecheckingProfile.PredicativeRankNIndexed)}`,
    );
  }
  const declaresHigherRankTypes =
    module.definitionTypes.some((definition) =>
      definition.annotation !== null && schemaContainsForall(definition.annotation)
    ) || module.typeDeclarations.some((declaration) =>
      declaration.constructors.some((constructor) =>
        constructor.fields.some((field) =>
          schemaContainsForall(field.type)
        ) ||
        constructor.result !== undefined && schemaContainsForall(constructor.result)
      )
    );
  if (
    declaresHigherRankTypes !==
      (module.typecheckingProfile === FunctionalTypecheckingProfile.PredicativeRankNIndexed)
  ) {
    throw new Error(
      `functional module typechecking profile ${
        JSON.stringify(module.typecheckingProfile)
      } does not match higher-rank schema presence ${declaresHigherRankTypes}`,
    );
  }
  validatePrimitiveCapabilities(module.primitiveCapabilities);
  normalizeFunctionalHostCapabilities(module.hostCapabilities);
  validateRecordTable("node", module.nodeWords, module.nodeCount, FUNCTIONAL_NODE_WORD_LENGTH);
  validateRecordTable(
    "definition",
    module.definitionWords,
    module.definitionCount,
    FUNCTIONAL_DEFINITION_WORD_LENGTH,
  );
  validateRecordTable("type", module.typeWords, module.typeCount, FUNCTIONAL_TYPE_WORD_LENGTH);
  validateRecordTable(
    "constructor",
    module.constructorWords,
    module.constructorCount,
    FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
  );
  if (!Number.isSafeInteger(module.entrySymbol) || module.entrySymbol < 0) {
    throw new Error(`functional module has invalid entry symbol ${module.entrySymbol}`);
  }
  if (module.entrySymbol >= module.symbolNames.length) {
    throw new Error(
      `functional module entry symbol ${module.entrySymbol} is outside ${module.symbolNames.length} symbols`,
    );
  }
  for (const [symbol, name] of module.symbolNames.entries()) {
    if (typeof name !== "string") {
      throw new Error(`functional module symbol ${symbol} is not a string; received ${name}`);
    }
  }
  if (module.definitionTypes.length !== module.definitionCount) {
    throw new Error(
      `functional module has ${module.definitionTypes.length} definition type records for ${module.definitionCount} definitions`,
    );
  }
  if (module.typeDeclarations.length !== module.typeCount) {
    throw new Error(
      `functional module has ${module.typeDeclarations.length} type declarations for ${module.typeCount} type records`,
    );
  }
}

function schemaContainsForall(schema: FunctionalTypeSchema): boolean {
  switch (schema.kind) {
    case "forall":
      return true;
    case "tuple":
      return schemaContainsForall(schema.values[0]) || schemaContainsForall(schema.values[1]);
    case "named":
      return schema.arguments.some(schemaContainsForall);
    case "function":
      return schemaContainsForall(schema.parameter) || schemaContainsForall(schema.result);
    case "integer":
    case "boolean":
    case "unit":
    case "parameter":
      return false;
  }
}

function validatePrimitiveCapabilities(capabilities: readonly string[]): void {
  if (!Array.isArray(capabilities)) {
    throw new Error("functional module primitive capabilities must be an array");
  }
  const received = new Set<string>();
  for (const capability of capabilities) {
    if (typeof capability !== "string") {
      throw new Error(
        `functional module primitive capability must be a string; received ${capability}`,
      );
    }
    if (received.has(capability)) {
      throw new Error(
        `functional module repeats primitive capability ${JSON.stringify(capability)}`,
      );
    }
    received.add(capability);
  }
  const expected = new Set<string>(FUNCTIONAL_CORE_V1_PRIMITIVE_CAPABILITIES);
  const unsupported = [...received].filter((capability) => !expected.has(capability));
  const missing = [...expected].filter((capability) => !received.has(capability));
  if (unsupported.length === 0 && missing.length === 0) return;
  throw new Error(
    `functional module primitive capabilities do not match the supported core profile: ` +
      `unsupported=${JSON.stringify(unsupported)}, missing=${JSON.stringify(missing)}`,
  );
}

function validateRecordTable(
  recordName: string,
  words: Uint32Array,
  count: number,
  recordWordLength: number,
): void {
  if (!(words instanceof Uint32Array)) {
    throw new Error(`functional module ${recordName} words must be a Uint32Array`);
  }
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`functional module has invalid ${recordName} count ${count}`);
  }
  const expectedWordLength = count * recordWordLength;
  if (!Number.isSafeInteger(expectedWordLength)) {
    throw new Error(
      `functional module ${recordName} count ${count} exceeds the host word-length range`,
    );
  }
  if (words.length !== expectedWordLength) {
    throw new Error(
      `functional module has ${words.length} ${recordName} words for ${count} records; expected ${expectedWordLength}`,
    );
  }
}

export function semanticSurfaceFromModule(module: EncodedFunctionalModule): EncodedLazuliSurface {
  return {
    nodeWords: module.nodeWords,
    definitionWords: module.definitionWords,
    typeWords: module.typeWords,
    constructorWords: module.constructorWords,
    nodeCount: module.nodeCount,
    definitionCount: module.definitionCount,
    typeCount: module.typeCount,
    constructorCount: module.constructorCount,
    mainSymbol: module.entrySymbol,
    symbolNames: module.symbolNames,
    definitionTypes: module.definitionTypes,
    typeDeclarations: module.typeDeclarations,
  };
}

function failedLimit(
  message: string,
  startByte: number,
  endByte: number,
): FunctionalCompileResult {
  return {
    ok: false,
    diagnostics: [{
      stage: "compile",
      code: "F1003",
      message,
      span: { startByte, endByte },
    }],
  };
}

function functionalFailure(diagnostic: LazuliDiagnostic): FunctionalCompileResult {
  return { ok: false, diagnostics: [functionalDiagnostic(diagnostic)] };
}

function functionalDiagnostic(diagnostic: LazuliDiagnostic): FunctionalDiagnostic {
  return {
    stage: "compile",
    code: `F${diagnostic.code.slice(1)}` as FunctionalDiagnosticCode,
    message: diagnostic.message,
    span: diagnostic.span,
  };
}
