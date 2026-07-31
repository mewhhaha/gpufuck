/**
 * The synchronous memory32 subset of the Component Model Canonical ABI used by
 * language frontends that publish a stable Core WebAssembly boundary.
 *
 * This describes the caller-facing value, not gpufuck's internal heap value.
 * Constructor names connect structural boundary values to their internal Core
 * representations and never appear in the emitted function signatures.
 */

export type CanonicalAbiType =
  | { readonly kind: "unit" }
  | { readonly kind: "signed-integer-64" }
  | { readonly kind: "boolean" }
  | { readonly kind: "text" }
  | {
    readonly kind: "array";
    readonly element: CanonicalAbiType;
  }
  | {
    readonly kind: "record";
    readonly constructor: string;
    readonly fields: readonly CanonicalAbiField[];
  }
  | {
    readonly kind: "variant";
    readonly cases: readonly CanonicalAbiCase[];
  }
  | {
    readonly kind: "sealed";
    readonly name: string;
    readonly constructor: string;
    readonly inner: CanonicalAbiType;
  };

export interface CanonicalAbiField {
  readonly name: string;
  readonly type: CanonicalAbiType;
  /** Field slot in the private Core constructor. Not part of the memory layout. */
  readonly coreIndex: number;
}

export interface CanonicalAbiCase {
  readonly name: string;
  readonly constructor: string;
  readonly payload?: CanonicalAbiType;
}

export interface CanonicalAbiFunction {
  readonly parameters: readonly CanonicalAbiType[];
  readonly result: CanonicalAbiType;
}

export interface CanonicalAbiExport {
  readonly name: string;
  readonly function: CanonicalAbiFunction;
  readonly postReturn?: string;
}

export interface CanonicalAbiImport {
  readonly capability: string;
  readonly operation: string;
  readonly module: string;
  readonly name: string;
  readonly function: CanonicalAbiFunction;
}

export interface CanonicalAbiInterface {
  readonly version: 1;
  readonly exports: readonly CanonicalAbiExport[];
  readonly imports: readonly CanonicalAbiImport[];
}

export type CanonicalAbiCoreType = "i32" | "i64";

export interface CanonicalAbiCoreSignature {
  readonly parameters: readonly CanonicalAbiCoreType[];
  readonly results: readonly CanonicalAbiCoreType[];
  readonly indirectParameters: boolean;
  readonly indirectResult: boolean;
}

export interface CanonicalAbiLayout {
  readonly alignment: number;
  readonly byteLength: number;
}

export interface CanonicalAbiRecordLayout extends CanonicalAbiLayout {
  readonly fields: readonly {
    readonly name: string;
    readonly type: CanonicalAbiType;
    readonly coreIndex: number;
    readonly offset: number;
  }[];
}

export interface CanonicalAbiVariantLayout extends CanonicalAbiLayout {
  readonly discriminantByteLength: 1 | 2 | 4;
  readonly payloadOffset: number;
  readonly payloadByteLength: number;
  readonly payloadAlignment: number;
}

export const CANONICAL_ABI_MAX_FLAT_PARAMETERS = 16;
export const CANONICAL_ABI_MAX_FLAT_RESULTS = 1;
const MAXIMUM_CANONICAL_ABI_TYPE_DEPTH = 64;
const MAXIMUM_CANONICAL_ABI_TYPE_NODES = 4_096;

