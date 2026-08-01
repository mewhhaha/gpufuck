import type { WasmExportDeclaration } from "./module_contract.ts";
import type { TypeSchema } from "./schema_contract.ts";
import { type EffectSet, effectSetFrom } from "./effect_set.ts";

export type HostType = TypeSchema;

export const INIT_TYPE_NAME = "$FunctionalInitType";
export const INIT_CONSTRUCTOR_NAME = "$FunctionalInit";
export const TEXT_TYPE_NAME = "$FunctionalText";
export const BYTES_TYPE_NAME = "$FunctionalBytes";
export const WHOLE_NUMBER_F64_TYPE_NAME = "$FunctionalWholeNumberF64";
export const ARRAY_TYPE_NAME = "$FunctionalArray";
export const SLICE_TYPE_NAME = "$FunctionalSlice";
export const RESOURCE_TYPE_PREFIX = "$FunctionalResource:";
export const ERASED_TYPE_NAME = "$FunctionalErased";

const MAXIMUM_HOST_TYPE_DEPTH = 64;
const MAXIMUM_HOST_TYPE_NODES = 4_096;

interface HostTypeTraversal {
  readonly activeTypes: WeakSet<object>;
  remainingNodes: number;
}

export const HostTypes: Readonly<{
  readonly text: TypeSchema;
  readonly bytes: TypeSchema;
  readonly wholeNumberF64: TypeSchema;
  readonly array: (element: TypeSchema) => TypeSchema;
  readonly slice: (element: TypeSchema) => TypeSchema;
  readonly resource: (name: string) => TypeSchema;
  readonly erased: TypeSchema;
  readonly bitBuffer: TypeSchema;
}> = Object.freeze({
  text: Object.freeze({ kind: "named", name: TEXT_TYPE_NAME, arguments: [] }),
  bytes: Object.freeze({ kind: "named", name: BYTES_TYPE_NAME, arguments: [] }),
  wholeNumberF64: Object.freeze({
    kind: "named",
    name: WHOLE_NUMBER_F64_TYPE_NAME,
    arguments: [],
  }),
  array(element: TypeSchema): TypeSchema {
    return Object.freeze({
      kind: "named",
      name: ARRAY_TYPE_NAME,
      arguments: Object.freeze([element]),
    });
  },
  slice(element: TypeSchema): TypeSchema {
    return Object.freeze({
      kind: "named",
      name: SLICE_TYPE_NAME,
      arguments: Object.freeze([element]),
    });
  },
  resource(name: string): TypeSchema {
    requireName(name, "resource type name");
    return Object.freeze({
      kind: "named",
      name: RESOURCE_TYPE_PREFIX + encodeURIComponent(name),
      arguments: Object.freeze([]),
    });
  },
  erased: Object.freeze({ kind: "named", name: ERASED_TYPE_NAME, arguments: [] }),
  bitBuffer: Object.freeze({
    kind: "tuple",
    values: Object.freeze(
      [
        Object.freeze({ kind: "named", name: BYTES_TYPE_NAME, arguments: [] }),
        Object.freeze({ kind: "integer" }),
      ] as const,
    ),
  }),
});

export type HostScalarType =
  | { readonly kind: "integer" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "float-32" }
  | { readonly kind: "float-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "unit" };

export const HostOwnership = {
  BoundedBorrow: "bounded-borrow",
  FrozenShareable: "frozen-shareable",
  OwnershipTransfer: "ownership-transfer",
  Unique: "unique",
} as const;

export type HostOwnership = (typeof HostOwnership)[keyof typeof HostOwnership];

export const WasmIntrinsic = {
  BufferByteLength: "buffer-byte-length",
  BufferByteGet: "buffer-byte-get",
  BufferByteSlice: "buffer-byte-slice",
  BufferGenerate: "buffer-generate",
  BufferAppend: "buffer-append",
  BufferEqual: "buffer-equal",
  BufferConvert: "buffer-convert",
  TextCodePointLength: "text-code-point-length",
  TextFromSignedInteger64: "text-from-signed-integer-64",
  TextCompare: "text-compare",
  TextContains: "text-contains",
} as const;

export type WasmIntrinsic = (typeof WasmIntrinsic)[keyof typeof WasmIntrinsic];

export interface HostValueDeclaration {
  readonly kind: "value";
  readonly name: string;
  readonly type: HostType;
  readonly representation?: HostType;
  readonly ownership?: "frozen-shareable" | "ownership-transfer";
  readonly wasmLiteral?: WasmLiteral;
}

export type WasmLiteral =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "bytes"; readonly value: readonly number[] };

