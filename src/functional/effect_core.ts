import type { FunctionalDiagnostic, FunctionalSpan } from "./abi.ts";
import type {
  FunctionalEffectCoreModule,
  LoweredFunctionalEffectCoreModule,
} from "./effect_core_contract.ts";
import {
  expressionSpan,
  type PreparedEffectCore,
  prepareFunctionalEffectCore,
  scalarTypeFromTag,
} from "./effect_core_encoding.ts";
import { lowerPreparedEffectCore } from "./effect_core_lowering.ts";
import {
  FUNCTIONAL_EFFECT_CORE_NO_INDEX,
  FUNCTIONAL_EFFECT_CORE_SHADER,
  FUNCTIONAL_EFFECT_CORE_STATE_WORD_LENGTH,
  FunctionalEffectCoreDiagnostic,
  FunctionalEffectCoreStateWord,
  FunctionalEffectCoreStatus,
} from "./effect_core_shader.ts";
import type { FunctionalHostScalarType } from "./host_contract.ts";

const EFFECT_CORE_RESULT_WORD_LENGTH = 2;
const EFFECT_CORE_STATE_BYTE_LENGTH = FUNCTIONAL_EFFECT_CORE_STATE_WORD_LENGTH * 4;
export interface FunctionalEffectCoreDispatchObservation {
  readonly dispatch: number;
  readonly transitions: number;
  readonly dispatchTransitions: number;
  readonly status: number;
}

export interface FunctionalEffectCoreVerificationOptions {
  readonly maximumTransitions: number;
  readonly maximumTransitionsPerDispatch: number;
  readonly signal?: AbortSignal;
  readonly observeDispatch?: (observation: FunctionalEffectCoreDispatchObservation) => void;
}

export type FunctionalEffectCoreVerification =
  | {
    readonly ok: true;
    readonly type: FunctionalHostScalarType;
    readonly effects: readonly string[];
    readonly transitions: number;
    readonly dispatches: number;
  }
  | {
    readonly ok: false;
    readonly diagnostic: FunctionalDiagnostic;
    readonly transitions: number;
    readonly dispatches: number;
  };

export class GpuFunctionalEffectCoreVerifier {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  private constructor(device: GPUDevice, pipeline: GPUComputePipeline) {
    this.#device = device;
    this.#pipeline = pipeline;
  }

