import { type FunctionalHostType, FunctionalHostTypes } from "./host_contract.ts";
import type { FunctionalWasmHostValue } from "./wasm_contract.ts";

type FunctionalResourceHandle = Extract<
  FunctionalWasmHostValue,
  { readonly kind: "resource" }
>;

export class FunctionalOpaqueResourceTable<Value> {
  readonly #resourceName: string;
  readonly #values = new Map<number, Value>();
  #nextId = 1;

  constructor(resourceName: string) {
    if (typeof resourceName !== "string" || resourceName.length === 0) {
      throw new Error(
        `functional opaque resource name must be nonempty; received ${
          JSON.stringify(resourceName)
        }`,
      );
    }
    this.#resourceName = resourceName;
  }

  get type(): FunctionalHostType {
    return FunctionalHostTypes.resource(this.#resourceName);
  }

  insert(value: Value): FunctionalResourceHandle {
    if (this.#nextId > 0xffff_ffff) {
      throw new RangeError(
        `functional opaque resource ${JSON.stringify(this.#resourceName)} exhausted u32 handles`,
      );
    }
    const id = this.#nextId++;
    this.#values.set(id, value);
    return { kind: "resource", id };
  }

  get(resource: FunctionalResourceHandle): Value {
    const value = this.#values.get(resource.id);
    if (value === undefined && !this.#values.has(resource.id)) {
      throw new Error(
        `functional opaque resource ${
          JSON.stringify(this.#resourceName)
        } has no live handle ${resource.id}`,
      );
    }
    return value!;
  }

  take(resource: FunctionalResourceHandle): Value {
    const value = this.get(resource);
    this.#values.delete(resource.id);
    return value;
  }

  drop(resource: FunctionalResourceHandle): void {
    if (!this.#values.delete(resource.id)) {
      throw new Error(
        `functional opaque resource ${
          JSON.stringify(this.#resourceName)
        } has no live handle ${resource.id}`,
      );
    }
  }
}
