import type { FunctionalEvaluationProfile, FunctionalTypeSchema } from "./abi.ts";
import type { FunctionalWasmExportDeclaration } from "./wasm_contract.ts";

export type FunctionalHostType = FunctionalTypeSchema;

export const FUNCTIONAL_INIT_TYPE_NAME = "$FunctionalInitType";
export const FUNCTIONAL_INIT_CONSTRUCTOR_NAME = "$FunctionalInit";
export const FUNCTIONAL_TEXT_TYPE_NAME = "$FunctionalText";
export const FUNCTIONAL_BYTES_TYPE_NAME = "$FunctionalBytes";
export const FUNCTIONAL_ARRAY_TYPE_NAME = "$FunctionalArray";
export const FUNCTIONAL_SLICE_TYPE_NAME = "$FunctionalSlice";
export const FUNCTIONAL_RESOURCE_TYPE_PREFIX = "$FunctionalResource:";

export const FunctionalHostTypes: Readonly<{
  readonly text: FunctionalTypeSchema;
  readonly bytes: FunctionalTypeSchema;
  readonly array: (element: FunctionalTypeSchema) => FunctionalTypeSchema;
  readonly slice: (element: FunctionalTypeSchema) => FunctionalTypeSchema;
  readonly resource: (name: string) => FunctionalTypeSchema;
}> = Object.freeze({
  text: Object.freeze({ kind: "named", name: FUNCTIONAL_TEXT_TYPE_NAME, arguments: [] }),
  bytes: Object.freeze({ kind: "named", name: FUNCTIONAL_BYTES_TYPE_NAME, arguments: [] }),
  array(element: FunctionalTypeSchema): FunctionalTypeSchema {
    return Object.freeze({
      kind: "named",
      name: FUNCTIONAL_ARRAY_TYPE_NAME,
      arguments: Object.freeze([element]),
    });
  },
  slice(element: FunctionalTypeSchema): FunctionalTypeSchema {
    return Object.freeze({
      kind: "named",
      name: FUNCTIONAL_SLICE_TYPE_NAME,
      arguments: Object.freeze([element]),
    });
  },
  resource(name: string): FunctionalTypeSchema {
    requireName(name, "resource type name");
    return Object.freeze({
      kind: "named",
      name: FUNCTIONAL_RESOURCE_TYPE_PREFIX + encodeURIComponent(name),
      arguments: Object.freeze([]),
    });
  },
});

export type FunctionalHostScalarType =
  | { readonly kind: "integer" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" };

export const FunctionalHostOwnership = {
  BoundedBorrow: "bounded-borrow",
  FrozenShareable: "frozen-shareable",
  OwnershipTransfer: "ownership-transfer",
  Unique: "unique",
} as const;

export type FunctionalHostOwnership =
  (typeof FunctionalHostOwnership)[keyof typeof FunctionalHostOwnership];

export const FunctionalWasmIntrinsic = {
  BufferByteLength: "buffer-byte-length",
  BufferByteGet: "buffer-byte-get",
  BufferByteSlice: "buffer-byte-slice",
  BufferGenerate: "buffer-generate",
  BufferAppend: "buffer-append",
  BufferEqual: "buffer-equal",
  BufferConvert: "buffer-convert",
} as const;

export type FunctionalWasmIntrinsic =
  (typeof FunctionalWasmIntrinsic)[keyof typeof FunctionalWasmIntrinsic];

export interface FunctionalHostValueDeclaration {
  readonly kind: "value";
  readonly name: string;
  readonly type: FunctionalHostType;
  readonly ownership?: "frozen-shareable" | "ownership-transfer";
  readonly wasmLiteral?: FunctionalWasmLiteral;
}

export type FunctionalWasmLiteral =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: readonly number[] };

export interface FunctionalHostOperationDeclaration {
  readonly kind: "operation";
  readonly name: string;
  readonly purity: "pure" | "effectful";
  readonly execution?: "synchronous" | "suspending";
  readonly parameter: FunctionalHostType;
  readonly result: FunctionalHostType;
  readonly parameterOwnership?: "bounded-borrow" | "ownership-transfer";
  readonly resultOwnership?: "frozen-shareable" | "ownership-transfer" | "unique";
  readonly wasmIntrinsic?: FunctionalWasmIntrinsic;
}