  static async create(device: GPUDevice): Promise<GpuFunctionalEffectCoreVerifier> {
    const shader = device.createShaderModule({
      label: "Functional Effect Core verifier",
      code: FUNCTIONAL_EFFECT_CORE_SHADER,
    });
    const compilation = await shader.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length !== 0) {
      throw new Error(
        `WebGPU rejected the Functional Effect Core verifier:\n${
          errors.map((error) => `${error.lineNum}:${error.linePos}: ${error.message}`).join("\n")
        }`,
      );
    }
    try {
      const pipeline = await device.createComputePipelineAsync({
        label: "Functional Effect Core verifier pipeline",
        layout: "auto",
        compute: { module: shader, entryPoint: "verify_functional_effect_core" },
      });
      return new GpuFunctionalEffectCoreVerifier(device, pipeline);
    } catch (cause) {
      throw new Error("WebGPU could not create the Functional Effect Core verifier pipeline", {
        cause,
      });
    }
  }

  async verify(
    module: FunctionalEffectCoreModule,
    options: FunctionalEffectCoreVerificationOptions,
  ): Promise<FunctionalEffectCoreVerification> {
    const prepared = prepareFunctionalEffectCore(module);
    return await this.verifyPrepared(prepared, options);
  }

  async verifyAndLower(
    module: FunctionalEffectCoreModule,
    options: FunctionalEffectCoreVerificationOptions,
  ): Promise<
    | {
      readonly ok: true;
      readonly lowered: LoweredFunctionalEffectCoreModule;
      readonly transitions: number;
    }
    | {
      readonly ok: false;
      readonly diagnostic: FunctionalDiagnostic;
      readonly transitions: number;
    }
  > {
    const prepared = prepareFunctionalEffectCore(module);
    const verification = await this.verifyPrepared(prepared, options);
    if (!verification.ok) {
      return {
        ok: false,
        diagnostic: verification.diagnostic,
        transitions: verification.transitions,
      };
    }
    const unhandledLocalEffects = verification.effects.filter((effect) =>
      prepared.operations.some((operation) =>
        operation.kind === "local" && operation.key === effect
      )
    );
    if (unhandledLocalEffects.length !== 0) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "F2101",
          `Functional Effect Core leaves local operations unhandled: ${
            JSON.stringify(unhandledLocalEffects)
          }`,
          expressionSpan(prepared.expressions[prepared.rootNode], module.sourceByteLength),
        ),
        transitions: verification.transitions,
      };
    }
    return {
      ok: true,
      lowered: lowerPreparedEffectCore(prepared, verification),
      transitions: verification.transitions,
    };
  }

  private async verifyPrepared(
    prepared: PreparedEffectCore,
    options: FunctionalEffectCoreVerificationOptions,
  ): Promise<FunctionalEffectCoreVerification> {
    validateVerificationOptions(options);
    options.signal?.throwIfAborted();
    const nodeByteLength = prepared.nodeWords.byteLength;
    const operationByteLength = Math.max(4, prepared.operationWords.byteLength);
    const resultByteLength = prepared.expressions.length * EFFECT_CORE_RESULT_WORD_LENGTH * 4;
    const parentByteLength = prepared.expressions.length * 4;
    ensureDeviceCapacity(
      this.#device,
      nodeByteLength,
      operationByteLength,
      resultByteLength,
      parentByteLength,
    );

    const stateWords = new Uint32Array(FUNCTIONAL_EFFECT_CORE_STATE_WORD_LENGTH);
    stateWords[FunctionalEffectCoreStateWord.NodeCount] = prepared.expressions.length;
    stateWords[FunctionalEffectCoreStateWord.OperationCount] = prepared.operations.length;
    stateWords[FunctionalEffectCoreStateWord.RootNode] = prepared.rootNode;
    stateWords[FunctionalEffectCoreStateWord.Cursor] = prepared.expressions.length - 1;
    stateWords[FunctionalEffectCoreStateWord.MaximumTransitions] = options.maximumTransitions;
    stateWords[FunctionalEffectCoreStateWord.MaximumTransitionsPerDispatch] =
      options.maximumTransitionsPerDispatch;
    stateWords[FunctionalEffectCoreStateWord.DiagnosticNode] = FUNCTIONAL_EFFECT_CORE_NO_INDEX;

    const buffers: GPUBuffer[] = [];
    try {
      const nodeBuffer = createBuffer(
        this.#device,
        "Functional Effect Core nodes",
        nodeByteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const operationBuffer = createBuffer(
        this.#device,
        "Functional Effect Core operations",
        operationByteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const resultBuffer = createBuffer(
        this.#device,
        "Functional Effect Core results",
        resultByteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const parentBuffer = createBuffer(
        this.#device,
        "Functional Effect Core parents",
        parentByteLength,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        buffers,
      );
      const stateBuffer = createBuffer(
        this.#device,
        "Functional Effect Core state",
        EFFECT_CORE_STATE_BYTE_LENGTH,
        GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
        buffers,
      );
      const readbackBuffer = createBuffer(
        this.#device,
        "Functional Effect Core state readback",
        EFFECT_CORE_STATE_BYTE_LENGTH,
        GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        buffers,
      );
      this.#device.queue.writeBuffer(
        nodeBuffer,
        0,
        prepared.nodeWords.buffer as ArrayBuffer,
        prepared.nodeWords.byteOffset,
        prepared.nodeWords.byteLength,
      );
      if (prepared.operationWords.length !== 0) {
        this.#device.queue.writeBuffer(
          operationBuffer,
          0,
          prepared.operationWords.buffer as ArrayBuffer,
          prepared.operationWords.byteOffset,
          prepared.operationWords.byteLength,
        );
      }
      this.#device.queue.writeBuffer(resultBuffer, 0, new Uint32Array(resultByteLength / 4));
      this.#device.queue.writeBuffer(parentBuffer, 0, new Uint32Array(parentByteLength / 4));
      this.#device.queue.writeBuffer(stateBuffer, 0, stateWords);

      const bindGroup = this.#device.createBindGroup({
        label: "Functional Effect Core verifier bindings",
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: nodeBuffer } },
          { binding: 1, resource: { buffer: operationBuffer } },
          { binding: 2, resource: { buffer: resultBuffer } },
          { binding: 3, resource: { buffer: parentBuffer } },
          { binding: 4, resource: { buffer: stateBuffer } },
        ],
      });

      let dispatches = 0;
      while (true) {
        options.signal?.throwIfAborted();
        const commands = this.#device.createCommandEncoder({
          label: "Functional Effect Core verifier dispatch",
        });
        const pass = commands.beginComputePass();
        pass.setPipeline(this.#pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(1);
        pass.end();
        commands.copyBufferToBuffer(
          stateBuffer,
          0,
          readbackBuffer,
          0,
          EFFECT_CORE_STATE_BYTE_LENGTH,
        );
        this.#device.queue.submit([commands.finish()]);
        await readbackBuffer.mapAsync(GPUMapMode.READ);
        const snapshot = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
        readbackBuffer.unmap();
        dispatches += 1;
        const status = requiredWord(snapshot, FunctionalEffectCoreStateWord.Status, "status");
        const transitions = requiredWord(
          snapshot,
          FunctionalEffectCoreStateWord.Transitions,
          "transitions",
        );
        options.observeDispatch?.({
          dispatch: dispatches,
          transitions,
          dispatchTransitions: requiredWord(
            snapshot,
            FunctionalEffectCoreStateWord.DispatchTransitions,
            "dispatch transitions",
          ),
          status,
        });
        options.signal?.throwIfAborted();
        if (status === FunctionalEffectCoreStatus.Pending) continue;
        if (status === FunctionalEffectCoreStatus.Complete) {
          const type = scalarTypeFromTag(requiredWord(
            snapshot,
            FunctionalEffectCoreStateWord.RootType,
            "root type",
          ));
          const effectMask = requiredWord(
            snapshot,
            FunctionalEffectCoreStateWord.RootEffects,
            "root effects",
          );
          const effects = prepared.effectNames.filter((_, bit) => (effectMask & (1 << bit)) !== 0);
          return {
            ok: true,
            type,
            effects: Object.freeze(effects),
            transitions,
            dispatches,
          };
        }
        const node = requiredWord(
          snapshot,
          FunctionalEffectCoreStateWord.DiagnosticNode,
          "diagnostic node",
        );
        const span = node < prepared.expressions.length
          ? expressionSpan(prepared.expressions[node], prepared.module.sourceByteLength)
          : { startByte: 0, endByte: prepared.module.sourceByteLength };
        if (status === FunctionalEffectCoreStatus.Exhausted) {
          return {
            ok: false,
            diagnostic: diagnostic(
              "F1003",
              `Functional Effect Core exhausted ${options.maximumTransitions} GPU transitions after ${transitions}`,
              span,
            ),
            transitions,
            dispatches,
          };
        }
        const code = requiredWord(
          snapshot,
          FunctionalEffectCoreStateWord.Diagnostic,
          "diagnostic",
        );
        return {
          ok: false,
          diagnostic: effectDiagnostic(code, node, span),
          transitions,
          dispatches,
        };
      }
    } finally {
      for (const buffer of buffers) buffer.destroy();
    }
  }
}

