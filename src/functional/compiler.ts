import type { EncodedLazuliSurface, LazuliDiagnostic } from "../lazuli/abi.ts";
import { CompiledGpuLazuliModule, type GpuLazuliModule } from "../lazuli/compiler_module.ts";
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
import { publicTypeMetadata } from "../lazuli/gpu_type_inference_results.ts";
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
  FunctionalExpressionTag,
  FunctionalNodeWord,
  FunctionalTypecheckingProfile,
  type FunctionalTypeSchema,
} from "./abi.ts";
import { CompilationAdmissionQueue } from "./compilation_admission.ts";
import {
  encodeFunctionalCoreArtifact,
  type FunctionalCompiledCoreArtifact,
} from "./core_artifact.ts";
import type { FunctionalEffectCoreModule } from "./effect_core_contract.ts";
import { GpuFunctionalEffectCoreVerifier } from "./effect_core.ts";
import { normalizeFunctionalHostCapabilities } from "./host_contract.ts";
import { functionalBytesFromLiteralSymbol } from "./static_literals.ts";
import { buildFunctionalSurfaceModule } from "./surface_builder.ts";
import type {
  FunctionalCompilationOptions,
  FunctionalCompileResult,
  GpuFunctionalModule,
} from "./compiler_module.ts";
import { concreteFunctionalType } from "./wasm_value_codec.ts";

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
  readonly #device: GPUDevice;
  readonly #semanticCompiler: GpuLazuliSemanticCompiler;
  #effectVerifier: Promise<GpuFunctionalEffectCoreVerifier> | undefined;
  readonly #compilationAdmission: CompilationAdmissionQueue;
  readonly #maximumNodeCount: number;
  readonly #maximumDefinitionCount: number;
  readonly #maximumTypeCount: number;
  readonly #maximumConstructorCount: number;

  private constructor(
    device: GPUDevice,
    semanticCompiler: GpuLazuliSemanticCompiler,
    maximumNodeCount: number,
    maximumDefinitionCount: number,
    maximumTypeCount: number,
    maximumConstructorCount: number,
    maximumConcurrentCompilationWeight: number,
  ) {
    this.#device = device;
    this.#semanticCompiler = semanticCompiler;
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

    const semanticCompiler = await GpuLazuliSemanticCompiler.create(device);
    return new GpuFunctionalCompiler(
      device,
      semanticCompiler,
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
    const evaluationProfile = effectModule.evaluationProfile ??
      FunctionalEvaluationProfile.LazyCallByNeed;
    requireFunctionalEvaluationProfile(evaluationProfile, "Functional Effect Core module");
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
    this.#effectVerifier ??= GpuFunctionalEffectCoreVerifier.create(this.#device);
    const effectVerifier = await this.#effectVerifier;
    const effect = await effectVerifier.verifyAndLower(effectModule, {
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
      {
        hostCapabilities: effect.lowered.hostCapabilities,
        evaluationProfile,
      },
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
    const results = await this.compileBatch([module], options);
    const result = results[0];
    if (result === undefined) {
      throw new Error("functional scalar compiler omitted its only result");
    }
    return result;
  }

  async compileBatch(
    modules: readonly EncodedFunctionalModule[],
    options: FunctionalCompilationOptions = {},
  ): Promise<readonly FunctionalCompileResult[]> {
    const limits = compilationLimits(options);
    options.signal?.throwIfAborted();
    if (modules.length === 0) return [];

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

  async restoreCompiledCore(
    encodedModule: EncodedFunctionalModule,
    artifact: FunctionalCompiledCoreArtifact,
  ): Promise<GpuFunctionalModule> {
    validateEncodedModule(encodedModule);
    const coreNodeBytes = encodeFunctionalCoreArtifact(encodedModule, artifact);
    const surface = semanticSurfaceFromModule(encodedModule);
    const entryDefinition = findEntryDefinition(encodedModule);
    const buffers: GPUBuffer[] = [];
    this.#device.pushErrorScope("validation");
    this.#device.pushErrorScope("out-of-memory");
    let allocationCause: unknown;
    try {
      const nodeBuffer = createRestoredBuffer(
        this.#device,
        "Functional restored Core nodes",
        coreNodeBytes,
        FUNCTIONAL_NODE_BYTE_LENGTH,
      );
      buffers.push(nodeBuffer);
      const definitionBuffer = createRestoredBuffer(
        this.#device,
        "Functional restored definitions",
        encodedModule.definitionWords,
        FUNCTIONAL_DEFINITION_BYTE_LENGTH,
      );
      buffers.push(definitionBuffer);
      const constructorBuffer = createRestoredBuffer(
        this.#device,
        "Functional restored constructors",
        encodedModule.constructorWords,
        FUNCTIONAL_CONSTRUCTOR_BYTE_LENGTH,
      );
      buffers.push(constructorBuffer);
    } catch (cause) {
      allocationCause = cause;
    }
    const [outOfMemory, validation] = await Promise.all([
      this.#device.popErrorScope(),
      this.#device.popErrorScope(),
    ]);
    if (validation !== null || outOfMemory !== null || allocationCause !== undefined) {
      for (const buffer of buffers) buffer.destroy();
      const evidence = validation?.message ?? outOfMemory?.message ?? String(allocationCause);
      throw new Error(
        `could not restore functional compiled Core with ${encodedModule.nodeCount} nodes, ${encodedModule.definitionCount} definitions, and ${encodedModule.constructorCount} constructors: ${evidence}`,
        allocationCause === undefined ? undefined : { cause: allocationCause },
      );
    }
    const [nodeBuffer, definitionBuffer, constructorBuffer] = buffers;
    if (
      nodeBuffer === undefined || definitionBuffer === undefined || constructorBuffer === undefined
    ) {
      for (const buffer of buffers) buffer.destroy();
      throw new Error("functional compiled Core restoration omitted a module buffer");
    }
    const lazuliModule = new CompiledGpuLazuliModule(
      this.#device,
      nodeBuffer,
      definitionBuffer,
      constructorBuffer,
      surface,
      entryDefinition,
      artifact.entryType,
      publicTypeMetadata(surface).typeDeclarations,
      coreNodeBytes.slice(0, encodedModule.nodeCount * FUNCTIONAL_NODE_BYTE_LENGTH),
    );
    return functionalModule(lazuliModule, encodedModule);
  }
}

function createRestoredBuffer(
  device: GPUDevice,
  label: string,
  source: ArrayBuffer | Uint32Array,
  minimumByteLength: number,
): GPUBuffer {
  const sourceBytes = source instanceof Uint32Array
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const buffer = device.createBuffer({
    label,
    size: Math.max(minimumByteLength, sourceBytes.byteLength),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Uint8Array(buffer.getMappedRange()).set(sourceBytes);
  buffer.unmap();
  return buffer;
}

function findEntryDefinition(module: EncodedFunctionalModule): number {
  for (let definitionIndex = 0; definitionIndex < module.definitionCount; definitionIndex++) {
    const symbol = module.definitionWords[
      definitionIndex * FUNCTIONAL_DEFINITION_WORD_LENGTH + FunctionalDefinitionWord.Symbol
    ];
    if (symbol === module.entrySymbol) return definitionIndex;
  }
  throw new Error(
    `functional compiled Core entry symbol ${module.entrySymbol} has no definition among ${module.definitionCount} definitions`,
  );
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
  const definitionNames = Array.from(
    { length: encodedModule.definitionCount },
    (_, definitionIndex) => {
      const symbol = encodedModule.definitionWords[
        definitionIndex * FUNCTIONAL_DEFINITION_WORD_LENGTH + FunctionalDefinitionWord.Symbol
      ];
      const name = symbol === undefined ? undefined : encodedModule.symbolNames[symbol];
      if (name === undefined) {
        throw new Error(
          `functional definition ${definitionIndex} references missing symbol ${symbol}`,
        );
      }
      return name;
    },
  );
  const wasmExports = (encodedModule.wasmExports ?? []).map((exported) => {
    const symbol = encodedModule.symbolNames.indexOf(exported.definition);
    if (symbol < 0) {
      throw new Error(
        `functional WASM export ${JSON.stringify(exported.name)} references unknown symbol ${
          JSON.stringify(exported.definition)
        }`,
      );
    }
    let definitionIndex: number | undefined;
    for (let index = 0; index < encodedModule.definitionCount; index++) {
      const definitionSymbol = encodedModule.definitionWords[
        index * FUNCTIONAL_DEFINITION_WORD_LENGTH + FunctionalDefinitionWord.Symbol
      ];
      if (definitionSymbol === symbol) {
        definitionIndex = index;
        break;
      }
    }
    if (definitionIndex === undefined) {
      throw new Error(
        `functional WASM export ${JSON.stringify(exported.name)} references non-definition ${
          JSON.stringify(exported.definition)
        }`,
      );
    }
    const annotation = encodedModule.definitionTypes[definitionIndex]?.annotation;
    if (annotation === null || annotation === undefined) {
      throw new Error(
        `functional WASM export ${JSON.stringify(exported.name)} requires a concrete annotation`,
      );
    }
    return Object.freeze({
      name: exported.name,
      definitionIndex,
      type: concreteFunctionalType(annotation),
    });
  });
  const hostCapabilities = normalizeFunctionalHostCapabilities(encodedModule.hostCapabilities);
  const boundDefinitions = new Set<string>();
  const hostDefinitions = (encodedModule.hostDefinitions ?? []).map((binding, index) => {
    const definitionIndex = definitionNames.indexOf(binding.definition);
    if (definitionIndex < 0) {
      throw new Error(
        `functional host definition binding ${index} references missing definition ${
          JSON.stringify(binding.definition)
        }`,
      );
    }
    if (boundDefinitions.has(binding.definition)) {
      throw new Error(
        `functional host definition bindings repeat definition ${
          JSON.stringify(binding.definition)
        }`,
      );
    }
    const capability = hostCapabilities.find((candidate) => candidate.name === binding.capability);
    const field = capability?.fields.find((field) => field.name === binding.field);
    if (field === undefined) {
      throw new Error(
        `functional host definition ${
          JSON.stringify(binding.definition)
        } references missing field ${JSON.stringify(`${binding.capability}.${binding.field}`)}`,
      );
    }
    const expectedType: FunctionalTypeSchema = field.kind === "value"
      ? field.type
      : { kind: "function", parameter: field.parameter, result: field.result };
    const annotation = encodedModule.definitionTypes[definitionIndex]?.annotation;
    if (
      annotation === null || annotation === undefined ||
      JSON.stringify(schemaShape(annotation)) !== JSON.stringify(schemaShape(expectedType))
    ) {
      throw new Error(
        `functional host definition ${JSON.stringify(binding.definition)} annotation ${
          JSON.stringify(annotation)
        } does not match field ${JSON.stringify(`${binding.capability}.${binding.field}`)} type ${
          JSON.stringify(expectedType)
        }`,
      );
    }
    boundDefinitions.add(binding.definition);
    return Object.freeze({ ...binding });
  });
  return {
    ...module,
    symbolNames: Object.freeze([...encodedModule.symbolNames]),
    definitionNames: Object.freeze(definitionNames),
    definitionRoots: Object.freeze(definitionRoots),
    hostCapabilities,
    hostDefinitions: Object.freeze(hostDefinitions),
    wasmExports: Object.freeze(wasmExports),
    sources: Object.freeze([...(encodedModule.sources ?? [])]),
    evaluationProfile: encodedModule.evaluationProfile,
    entryType: module.mainType,
    entryEffects: Object.freeze([]),
    readCoreNodes: async () => await module.readCoreNodes(),
    destroy: () => module.destroy(),
  };
}

function schemaShape(schema: FunctionalTypeSchema): unknown {
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return { kind: schema.kind };
    case "parameter":
      return { kind: schema.kind, name: schema.name };
    case "tuple":
      return { kind: schema.kind, values: schema.values.map(schemaShape) };
    case "named":
      return { kind: schema.kind, name: schema.name, arguments: schema.arguments.map(schemaShape) };
    case "function":
      return {
        kind: schema.kind,
        parameter: schemaShape(schema.parameter),
        result: schemaShape(schema.result),
      };
    case "forall":
      return { kind: schema.kind, parameters: schema.parameters, body: schemaShape(schema.body) };
  }
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
  requireFunctionalEvaluationProfile(module.evaluationProfile, "functional module");
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
  if (module.hostDefinitions !== undefined && !Array.isArray(module.hostDefinitions)) {
    throw new Error("functional module host definition bindings must be an array");
  }
  if (module.wasmExports !== undefined && !Array.isArray(module.wasmExports)) {
    throw new Error("functional module WASM exports must be an array");
  }
  validateFunctionalSources(module.sources, module.sourceByteLength);
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
  for (let nodeIndex = 0; nodeIndex < module.nodeCount; nodeIndex++) {
    const offset = nodeIndex * FUNCTIONAL_NODE_WORD_LENGTH;
    const tag = module.nodeWords[offset + FunctionalNodeWord.Tag];
    if (tag === FunctionalExpressionTag.RuntimeFault) {
      const symbol = module.nodeWords[offset + FunctionalNodeWord.Payload]!;
      if (symbol >= module.symbolNames.length) {
        throw new Error(
          `functional runtime fault node ${nodeIndex} references symbol ${symbol}; expected fewer than ${module.symbolNames.length}`,
        );
      }
      continue;
    }
    if (tag !== FunctionalExpressionTag.Text && tag !== FunctionalExpressionTag.Bytes) continue;
    const symbol = module.nodeWords[offset + FunctionalNodeWord.Payload]!;
    const typeIndex = module.nodeWords[offset + FunctionalNodeWord.Child0]!;
    if (symbol >= module.symbolNames.length || typeIndex >= module.typeCount) {
      throw new Error(
        `functional ${
          tag === FunctionalExpressionTag.Text ? "text" : "bytes"
        } literal node ${nodeIndex} references symbol ${symbol} and type ${typeIndex}; expected bounds ${module.symbolNames.length} and ${module.typeCount}`,
      );
    }
    if (tag === FunctionalExpressionTag.Bytes) {
      functionalBytesFromLiteralSymbol(module.symbolNames[symbol]!);
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

function validateFunctionalSources(
  sources: EncodedFunctionalModule["sources"],
  sourceByteLength: number,
): void {
  if (sources === undefined) return;
  if (!Array.isArray(sources)) throw new TypeError("functional module sources must be an array");
  let previousEndByte = 0;
  for (const [index, source] of sources.entries()) {
    if (source === null || typeof source !== "object") {
      throw new TypeError(
        `functional module source ${index} must be an object; received ${JSON.stringify(source)}`,
      );
    }
    if (typeof source.module !== "string" || source.module.length === 0) {
      throw new TypeError(
        `functional module source ${index} has invalid module ${JSON.stringify(source.module)}`,
      );
    }
    if (
      !Number.isSafeInteger(source.startByte) || !Number.isSafeInteger(source.endByte) ||
      source.startByte < previousEndByte || source.endByte < source.startByte ||
      source.endByte > sourceByteLength
    ) {
      throw new RangeError(
        `functional module source ${
          JSON.stringify(source.module)
        } has byte range ${source.startByte}..${source.endByte}; expected an ordered range within ${previousEndByte}..${sourceByteLength}`,
      );
    }
    previousEndByte = source.endByte;
  }
}

function requireFunctionalEvaluationProfile(
  profile: FunctionalEvaluationProfile,
  location: string,
): void {
  if (
    profile === FunctionalEvaluationProfile.LazyCallByNeed ||
    profile === FunctionalEvaluationProfile.StrictEager
  ) return;
  throw new Error(
    `${location} evaluation profile ${JSON.stringify(profile)} is unsupported; expected ${
      JSON.stringify(FunctionalEvaluationProfile.LazyCallByNeed)
    } or ${JSON.stringify(FunctionalEvaluationProfile.StrictEager)}`,
  );
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
    case "signed-integer-64":
    case "float-32":
    case "float-64":
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
    ...(diagnostic.related === undefined ? {} : {
      related: diagnostic.related.map((related) => ({
        message: related.message,
        span: related.span,
      })),
    }),
  };
}
