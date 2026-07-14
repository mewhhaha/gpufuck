import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_BYTE_LENGTH,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_BYTE_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH,
  LAZULI_MAXIMUM_SURFACE_NODES,
  LAZULI_NODE_BYTE_LENGTH,
  LAZULI_NODE_WORD_LENGTH,
  LAZULI_TYPE_BYTE_LENGTH,
  LAZULI_TYPE_WORD_LENGTH,
} from "./abi.ts";
import { LazuliCompilationAdmissionQueue } from "./compilation_admission.ts";
import {
  constructorLimitDiagnostic,
  definitionLimitDiagnostic,
  nodeLimitDiagnostic,
  sourceTooLargeDiagnostic,
  typeLimitDiagnostic,
} from "./compilation_diagnostics.ts";
import type { LazuliCompilationOptions, LazuliCompileResult } from "./compiler_module.ts";
import { parseLazuliSource } from "./frontend.ts";
import {
  GpuLazuliSemanticCompiler,
  type LazuliSemanticCompilationLimits,
} from "./gpu_semantic_compiler.ts";

export type {
  GpuLazuliModule,
  LazuliCompilationOptions,
  LazuliCompileResult,
  LazuliCoreNode,
} from "./compiler_module.ts";

const DEFAULT_MAXIMUM_COMPILATION_STEPS = 1_000_000;
const HARD_MAXIMUM_COMPILATION_STEPS = 10_000_000;
const DEFAULT_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH = 4_096;
const HARD_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH = 65_536;
const COMPILATION_TRANSIENT_BYTES_PER_INPUT = 6_144;
const COMPILATION_FIXED_TRANSIENT_BYTE_LENGTH = 16_384;

export class GpuLazuliCompiler {
  readonly #semanticCompiler: GpuLazuliSemanticCompiler;
  readonly #compilationAdmission: LazuliCompilationAdmissionQueue;
  readonly #maximumSourceByteLength: number;
  readonly #maximumNodeCount: number;
  readonly #maximumDefinitionCount: number;
  readonly #maximumTypeCount: number;
  readonly #maximumConstructorCount: number;

