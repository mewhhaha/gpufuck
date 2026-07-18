import {
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  type FunctionalType,
  type FunctionalTypeSchema,
} from "./abi.ts";
import type { GpuFunctionalModule } from "./compiler_module.ts";
import type { FunctionalWasmHostValue } from "./wasm_contract.ts";
import {
  FUNCTIONAL_ARRAY_TYPE_NAME,
  FUNCTIONAL_BYTES_TYPE_NAME,
  FUNCTIONAL_RESOURCE_TYPE_PREFIX,
  FUNCTIONAL_SLICE_TYPE_NAME,
  FUNCTIONAL_TEXT_TYPE_NAME,
} from "./host_contract.ts";
import { FunctionalWasmValueAbi } from "./wasm_abi.ts";

const CONSTRUCTOR_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.constructor;
const NUMERIC_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.numeric;
const TEXT_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.text;
const BYTES_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.bytes;
const ARRAY_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.array;
const SLICE_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.slice;
const RESOURCE_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.resource;
const OBJECT_HEADER_BYTE_LENGTH = FunctionalWasmValueAbi.objectHeaderByteLength;
const OBJECT_REFERENCE_COUNT_BYTE_OFFSET = FunctionalWasmValueAbi.objectReferenceCountByteOffset;
const VALUE_BYTE_LENGTH = FunctionalWasmValueAbi.valueByteLength;

export type FunctionalWasmValue = FunctionalWasmHostValue;

export class FunctionalWasmValueError extends Error {
  readonly kind: "result-too-large" | "cyclic-result";

  constructor(kind: "result-too-large" | "cyclic-result", message: string) {
    super(message);
    this.name = "FunctionalWasmValueError";
    this.kind = kind;
  }
}

const allocationGroups = new WeakMap<
  WebAssembly.Instance,
  Map<number, readonly { readonly pointer: number; readonly byteLength: number }[]>
>();

export function discardEncodedFunctionalWasmValuesFrom(
  instance: WebAssembly.Instance,
  mark: number,
): void {
  const groups = allocationGroups.get(instance);
  if (groups === undefined) return;
  for (const [root, allocations] of groups) {
    if (allocations.some((allocation) => allocation.pointer >= mark)) {
      groups.delete(root);
    }
  }
}

export function forgetEncodedFunctionalWasmValue(
  instance: WebAssembly.Instance,
  encoded: bigint,
): void {
  allocationGroups.get(instance)?.delete(Number(BigInt.asUintN(32, encoded)));
}

export function describeFunctionalType(type: FunctionalType): string {
  switch (type.kind) {
    case "integer":
      return "integer";
    case "signed-integer-64":
      return "signed i64";
    case "float-32":
      return "f32";
    case "float-64":
      return "f64";
    case "boolean":
      return "boolean";
    case "unit":
      return "unit";
    case "named":
      if (type.name === FUNCTIONAL_TEXT_TYPE_NAME) return "text";
      if (type.name === FUNCTIONAL_BYTES_TYPE_NAME) return "bytes";
      if (type.name === FUNCTIONAL_ARRAY_TYPE_NAME) {
        return `array(${type.arguments.map(describeFunctionalType).join(", ")})`;
      }
      if (type.name === FUNCTIONAL_SLICE_TYPE_NAME) {
        return `slice(${type.arguments.map(describeFunctionalType).join(", ")})`;
      }
      if (type.name.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)) {
        return `resource(${
          decodeURIComponent(type.name.slice(FUNCTIONAL_RESOURCE_TYPE_PREFIX.length))
        })`;
      }
      return type.arguments.length === 0
        ? type.name
        : `${type.name}(${type.arguments.map(describeFunctionalType).join(", ")})`;
    case "tuple":
      return `(${type.values.map(describeFunctionalType).join(", ")})`;
    case "function":
      return `${describeFunctionalType(type.parameter)} -> ${describeFunctionalType(type.result)}`;
  }
}