export type FunctionalHostFieldDeclaration =
  | FunctionalHostValueDeclaration
  | FunctionalHostOperationDeclaration;

export interface FunctionalHostCapabilityDeclaration {
  readonly name: string;
  readonly fields: readonly FunctionalHostFieldDeclaration[];
}

export interface FunctionalSurfaceModuleOptions {
  readonly hostCapabilities?: readonly FunctionalHostCapabilityDeclaration[];
  readonly evaluationProfile?: FunctionalEvaluationProfile;
  readonly wasmExports?: readonly FunctionalWasmExportDeclaration[];
}

export function normalizeFunctionalHostCapabilities(
  declarations: readonly FunctionalHostCapabilityDeclaration[] | undefined,
): readonly FunctionalHostCapabilityDeclaration[] {
  if (declarations === undefined) return Object.freeze([]);
  if (!Array.isArray(declarations)) {
    throw new TypeError("functional host capabilities must be an array");
  }
  const capabilities: readonly FunctionalHostCapabilityDeclaration[] = declarations;
  const capabilityNames = new Set<string>();
  return Object.freeze(capabilities.map((declaration, capabilityIndex) => {
    if (declaration === null || typeof declaration !== "object") {
      throw new TypeError(
        `functional host capability ${capabilityIndex} must be an object; received ${
          JSON.stringify(declaration)
        }`,
      );
    }
    requireName(declaration.name, `capability ${capabilityIndex} name`);
    if (capabilityNames.has(declaration.name)) {
      throw new Error(
        `functional host capabilities repeat capability ${JSON.stringify(declaration.name)}`,
      );
    }
    capabilityNames.add(declaration.name);
    if (!Array.isArray(declaration.fields)) {
      throw new TypeError(
        `functional host capability ${JSON.stringify(declaration.name)} fields must be an array`,
      );
    }
    const declaredFields: readonly FunctionalHostFieldDeclaration[] = declaration.fields;
    const fieldNames = new Set<string>();
    const fields = declaredFields.map((field, fieldIndex) => {
      if (field === null || typeof field !== "object") {
        throw new TypeError(
          `functional host capability ${
            JSON.stringify(declaration.name)
          } field ${fieldIndex} must be an object; received ${JSON.stringify(field)}`,
        );
      }
      requireName(
        field.name,
        `capability ${JSON.stringify(declaration.name)} field ${fieldIndex} name`,
      );
      if (fieldNames.has(field.name)) {
        throw new Error(
          `functional host capability ${JSON.stringify(declaration.name)} repeats field ${
            JSON.stringify(field.name)
          }`,
        );
      }
      fieldNames.add(field.name);
      if (field.kind === "value") {
        requireHostType(
          field.type,
          `capability ${JSON.stringify(declaration.name)} value ${JSON.stringify(field.name)}`,
        );
        if (
          field.ownership !== undefined && field.ownership !== "frozen-shareable" &&
          field.ownership !== "ownership-transfer"
        ) {
          throw new Error(
            `functional host value ${
              JSON.stringify(`${declaration.name}.${field.name}`)
            } has unsupported ownership ${JSON.stringify(field.ownership)}`,
          );
        }
        let wasmLiteral: FunctionalWasmLiteral | undefined;
        if (field.wasmLiteral !== undefined) {
          wasmLiteral = normalizeWasmLiteral(
            field.wasmLiteral,
            field.type,
            declaration.name,
            field.name,
          );
          if (field.ownership === "ownership-transfer") {
            throw new Error(
              `functional WASM literal ${
                JSON.stringify(`${declaration.name}.${field.name}`)
              } must be frozen-shareable`,
            );
          }
        }
        return Object.freeze({
          ...field,
          type: Object.freeze({ ...field.type }),
          ...(wasmLiteral === undefined ? {} : { wasmLiteral }),
        });
      }
      if (field.kind !== "operation") {
        const unsupported = field as { readonly kind?: unknown; readonly name?: unknown };
        throw new Error(
          `functional host capability ${JSON.stringify(declaration.name)} field ${
            JSON.stringify(unsupported.name)
          } has unsupported kind ${JSON.stringify(unsupported.kind)}`,
        );
      }
      if (field.purity !== "pure" && field.purity !== "effectful") {
        throw new Error(
          `functional host operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } has unsupported purity ${JSON.stringify(field.purity)}`,
        );
      }
      if (
        field.execution !== undefined && field.execution !== "synchronous" &&
        field.execution !== "suspending"
      ) {
        throw new Error(
          `functional host operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } has unsupported execution ${JSON.stringify(field.execution)}`,
        );
      }
      if (field.wasmIntrinsic !== undefined) {
        if (!Object.values(FunctionalWasmIntrinsic).includes(field.wasmIntrinsic)) {
          throw new Error(
            `functional host operation ${
              JSON.stringify(`${declaration.name}.${field.name}`)
            } has unsupported WASM intrinsic ${JSON.stringify(field.wasmIntrinsic)}`,
          );
        }
        if (field.purity !== "pure" || field.execution === "suspending") {
          throw new Error(
            `functional WASM intrinsic ${
              JSON.stringify(`${declaration.name}.${field.name}`)
            } must be pure and synchronous`,
          );
        }
        requireWasmIntrinsicSignature(field, declaration.name);
      }
      if (
        field.parameterOwnership !== undefined &&
        field.parameterOwnership !== "bounded-borrow" &&
        field.parameterOwnership !== "ownership-transfer"
      ) {
        throw new Error(
          `functional host operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } has unsupported parameter ownership ${JSON.stringify(field.parameterOwnership)}`,
        );
      }
      if (
        field.resultOwnership !== undefined && field.resultOwnership !== "frozen-shareable" &&
        field.resultOwnership !== "ownership-transfer" && field.resultOwnership !== "unique"
      ) {
        throw new Error(
          `functional host operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } has unsupported result ownership ${JSON.stringify(field.resultOwnership)}`,
        );
      }
      if (field.wasmIntrinsic !== FunctionalWasmIntrinsic.BufferGenerate) {
        requireHostType(
          field.parameter,
          `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} parameter`,
        );
      }
      requireHostType(
        field.result,
        `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} result`,
      );
      return Object.freeze({
        ...field,
        execution: field.execution ?? "synchronous",
        parameter: Object.freeze({ ...field.parameter }),
        result: Object.freeze({ ...field.result }),
      });
    });
    return Object.freeze({ name: declaration.name, fields: Object.freeze(fields) });
  }));
}

