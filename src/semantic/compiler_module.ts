import {
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  CoreTag,
  type CoreTag as KnownCoreTag,
  type EncodedSemanticSurface,
  type EvaluationMode,
  NODE_BYTE_LENGTH,
  type SemanticDiagnostic,
  type Type,
  type TypeDeclaration,
} from "./abi.ts";

export interface CoreNode {
  readonly tag: CoreTag;
  readonly payload: number;
  readonly child0: number;
  readonly child1: number;
  readonly child2: number;
  readonly sourceByteOffset: number;
  readonly sourceEndByte: number;
  readonly evaluationMode: EvaluationMode;
}

export interface GpuSemanticModule {
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
  readonly mainType: Type;
  readonly typeDeclarations: readonly TypeDeclaration[];
  readCoreNodes(): Promise<readonly CoreNode[]>;
  destroy(): void;
}

export interface SemanticCompilationOptions {
  readonly maximumSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly signal?: AbortSignal;
}

export type SemanticCompileResult =
  | { readonly ok: true; readonly module: GpuSemanticModule }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [SemanticDiagnostic, ...SemanticDiagnostic[]];
  };

export class CompiledGpuSemanticModule implements GpuSemanticModule {
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
  readonly entryType: Type;
  readonly mainType: Type;
  readonly typeDeclarations: readonly TypeDeclaration[];

  readonly #device: GPUDevice;
  #coreNodes: readonly CoreNode[] | undefined;
  #destroyed = false;

  constructor(
    device: GPUDevice,
    nodeBuffer: GPUBuffer,
    definitionBuffer: GPUBuffer,
    constructorBuffer: GPUBuffer,
    surface: EncodedSemanticSurface,
    entryDefinition: number,
    mainType: Type,
    typeDeclarations: readonly TypeDeclaration[],
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

  async readCoreNodes(): Promise<readonly CoreNode[]> {
    if (this.#destroyed) {
      throw new Error("cannot read a destroyed GPU module");
    }
    if (this.#coreNodes !== undefined) {
      return this.#coreNodes;
    }
    if (this.nodeCount === 0) {
      this.#coreNodes = Object.freeze([]);
      return this.#coreNodes;
    }

    const byteLength = this.nodeCount * NODE_BYTE_LENGTH;
    let readbackBuffer: GPUBuffer | undefined;
    let mapped = false;

    try {
      this.#device.pushErrorScope("validation");
      let validation: Promise<GPUError | null>;
      try {
        readbackBuffer = this.#device.createBuffer({
          label: "core node readback",
          size: byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const commandEncoder = this.#device.createCommandEncoder({
          label: "core node readback commands",
        });
        commandEncoder.copyBufferToBuffer(this.nodeBuffer, 0, readbackBuffer, 0, byteLength);
        this.#device.queue.submit([commandEncoder.finish()]);
        validation = this.#device.popErrorScope();
      } catch (cause) {
        const validationError = await this.#device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected core node readback for ${this.nodeCount} nodes: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }

      const validationError = await validation;
      if (validationError !== null) {
        throw new Error(
          `WebGPU rejected core node readback for ${this.nodeCount} nodes: ${validationError.message}`,
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

function decodeCoreNodes(words: DataView, nodeCount: number): readonly CoreNode[] {
  const expectedByteLength = nodeCount * NODE_BYTE_LENGTH;
  if (words.byteLength !== expectedByteLength) {
    throw new Error(
      `GPU core readback has ${words.byteLength} bytes for ${nodeCount} nodes; expected ${expectedByteLength}`,
    );
  }
  const nodes = new Array<CoreNode>(nodeCount);
  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
    const byteOffset = nodeIndex * NODE_BYTE_LENGTH;
    const tag = decodeCoreTag(words.getUint32(byteOffset, true), nodeIndex);
    nodes[nodeIndex] = Object.freeze({
      tag,
      payload: words.getUint32(byteOffset + 4, true),
      child0: words.getUint32(byteOffset + 8, true),
      child1: words.getUint32(byteOffset + 12, true),
      child2: words.getUint32(byteOffset + 16, true),
      sourceByteOffset: words.getUint32(byteOffset + 20, true),
      sourceEndByte: words.getUint32(byteOffset + 24, true),
      evaluationMode: decodeEvaluationMode(words.getUint32(byteOffset + 28, true), nodeIndex),
    });
  }
  return Object.freeze(nodes);
}

function decodeEvaluationMode(value: number, nodeIndex: number): EvaluationMode {
  if (value === 0 || value === 1) return value;
  throw new Error(
    `GPU module contains unknown evaluation mode ${value} at node ${nodeIndex}`,
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function decodeCoreTag(tag: number, nodeIndex: number): KnownCoreTag {
  switch (tag) {
    case CoreTag.Integer:
    case CoreTag.SignedInteger64:
    case CoreTag.Float32:
    case CoreTag.Float64:
    case CoreTag.WholeNumberF64:
    case CoreTag.BufferAppend:
    case CoreTag.StoreNew:
    case CoreTag.StoreLength:
    case CoreTag.StoreRead:
    case CoreTag.StoreWrite:
    case CoreTag.StoreGrow:
    case CoreTag.Text:
    case CoreTag.Bytes:
    case CoreTag.RuntimeFault:
    case CoreTag.NumericConvert:
    case CoreTag.Boolean:
    case CoreTag.Let:
    case CoreTag.If:
    case CoreTag.Lambda:
    case CoreTag.Apply:
    case CoreTag.Unary:
    case CoreTag.Binary:
    case CoreTag.Case:
    case CoreTag.CaseArm:
    case CoreTag.PatternBind:
    case CoreTag.LetRec:
    case CoreTag.Local:
    case CoreTag.Global:
    case CoreTag.Constructor:
      return tag;
    default:
      throw new Error(`GPU module contains unknown core tag ${tag} at node ${nodeIndex}`);
  }
}

function constructorNames(surface: EncodedSemanticSurface): string[] {
  const names: string[] = [];
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const symbol = surface.constructorWords[
      constructorIndex * CONSTRUCTOR_WORD_LENGTH + ConstructorWord.Symbol
    ];
    if (symbol === undefined) {
      throw new Error(`frontend omitted constructor symbol ${constructorIndex}`);
    }
    names.push(surface.symbolNames[symbol] ?? `<symbol ${symbol}>`);
  }
  return names;
}

function constructorArities(surface: EncodedSemanticSurface): number[] {
  const arities: number[] = [];
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const arity = surface.constructorWords[
      constructorIndex * CONSTRUCTOR_WORD_LENGTH + ConstructorWord.Arity
    ];
    if (arity === undefined) {
      throw new Error(`frontend omitted constructor arity ${constructorIndex}`);
    }
    arities.push(arity);
  }
  return arities;
}
