import {
  LAZULI_CONSTRUCTOR_BYTE_LENGTH,
  LAZULI_DEFINITION_BYTE_LENGTH,
  LAZULI_MAXIMUM_CONSTRUCTOR_ARITY,
  LAZULI_NO_INDEX,
  LAZULI_NODE_BYTE_LENGTH,
} from "./abi.ts";
import type { GpuLazuliModule } from "./compiler.ts";
import { LAZULI_EVALUATOR_SHADER } from "./evaluator_shader.ts";

const HEAP_SLOT_BYTE_LENGTH = 32;
const STACK_FRAME_BYTE_LENGTH = 32;
const EVALUATION_STATE_WORD_LENGTH = 36;
const EVALUATION_STATE_BYTE_LENGTH = EVALUATION_STATE_WORD_LENGTH * Uint32Array.BYTES_PER_ELEMENT;

const HARD_MAXIMUM_STEPS = 1_000_000;
const DEFAULT_MAXIMUM_STEPS_PER_DISPATCH = 4_096;
const HARD_MAXIMUM_STEPS_PER_DISPATCH = 65_536;
const HARD_MAXIMUM_HEAP_SLOTS = 1_000_000;
const HARD_MAXIMUM_STACK_FRAMES = 262_144;

const STATUS_PENDING = 1;
const STATUS_COMPLETE = 2;
const STATUS_FAULT = 3;

const FAULT_BAD_MODULE = 1;
const FAULT_OUT_OF_FUEL = 2;
const FAULT_OUT_OF_HEAP = 3;
const FAULT_STACK_OVERFLOW = 4;
const FAULT_BLACKHOLE = 5;
const FAULT_TYPE_ERROR = 6;
const FAULT_DIVIDE_BY_ZERO = 7;
const FAULT_NON_EXHAUSTIVE_CASE = 8;

const VALUE_INTEGER = 1;
const VALUE_BOOLEAN = 2;
const VALUE_CLOSURE = 3;
const VALUE_CONSTRUCTOR_PARTIAL = 4;
const VALUE_CONSTRUCTOR = 5;

const EXPECT_INTEGER = 1;
const EXPECT_BOOLEAN = 2;
const EXPECT_CALLABLE = 3;
const EXPECT_CONSTRUCTOR = 4;

const EvaluationStateWord = {
  NodeCount: 0,
  DefinitionCount: 1,
  EntryDefinition: 2,
  MaximumSteps: 3,
  HeapCapacity: 4,
  StackCapacity: 5,
  Status: 6,
  FaultCode: 7,
  FaultSourceOffset: 8,
  FaultDetail: 9,
  Mode: 10,
  Expression: 11,
  Environment: 12,
  ValueTag: 13,
  ValuePayload: 14,
  CurrentSourceOffset: 15,
  Steps: 16,
  Allocations: 17,
  PeakStack: 18,
  ThunkEvaluations: 19,
  HeapTop: 20,
  StackTop: 21,
  LocalEnvironment: 22,
  LocalDepth: 23,
  LocalLookupActive: 24,
  ConstructorCount: 25,
  TypeCount: 26,
  CaseArm: 27,
  CasePattern: 28,
  CaseField: 29,
  CaseEnvironment: 30,
  CaseRemaining: 31,
  CaseConstructor: 32,
  CaseSourceOffset: 33,
  MaximumStepsPerDispatch: 34,
  InitializationDefinition: 35,
} as const;

export interface LazuliEvaluationOptions {
  readonly maximumSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly heapSlots?: number;
  readonly stackFrames?: number;
  readonly signal?: AbortSignal;
}

export type LazuliValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "closure" }
  | { readonly kind: "constructor"; readonly name: string; readonly fieldCount: number };

export interface LazuliEvaluationStats {
  readonly steps: number;
  readonly allocations: number;
  readonly peakStack: number;
  readonly thunkEvaluations: number;
}