export interface HostOperationDeclaration {
  readonly kind: "operation";
  readonly name: string;
  readonly effects: EffectSet;
  readonly execution?: "synchronous" | "suspending";
  readonly parameter: HostType;
  readonly result: HostType;
  readonly typeParameters?: readonly string[];
  readonly parameterRepresentation?: HostType;
  readonly resultRepresentation?: HostType;
  readonly parameterOwnership?: "bounded-borrow" | "ownership-transfer";
  readonly resultOwnership?: "frozen-shareable" | "ownership-transfer" | "unique";
  readonly wasmIntrinsic?: WasmIntrinsic;
}

export type HostFieldDeclaration =
  | HostValueDeclaration
  | HostOperationDeclaration;

export interface HostCapabilityDeclaration {
  readonly name: string;
  readonly fields: readonly HostFieldDeclaration[];
}

export interface HostDefinitionBinding {
  readonly definition: string;
  readonly capability: string;
  readonly field: string;
}

export interface SurfaceModuleOptions {
  readonly hostCapabilities?: readonly HostCapabilityDeclaration[];
  readonly hostDefinitions?: readonly HostDefinitionBinding[];
  readonly wasmExports?: readonly WasmExportDeclaration[];
}

export function normalizeHostCapabilities(
  declarations: readonly HostCapabilityDeclaration[] | undefined,
): readonly HostCapabilityDeclaration[] {
  if (declarations === undefined) return Object.freeze([]);
  if (!Array.isArray(declarations)) {
    throw new TypeError("functional host capabilities must be an array");
  }
  const capabilities: readonly HostCapabilityDeclaration[] = declarations;
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
    const declaredFields: readonly HostFieldDeclaration[] = declaration.fields;
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
        const typeParameters = new Set<string>();
        requireHostType(
          field.type,
          `capability ${JSON.stringify(declaration.name)} value ${JSON.stringify(field.name)}`,
          typeParameters,
        );
        if (field.representation !== undefined) {
          requireHostType(
            field.representation,
            `capability ${JSON.stringify(declaration.name)} value ${
              JSON.stringify(field.name)
            } representation`,
            typeParameters,
          );
          requireCompatibleRepresentation(
            field.type,
            field.representation,
            `capability ${JSON.stringify(declaration.name)} value ${JSON.stringify(field.name)}`,
          );
        }
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
        let wasmLiteral: WasmLiteral | undefined;
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
          ...(field.representation === undefined
            ? {}
            : { representation: Object.freeze({ ...field.representation }) }),
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
      if (!(field.effects instanceof Set)) {
        throw new TypeError(
          `functional host operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } effects must be a ReadonlySet; received ${JSON.stringify(field.effects)}`,
        );
      }
      const effects = effectSetFrom(field.effects);
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
      if (field.execution === "suspending" && effects.size === 0) {
        throw new Error(
          `functional suspending host operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } must declare at least one effect`,
        );
      }
      if (field.wasmIntrinsic !== undefined) {
        if (!Object.values(WasmIntrinsic).includes(field.wasmIntrinsic)) {
          throw new Error(
            `functional host operation ${
              JSON.stringify(`${declaration.name}.${field.name}`)
            } has unsupported WASM intrinsic ${JSON.stringify(field.wasmIntrinsic)}`,
          );
        }
        if (effects.size !== 0 || field.execution === "suspending") {
          throw new Error(
            `functional WASM intrinsic ${
              JSON.stringify(`${declaration.name}.${field.name}`)
            } must have no effects and be synchronous`,
          );
        }
        requireWasmIntrinsicSignature(field, declaration.name);
      }
      const typeParameters = normalizeTypeParameters(
        field.typeParameters,
        `${declaration.name}.${field.name}`,
      );
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
      if (field.wasmIntrinsic !== WasmIntrinsic.BufferGenerate) {
        requireHostType(
          field.parameter,
          `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} parameter`,
          typeParameters,
        );
      }
      requireHostType(
        field.result,
        `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} result`,
        typeParameters,
      );
      if (field.parameterRepresentation !== undefined) {
        requireHostType(
          field.parameterRepresentation,
          `operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } parameter representation`,
          typeParameters,
        );
        requireCompatibleRepresentation(
          field.parameter,
          field.parameterRepresentation,
          `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} parameter`,
        );
      }
      if (field.resultRepresentation !== undefined) {
        requireHostType(
          field.resultRepresentation,
          `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} result representation`,
          typeParameters,
        );
        requireCompatibleRepresentation(
          field.result,
          field.resultRepresentation,
          `operation ${JSON.stringify(`${declaration.name}.${field.name}`)} result`,
        );
      }
      if (typeParameters.size !== 0) {
        throw new Error(
          `functional host operation ${
            JSON.stringify(`${declaration.name}.${field.name}`)
          } remains polymorphic over ${
            JSON.stringify([...typeParameters])
          }; specialize it before module construction`,
        );
      }
      return Object.freeze({
        ...field,
        effects,
        execution: field.execution ?? "synchronous",
        parameter: Object.freeze({ ...field.parameter }),
        result: Object.freeze({ ...field.result }),
        ...(field.parameterRepresentation === undefined
          ? {}
          : { parameterRepresentation: Object.freeze({ ...field.parameterRepresentation }) }),
        ...(field.resultRepresentation === undefined
          ? {}
          : { resultRepresentation: Object.freeze({ ...field.resultRepresentation }) }),
      });
    });
    return Object.freeze({ name: declaration.name, fields: Object.freeze(fields) });
  }));
}