function normalizeWasmLiteral(
  literal: FunctionalWasmLiteral,
  type: FunctionalHostType,
  capability: string,
  field: string,
): FunctionalWasmLiteral {
  const location = JSON.stringify(`${capability}.${field}`);
  if (literal.kind === "text") {
    if (
      type.kind !== "named" || type.name !== FUNCTIONAL_TEXT_TYPE_NAME ||
      typeof literal.value !== "string"
    ) {
      throw new Error(`functional WASM literal ${location} must match Text`);
    }
    return Object.freeze({ kind: "text", value: literal.value });
  }
  if (literal.kind !== "bytes" || !Array.isArray(literal.value)) {
    throw new Error(`functional WASM literal ${location} is unsupported`);
  }
  if (type.kind !== "named" || type.name !== FUNCTIONAL_BYTES_TYPE_NAME) {
    throw new Error(`functional WASM literal ${location} must match Bytes`);
  }
  for (const [index, byte] of literal.value.entries()) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(
        `functional WASM literal ${location} byte ${index} must be within [0, 255]`,
      );
    }
  }
  return Object.freeze({ kind: "bytes", value: Object.freeze([...literal.value]) });
}

function requireWasmIntrinsicSignature(
  field: FunctionalHostOperationDeclaration,
  capability: string,
): void {
  const intrinsic = field.wasmIntrinsic;
  if (intrinsic === undefined) return;
  const location = JSON.stringify(`${capability}.${field.name}`);
  if (intrinsic === FunctionalWasmIntrinsic.BufferByteLength) {
    requireBufferType(field.parameter, `${location} parameter`);
    requireTypeKind(field.result, "integer", `${location} result`);
    return;
  }
  if (intrinsic === FunctionalWasmIntrinsic.BufferByteGet) {
    const [buffer, index] = requireTupleType(field.parameter, `${location} parameter`);
    requireBufferType(buffer, `${location} buffer`);
    requireTypeKind(index, "integer", `${location} index`);
    requireTypeKind(field.result, "integer", `${location} result`);
    return;
  }
  if (intrinsic === FunctionalWasmIntrinsic.BufferConvert) {
    requireBufferType(field.parameter, `${location} parameter`);
    requireBufferType(field.result, `${location} result`);
    return;
  }
  if (intrinsic === FunctionalWasmIntrinsic.BufferByteSlice) {
    const [buffer, bounds] = requireTupleType(field.parameter, `${location} parameter`);
    const [start, end] = requireTupleType(bounds, `${location} bounds`);
    requireBufferType(buffer, `${location} buffer`);
    requireTypeKind(start, "integer", `${location} start`);
    requireTypeKind(end, "integer", `${location} end`);
    requireSameBufferType(buffer, field.result, location);
    return;
  }
  if (intrinsic === FunctionalWasmIntrinsic.BufferGenerate) {
    const [length, generate] = requireTupleType(field.parameter, `${location} parameter`);
    requireTypeKind(length, "integer", `${location} length`);
    if (generate.kind !== "function") {
      throw new Error(`functional WASM intrinsic ${location} generator must be a function`);
    }
    requireTypeKind(generate.parameter, "integer", `${location} generator parameter`);
    requireTypeKind(generate.result, "integer", `${location} generator result`);
    requireBufferType(field.result, `${location} result`);
    return;
  }
  const [left, right] = requireTupleType(field.parameter, `${location} parameter`);
  requireBufferType(left, `${location} left`);
  requireSameBufferType(left, right, location);
  if (intrinsic === FunctionalWasmIntrinsic.BufferAppend) {
    requireSameBufferType(left, field.result, location);
    return;
  }
  requireTypeKind(field.result, "boolean", `${location} result`);
}

