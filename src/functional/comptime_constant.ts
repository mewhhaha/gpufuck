import {
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  type FunctionalSpan,
  type FunctionalTypeSchema,
} from "./abi.ts";
import type { FunctionalConstant } from "./comptime_contract.ts";
import type { FunctionalDeepValue } from "./evaluator.ts";
import { matchesFunctionalQualifiedName } from "./module_contract.ts";
import type { TypeCoreType, TypeCoreValue } from "./type_core_contract.ts";
import type {
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_builder.ts";

export const FUNCTIONAL_CONSTANT_ABI_VERSION = 1;
export const FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPE_NAME = "$ComptimeDescriptor";
export const FUNCTIONAL_COMPTIME_TYPE_TREE_NAME = "$ComptimeTypeTree";
export const FUNCTIONAL_COMPTIME_BYTE_LIST_NAME = "$ComptimeByteList";
export const FUNCTIONAL_COMPTIME_DESCRIPTOR_LIST_NAME = "$ComptimeDescriptorList";

const DESCRIPTOR_INTEGER = "$ComptimeDescriptorInteger";
const DESCRIPTOR_BOOLEAN = "$ComptimeDescriptorBoolean";
const DESCRIPTOR_SYMBOL = "$ComptimeDescriptorSymbol";
const DESCRIPTOR_TYPE = "$ComptimeDescriptorType";
const TYPE_INTEGER = "$ComptimeTypeInteger";
const TYPE_BOOLEAN = "$ComptimeTypeBoolean";
const TYPE_UNIT = "$ComptimeTypeUnit";
const TYPE_NAMED = "$ComptimeTypeNamed";
const TYPE_TUPLE = "$ComptimeTypeTuple";
const TYPE_FUNCTION = "$ComptimeTypeFunction";
const BYTE_NIL = "$ComptimeByteNil";
const BYTE_CONS = "$ComptimeByteCons";
const DESCRIPTOR_NIL = "$ComptimeDescriptorNil";
const DESCRIPTOR_CONS = "$ComptimeDescriptorCons";
const MAXIMUM_FUNCTIONAL_CONSTANT_DEPTH = 512;

export const FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPES: readonly FunctionalSurfaceTypeDeclaration[] =
  Object.freeze([
    {
      name: FUNCTIONAL_COMPTIME_BYTE_LIST_NAME,
      parameters: [],
      constructors: [
        { name: BYTE_NIL, fields: [] },
        {
          name: BYTE_CONS,
          fields: [
            { name: "byte", type: { kind: "integer" } },
            {
              name: "rest",
              type: {
                kind: "named",
                name: FUNCTIONAL_COMPTIME_BYTE_LIST_NAME,
                arguments: [],
              },
            },
          ],
        },
      ],
    },
    {
      name: FUNCTIONAL_COMPTIME_DESCRIPTOR_LIST_NAME,
      parameters: [],
      constructors: [
        { name: DESCRIPTOR_NIL, fields: [] },
        {
          name: DESCRIPTOR_CONS,
          fields: [
            {
              name: "value",
              type: {
                kind: "named",
                name: FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPE_NAME,
                arguments: [],
              },
            },
            {
              name: "rest",
              type: {
                kind: "named",
                name: FUNCTIONAL_COMPTIME_DESCRIPTOR_LIST_NAME,
                arguments: [],
              },
            },
          ],
        },
      ],
    },
    {
      name: FUNCTIONAL_COMPTIME_TYPE_TREE_NAME,
      parameters: [],
      constructors: [
        { name: TYPE_INTEGER, fields: [] },
        { name: TYPE_BOOLEAN, fields: [] },
        { name: TYPE_UNIT, fields: [] },
        {
          name: TYPE_NAMED,
          fields: [
            {
              name: "name",
              type: {
                kind: "named",
                name: FUNCTIONAL_COMPTIME_BYTE_LIST_NAME,
                arguments: [],
              },
            },
            {
              name: "arguments",
              type: {
                kind: "named",
                name: FUNCTIONAL_COMPTIME_DESCRIPTOR_LIST_NAME,
                arguments: [],
              },
            },
          ],
        },
        {
          name: TYPE_TUPLE,
          fields: [
            {
              name: "first",
              type: { kind: "named", name: FUNCTIONAL_COMPTIME_TYPE_TREE_NAME, arguments: [] },
            },
            {
              name: "second",
              type: { kind: "named", name: FUNCTIONAL_COMPTIME_TYPE_TREE_NAME, arguments: [] },
            },
          ],
        },
        {
          name: TYPE_FUNCTION,
          fields: [
            {
              name: "parameter",
              type: { kind: "named", name: FUNCTIONAL_COMPTIME_TYPE_TREE_NAME, arguments: [] },
            },
            {
              name: "result",
              type: { kind: "named", name: FUNCTIONAL_COMPTIME_TYPE_TREE_NAME, arguments: [] },
            },
          ],
        },
      ],
    },
    {
      name: FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPE_NAME,
      parameters: [],
      constructors: [
        {
          name: DESCRIPTOR_INTEGER,
          fields: [{ name: "value", type: { kind: "integer" } }],
        },
        {
          name: DESCRIPTOR_BOOLEAN,
          fields: [{ name: "value", type: { kind: "boolean" } }],
        },
        {
          name: DESCRIPTOR_SYMBOL,
          fields: [{
            name: "value",
            type: { kind: "named", name: FUNCTIONAL_COMPTIME_BYTE_LIST_NAME, arguments: [] },
          }],
        },
        {
          name: DESCRIPTOR_TYPE,
          fields: [{
            name: "value",
            type: { kind: "named", name: FUNCTIONAL_COMPTIME_TYPE_TREE_NAME, arguments: [] },
          }],
        },
      ],
    },
  ]);

export const FUNCTIONAL_COMPTIME_DESCRIPTOR_SCHEMA: FunctionalTypeSchema = Object.freeze({
  kind: "named",
  name: FUNCTIONAL_COMPTIME_DESCRIPTOR_TYPE_NAME,
  arguments: Object.freeze([]),
});

export interface FunctionalConstantMeasurements {
  readonly nodes: number;
  readonly bytes: number;
  readonly depth: number;
}

export function functionalConstantFromDeepValue(
  value: FunctionalDeepValue,
): FunctionalConstant | undefined {
  switch (value.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return Object.freeze({ ...value });
    case "closure":
      return undefined;
    case "tuple": {
      const first = value.fields[0] === undefined
        ? undefined
        : functionalConstantFromDeepValue(value.fields[0]);
      const second = value.fields[1] === undefined
        ? undefined
        : functionalConstantFromDeepValue(value.fields[1]);
      if (first === undefined || second === undefined || value.fields.length !== 2) {
        return undefined;
      }
      return Object.freeze({
        kind: "tuple",
        values: Object.freeze([first, second]),
      }) as FunctionalConstant;
    }
    case "constructor": {
      const fields = value.fields.map(functionalConstantFromDeepValue);
      if (fields.some((field) => field === undefined)) return undefined;
      return Object.freeze({
        kind: "constructor",
        name: value.name,
        fields: Object.freeze(fields as FunctionalConstant[]),
      });
    }
  }
}

export function functionalConstantExpression(
  constant: FunctionalConstant,
  span?: FunctionalSpan,
): FunctionalSurfaceExpression {
  validateFunctionalConstant(constant);
  return functionalConstantExpressionUnchecked(constant, span);
}

export function validateFunctionalConstant(constant: FunctionalConstant): void {
  const ancestors = new Set<FunctionalConstant>();
  const visit = (value: FunctionalConstant, depth: number): void => {
    if (depth > MAXIMUM_FUNCTIONAL_CONSTANT_DEPTH) {
      throw new RangeError(
        `functional constant depth ${depth} exceeds ${MAXIMUM_FUNCTIONAL_CONSTANT_DEPTH}`,
      );
    }
    if (ancestors.has(value)) {
      throw new TypeError(`functional constant ${JSON.stringify(value.kind)} contains a cycle`);
    }
    ancestors.add(value);
    const scalarValue = (value as { readonly value?: unknown }).value;
    switch (value.kind) {
      case "integer":
        if (
          !Number.isInteger(scalarValue) || (scalarValue as number) < -0x80000000 ||
          (scalarValue as number) > 0x7fffffff
        ) {
          throw new RangeError(
            `functional constant integer ${String(scalarValue)} is outside [-2^31, 2^31 - 1]`,
          );
        }
        break;
      case "signed-integer-64":
        if (
          typeof scalarValue !== "bigint" || scalarValue < -0x8000000000000000n ||
          scalarValue > 0x7fffffffffffffffn
        ) {
          throw new RangeError(
            `functional constant signed i64 ${String(scalarValue)} is outside [-2^63, 2^63 - 1]`,
          );
        }
        break;
      case "float-32":
      case "float-64":
        if (typeof scalarValue !== "number") {
          throw new TypeError(
            `functional constant ${value.kind} contains ${typeof scalarValue} instead of a number`,
          );
        }
        break;
      case "whole-number-f64":
        if (
          typeof scalarValue !== "number" || !Number.isFinite(scalarValue) ||
          !Number.isInteger(scalarValue)
        ) {
          throw new TypeError(
            `functional constant whole-number-f64 must be a finite integer; received ${
              String(scalarValue)
            }`,
          );
        }
        break;
      case "boolean":
        if (typeof scalarValue !== "boolean") {
          throw new TypeError(
            `functional constant boolean contains ${typeof scalarValue} instead of a boolean`,
          );
        }
        break;
      case "unit":
        break;
      case "tuple":
        if (!Array.isArray(value.values) || value.values.length !== 2) {
          throw new TypeError("functional constant tuple must contain exactly two values");
        }
        visit(value.values[0], depth + 1);
        visit(value.values[1], depth + 1);
        break;
      case "constructor":
        if (value.name.length === 0) {
          throw new TypeError("functional constant constructor name must be nonempty");
        }
        if (!Array.isArray(value.fields)) {
          throw new TypeError(
            `functional constant constructor ${JSON.stringify(value.name)} fields must be an array`,
          );
        }
        for (const field of value.fields) visit(field, depth + 1);
        break;
    }
    ancestors.delete(value);
  };
  visit(constant, 1);
}

function functionalConstantExpressionUnchecked(
  constant: FunctionalConstant,
  span?: FunctionalSpan,
): FunctionalSurfaceExpression {
  switch (constant.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "whole-number-f64":
    case "boolean":
      return { ...constant, ...(span === undefined ? {} : { span }) };
    case "unit":
      return {
        kind: "name",
        name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
        ...(span === undefined ? {} : { span }),
      };
    case "tuple":
      return applyConstantConstructor(
        FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
        constant.values,
        span,
      );
    case "constructor":
      return applyConstantConstructor(constant.name, constant.fields, span);
  }
}

export function measureFunctionalConstant(
  constant: FunctionalConstant,
): FunctionalConstantMeasurements {
  validateFunctionalConstant(constant);
  let nodes = 0;
  let depth = 0;
  const visit = (value: FunctionalConstant, currentDepth: number): void => {
    nodes++;
    depth = Math.max(depth, currentDepth);
    if (value.kind === "tuple") {
      visit(value.values[0], currentDepth + 1);
      visit(value.values[1], currentDepth + 1);
    } else if (value.kind === "constructor") {
      for (const field of value.fields) visit(field, currentDepth + 1);
    }
  };
  visit(constant, 1);
  return { nodes, bytes: encodedFunctionalConstantBytes(constant).byteLength, depth };
}

export function encodeFunctionalConstant(constant: FunctionalConstant): Uint8Array {
  validateFunctionalConstant(constant);
  return encodedFunctionalConstantBytes(constant);
}

function encodedFunctionalConstantBytes(constant: FunctionalConstant): Uint8Array {
  const envelope = {
    abiVersion: FUNCTIONAL_CONSTANT_ABI_VERSION,
    value: encodedConstant(constant),
  };
  return new TextEncoder().encode(JSON.stringify(envelope));
}

export function decodeFunctionalConstant(bytes: Uint8Array): FunctionalConstant {
  let envelope: unknown;
  try {
    envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error("functional constant is not valid UTF-8 JSON", { cause });
  }
  if (!isRecord(envelope) || envelope.abiVersion !== FUNCTIONAL_CONSTANT_ABI_VERSION) {
    throw new Error(
      `functional constant has ABI ${
        isRecord(envelope) ? String(envelope.abiVersion) : "non-object"
      }; expected ${FUNCTIONAL_CONSTANT_ABI_VERSION}`,
    );
  }
  return decodedConstant(envelope.value, 0);
}

export function functionalConstantFromTypeCoreValue(value: TypeCoreValue): FunctionalConstant {
  switch (value.kind) {
    case "integer":
      return constructor(DESCRIPTOR_INTEGER, [{ kind: "integer", value: value.value }]);
    case "boolean":
      return constructor(DESCRIPTOR_BOOLEAN, [{ kind: "boolean", value: value.value }]);
    case "symbol":
      return constructor(DESCRIPTOR_SYMBOL, [functionalConstantFromComptimeString(value.value)]);
    case "type":
      return constructor(DESCRIPTOR_TYPE, [typeTree(value.type)]);
  }
}

export function functionalConstantFromComptimeString(value: string): FunctionalConstant {
  return byteList(new TextEncoder().encode(value));
}

export function functionalConstantFromComptimeBytes(value: Uint8Array): FunctionalConstant {
  return byteList(value);
}

export function functionalComptimeStringFromConstant(constant: FunctionalConstant): string {
  const bytes = functionalComptimeBytesFromConstant(constant);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new TypeError("functional comptime string contains invalid UTF-8", { cause });
  }
}