function normalizeWasmLiteral(
  literal: WasmLiteral,
  type: HostType,
  capability: string,
  field: string,
): WasmLiteral {
  const location = JSON.stringify(`${capability}.${field}`);
  if (literal.kind === "text") {
    if (
      type.kind !== "named" || type.name !== TEXT_TYPE_NAME ||
      typeof literal.value !== "string"
    ) {
      throw new Error(`functional WASM literal ${location} must match Text`);
    }
    return Object.freeze({ kind: "text", value: literal.value });
  }
  if (literal.kind !== "bytes" || !Array.isArray(literal.value)) {
    throw new Error(`functional WASM literal ${location} is unsupported`);
  }
  if (type.kind !== "named" || type.name !== BYTES_TYPE_NAME) {
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
  field: HostOperationDeclaration,
  capability: string,
): void {
  const intrinsic = field.wasmIntrinsic;
  if (intrinsic === undefined) return;
  const location = JSON.stringify(`${capability}.${field.name}`);
  if (intrinsic === WasmIntrinsic.TextCodePointLength) {
    requireTextType(field.parameter, `${location} parameter`);
    requireTypeKind(field.result, "signed-integer-64", `${location} result`);
    return;
  }
  if (intrinsic === WasmIntrinsic.TextFromSignedInteger64) {
    requireTypeKind(
      field.parameter,
      "signed-integer-64",
      `${location} parameter`,
    );
    requireTextType(field.result, `${location} result`);
    return;
  }
  if (intrinsic === WasmIntrinsic.TextCompare) {
    if (
      field.parameter.kind !== "named" ||
      field.parameter.arguments.length !== 2
    ) {
      throw new Error(
        `functional WASM intrinsic ${location} parameter must be a two-field nominal`,
      );
    }
    requireTextType(field.parameter.arguments[0]!, `${location} left`);
    requireTextType(field.parameter.arguments[1]!, `${location} right`);
    requireTypeKind(field.result, "signed-integer-64", `${location} result`);
    return;
  }
  if (intrinsic === WasmIntrinsic.TextContains) {
    if (
      field.parameter.kind !== "named" ||
      field.parameter.arguments.length !== 2
    ) {
      throw new Error(
        `functional WASM intrinsic ${location} parameter must be a two-field nominal`,
      );
    }
    requireTextType(field.parameter.arguments[0]!, `${location} text`);
    requireTextType(field.parameter.arguments[1]!, `${location} query`);
    requireTypeKind(field.result, "boolean", `${location} result`);
    return;
  }
  if (intrinsic === WasmIntrinsic.BufferByteLength) {
    requireBufferType(field.parameter, `${location} parameter`);
    requireTypeKind(field.result, "integer", `${location} result`);
    return;
  }
  if (intrinsic === WasmIntrinsic.BufferByteGet) {
    const [buffer, index] = requireTupleType(field.parameter, `${location} parameter`);
    requireBufferType(buffer, `${location} buffer`);
    requireTypeKind(index, "integer", `${location} index`);
    requireTypeKind(field.result, "integer", `${location} result`);
    return;
  }
  if (intrinsic === WasmIntrinsic.BufferConvert) {
    requireBufferType(field.parameter, `${location} parameter`);
    requireBufferType(field.result, `${location} result`);
    return;
  }
  if (intrinsic === WasmIntrinsic.BufferByteSlice) {
    const [buffer, bounds] = requireTupleType(field.parameter, `${location} parameter`);
    const [start, end] = requireTupleType(bounds, `${location} bounds`);
    requireBufferType(buffer, `${location} buffer`);
    requireTypeKind(start, "integer", `${location} start`);
    requireTypeKind(end, "integer", `${location} end`);
    requireSameBufferType(buffer, field.result, location);
    return;
  }
  if (intrinsic === WasmIntrinsic.BufferGenerate) {
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
  if (intrinsic === WasmIntrinsic.BufferAppend) {
    requireSameBufferType(left, field.result, location);
    return;
  }
  requireTypeKind(field.result, "boolean", `${location} result`);
}

function requireTupleType(
  type: HostType,
  location: string,
): readonly [HostType, HostType] {
  if (type.kind !== "tuple") {
    throw new Error(`functional WASM intrinsic ${location} must be a tuple`);
  }
  return type.values;
}

function requireBufferType(type: HostType, location: string): void {
  if (
    type.kind === "named" &&
    (type.name === TEXT_TYPE_NAME || type.name === BYTES_TYPE_NAME) &&
    type.arguments.length === 0
  ) return;
  throw new Error(`functional WASM intrinsic ${location} must be Text or Bytes`);
}

function requireTextType(type: HostType, location: string): void {
  if (
    type.kind === "named" &&
    type.name === TEXT_TYPE_NAME &&
    type.arguments.length === 0
  ) return;
  throw new Error(`functional WASM intrinsic ${location} must be Text`);
}

function requireSameBufferType(
  expected: HostType,
  actual: HostType,
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
  type: HostType,
  kind: "integer" | "signed-integer-64" | "boolean",
  location: string,
): void {
  if (type.kind !== kind) {
    throw new Error(`functional WASM intrinsic ${location} must be ${kind}`);
  }
}

export function hostFieldType(
  field: HostFieldDeclaration,
): TypeSchema {
  if (field.kind === "value") return field.type;
  return {
    kind: "function",
    parameter: field.parameter,
    result: field.result,
  };
}

export function hostFieldRepresentationType(
  field: HostFieldDeclaration,
): TypeSchema {
  if (field.kind === "value") return field.representation ?? field.type;
  return {
    kind: "function",
    parameter: field.parameterRepresentation ?? field.parameter,
    result: field.resultRepresentation ?? field.result,
  };
}

function requireName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `functional host ${location} must be nonempty; received ${JSON.stringify(name)}`,
    );
  }
}

