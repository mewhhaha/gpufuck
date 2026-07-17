import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_NODE_BYTE_LENGTH,
  LazuliConstructorWord,
  LazuliCoreTag,
  type LazuliCoreTag as KnownLazuliCoreTag,
  type LazuliDiagnostic,
  type LazuliEvaluationMode,
  type LazuliType,
  type LazuliTypeDeclaration,
} from "./abi.ts";

export interface LazuliCoreNode {
  readonly tag: LazuliCoreTag;
  readonly payload: number;
  readonly child0: number;
  readonly child1: number;
  readonly child2: number;
  readonly sourceByteOffset: number;
  readonly evaluationMode: LazuliEvaluationMode;
}

export interface GpuLazuliModule {
  readonly nodeBuffer: GPUBuffer;
  readonly definitionBuffer: GPUBuffer;
  readonly constructorBuffer: GPUBuffer;
  readonly nodeCount: number;
  readonly definitionCount: number;
  readonly constructorCount: number;
  readonly typeCount: number;
  readonly constructorNames: readonly string[];
  readonly constructorArities: readonly number[];
  readonly entryDefinition: number;
  readonly mainType: LazuliType;
  readonly typeDeclarations: readonly LazuliTypeDeclaration[];
  readCoreNodes(): Promise<readonly LazuliCoreNode[]>;
  destroy(): void;
}

export interface LazuliCompilationOptions {
  readonly maximumSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly signal?: AbortSignal;
}

export type LazuliCompileResult =
  | { readonly ok: true; readonly module: GpuLazuliModule }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [LazuliDiagnostic, ...LazuliDiagnostic[]];
  };

export class CompiledGpuLazuliModule implements GpuLazuliModule {
  readonly nodeBuffer: GPUBuffer;
  readonly definitionBuffer: GPUBuffer;
  readonly constructorBuffer: GPUBuffer;
  readonly nodeCount: number;
  readonly definitionCount: number;
  readonly constructorCount: number;
  readonly typeCount: number;
  readonly constructorNames: readonly string[];
  readonly constructorArities: readonly number[];
  readonly entryDefinition: number;
  readonly entryType: LazuliType;
  readonly mainType: LazuliType;
  readonly typeDeclarations: readonly LazuliTypeDeclaration[];

  readonly #device: GPUDevice;
  #coreNodes: readonly LazuliCoreNode[] | undefined;
  #destroyed = false;

  constructor(
    device: GPUDevice,
    nodeBuffer: GPUBuffer,
    definitionBuffer: GPUBuffer,
    constructorBuffer: GPUBuffer,
    surface: EncodedLazuliSurface,
    entryDefinition: number,
    mainType: LazuliType,
    typeDeclarations: readonly LazuliTypeDeclaration[],
    coreNodeBytes?: ArrayBuffer,
  ) {
    this.#device = device;
    this.nodeBuffer = nodeBuffer;
    this.definitionBuffer = definitionBuffer;
    this.constructorBuffer = constructorBuffer;
    this.nodeCount = surface.nodeCount;
    this.definitionCount = surface.definitionCount;
    this.constructorCount = surface.constructorCount;
    this.typeCount = surface.typeCount;
    this.constructorNames = Object.freeze(constructorNames(surface));
    this.constructorArities = Object.freeze(constructorArities(surface));
    this.entryDefinition = entryDefinition;
    this.entryType = deepFreeze(mainType);
    this.mainType = this.entryType;
    this.typeDeclarations = deepFreeze([...typeDeclarations]);
    if (coreNodeBytes !== undefined) {
      this.#coreNodes = decodeCoreNodes(new DataView(coreNodeBytes), this.nodeCount);
    }
  }