export function encodeFunctionalWasmValue(
  instance: WebAssembly.Instance,
  module: GpuFunctionalModule,
  type: FunctionalType,
  value: FunctionalWasmValue,
): bigint {
  const memory = instance.exports.memory;
  const allocate = instance.exports.allocate;
  const free = instance.exports.free;
  if (
    !(memory instanceof WebAssembly.Memory) || typeof allocate !== "function" ||
    typeof free !== "function"
  ) {
    throw new Error("functional WASM input module omitted memory, allocate, or free exports");
  }
  const allocations: { readonly pointer: number; readonly byteLength: number }[] = [];
  const allocateBytesLength = (byteLength: number): number => {
    const alignedByteLength = (byteLength + 7) & ~7;
    const rawPointer = allocate(alignedByteLength) as number;
    const pointer = rawPointer >>> 0;
    const end = pointer + alignedByteLength;
    if (!Number.isSafeInteger(end) || end > memory.buffer.byteLength) {
      throw new RangeError(
        `functional WASM allocator returned ${pointer} for ${alignedByteLength} bytes with memory length ${memory.buffer.byteLength}`,
      );
    }
    allocations.push({ pointer, byteLength: alignedByteLength });
    return pointer;
  };
  const allocateObject = (
    objectKind: number,
    payload: number,
    fields: readonly bigint[],
  ): bigint => {
    const byteLength = OBJECT_HEADER_BYTE_LENGTH + fields.length * VALUE_BYTE_LENGTH;
    const pointer = allocateBytesLength(byteLength);
    const view = new DataView(memory.buffer);
    view.setUint32(pointer, objectKind, true);
    view.setUint32(pointer + 4, payload, true);
    view.setUint32(pointer + 8, fields.length, true);
    view.setUint32(pointer + OBJECT_REFERENCE_COUNT_BYTE_OFFSET, 1, true);
    for (const [index, field] of fields.entries()) {
      view.setBigInt64(
        pointer + OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH,
        BigInt.asIntN(64, field),
        true,
      );
    }
    return BigInt(pointer);
  };
  const allocateBytes = (objectKind: number, bytes: Uint8Array): bigint => {
    const byteLength = OBJECT_HEADER_BYTE_LENGTH + bytes.byteLength;
    const pointer = allocateBytesLength(byteLength);
    const view = new DataView(memory.buffer);
    view.setUint32(pointer, objectKind, true);
    view.setUint32(pointer + 4, 0, true);
    view.setUint32(pointer + 8, bytes.byteLength, true);
    view.setUint32(pointer + OBJECT_REFERENCE_COUNT_BYTE_OFFSET, 1, true);
    new Uint8Array(memory.buffer, pointer + OBJECT_HEADER_BYTE_LENGTH, bytes.byteLength).set(bytes);
    return BigInt(pointer);
  };
  const allocateConstructor = (constructorIndex: number, fields: readonly bigint[]): bigint =>
    allocateObject(CONSTRUCTOR_OBJECT_KIND, constructorIndex, fields);
  type EncodeFrame =
    | {
      readonly kind: "value";
      readonly expected: FunctionalType;
      readonly input: FunctionalWasmValue;
    }
    | {
      readonly kind: "object";
      readonly objectKind: number;
      readonly payload: number;
      readonly fieldCount: number;
      readonly source: object;
    };
  const encode = (expected: FunctionalType, input: FunctionalWasmValue): bigint => {
    const pending: EncodeFrame[] = [{ kind: "value", expected, input }];
    const encodedFields: bigint[] = [];
    const activeValues = new WeakSet<object>();
    const enterStructuredValue = (source: object, valueKind: string): void => {
      if (activeValues.has(source)) {
        throw new TypeError(`functional WASM argument contains a cyclic ${valueKind} value`);
      }
      activeValues.add(source);
    };
    while (pending.length !== 0) {
      const frame = pending.pop()!;
      if (frame.kind === "object") {
        const firstField = encodedFields.length - frame.fieldCount;
        if (firstField < 0) {
          throw new Error(
            `functional WASM ${frame.objectKind} object expected ${frame.fieldCount} encoded fields; received ${encodedFields.length}`,
          );
        }
        const fields = encodedFields.splice(firstField, frame.fieldCount);
        encodedFields.push(allocateObject(frame.objectKind, frame.payload, fields));
        activeValues.delete(frame.source);
        continue;
      }

      const currentType = frame.expected;
      const candidate: unknown = frame.input;
      if (
        candidate === null || typeof candidate !== "object" ||
        typeof (candidate as { readonly kind?: unknown }).kind !== "string"
      ) {
        throw new TypeError(
          `functional WASM argument expected ${describeFunctionalType(currentType)}; received ${
            candidate === null ? "null" : typeof candidate
          }`,
        );
      }
      const currentValue = candidate as FunctionalWasmValue;
      if (currentType.kind === "integer") {
        if (currentValue.kind !== "integer") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        if (
          !Number.isInteger(currentValue.value) || currentValue.value < -2_147_483_648 ||
          currentValue.value > 2_147_483_647
        ) {
          throw new RangeError(
            `functional WASM i32 argument is out of range: ${currentValue.value}`,
          );
        }
        encodedFields.push((BigInt(currentValue.value | 0) << 3n) | 1n);
        continue;
      }
      if (currentType.kind === "boolean") {
        if (currentValue.kind !== "boolean") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const payload: unknown = currentValue.value;
        if (typeof payload !== "boolean") {
          throw new TypeError(
            `functional WASM boolean argument payload must be boolean; received ${typeof payload}`,
          );
        }
        encodedFields.push((BigInt(payload ? 1 : 0) << 3n) | 2n);
        continue;
      }
      if (currentType.kind === "unit") {
        if (currentValue.kind !== "unit") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const constructorIndex = module.constructorNames.indexOf(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME);
        if (constructorIndex < 0) {
          throw new Error("functional WASM input omitted unit constructor");
        }
        encodedFields.push(allocateConstructor(constructorIndex, []));
        continue;
      }
      if (currentType.kind === "signed-integer-64") {
        if (currentValue.kind !== "signed-integer-64") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const payload: unknown = currentValue.value;
        if (
          typeof payload !== "bigint" ||
          payload < -0x8000000000000000n ||
          payload > 0x7fffffffffffffffn
        ) {
          throw new RangeError(
            `functional WASM i64 argument payload must be a signed i64; received ${
              typeof payload === "bigint" ? payload : typeof payload
            }`,
          );
        }
        encodedFields.push(allocateObject(
          NUMERIC_OBJECT_KIND,
          FunctionalWasmValueAbi.numericKinds.signedInteger64,
          [payload],
        ));
        continue;
      }
      if (currentType.kind === "float-32") {
        if (currentValue.kind !== "float-32") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const payload: unknown = currentValue.value;
        if (typeof payload !== "number") {
          throw new TypeError(
            `functional WASM f32 argument payload must be a number; received ${typeof payload}`,
          );
        }
        encodedFields.push(allocateObject(
          NUMERIC_OBJECT_KIND,
          FunctionalWasmValueAbi.numericKinds.float32,
          [BigInt(float32Bits(payload))],
        ));
        continue;
      }
      if (currentType.kind === "float-64") {
        if (currentValue.kind !== "float-64") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const payload: unknown = currentValue.value;
        if (typeof payload !== "number") {
          throw new TypeError(
            `functional WASM f64 argument payload must be a number; received ${typeof payload}`,
          );
        }
        encodedFields.push(allocateObject(
          NUMERIC_OBJECT_KIND,
          FunctionalWasmValueAbi.numericKinds.float64,
          [BigInt.asIntN(64, float64Bits(payload))],
        ));
        continue;
      }
      if (currentType.kind === "function") {
        throw new TypeError("functional WASM ABI does not accept host function arguments");
      }
      if (currentType.kind === "named" && currentType.name === FUNCTIONAL_TEXT_TYPE_NAME) {
        if (currentValue.kind !== "text") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const payload: unknown = currentValue.value;
        if (typeof payload !== "string") {
          throw new TypeError(
            `functional WASM text argument payload must be a string; received ${typeof payload}`,
          );
        }
        encodedFields.push(
          allocateBytes(TEXT_OBJECT_KIND, new TextEncoder().encode(payload)),
        );
        continue;
      }
      if (currentType.kind === "named" && currentType.name === FUNCTIONAL_BYTES_TYPE_NAME) {
        if (currentValue.kind !== "bytes") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const payload: unknown = currentValue.value;
        if (!(payload instanceof Uint8Array)) {
          throw new TypeError(
            `functional WASM bytes argument payload must be Uint8Array; received ${
              Object.prototype.toString.call(payload)
            }`,
          );
        }
        encodedFields.push(allocateBytes(BYTES_OBJECT_KIND, payload));
        continue;
      }
      if (
        currentType.kind === "named" &&
        (currentType.name === FUNCTIONAL_ARRAY_TYPE_NAME ||
          currentType.name === FUNCTIONAL_SLICE_TYPE_NAME)
      ) {
        const valueKind = currentType.name === FUNCTIONAL_ARRAY_TYPE_NAME ? "array" : "slice";
        if (currentValue.kind !== valueKind) {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const values: unknown = currentValue.values;
        if (!Array.isArray(values)) {
          throw new TypeError(
            `functional WASM ${valueKind} argument values must be an array; received ${
              Object.prototype.toString.call(values)
            }`,
          );
        }
        const elementType = currentType.arguments[0];
        if (elementType === undefined || currentType.arguments.length !== 1) {
          throw new TypeError(`${valueKind} boundary type requires exactly one element type`);
        }
        enterStructuredValue(currentValue, valueKind);
        pending.push({
          kind: "object",
          objectKind: valueKind === "array" ? ARRAY_OBJECT_KIND : SLICE_OBJECT_KIND,
          payload: 0,
          fieldCount: values.length,
          source: currentValue,
        });
        for (let index = values.length - 1; index >= 0; index--) {
          pending.push({
            kind: "value",
            expected: elementType,
            input: values[index] as FunctionalWasmValue,
          });
        }
        continue;
      }
      if (
        currentType.kind === "named" &&
        currentType.name.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)
      ) {
        if (currentValue.kind !== "resource") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        if (
          !Number.isInteger(currentValue.id) || currentValue.id < 0 || currentValue.id > 0xffffffff
        ) {
          throw new RangeError(`functional WASM resource id is outside u32: ${currentValue.id}`);
        }
        encodedFields.push(allocateObject(RESOURCE_OBJECT_KIND, currentValue.id, []));
        continue;
      }
      if (currentType.kind === "tuple") {
        if (currentValue.kind !== "tuple") {
          throw wasmArgumentTypeMismatch(currentType, currentValue);
        }
        const values: unknown = currentValue.values;
        if (!Array.isArray(values) || values.length !== 2) {
          throw new TypeError(
            `functional WASM tuple argument requires exactly 2 values; received ${
              Array.isArray(values) ? values.length : Object.prototype.toString.call(values)
            }`,
          );
        }
        const constructorIndex = module.constructorNames.indexOf(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME);
        if (constructorIndex < 0) {
          throw new Error("functional WASM input omitted tuple constructor");
        }
        enterStructuredValue(currentValue, "tuple");
        pending.push({
          kind: "object",
          objectKind: CONSTRUCTOR_OBJECT_KIND,
          payload: constructorIndex,
          fieldCount: 2,
          source: currentValue,
        });
        pending.push({
          kind: "value",
          expected: currentType.values[1],
          input: values[1] as FunctionalWasmValue,
        });
        pending.push({
          kind: "value",
          expected: currentType.values[0],
          input: values[0] as FunctionalWasmValue,
        });
        continue;
      }
      if (currentValue.kind !== "constructor") {
        throw wasmArgumentTypeMismatch(currentType, currentValue);
      }
      const constructorName: unknown = currentValue.name;
      if (typeof constructorName !== "string") {
        throw new TypeError(
          `functional WASM constructor argument name must be a string; received ${typeof constructorName}`,
        );
      }
      const fields: unknown = currentValue.fields;
      if (!Array.isArray(fields)) {
        throw new TypeError(
          `functional WASM constructor argument fields must be an array; received ${
            Object.prototype.toString.call(fields)
          }`,
        );
      }
      const constructorIndex = module.constructorNames.indexOf(constructorName);
      if (constructorIndex < 0) {
        throw new TypeError(
          `functional WASM argument names unknown constructor ${JSON.stringify(constructorName)}`,
        );
      }
      const fieldTypes = functionalStructuredFieldTypes(
        module,
        currentType,
        constructorName,
      );
      if (fieldTypes.length !== fields.length) {
        throw new TypeError(
          `functional WASM argument constructor ${
            JSON.stringify(constructorName)
          } expects ${fieldTypes.length} fields; received ${fields.length}`,
        );
      }
      enterStructuredValue(currentValue, `constructor ${JSON.stringify(constructorName)}`);
      pending.push({
        kind: "object",
        objectKind: CONSTRUCTOR_OBJECT_KIND,
        payload: constructorIndex,
        fieldCount: fieldTypes.length,
        source: currentValue,
      });
      for (let index = fieldTypes.length - 1; index >= 0; index--) {
        pending.push({
          kind: "value",
          expected: fieldTypes[index]!,
          input: fields[index] as FunctionalWasmValue,
        });
      }
    }
    if (encodedFields.length !== 1) {
      throw new Error(
        `functional WASM argument encoding produced ${encodedFields.length} root values; expected 1`,
      );
    }
    return encodedFields[0]!;
  };
  let encoded: bigint;
  try {
    encoded = encode(type, value);
  } catch (cause) {
    try {
      for (let index = allocations.length - 1; index >= 0; index--) {
        const allocation = allocations[index];
        if (allocation !== undefined) free(allocation.pointer, allocation.byteLength);
      }
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        `functional WASM argument encoding and cleanup both failed after ${allocations.length} allocations`,
      );
    }
    throw cause;
  }
  if (allocations.length !== 0) {
    let groups = allocationGroups.get(instance);
    if (groups === undefined) {
      groups = new Map();
      allocationGroups.set(instance, groups);
    }
    groups.set(Number(BigInt.asUintN(32, encoded)), Object.freeze([...allocations]));
  }
  return encoded;
}