export type LazuliRuntimeFault =
  | {
    readonly kind: "bad-module";
    readonly code: "L3001";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "out-of-fuel";
    readonly code: "L3002";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "out-of-heap";
    readonly code: "L3003";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "stack-overflow";
    readonly code: "L3004";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "blackhole";
    readonly code: "L3005";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "type-error";
    readonly code: "L3006";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "divide-by-zero";
    readonly code: "L3007";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "non-exhaustive-case";
    readonly code: "L3008";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  };

export type LazuliEvaluationResult =
  | {
    readonly ok: true;
    readonly value: LazuliValue;
    readonly stats: LazuliEvaluationStats;
  }
  | {
    readonly ok: false;
    readonly fault: LazuliRuntimeFault;
    readonly stats: LazuliEvaluationStats;
  };

interface EvaluationLimits {
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
  readonly heapSlots: number;
  readonly stackFrames: number;
}

interface EvaluationSnapshot {
  readonly status: number;
  readonly faultCode: number;
  readonly faultSourceOffset: number;
  readonly faultDetail: number;
  readonly valueTag: number;
  readonly valuePayload: number;
  readonly heapTop: number;
  readonly stackTop: number;
  readonly initializationDefinition: number;
  readonly stats: LazuliEvaluationStats;
}

type NumericEvaluationOption = Exclude<keyof LazuliEvaluationOptions, "signal">;

function badModuleFault(message: string): LazuliEvaluationResult {
  return {
    ok: false,
    fault: {
      kind: "bad-module",
      code: "L3001",
      message,
      sourceByteOffset: null,
    },
    stats: {
      steps: 0,
      allocations: 0,
      peakStack: 0,
      thunkEvaluations: 0,
    },
  };
}

function checkedByteLength(count: number, elementByteLength: number): number | null {
  if (!Number.isSafeInteger(count) || count < 0 || count > LAZULI_NO_INDEX - 1) {
    return null;
  }
  const byteLength = count * elementByteLength;
  return Number.isSafeInteger(byteLength) ? byteLength : null;
}