function requireHostType(
  type: HostType,
  location: string,
  typeParameters: ReadonlySet<string>,
  depth = 0,
  traversal: HostTypeTraversal = {
    activeTypes: new WeakSet(),
    remainingNodes: MAXIMUM_HOST_TYPE_NODES,
  },
): void {
  if (depth > MAXIMUM_HOST_TYPE_DEPTH) {
    throw new RangeError(
      `functional host ${location} exceeds type depth ${MAXIMUM_HOST_TYPE_DEPTH}`,
    );
  }
  if (traversal.remainingNodes === 0) {
    throw new RangeError(
      `functional host ${location} exceeds ${MAXIMUM_HOST_TYPE_NODES} type nodes`,
    );
  }
  traversal.remainingNodes -= 1;
  if (type === null || typeof type !== "object" || typeof type.kind !== "string") {
    throw new TypeError(
      `functional host ${location} must be a type object; received ${JSON.stringify(type)}`,
    );
  }
  if (
    type.kind === "integer" || type.kind === "signed-integer-64" ||
    type.kind === "float-32" || type.kind === "float-64" ||
    type.kind === "boolean" || type.kind === "unit"
  ) return;
  if (traversal.activeTypes.has(type)) {
    throw new TypeError(`functional host ${location} contains a structural type cycle`);
  }
  if (type.kind === "tuple") {
    if (!Array.isArray(type.values) || type.values.length !== 2) {
      throw new TypeError(
        `functional host ${location} tuple must contain exactly two values; received ${
          JSON.stringify(type.values)
        }`,
      );
    }
    traversal.activeTypes.add(type);
    try {
      requireHostType(type.values[0], location, typeParameters, depth + 1, traversal);
      requireHostType(type.values[1], location, typeParameters, depth + 1, traversal);
    } finally {
      traversal.activeTypes.delete(type);
    }
    return;
  }
  if (type.kind === "named") {
    requireName(type.name, `${location} named type`);
    if (!Array.isArray(type.arguments)) {
      throw new TypeError(
        `functional host ${location} named type arguments must be an array; received ${
          JSON.stringify(type.arguments)
        }`,
      );
    }
    traversal.activeTypes.add(type);
    try {
      for (const argument of type.arguments) {
        requireHostType(argument, location, typeParameters, depth + 1, traversal);
      }
    } finally {
      traversal.activeTypes.delete(type);
    }
    return;
  }
  if (type.kind === "parameter") {
    requireName(type.name, `${location} type parameter`);
    if (typeParameters.has(type.name)) return;
  }
  throw new Error(
    `functional host ${location} must be a concrete first-order type; received kind ${
      JSON.stringify(type.kind)
    }`,
  );
}