export function validateCanonicalAbiInterface(
  interface_: CanonicalAbiInterface,
): void {
  if (
    interface_ === null ||
    typeof interface_ !== "object" ||
    interface_.version !== 1
  ) {
    throw new TypeError("canonical ABI interface version must be 1");
  }
  if (!Array.isArray(interface_.exports) || !Array.isArray(interface_.imports)) {
    throw new TypeError("canonical ABI exports and imports must be arrays");
  }
  const exportNames = new Set<string>();
  for (const [index, exported] of interface_.exports.entries()) {
    requireCanonicalAbiName(exported.name, `export ${index} name`);
    if (exportNames.has(exported.name)) {
      throw new TypeError(
        `canonical ABI repeats export ${JSON.stringify(exported.name)}`,
      );
    }
    exportNames.add(exported.name);
    validateCanonicalAbiFunction(exported.function, `export ${exported.name}`);
    const signature = canonicalAbiCoreSignature(exported.function, "export");
    if (signature.indirectResult && exported.postReturn === undefined) {
      throw new TypeError(
        `canonical ABI export ${JSON.stringify(exported.name)} requires post-return`,
      );
    }
    if (!signature.indirectResult && exported.postReturn !== undefined) {
      throw new TypeError(
        `canonical ABI export ${JSON.stringify(exported.name)} has unnecessary post-return`,
      );
    }
    if (exported.postReturn !== undefined) {
      requireCanonicalAbiName(
        exported.postReturn,
        `export ${exported.name} post-return`,
      );
      if (exportNames.has(exported.postReturn)) {
        throw new TypeError(
          `canonical ABI repeats export ${JSON.stringify(exported.postReturn)}`,
        );
      }
      exportNames.add(exported.postReturn);
    }
  }
  const importNames = new Set<string>();
  const operations = new Set<string>();
  for (const [index, imported] of interface_.imports.entries()) {
    requireCanonicalAbiName(imported.capability, `import ${index} capability`);
    requireCanonicalAbiName(imported.operation, `import ${index} operation`);
    requireCanonicalAbiName(imported.module, `import ${index} module`);
    requireCanonicalAbiName(imported.name, `import ${index} name`);
    const importName = `${imported.module}\u0000${imported.name}`;
    if (importNames.has(importName)) {
      throw new TypeError(
        `canonical ABI repeats import ${JSON.stringify(`${imported.module}.${imported.name}`)}`,
      );
    }
    importNames.add(importName);
    const operation = `${imported.capability}\u0000${imported.operation}`;
    if (operations.has(operation)) {
      throw new TypeError(
        `canonical ABI repeats host operation ${
          JSON.stringify(`${imported.capability}.${imported.operation}`)
        }`,
      );
    }
    operations.add(operation);
    validateCanonicalAbiFunction(
      imported.function,
      `import ${imported.capability}.${imported.operation}`,
    );
  }
}

function validateCanonicalAbiFunction(
  function_: CanonicalAbiFunction,
  location: string,
): void {
  if (
    function_ === null ||
    typeof function_ !== "object" ||
    !Array.isArray(function_.parameters)
  ) {
    throw new TypeError(`canonical ABI ${location} must be a function`);
  }
  const state = { remaining: MAXIMUM_CANONICAL_ABI_TYPE_NODES };
  for (const [index, parameter] of function_.parameters.entries()) {
    validateCanonicalAbiType(
      parameter,
      `${location} parameter ${index}`,
      0,
      state,
    );
  }
  validateCanonicalAbiType(function_.result, `${location} result`, 0, state);
}