  private constructor(
    semanticCompiler: GpuLazuliSemanticCompiler,
    maximumSourceByteLength: number,
    maximumNodeCount: number,
    maximumDefinitionCount: number,
    maximumTypeCount: number,
    maximumConstructorCount: number,
    maximumConcurrentCompilationWeight: number,
  ) {
    this.#semanticCompiler = semanticCompiler;
    this.#compilationAdmission = new LazuliCompilationAdmissionQueue(
      maximumConcurrentCompilationWeight,
    );
    this.#maximumSourceByteLength = maximumSourceByteLength;
    this.#maximumNodeCount = maximumNodeCount;
    this.#maximumDefinitionCount = maximumDefinitionCount;
    this.#maximumTypeCount = maximumTypeCount;
    this.#maximumConstructorCount = maximumConstructorCount;
  }

  static async create(device: GPUDevice): Promise<GpuLazuliCompiler> {
    const maximumSourceByteLength = LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH;
    const maximumNodeCount = Math.min(
      LAZULI_MAXIMUM_SURFACE_NODES,
      Math.floor(device.limits.maxStorageBufferBindingSize / LAZULI_NODE_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / LAZULI_NODE_BYTE_LENGTH),
    );
    const maximumDefinitionCount = Math.min(
      maximumNodeCount,
      Math.floor(device.limits.maxStorageBufferBindingSize / LAZULI_DEFINITION_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / LAZULI_DEFINITION_BYTE_LENGTH),
    );
    const maximumTypeCount = Math.min(
      Math.floor(device.limits.maxStorageBufferBindingSize / LAZULI_TYPE_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / LAZULI_TYPE_BYTE_LENGTH),
    );
    const maximumConstructorCount = Math.min(
      Math.floor(device.limits.maxStorageBufferBindingSize / LAZULI_CONSTRUCTOR_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / LAZULI_CONSTRUCTOR_BYTE_LENGTH),
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
        "WebGPU device limits cannot store Lazuli ABI records: " +
          `maxStorageBufferBindingSize=${device.limits.maxStorageBufferBindingSize}, ` +
          `maxBufferSize=${device.limits.maxBufferSize}`,
      );
    }

    const semanticCompiler = await GpuLazuliSemanticCompiler.create(device);
    return new GpuLazuliCompiler(
      semanticCompiler,
      maximumSourceByteLength,
      maximumNodeCount,
      maximumDefinitionCount,
      maximumTypeCount,
      maximumConstructorCount,
      maximumConcurrentCompilationWeight,
    );
  }

  async compile(
    source: string,
    options: LazuliCompilationOptions = {},
  ): Promise<LazuliCompileResult> {
    const limits = compilationLimits(options);
    options.signal?.throwIfAborted();
    const sourceByteLength = new TextEncoder().encode(source).byteLength;
    if (sourceByteLength > this.#maximumSourceByteLength) {
      return {
        ok: false,
        diagnostics: [sourceTooLargeDiagnostic(sourceByteLength, this.#maximumSourceByteLength)],
      };
    }

    const frontend = parseLazuliSource(source);
    if (!frontend.ok) {
      return frontend;
    }
    const surface = frontend.surface;
    validateEncodedSurfaceShape(surface);
    if (surface.nodeCount > this.#maximumNodeCount) {
      return {
        ok: false,
        diagnostics: [nodeLimitDiagnostic(surface.nodeCount, this.#maximumNodeCount)],
      };
    }
    if (surface.definitionCount > this.#maximumDefinitionCount) {
      return {
        ok: false,
        diagnostics: [
          definitionLimitDiagnostic(surface.definitionCount, this.#maximumDefinitionCount),
        ],
      };
    }
    if (surface.typeCount > this.#maximumTypeCount) {
      return {
        ok: false,
        diagnostics: [typeLimitDiagnostic(surface.typeCount, this.#maximumTypeCount)],
      };
    }
    if (surface.constructorCount > this.#maximumConstructorCount) {
      return {
        ok: false,
        diagnostics: [
          constructorLimitDiagnostic(surface.constructorCount, this.#maximumConstructorCount),
        ],
      };
    }

    // One source byte upper-bounds one schema or type-parameter record. Six KiB covers its
    // semantic storage, inference metadata/workspace/output/readback, and one workspace growth.
    const estimatedTransientByteLength = COMPILATION_FIXED_TRANSIENT_BYTE_LENGTH +
      COMPILATION_TRANSIENT_BYTES_PER_INPUT *
        (sourceByteLength + surface.nodeCount + surface.definitionCount + surface.typeCount +
          surface.constructorCount);

    return await this.#compilationAdmission.admit(
      async () => {
        options.signal?.throwIfAborted();
        const result = await this.#semanticCompiler.compile(
          surface,
          sourceByteLength,
          limits,
          options.signal,
        );
        try {
          options.signal?.throwIfAborted();
        } catch (error) {
          if (result.ok) result.module.destroy();
          throw error;
        }
        return result;
      },
      estimatedTransientByteLength,
      options.signal,
    );
  }
}

function compilationLimits(options: LazuliCompilationOptions): LazuliSemanticCompilationLimits {
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
      DEFAULT_MAXIMUM_COMPILATION_STEPS_PER_DISPATCH,
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

function validateEncodedSurfaceShape(surface: EncodedLazuliSurface): void {
  if (!Number.isSafeInteger(surface.nodeCount) || surface.nodeCount < 0) {
    throw new Error(`frontend returned invalid Lazuli node count ${surface.nodeCount}`);
  }
  if (!Number.isSafeInteger(surface.definitionCount) || surface.definitionCount < 0) {
    throw new Error(`frontend returned invalid Lazuli definition count ${surface.definitionCount}`);
  }
  if (!Number.isSafeInteger(surface.typeCount) || surface.typeCount < 0) {
    throw new Error(`frontend returned invalid Lazuli type count ${surface.typeCount}`);
  }
  if (!Number.isSafeInteger(surface.constructorCount) || surface.constructorCount < 0) {
    throw new Error(
      `frontend returned invalid Lazuli constructor count ${surface.constructorCount}`,
    );
  }
  if (surface.nodeWords.length !== surface.nodeCount * LAZULI_NODE_WORD_LENGTH) {
    throw new Error(
      `frontend returned ${surface.nodeWords.length} Lazuli node words for ${surface.nodeCount} nodes`,
    );
  }
  if (
    surface.definitionWords.length !== surface.definitionCount * LAZULI_DEFINITION_WORD_LENGTH
  ) {
    throw new Error(
      `frontend returned ${surface.definitionWords.length} Lazuli definition words for ${surface.definitionCount} definitions`,
    );
  }
  if (surface.typeWords.length !== surface.typeCount * LAZULI_TYPE_WORD_LENGTH) {
    throw new Error(
      `frontend returned ${surface.typeWords.length} Lazuli type words for ${surface.typeCount} types`,
    );
  }
  if (
    surface.constructorWords.length !==
      surface.constructorCount * LAZULI_CONSTRUCTOR_WORD_LENGTH
  ) {
    throw new Error(
      `frontend returned ${surface.constructorWords.length} Lazuli constructor words for ${surface.constructorCount} constructors`,
    );
  }
}