export function functionalComptimeBytesFromConstant(constant: FunctionalConstant): Uint8Array {
  validateFunctionalConstant(constant);
  const bytes: number[] = [];
  let current = constant;
  while (
    current.kind === "constructor" && matchesFunctionalQualifiedName(current.name, BYTE_CONS)
  ) {
    if (current.fields.length !== 2) {
      throw new TypeError(
        `functional comptime string constructor ${
          JSON.stringify(BYTE_CONS)
        } has ${current.fields.length} fields; expected 2`,
      );
    }
    const byte = current.fields[0];
    if (byte?.kind !== "integer" || byte.value < 0 || byte.value > 255) {
      throw new TypeError(
        `functional comptime string contains byte ${
          byte?.kind === "integer" ? byte.value : byte?.kind ?? "missing"
        }; expected an integer from 0 through 255`,
      );
    }
    bytes.push(byte.value);
    current = current.fields[1]!;
  }
  if (
    current.kind !== "constructor" || !matchesFunctionalQualifiedName(current.name, BYTE_NIL) ||
    current.fields.length !== 0
  ) {
    throw new TypeError(
      `functional comptime string ends with ${
        current.kind === "constructor" ? JSON.stringify(current.name) : current.kind
      }; expected ${JSON.stringify(BYTE_NIL)}`,
    );
  }
  return Uint8Array.from(bytes);
}