function validateCanonicalAbiType(
  type: CanonicalAbiType,
  location: string,
  depth: number,
  state: { remaining: number },
): void {
  if (depth > MAXIMUM_CANONICAL_ABI_TYPE_DEPTH) {
    throw new TypeError(`canonical ABI ${location} exceeds the type depth limit`);
  }
  state.remaining -= 1;
  if (state.remaining < 0) {
    throw new TypeError(`canonical ABI ${location} exceeds the type size limit`);
  }
  if (type === null || typeof type !== "object") {
    throw new TypeError(`canonical ABI ${location} must be a type`);
  }
  if (
    type.kind === "unit" ||
    type.kind === "signed-integer-64" ||
    type.kind === "boolean" ||
    type.kind === "text"
  ) return;
  if (type.kind === "array") {
    validateCanonicalAbiType(type.element, `${location} element`, depth + 1, state);
    return;
  }
  if (type.kind === "sealed") {
    requireCanonicalAbiName(type.name, `${location} seal name`);
    requireCanonicalAbiName(type.constructor, `${location} constructor`);
    validateCanonicalAbiType(type.inner, `${location} carrier`, depth + 1, state);
    return;
  }
  if (type.kind === "record") {
    requireCanonicalAbiName(type.constructor, `${location} constructor`);
    if (!Array.isArray(type.fields)) {
      throw new TypeError(`canonical ABI ${location} fields must be an array`);
    }
    const coreIndices = new Set<number>();
    let previous: string | undefined;
    for (const [index, field] of type.fields.entries()) {
      requireCanonicalAbiName(field.name, `${location} field ${index}`);
      if (previous !== undefined && previous >= field.name) {
        throw new TypeError(
          `canonical ABI ${location} fields must be uniquely sorted by name`,
        );
      }
      previous = field.name;
      if (
        !Number.isInteger(field.coreIndex) ||
        field.coreIndex < 0 ||
        field.coreIndex >= type.fields.length ||
        coreIndices.has(field.coreIndex)
      ) {
        throw new TypeError(
          `canonical ABI ${location} field ${field.name} has invalid Core index ${field.coreIndex}`,
        );
      }
      coreIndices.add(field.coreIndex);
      validateCanonicalAbiType(
        field.type,
        `${location} field ${field.name}`,
        depth + 1,
        state,
      );
    }
    return;
  }
  if (type.kind === "variant") {
    if (!Array.isArray(type.cases) || type.cases.length === 0) {
      throw new TypeError(`canonical ABI ${location} must have variant cases`);
    }
    let previous: string | undefined;
    for (const [index, case_] of type.cases.entries()) {
      requireCanonicalAbiName(case_.name, `${location} case ${index}`);
      requireCanonicalAbiName(
        case_.constructor,
        `${location} case ${case_.name} constructor`,
      );
      if (previous !== undefined && previous >= case_.name) {
        throw new TypeError(
          `canonical ABI ${location} cases must be uniquely sorted by name`,
        );
      }
      previous = case_.name;
      if (case_.payload !== undefined) {
        validateCanonicalAbiType(
          case_.payload,
          `${location} case ${case_.name}`,
          depth + 1,
          state,
        );
      }
    }
    return;
  }
  throw new TypeError(
    `canonical ABI ${location} has unknown type kind ${
      JSON.stringify((type as { readonly kind?: unknown }).kind)
    }`,
  );
}

function requireCanonicalAbiName(value: unknown, location: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`canonical ABI ${location} must be a non-empty string`);
  }
}

export function canonicalAbiCoreSignature(
  function_: CanonicalAbiFunction,
  direction: "export" | "import",
): CanonicalAbiCoreSignature {
  let parameters = function_.parameters.flatMap(flattenCanonicalAbiType);
  const flatResults = flattenCanonicalAbiType(function_.result);
  let indirectParameters = false;
  let indirectResult = false;
  if (parameters.length > CANONICAL_ABI_MAX_FLAT_PARAMETERS) {
    parameters = ["i32"];
    indirectParameters = true;
  }
  let results = flatResults;
  if (flatResults.length > CANONICAL_ABI_MAX_FLAT_RESULTS) {
    indirectResult = true;
    if (direction === "export") {
      results = ["i32"];
    } else {
      parameters = [...parameters, "i32"];
      results = [];
    }
  }
  return {
    parameters,
    results,
    indirectParameters,
    indirectResult,
  };
}

export function flattenCanonicalAbiType(
  type: CanonicalAbiType,
): CanonicalAbiCoreType[] {
  switch (type.kind) {
    case "unit":
      return [];
    case "signed-integer-64":
      return ["i64"];
    case "boolean":
      return ["i32"];
    case "text":
    case "array":
      return ["i32", "i32"];
    case "sealed":
      return flattenCanonicalAbiType(type.inner);
    case "record":
      return type.fields.flatMap((field) => flattenCanonicalAbiType(field.type));
    case "variant": {
      let payload: CanonicalAbiCoreType[] = [];
      for (const case_ of type.cases) {
        const flattened = case_.payload === undefined ? [] : flattenCanonicalAbiType(case_.payload);
        payload = joinCanonicalAbiFlatTypes(payload, flattened);
      }
      return ["i32", ...payload];
    }
  }
}