function normalizeTypeParameters(
  parameters: readonly string[] | undefined,
  operation: string,
): ReadonlySet<string> {
  if (parameters === undefined) return new Set();
  if (!Array.isArray(parameters)) {
    throw new TypeError(
      `functional host operation ${JSON.stringify(operation)} typeParameters must be an array`,
    );
  }
  const names = new Set<string>();
  for (const [index, parameter] of parameters.entries()) {
    requireName(parameter, `operation ${JSON.stringify(operation)} type parameter ${index}`);
    if (names.has(parameter)) {
      throw new Error(
        `functional host operation ${JSON.stringify(operation)} repeats type parameter ${
          JSON.stringify(parameter)
        }`,
      );
    }
    names.add(parameter);
  }
  return names;
}

function requireCompatibleRepresentation(
  semantic: HostType,
  representation: HostType,
  location: string,
): void {
  if (sameHostType(semantic, representation)) return;
  if (
    representation.kind === "named" && representation.name === ERASED_TYPE_NAME &&
    representation.arguments.length === 0
  ) return;
  if (
    semantic.kind === "named" && representation.kind === "named" &&
    representation.name.startsWith(RESOURCE_TYPE_PREFIX) &&
    representation.arguments.length === 0
  ) return;
  throw new Error(
    `functional host ${location} representation ${
      JSON.stringify(representation)
    } is not ABI-compatible with semantic type ${JSON.stringify(semantic)}`,
  );
}

function sameHostType(left: HostType, right: HostType): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return true;
    case "parameter":
      return right.kind === "parameter" && left.name === right.name;
    case "tuple":
      return right.kind === "tuple" && sameHostType(left.values[0], right.values[0]) &&
        sameHostType(left.values[1], right.values[1]);
    case "named":
      return right.kind === "named" && left.name === right.name &&
        left.arguments.length === right.arguments.length &&
        left.arguments.every((argument, index) => sameHostType(argument, right.arguments[index]!));
    case "function":
    case "forall":
      return false;
  }
}