export function releaseEncodedFunctionalWasmValue(
  instance: WebAssembly.Instance,
  encoded: bigint,
): void {
  const groups = allocationGroups.get(instance);
  if (groups === undefined) return;
  const root = Number(BigInt.asUintN(32, encoded));
  const allocations = groups.get(root);
  if (allocations === undefined) return;
  const free = instance.exports.free;
  if (typeof free !== "function") {
    throw new Error("functional WASM input module omitted its free export");
  }
  for (let index = allocations.length - 1; index >= 0; index--) {
    const allocation = allocations[index];
    if (allocation === undefined) {
      throw new Error(`functional WASM allocation group omitted entry ${index}`);
    }
    free(allocation.pointer, allocation.byteLength);
  }
  groups.delete(root);
}

export function decodeFunctionalWasmValue(
  instance: WebAssembly.Instance,
  module: GpuFunctionalModule,
  type: FunctionalType,
  rawResult: number | bigint,
  maximumResultNodes: number,
): FunctionalWasmValue {
  if (!Number.isSafeInteger(maximumResultNodes) || maximumResultNodes < 1) {
    throw new RangeError(
      `functional WASM maximumResultNodes must be a positive safe integer; received ${maximumResultNodes}`,
    );
  }
  if (type.kind === "integer") return { kind: "integer", value: Number(rawResult) | 0 };
  if (type.kind === "signed-integer-64") {
    return { kind: "signed-integer-64", value: BigInt(rawResult) };
  }
  if (type.kind === "float-32") return { kind: "float-32", value: Number(rawResult) };
  if (type.kind === "float-64") return { kind: "float-64", value: Number(rawResult) };
  if (type.kind === "boolean") return { kind: "boolean", value: Number(rawResult) !== 0 };
  if (type.kind === "unit") return { kind: "unit" };
  if (type.kind === "function") {
    throw new TypeError(
      `functional WASM cannot decode function result ${describeFunctionalType(type)}`,
    );
  }
  const memory = instance.exports.memory;
  const forceValue = instance.exports.forceValue;
  if (!(memory instanceof WebAssembly.Memory) || typeof forceValue !== "function") {
    throw new Error("functional WASM structured result omitted memory or forceValue exports");
  }

  type DecodeFrame =
    | {
      readonly kind: "value";
      readonly rawValue: bigint;
      readonly expected: FunctionalType;
    }
    | {
      readonly kind: "collection";
      readonly pointer: number;
      readonly valueKind: "array" | "slice";
      readonly elementType: FunctionalType;
      readonly valueCount: number;
      nextIndex: number;
      readonly values: FunctionalWasmValue[];
    }
    | {
      readonly kind: "constructor";
      readonly pointer: number;
      readonly expected: Extract<FunctionalType, { readonly kind: "tuple" | "named" }>;
      readonly constructorName: string;
      readonly fieldTypes: readonly FunctionalType[];
      nextIndex: number;
      readonly fields: FunctionalWasmValue[];
    };

  let decodedNodes = 0;
  let decodedResult: FunctionalWasmValue | undefined;
  const activePointers = new Set<number>();
  const frames: DecodeFrame[] = [{
    kind: "value",
    rawValue: BigInt(rawResult),
    expected: type,
  }];
  const appendDecodedValue = (value: FunctionalWasmValue): void => {
    const parent = frames.at(-1);
    if (parent === undefined) {
      decodedResult = value;
      return;
    }
    if (parent.kind === "value") {
      throw new Error("functional WASM decoder retained a completed value frame");
    }
    if (parent.kind === "collection") {
      parent.values.push(value);
      return;
    }
    parent.fields.push(value);
  };

  while (frames.length !== 0) {
    const frame = frames.at(-1)!;
    if (frame.kind === "collection") {
      if (frame.nextIndex === frame.valueCount) {
        activePointers.delete(frame.pointer);
        frames.pop();
        appendDecodedValue(
          frame.valueKind === "array"
            ? { kind: "array", values: frame.values }
            : { kind: "slice", values: frame.values },
        );
        continue;
      }
      const index = frame.nextIndex;
      frame.nextIndex += 1;
      const view = new DataView(memory.buffer);
      const offset = frame.pointer + OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH;
      if (offset > view.byteLength - VALUE_BYTE_LENGTH) {
        throw new RangeError(
          `functional WASM ${frame.valueKind} element ${index} exceeds memory length ${view.byteLength}`,
        );
      }
      frames.push({
        kind: "value",
        rawValue: view.getBigInt64(offset, true),
        expected: frame.elementType,
      });
      continue;
    }
    if (frame.kind === "constructor") {
      if (frame.nextIndex === frame.fieldTypes.length) {
        activePointers.delete(frame.pointer);
        frames.pop();
        if (frame.expected.kind === "tuple") {
          const first = frame.fields[0];
          const second = frame.fields[1];
          if (first === undefined || second === undefined) {
            throw new Error("functional WASM tuple result omitted a field");
          }
          appendDecodedValue({ kind: "tuple", values: [first, second] });
        } else {
          appendDecodedValue({
            kind: "constructor",
            name: frame.constructorName,
            fields: frame.fields,
          });
        }
        continue;
      }
      const index = frame.nextIndex;
      const fieldType = frame.fieldTypes[index];
      if (fieldType === undefined) {
        throw new Error(
          `functional WASM constructor ${
            JSON.stringify(frame.constructorName)
          } omitted field type ${index}`,
        );
      }
      frame.nextIndex += 1;
      const view = new DataView(memory.buffer);
      const offset = frame.pointer + OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH;
      if (offset > view.byteLength - VALUE_BYTE_LENGTH) {
        throw new RangeError(
          `functional WASM constructor ${
            JSON.stringify(frame.constructorName)
          } field ${index} exceeds memory length ${view.byteLength}`,
        );
      }
      frames.push({
        kind: "value",
        rawValue: view.getBigInt64(offset, true),
        expected: fieldType,
      });
      continue;
    }

    decodedNodes += 1;
    if (decodedNodes > maximumResultNodes) {
      throw new FunctionalWasmValueError(
        "result-too-large",
        `functional WASM result exceeded maximumResultNodes ${maximumResultNodes} while decoding ${
          describeFunctionalType(type)
        }`,
      );
    }
    const forced = forceValue(frame.rawValue) as bigint;
    const expected = frame.expected;
    if (expected.kind === "integer") {
      frames.pop();
      appendDecodedValue({
        kind: "integer",
        value: Number(BigInt.asIntN(32, forced >> 3n)),
      });
      continue;
    }
    if (expected.kind === "boolean") {
      frames.pop();
      appendDecodedValue({ kind: "boolean", value: forced >> 3n !== 0n });
      continue;
    }
    if (expected.kind === "unit") {
      frames.pop();
      appendDecodedValue({ kind: "unit" });
      continue;
    }
    if (
      expected.kind === "signed-integer-64" || expected.kind === "float-32" ||
      expected.kind === "float-64"
    ) {
      frames.pop();
      appendDecodedValue(decodeBoxedNumeric(memory, forced, expected));
      continue;
    }
    if (expected.kind === "function") {
      throw new TypeError("functional WASM structured results cannot contain function fields");
    }
    const pointer = Number(BigInt.asUintN(32, forced));
    if (activePointers.has(pointer)) {
      throw new FunctionalWasmValueError(
        "cyclic-result",
        `functional WASM structured result contains a cycle through pointer ${pointer}`,
      );
    }
    const view = new DataView(memory.buffer);
    if (pointer > view.byteLength - OBJECT_HEADER_BYTE_LENGTH) {
      throw new RangeError(
        `functional WASM constructor pointer ${pointer} exceeds memory length ${view.byteLength}`,
      );
    }
    const objectKind = view.getUint32(pointer, true);
    const valueCount = view.getUint32(pointer + 8, true);
    if (expected.kind === "named" && expected.name === FUNCTIONAL_TEXT_TYPE_NAME) {
      requireObjectKind(pointer, objectKind, TEXT_OBJECT_KIND, "text");
      const bytes = boundedBytes(view, pointer, valueCount, "text");
      frames.pop();
      appendDecodedValue({
        kind: "text",
        value: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      });
      continue;
    }
    if (expected.kind === "named" && expected.name === FUNCTIONAL_BYTES_TYPE_NAME) {
      requireObjectKind(pointer, objectKind, BYTES_OBJECT_KIND, "bytes");
      frames.pop();
      appendDecodedValue({
        kind: "bytes",
        value: boundedBytes(view, pointer, valueCount, "bytes").slice(),
      });
      continue;
    }
    if (
      expected.kind === "named" &&
      (expected.name === FUNCTIONAL_ARRAY_TYPE_NAME ||
        expected.name === FUNCTIONAL_SLICE_TYPE_NAME)
    ) {
      const valueKind = expected.name === FUNCTIONAL_ARRAY_TYPE_NAME ? "array" : "slice";
      requireObjectKind(
        pointer,
        objectKind,
        valueKind === "array" ? ARRAY_OBJECT_KIND : SLICE_OBJECT_KIND,
        valueKind,
      );
      const elementType = expected.arguments[0];
      if (elementType === undefined || expected.arguments.length !== 1) {
        throw new TypeError(`${valueKind} boundary type requires exactly one element type`);
      }
      activePointers.add(pointer);
      frames[frames.length - 1] = {
        kind: "collection",
        pointer,
        valueKind,
        elementType,
        valueCount,
        nextIndex: 0,
        values: [],
      };
      continue;
    }
    if (expected.kind === "named" && expected.name.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)) {
      requireObjectKind(pointer, objectKind, RESOURCE_OBJECT_KIND, "resource");
      frames.pop();
      appendDecodedValue({ kind: "resource", id: view.getUint32(pointer + 4, true) });
      continue;
    }
    if (objectKind !== CONSTRUCTOR_OBJECT_KIND) {
      throw new Error(
        `functional WASM result pointer ${pointer} has object kind ${objectKind}; expected constructor kind ${CONSTRUCTOR_OBJECT_KIND}`,
      );
    }
    const constructorIndex = view.getUint32(pointer + 4, true);
    const constructorName = module.constructorNames[constructorIndex];
    if (constructorName === undefined) {
      throw new Error(
        `functional WASM result references constructor ${constructorIndex} beyond ${module.constructorCount}`,
      );
    }
    const fieldTypes = functionalStructuredFieldTypes(module, expected, constructorName);
    if (fieldTypes.length !== valueCount) {
      throw new Error(
        `functional WASM constructor ${
          JSON.stringify(constructorName)
        } stores ${valueCount} fields; its type declares ${fieldTypes.length}`,
      );
    }
    activePointers.add(pointer);
    frames[frames.length - 1] = {
      kind: "constructor",
      pointer,
      expected,
      constructorName,
      fieldTypes,
      nextIndex: 0,
      fields: [],
    };
  }

  if (decodedResult === undefined) {
    throw new Error("functional WASM decoder completed without a value");
  }
  return decodedResult;
}

