import type { TypeSchema } from "./schema_contract.ts";

export const STORE_TYPE_NAME = "$FunctionalStore";
export const MAXIMUM_STORE_LENGTH = 16_777_216;

export function functionalStoreType(element: TypeSchema): TypeSchema {
  return {
    kind: "named",
    name: STORE_TYPE_NAME,
    arguments: [element],
  };
}
