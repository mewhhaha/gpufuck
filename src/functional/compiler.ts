import type { SemanticDiagnostic } from "../semantic/abi.ts";
import { measureCompilerStage, measureCompilerStageAsync } from "../compiler_performance_trace.ts";
import {
  CompiledGpuSemanticModule,
  type GpuSemanticModule,
  type SemanticModule,
} from "../semantic/compiler_module.ts";
import {
  constructorLimitDiagnostic,
  definitionLimitDiagnostic,
  nodeLimitDiagnostic,
  typeLimitDiagnostic,
} from "../semantic/compilation_diagnostics.ts";
import {
  GpuSemanticCompiler,
  type SemanticCompilationLimits,
} from "../semantic/gpu_semantic_compiler.ts";
import { publicTypeMetadata } from "../semantic/gpu_type_inference_results.ts";
import { compileSemanticOnHost } from "../semantic/host_semantic_compiler.ts";
import {
  CONSTRUCTOR_BYTE_LENGTH,
  CONSTRUCTOR_WORD_LENGTH,
  CORE_V1_PRIMITIVE_CAPABILITIES,
  DEFINITION_BYTE_LENGTH,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type Diagnostic,
  type EncodedModule,
  EvaluationMode,
  ExpressionTag,
  MAXIMUM_EXPRESSION_NODES,
  MAXIMUM_SOURCE_BYTE_LENGTH,
  MODULE_ABI_VERSION,
  NODE_BYTE_LENGTH,
  NODE_WORD_LENGTH,
  NodeWord,
  RuntimeFaultCategory,
  TYPE_BYTE_LENGTH,
  TYPE_WORD_LENGTH,
  TypecheckingProfile,
  type TypeSchema,
} from "./abi.ts";
import { CompilationAdmissionQueue } from "./compilation_admission.ts";
import {
  applyCoreArtifactLiteralUpdate,
  type CompiledCoreArtifact,
  encodeCoreArtifact,
  rebindCoreArtifactSource,
} from "./core_artifact.ts";
import { analyzeModuleEffects } from "./effect_analysis.ts";
import { type EffectSet, effectSet, effectSetFrom } from "./effect_set.ts";
import { type HostDefinitionBinding, normalizeHostCapabilities } from "./host_contract.ts";
import { functionalBytesFromLiteralSymbol } from "./static_literals.ts";
import { literalModuleUpdate } from "./incremental_module.ts";
import {
  registerResolvedCoreFingerprint,
  semanticModuleFingerprint,
} from "./semantic_fingerprint.ts";
import type {
  CompilationOptions,
  CompiledModule,
  CompileResult,
  CpuCompileResult,
  GpuModule,
} from "./compiler_module.ts";
import { registerCompleteTypeDeclarations } from "./compiler_module.ts";
import { registerPreparedWasmLambdaAnalysis } from "./prepared_wasm_lambda_analysis.ts";
import { concreteType } from "./schema_contract.ts";

export type {
  CompilationOptions,
  CompiledModule,
  CompileResult,
  CoreNode,
  CpuCompileResult,
  GpuModule,
} from "./compiler_module.ts";

const DEFAULT_MAXIMUM_COMPILATION_STEPS = 1_000_000;
const HARD_MAXIMUM_COMPILATION_STEPS = 10_000_000;
const DEFAULT_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH = 524_288;
const DEFAULT_CANCELLABLE_COMPILATION_STEPS_PER_DISPATCH = 16_384;
const HARD_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH = 524_288;
// One source byte upper-bounds one schema or type-parameter record. Six KiB covers its
// semantic storage, inference metadata/workspace/output/readback, and one workspace growth.
const COMPILATION_TRANSIENT_BYTES_PER_INPUT = 6_144;
const COMPILATION_FIXED_TRANSIENT_BYTE_LENGTH = 16_384;

export class CpuCompiler {
  async compileModule(
    module: EncodedModule,
    options: CompilationOptions = {},
  ): Promise<CpuCompileResult> {
    const results = await this.compileBatch([module], options);
    const result = results[0];
    if (result === undefined) {
      throw new Error("functional CPU compiler omitted its only result");
    }
    return result;
  }