function effectDiagnostic(
  code: number,
  node: number,
  span: FunctionalSpan,
): FunctionalDiagnostic {
  if (code === FunctionalEffectCoreDiagnostic.TypeMismatch) {
    return diagnostic(
      "F2102",
      `Functional Effect Core node ${node} has incompatible scalar types`,
      span,
    );
  }
  if (code === FunctionalEffectCoreDiagnostic.NonLinear) {
    return diagnostic(
      "F2101",
      `Functional Effect Core node ${node} is reused or omitted; every computation must have exactly one parent`,
      span,
    );
  }
  const description = code === FunctionalEffectCoreDiagnostic.InvalidOperation
    ? "an invalid operation reference"
    : "an invalid computation shape";
  return diagnostic("F2101", `Functional Effect Core node ${node} has ${description}`, span);
}

function diagnostic(
  code: "F1003" | "F2101" | "F2102",
  message: string,
  span: FunctionalSpan,
): FunctionalDiagnostic {
  return { stage: "compile", code, message, span };
}

function validateVerificationOptions(options: FunctionalEffectCoreVerificationOptions): void {
  for (
    const [name, value, maximum] of [
      ["maximumTransitions", options.maximumTransitions, 10_000_000],
      ["maximumTransitionsPerDispatch", options.maximumTransitionsPerDispatch, 65_536],
    ] as const
  ) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new RangeError(
        `${name} must be an integer from 1 through ${maximum}; received ${value}`,
      );
    }
  }
}

function ensureDeviceCapacity(
  device: GPUDevice,
  ...byteLengths: readonly number[]
): void {
  for (const byteLength of byteLengths) {
    if (
      byteLength > device.limits.maxBufferSize ||
      byteLength > device.limits.maxStorageBufferBindingSize
    ) {
      throw new Error(
        `Functional Effect Core requires ${byteLength} bytes in one storage region; device limits are maxBufferSize=${device.limits.maxBufferSize}, maxStorageBufferBindingSize=${device.limits.maxStorageBufferBindingSize}`,
      );
    }
  }
}

function createBuffer(
  device: GPUDevice,
  label: string,
  size: number,
  usage: number,
  buffers: GPUBuffer[],
): GPUBuffer {
  const buffer = device.createBuffer({ label, size, usage });
  buffers.push(buffer);
  return buffer;
}

function requiredWord(words: Uint32Array, index: number, name: string): number {
  const value = words[index];
  if (value === undefined) {
    throw new Error(`GPU Functional Effect Core verifier omitted state word ${name} at ${index}`);
  }
  return value;
}
