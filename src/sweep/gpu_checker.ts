import type { SweepDiagnostic } from "./parser.ts";
import type { SweepCheckingPlan } from "./checking_plan.ts";

const WORKGROUP_SIZE = 64;
const NO_CONSTRAINT = 0xffff_ffff;

export type GpuSweepCheckResult =
  | {
    readonly ok: true;
    readonly constraintCount: number;
    readonly milliseconds: number;
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [SweepDiagnostic, ...SweepDiagnostic[]];
    readonly constraintCount: number;
    readonly milliseconds: number;
  };

export class GpuSweepChecker {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;

  private constructor(device: GPUDevice, pipeline: GPUComputePipeline) {
    this.#device = device;
    this.#pipeline = pipeline;
  }

  static async create(device: GPUDevice): Promise<GpuSweepChecker> {
    const shader = device.createShaderModule({
      label: "Sweep checking-only constraint map",
      code: SWEEP_CHECKER_SHADER,
    });
    const compilation = await shader.getCompilationInfo();
    const errors = compilation.messages.filter((message) => message.type === "error");
    if (errors.length !== 0) {
      throw new Error(
        `WebGPU rejected the Sweep checking-only shader:\n${
          errors.map((error) => `${error.lineNum}:${error.linePos}: ${error.message}`).join("\n")
        }`,
      );
    }
    try {
      const pipeline = await device.createComputePipelineAsync({
        label: "Sweep checking-only constraint map",
        layout: "auto",
        compute: { module: shader, entryPoint: "check_constraints" },
      });
      return new GpuSweepChecker(device, pipeline);
    } catch (cause) {
      throw new Error("WebGPU could not create the Sweep checking-only pipeline", { cause });
    }
  }

  async check(plan: SweepCheckingPlan): Promise<GpuSweepCheckResult> {
    const constraintCount = plan.constraints.length;
    if (constraintCount === 0) return { ok: true, constraintCount, milliseconds: 0 };
    const workgroups = Math.ceil(constraintCount / WORKGROUP_SIZE);
    if (workgroups > this.#device.limits.maxComputeWorkgroupsPerDimension) {
      throw new RangeError(
        `Sweep checking needs ${workgroups} workgroups for ${constraintCount} constraints but the device permits ${this.#device.limits.maxComputeWorkgroupsPerDimension}`,
      );
    }
    if (plan.constraintWords.byteLength > this.#device.limits.maxStorageBufferBindingSize) {
      throw new RangeError(
        `Sweep checking needs ${plan.constraintWords.byteLength} constraint bytes but the device permits ${this.#device.limits.maxStorageBufferBindingSize} per storage binding`,
      );
    }

    let constraintBuffer: GPUBuffer | undefined;
    let resultBuffer: GPUBuffer | undefined;
    let readbackBuffer: GPUBuffer | undefined;
    let mapped = false;
    const started = performance.now();
    try {
      this.#device.pushErrorScope("validation");
      this.#device.pushErrorScope("out-of-memory");
      let setupCause: unknown;
      try {
        constraintBuffer = this.#device.createBuffer({
          label: `Sweep checking constraints (${constraintCount})`,
          size: plan.constraintWords.byteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        resultBuffer = this.#device.createBuffer({
          label: "Sweep checking result",
          size: Uint32Array.BYTES_PER_ELEMENT,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        readbackBuffer = this.#device.createBuffer({
          label: "Sweep checking readback",
          size: Uint32Array.BYTES_PER_ELEMENT,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this.#device.queue.writeBuffer(constraintBuffer, 0, plan.constraintWords);
        this.#device.queue.writeBuffer(resultBuffer, 0, Uint32Array.of(NO_CONSTRAINT));
        const bindings = this.#device.createBindGroup({
          label: "Sweep checking bindings",
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: constraintBuffer } },
            { binding: 1, resource: { buffer: resultBuffer } },
          ],
        });
        const commands = this.#device.createCommandEncoder({
          label: "Sweep checking commands",
        });
        const pass = commands.beginComputePass({ label: "Sweep checking-only map" });
        pass.setPipeline(this.#pipeline);
        pass.setBindGroup(0, bindings);
        pass.dispatchWorkgroups(workgroups);
        pass.end();
        commands.copyBufferToBuffer(
          resultBuffer,
          0,
          readbackBuffer,
          0,
          Uint32Array.BYTES_PER_ELEMENT,
        );
        this.#device.queue.submit([commands.finish()]);
      } catch (cause) {
        setupCause = cause;
      }
      const outOfMemory = this.#device.popErrorScope();
      const validation = this.#device.popErrorScope();
      const [outOfMemoryError, validationError] = await Promise.all([outOfMemory, validation]);
      if (validationError !== null || outOfMemoryError !== null || setupCause !== undefined) {
        const evidence = validationError?.message ?? outOfMemoryError?.message ??
          String(setupCause);
        throw new Error(
          `WebGPU could not check ${constraintCount} Sweep constraints: ${evidence}`,
          setupCause === undefined ? undefined : { cause: setupCause },
        );
      }
      if (readbackBuffer === undefined) {
        throw new Error("WebGPU omitted the Sweep checking readback buffer");
      }
      await readbackBuffer.mapAsync(GPUMapMode.READ);
      mapped = true;
      const failedConstraint = new Uint32Array(readbackBuffer.getMappedRange())[0];
      const milliseconds = performance.now() - started;
      if (failedConstraint === NO_CONSTRAINT) {
        return { ok: true, constraintCount, milliseconds };
      }
      const failure = failedConstraint === undefined
        ? undefined
        : plan.constraints[failedConstraint];
      if (failure === undefined) {
        throw new Error(
          `Sweep checking returned constraint ${failedConstraint} outside ${constraintCount} constraints`,
        );
      }
      return {
        ok: false,
        diagnostics: [failure.diagnostic],
        constraintCount,
        milliseconds,
      };
    } finally {
      if (mapped) readbackBuffer?.unmap();
      constraintBuffer?.destroy();
      resultBuffer?.destroy();
      readbackBuffer?.destroy();
    }
  }
}

const SWEEP_CHECKER_SHADER = /* wgsl */ `
struct Constraint {
  expected: u32,
  received: u32,
}

@group(0) @binding(0)
var<storage, read> constraints: array<Constraint>;

@group(0) @binding(1)
var<storage, read_write> first_failure: atomic<u32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn check_constraints(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  if index >= arrayLength(&constraints) {
    return;
  }
  let constraint = constraints[index];
  if constraint.expected != constraint.received {
    atomicMin(&first_failure, index);
  }
}
`;
