import type { FunctionalType } from "./abi.ts";
import type { GpuFunctionalModule } from "./compiler_module.ts";
import {
  FUNCTIONAL_ARRAY_TYPE_NAME,
  FUNCTIONAL_RESOURCE_TYPE_PREFIX,
  FUNCTIONAL_SLICE_TYPE_NAME,
} from "./host_contract.ts";
import {
  type FunctionalWasmArena,
  functionalWasmArenaDepth,
  functionalWasmArenaInstance,
  functionalWasmInstanceArenaDepth,
} from "./wasm_arena.ts";
import {
  decodeFunctionalWasmValue,
  encodeFunctionalWasmValue,
  forgetEncodedFunctionalWasmValue,
  functionalStructuredFieldTypes,
  type FunctionalWasmValue,
  releaseEncodedFunctionalWasmValue,
} from "./wasm_value_codec.ts";

export interface FunctionalWasmOwnedValueOptions {
  readonly maximumNodes?: number;
  readonly dropResource?: (resource: string, id: number) => void;
}

export interface FunctionalWasmOwnedValue {
  readonly encoded: bigint;
  readonly active: boolean;
  decode(maximumNodes?: number): FunctionalWasmValue;
  retain(): FunctionalWasmOwnedValue;
  transfer(): bigint;
  release(): void;
}

export function encodeFunctionalWasmArenaValue(
  arena: FunctionalWasmArena,
  module: GpuFunctionalModule,
  type: FunctionalType,
  value: FunctionalWasmValue,
): bigint {
  return encodeFunctionalWasmValue(
    functionalWasmArenaInstance(arena),
    module,
    type,
    value,
  );
}

export function promoteFunctionalWasmArenaValueToOwned(
  arena: FunctionalWasmArena,
  module: GpuFunctionalModule,
  type: FunctionalType,
  encoded: number | bigint,
  options: FunctionalWasmOwnedValueOptions = {},
): FunctionalWasmOwnedValue {
  if (functionalWasmArenaDepth(arena) !== 1) {
    throw new Error(
      `functional WASM arena at mark ${arena.mark} must be outermost before promotion to owned storage`,
    );
  }
  const instance = functionalWasmArenaInstance(arena);
  const value = decodeFunctionalWasmValue(
    instance,
    module,
    type,
    encoded,
    options.maximumNodes ?? 2_047,
  );
  arena.reset();
  return encodeFunctionalWasmOwnedValue(instance, module, type, value, options);
}

export function promoteFunctionalWasmArenaValueToParent(
  arena: FunctionalWasmArena,
  module: GpuFunctionalModule,
  type: FunctionalType,
  encoded: number | bigint,
  maximumNodes = 2_047,
): bigint {
  if (functionalWasmArenaDepth(arena) < 2) {
    throw new Error(
      `functional WASM arena at mark ${arena.mark} has no parent arena for promotion`,
    );
  }
  const instance = functionalWasmArenaInstance(arena);
  const value = decodeFunctionalWasmValue(
    instance,
    module,
    type,
    encoded,
    maximumNodes,
  );
  arena.reset();
  return encodeFunctionalWasmValue(instance, module, type, value);
}