function boundedOption(
  name: NumericEvaluationOption,
  provided: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const value = provided ?? defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}; received ${value}`);
  }
  return value;
}

function expectedValueName(expected: number): string {
  switch (expected) {
    case EXPECT_INTEGER:
      return "integer";
    case EXPECT_BOOLEAN:
      return "boolean";
    case EXPECT_CALLABLE:
      return "callable";
    case EXPECT_CONSTRUCTOR:
      return "constructor";
    default:
      return `unknown value kind ${expected}`;
  }
}

function actualValueName(tag: number): string {
  switch (tag) {
    case VALUE_INTEGER:
      return "integer";
    case VALUE_BOOLEAN:
      return "boolean";
    case VALUE_CLOSURE:
    case VALUE_CONSTRUCTOR_PARTIAL:
      return "callable";
    case VALUE_CONSTRUCTOR:
      return "constructor";
    default:
      return `unknown value tag ${tag}`;
  }
}

function decodeFault(
  state: EvaluationSnapshot,
  limits: EvaluationLimits,
  module: GpuLazuliModule,
): LazuliRuntimeFault {
  const sourceByteOffset = state.faultSourceOffset === LAZULI_NO_INDEX
    ? null
    : state.faultSourceOffset;

  switch (state.faultCode) {
    case FAULT_BAD_MODULE:
      return {
        kind: "bad-module",
        code: "L3001",
        message: `module contains an invalid tag or index (${state.faultDetail})`,
        sourceByteOffset,
      };
    case FAULT_OUT_OF_FUEL:
      return {
        kind: "out-of-fuel",
        code: "L3002",
        message: `evaluation exhausted its limit of ${limits.maximumSteps} steps`,
        sourceByteOffset,
      };
    case FAULT_OUT_OF_HEAP:
      return {
        kind: "out-of-heap",
        code: "L3003",
        message: `evaluation exhausted its heap of ${limits.heapSlots} slots`,
        sourceByteOffset,
      };
    case FAULT_STACK_OVERFLOW:
      return {
        kind: "stack-overflow",
        code: "L3004",
        message: `evaluation exhausted its continuation stack of ${limits.stackFrames} frames`,
        sourceByteOffset,
      };
    case FAULT_BLACKHOLE:
      return {
        kind: "blackhole",
        code: "L3005",
        message: `evaluation demanded thunk ${state.faultDetail} while it was already evaluating`,
        sourceByteOffset,
      };
    case FAULT_TYPE_ERROR:
      return {
        kind: "type-error",
        code: "L3006",
        message: `expected ${expectedValueName(state.faultDetail)}, received ${
          actualValueName(state.valueTag)
        }`,
        sourceByteOffset,
      };
    case FAULT_DIVIDE_BY_ZERO:
      return {
        kind: "divide-by-zero",
        code: "L3007",
        message: "integer division by zero",
        sourceByteOffset,
      };
    case FAULT_NON_EXHAUSTIVE_CASE: {
      const constructorName = module.constructorNames[state.faultDetail];
      if (state.faultDetail >= module.constructorCount || typeof constructorName !== "string") {
        throw new Error(
          `GPU Lazuli evaluator returned invalid non-exhaustive constructor ${state.faultDetail}`,
        );
      }
      return {
        kind: "non-exhaustive-case",
        code: "L3008",
        message: `non-exhaustive case: no arm matches constructor "${constructorName}"`,
        sourceByteOffset,
      };
    }
    default:
      throw new Error(`GPU Lazuli evaluator returned unknown fault code ${state.faultCode}`);
  }
}

function decodeValue(
  valueTag: number,
  valuePayload: number,
  module: GpuLazuliModule,
): LazuliValue {
  switch (valueTag) {
    case VALUE_INTEGER:
      return { kind: "integer", value: valuePayload | 0 };
    case VALUE_BOOLEAN:
      if (valuePayload > 1) {
        throw new Error(`GPU Lazuli evaluator returned invalid Boolean payload ${valuePayload}`);
      }
      return { kind: "boolean", value: valuePayload === 1 };
    case VALUE_CLOSURE:
    case VALUE_CONSTRUCTOR_PARTIAL:
      return { kind: "closure" };
    case VALUE_CONSTRUCTOR: {
      const name = module.constructorNames[valuePayload];
      const fieldCount = module.constructorArities[valuePayload];
      if (
        valuePayload >= module.constructorCount || typeof name !== "string" ||
        typeof fieldCount !== "number" || !Number.isSafeInteger(fieldCount) || fieldCount < 0 ||
        fieldCount > LAZULI_MAXIMUM_CONSTRUCTOR_ARITY
      ) {
        throw new Error(
          `GPU Lazuli evaluator returned invalid constructor metadata for index ${valuePayload}`,
        );
      }
      return { kind: "constructor", name, fieldCount };
    }
    default:
      throw new Error(`GPU Lazuli evaluator returned unknown value tag ${valueTag}`);
  }
}

export class GpuLazuliEvaluator {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;
  readonly #maximumHeapSlots: number;
  readonly #maximumStackFrames: number;

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    maximumHeapSlots: number,
    maximumStackFrames: number,
  ) {
    this.#device = device;
    this.#pipeline = pipeline;
    this.#maximumHeapSlots = maximumHeapSlots;
    this.#maximumStackFrames = maximumStackFrames;
  }

  static async create(device: GPUDevice): Promise<GpuLazuliEvaluator> {
    const maximumStorageBytes = Math.min(
      device.limits.maxStorageBufferBindingSize,
      device.limits.maxBufferSize,
    );
    const maximumHeapSlots = Math.min(
      HARD_MAXIMUM_HEAP_SLOTS,
      Math.floor(maximumStorageBytes / HEAP_SLOT_BYTE_LENGTH),
    );
    const maximumStackFrames = Math.min(
      HARD_MAXIMUM_STACK_FRAMES,
      Math.floor(maximumStorageBytes / STACK_FRAME_BYTE_LENGTH),
    );
    if (maximumHeapSlots < 1 || maximumStackFrames < 1) {
      throw new Error(
        `WebGPU device storage limit ${maximumStorageBytes} is too small for Lazuli runtime buffers`,
      );
    }

    const shaderModule = device.createShaderModule({
      label: "Lazuli lazy evaluator",
      code: LAZULI_EVALUATOR_SHADER,
    });
    const shaderCompilation = await shaderModule.getCompilationInfo();
    const shaderErrors = shaderCompilation.messages.filter((message) => message.type === "error");
    if (shaderErrors.length > 0) {
      const formattedShaderErrors = shaderErrors.map((message) =>
        `${message.lineNum}:${message.linePos}: ${message.message}`
      ).join("\n");
      throw new Error(`WebGPU rejected the Lazuli evaluator shader:\n${formattedShaderErrors}`);
    }

    try {
      const pipeline = await device.createComputePipelineAsync({
        label: "Lazuli lazy evaluator pipeline",
        layout: "auto",
        compute: {
          module: shaderModule,
          entryPoint: "evaluate_lazuli",
        },
      });
      return new GpuLazuliEvaluator(
        device,
        pipeline,
        maximumHeapSlots,
        maximumStackFrames,
      );
    } catch (cause) {
      throw new Error("WebGPU could not create the Lazuli evaluator pipeline", { cause });
    }
  }

  async evaluate(
    module: GpuLazuliModule,
    options: LazuliEvaluationOptions = {},
  ): Promise<LazuliEvaluationResult> {
    options.signal?.throwIfAborted();

    const nodeBufferByteLength = checkedByteLength(module.nodeCount, LAZULI_NODE_BYTE_LENGTH);
    const definitionBufferByteLength = checkedByteLength(
      module.definitionCount,
      LAZULI_DEFINITION_BYTE_LENGTH,
    );
    const constructorBufferByteLength = checkedByteLength(
      module.constructorCount,
      LAZULI_CONSTRUCTOR_BYTE_LENGTH,
    );
    const constructorBindingByteLength = Math.max(
      LAZULI_CONSTRUCTOR_BYTE_LENGTH,
      constructorBufferByteLength ?? 0,
    );
    if (
      nodeBufferByteLength === null || definitionBufferByteLength === null ||
      constructorBufferByteLength === null ||
      module.nodeCount === 0 || module.definitionCount === 0 ||
      !Number.isSafeInteger(module.entryDefinition) || module.entryDefinition < 0 ||
      module.entryDefinition >= module.definitionCount ||
      !Number.isSafeInteger(module.typeCount) || module.typeCount < 0 ||
      module.typeCount >= LAZULI_NO_INDEX ||
      (module.constructorCount > 0 && module.typeCount === 0) ||
      module.constructorNames.length !== module.constructorCount ||
      module.constructorArities.length !== module.constructorCount
    ) {
      return badModuleFault(
        `module counts, metadata, or entry definition are invalid: nodes=${module.nodeCount}, definitions=${module.definitionCount}, types=${module.typeCount}, constructors=${module.constructorCount}, entry=${module.entryDefinition}`,
      );
    }

    const maximumModuleBindingSize = this.#device.limits.maxStorageBufferBindingSize;
    if (
      nodeBufferByteLength > maximumModuleBindingSize ||
      definitionBufferByteLength > maximumModuleBindingSize ||
      constructorBindingByteLength > maximumModuleBindingSize ||
      nodeBufferByteLength > this.#device.limits.maxBufferSize ||
      definitionBufferByteLength > this.#device.limits.maxBufferSize ||
      constructorBindingByteLength > this.#device.limits.maxBufferSize ||
      module.nodeBuffer.size < nodeBufferByteLength ||
      module.definitionBuffer.size < definitionBufferByteLength ||
      module.constructorBuffer.size < constructorBindingByteLength
    ) {
      return badModuleFault(
        `module buffers do not contain the declared ${module.nodeCount} nodes, ${module.definitionCount} definitions, and ${module.constructorCount} constructors within this device's limits`,
      );
    }

    const defaultMaximumSteps = Math.min(
      HARD_MAXIMUM_STEPS,
      Math.max(10_000, module.nodeCount * 64 + module.definitionCount * 8),
    );
    const defaultHeapSlots = Math.min(
      this.#maximumHeapSlots,
      Math.max(256, module.definitionCount + module.nodeCount * 4),
    );
    const defaultStackFrames = Math.min(
      this.#maximumStackFrames,
      Math.max(128, module.nodeCount * 2),
    );
    const limits: EvaluationLimits = {
      maximumSteps: boundedOption(
        "maximumSteps",
        options.maximumSteps,
        defaultMaximumSteps,
        HARD_MAXIMUM_STEPS,
      ),
      maximumStepsPerDispatch: boundedOption(
        "maximumStepsPerDispatch",
        options.maximumStepsPerDispatch,
        DEFAULT_MAXIMUM_STEPS_PER_DISPATCH,
        HARD_MAXIMUM_STEPS_PER_DISPATCH,
      ),
      heapSlots: boundedOption(
        "heapSlots",
        options.heapSlots,
        defaultHeapSlots,
        this.#maximumHeapSlots,
      ),
      stackFrames: boundedOption(
        "stackFrames",
        options.stackFrames,
        defaultStackFrames,
        this.#maximumStackFrames,
      ),
    };

    const heapBufferByteLength = limits.heapSlots * HEAP_SLOT_BYTE_LENGTH;
    const stackBufferByteLength = limits.stackFrames * STACK_FRAME_BYTE_LENGTH;
    const globalBufferByteLength = module.definitionCount * Uint32Array.BYTES_PER_ELEMENT;
    if (
      globalBufferByteLength > maximumModuleBindingSize ||
      globalBufferByteLength > this.#device.limits.maxBufferSize
    ) {
      return badModuleFault(
        `module requires ${globalBufferByteLength} bytes of global runtime storage, beyond this device's limit`,
      );
    }

    const initialState = new ArrayBuffer(EVALUATION_STATE_BYTE_LENGTH);
    const initialStateView = new DataView(initialState);
    const setInitialStateWord = (word: number, value: number) => {
      initialStateView.setUint32(word * Uint32Array.BYTES_PER_ELEMENT, value, true);
    };
    setInitialStateWord(EvaluationStateWord.NodeCount, module.nodeCount);
    setInitialStateWord(EvaluationStateWord.DefinitionCount, module.definitionCount);
    setInitialStateWord(EvaluationStateWord.EntryDefinition, module.entryDefinition);
    setInitialStateWord(EvaluationStateWord.MaximumSteps, limits.maximumSteps);
    setInitialStateWord(EvaluationStateWord.HeapCapacity, limits.heapSlots);
    setInitialStateWord(EvaluationStateWord.StackCapacity, limits.stackFrames);
    setInitialStateWord(EvaluationStateWord.ConstructorCount, module.constructorCount);
    setInitialStateWord(EvaluationStateWord.TypeCount, module.typeCount);
    setInitialStateWord(
      EvaluationStateWord.MaximumStepsPerDispatch,
      limits.maximumStepsPerDispatch,
    );

    let heapBuffer: GPUBuffer | undefined;
    let stackBuffer: GPUBuffer | undefined;
    let globalBuffer: GPUBuffer | undefined;
    let stateBuffer: GPUBuffer | undefined;
    let stateReadbackBuffer: GPUBuffer | undefined;
    let stateReadbackMapped = false;

    try {
      let bindGroup: GPUBindGroup;
      this.#device.pushErrorScope("validation");
      let setupValidation: Promise<GPUError | null>;
      try {
        heapBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation heap",
          size: heapBufferByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        stackBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation continuation stack",
          size: stackBufferByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        globalBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation global thunks",
          size: globalBufferByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        stateBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation state",
          size: EVALUATION_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateReadbackBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation state readback",
          size: EVALUATION_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        this.#device.queue.writeBuffer(stateBuffer, 0, initialState);

        bindGroup = this.#device.createBindGroup({
          label: "Lazuli evaluator bindings",
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: { buffer: module.nodeBuffer, size: nodeBufferByteLength },
            },
            {
              binding: 1,
              resource: { buffer: module.definitionBuffer, size: definitionBufferByteLength },
            },
            { binding: 2, resource: { buffer: heapBuffer } },
            { binding: 3, resource: { buffer: stackBuffer } },
            { binding: 4, resource: { buffer: globalBuffer } },
            { binding: 5, resource: { buffer: stateBuffer } },
            {
              binding: 6,
              resource: { buffer: module.constructorBuffer, size: constructorBindingByteLength },
            },
          ],
        });
        setupValidation = this.#device.popErrorScope();
      } catch (cause) {
        const validationError = await this.#device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli evaluation setup for ${module.nodeCount} nodes: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }

      const setupValidationError = await setupValidation;
      if (setupValidationError !== null) {
        throw new Error(
          `WebGPU rejected Lazuli evaluation setup for ${module.nodeCount} nodes: ${setupValidationError.message}`,
        );
      }

      let previousSteps = 0;
      while (true) {
        options.signal?.throwIfAborted();
        this.#device.pushErrorScope("validation");
        let dispatchValidation: Promise<GPUError | null>;
        try {
          const commandEncoder = this.#device.createCommandEncoder({
            label: "Lazuli evaluation commands",
          });
          const computePass = commandEncoder.beginComputePass({
            label: "Evaluate Lazuli module",
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
            EVALUATION_STATE_BYTE_LENGTH,
          );
          options.signal?.throwIfAborted();
          this.#device.queue.submit([commandEncoder.finish()]);
          dispatchValidation = this.#device.popErrorScope();
        } catch (cause) {
          const validationError = await this.#device.popErrorScope();
          if (validationError !== null) {
            throw new Error(
              `WebGPU rejected Lazuli evaluation for ${module.nodeCount} nodes: ${validationError.message}`,
              { cause },
            );
          }
          throw cause;
        }

        const validationError = await dispatchValidation;
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli evaluation for ${module.nodeCount} nodes: ${validationError.message}`,
          );
        }

        try {
          await stateReadbackBuffer.mapAsync(GPUMapMode.READ);
        } catch (cause) {
          throw new Error(
            `could not read GPU Lazuli evaluation status for ${module.nodeCount} nodes`,
            { cause },
          );
        }
        stateReadbackMapped = true;
        const snapshotBytes = stateReadbackBuffer.getMappedRange().slice(0);
        stateReadbackBuffer.unmap();
        stateReadbackMapped = false;
        options.signal?.throwIfAborted();

        const snapshotView = new DataView(snapshotBytes);
        const snapshotWord = (word: number) =>
          snapshotView.getUint32(word * Uint32Array.BYTES_PER_ELEMENT, true);
        const snapshot: EvaluationSnapshot = {
          status: snapshotWord(EvaluationStateWord.Status),
          faultCode: snapshotWord(EvaluationStateWord.FaultCode),
          faultSourceOffset: snapshotWord(EvaluationStateWord.FaultSourceOffset),
          faultDetail: snapshotWord(EvaluationStateWord.FaultDetail),
          valueTag: snapshotWord(EvaluationStateWord.ValueTag),
          valuePayload: snapshotWord(EvaluationStateWord.ValuePayload),
          heapTop: snapshotWord(EvaluationStateWord.HeapTop),
          stackTop: snapshotWord(EvaluationStateWord.StackTop),
          initializationDefinition: snapshotWord(EvaluationStateWord.InitializationDefinition),
          stats: {
            steps: snapshotWord(EvaluationStateWord.Steps),
            allocations: snapshotWord(EvaluationStateWord.Allocations),
            peakStack: snapshotWord(EvaluationStateWord.PeakStack),
            thunkEvaluations: snapshotWord(EvaluationStateWord.ThunkEvaluations),
          },
        };

        if (
          snapshot.stats.steps > limits.maximumSteps ||
          snapshot.stats.allocations !== snapshot.heapTop ||
          snapshot.heapTop > limits.heapSlots ||
          snapshot.stats.peakStack > limits.stackFrames ||
          snapshot.stackTop > snapshot.stats.peakStack ||
          snapshot.initializationDefinition > module.definitionCount ||
          snapshot.stats.thunkEvaluations > snapshot.stats.steps
        ) {
          throw new Error(
            `GPU Lazuli evaluator returned inconsistent counters: steps=${snapshot.stats.steps}, allocations=${snapshot.stats.allocations}, heapTop=${snapshot.heapTop}, peakStack=${snapshot.stats.peakStack}, stackTop=${snapshot.stackTop}, thunkEvaluations=${snapshot.stats.thunkEvaluations}, initializedDefinitions=${snapshot.initializationDefinition}`,
          );
        }

        const dispatchSteps = snapshot.stats.steps - previousSteps;
        if (dispatchSteps < 1 || dispatchSteps > limits.maximumStepsPerDispatch) {
          throw new Error(
            `GPU Lazuli evaluator returned invalid dispatch progress: previousSteps=${previousSteps}, steps=${snapshot.stats.steps}, maximumStepsPerDispatch=${limits.maximumStepsPerDispatch}`,
          );
        }

        if (snapshot.status === STATUS_PENDING) {
          if (
            snapshot.faultCode !== 0 ||
            snapshot.faultSourceOffset !== LAZULI_NO_INDEX ||
            snapshot.faultDetail !== 0 || snapshot.stats.steps >= limits.maximumSteps
          ) {
            throw new Error(
              `GPU Lazuli evaluator returned inconsistent pending state: fault=${snapshot.faultCode}, source=${snapshot.faultSourceOffset}, detail=${snapshot.faultDetail}, steps=${snapshot.stats.steps}`,
            );
          }
          previousSteps = snapshot.stats.steps;
          continue;
        }

        if (snapshot.status === STATUS_COMPLETE) {
          if (
            snapshot.faultCode !== 0 ||
            snapshot.faultSourceOffset !== LAZULI_NO_INDEX ||
            snapshot.stackTop !== 0
          ) {
            throw new Error(
              `GPU Lazuli evaluator returned inconsistent success state: fault=${snapshot.faultCode}, source=${snapshot.faultSourceOffset}, stackTop=${snapshot.stackTop}`,
            );
          }
          return {
            ok: true,
            value: decodeValue(snapshot.valueTag, snapshot.valuePayload, module),
            stats: snapshot.stats,
          };
        }

        if (snapshot.status === STATUS_FAULT) {
          return {
            ok: false,
            fault: decodeFault(snapshot, limits, module),
            stats: snapshot.stats,
          };
        }

        throw new Error(`GPU Lazuli evaluator returned unknown status ${snapshot.status}`);
      }
    } finally {
      if (stateReadbackMapped) {
        stateReadbackBuffer?.unmap();
      }
      heapBuffer?.destroy();
      stackBuffer?.destroy();
      globalBuffer?.destroy();
      stateBuffer?.destroy();
      stateReadbackBuffer?.destroy();
    }
  }
}
