import { BRAINFUCK_COMPILER_SHADER } from "./compiler_shader.ts";
import {
  type BrainfuckInstruction,
  BrainfuckOpcode,
  type BrainfuckOpcode as KnownBrainfuckOpcode,
} from "./ir.ts";

export const MAXIMUM_SOURCE_BYTE_LENGTH = 1024 * 1024;

const INSTRUCTION_BYTE_LENGTH = 8;
const COMPILATION_STATE_BYTE_LENGTH = 16;
const NO_SOURCE_OFFSET = 0xffffffff;

const STATUS_OK = 1;
const STATUS_UNMATCHED_CLOSING_BRACKET = 2;
const STATUS_UNMATCHED_OPENING_BRACKET = 3;

export interface GpuBrainfuckIr {
  readonly buffer: GPUBuffer;
  readonly instructionCount: number;
  readInstructions(): Promise<readonly BrainfuckInstruction[]>;
  destroy(): void;
}

export type BrainfuckCompileDiagnostic =
  | {
    readonly kind: "unmatched-closing-bracket";
    readonly code: "E1001";
    readonly message: string;
    readonly sourceByteOffset: number;
  }
  | {
    readonly kind: "unmatched-opening-bracket";
    readonly code: "E1002";
    readonly message: string;
    readonly sourceByteOffset: number;
  }
  | {
    readonly kind: "source-too-large";
    readonly code: "E1003";
    readonly message: string;
    readonly sourceByteLength: number;
    readonly maximumSourceByteLength: number;
  };

export type BrainfuckCompileResult =
  | { readonly ok: true; readonly ir: GpuBrainfuckIr }
  | { readonly ok: false; readonly diagnostic: BrainfuckCompileDiagnostic };

class CompiledGpuBrainfuckIr implements GpuBrainfuckIr {
  readonly buffer: GPUBuffer;
  readonly instructionCount: number;

  readonly #device: GPUDevice;
  #destroyed = false;

  constructor(device: GPUDevice, buffer: GPUBuffer, instructionCount: number) {
    this.#device = device;
    this.buffer = buffer;
    this.instructionCount = instructionCount;
  }

  async readInstructions(): Promise<readonly BrainfuckInstruction[]> {
    if (this.#destroyed) {
      throw new Error("cannot read a destroyed GPU Brainfuck IR buffer");
    }
    if (this.instructionCount === 0) {
      return [];
    }

    const byteLength = this.instructionCount * INSTRUCTION_BYTE_LENGTH;
    const readbackBuffer = this.#device.createBuffer({
      label: "Brainfuck IR readback",
      size: byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    let mapped = false;

    try {
      this.#device.pushErrorScope("validation");
      let readbackValidation: Promise<GPUError | null>;
      try {
        const commandEncoder = this.#device.createCommandEncoder({
          label: "Brainfuck IR readback commands",
        });
        commandEncoder.copyBufferToBuffer(this.buffer, 0, readbackBuffer, 0, byteLength);
        this.#device.queue.submit([commandEncoder.finish()]);
        readbackValidation = this.#device.popErrorScope();
      } catch (cause) {
        const validationError = await this.#device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Brainfuck IR readback for ${this.instructionCount} instructions: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }

      const validationError = await readbackValidation;
      if (validationError !== null) {
        throw new Error(
          `WebGPU rejected Brainfuck IR readback for ${this.instructionCount} instructions: ${validationError.message}`,
        );
      }

      await readbackBuffer.mapAsync(GPUMapMode.READ);
      mapped = true;
      const copiedBytes = readbackBuffer.getMappedRange().slice(0);
      const instructionView = new DataView(copiedBytes);
      const decodedInstructions: BrainfuckInstruction[] = [];

      for (let instructionIndex = 0; instructionIndex < this.instructionCount; instructionIndex++) {
        const byteOffset = instructionIndex * INSTRUCTION_BYTE_LENGTH;
        const encodedOpcode = instructionView.getUint32(byteOffset, true);
        let opcode: KnownBrainfuckOpcode;

        switch (encodedOpcode) {
          case BrainfuckOpcode.NOP:
          case BrainfuckOpcode.Right:
          case BrainfuckOpcode.Left:
          case BrainfuckOpcode.Increment:
          case BrainfuckOpcode.Decrement:
          case BrainfuckOpcode.Output:
          case BrainfuckOpcode.Input:
          case BrainfuckOpcode.LoopStart:
          case BrainfuckOpcode.LoopEnd:
            opcode = encodedOpcode;
            break;
          default:
            throw new Error(
              `GPU Brainfuck IR contains unknown opcode ${encodedOpcode} at instruction ${instructionIndex}`,
            );
        }

        decodedInstructions.push({
          opcode,
          operand: instructionView.getUint32(byteOffset + 4, true),
        });
      }

      return decodedInstructions;
    } finally {
      if (mapped) {
        readbackBuffer.unmap();
      }
      readbackBuffer.destroy();
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.buffer.destroy();
  }
}

