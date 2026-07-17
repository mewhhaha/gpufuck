export interface FunctionalIncrementalCache {
  read(key: string): Promise<Uint8Array | undefined>;
  write(key: string, value: Uint8Array): Promise<void>;
}

export class MemoryFunctionalIncrementalCache implements FunctionalIncrementalCache {
  readonly #entries = new Map<string, Uint8Array>();

  read(key: string): Promise<Uint8Array | undefined> {
    requireCacheKey(key);
    const value = this.#entries.get(key);
    return Promise.resolve(value?.slice());
  }

  write(key: string, value: Uint8Array): Promise<void> {
    requireCacheKey(key);
    this.#entries.set(key, value.slice());
    return Promise.resolve();
  }
}

export class DirectoryFunctionalIncrementalCache implements FunctionalIncrementalCache {
  readonly #directory: string;

  constructor(directory: string) {
    if (directory.length === 0) {
      throw new TypeError("functional incremental cache directory must be nonempty");
    }
    this.#directory = directory === "/" ? directory : directory.replace(/\/+$/, "");
  }

  async read(key: string): Promise<Uint8Array | undefined> {
    requireCacheKey(key);
    const path = this.#path(key);
    try {
      return await Deno.readFile(path);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return undefined;
      throw new Error(`could not read functional incremental cache entry ${path}`, { cause });
    }
  }

  async write(key: string, value: Uint8Array): Promise<void> {
    requireCacheKey(key);
    const path = this.#path(key);
    const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await Deno.mkdir(this.#directory, { recursive: true });
      await Deno.writeFile(temporaryPath, value);
      await Deno.rename(temporaryPath, path);
    } catch (cause) {
      try {
        await Deno.remove(temporaryPath);
      } catch (cleanupCause) {
        if (!(cleanupCause instanceof Deno.errors.NotFound)) {
          throw new Error(
            `could not write functional incremental cache entry ${path}; cleanup of ${temporaryPath} also failed`,
            { cause: new AggregateError([cause, cleanupCause]) },
          );
        }
      }
      throw new Error(`could not write functional incremental cache entry ${path}`, { cause });
    }
  }

  #path(key: string): string {
    const separator = this.#directory === "/" ? "" : "/";
    return `${this.#directory}${separator}${key}.json`;
  }
}

function requireCacheKey(key: string): void {
  if (/^[0-9a-f]{64}$/.test(key)) return;
  throw new TypeError(
    `functional incremental cache key must be a lowercase SHA-256 digest; received ${
      JSON.stringify(key)
    }`,
  );
}