function typeTree(type: TypeCoreType): FunctionalConstant {
  switch (type.kind) {
    case "integer":
      return constructor(TYPE_INTEGER);
    case "boolean":
      return constructor(TYPE_BOOLEAN);
    case "unit":
      return constructor(TYPE_UNIT);
    case "named":
      return constructor(TYPE_NAMED, [
        functionalConstantFromComptimeString(type.name),
        descriptorList(type.arguments.map(functionalConstantFromTypeCoreValue)),
      ]);
    case "tuple":
      return constructor(TYPE_TUPLE, [typeTree(type.values[0]), typeTree(type.values[1])]);
    case "function":
      return constructor(TYPE_FUNCTION, [typeTree(type.parameter), typeTree(type.result)]);
  }
}

function byteList(bytes: Uint8Array): FunctionalConstant {
  let result = constructor(BYTE_NIL);
  for (let index = bytes.length - 1; index >= 0; index--) {
    result = constructor(BYTE_CONS, [{ kind: "integer", value: bytes[index]! }, result]);
  }
  return result;
}

function descriptorList(values: readonly FunctionalConstant[]): FunctionalConstant {
  let result = constructor(DESCRIPTOR_NIL);
  for (let index = values.length - 1; index >= 0; index--) {
    result = constructor(DESCRIPTOR_CONS, [values[index]!, result]);
  }
  return result;
}

