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
        active = false;
        ownership.references -= 1;
        if (ownership.references !== 0) return;
        const dropFailures: unknown[] = [];
        if (options.dropResource !== undefined) {
          const dropResource = options.dropResource;
          const dropResourceFields = (
            currentType: FunctionalType,
            currentValue: FunctionalWasmValue,
          ): void => {
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
                return;
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
              return;
            }
            if (currentType.kind === "tuple") {
              if (currentValue.kind !== "tuple") return;
              dropResourceFields(currentType.values[0], currentValue.values[0]);
              dropResourceFields(currentType.values[1], currentValue.values[1]);
              return;
            }
            if (
              currentType.kind === "named" &&
              (currentType.name === FUNCTIONAL_ARRAY_TYPE_NAME ||
                currentType.name === FUNCTIONAL_SLICE_TYPE_NAME)
            ) {
              if (currentValue.kind !== "array" && currentValue.kind !== "slice") return;
              const elementType = currentType.arguments[0];
              if (elementType === undefined) return;
              for (const element of currentValue.values) {
                dropResourceFields(elementType, element);
              }
              return;
            }
            if (currentType.kind !== "named" || currentValue.kind !== "constructor") return;
            const fieldTypes = functionalStructuredFieldTypes(
              module,
              currentType,
              currentValue.name,
            );
            for (const [index, fieldType] of fieldTypes.entries()) {
              const field = currentValue.fields[index];
              if (field !== undefined) dropResourceFields(fieldType, field);
            }
          };
          try {
            dropResourceFields(type, value);
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
