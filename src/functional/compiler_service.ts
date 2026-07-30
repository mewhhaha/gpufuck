import { requestWebGpuDevice } from "../webgpu.ts";
import { CpuCompiler, GpuCompiler } from "./compiler.ts";
import type { CompilationOptions, CpuCompileResult } from "./compiler_module.ts";
import { type EncodedModule, TypecheckingProfile } from "./abi.ts";

export type CompilerBackend = "auto" | "cpu" | "gpu";

export interface CompilerServiceOptions {
  readonly backend?: CompilerBackend;
  readonly device?: GPUDevice;
}

export interface ServiceCompilationOptions extends CompilationOptions {
  readonly backend?: CompilerBackend;
}

export type ServiceCompileResult = CpuCompileResult;

interface ResidentGpuCompiler {
  readonly compiler: GpuCompiler;
  readonly device: GPUDevice;
  readonly ownsDevice: boolean;
}

export class FunctionalCompilerService {
  readonly #cpuCompiler = new CpuCompiler();
  readonly #cpuCompilations = new WeakMap<EncodedModule, Promise<CpuCompileResult>>();
  readonly #defaultBackend: CompilerBackend;
  readonly #providedDevice: GPUDevice | undefined;
  #residentGpuCompiler: Promise<ResidentGpuCompiler> | undefined;
  #destroyed = false;

  constructor(options: CompilerServiceOptions = {}) {
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("functional compiler service options must be an object");
    }
    this.#defaultBackend = options.backend ?? "auto";
    if (
      this.#defaultBackend !== "auto" &&
      this.#defaultBackend !== "cpu" &&
      this.#defaultBackend !== "gpu"
    ) {
      throw new TypeError(
        `functional compiler backend must be auto, cpu, or gpu; received ${
          JSON.stringify(this.#defaultBackend)
        }`,
      );
    }
    this.#providedDevice = options.device;
  }

  async compileModule(
    module: EncodedModule,
    options: ServiceCompilationOptions = {},
  ): Promise<ServiceCompileResult> {
    const results = await this.compileBatch([module], options);
    const result = results[0];
    if (result === undefined) {
      throw new Error("functional compiler service omitted its only result");
    }
    return result;
  }

  async compileBatch(
    modules: readonly EncodedModule[],
    options: ServiceCompilationOptions = {},
  ): Promise<readonly ServiceCompileResult[]> {
    this.#requireActive();
    const requestedBackend = options.backend ?? this.#defaultBackend;
    if (
      requestedBackend !== "auto" && requestedBackend !== "cpu" &&
      requestedBackend !== "gpu"
    ) {
      throw new TypeError(
        `functional compiler backend must be auto, cpu, or gpu; received ${
          JSON.stringify(requestedBackend)
        }`,
      );
    }
    const backend = requestedBackend === "auto" &&
        modules.every((module) =>
          module.typecheckingProfile === TypecheckingProfile.HindleyMilnerIndexed
        )
      ? "cpu"
      : requestedBackend === "auto"
      ? "gpu"
      : requestedBackend;
    const compilationOptions: CompilationOptions = {
      ...(options.maximumSteps === undefined ? {} : { maximumSteps: options.maximumSteps }),
      ...(options.maximumStepsPerDispatch === undefined
        ? {}
        : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    if (backend === "cpu") {
      if (
        options.signal !== undefined ||
        options.maximumSteps !== undefined ||
        options.maximumStepsPerDispatch !== undefined
      ) {
        return await this.#cpuCompiler.compileBatch(modules, compilationOptions);
      }
      return await Promise.all(
        modules.map((module) => this.#compileCpuModule(module, compilationOptions)),
      );
    }
    const resident = await this.#gpuCompiler();
    return await resident.compiler.compileBatch(modules, compilationOptions);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    const pending = this.#residentGpuCompiler;
    this.#residentGpuCompiler = undefined;
    if (pending === undefined) return;
    const resident = await pending;
    if (resident.ownsDevice) resident.device.destroy();
  }

  #compileCpuModule(
    module: EncodedModule,
    options: CompilationOptions,
  ): Promise<CpuCompileResult> {
    const cached = this.#cpuCompilations.get(module);
    if (cached !== undefined) return cached;

    const pending = this.#cpuCompiler.compileModule(module, options);
    this.#cpuCompilations.set(module, pending);
    pending.catch(() => {
      if (this.#cpuCompilations.get(module) === pending) {
        this.#cpuCompilations.delete(module);
      }
    });
    return pending;
  }

  async #gpuCompiler(): Promise<ResidentGpuCompiler> {
    this.#requireActive();
    this.#residentGpuCompiler ??= this.#createGpuCompiler();
    return await this.#residentGpuCompiler;
  }

  async #createGpuCompiler(): Promise<ResidentGpuCompiler> {
    const ownsDevice = this.#providedDevice === undefined;
    const device = this.#providedDevice ?? await requestWebGpuDevice();
    try {
      return {
        compiler: await GpuCompiler.create(device),
        device,
        ownsDevice,
      };
    } catch (error) {
      if (ownsDevice) device.destroy();
      throw error;
    }
  }

  #requireActive(): void {
    if (this.#destroyed) {
      throw new Error("functional compiler service was destroyed");
    }
  }
}