function constructor(
  name: string,
  fields: readonly FunctionalConstant[] = [],
): FunctionalConstant {
  return Object.freeze({ kind: "constructor", name, fields: Object.freeze([...fields]) });
}

function applyConstantConstructor(
  name: string,
  fields: readonly FunctionalConstant[],
  span: FunctionalSpan | undefined,
): FunctionalSurfaceExpression {
  let expression: FunctionalSurfaceExpression = {
    kind: "name",
    name,
    ...(span === undefined ? {} : { span }),
  };
  for (const field of fields) {
    expression = {
      kind: "apply",
      callee: expression,
      argument: functionalConstantExpressionUnchecked(field, span),
      ...(span === undefined ? {} : { span }),
    };
  }
  return expression;
}

function encodedConstant(constant: FunctionalConstant): unknown {
  switch (constant.kind) {
    case "integer":
    case "boolean":
      return { kind: constant.kind, value: constant.value };
    case "signed-integer-64":
      return { kind: constant.kind, value: constant.value.toString() };
    case "float-32":
    case "float-64":
    case "whole-number-f64":
      return { kind: constant.kind, value: encodedFloat(constant.value) };
    case "unit":
      return { kind: "unit" };
    case "tuple":
      return { kind: "tuple", values: constant.values.map(encodedConstant) };
    case "constructor":
      return {
        kind: "constructor",
        name: constant.name,
        fields: constant.fields.map(encodedConstant),
      };
  }
}

