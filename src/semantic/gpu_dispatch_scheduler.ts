export interface GpuDispatchRequest {
  readonly encode: (commands: GPUCommandEncoder) => void;
  readonly validationContext: string;
  readonly signal?: AbortSignal;
}

interface PendingGpuDispatch extends GpuDispatchRequest {
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

export const MAXIMUM_GPU_DISPATCH_BATCH_SIZE = 64;

export class GpuDispatchScheduler {
  readonly #device: GPUDevice;
  #pendingDispatches: PendingGpuDispatch[] = [];
  #firstPendingDispatch = 0;
  #flushScheduled = false;

  constructor(device: GPUDevice) {
    this.#device = device;
  }

  schedule(request: GpuDispatchRequest): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#pendingDispatches.push({ ...request, resolve, reject });
      this.#scheduleFlush();
    });
  }

  #scheduleFlush(): void {
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;

    // Buffer setup resumes through several WebGPU promise callbacks. One extra
    // microtask lets sibling compilations reach this queue together.
    queueMicrotask(() => {
      queueMicrotask(() => this.#flush());
    });
  }

  #flush(): void {
    this.#flushScheduled = false;
    const endDispatch = Math.min(
      this.#firstPendingDispatch + MAXIMUM_GPU_DISPATCH_BATCH_SIZE,
      this.#pendingDispatches.length,
    );
    const pendingDispatches = this.#pendingDispatches.slice(
      this.#firstPendingDispatch,
      endDispatch,
    );
    this.#firstPendingDispatch = endDispatch;
    if (this.#firstPendingDispatch === this.#pendingDispatches.length) {
      this.#pendingDispatches = [];
      this.#firstPendingDispatch = 0;
    } else {
      this.#scheduleFlush();
    }

    const activeDispatches: PendingGpuDispatch[] = [];
    for (const dispatch of pendingDispatches) {
      if (dispatch.signal?.aborted) {
        dispatch.reject(dispatch.signal.reason);
      } else {
        activeDispatches.push(dispatch);
      }
    }
    if (activeDispatches.length === 0) return;

    void this.#submit(activeDispatches);
  }

  async #submit(dispatches: readonly PendingGpuDispatch[]): Promise<void> {
    let validation: Promise<GPUError | null>;
    let errorScopeOpen = false;
    try {
      this.#device.pushErrorScope("validation");
      errorScopeOpen = true;
      const commands = this.#device.createCommandEncoder({
        label: dispatches.length === 1
          ? "Functional compiler dispatch"
          : `Functional compiler dispatch batch (${dispatches.length} lanes)`,
      });
      for (const dispatch of dispatches) dispatch.encode(commands);
      this.#device.queue.submit([commands.finish()]);
      validation = this.#device.popErrorScope();
      errorScopeOpen = false;
    } catch (cause) {
      if (!errorScopeOpen) {
        this.#rejectAll(dispatches, cause);
        return;
      }
      let validationError: GPUError | null;
      try {
        validationError = await this.#device.popErrorScope();
      } catch (scopeCause) {
        this.#rejectAll(dispatches, scopeCause);
        return;
      }
      if (validationError !== null) {
        this.#rejectValidation(dispatches, validationError, cause);
      } else {
        this.#rejectAll(dispatches, cause);
      }
      return;
    }

    let validationError: GPUError | null;
    try {
      validationError = await validation;
    } catch (cause) {
      this.#rejectAll(dispatches, cause);
      return;
    }
    if (validationError !== null) {
      this.#rejectValidation(dispatches, validationError);
      return;
    }

    for (const dispatch of dispatches) {
      if (dispatch.signal?.aborted) {
        dispatch.reject(dispatch.signal.reason);
      } else {
        dispatch.resolve();
      }
    }
  }

  #rejectValidation(
    dispatches: readonly PendingGpuDispatch[],
    validationError: GPUError,
    cause?: unknown,
  ): void {
    for (const dispatch of dispatches) {
      dispatch.reject(
        new Error(`${dispatch.validationContext}: ${validationError.message}`, {
          ...(cause === undefined ? {} : { cause }),
        }),
      );
    }
  }

  #rejectAll(dispatches: readonly PendingGpuDispatch[], reason: unknown): void {
    for (const dispatch of dispatches) dispatch.reject(reason);
  }
}