export class GpuBrainfuckCompiler {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;
  readonly #maximumSourceByteLength: number;

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    maximumSourceByteLength: number,
  ) {
    this.#device = device;
    this.#pipeline = pipeline;
    this.#maximumSourceByteLength = maximumSourceByteLength;
  }

  static async create(device: GPUDevice): Promise<GpuBrainfuckCompiler> {
    const maximumSourceByteLength = Math.min(
      MAXIMUM_SOURCE_BYTE_LENGTH,
      Math.floor(device.limits.maxStorageBufferBindingSize / INSTRUCTION_BYTE_LENGTH),
      Math.floor(device.limits.maxBufferSize / INSTRUCTION_BYTE_LENGTH),
      NO_SOURCE_OFFSET - 1,
    );

    const shaderModule = device.createShaderModule({
      label: "Brainfuck compiler",
      code: BRAINFUCK_COMPILER_SHADER,
    });
    const shaderCompilation = await shaderModule.getCompilationInfo();
    const shaderErrors = shaderCompilation.messages.filter((message) => message.type === "error");
    if (shaderErrors.length > 0) {
      const formattedShaderErrors = shaderErrors.map((message) =>
        `${message.lineNum}:${message.linePos}: ${message.message}`
      ).join("\n");
      throw new Error(`WebGPU rejected the Brainfuck compiler shader:\n${formattedShaderErrors}`);
    }

    try {
      const pipeline = await device.createComputePipelineAsync({
        label: "Brainfuck compiler pipeline",
        layout: "auto",
        compute: {
          module: shaderModule,
          entryPoint: "compile_brainfuck",
        },
      });
      return new GpuBrainfuckCompiler(device, pipeline, maximumSourceByteLength);
    } catch (cause) {
      throw new Error("WebGPU could not create the Brainfuck compiler pipeline", { cause });
    }
  }

  async compile(source: string): Promise<BrainfuckCompileResult> {
    const sourceBytes = new TextEncoder().encode(source);
    if (sourceBytes.byteLength > this.#maximumSourceByteLength) {
      return {
        ok: false,
        diagnostic: {
          kind: "source-too-large",
          code: "E1003",
          message:
            `source is ${sourceBytes.byteLength} UTF-8 bytes; this device accepts at most ${this.#maximumSourceByteLength}`,
          sourceByteLength: sourceBytes.byteLength,
          maximumSourceByteLength: this.#maximumSourceByteLength,
        },
      };
    }

    const sourceBufferByteLength = Math.max(4, Math.ceil(sourceBytes.byteLength / 4) * 4);
    const instructionBufferByteLength = Math.max(
      INSTRUCTION_BYTE_LENGTH,
      sourceBytes.byteLength * INSTRUCTION_BYTE_LENGTH,
    );
    const paddedSourceBytes = new Uint8Array(sourceBufferByteLength);
    paddedSourceBytes.set(sourceBytes);

    const initialState = new ArrayBuffer(COMPILATION_STATE_BYTE_LENGTH);
    const initialStateView = new DataView(initialState);
    initialStateView.setUint32(0, sourceBytes.byteLength, true);
    initialStateView.setUint32(4, 0, true);
    initialStateView.setUint32(8, NO_SOURCE_OFFSET, true);
    initialStateView.setUint32(12, 0, true);

    let sourceBuffer: GPUBuffer | undefined;
    let instructionBuffer: GPUBuffer | undefined;
    let stateBuffer: GPUBuffer | undefined;
    let stateReadbackBuffer: GPUBuffer | undefined;
    let stateReadbackMapped = false;
    let instructionBufferTransferred = false;

    try {
      this.#device.pushErrorScope("validation");
      let compilationValidation: Promise<GPUError | null>;
      try {
        sourceBuffer = this.#device.createBuffer({
          label: "Brainfuck UTF-8 source",
          size: sourceBufferByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        instructionBuffer = this.#device.createBuffer({
          label: "Brainfuck IR",
          size: instructionBufferByteLength,
          usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateBuffer = this.#device.createBuffer({
          label: "Brainfuck compilation state",
          size: COMPILATION_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateReadbackBuffer = this.#device.createBuffer({
          label: "Brainfuck compilation state readback",
          size: COMPILATION_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        this.#device.queue.writeBuffer(sourceBuffer, 0, paddedSourceBytes);
        this.#device.queue.writeBuffer(stateBuffer, 0, initialState);

        const bindGroup = this.#device.createBindGroup({
          label: "Brainfuck compiler bindings",
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: sourceBuffer } },
            { binding: 1, resource: { buffer: instructionBuffer } },
            { binding: 2, resource: { buffer: stateBuffer } },
          ],
        });
        const commandEncoder = this.#device.createCommandEncoder({
          label: "Brainfuck compilation commands",
        });
        const computePass = commandEncoder.beginComputePass({
          label: "Compile Brainfuck to IR",
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
        compilationValidation = this.#device.popErrorScope();
      } catch (cause) {
        const validationError = await this.#device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Brainfuck compilation for ${sourceBytes.byteLength} source bytes: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }

      const validationError = await compilationValidation;
      if (validationError !== null) {
        throw new Error(
          `WebGPU rejected Brainfuck compilation for ${sourceBytes.byteLength} source bytes: ${validationError.message}`,
        );
      }

      try {
        await stateReadbackBuffer.mapAsync(GPUMapMode.READ);
      } catch (cause) {
        throw new Error(
          `could not read GPU compilation status for ${sourceBytes.byteLength} source bytes`,
          { cause },
        );
      }
      stateReadbackMapped = true;

      const copiedState = stateReadbackBuffer.getMappedRange().slice(0);
      const completedState = new DataView(copiedState);
      const status = completedState.getUint32(4, true);
      const errorOffset = completedState.getUint32(8, true);
      const instructionCount = completedState.getUint32(12, true);

      if (status === STATUS_OK) {
        if (instructionCount !== sourceBytes.byteLength || errorOffset !== NO_SOURCE_OFFSET) {
          throw new Error(
            `GPU compiler returned inconsistent success state: count=${instructionCount}, errorOffset=${errorOffset}, sourceBytes=${sourceBytes.byteLength}`,
          );
        }

        const ir = new CompiledGpuBrainfuckIr(this.#device, instructionBuffer, instructionCount);
        instructionBufferTransferred = true;
        return {
          ok: true,
          ir,
        };
      }

      if (
        status !== STATUS_UNMATCHED_CLOSING_BRACKET &&
        status !== STATUS_UNMATCHED_OPENING_BRACKET
      ) {
        throw new Error(
          `GPU compiler returned unknown status ${status} for ${sourceBytes.byteLength} source bytes`,
        );
      }

      if (errorOffset >= sourceBytes.byteLength || instructionCount !== 0) {
        throw new Error(
          `GPU compiler returned inconsistent error state: status=${status}, errorOffset=${errorOffset}, count=${instructionCount}, sourceBytes=${sourceBytes.byteLength}`,
        );
      }

      if (status === STATUS_UNMATCHED_CLOSING_BRACKET) {
        return {
          ok: false,
          diagnostic: {
            kind: "unmatched-closing-bracket",
            code: "E1001",
            message: `unmatched closing bracket at UTF-8 byte ${errorOffset}`,
            sourceByteOffset: errorOffset,
          },
        };
      }
      return {
        ok: false,
        diagnostic: {
          kind: "unmatched-opening-bracket",
          code: "E1002",
          message: `unmatched opening bracket at UTF-8 byte ${errorOffset}`,
          sourceByteOffset: errorOffset,
        },
      };
    } finally {
      if (stateReadbackMapped) {
        stateReadbackBuffer?.unmap();
      }
      sourceBuffer?.destroy();
      stateBuffer?.destroy();
      stateReadbackBuffer?.destroy();
      if (!instructionBufferTransferred) {
        instructionBuffer?.destroy();
      }
    }
  }
}