  async readCoreNodes(): Promise<readonly LazuliCoreNode[]> {
    if (this.#destroyed) {
      throw new Error("cannot read a destroyed GPU Lazuli module");
    }
    if (this.#coreNodes !== undefined) {
      return this.#coreNodes;
    }
    if (this.nodeCount === 0) {
      this.#coreNodes = Object.freeze([]);
      return this.#coreNodes;
    }

    const byteLength = this.nodeCount * LAZULI_NODE_BYTE_LENGTH;
    let readbackBuffer: GPUBuffer | undefined;
    let mapped = false;

    try {
      this.#device.pushErrorScope("validation");
      let validation: Promise<GPUError | null>;
      try {
        readbackBuffer = this.#device.createBuffer({
          label: "Lazuli core node readback",
          size: byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const commandEncoder = this.#device.createCommandEncoder({
          label: "Lazuli core node readback commands",
        });
        commandEncoder.copyBufferToBuffer(this.nodeBuffer, 0, readbackBuffer, 0, byteLength);
        this.#device.queue.submit([commandEncoder.finish()]);
        validation = this.#device.popErrorScope();
      } catch (cause) {
        const validationError = await this.#device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli core node readback for ${this.nodeCount} nodes: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }

      const validationError = await validation;
      if (validationError !== null) {
        throw new Error(
          `WebGPU rejected Lazuli core node readback for ${this.nodeCount} nodes: ${validationError.message}`,
        );
      }
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      mapped = true;
      const words = new DataView(readbackBuffer.getMappedRange().slice(0));
      this.#coreNodes = decodeCoreNodes(words, this.nodeCount);
      return this.#coreNodes;
    } finally {
      if (mapped) {
        readbackBuffer?.unmap();
      }
      readbackBuffer?.destroy();
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.nodeBuffer.destroy();
    this.definitionBuffer.destroy();
    this.constructorBuffer.destroy();
  }
}

function decodeCoreNodes(words: DataView, nodeCount: number): readonly LazuliCoreNode[] {
  const expectedByteLength = nodeCount * LAZULI_NODE_BYTE_LENGTH;
  if (words.byteLength !== expectedByteLength) {
    throw new Error(
      `GPU Lazuli core readback has ${words.byteLength} bytes for ${nodeCount} nodes; expected ${expectedByteLength}`,
    );
  }
  const nodes: LazuliCoreNode[] = [];
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
    const byteOffset = nodeIndex * LAZULI_NODE_BYTE_LENGTH;
    const tag = decodeCoreTag(words.getUint32(byteOffset, true), nodeIndex);
    nodes.push({
      tag,
      payload: words.getUint32(byteOffset + 4, true),
      child0: words.getUint32(byteOffset + 8, true),
      child1: words.getUint32(byteOffset + 12, true),
      child2: words.getUint32(byteOffset + 16, true),
      sourceByteOffset: words.getUint32(byteOffset + 20, true),
      evaluationMode: decodeEvaluationMode(words.getUint32(byteOffset + 28, true), nodeIndex),
    });
  }
  return deepFreeze(nodes);
}

function decodeEvaluationMode(value: number, nodeIndex: number): LazuliEvaluationMode {
  if (value === 0 || value === 1) return value;
  throw new Error(
    `GPU Lazuli module contains unknown evaluation mode ${value} at node ${nodeIndex}`,
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function decodeCoreTag(tag: number, nodeIndex: number): KnownLazuliCoreTag {
  switch (tag) {
    case LazuliCoreTag.Integer:
    case LazuliCoreTag.SignedInteger64:
    case LazuliCoreTag.Float32:
    case LazuliCoreTag.Float64:
    case LazuliCoreTag.NumericConvert:
    case LazuliCoreTag.Boolean:
    case LazuliCoreTag.Let:
    case LazuliCoreTag.If:
    case LazuliCoreTag.Lambda:
    case LazuliCoreTag.Apply:
    case LazuliCoreTag.Unary:
    case LazuliCoreTag.Binary:
    case LazuliCoreTag.Case:
    case LazuliCoreTag.CaseArm:
    case LazuliCoreTag.PatternBind:
    case LazuliCoreTag.LetRec:
    case LazuliCoreTag.Local:
    case LazuliCoreTag.Global:
    case LazuliCoreTag.Constructor:
      return tag;
    default:
      throw new Error(`GPU Lazuli module contains unknown core tag ${tag} at node ${nodeIndex}`);
  }
}

function constructorNames(surface: EncodedLazuliSurface): string[] {
  const names: string[] = [];
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const symbol = surface.constructorWords[
      constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH + LazuliConstructorWord.Symbol
    ];
    if (symbol === undefined) {
      throw new Error(`frontend omitted constructor symbol ${constructorIndex}`);
    }
    names.push(surface.symbolNames[symbol] ?? `<symbol ${symbol}>`);
  }
  return names;
}

function constructorArities(surface: EncodedLazuliSurface): number[] {
  const arities: number[] = [];
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const arity = surface.constructorWords[
      constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH + LazuliConstructorWord.Arity
    ];
    if (arity === undefined) {
      throw new Error(`frontend omitted constructor arity ${constructorIndex}`);
    }
    arities.push(arity);
  }
  return arities;
}