export function canonicalAbiLayout(
  type: CanonicalAbiType,
): CanonicalAbiLayout {
  switch (type.kind) {
    case "unit":
      return { alignment: 1, byteLength: 0 };
    case "boolean":
      return { alignment: 1, byteLength: 1 };
    case "signed-integer-64":
      return { alignment: 8, byteLength: 8 };
    case "text":
    case "array":
      return { alignment: 4, byteLength: 8 };
    case "sealed":
      return canonicalAbiLayout(type.inner);
    case "record":
      return canonicalAbiRecordLayout(type);
    case "variant":
      return canonicalAbiVariantLayout(type);
  }
}

export function canonicalAbiRecordLayout(
  type: Extract<CanonicalAbiType, { readonly kind: "record" }>,
): CanonicalAbiRecordLayout {
  let alignment = 1;
  let byteLength = 0;
  const fields = type.fields.map((field) => {
    const layout = canonicalAbiLayout(field.type);
    alignment = Math.max(alignment, layout.alignment);
    byteLength = alignCanonicalAbi(byteLength, layout.alignment);
    const offset = byteLength;
    byteLength += layout.byteLength;
    return { ...field, offset };
  });
  return {
    alignment,
    byteLength: alignCanonicalAbi(byteLength, alignment),
    fields,
  };
}

export function canonicalAbiVariantLayout(
  type: Extract<CanonicalAbiType, { readonly kind: "variant" }>,
): CanonicalAbiVariantLayout {
  let discriminantByteLength: 1 | 2 | 4 = 1;
  if (type.cases.length > 0x100) discriminantByteLength = 2;
  if (type.cases.length > 0x1_0000) discriminantByteLength = 4;
  let payloadAlignment = 1;
  let payloadByteLength = 0;
  for (const case_ of type.cases) {
    if (case_.payload === undefined) continue;
    const layout = canonicalAbiLayout(case_.payload);
    payloadAlignment = Math.max(payloadAlignment, layout.alignment);
    payloadByteLength = Math.max(payloadByteLength, layout.byteLength);
  }
  const alignment = Math.max(discriminantByteLength, payloadAlignment);
  const payloadOffset = alignCanonicalAbi(
    discriminantByteLength,
    payloadAlignment,
  );
  return {
    alignment,
    byteLength: alignCanonicalAbi(
      payloadOffset + payloadByteLength,
      alignment,
    ),
    discriminantByteLength,
    payloadOffset,
    payloadByteLength,
    payloadAlignment,
  };
}

export function canonicalAbiParameterRecord(
  parameters: readonly CanonicalAbiType[],
): Extract<CanonicalAbiType, { readonly kind: "record" }> {
  return {
    kind: "record",
    constructor: "",
    fields: parameters.map((type, index) => ({
      name: String(index),
      type,
      coreIndex: index,
    })),
  };
}

export function alignCanonicalAbi(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function joinCanonicalAbiFlatTypes(
  left: readonly CanonicalAbiCoreType[],
  right: readonly CanonicalAbiCoreType[],
): CanonicalAbiCoreType[] {
  const length = Math.max(left.length, right.length);
  const joined: CanonicalAbiCoreType[] = [];
  for (let index = 0; index < length; index += 1) {
    const leftType = left[index];
    const rightType = right[index];
    if (leftType === undefined) {
      joined.push(rightType ?? "i32");
      continue;
    }
    if (rightType === undefined || leftType === rightType) {
      joined.push(leftType);
      continue;
    }
    joined.push("i64");
  }
  return joined;
}
