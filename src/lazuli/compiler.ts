import { LAZULI_COMPILER_SHADER } from "./compiler_shader.ts";
import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_BYTE_LENGTH,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_BYTE_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_MAXIMUM_PARSE_DEPTH,
  LAZULI_MAXIMUM_SOURCE_BYTE_LENGTH,
  LAZULI_MAXIMUM_SURFACE_NODES,
  LAZULI_NO_INDEX,
  LAZULI_NODE_BYTE_LENGTH,
  LAZULI_NODE_WORD_LENGTH,
  LAZULI_TYPE_BYTE_LENGTH,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliConstructorWord,
  LazuliCoreTag,
  type LazuliCoreTag as KnownLazuliCoreTag,
  type LazuliDiagnostic,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
  LazuliTypeWord,
} from "./abi.ts";
import { parseLazuliSource } from "./frontend.ts";

const COMPILATION_STATE_BYTE_LENGTH = 40;
const MAXIMUM_SEMANTIC_COMPILER_ITERATIONS = 1_000_000;

const StateWord = {
  NodeCount: 0,
  DefinitionCount: 1,
  TypeCount: 2,
  ConstructorCount: 3,
  EntrySymbol: 4,
  Status: 5,
  ErrorCode: 6,
  ErrorSource: 7,
  ErrorDetail: 8,
  EntryDefinition: 9,
} as const;

const Status = {
  Ok: 1,
  Diagnostic: 2,
  InvalidSurface: 3,
} as const;

const ErrorCode = {
  None: 0,
  UnknownName: 1,
  DuplicateDefinition: 2,
  MissingMain: 3,
  DuplicateType: 4,
  DuplicateConstructor: 5,
  DefinitionConstructorCollision: 6,
  UnknownCaseConstructor: 7,
  PatternArityMismatch: 8,
  DuplicateCaseArm: 9,
  InvalidCounts: 100,
  InvalidNode: 101,
  InvalidDefinition: 102,
  InvalidType: 103,
  InvalidConstructor: 104,
} as const;

export interface LazuliCoreNode {
  readonly tag: LazuliCoreTag;
  readonly payload: number;
  readonly child0: number;
  readonly child1: number;
  readonly child2: number;
  readonly sourceByteOffset: number;
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
  readCoreNodes(): Promise<readonly LazuliCoreNode[]>;
  destroy(): void;
}

export type LazuliCompileResult =
  | { readonly ok: true; readonly module: GpuLazuliModule }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [LazuliDiagnostic, ...LazuliDiagnostic[]];
  };

class CompiledGpuLazuliModule implements GpuLazuliModule {
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

  readonly #device: GPUDevice;
  #destroyed = false;

  constructor(
    device: GPUDevice,
    nodeBuffer: GPUBuffer,
    definitionBuffer: GPUBuffer,
    constructorBuffer: GPUBuffer,
    nodeCount: number,
    definitionCount: number,
    typeCount: number,
    constructorNames: readonly string[],
    constructorArities: readonly number[],
    entryDefinition: number,
  ) {
    this.#device = device;
    this.nodeBuffer = nodeBuffer;
    this.definitionBuffer = definitionBuffer;
    this.constructorBuffer = constructorBuffer;
    this.nodeCount = nodeCount;
    this.definitionCount = definitionCount;
    this.constructorCount = constructorNames.length;
    this.typeCount = typeCount;
    this.constructorNames = Object.freeze([...constructorNames]);
    this.constructorArities = Object.freeze([...constructorArities]);
    this.entryDefinition = entryDefinition;
  }