export function encodeFunctionalWasmOwnedValue(
  instance: WebAssembly.Instance,
  module: GpuFunctionalModule,
  type: FunctionalType,
  value: FunctionalWasmValue,
  options: FunctionalWasmOwnedValueOptions = {},
): FunctionalWasmOwnedValue {
  const arenaDepth = functionalWasmInstanceArenaDepth(instance);
  if (arenaDepth !== 0) {
    throw new Error(
      `functional WASM owned values cannot be encoded while ${arenaDepth} arenas are active`,
    );
  }
  const encoded = encodeFunctionalWasmValue(instance, module, type, value);
  let resourceDropValue = value;
  if (options.dropResource !== undefined) {
    try {
      resourceDropValue = decodeFunctionalWasmValue(
        instance,
        module,
        type,
        encoded,
        Number.MAX_SAFE_INTEGER,
      );
    } catch (cause) {
      try {
        releaseEncodedFunctionalWasmValue(instance, encoded);
      } catch (cleanupCause) {
        throw new AggregateError(
          [cause, cleanupCause],
          "functional WASM owned value snapshot and cleanup both failed",
        );
      }
      throw cause;
    }
  }
  const ownership = { references: 1 };
  const createLease = (): FunctionalWasmOwnedValue => {
    let active = true;
    return {
      get encoded(): bigint {
        if (!active) throw new Error("functional WASM owned value was already released");
        return encoded;
      },
      get active(): boolean {
        return active;
      },
      decode(maximumNodes = options.maximumNodes ?? 2_047): FunctionalWasmValue {
        if (!active) throw new Error("functional WASM owned value was already released");
        return decodeFunctionalWasmValue(instance, module, type, encoded, maximumNodes);
      },
      retain(): FunctionalWasmOwnedValue {
        if (!active) throw new Error("functional WASM owned value was already released");
        ownership.references += 1;
        return createLease();
      },
      transfer(): bigint {
        if (!active) throw new Error("functional WASM owned value was already released");
        if (options.dropResource !== undefined) {
          throw new Error(
            "functional WASM owned value cannot transfer while host resource drop callbacks remain attached",
          );
        }
        if (ownership.references !== 1) {
          throw new Error(
            `functional WASM owned value cannot transfer with ${ownership.references} active leases`,
          );
        }
        forgetEncodedFunctionalWasmValue(instance, encoded);
        active = false;
        ownership.references = 0;
        return encoded;
      },
      release(): void {
        if (!active) throw new Error("functional WASM owned value was already released");
        const arenaDepth = functionalWasmInstanceArenaDepth(instance);
        if (ownership.references === 1 && arenaDepth !== 0) {
          throw new Error(
            `functional WASM owned value cannot release its final lease while ${arenaDepth} arenas are active`,
          );
        }
        active = false;
        ownership.references -= 1;
        if (ownership.references !== 0) return;
        const dropFailures: unknown[] = [];
        if (options.dropResource !== undefined) {
          const dropResource = options.dropResource;
          const pendingFields: {
            readonly type: FunctionalType;
            readonly value: FunctionalWasmValue;
          }[] = [{ type, value: resourceDropValue }];
          try {
            while (pendingFields.length !== 0) {
              const current = pendingFields.pop()!;
              const currentType = current.type;
              const currentValue = current.value;
              if (
                currentType.kind === "named" &&
                currentType.name.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)
              ) {
                if (currentValue.kind !== "resource") {
                  dropFailures.push(
                    new TypeError(
                      `functional WASM drop expected resource; received ${currentValue.kind}`,
                    ),
                  );
                  continue;
                }
                try {
                  dropResource(
                    decodeURIComponent(
                      currentType.name.slice(FUNCTIONAL_RESOURCE_TYPE_PREFIX.length),
                    ),
                    currentValue.id,
                  );
                } catch (cause) {
                  dropFailures.push(cause);
                }
                continue;
              }
              if (currentType.kind === "tuple") {
                if (currentValue.kind !== "tuple") continue;
                pendingFields.push(
                  { type: currentType.values[1], value: currentValue.values[1] },
                  { type: currentType.values[0], value: currentValue.values[0] },
                );
                continue;
              }
              if (
                currentType.kind === "named" &&
                (currentType.name === FUNCTIONAL_ARRAY_TYPE_NAME ||
                  currentType.name === FUNCTIONAL_SLICE_TYPE_NAME)
              ) {
                if (currentValue.kind !== "array" && currentValue.kind !== "slice") continue;
                const elementType = currentType.arguments[0];
                if (elementType === undefined) continue;
                for (let index = currentValue.values.length - 1; index >= 0; index--) {
                  const element = currentValue.values[index];
                  if (element !== undefined) {
                    pendingFields.push({ type: elementType, value: element });
                  }
                }
                continue;
              }
              if (currentType.kind !== "named" || currentValue.kind !== "constructor") continue;
              const fieldTypes = functionalStructuredFieldTypes(
                module,
                currentType,
                currentValue.name,
              );
              for (let index = fieldTypes.length - 1; index >= 0; index--) {
                const fieldType = fieldTypes[index];
                const field = currentValue.fields[index];
                if (fieldType !== undefined && field !== undefined) {
                  pendingFields.push({ type: fieldType, value: field });
                }
              }
            }
          } catch (cause) {
            dropFailures.push(cause);
          }
        }
        try {
          releaseEncodedFunctionalWasmValue(instance, encoded);
        } catch (cause) {
          dropFailures.push(cause);
        }
        if (dropFailures.length !== 0) {
          throw new AggregateError(
            dropFailures,
            `functional WASM owned value release failed in ${dropFailures.length} drop operations`,
          );
        }
      },
    };
  };
  return createLease();
}