export function concreteFunctionalType(schema: FunctionalTypeSchema): FunctionalType {
  return instantiateSchema(schema, new Map());
}

export function requireFirstOrderFunctionalWasmType(
  module: GpuFunctionalModule,
  type: FunctionalType,
  location: string,
): void {
  const visitedNamedTypes = new Set<string>();
  const visit = (current: FunctionalType, path: string): void => {
    switch (current.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return;
      case "function":
        throw new TypeError(
          `functional WASM ${location} contains a function at ${path}; the public boundary accepts only concrete first-order values`,
        );
      case "tuple":
        visit(current.values[0], `${path}.0`);
        visit(current.values[1], `${path}.1`);
        return;
      case "named": {
        for (const [index, argument] of current.arguments.entries()) {
          visit(argument, `${path}.arguments[${index}]`);
        }
        if (
          current.name === FUNCTIONAL_TEXT_TYPE_NAME ||
          current.name === FUNCTIONAL_BYTES_TYPE_NAME ||
          current.name === FUNCTIONAL_ARRAY_TYPE_NAME ||
          current.name === FUNCTIONAL_SLICE_TYPE_NAME ||
          current.name.startsWith(FUNCTIONAL_RESOURCE_TYPE_PREFIX)
        ) return;
        const key = JSON.stringify(current);
        if (visitedNamedTypes.has(key)) return;
        visitedNamedTypes.add(key);
        const declaration = module.typeDeclarations.find((candidate) =>
          candidate.name === current.name
        );
        if (declaration === undefined) {
          throw new TypeError(
            `functional WASM ${location} references undeclared type ${
              JSON.stringify(current.name)
            } at ${path}`,
          );
        }
        if (declaration.parameters.length !== current.arguments.length) {
          throw new TypeError(
            `functional WASM ${location} type ${
              JSON.stringify(current.name)
            } expects ${declaration.parameters.length} arguments; received ${current.arguments.length} at ${path}`,
          );
        }
        const parameters = new Map(
          declaration.parameters.map((parameter, index) => [parameter, current.arguments[index]!]),
        );
        for (const constructor of declaration.constructors) {
          for (const [index, field] of constructor.fields.entries()) {
            visit(
              instantiateSchema(field.type, parameters),
              `${path}.${constructor.name}.fields[${index}]`,
            );
          }
        }
      }
    }
  };
  visit(type, "$");
}