  async compileBatch(
    modules: readonly EncodedModule[],
    options: CompilationOptions = {},
  ): Promise<readonly CpuCompileResult[]> {
    validateCompilationOptions(options);
    options.signal?.throwIfAborted();
    return await Promise.all(modules.map(async (module) => {
      measureCompilerStage(
        options.trace,
        "semantic.validate-envelope",
        {
          backend: "cpu",
          sourceBytes: module.sourceByteLength,
          nodes: module.nodeCount,
          definitions: module.definitionCount,
          types: module.typeCount,
          constructors: module.constructorCount,
        },
        () => validateEncodedModule(module),
      );
      options.signal?.throwIfAborted();
      if (module.sourceByteLength > MAXIMUM_SOURCE_BYTE_LENGTH) {
        return failedLimit(
          `module spans ${module.sourceByteLength} UTF-8 source bytes; this compiler accepts at most ${MAXIMUM_SOURCE_BYTE_LENGTH}`,
          MAXIMUM_SOURCE_BYTE_LENGTH,
          module.sourceByteLength,
        );
      }
      const compilation = compileSemanticOnHost(
        module,
        module.sourceByteLength,
        options.trace,
      );
      if (!compilation.ok) {
        return {
          ok: false,
          diagnostics: compilation.diagnostics.map(functionalDiagnostic) as [
            Diagnostic,
            ...Diagnostic[],
          ],
        };
      }
      return {
        ok: true,
        module: await measureCompilerStageAsync(
          options.trace,
          "semantic.publish",
          { definitions: module.definitionCount },
          () => publicModule(compilation.module, module, options.trace),
        ),
      };
    }));
  }
}

export class GpuCompiler {
  readonly #device: GPUDevice;
  readonly #semanticCompiler: GpuSemanticCompiler;
  readonly #compilationAdmission: CompilationAdmissionQueue;
  readonly #maximumNodeCount: number;
  readonly #maximumDefinitionCount: number;
  readonly #maximumTypeCount: number;
  readonly #maximumConstructorCount: number;
  readonly #artifactsByModule = new WeakMap<EncodedModule, Promise<CompiledCoreArtifact>>();
  readonly #artifactsBySemantics = new Map<string, Promise<CompiledCoreArtifact>>();

