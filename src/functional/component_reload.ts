export interface ReloadableComponentVersion<Exports> {
  readonly wit: string;
  readonly exports: Exports;
  readonly dispose?: () => void | PromiseLike<void>;
}

interface ActiveComponentVersion<Exports> {
  readonly wit: string;
  readonly exports: Exports;
  dispose: (() => void | PromiseLike<void>) | undefined;
  calls: number;
  retired: boolean;
}

export class ComponentReloadSlot<Exports> {
  #active: ActiveComponentVersion<Exports>;

  constructor(initial: ReloadableComponentVersion<Exports>) {
    this.#active = activeVersion(initial);
  }

  async call<Result>(
    operation: (exports: Exports) => Result | PromiseLike<Result>,
  ): Promise<Result> {
    const version = this.#active;
    version.calls += 1;
    try {
      return await operation(version.exports);
    } finally {
      version.calls -= 1;
      await disposeRetiredVersion(version);
    }
  }

  async replace(
    candidate: ReloadableComponentVersion<Exports>,
    healthCheck: (exports: Exports) => void | PromiseLike<void>,
  ): Promise<void> {
    const replacement = activeVersion(candidate);
    if (replacement.wit !== this.#active.wit) {
      let mismatch = 0;
      while (
        mismatch < replacement.wit.length && mismatch < this.#active.wit.length &&
        replacement.wit[mismatch] === this.#active.wit[mismatch]
      ) mismatch += 1;
      throw new TypeError(
        `component reload WIT differs at offset ${mismatch}; active ${
          JSON.stringify(this.#active.wit[mismatch])
        }, candidate ${JSON.stringify(replacement.wit[mismatch])}`,
      );
    }
    await healthCheck(replacement.exports);
    const retired = this.#active;
    this.#active = replacement;
    retired.retired = true;
    await disposeRetiredVersion(retired);
  }
}

function activeVersion<Exports>(
  version: ReloadableComponentVersion<Exports>,
): ActiveComponentVersion<Exports> {
  if (version === null || typeof version !== "object") {
    throw new TypeError(`component version must be an object; received ${String(version)}`);
  }
  if (typeof version.wit !== "string") {
    throw new TypeError(`component version WIT must be a string; received ${typeof version.wit}`);
  }
  return {
    wit: version.wit,
    exports: version.exports,
    dispose: version.dispose,
    calls: 0,
    retired: false,
  };
}

async function disposeRetiredVersion<Exports>(version: ActiveComponentVersion<Exports>) {
  if (!version.retired || version.calls !== 0 || version.dispose === undefined) return;
  const dispose = version.dispose;
  version.dispose = undefined;
  await dispose();
}