function decodedConstant(candidate: unknown, depth: number): FunctionalConstant {
  if (
    depth > MAXIMUM_FUNCTIONAL_CONSTANT_DEPTH || !isRecord(candidate) ||
    typeof candidate.kind !== "string"
  ) {
    throw new Error("functional constant contains a malformed or excessively deep value");
  }
  switch (candidate.kind) {
    case "integer":
      if (
        !Number.isInteger(candidate.value) || (candidate.value as number) < -0x80000000 ||
        (candidate.value as number) > 0x7fffffff
      ) {
        throw new Error(`functional constant contains invalid integer ${String(candidate.value)}`);
      }
      return Object.freeze({ kind: "integer", value: candidate.value as number });
    case "signed-integer-64": {
      if (typeof candidate.value !== "string" || !/^-?[0-9]+$/.test(candidate.value)) {
        throw new Error(
          `functional constant contains invalid signed i64 ${String(candidate.value)}`,
        );
      }
      const value = BigInt(candidate.value);
      if (value < -0x8000000000000000n || value > 0x7fffffffffffffffn) {
        throw new Error(`functional constant signed i64 ${value} is outside [-2^63, 2^63 - 1]`);
      }
      return Object.freeze({ kind: "signed-integer-64", value });
    }
    case "float-32":
    case "float-64":
      return Object.freeze({ kind: candidate.kind, value: decodedFloat(candidate.value) });
    case "whole-number-f64": {
      const value = decodedFloat(candidate.value);
      if (!Number.isFinite(value) || !Number.isInteger(value)) {
        throw new Error(
          `functional constant contains invalid whole-number-f64 ${String(value)}`,
        );
      }
      return Object.freeze({ kind: "whole-number-f64", value });
    }
    case "boolean":
      if (typeof candidate.value !== "boolean") {
        throw new Error(`functional constant contains invalid boolean ${String(candidate.value)}`);
      }
      return Object.freeze({ kind: "boolean", value: candidate.value });
    case "unit":
      return Object.freeze({ kind: "unit" });
    case "tuple":
      if (!Array.isArray(candidate.values) || candidate.values.length !== 2) {
        throw new Error("functional constant tuple must contain exactly two values");
      }
      return Object.freeze({
        kind: "tuple",
        values: Object.freeze([
          decodedConstant(candidate.values[0], depth + 1),
          decodedConstant(candidate.values[1], depth + 1),
        ]),
      }) as FunctionalConstant;
    case "constructor":
      if (
        typeof candidate.name !== "string" || candidate.name.length === 0 ||
        !Array.isArray(candidate.fields)
      ) {
        throw new Error("functional constant contains a malformed constructor");
      }
      return Object.freeze({
        kind: "constructor",
        name: candidate.name,
        fields: Object.freeze(candidate.fields.map((field) => decodedConstant(field, depth + 1))),
      });
    default:
      throw new Error(
        `functional constant contains unknown kind ${JSON.stringify(candidate.kind)}`,
      );
  }
}

function encodedFloat(value: number): number | string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "+infinity";
  if (value === -Infinity) return "-infinity";
  if (Object.is(value, -0)) return "-0";
  return value;
}

function decodedFloat(value: unknown): number {
  if (typeof value === "number") return value;
  if (value === "nan") return NaN;
  if (value === "+infinity") return Infinity;
  if (value === "-infinity") return -Infinity;
  if (value === "-0") return -0;
  throw new Error(`functional constant contains invalid float ${String(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