  private constructor(
    device: GPUDevice,
    semanticCompiler: GpuSemanticCompiler,
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

  static async create(device: GPUDevice): Promise<GpuCompiler> {
    const maximumNodeCount = Math.min(
      MAXIMUM_EXPRESSION_NODES,
      Math.floor(device.limits.maxStorageBufferBindingSize / NODE_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / NODE_BYTE_LENGTH),
    );
    const maximumDefinitionCount = Math.min(
      maximumNodeCount,
      Math.floor(device.limits.maxStorageBufferBindingSize / DEFINITION_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / DEFINITION_BYTE_LENGTH),
    );
    const maximumTypeCount = Math.min(
      Math.floor(device.limits.maxStorageBufferBindingSize / TYPE_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / TYPE_BYTE_LENGTH),
    );
    const maximumConstructorCount = Math.min(
      Math.floor(device.limits.maxStorageBufferBindingSize / CONSTRUCTOR_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / CONSTRUCTOR_BYTE_LENGTH),
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

    const semanticCompiler = await GpuSemanticCompiler.create(device);
    return new GpuCompiler(
      device,
      semanticCompiler,
      maximumNodeCount,
      maximumDefinitionCount,
      maximumTypeCount,
      maximumConstructorCount,
      maximumConcurrentCompilationWeight,
    );
  }

  async compileModule(
    module: EncodedModule,
    options: CompilationOptions = {},
  ): Promise<CompileResult> {
    validateCompilationOptions(options);
    if (options.signal === undefined && options.maximumSteps === undefined) {
      return await this.#compileCachedModule(module, options);
    }
    const results = await this.compileBatch([module], options);
    const result = results[0];
    if (result === undefined) {
      throw new Error("functional scalar compiler omitted its only result");
    }
    return result;
  }

  async #compileCachedModule(
    module: EncodedModule,
    options: CompilationOptions,
  ): Promise<CompileResult> {
    const moduleArtifact = this.#artifactsByModule.get(module);
    const semanticFingerprint = measureCompilerStage(
      options.trace,
      "semantic.fingerprint",
      { nodes: module.nodeCount, sourceBytes: module.sourceByteLength },
      () => semanticModuleFingerprint(module),
    );
    const semanticArtifact = this.#artifactsBySemantics.get(semanticFingerprint);
    const literalUpdate = literalModuleUpdate(module);
    const literalArtifact = literalUpdate === undefined
      ? undefined
      : this.#artifactsByModule.get(literalUpdate.reference);
    const cacheLevel = moduleArtifact !== undefined
      ? "module"
      : semanticArtifact !== undefined
      ? "semantics"
      : literalArtifact !== undefined
      ? "literal-update"
      : "none";
    options.trace?.start("semantic.service-cache").finish({
      backend: "gpu",
      cacheHit: cacheLevel !== "none",
      cacheLevel,
    });

    let cachedArtifact = moduleArtifact;
    if (cachedArtifact === undefined && semanticArtifact !== undefined) {
      cachedArtifact = semanticArtifact.then((artifact) =>
        rebindCoreArtifactSource(module, artifact)
      );
    }
    if (
      cachedArtifact === undefined && literalArtifact !== undefined && literalUpdate !== undefined
    ) {
      cachedArtifact = literalArtifact.then((artifact) =>
        applyCoreArtifactLiteralUpdate(module, artifact, literalUpdate.changedNodes)
      );
    }
    if (cachedArtifact !== undefined) {
      this.#rememberArtifact(module, semanticFingerprint, cachedArtifact);
      const restored = await measureCompilerStageAsync(
        options.trace,
        "semantic.restore-core",
        { nodes: module.nodeCount, cacheLevel },
        async () => await this.restoreCompiledCore(module, await cachedArtifact),
      );
      registerResolvedCoreFingerprint(restored, `surface:${semanticFingerprint}`);
      return { ok: true, module: restored };
    }

    const results = await this.compileBatch([module], options);
    const result = results[0];
    if (result === undefined) {
      throw new Error("functional scalar compiler omitted its only result");
    }
    if (!result.ok) return result;
    const artifact = Promise.resolve({
      nodes: await result.module.readCoreNodes(),
      entryType: result.module.entryType,
    });
    this.#rememberArtifact(module, semanticFingerprint, artifact);
    registerResolvedCoreFingerprint(result.module, `surface:${semanticFingerprint}`);
    return result;
  }

  #rememberArtifact(
    module: EncodedModule,
    semanticFingerprint: string,
    artifact: Promise<CompiledCoreArtifact>,
  ): void {
    this.#artifactsByModule.set(module, artifact);
    this.#artifactsBySemantics.set(semanticFingerprint, artifact);
    while (this.#artifactsBySemantics.size > 64) {
      const oldest = this.#artifactsBySemantics.keys().next().value;
      if (oldest === undefined) break;
      this.#artifactsBySemantics.delete(oldest);
    }
  }