function decodeBoxedNumeric(
  memory: WebAssembly.Memory,
  rawValue: bigint,
  expected: Extract<
    FunctionalType,
    { readonly kind: "signed-integer-64" | "float-32" | "float-64" }
  >,
): FunctionalWasmValue {
  const pointer = Number(BigInt.asUintN(32, rawValue));
  const view = new DataView(memory.buffer);
  if (pointer > view.byteLength - (OBJECT_HEADER_BYTE_LENGTH + VALUE_BYTE_LENGTH)) {
    throw new RangeError(
      `functional WASM numeric pointer ${pointer} exceeds memory length ${view.byteLength}`,
    );
  }
  const objectKind = view.getUint32(pointer, true);
  const numericKind = view.getUint32(pointer + 4, true);
  if (objectKind !== NUMERIC_OBJECT_KIND) {
    throw new Error(
      `functional WASM ${expected.kind} pointer ${pointer} has object kind ${objectKind}; expected ${NUMERIC_OBJECT_KIND}`,
    );
  }
  if (expected.kind === "signed-integer-64") {
    if (numericKind !== FunctionalWasmValueAbi.numericKinds.signedInteger64) {
      throw new Error(`functional WASM i64 pointer ${pointer} has numeric kind ${numericKind}`);
    }
    return {
      kind: "signed-integer-64",
      value: view.getBigInt64(pointer + OBJECT_HEADER_BYTE_LENGTH, true),
    };
  }
  if (expected.kind === "float-32") {
    if (numericKind !== FunctionalWasmValueAbi.numericKinds.float32) {
      throw new Error(`functional WASM f32 pointer ${pointer} has numeric kind ${numericKind}`);
    }
    return {
      kind: "float-32",
      value: view.getFloat32(pointer + OBJECT_HEADER_BYTE_LENGTH, true),
    };
  }
  if (numericKind !== FunctionalWasmValueAbi.numericKinds.float64) {
    throw new Error(`functional WASM f64 pointer ${pointer} has numeric kind ${numericKind}`);
  }
  return {
    kind: "float-64",
    value: view.getFloat64(pointer + OBJECT_HEADER_BYTE_LENGTH, true),
  };
}