  async readCoreNodes(): Promise<readonly LazuliCoreNode[]> {
    if (this.#destroyed) {
      throw new Error("cannot read a destroyed GPU Lazuli module");
    }
    if (this.nodeCount === 0) {
      return [];
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
      const nodes: LazuliCoreNode[] = [];
      for (let nodeIndex = 0; nodeIndex < this.nodeCount; nodeIndex++) {
        const byteOffset = nodeIndex * LAZULI_NODE_BYTE_LENGTH;
        const tag = decodeCoreTag(words.getUint32(byteOffset, true), nodeIndex);
        nodes.push({
          tag,
          payload: words.getUint32(byteOffset + 4, true),
          child0: words.getUint32(byteOffset + 8, true),
          child1: words.getUint32(byteOffset + 12, true),
          child2: words.getUint32(byteOffset + 16, true),
          sourceByteOffset: words.getUint32(byteOffset + 20, true),
        });
      }
      return nodes;
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

export class GpuLazuliCompiler {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;
  readonly #maximumSourceByteLength: number;
  readonly #maximumNodeCount: number;
  readonly #maximumDefinitionCount: number;
  readonly #maximumTypeCount: number;
  readonly #maximumConstructorCount: number;
  #compilationTail: Promise<void> = Promise.resolve();

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    maximumSourceByteLength: number,
    maximumNodeCount: number,
    maximumDefinitionCount: number,
    maximumTypeCount: number,
    maximumConstructorCount: number,
  ) {
    this.#device = device;
    this.#pipeline = pipeline;
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

    const shaderModule = device.createShaderModule({
      label: "Lazuli semantic compiler",
      code: LAZULI_COMPILER_SHADER,
    });
    const compilation = await shaderModule.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length > 0) {
      const formattedErrors = errors.map((message) =>
        `${message.lineNum}:${message.linePos}: ${message.message}`
      ).join("\n");
      throw new Error(`WebGPU rejected the Lazuli compiler shader:\n${formattedErrors}`);
    }

    try {
      const pipeline = await device.createComputePipelineAsync({
        label: "Lazuli semantic compiler pipeline",
        layout: "auto",
        compute: {
          module: shaderModule,
          entryPoint: "compile_lazuli",
        },
      });
      return new GpuLazuliCompiler(
        device,
        pipeline,
        maximumSourceByteLength,
        maximumNodeCount,
        maximumDefinitionCount,
        maximumTypeCount,
        maximumConstructorCount,
      );
    } catch (cause) {
      throw new Error("WebGPU could not create the Lazuli semantic compiler pipeline", { cause });
    }
  }

  async compile(source: string): Promise<LazuliCompileResult> {
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

    let nameNodeCount = 0;
    let caseArmNodeCount = 0;
    for (let nodeIndex = 0; nodeIndex < surface.nodeCount; nodeIndex++) {
      const tag = surface.nodeWords[nodeIndex * LAZULI_NODE_WORD_LENGTH + LazuliSurfaceWord.Tag];
      if (tag === LazuliSurfaceTag.Name) nameNodeCount++;
      if (tag === LazuliSurfaceTag.CaseArm) caseArmNodeCount++;
    }
    const triangularDefinitionIterations = surface.definitionCount *
      (surface.definitionCount - 1) / 2;
    const triangularTypeIterations = surface.typeCount * (surface.typeCount - 1) / 2;
    const triangularConstructorIterations = surface.constructorCount *
      (surface.constructorCount - 1) / 2;
    const semanticIterationEstimate = triangularDefinitionIterations +
      triangularTypeIterations + triangularConstructorIterations +
      surface.constructorCount * surface.definitionCount + surface.definitionCount +
      surface.nodeCount +
      nameNodeCount *
        (LAZULI_MAXIMUM_PARSE_DEPTH + surface.definitionCount + surface.constructorCount) +
      caseArmNodeCount * (surface.constructorCount + LAZULI_MAXIMUM_PARSE_DEPTH) +
      caseArmNodeCount * caseArmNodeCount;
    if (semanticIterationEstimate > MAXIMUM_SEMANTIC_COMPILER_ITERATIONS) {
      return {
        ok: false,
        diagnostics: [semanticWorkLimitDiagnostic(
          semanticIterationEstimate,
          sourceByteLength,
        )],
      };
    }

    return await this.#runExclusively(() => this.#compileSurface(surface, sourceByteLength));
  }

  async #runExclusively<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previousCompilation = this.#compilationTail;
    let release: (() => void) | undefined;
    this.#compilationTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previousCompilation;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  async #compileSurface(
    surface: EncodedLazuliSurface,
    sourceByteLength: number,
  ): Promise<LazuliCompileResult> {
    const surfaceNodeBytes = encodeWords(surface.nodeWords);
    const definitionBytes = encodeWords(surface.definitionWords);
    const typeBytes = encodeWords(surface.typeWords);
    const constructorBytes = encodeWords(surface.constructorWords);
    const initialState = new ArrayBuffer(COMPILATION_STATE_BYTE_LENGTH);
    const initialStateView = new DataView(initialState);
    initialStateView.setUint32(StateWord.NodeCount * 4, surface.nodeCount, true);
    initialStateView.setUint32(StateWord.DefinitionCount * 4, surface.definitionCount, true);
    initialStateView.setUint32(StateWord.TypeCount * 4, surface.typeCount, true);
    initialStateView.setUint32(StateWord.ConstructorCount * 4, surface.constructorCount, true);
    initialStateView.setUint32(StateWord.EntrySymbol * 4, surface.mainSymbol, true);
    initialStateView.setUint32(StateWord.Status * 4, 0, true);
    initialStateView.setUint32(StateWord.ErrorCode * 4, ErrorCode.None, true);
    initialStateView.setUint32(StateWord.ErrorSource * 4, LAZULI_NO_INDEX, true);
    initialStateView.setUint32(StateWord.ErrorDetail * 4, LAZULI_NO_INDEX, true);
    initialStateView.setUint32(StateWord.EntryDefinition * 4, LAZULI_NO_INDEX, true);

    let surfaceNodeBuffer: GPUBuffer | undefined;
    let coreNodeBuffer: GPUBuffer | undefined;
    let definitionBuffer: GPUBuffer | undefined;
    let typeBuffer: GPUBuffer | undefined;
    let constructorBuffer: GPUBuffer | undefined;
    let stateBuffer: GPUBuffer | undefined;
    let stateReadbackBuffer: GPUBuffer | undefined;
    let stateReadbackMapped = false;
    let nodeBufferTransferred = false;
    let definitionBufferTransferred = false;
    let constructorBufferTransferred = false;

    try {
      this.#device.pushErrorScope("validation");
      let validation: Promise<GPUError | null>;
      try {
        surfaceNodeBuffer = this.#device.createBuffer({
          label: "Lazuli surface nodes",
          size: storageBufferSize(surface.nodeCount, LAZULI_NODE_BYTE_LENGTH),
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        definitionBuffer = this.#device.createBuffer({
          label: "Lazuli definitions",
          size: storageBufferSize(surface.definitionCount, LAZULI_DEFINITION_BYTE_LENGTH),
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        typeBuffer = this.#device.createBuffer({
          label: "Lazuli algebraic types",
          size: storageBufferSize(surface.typeCount, LAZULI_TYPE_BYTE_LENGTH),
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        constructorBuffer = this.#device.createBuffer({
          label: "Lazuli constructors",
          size: storageBufferSize(surface.constructorCount, LAZULI_CONSTRUCTOR_BYTE_LENGTH),
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        coreNodeBuffer = this.#device.createBuffer({
          label: "Lazuli core nodes",
          size: storageBufferSize(surface.nodeCount, LAZULI_NODE_BYTE_LENGTH),
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateBuffer = this.#device.createBuffer({
          label: "Lazuli compilation state",
          size: COMPILATION_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateReadbackBuffer = this.#device.createBuffer({
          label: "Lazuli compilation state readback",
          size: COMPILATION_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        this.#device.queue.writeBuffer(surfaceNodeBuffer, 0, surfaceNodeBytes);
        this.#device.queue.writeBuffer(definitionBuffer, 0, definitionBytes);
        this.#device.queue.writeBuffer(typeBuffer, 0, typeBytes);
        this.#device.queue.writeBuffer(constructorBuffer, 0, constructorBytes);
        this.#device.queue.writeBuffer(stateBuffer, 0, initialState);

        const bindGroup = this.#device.createBindGroup({
          label: "Lazuli semantic compiler bindings",
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: surfaceNodeBuffer } },
            { binding: 1, resource: { buffer: definitionBuffer } },
            { binding: 2, resource: { buffer: typeBuffer } },
            { binding: 3, resource: { buffer: constructorBuffer } },
            { binding: 4, resource: { buffer: coreNodeBuffer } },
            { binding: 5, resource: { buffer: stateBuffer } },
          ],
        });
        const commandEncoder = this.#device.createCommandEncoder({
          label: "Lazuli semantic compilation commands",
        });
        const computePass = commandEncoder.beginComputePass({
          label: "Compile Lazuli surface nodes",
        });
        computePass.setPipeline(this.#pipeline);
        computePass.setBindGroup(0, bindGroup);
        computePass.dispatchWorkgroups(1);
        computePass.end();
        commandEncoder.copyBufferToBuffer(
          stateBuffer,
          0,
          stateReadbackBuffer,
          0,
          COMPILATION_STATE_BYTE_LENGTH,
        );
        this.#device.queue.submit([commandEncoder.finish()]);
        validation = this.#device.popErrorScope();
      } catch (cause) {
        const validationError = await this.#device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli compilation for ${surface.nodeCount} nodes, ${surface.definitionCount} definitions, ${surface.typeCount} types, and ${surface.constructorCount} constructors: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }

      const validationError = await validation;
      if (validationError !== null) {
        throw new Error(
          `WebGPU rejected Lazuli compilation for ${surface.nodeCount} nodes, ${surface.definitionCount} definitions, ${surface.typeCount} types, and ${surface.constructorCount} constructors: ${validationError.message}`,
        );
      }

      try {
        await stateReadbackBuffer.mapAsync(GPUMapMode.READ);
      } catch (cause) {
        throw new Error(
          `could not read GPU Lazuli compilation status for ${surface.nodeCount} nodes`,
          { cause },
        );
      }
      stateReadbackMapped = true;
      const completedState = new DataView(stateReadbackBuffer.getMappedRange().slice(0));
      const state = readCompletedState(completedState);

      if (state.status === Status.Ok) {
        if (
          state.nodeCount !== surface.nodeCount ||
          state.definitionCount !== surface.definitionCount ||
          state.typeCount !== surface.typeCount ||
          state.constructorCount !== surface.constructorCount ||
          state.errorCode !== ErrorCode.None ||
          state.errorSource !== LAZULI_NO_INDEX ||
          state.errorDetail !== LAZULI_NO_INDEX ||
          state.entryDefinition >= surface.definitionCount
        ) {
          throw new Error(
            `GPU Lazuli compiler returned inconsistent success state: ${formatState(state)}`,
          );
        }
        const module = new CompiledGpuLazuliModule(
          this.#device,
          coreNodeBuffer,
          definitionBuffer,
          constructorBuffer,
          surface.nodeCount,
          surface.definitionCount,
          surface.typeCount,
          constructorNames(surface),
          constructorArities(surface),
          state.entryDefinition,
        );
        nodeBufferTransferred = true;
        definitionBufferTransferred = true;
        constructorBufferTransferred = true;
        return { ok: true, module };
      }

      if (state.status === Status.Diagnostic) {
        const diagnostic = diagnosticFromState(state, surface, sourceByteLength);
        if (diagnostic === undefined) {
          throw new Error(
            `GPU Lazuli compiler returned inconsistent diagnostic state: ${formatState(state)}`,
          );
        }
        return { ok: false, diagnostics: [diagnostic] };
      }

      if (state.status === Status.InvalidSurface) {
        throw new Error(
          `GPU Lazuli compiler rejected an impossible encoded surface: ${
            formatInvalidSurfaceState(state)
          }`,
        );
      }

      throw new Error(`GPU Lazuli compiler returned unknown status: ${formatState(state)}`);
    } finally {
      if (stateReadbackMapped) {
        stateReadbackBuffer?.unmap();
      }
      surfaceNodeBuffer?.destroy();
      typeBuffer?.destroy();
      stateBuffer?.destroy();
      stateReadbackBuffer?.destroy();
      if (!nodeBufferTransferred) {
        coreNodeBuffer?.destroy();
      }
      if (!definitionBufferTransferred) {
        definitionBuffer?.destroy();
      }
      if (!constructorBufferTransferred) {
        constructorBuffer?.destroy();
      }
    }
  }
}

