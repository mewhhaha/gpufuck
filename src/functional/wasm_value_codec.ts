import {
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  type FunctionalType,
  type FunctionalTypeSchema,
} from "./abi.ts";
import type { GpuFunctionalModule } from "./compiler_module.ts";
import type { FunctionalWasmHostValue } from "./host_contract.ts";
import { FunctionalWasmValueAbi } from "./wasm_abi.ts";

const CONSTRUCTOR_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.constructor;
const NUMERIC_OBJECT_KIND = FunctionalWasmValueAbi.objectKinds.numeric;
const OBJECT_HEADER_BYTE_LENGTH = FunctionalWasmValueAbi.objectHeaderByteLength;
const VALUE_BYTE_LENGTH = FunctionalWasmValueAbi.valueByteLength;

export type FunctionalWasmValue = FunctionalWasmHostValue;

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
  const heapTop = instance.exports.heapTop;
  if (!(memory instanceof WebAssembly.Memory) || !(heapTop instanceof WebAssembly.Global)) {
    throw new Error("functional WASM input module omitted memory or heapTop exports");
  }
  const allocateObject = (
    objectKind: number,
    payload: number,
    fields: readonly bigint[],
  ): bigint => {
    const byteLength = OBJECT_HEADER_BYTE_LENGTH + fields.length * VALUE_BYTE_LENGTH;
    const pointer = (Number(heapTop.value) + 7) & ~7;
    const end = pointer + byteLength;
    if (!Number.isSafeInteger(end) || end > 0xffffffff) {
      throw new RangeError(
        `functional WASM input allocation from ${pointer} by ${byteLength} bytes exceeds 32-bit memory`,
      );
    }
    if (end > memory.buffer.byteLength) {
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65_536));
    }
    const view = new DataView(memory.buffer);
    view.setUint32(pointer, objectKind, true);
    view.setUint32(pointer + 4, payload, true);
    view.setUint32(pointer + 8, fields.length, true);
    view.setUint32(pointer + 12, 0, true);
    for (const [index, field] of fields.entries()) {
      view.setBigInt64(
        pointer + OBJECT_HEADER_BYTE_LENGTH + index * VALUE_BYTE_LENGTH,
        BigInt.asIntN(64, field),
        true,
      );
    }
    heapTop.value = end;
    return BigInt(pointer);
  };
  const allocateConstructor = (constructorIndex: number, fields: readonly bigint[]): bigint =>
    allocateObject(CONSTRUCTOR_OBJECT_KIND, constructorIndex, fields);
  const encode = (expected: FunctionalType, input: FunctionalWasmValue): bigint => {
    if (expected.kind === "integer") {
      if (input.kind !== "integer") throw wasmArgumentTypeMismatch(expected, input);
      if (
        !Number.isInteger(input.value) || input.value < -2_147_483_648 ||
        input.value > 2_147_483_647
      ) {
        throw new RangeError(`functional WASM i32 argument is out of range: ${input.value}`);
      }
      return (BigInt(input.value | 0) << 3n) | 1n;
    }
    if (expected.kind === "boolean") {
      if (input.kind !== "boolean") throw wasmArgumentTypeMismatch(expected, input);
      return (BigInt(input.value ? 1 : 0) << 3n) | 2n;
    }
    if (expected.kind === "unit") {
      if (input.kind !== "unit") throw wasmArgumentTypeMismatch(expected, input);
      const constructorIndex = module.constructorNames.indexOf(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME);
      if (constructorIndex < 0) throw new Error("functional WASM input omitted unit constructor");
      return allocateConstructor(constructorIndex, []);
    }
    if (expected.kind === "signed-integer-64") {
      if (input.kind !== "signed-integer-64") throw wasmArgumentTypeMismatch(expected, input);
      return allocateObject(
        NUMERIC_OBJECT_KIND,
        FunctionalWasmValueAbi.numericKinds.signedInteger64,
        [input.value],
      );
    }
    if (expected.kind === "float-32") {
      if (input.kind !== "float-32") throw wasmArgumentTypeMismatch(expected, input);
      return allocateObject(
        NUMERIC_OBJECT_KIND,
        FunctionalWasmValueAbi.numericKinds.float32,
        [BigInt(float32Bits(input.value))],
      );
    }
    if (expected.kind === "float-64") {
      if (input.kind !== "float-64") throw wasmArgumentTypeMismatch(expected, input);
      return allocateObject(
        NUMERIC_OBJECT_KIND,
        FunctionalWasmValueAbi.numericKinds.float64,
        [BigInt.asIntN(64, float64Bits(input.value))],
      );
    }
    if (expected.kind === "function") {
      throw new TypeError("functional WASM ABI does not accept host function arguments");
    }
    if (expected.kind === "tuple") {
      if (input.kind !== "tuple") throw wasmArgumentTypeMismatch(expected, input);
      const constructorIndex = module.constructorNames.indexOf(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME);
      if (constructorIndex < 0) throw new Error("functional WASM input omitted tuple constructor");
      return allocateConstructor(constructorIndex, [
        encode(expected.values[0], input.values[0]),
        encode(expected.values[1], input.values[1]),
      ]);
    }
    if (input.kind !== "constructor") throw wasmArgumentTypeMismatch(expected, input);
    const constructorIndex = module.constructorNames.indexOf(input.name);
    if (constructorIndex < 0) {
      throw new TypeError(
        `functional WASM argument names unknown constructor ${JSON.stringify(input.name)}`,
      );
    }
    const fieldTypes = structuredFieldTypes(module, expected, input.name);
    if (fieldTypes.length !== input.fields.length) {
      throw new TypeError(
        `functional WASM argument constructor ${
          JSON.stringify(input.name)
        } expects ${fieldTypes.length} fields; received ${input.fields.length}`,
      );
    }
    return allocateConstructor(
      constructorIndex,
      fieldTypes.map((fieldType, index) => encode(fieldType, input.fields[index]!)),
    );
  };
  return encode(type, value);
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
  let decodedNodes = 0;
  const activePointers = new Set<number>();
  const decode = (rawValue: bigint, expected: FunctionalType): FunctionalWasmValue => {
    decodedNodes += 1;
    if (decodedNodes > maximumResultNodes) {
      throw new RangeError(
        `functional WASM result exceeded maximumResultNodes ${maximumResultNodes} while decoding ${
          describeFunctionalType(type)
        }`,
      );
    }
    const forced = forceValue(rawValue) as bigint;
    if (expected.kind === "integer") {
      return { kind: "integer", value: Number(BigInt.asIntN(32, forced >> 3n)) };
    }
    if (expected.kind === "boolean") return { kind: "boolean", value: forced >> 3n !== 0n };
    if (expected.kind === "unit") return { kind: "unit" };
    if (
      expected.kind === "signed-integer-64" || expected.kind === "float-32" ||
      expected.kind === "float-64"
    ) {
      return decodeBoxedNumeric(memory, forced, expected);
    }
    if (expected.kind === "function") {
      throw new TypeError("functional WASM structured results cannot contain function fields");
    }
    const pointer = Number(BigInt.asUintN(32, forced));
    if (activePointers.has(pointer)) {
      throw new Error(
        `functional WASM structured result contains a cycle through pointer ${pointer}`,
      );
    }
    activePointers.add(pointer);
    try {
      const view = new DataView(memory.buffer);
      if (pointer > view.byteLength - OBJECT_HEADER_BYTE_LENGTH) {
        throw new RangeError(
          `functional WASM constructor pointer ${pointer} exceeds memory length ${view.byteLength}`,
        );
      }
      const objectKind = view.getUint32(pointer, true);
      if (objectKind !== CONSTRUCTOR_OBJECT_KIND) {
        throw new Error(
          `functional WASM result pointer ${pointer} has object kind ${objectKind}; expected constructor kind ${CONSTRUCTOR_OBJECT_KIND}`,
        );
      }
      const constructorIndex = view.getUint32(pointer + 4, true);
      const fieldCount = view.getUint32(pointer + 8, true);
      const constructorName = module.constructorNames[constructorIndex];
      if (constructorName === undefined) {
        throw new Error(
          `functional WASM result references constructor ${constructorIndex} beyond ${module.constructorCount}`,
        );
      }
      const fieldTypes = structuredFieldTypes(module, expected, constructorName);
      if (fieldTypes.length !== fieldCount) {
        throw new Error(
          `functional WASM constructor ${
            JSON.stringify(constructorName)
          } stores ${fieldCount} fields; its type declares ${fieldTypes.length}`,
        );
      }
      const fields = fieldTypes.map((fieldType, fieldIndex) => {
        const fieldOffset = pointer + OBJECT_HEADER_BYTE_LENGTH + fieldIndex * VALUE_BYTE_LENGTH;
        if (fieldOffset > view.byteLength - VALUE_BYTE_LENGTH) {
          throw new RangeError(
            `functional WASM constructor ${
              JSON.stringify(constructorName)
            } field ${fieldIndex} exceeds memory length ${view.byteLength}`,
          );
        }
        return decode(view.getBigInt64(fieldOffset, true), fieldType);
      });
      if (expected.kind === "tuple") {
        const first = fields[0];
        const second = fields[1];
        if (first === undefined || second === undefined) {
          throw new Error("functional WASM tuple result omitted a field");
        }
        return { kind: "tuple", values: [first, second] };
      }
      return { kind: "constructor", name: constructorName, fields };
    } finally {
      activePointers.delete(pointer);
    }
  };
  return decode(BigInt(rawResult), type);
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

function structuredFieldTypes(
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