function wasmArgumentTypeMismatch(type: FunctionalType, value: FunctionalWasmValue): TypeError {
  return new TypeError(
    `functional WASM argument expected ${describeFunctionalType(type)}; received ${value.kind}`,
  );
}

function requireObjectKind(
  pointer: number,
  actual: number,
  expected: number,
  valueKind: string,
): void {
  if (actual === expected) return;
  throw new Error(
    `functional WASM ${valueKind} pointer ${pointer} has object kind ${actual}; expected ${expected}`,
  );
}

function boundedBytes(
  view: DataView,
  pointer: number,
  byteLength: number,
  valueKind: string,
): Uint8Array {
  const start = pointer + OBJECT_HEADER_BYTE_LENGTH;
  const end = start + byteLength;
  if (!Number.isSafeInteger(end) || end > view.byteLength) {
    throw new RangeError(
      `functional WASM ${valueKind} at pointer ${pointer} stores ${byteLength} bytes beyond memory length ${view.byteLength}`,
    );
  }
  return new Uint8Array(view.buffer, start, byteLength);
}

export function functionalStructuredFieldTypes(
  module: GpuFunctionalModule,
  type: Extract<FunctionalType, { readonly kind: "tuple" | "named" }>,
  constructorName: string,
): readonly FunctionalType[] {
  if (type.kind === "tuple") {
    if (constructorName !== FUNCTIONAL_PAIR_CONSTRUCTOR_NAME) {
      throw new Error(
        `functional WASM tuple result used constructor ${JSON.stringify(constructorName)}`,
      );
    }
    return type.values;
  }
  const declaration = module.typeDeclarations.find((candidate) => candidate.name === type.name);
  if (declaration === undefined) {
    throw new Error(`functional WASM result type ${JSON.stringify(type.name)} is undeclared`);
  }
  const constructor = declaration.constructors.find((candidate) =>
    candidate.name === constructorName
  );
  if (constructor === undefined) {
    throw new Error(
      `functional WASM constructor ${JSON.stringify(constructorName)} does not belong to ${
        JSON.stringify(type.name)
      }`,
    );
  }
  const parameters = new Map<string, FunctionalType>();
  if (constructor.result === undefined) {
    for (const [index, parameter] of declaration.parameters.entries()) {
      const argument = type.arguments[index];
      if (argument === undefined) {
        throw new Error(
          `functional WASM result type ${JSON.stringify(type.name)} omitted argument ${index}`,
        );
      }
      parameters.set(parameter, argument);
    }
  } else if (!matchConstructorResult(constructor.result, type, parameters)) {
    throw new Error(
      `functional WASM constructor ${JSON.stringify(constructorName)} does not inhabit ${
        describeFunctionalType(type)
      }`,
    );
  }
  return constructor.fields.map((field) => instantiateSchema(field.type, parameters));
}