function requireTupleType(
  type: FunctionalHostType,
  location: string,
): readonly [FunctionalHostType, FunctionalHostType] {
  if (type.kind !== "tuple") {
    throw new Error(`functional WASM intrinsic ${location} must be a tuple`);
  }
  return type.values;
}

function requireBufferType(type: FunctionalHostType, location: string): void {
  if (
    type.kind === "named" &&
    (type.name === FUNCTIONAL_TEXT_TYPE_NAME || type.name === FUNCTIONAL_BYTES_TYPE_NAME) &&
    type.arguments.length === 0
  ) return;
  throw new Error(`functional WASM intrinsic ${location} must be Text or Bytes`);
}

function requireSameBufferType(
  expected: FunctionalHostType,
  actual: FunctionalHostType,
  location: string,
): void {
  requireBufferType(actual, `${location} buffer`);
  if (
    expected.kind !== "named" || actual.kind !== "named" ||
    expected.name !== actual.name
  ) {
    throw new Error(`functional WASM intrinsic ${location} must use one buffer type`);
  }
}

function requireTypeKind(
  type: FunctionalHostType,
  kind: "integer" | "boolean",
  location: string,
): void {
  if (type.kind !== kind) {
    throw new Error(`functional WASM intrinsic ${location} must be ${kind}`);
  }
}

export function functionalHostFieldType(
  field: FunctionalHostFieldDeclaration,
): FunctionalTypeSchema {
  if (field.kind === "value") return field.type;
  return {
    kind: "function",
    parameter: field.parameter,
    result: field.result,
  };
}

function requireName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `functional host ${location} must be nonempty; received ${JSON.stringify(name)}`,
    );
  }
}

function requireHostType(type: FunctionalHostType, location: string, depth = 0): void {
  if (depth > 64) throw new RangeError(`functional host ${location} exceeds type depth 64`);
  if (
    type?.kind === "integer" || type?.kind === "signed-integer-64" ||
    type?.kind === "float-32" || type?.kind === "float-64" ||
    type?.kind === "boolean" || type?.kind === "unit"
  ) return;
  if (type?.kind === "tuple") {
    requireHostType(type.values[0], location, depth + 1);
    requireHostType(type.values[1], location, depth + 1);
    return;
  }
  if (type?.kind === "named") {
    for (const argument of type.arguments) requireHostType(argument, location, depth + 1);
    return;
  }
  throw new Error(
    `functional host ${location} must be a concrete first-order type; received ${
      JSON.stringify(type)
    }`,
  );
}
