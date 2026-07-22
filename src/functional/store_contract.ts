import type { FunctionalTypeSchema } from "./schema_contract.ts";

export const FUNCTIONAL_STORE_TYPE_NAME = "$FunctionalStore";
export const FUNCTIONAL_MAXIMUM_STORE_LENGTH = 16_777_216;

export function functionalStoreType(element: FunctionalTypeSchema): FunctionalTypeSchema {
  return {
    kind: "named",
    name: FUNCTIONAL_STORE_TYPE_NAME,
    arguments: [element],
  };
}