function matchConstructorResult(
  schema: FunctionalTypeSchema,
  type: FunctionalType,
  parameters: Map<string, FunctionalType>,
): boolean {
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return schema.kind === type.kind;
    case "parameter": {
      const existing = parameters.get(schema.name);
      if (existing !== undefined) return sameFunctionalType(existing, type);
      parameters.set(schema.name, type);
      return true;
    }
    case "tuple":
      return type.kind === "tuple" &&
        matchConstructorResult(schema.values[0], type.values[0], parameters) &&
        matchConstructorResult(schema.values[1], type.values[1], parameters);
    case "named":
      return type.kind === "named" && schema.name === type.name &&
        schema.arguments.length === type.arguments.length &&
        schema.arguments.every((argument, index) =>
          matchConstructorResult(argument, type.arguments[index]!, parameters)
        );
    case "function":
      return type.kind === "function" &&
        matchConstructorResult(schema.parameter, type.parameter, parameters) &&
        matchConstructorResult(schema.result, type.result, parameters);
    case "forall":
      return false;
  }
}

function sameFunctionalType(left: FunctionalType, right: FunctionalType): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return true;
    case "tuple":
      return right.kind === "tuple" &&
        sameFunctionalType(left.values[0], right.values[0]) &&
        sameFunctionalType(left.values[1], right.values[1]);
    case "named":
      return right.kind === "named" && left.name === right.name &&
        left.arguments.length === right.arguments.length &&
        left.arguments.every((argument, index) =>
          sameFunctionalType(argument, right.arguments[index]!)
        );
    case "function":
      return right.kind === "function" &&
        sameFunctionalType(left.parameter, right.parameter) &&
        sameFunctionalType(left.result, right.result);
  }
}