type CompletedState = Readonly<{
  nodeCount: number;
  definitionCount: number;
  typeCount: number;
  constructorCount: number;
  entrySymbol: number;
  status: number;
  errorCode: number;
  errorSource: number;
  errorDetail: number;
  entryDefinition: number;
}>;

function readCompletedState(state: DataView): CompletedState {
  return {
    nodeCount: state.getUint32(StateWord.NodeCount * 4, true),
    definitionCount: state.getUint32(StateWord.DefinitionCount * 4, true),
    typeCount: state.getUint32(StateWord.TypeCount * 4, true),
    constructorCount: state.getUint32(StateWord.ConstructorCount * 4, true),
    entrySymbol: state.getUint32(StateWord.EntrySymbol * 4, true),
    status: state.getUint32(StateWord.Status * 4, true),
    errorCode: state.getUint32(StateWord.ErrorCode * 4, true),
    errorSource: state.getUint32(StateWord.ErrorSource * 4, true),
    errorDetail: state.getUint32(StateWord.ErrorDetail * 4, true),
    entryDefinition: state.getUint32(StateWord.EntryDefinition * 4, true),
  };
}

function diagnosticFromState(
  state: CompletedState,
  surface: EncodedLazuliSurface,
  sourceByteLength: number,
): LazuliDiagnostic | undefined {
  const symbolName = symbolNameFor(surface, state.errorDetail);
  switch (state.errorCode) {
    case ErrorCode.UnknownName: {
      const span = nodeSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2001",
        message: `unknown name ${symbolName}`,
        span,
      };
    }
    case ErrorCode.DuplicateDefinition: {
      const span = definitionSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2002",
        message: `duplicate top-level definition ${symbolName}`,
        span,
      };
    }
    case ErrorCode.MissingMain:
      if (state.errorSource !== LAZULI_NO_INDEX || state.errorDetail !== surface.mainSymbol) {
        return undefined;
      }
      return {
        stage: "compile",
        code: "L2003",
        message: `missing required entry definition ${symbolName}`,
        span: { startByte: sourceByteLength, endByte: sourceByteLength },
      };
    case ErrorCode.DuplicateType: {
      const span = typeSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2004",
        message: `duplicate algebraic type ${symbolName}`,
        span,
      };
    }
    case ErrorCode.DuplicateConstructor: {
      const span = constructorSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2005",
        message: `duplicate constructor ${symbolName}`,
        span,
      };
    }
    case ErrorCode.DefinitionConstructorCollision: {
      const span = topLevelSymbolSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2006",
        message: `top-level function and constructor share the name ${symbolName}`,
        span,
      };
    }
    case ErrorCode.UnknownCaseConstructor: {
      const span = surfaceNodeSpanAt(
        surface,
        state.errorSource,
        state.errorDetail,
        LazuliSurfaceTag.CaseArm,
      );
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2007",
        message: `unknown case constructor ${symbolName}`,
        span,
      };
    }
    case ErrorCode.PatternArityMismatch: {
      const arm = caseArmDetails(surface, state.errorSource, state.errorDetail);
      if (arm === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2008",
        message: `constructor ${
          symbolNameFor(surface, arm.constructorSymbol)
        } expects ${arm.arity} pattern binders, received ${arm.binderCount}`,
        span: arm.span,
      };
    }
    case ErrorCode.DuplicateCaseArm: {
      const span = surfaceNodeSpanAt(
        surface,
        state.errorSource,
        state.errorDetail,
        LazuliSurfaceTag.CaseArm,
      );
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2009",
        message: `duplicate case arm for constructor ${symbolName}`,
        span,
      };
    }
    default:
      return undefined;
  }
}

function nodeSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  for (let nodeIndex = 0; nodeIndex < surface.nodeCount; nodeIndex++) {
    const wordOffset = nodeIndex * LAZULI_NODE_WORD_LENGTH;
    if (
      surface.nodeWords[wordOffset + LazuliSurfaceWord.Tag] === LazuliSurfaceTag.Name &&
      surface.nodeWords[wordOffset + LazuliSurfaceWord.StartByte] === startByte &&
      surface.nodeWords[wordOffset + LazuliSurfaceWord.Payload] === symbol
    ) {
      const endByte = surface.nodeWords[wordOffset + LazuliSurfaceWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function definitionSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  for (let definitionIndex = 0; definitionIndex < surface.definitionCount; definitionIndex++) {
    const wordOffset = definitionIndex * LAZULI_DEFINITION_WORD_LENGTH;
    if (
      surface.definitionWords[wordOffset] === symbol &&
      surface.definitionWords[wordOffset + 2] === startByte
    ) {
      const endByte = surface.definitionWords[wordOffset + 3];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function typeSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  for (let typeIndex = 0; typeIndex < surface.typeCount; typeIndex++) {
    const wordOffset = typeIndex * LAZULI_TYPE_WORD_LENGTH;
    if (
      surface.typeWords[wordOffset + LazuliTypeWord.Symbol] === symbol &&
      surface.typeWords[wordOffset + LazuliTypeWord.StartByte] === startByte
    ) {
      const endByte = surface.typeWords[wordOffset + LazuliTypeWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function constructorSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const wordOffset = constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH;
    if (
      surface.constructorWords[wordOffset + LazuliConstructorWord.Symbol] === symbol &&
      surface.constructorWords[wordOffset + LazuliConstructorWord.StartByte] === startByte
    ) {
      const endByte = surface.constructorWords[wordOffset + LazuliConstructorWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function topLevelSymbolSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  return definitionSpanAt(surface, startByte, symbol) ??
    constructorSpanAt(surface, startByte, symbol);
}

function surfaceNodeSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
  tag: number,
): LazuliDiagnostic["span"] | undefined {
  for (let nodeIndex = 0; nodeIndex < surface.nodeCount; nodeIndex++) {
    const wordOffset = nodeIndex * LAZULI_NODE_WORD_LENGTH;
    if (
      surface.nodeWords[wordOffset + LazuliSurfaceWord.Tag] === tag &&
      surface.nodeWords[wordOffset + LazuliSurfaceWord.StartByte] === startByte &&
      surface.nodeWords[wordOffset + LazuliSurfaceWord.Payload] === symbol
    ) {
      const endByte = surface.nodeWords[wordOffset + LazuliSurfaceWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function caseArmDetails(
  surface: EncodedLazuliSurface,
  startByte: number,
  armIndex: number,
): {
  readonly constructorSymbol: number;
  readonly arity: number;
  readonly binderCount: number;
  readonly span: LazuliDiagnostic["span"];
} | undefined {
  if (armIndex >= surface.nodeCount) return undefined;
  const armOffset = armIndex * LAZULI_NODE_WORD_LENGTH;
  if (
    surface.nodeWords[armOffset + LazuliSurfaceWord.Tag] !== LazuliSurfaceTag.CaseArm ||
    surface.nodeWords[armOffset + LazuliSurfaceWord.StartByte] !== startByte
  ) {
    return undefined;
  }
  const constructorSymbol = surface.nodeWords[armOffset + LazuliSurfaceWord.Payload];
  const endByte = surface.nodeWords[armOffset + LazuliSurfaceWord.EndByte];
  const firstPatternOrBody = surface.nodeWords[armOffset + LazuliSurfaceWord.Child0];
  if (
    constructorSymbol === undefined || endByte === undefined || firstPatternOrBody === undefined
  ) {
    return undefined;
  }

  let binderCount = 0;
  let nodeIndex: number = firstPatternOrBody;
  while (nodeIndex < surface.nodeCount) {
    const nodeOffset: number = nodeIndex * LAZULI_NODE_WORD_LENGTH;
    if (surface.nodeWords[nodeOffset + LazuliSurfaceWord.Tag] !== LazuliSurfaceTag.PatternBind) {
      break;
    }
    binderCount++;
    const child: number | undefined = surface.nodeWords[nodeOffset + LazuliSurfaceWord.Child0];
    if (child === undefined) return undefined;
    nodeIndex = child;
  }

  const constructorIndex = findConstructor(surface, constructorSymbol);
  if (constructorIndex === undefined) return undefined;
  const arity = surface.constructorWords[
    constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH + LazuliConstructorWord.Arity
  ];
  if (arity === undefined) return undefined;
  return {
    constructorSymbol,
    arity,
    binderCount,
    span: { startByte, endByte },
  };
}

function symbolNameFor(surface: EncodedLazuliSurface, symbol: number): string {
  const symbolName = surface.symbolNames[symbol];
  return symbolName === undefined ? `<symbol ${symbol}>` : JSON.stringify(symbolName);
}

function sourceTooLargeDiagnostic(
  sourceByteLength: number,
  maximumSourceByteLength: number,
): LazuliDiagnostic {
  return {
    stage: "parse",
    code: "L1003",
    message:
      `source is ${sourceByteLength} UTF-8 bytes; this compiler accepts at most ${maximumSourceByteLength}`,
    span: { startByte: maximumSourceByteLength, endByte: sourceByteLength },
  };
}

function nodeLimitDiagnostic(nodeCount: number, maximumNodeCount: number): LazuliDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program has ${nodeCount} surface nodes; this device accepts at most ${maximumNodeCount}`,
    span: { startByte: 0, endByte: 0 },
  };
}

function definitionLimitDiagnostic(
  definitionCount: number,
  maximumDefinitionCount: number,
): LazuliDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program has ${definitionCount} definitions; this device accepts at most ${maximumDefinitionCount}`,
    span: { startByte: 0, endByte: 0 },
  };
}

function typeLimitDiagnostic(typeCount: number, maximumTypeCount: number): LazuliDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program has ${typeCount} algebraic types; this device accepts at most ${maximumTypeCount}`,
    span: { startByte: 0, endByte: 0 },
  };
}

function constructorLimitDiagnostic(
  constructorCount: number,
  maximumConstructorCount: number,
): LazuliDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program has ${constructorCount} constructors; this device accepts at most ${maximumConstructorCount}`,
    span: { startByte: 0, endByte: 0 },
  };
}

function semanticWorkLimitDiagnostic(
  semanticIterationEstimate: number,
  sourceByteLength: number,
): LazuliDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program's serial semantic work estimate is ${semanticIterationEstimate} iterations; the compiler limit is ${MAXIMUM_SEMANTIC_COMPILER_ITERATIONS}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
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

function findConstructor(surface: EncodedLazuliSurface, symbol: number): number | undefined {
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const wordOffset = constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH;
    if (surface.constructorWords[wordOffset + LazuliConstructorWord.Symbol] === symbol) {
      return constructorIndex;
    }
  }
  return undefined;
}

function constructorNames(surface: EncodedLazuliSurface): readonly string[] {
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

function constructorArities(surface: EncodedLazuliSurface): readonly number[] {
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

function storageBufferSize(recordCount: number, recordByteLength: number): number {
  return Math.max(recordByteLength, recordCount * recordByteLength);
}

function encodeWords(words: Uint32Array): ArrayBuffer {
  const bytes = new ArrayBuffer(Math.max(4, words.byteLength));
  const view = new DataView(bytes);
  for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
    const word = words[wordIndex];
    if (word === undefined) {
      throw new Error(`missing Lazuli ABI word ${wordIndex}`);
    }
    view.setUint32(wordIndex * 4, word, true);
  }
  return bytes;
}

function decodeCoreTag(tag: number, nodeIndex: number): KnownLazuliCoreTag {
  switch (tag) {
    case LazuliCoreTag.Integer:
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

function formatState(state: CompletedState): string {
  return `nodeCount=${state.nodeCount}, definitionCount=${state.definitionCount}, typeCount=${state.typeCount}, constructorCount=${state.constructorCount}, entrySymbol=${state.entrySymbol}, status=${state.status}, errorCode=${state.errorCode}, errorSource=${state.errorSource}, errorDetail=${state.errorDetail}, entryDefinition=${state.entryDefinition}`;
}

function formatInvalidSurfaceState(state: CompletedState): string {
  const reason = (() => {
    switch (state.errorCode) {
      case ErrorCode.InvalidCounts:
        return "record counts exceed their bound storage buffers";
      case ErrorCode.InvalidNode:
        return `node ${state.errorDetail} violates a tag, child, parent, or preorder invariant`;
      case ErrorCode.InvalidDefinition:
        return `definition ${state.errorDetail} violates a root or source-order invariant`;
      case ErrorCode.InvalidType:
        return `type ${state.errorDetail} violates a constructor-range or source-order invariant`;
      case ErrorCode.InvalidConstructor:
        return `constructor ${state.errorDetail} violates a type, arity, or source-order invariant`;
      default:
        return `unknown invariant error ${state.errorCode}`;
    }
  })();
  return `${reason}; ${formatState(state)}`;
}