  async compileBatch(
    modules: readonly EncodedModule[],
    options: CompilationOptions = {},
  ): Promise<readonly CompileResult[]> {
    const limits = compilationLimits(options);
    options.signal?.throwIfAborted();
    if (modules.length === 0) return [];

    const results: (CompileResult | undefined)[] = new Array(modules.length);
    const accepted: { readonly resultIndex: number; readonly module: EncodedModule }[] = [];
    let estimatedTransientByteLength = 0;
    for (const [resultIndex, module] of modules.entries()) {
      measureCompilerStage(
        options.trace,
        "semantic.validate-envelope",
        {
          backend: "gpu",
          sourceBytes: module.sourceByteLength,
          nodes: module.nodeCount,
          definitions: module.definitionCount,
          types: module.typeCount,
          constructors: module.constructorCount,
        },
        () => validateEncodedModule(module),
      );
      if (module.sourceByteLength > MAXIMUM_SOURCE_BYTE_LENGTH) {
        results[resultIndex] = failedLimit(
          `module spans ${module.sourceByteLength} UTF-8 source bytes; this compiler accepts at most ${MAXIMUM_SOURCE_BYTE_LENGTH}`,
          MAXIMUM_SOURCE_BYTE_LENGTH,
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

    const compiled = await measureCompilerStageAsync(
      options.trace,
      "semantic.gpu.admit-and-dispatch",
      {
        modules: accepted.length,
        transientBytes: estimatedTransientByteLength,
        nodes: options.trace === undefined
          ? 0
          : accepted.reduce((total, entry) => total + entry.module.nodeCount, 0),
      },
      () =>
        this.#compilationAdmission.admit(
          async () => {
            options.signal?.throwIfAborted();
            return await this.#semanticCompiler.compileBatch(
              accepted.map(({ module }) => ({
                surface: module,
                sourceByteLength: module.sourceByteLength,
                ...limits,
              })),
              options.signal,
              undefined,
              options.trace,
            );
          },
          estimatedTransientByteLength,
          options.signal,
        ),
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
          ? {
            ok: true,
            module: await measureCompilerStageAsync(
              options.trace,
              "semantic.publish",
              { backend: "gpu", definitions: entry.module.definitionCount },
              () => publicModule(result.module, entry.module, options.trace),
            ),
          }
          : {
            ok: false,
            diagnostics: result.diagnostics.map(functionalDiagnostic) as [
              Diagnostic,
              ...Diagnostic[],
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
    encodedModule: EncodedModule,
    artifact: CompiledCoreArtifact,
  ): Promise<GpuModule> {
    return await restoreCompiledCore(this.#device, encodedModule, artifact);
  }
}

export async function restoreCompiledCore(
  device: GPUDevice,
  encodedModule: EncodedModule,
  artifact: CompiledCoreArtifact,
): Promise<GpuModule> {
  validateEncodedModule(encodedModule);
  const coreNodeBytes = encodeCoreArtifact(encodedModule, artifact);
  const surface = encodedModule;
  const entryDefinition = findEntryDefinition(encodedModule);
  const buffers: GPUBuffer[] = [];
  device.pushErrorScope("validation");
  device.pushErrorScope("out-of-memory");
  let allocationCause: unknown;
  try {
    const nodeBuffer = createRestoredBuffer(
      device,
      "Functional restored Core nodes",
      coreNodeBytes,
      NODE_BYTE_LENGTH,
    );
    buffers.push(nodeBuffer);
    const definitionBuffer = createRestoredBuffer(
      device,
      "Functional restored definitions",
      encodedModule.definitionWords,
      DEFINITION_BYTE_LENGTH,
    );
    buffers.push(definitionBuffer);
    const constructorBuffer = createRestoredBuffer(
      device,
      "Functional restored constructors",
      encodedModule.constructorWords,
      CONSTRUCTOR_BYTE_LENGTH,
    );
    buffers.push(constructorBuffer);
  } catch (cause) {
    allocationCause = cause;
  }
  const [outOfMemory, validation] = await Promise.all([
    device.popErrorScope(),
    device.popErrorScope(),
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
  const semanticModule = new CompiledGpuSemanticModule(
    device,
    nodeBuffer,
    definitionBuffer,
    constructorBuffer,
    surface,
    entryDefinition,
    artifact.entryType,
    publicTypeMetadata(surface).typeDeclarations,
    coreNodeBytes.slice(0, encodedModule.nodeCount * NODE_BYTE_LENGTH),
  );
  return await publicModule(semanticModule, encodedModule);
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

function findEntryDefinition(module: EncodedModule): number {
  for (let definitionIndex = 0; definitionIndex < module.definitionCount; definitionIndex++) {
    const symbol = module.definitionWords[
      definitionIndex * DEFINITION_WORD_LENGTH + DefinitionWord.Symbol
    ];
    if (symbol === module.entrySymbol) return definitionIndex;
  }
  throw new Error(
    `functional compiled Core entry symbol ${module.entrySymbol} has no definition among ${module.definitionCount} definitions`,
  );
}

function encodedDefinitionNames(module: EncodedModule): readonly string[] {
  return Object.freeze(Array.from(
    { length: module.definitionCount },
    (_, definitionIndex) => {
      const symbol = module.definitionWords[
        definitionIndex * DEFINITION_WORD_LENGTH + DefinitionWord.Symbol
      ];
      const name = symbol === undefined ? undefined : module.symbolNames[symbol];
      if (name === undefined) {
        throw new Error(
          `functional definition ${definitionIndex} references missing symbol ${symbol}`,
        );
      }
      return name;
    },
  ));
}

function completedBatchResults(
  results: readonly (CompileResult | undefined)[],
): readonly CompileResult[] {
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`functional batch compiler omitted result ${index}`);
    return result;
  });
}

async function publicModule(
  module: GpuSemanticModule,
  encodedModule: EncodedModule,
  trace?: CompilationOptions["trace"],
): Promise<GpuModule>;
async function publicModule(
  module: SemanticModule,
  encodedModule: EncodedModule,
  trace?: CompilationOptions["trace"],
): Promise<CompiledModule>;
async function publicModule(
  module: SemanticModule,
  encodedModule: EncodedModule,
  trace?: CompilationOptions["trace"],
): Promise<CompiledModule> {
  const definitionRoots = Array.from(
    { length: encodedModule.definitionCount },
    (_, definitionIndex) =>
      encodedModule.definitionWords[
        definitionIndex * DEFINITION_WORD_LENGTH + DefinitionWord.RootNode
      ]!,
  );
  const definitionNames = encodedDefinitionNames(encodedModule);
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
        index * DEFINITION_WORD_LENGTH + DefinitionWord.Symbol
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
      type: concreteType(annotation),
      effects: effectSet(),
    });
  });
  const hostCapabilities = normalizeHostCapabilities(encodedModule.hostCapabilities);
  const declaredDefinitionEffects = normalizedDeclaredDefinitionEffects(encodedModule);
  const hostDefinitions = normalizedEncodedHostDefinitions(
    encodedModule,
    definitionNames,
    hostCapabilities,
    declaredDefinitionEffects,
  );
  const functional: CompiledModule = {
    ...module,
    symbolNames: Object.freeze([...encodedModule.symbolNames]),
    definitionNames: Object.freeze(definitionNames),
    typeNames: Object.freeze(encodedModule.typeDeclarations.map((declaration) => declaration.name)),
    definitionRoots: Object.freeze(definitionRoots),
    hostCapabilities,
    hostDefinitions,
    wasmExports: Object.freeze(wasmExports),
    sources: Object.freeze([...(encodedModule.sources ?? [])]),
    entryType: module.mainType,
    entryEffects: effectSet(),
    declaredDefinitionEffects,
    definitionEffects: Object.freeze(
      Array.from({ length: encodedModule.definitionCount }, () => effectSet()),
    ),
    readCoreNodes: async () => await module.readCoreNodes(),
    destroy: () => module.destroy(),
  };
  const coreNodes = await measureCompilerStageAsync(
    trace,
    "semantic.read-core",
    { nodes: module.nodeCount },
    () => module.readCoreNodes(),
  );
  const effects = measureCompilerStage(
    trace,
    "semantic.effects",
    { nodes: module.nodeCount, definitions: module.definitionCount },
    () => analyzeModuleEffects(functional, coreNodes, trace),
  );
  const completed = {
    ...functional,
    entryEffects: effects.entryEffects,
    definitionEffects: effects.definitionEffects,
    wasmExports: Object.freeze(functional.wasmExports.map((exported) =>
      Object.freeze({
        ...exported,
        effects: effects.definitionEffects[exported.definitionIndex]!,
      })
    )),
  };
  registerCompleteTypeDeclarations(completed, encodedModule.typeDeclarations);
  if (effects.wasmLambdaAnalysis !== undefined) {
    registerPreparedWasmLambdaAnalysis(completed, effects.wasmLambdaAnalysis);
  }
  return completed;
}

function schemaShape(schema: TypeSchema): unknown {
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

export function validateCompilationOptions(
  options: CompilationOptions,
): void {
  compilationLimits(options);
}

function compilationLimits(
  options: CompilationOptions,
): SemanticCompilationLimits {
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

function validateEncodedModule(module: EncodedModule): void {
  if (module.abiVersion !== MODULE_ABI_VERSION) {
    throw new Error(
      `functional module ABI version ${module.abiVersion} is unsupported; expected ${MODULE_ABI_VERSION}`,
    );
  }
  if (!Number.isSafeInteger(module.sourceByteLength) || module.sourceByteLength < 0) {
    throw new Error(
      `functional module has invalid source byte length ${module.sourceByteLength}`,
    );
  }
  if (
    module.typecheckingProfile !== TypecheckingProfile.HindleyMilnerIndexed &&
    module.typecheckingProfile !== TypecheckingProfile.PredicativeRankNIndexed
  ) {
    throw new Error(
      `functional module typechecking profile ${
        JSON.stringify(module.typecheckingProfile)
      } is unsupported; expected ${JSON.stringify(TypecheckingProfile.HindleyMilnerIndexed)} or ${
        JSON.stringify(TypecheckingProfile.PredicativeRankNIndexed)
      }`,
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
      (module.typecheckingProfile === TypecheckingProfile.PredicativeRankNIndexed)
  ) {
    throw new Error(
      `functional module typechecking profile ${
        JSON.stringify(module.typecheckingProfile)
      } does not match higher-rank schema presence ${declaresHigherRankTypes}`,
    );
  }
  validatePrimitiveCapabilities(module.primitiveCapabilities);
  const hostCapabilities = normalizeHostCapabilities(module.hostCapabilities);
  const declaredDefinitionEffects = normalizedDeclaredDefinitionEffects(module);
  if (module.hostDefinitions !== undefined && !Array.isArray(module.hostDefinitions)) {
    throw new Error("functional module host definition bindings must be an array");
  }
  if (module.wasmExports !== undefined && !Array.isArray(module.wasmExports)) {
    throw new Error("functional module WASM exports must be an array");
  }
  validateSources(module.sources, module.sourceByteLength);
  validateRecordTable("node", module.nodeWords, module.nodeCount, NODE_WORD_LENGTH);
  validateRecordTable(
    "definition",
    module.definitionWords,
    module.definitionCount,
    DEFINITION_WORD_LENGTH,
  );
  validateRecordTable("type", module.typeWords, module.typeCount, TYPE_WORD_LENGTH);
  validateRecordTable(
    "constructor",
    module.constructorWords,
    module.constructorCount,
    CONSTRUCTOR_WORD_LENGTH,
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
    const offset = nodeIndex * NODE_WORD_LENGTH;
    const tag = module.nodeWords[offset + NodeWord.Tag];
    if (tag === ExpressionTag.Let) {
      const evaluationMode = module.nodeWords[offset + NodeWord.Child2]!;
      if (
        evaluationMode !== EvaluationMode.LazyCallByNeed &&
        evaluationMode !== EvaluationMode.StrictEager
      ) {
        throw new Error(
          `functional let node ${nodeIndex} has unknown evaluation mode ${evaluationMode}`,
        );
      }
      continue;
    }
    if (tag === ExpressionTag.RuntimeFault) {
      const symbol = module.nodeWords[offset + NodeWord.Payload]!;
      const category = module.nodeWords[offset + NodeWord.Child0]!;
      if (symbol >= module.symbolNames.length) {
        throw new Error(
          `functional runtime fault node ${nodeIndex} references symbol ${symbol}; expected fewer than ${module.symbolNames.length}`,
        );
      }
      if (category > RuntimeFaultCategory.Unreachable) {
        throw new Error(
          `functional runtime fault node ${nodeIndex} has unknown category ${category}`,
        );
      }
      continue;
    }
    if (tag !== ExpressionTag.Text && tag !== ExpressionTag.Bytes) continue;
    const symbol = module.nodeWords[offset + NodeWord.Payload]!;
    const typeIndex = module.nodeWords[offset + NodeWord.Child0]!;
    if (symbol >= module.symbolNames.length || typeIndex >= module.typeCount) {
      throw new Error(
        `functional ${
          tag === ExpressionTag.Text ? "text" : "bytes"
        } literal node ${nodeIndex} references symbol ${symbol} and type ${typeIndex}; expected bounds ${module.symbolNames.length} and ${module.typeCount}`,
      );
    }
    if (tag === ExpressionTag.Bytes) {
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
  normalizedEncodedHostDefinitions(
    module,
    encodedDefinitionNames(module),
    hostCapabilities,
    declaredDefinitionEffects,
  );
}

function normalizedDeclaredDefinitionEffects(
  module: EncodedModule,
): readonly EffectSet[] {
  const declarations = module.declaredDefinitionEffects;
  if (!Array.isArray(declarations) || declarations.length !== module.definitionCount) {
    throw new Error(
      `functional module has ${
        Array.isArray(declarations) ? declarations.length : "non-array"
      } declared effect sets for ${module.definitionCount} definitions`,
    );
  }
  return Object.freeze(declarations.map((effects, definitionIndex) => {
    if (!(effects instanceof Set)) {
      throw new TypeError(
        `functional definition ${definitionIndex} declared effects must be a ReadonlySet; received ${
          JSON.stringify(effects)
        }`,
      );
    }
    return effectSetFrom(effects);
  }));
}

function normalizedEncodedHostDefinitions(
  module: EncodedModule,
  definitionNames: readonly string[],
  hostCapabilities: ReturnType<typeof normalizeHostCapabilities>,
  declaredDefinitionEffects: readonly EffectSet[],
): readonly HostDefinitionBinding[] {
  const boundDefinitions = new Set<string>();
  return Object.freeze((module.hostDefinitions ?? []).map((binding, index) => {
    if (binding === null || typeof binding !== "object") {
      throw new TypeError(
        `functional host definition binding ${index} must be an object; received ${
          JSON.stringify(binding)
        }`,
      );
    }
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
    const field = capability?.fields.find((candidate) => candidate.name === binding.field);
    if (field === undefined) {
      throw new Error(
        `functional host definition ${
          JSON.stringify(binding.definition)
        } references missing field ${JSON.stringify(`${binding.capability}.${binding.field}`)}`,
      );
    }
    const expectedType: TypeSchema = field.kind === "value"
      ? field.type
      : { kind: "function", parameter: field.parameter, result: field.result };
    const annotation = module.definitionTypes[definitionIndex]?.annotation;
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
    const declaredEffects = declaredDefinitionEffects[definitionIndex]!;
    if (
      declaredEffects.size !== 0 &&
      (
        field.kind !== "operation" ||
        declaredEffects.size !== field.effects.size ||
        ![...declaredEffects].every((effect) => field.effects.has(effect))
      )
    ) {
      throw new Error(
        `functional host definition ${JSON.stringify(binding.definition)} declares effects ${
          JSON.stringify([...declaredEffects])
        }; field ${JSON.stringify(`${binding.capability}.${binding.field}`)} declares ${
          JSON.stringify(field.kind === "operation" ? [...field.effects] : [])
        }`,
      );
    }
    boundDefinitions.add(binding.definition);
    return Object.freeze({ ...binding });
  }));
}

function validateSources(
  sources: EncodedModule["sources"],
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

function schemaContainsForall(schema: TypeSchema): boolean {
  switch (schema.kind) {
    case "forall":
      return true;
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
  const expected = new Set<string>(CORE_V1_PRIMITIVE_CAPABILITIES);
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

/**
 * An encoded module carries every field the packed surface does, so this is the identity. It stays
 * exported because it is part of the published surface, and it keeps the widening explicit at the
 * call sites that pass a module where a surface is expected.
 */
function failedLimit(
  message: string,
  startByte: number,
  endByte: number,
): CompileResult {
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

function functionalFailure(diagnostic: SemanticDiagnostic): CompileResult {
  return { ok: false, diagnostics: [functionalDiagnostic(diagnostic)] };
}

function functionalDiagnostic(diagnostic: SemanticDiagnostic): Diagnostic {
  return {
    stage: "compile",
    code: diagnostic.code,
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