function instantiateSchema(
  schema: FunctionalTypeSchema,
  parameters: ReadonlyMap<string, FunctionalType>,
): FunctionalType {
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return { kind: schema.kind };
    case "parameter": {
      const type = parameters.get(schema.name);
      if (type === undefined) {
        throw new Error(
          `functional WASM structured value contains unresolved parameter ${
            JSON.stringify(schema.name)
          }`,
        );
      }
      return type;
    }
    case "tuple":
      return {
        kind: "tuple",
        values: [
          instantiateSchema(schema.values[0], parameters),
          instantiateSchema(schema.values[1], parameters),
        ],
      };
    case "named":
      return {
        kind: "named",
        name: schema.name,
        arguments: schema.arguments.map((argument) => instantiateSchema(argument, parameters)),
      };
    case "function":
      return {
        kind: "function",
        parameter: instantiateSchema(schema.parameter, parameters),
        result: instantiateSchema(schema.result, parameters),
      };
    case "forall":
      throw new TypeError("functional WASM structured values cannot retain forall schemas");
  }
}

function float32Bits(value: number): number {
  const bytes = new ArrayBuffer(4);
  const view = new DataView(bytes);
  view.setFloat32(0, value, true);
  return view.getUint32(0, true);
}

function float64Bits(value: number): bigint {
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}
