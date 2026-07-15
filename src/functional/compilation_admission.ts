import { MAXIMUM_GPU_DISPATCH_BATCH_SIZE } from "./gpu_dispatch_scheduler.ts";

interface PendingCompilation<Result> {
  readonly compile: () => Promise<Result>;
  readonly admissionWeight: number;
  readonly signal?: AbortSignal;
  readonly cancelWhileQueued: () => void;
  readonly resolve: (result: Result) => void;
  readonly reject: (reason: unknown) => void;
  previous: PendingCompilation<Result> | undefined;
  next: PendingCompilation<Result> | undefined;
  queued: boolean;
}

export class CompilationAdmissionQueue<Result> {
  readonly #maximumConcurrentWeight: number;
  readonly #minimumAdmissionWeight: number;
  #firstPendingCompilation: PendingCompilation<Result> | undefined;
  #lastPendingCompilation: PendingCompilation<Result> | undefined;
  #activeCompilationCount = 0;
  #activeCompilationWeight = 0;

  constructor(maximumConcurrentWeight: number) {
    this.#maximumConcurrentWeight = maximumConcurrentWeight;
    this.#minimumAdmissionWeight = Math.max(
      1,
      Math.floor(maximumConcurrentWeight / MAXIMUM_GPU_DISPATCH_BATCH_SIZE),
    );
  }

  admit(
    compile: () => Promise<Result>,
    estimatedTransientByteLength: number,
    signal: AbortSignal | undefined,
  ): Promise<Result> {
    const admissionWeight = Math.max(this.#minimumAdmissionWeight, estimatedTransientByteLength);
    return new Promise<Result>((resolve, reject) => {
      const cancelWhileQueued = () => {
        if (!pendingCompilation.queued) return;
        this.#removeQueuedCompilation(pendingCompilation);
        reject(signal?.reason);
        this.#startQueuedCompilations();
      };
      const pendingCompilation: PendingCompilation<Result> = {
        compile,
        admissionWeight,
        ...(signal === undefined ? {} : { signal }),
        cancelWhileQueued,
        resolve,
        reject,
        previous: undefined,
        next: undefined,
        queued: false,
      };

      if (
        this.#firstPendingCompilation === undefined &&
        this.#canStartCompilation(admissionWeight)
      ) {
        this.#startCompilation(pendingCompilation);
        return;
      }
      this.#enqueueCompilation(pendingCompilation);
      signal?.addEventListener("abort", cancelWhileQueued, { once: true });
    });
  }

  #enqueueCompilation(pendingCompilation: PendingCompilation<Result>): void {
    pendingCompilation.previous = this.#lastPendingCompilation;
    pendingCompilation.queued = true;
    if (this.#lastPendingCompilation === undefined) {
      this.#firstPendingCompilation = pendingCompilation;
    } else {
      this.#lastPendingCompilation.next = pendingCompilation;
    }
    this.#lastPendingCompilation = pendingCompilation;
  }

  #removeQueuedCompilation(pendingCompilation: PendingCompilation<Result>): void {
    const { previous, next } = pendingCompilation;
    if (previous === undefined) {
      this.#firstPendingCompilation = next;
    } else {
      previous.next = next;
    }
    if (next === undefined) {
      this.#lastPendingCompilation = previous;
    } else {
      next.previous = previous;
    }
    pendingCompilation.previous = undefined;
    pendingCompilation.next = undefined;
    pendingCompilation.queued = false;
  }

  #startCompilation(pendingCompilation: PendingCompilation<Result>): void {
    pendingCompilation.signal?.removeEventListener(
      "abort",
      pendingCompilation.cancelWhileQueued,
    );
    if (pendingCompilation.signal?.aborted) {
      pendingCompilation.reject(pendingCompilation.signal.reason);
      return;
    }
    this.#activeCompilationCount++;
    this.#activeCompilationWeight += pendingCompilation.admissionWeight;
    void this.#settleCompilation(pendingCompilation);
  }

  async #settleCompilation(pendingCompilation: PendingCompilation<Result>): Promise<void> {
    try {
      pendingCompilation.resolve(await pendingCompilation.compile());
    } catch (error) {
      pendingCompilation.reject(error);
    } finally {
      this.#activeCompilationCount--;
      this.#activeCompilationWeight -= pendingCompilation.admissionWeight;
      this.#startQueuedCompilations();
    }
  }

  #startQueuedCompilations(): void {
    while (
      this.#firstPendingCompilation !== undefined &&
      this.#canStartCompilation(this.#firstPendingCompilation.admissionWeight)
    ) {
      const pendingCompilation = this.#firstPendingCompilation;
      this.#removeQueuedCompilation(pendingCompilation);
      this.#startCompilation(pendingCompilation);
    }
  }

  #canStartCompilation(admissionWeight: number): boolean {
    if (this.#activeCompilationCount >= MAXIMUM_GPU_DISPATCH_BATCH_SIZE) return false;
    if (this.#activeCompilationCount === 0) return true;
    return this.#activeCompilationWeight + admissionWeight <= this.#maximumConcurrentWeight;
  }
}
