import {
  LAZULI_CONSTRUCTOR_BYTE_LENGTH,
  LAZULI_DEFINITION_BYTE_LENGTH,
  LAZULI_MAXIMUM_CONSTRUCTOR_ARITY,
  LAZULI_NO_INDEX,
  LAZULI_NODE_BYTE_LENGTH,
} from "./abi.ts";
import type { LazuliType, LazuliTypeDeclaration, LazuliTypeSchema } from "./abi.ts";
import type { GpuLazuliModule } from "./compiler_module.ts";
import { LAZULI_EVALUATOR_SHADER } from "./evaluator_shader.ts";

const HEAP_SLOT_BYTE_LENGTH = 32;
const STACK_FRAME_BYTE_LENGTH = 32;
const INPUT_NODE_BYTE_LENGTH = 16;
const RESULT_NODE_BYTE_LENGTH = 16;
const EVALUATION_STATE_WORD_LENGTH = 51;
const EVALUATION_STATE_BYTE_LENGTH = EVALUATION_STATE_WORD_LENGTH * Uint32Array.BYTES_PER_ELEMENT;

const HARD_MAXIMUM_STEPS = 1_000_000;
const DEFAULT_MAXIMUM_STEPS_PER_DISPATCH = 4_096;
const HARD_MAXIMUM_STEPS_PER_DISPATCH = 65_536;
const HARD_MAXIMUM_HEAP_SLOTS = 1_000_000;
const HARD_MAXIMUM_STACK_FRAMES = 262_144;
const HARD_MAXIMUM_RESULT_NODES = 1_000_000;

const STATUS_PENDING = 1;
const STATUS_COMPLETE = 2;
const STATUS_FAULT = 3;

const FAULT_BAD_MODULE = 1;
const FAULT_OUT_OF_FUEL = 2;
const FAULT_OUT_OF_HEAP = 3;
const FAULT_STACK_OVERFLOW = 4;
const FAULT_BLACKHOLE = 5;
const FAULT_TYPE_ERROR = 6;
const FAULT_DIVIDE_BY_ZERO = 7;
const FAULT_NON_EXHAUSTIVE_CASE = 8;
const FAULT_RESULT_TOO_LARGE = 9;
const FAULT_CYCLIC_RESULT = 10;

const VALUE_INTEGER = 1;
const VALUE_BOOLEAN = 2;
const VALUE_CLOSURE = 3;
const VALUE_CONSTRUCTOR_PARTIAL = 4;
const VALUE_CONSTRUCTOR = 5;

const EXPECT_INTEGER = 1;
const EXPECT_BOOLEAN = 2;
const EXPECT_CALLABLE = 3;
const EXPECT_CONSTRUCTOR = 4;

const EvaluationStateWord = {
  NodeCount: 0,
  DefinitionCount: 1,
  EntryDefinition: 2,
  MaximumSteps: 3,
  HeapCapacity: 4,
  StackCapacity: 5,
  Status: 6,
  FaultCode: 7,
  FaultSourceOffset: 8,
  FaultDetail: 9,
  Mode: 10,
  Expression: 11,
  Environment: 12,
  ValueTag: 13,
  ValuePayload: 14,
  CurrentSourceOffset: 15,
  Steps: 16,
  Allocations: 17,
  PeakStack: 18,
  ThunkEvaluations: 19,
  HeapTop: 20,
  StackTop: 21,
  LocalEnvironment: 22,
  LocalDepth: 23,
  LocalLookupActive: 24,
  ConstructorCount: 25,
  TypeCount: 26,
  CaseArm: 27,
  CasePattern: 28,
  CaseField: 29,
  CaseEnvironment: 30,
  CaseRemaining: 31,
  CaseConstructor: 32,
  CaseSourceOffset: 33,
  MaximumStepsPerDispatch: 34,
  InitializationDefinition: 35,
  NodeBase: 36,
  DefinitionBase: 37,
  ConstructorBase: 38,
  HeapBase: 39,
  StackBase: 40,
  GlobalBase: 41,
  InputBase: 42,
  InputCount: 43,
  PendingInput: 44,
  ResultForm: 45,
  ResultBase: 46,
  ResultCapacity: 47,
  ResultTop: 48,
  ReifyField: 49,
  ReifyRemaining: 50,
} as const;

export interface LazuliEvaluationOptions {
  readonly maximumSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly heapSlots?: number;
  readonly stackFrames?: number;
  readonly signal?: AbortSignal;
  readonly input?: LazuliInputValue;
  readonly resultForm?: "weak-head" | "deep";
  readonly maximumResultNodes?: number;
}

export interface LazuliDeepEvaluationOptions extends LazuliEvaluationOptions {
  readonly resultForm: "deep";
}

export interface LazuliBatchEvaluationOptions extends Omit<LazuliEvaluationOptions, "input"> {
  readonly inputs?: readonly (LazuliInputValue | undefined)[];
}

export interface LazuliDeepBatchEvaluationOptions extends LazuliBatchEvaluationOptions {
  readonly resultForm: "deep";
}

export type LazuliInputValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "unit" }
  | { readonly kind: "tuple"; readonly values: readonly [LazuliInputValue, LazuliInputValue] }
  | { readonly kind: "list"; readonly values: readonly LazuliInputValue[] }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fields: readonly LazuliInputValue[];
  };

export type LazuliValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "unit" }
  | { readonly kind: "tuple"; readonly fieldCount: 2 }
  | { readonly kind: "closure" }
  | { readonly kind: "constructor"; readonly name: string; readonly fieldCount: number };

export type LazuliDeepValue =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "closure" }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "unit" }
  | { readonly kind: "tuple"; readonly fieldCount: 2; readonly fields: readonly LazuliDeepValue[] }
  | { readonly kind: "list"; readonly values: readonly LazuliDeepValue[] }
  | {
    readonly kind: "constructor";
    readonly name: string;
    readonly fieldCount: number;
    readonly fields: readonly LazuliDeepValue[];
  };

export interface LazuliEvaluationStats {
  readonly steps: number;
  readonly allocations: number;
  readonly peakStack: number;
  readonly thunkEvaluations: number;
}

export type LazuliRuntimeFault =
  | {
    readonly kind: "bad-module";
    readonly code: "L3001";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "out-of-fuel";
    readonly code: "L3002";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "out-of-heap";
    readonly code: "L3003";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "stack-overflow";
    readonly code: "L3004";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "blackhole";
    readonly code: "L3005";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "type-error";
    readonly code: "L3006";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "divide-by-zero";
    readonly code: "L3007";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "non-exhaustive-case";
    readonly code: "L3008";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "bad-input";
    readonly code: "L3009";
    readonly message: string;
    readonly sourceByteOffset: null;
    readonly fieldPath: readonly number[];
  }
  | {
    readonly kind: "result-too-large";
    readonly code: "L3010";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  }
  | {
    readonly kind: "cyclic-result";
    readonly code: "L3011";
    readonly message: string;
    readonly sourceByteOffset: number | null;
  };

export type LazuliEvaluationResult =
  | {
    readonly ok: true;
    readonly value: LazuliValue;
    readonly stats: LazuliEvaluationStats;
  }
  | {
    readonly ok: false;
    readonly fault: LazuliRuntimeFault;
    readonly stats: LazuliEvaluationStats;
  };

export type LazuliDeepEvaluationResult =
  | {
    readonly ok: true;
    readonly value: LazuliDeepValue;
    readonly stats: LazuliEvaluationStats;
  }
  | {
    readonly ok: false;
    readonly fault: LazuliRuntimeFault;
    readonly stats: LazuliEvaluationStats;
  };

type AnyLazuliEvaluationResult = LazuliEvaluationResult | LazuliDeepEvaluationResult;

interface EvaluationLimits {
  readonly maximumSteps: number;
  readonly maximumStepsPerDispatch: number;
  readonly heapSlots: number;
  readonly stackFrames: number;
  readonly resultNodes: number;
  readonly deepResult: boolean;
}

interface EvaluationSnapshot {
  readonly status: number;
  readonly faultCode: number;
  readonly faultSourceOffset: number;
  readonly faultDetail: number;
  readonly valueTag: number;
  readonly valuePayload: number;
  readonly heapTop: number;
  readonly stackTop: number;
  readonly initializationDefinition: number;
  readonly resultTop: number;
  readonly stats: LazuliEvaluationStats;
}

interface ValidatedModuleBuffers {
  readonly valid: true;
  readonly nodeByteLength: number;
  readonly definitionByteLength: number;
  readonly constructorByteLength: number;
  readonly constructorBindingByteLength: number;
}

interface InvalidModule {
  readonly valid: false;
  readonly result: LazuliEvaluationResult;
}

type ModuleValidation = ValidatedModuleBuffers | InvalidModule;

interface EvaluationBufferBases {
  readonly node: number;
  readonly definition: number;
  readonly constructor: number;
  readonly heap: number;
  readonly stack: number;
  readonly global: number;
  readonly input: number;
  readonly result: number;
}

interface BatchEvaluationLane extends EvaluationBufferBases {
  readonly resultIndex: number;
  readonly module: GpuLazuliModule;
  readonly buffers: ValidatedModuleBuffers;
  readonly limits: EvaluationLimits;
  readonly encodedInput: EncodedInput | undefined;
  readonly inputValue: LazuliInputValue | undefined;
  readonly outputType: LazuliType;
}

type NumericEvaluationOption =
  | "maximumSteps"
  | "maximumStepsPerDispatch"
  | "heapSlots"
  | "stackFrames"
  | "maximumResultNodes";

interface EncodedInput {
  readonly words: Uint32Array<ArrayBuffer>;
  readonly nodeCount: number;
}

interface InputEncodingEntry {
  readonly value: unknown;
  readonly expectedType: LazuliType;
  readonly path: readonly number[];
  readonly ancestor: InputAncestor | undefined;
}

interface InputAncestor {
  readonly value: object;
  readonly parent: InputAncestor | undefined;
}

function badModuleFault(message: string): LazuliEvaluationResult {
  return {
    ok: false,
    fault: {
      kind: "bad-module",
      code: "L3001",
      message,
      sourceByteOffset: null,
    },
    stats: {
      steps: 0,
      allocations: 0,
      peakStack: 0,
      thunkEvaluations: 0,
    },
  };
}

function badInputFault(message: string, fieldPath: readonly number[]): LazuliEvaluationResult {
  return {
    ok: false,
    fault: {
      kind: "bad-input",
      code: "L3009",
      message,
      sourceByteOffset: null,
      fieldPath,
    },
    stats: {
      steps: 0,
      allocations: 0,
      peakStack: 0,
      thunkEvaluations: 0,
    },
  };
}

function inputPath(path: readonly number[]): string {
  return path.length === 0 ? "$" : `$${path.map((index) => `.fields[${index}]`).join("")}`;
}

function hasInputAncestor(ancestor: InputAncestor | undefined, value: object): boolean {
  let current = ancestor;
  while (current !== undefined) {
    if (current.value === value) return true;
    current = current.parent;
  }
  return false;
}

function describeLazuliType(type: LazuliType): string {
  switch (type.kind) {
    case "integer":
      return "Integer";
    case "signed-integer-64":
      return "SignedInteger64";
    case "float-32":
      return "Float32";
    case "float-64":
      return "Float64";
    case "boolean":
      return "Boolean";
    case "unit":
      return "Unit";
    case "tuple":
      return `(${describeLazuliType(type.values[0])}, ${describeLazuliType(type.values[1])})`;
    case "named":
      return type.arguments.length === 0
        ? type.name
        : `${type.name} ${type.arguments.map(describeLazuliType).join(" ")}`;
    case "function":
      return `${describeLazuliType(type.parameter)} -> ${describeLazuliType(type.result)}`;
  }
}

function inputKind(value: unknown): string {
  if (typeof value !== "object" || value === null) return typeof value;
  const kind = (value as { readonly kind?: unknown }).kind;
  return typeof kind === "string" ? kind : "untagged object";
}

function typeMismatch(
  path: readonly number[],
  expected: LazuliType,
  value: unknown,
): LazuliEvaluationResult {
  return badInputFault(
    `${inputPath(path)} must be ${describeLazuliType(expected)}; received ${inputKind(value)}`,
    path,
  );
}

function namedTypeDeclaration(
  module: GpuLazuliModule,
  name: string,
): LazuliTypeDeclaration | undefined {
  return module.typeDeclarations.find((declaration) => declaration.name === name);
}

function instantiateTypeSchema(
  schema: LazuliTypeSchema,
  parameters: ReadonlyMap<string, LazuliType>,
): LazuliType | undefined {
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return schema;
    case "parameter":
      return parameters.get(schema.name);
    case "tuple": {
      const left = instantiateTypeSchema(schema.values[0], parameters);
      const right = instantiateTypeSchema(schema.values[1], parameters);
      return left === undefined || right === undefined
        ? undefined
        : { kind: "tuple", values: [left, right] };
    }
    case "named": {
      const arguments_ = schema.arguments.map((argument) =>
        instantiateTypeSchema(argument, parameters)
      );
      return arguments_.some((argument) => argument === undefined)
        ? undefined
        : { kind: "named", name: schema.name, arguments: arguments_ as LazuliType[] };
    }
    case "function": {
      const parameter = instantiateTypeSchema(schema.parameter, parameters);
      const result = instantiateTypeSchema(schema.result, parameters);
      return parameter === undefined || result === undefined
        ? undefined
        : { kind: "function", parameter, result };
    }
  }
}

function sameLazuliType(left: LazuliType, right: LazuliType): boolean {
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
        sameLazuliType(left.values[0], right.values[0]) &&
        sameLazuliType(left.values[1], right.values[1]);
    case "named":
      if (
        right.kind !== "named" || left.name !== right.name ||
        left.arguments.length !== right.arguments.length
      ) return false;
      return left.arguments.every((argument, index) => {
        const rightArgument = right.arguments[index];
        return rightArgument !== undefined && sameLazuliType(argument, rightArgument);
      });
    case "function":
      return right.kind === "function" &&
        sameLazuliType(left.parameter, right.parameter) &&
        sameLazuliType(left.result, right.result);
  }
}

function matchConstructorResultSchema(
  schema: LazuliTypeSchema,
  type: LazuliType,
  parameters: Map<string, LazuliType>,
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
      if (existing !== undefined) return sameLazuliType(existing, type);
      parameters.set(schema.name, type);
      return true;
    }
    case "tuple":
      return type.kind === "tuple" &&
        matchConstructorResultSchema(schema.values[0], type.values[0], parameters) &&
        matchConstructorResultSchema(schema.values[1], type.values[1], parameters);
    case "named":
      if (
        type.kind !== "named" || schema.name !== type.name ||
        schema.arguments.length !== type.arguments.length
      ) return false;
      return schema.arguments.every((argument, index) => {
        const typeArgument = type.arguments[index];
        return typeArgument !== undefined &&
          matchConstructorResultSchema(argument, typeArgument, parameters);
      });
    case "function":
      return type.kind === "function" &&
        matchConstructorResultSchema(schema.parameter, type.parameter, parameters) &&
        matchConstructorResultSchema(schema.result, type.result, parameters);
    case "forall":
      return false;
  }
}

function expectedConstructorFieldTypes(
  module: GpuLazuliModule,
  expectedType: LazuliType,
  constructorName: string,
): readonly LazuliType[] | undefined {
  if (expectedType.kind === "unit") {
    return constructorName === "$Unit" ? [] : undefined;
  }
  if (expectedType.kind === "tuple") {
    return constructorName === "$Tuple" ? expectedType.values : undefined;
  }
  if (expectedType.kind !== "named") return undefined;

  const declaration = namedTypeDeclaration(module, expectedType.name);
  if (
    declaration === undefined || declaration.parameters.length !== expectedType.arguments.length
  ) {
    return undefined;
  }
  const constructor = declaration.constructors.find((candidate) =>
    candidate.name === constructorName
  );
  if (constructor === undefined) return undefined;

  const parameters = new Map<string, LazuliType>();
  if (constructor.result === undefined) {
    for (const [index, parameter] of declaration.parameters.entries()) {
      const argument = expectedType.arguments[index];
      if (argument === undefined) return undefined;
      parameters.set(parameter, argument);
    }
  } else if (!matchConstructorResultSchema(constructor.result, expectedType, parameters)) {
    return undefined;
  }
  const fieldTypes = constructor.fields.map((field) =>
    instantiateTypeSchema(field.type, parameters)
  );
  return fieldTypes.some((field) => field === undefined) ? undefined : fieldTypes as LazuliType[];
}

function constructorOwnerType(
  module: GpuLazuliModule,
  constructorName: string,
): string | undefined {
  return module.typeDeclarations.find((declaration) =>
    declaration.constructors.some((constructor) => constructor.name === constructorName)
  )?.name;
}

function validateInputValue(
  module: GpuLazuliModule,
  input: LazuliInputValue,
  expectedType: LazuliType,
  enableCollectionSyntax: boolean,
): LazuliEvaluationResult | undefined {
  const entries: InputEncodingEntry[] = [{
    value: input,
    expectedType,
    path: [],
    ancestor: undefined,
  }];

  for (let inputIndex = 0; inputIndex < entries.length; inputIndex++) {
    const entry = entries[inputIndex];
    if (entry === undefined) throw new Error(`Lazuli input validator omitted node ${inputIndex}`);
    const { value, expectedType, path } = entry;
    if (typeof value !== "object" || value === null) {
      return badInputFault(`${inputPath(path)} must be a tagged Lazuli input value`, path);
    }
    if (hasInputAncestor(entry.ancestor, value)) {
      return badInputFault(`${inputPath(path)} contains a cyclic host value`, path);
    }
    const taggedValue = value as { readonly kind?: unknown };
    const ancestor: InputAncestor = { value, parent: entry.ancestor };

    if (expectedType.kind === "integer") {
      if (taggedValue.kind !== "integer") return typeMismatch(path, expectedType, value);
      const integerValue = (value as { readonly value?: unknown }).value;
      if (
        typeof integerValue !== "number" || !Number.isInteger(integerValue) ||
        integerValue < -2_147_483_648 || integerValue > 2_147_483_647
      ) {
        return badInputFault(
          `${inputPath(path)}.value must be a signed i32; received ${integerValue}`,
          path,
        );
      }
      continue;
    }
    if (expectedType.kind === "boolean") {
      if (taggedValue.kind !== "boolean") return typeMismatch(path, expectedType, value);
      const booleanValue = (value as { readonly value?: unknown }).value;
      if (typeof booleanValue !== "boolean") {
        return badInputFault(
          `${inputPath(path)}.value must be Boolean; received ${booleanValue}`,
          path,
        );
      }
      continue;
    }
    if (expectedType.kind === "unit") {
      if (taggedValue.kind !== "unit") return typeMismatch(path, expectedType, value);
      continue;
    }
    if (expectedType.kind === "tuple") {
      if (taggedValue.kind !== "tuple") return typeMismatch(path, expectedType, value);
      const values = (value as { readonly values?: unknown }).values;
      if (!Array.isArray(values) || values.length !== 2) {
        return badInputFault(`${inputPath(path)}.values must contain exactly two values`, path);
      }
      for (const [fieldIndex, fieldType] of expectedType.values.entries()) {
        entries.push({
          value: values[fieldIndex],
          expectedType: fieldType,
          path: [...path, fieldIndex],
          ancestor,
        });
      }
      continue;
    }
    if (expectedType.kind === "function") {
      return typeMismatch(path, expectedType, value);
    }

    if (expectedType.kind !== "named") return typeMismatch(path, expectedType, value);

    if (enableCollectionSyntax && expectedType.name === "Text" && taggedValue.kind === "text") {
      const textValue = (value as { readonly value?: unknown }).value;
      if (typeof textValue !== "string") {
        return badInputFault(`${inputPath(path)}.value must be text; received ${textValue}`, path);
      }
      continue;
    }
    if (enableCollectionSyntax && expectedType.name === "List" && taggedValue.kind === "list") {
      const values = (value as { readonly values?: unknown }).values;
      const elementType = expectedType.arguments[0];
      if (!Array.isArray(values)) {
        return badInputFault(`${inputPath(path)}.values must be an array`, path);
      }
      if (elementType === undefined) {
        return badInputFault(
          `${inputPath(path)} cannot encode List without an inferred element type`,
          path,
        );
      }
      for (let valueIndex = 0; valueIndex < values.length; valueIndex++) {
        entries.push({
          value: values[valueIndex],
          expectedType: elementType,
          path: [...path, valueIndex],
          ancestor,
        });
      }
      continue;
    }
    if (taggedValue.kind !== "constructor") return typeMismatch(path, expectedType, value);

    const constructorValue = value as { readonly name?: unknown; readonly fields?: unknown };
    if (typeof constructorValue.name !== "string") {
      return badInputFault(`${inputPath(path)}.name must be a constructor name`, path);
    }
    if (!Array.isArray(constructorValue.fields)) {
      return badInputFault(`${inputPath(path)}.fields must be an array`, path);
    }
    const fieldTypes = expectedConstructorFieldTypes(module, expectedType, constructorValue.name);
    if (fieldTypes === undefined) {
      const ownerType = constructorOwnerType(module, constructorValue.name);
      const ownership = ownerType === undefined
        ? "is not declared by this module"
        : `belongs to ${ownerType}`;
      return badInputFault(
        `${inputPath(path)} constructor ${
          JSON.stringify(constructorValue.name)
        } ${ownership}; expected ${describeLazuliType(expectedType)}`,
        path,
      );
    }
    if (constructorValue.fields.length !== fieldTypes.length) {
      return badInputFault(
        `${inputPath(path)} constructor ${
          JSON.stringify(constructorValue.name)
        } expects ${fieldTypes.length} fields; received ${constructorValue.fields.length}`,
        path,
      );
    }
    for (let fieldIndex = 0; fieldIndex < fieldTypes.length; fieldIndex++) {
      const fieldType = fieldTypes[fieldIndex];
      if (fieldType === undefined) {
        throw new Error(
          `Lazuli input constructor ${constructorValue.name} omitted field type ${fieldIndex}`,
        );
      }
      entries.push({
        value: constructorValue.fields[fieldIndex],
        expectedType: fieldType,
        path: [...path, fieldIndex],
        ancestor,
      });
    }
  }
}

function inputParameterType(
  module: GpuLazuliModule,
): LazuliType | LazuliEvaluationResult {
  if (module.mainType.kind === "function") return module.mainType.parameter;
  return badInputFault(
    `main has type ${describeLazuliType(module.mainType)} and cannot receive a host input`,
    [],
  );
}

function evaluationOutputType(module: GpuLazuliModule, hasInput: boolean): LazuliType {
  if (!hasInput) return module.mainType;
  if (module.mainType.kind !== "function") {
    throw new Error("Lazuli evaluator accepted input for a non-function main");
  }
  return module.mainType.result;
}

function encodeInputValue(
  module: GpuLazuliModule,
  input: LazuliInputValue,
  expectedType: LazuliType,
  enableCollectionSyntax: boolean,
): EncodedInput | LazuliEvaluationResult {
  const entries: InputEncodingEntry[] = [{
    value: input,
    expectedType,
    path: [],
    ancestor: undefined,
  }];
  const words: number[] = [];

  for (let inputIndex = 0; inputIndex < entries.length; inputIndex++) {
    const entry = entries[inputIndex];
    if (entry === undefined) {
      throw new Error(`Lazuli input encoder omitted node ${inputIndex}`);
    }
    let value = entry.value;
    const path = inputPath(entry.path);
    if (typeof value !== "object" || value === null) {
      return badInputFault(`${path} must be a tagged Lazuli input value`, entry.path);
    }
    if (hasInputAncestor(entry.ancestor, value)) {
      return badInputFault(`${path} contains a cyclic host value`, entry.path);
    }

    const ancestorValue = value;
    let taggedValue = value as { readonly kind?: unknown };
    if (enableCollectionSyntax && taggedValue.kind === "text") {
      const textValue = (value as { readonly value?: unknown }).value;
      if (typeof textValue !== "string") {
        return badInputFault(`${path}.value must be text; received ${textValue}`, entry.path);
      }
      const expandedText = expandTextInput(module, textValue, entry.path);
      if ("ok" in expandedText) return expandedText;
      value = expandedText;
      taggedValue = expandedText;
    }
    if (enableCollectionSyntax && taggedValue.kind === "list") {
      const listValues = (value as { readonly values?: unknown }).values;
      if (!Array.isArray(listValues)) {
        return badInputFault(`${path}.values must be an array`, entry.path);
      }
      const expandedList = expandListInput(module, listValues, entry.path);
      if ("ok" in expandedList) return expandedList;
      value = expandedList;
      taggedValue = expandedList;
    }
    if (taggedValue.kind === "unit") {
      value = { kind: "constructor", name: "$Unit", fields: [] };
      taggedValue = value as { readonly kind?: unknown };
    }
    if (taggedValue.kind === "tuple") {
      const tupleValues = (value as { readonly values?: unknown }).values;
      if (!Array.isArray(tupleValues) || tupleValues.length !== 2) {
        return badInputFault(`${path}.values must contain exactly two values`, entry.path);
      }
      value = { kind: "constructor", name: "$Tuple", fields: tupleValues };
      taggedValue = value as { readonly kind?: unknown };
    }
    const wordOffset = inputIndex * 4;
    if (taggedValue.kind === "integer") {
      const integerValue = (value as { readonly value?: unknown }).value;
      if (
        typeof integerValue !== "number" || !Number.isInteger(integerValue) ||
        integerValue < -2_147_483_648 || integerValue > 2_147_483_647
      ) {
        return badInputFault(
          `${path}.value must be a signed i32; received ${integerValue}`,
          entry.path,
        );
      }
      words[wordOffset] = VALUE_INTEGER;
      words[wordOffset + 1] = integerValue >>> 0;
      words[wordOffset + 2] = LAZULI_NO_INDEX;
      words[wordOffset + 3] = 0;
      continue;
    }
    if (taggedValue.kind === "boolean") {
      const booleanValue = (value as { readonly value?: unknown }).value;
      if (typeof booleanValue !== "boolean") {
        return badInputFault(`${path}.value must be Boolean; received ${booleanValue}`, entry.path);
      }
      words[wordOffset] = VALUE_BOOLEAN;
      words[wordOffset + 1] = booleanValue ? 1 : 0;
      words[wordOffset + 2] = LAZULI_NO_INDEX;
      words[wordOffset + 3] = 0;
      continue;
    }
    if (taggedValue.kind !== "constructor") {
      return badInputFault(`${path}.kind is not a supported Lazuli input kind`, entry.path);
    }

    const constructorValue = value as {
      readonly name?: unknown;
      readonly fields?: unknown;
    };
    if (typeof constructorValue.name !== "string") {
      return badInputFault(`${path}.name must be a constructor name`, entry.path);
    }
    const constructorIndex = module.constructorNames.indexOf(constructorValue.name);
    if (constructorIndex < 0) {
      return badInputFault(
        `${path} names unknown constructor ${JSON.stringify(constructorValue.name)}`,
        entry.path,
      );
    }
    if (!Array.isArray(constructorValue.fields)) {
      return badInputFault(`${path}.fields must be an array`, entry.path);
    }
    const fieldTypes = expectedConstructorFieldTypes(
      module,
      entry.expectedType,
      constructorValue.name,
    );
    if (fieldTypes === undefined || fieldTypes.length !== constructorValue.fields.length) {
      return badInputFault(
        `${path} constructor ${JSON.stringify(constructorValue.name)} cannot encode as ${
          describeLazuliType(entry.expectedType)
        }`,
        entry.path,
      );
    }
    const expectedArity = module.constructorArities[constructorIndex];
    if (constructorValue.fields.length !== expectedArity) {
      return badInputFault(
        `${path} constructor ${
          JSON.stringify(constructorValue.name)
        } expects ${expectedArity} fields; received ${constructorValue.fields.length}`,
        entry.path,
      );
    }
    const firstChild = constructorValue.fields.length === 0 ? LAZULI_NO_INDEX : entries.length;
    const ancestor: InputAncestor = { value: ancestorValue, parent: entry.ancestor };
    for (let fieldIndex = 0; fieldIndex < constructorValue.fields.length; fieldIndex++) {
      const fieldType = fieldTypes[fieldIndex];
      if (fieldType === undefined) {
        throw new Error(`Lazuli input encoder omitted type for field ${fieldIndex}`);
      }
      entries.push({
        value: constructorValue.fields[fieldIndex],
        expectedType: fieldType,
        path: [...entry.path, fieldIndex],
        ancestor,
      });
    }
    if (entries.length >= LAZULI_NO_INDEX) {
      throw new RangeError(`Lazuli input contains ${entries.length} nodes, beyond the u32 limit`);
    }
    words[wordOffset] = VALUE_CONSTRUCTOR;
    words[wordOffset + 1] = constructorIndex;
    words[wordOffset + 2] = firstChild;
    words[wordOffset + 3] = constructorValue.fields.length;
  }

  return { words: Uint32Array.from(words), nodeCount: entries.length };
}

function expandListInput(
  module: GpuLazuliModule,
  values: readonly LazuliInputValue[],
  path: readonly number[],
): LazuliInputValue | LazuliEvaluationResult {
  const requiredConstructors = [
    ["Nil", 0],
    ["Cons", 2],
  ] as const;
  for (const [name, arity] of requiredConstructors) {
    const index = module.constructorNames.indexOf(name);
    if (index < 0 || module.constructorArities[index] !== arity) {
      return badInputFault(
        `${inputPath(path)} list requires constructor ${name} with arity ${arity}`,
        path,
      );
    }
  }

  let list: LazuliInputValue = { kind: "constructor", name: "Nil", fields: [] };
  for (let valueIndex = values.length - 1; valueIndex >= 0; valueIndex--) {
    const value = values[valueIndex];
    if (value === undefined) throw new Error(`Lazuli list input omitted value ${valueIndex}`);
    list = { kind: "constructor", name: "Cons", fields: [value, list] };
  }
  return list;
}

function expandTextInput(
  module: GpuLazuliModule,
  text: string,
  path: readonly number[],
): LazuliInputValue | LazuliEvaluationResult {
  const requiredConstructors = [
    ["Utf8", 1],
    ["BytesNil", 0],
    ["BytesCons", 2],
  ] as const;
  for (const [name, arity] of requiredConstructors) {
    const index = module.constructorNames.indexOf(name);
    if (index < 0 || module.constructorArities[index] !== arity) {
      return badInputFault(
        `${inputPath(path)} text requires constructor ${name} with arity ${arity}`,
        path,
      );
    }
  }

  let bytes: LazuliInputValue = { kind: "constructor", name: "BytesNil", fields: [] };
  const encoded = new TextEncoder().encode(text);
  for (let byteIndex = encoded.length - 1; byteIndex >= 0; byteIndex--) {
    const byte = encoded[byteIndex];
    if (byte === undefined) throw new Error(`UTF-8 input omitted byte ${byteIndex}`);
    bytes = {
      kind: "constructor",
      name: "BytesCons",
      fields: [{ kind: "integer", value: byte }, bytes],
    };
  }
  return { kind: "constructor", name: "Utf8", fields: [bytes] };
}

function checkedByteLength(count: number, elementByteLength: number): number | null {
  if (!Number.isSafeInteger(count) || count < 0 || count > LAZULI_NO_INDEX - 1) {
    return null;
  }
  const byteLength = count * elementByteLength;
  return Number.isSafeInteger(byteLength) ? byteLength : null;
}

function boundedOption(
  name: NumericEvaluationOption,
  provided: number | undefined,
  defaultValue: number,
  maximum: number,
): number {
  const value = provided ?? defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 through ${maximum}; received ${value}`);
  }
  return value;
}

function createInitialEvaluationState(
  module: GpuLazuliModule,
  limits: EvaluationLimits,
  encodedInput: EncodedInput | undefined,
  bases?: EvaluationBufferBases,
): ArrayBuffer {
  const initialState = new ArrayBuffer(EVALUATION_STATE_BYTE_LENGTH);
  const initialStateView = new DataView(initialState);
  const setInitialStateWord = (word: number, value: number) => {
    initialStateView.setUint32(word * Uint32Array.BYTES_PER_ELEMENT, value, true);
  };
  setInitialStateWord(EvaluationStateWord.NodeCount, module.nodeCount);
  setInitialStateWord(EvaluationStateWord.DefinitionCount, module.definitionCount);
  setInitialStateWord(EvaluationStateWord.EntryDefinition, module.entryDefinition);
  setInitialStateWord(EvaluationStateWord.MaximumSteps, limits.maximumSteps);
  setInitialStateWord(EvaluationStateWord.HeapCapacity, limits.heapSlots);
  setInitialStateWord(EvaluationStateWord.StackCapacity, limits.stackFrames);
  setInitialStateWord(EvaluationStateWord.ConstructorCount, module.constructorCount);
  setInitialStateWord(EvaluationStateWord.TypeCount, module.typeCount);
  setInitialStateWord(
    EvaluationStateWord.MaximumStepsPerDispatch,
    limits.maximumStepsPerDispatch,
  );
  setInitialStateWord(EvaluationStateWord.InputCount, encodedInput?.nodeCount ?? 0);
  setInitialStateWord(
    EvaluationStateWord.PendingInput,
    encodedInput === undefined ? LAZULI_NO_INDEX : 0,
  );
  setInitialStateWord(EvaluationStateWord.ResultForm, optionsResultForm(limits));
  setInitialStateWord(EvaluationStateWord.ResultBase, encodedInput?.nodeCount ?? 0);
  setInitialStateWord(EvaluationStateWord.ResultCapacity, limits.resultNodes);
  if (bases !== undefined) {
    setInitialStateWord(EvaluationStateWord.NodeBase, bases.node);
    setInitialStateWord(EvaluationStateWord.DefinitionBase, bases.definition);
    setInitialStateWord(EvaluationStateWord.ConstructorBase, bases.constructor);
    setInitialStateWord(EvaluationStateWord.HeapBase, bases.heap);
    setInitialStateWord(EvaluationStateWord.StackBase, bases.stack);
    setInitialStateWord(EvaluationStateWord.GlobalBase, bases.global);
    setInitialStateWord(EvaluationStateWord.InputBase, bases.input);
    setInitialStateWord(EvaluationStateWord.ResultBase, bases.result);
  }
  return initialState;
}

function optionsResultForm(limits: EvaluationLimits): number {
  return limits.deepResult ? 1 : 0;
}

function checkedAggregateCount(
  region: string,
  accumulatedCount: number,
  laneCount: number,
  resultIndex: number,
): number {
  const totalCount = accumulatedCount + laneCount;
  if (!Number.isSafeInteger(totalCount) || totalCount > LAZULI_NO_INDEX) {
    throw new RangeError(
      `Lazuli batch ${region} count cannot be represented as a u32: lane=${resultIndex}, accumulated=${accumulatedCount}, laneCount=${laneCount}, total=${totalCount}, maximum=${LAZULI_NO_INDEX}`,
    );
  }
  return totalCount;
}

function checkedAggregateByteLength(
  region: string,
  count: number,
  elementByteLength: number,
  minimumByteLength: number,
  maximumBufferByteLength: number,
  maximumBindingByteLength: number,
): number {
  const byteLength = Math.max(minimumByteLength, count * elementByteLength);
  if (!Number.isSafeInteger(byteLength)) {
    throw new RangeError(
      `Lazuli batch ${region} byte length is not a safe integer: count=${count}, elementBytes=${elementByteLength}, bytes=${byteLength}`,
    );
  }
  if (byteLength > maximumBufferByteLength || byteLength > maximumBindingByteLength) {
    throw new RangeError(
      `Lazuli batch ${region} requires ${byteLength} bytes for ${count} entries, beyond maxBufferSize=${maximumBufferByteLength} or maxStorageBufferBindingSize=${maximumBindingByteLength}`,
    );
  }
  return byteLength;
}

function readEvaluationSnapshot(snapshotView: DataView, byteOffset = 0): EvaluationSnapshot {
  const snapshotWord = (word: number) =>
    snapshotView.getUint32(
      byteOffset + word * Uint32Array.BYTES_PER_ELEMENT,
      true,
    );
  return {
    status: snapshotWord(EvaluationStateWord.Status),
    faultCode: snapshotWord(EvaluationStateWord.FaultCode),
    faultSourceOffset: snapshotWord(EvaluationStateWord.FaultSourceOffset),
    faultDetail: snapshotWord(EvaluationStateWord.FaultDetail),
    valueTag: snapshotWord(EvaluationStateWord.ValueTag),
    valuePayload: snapshotWord(EvaluationStateWord.ValuePayload),
    heapTop: snapshotWord(EvaluationStateWord.HeapTop),
    stackTop: snapshotWord(EvaluationStateWord.StackTop),
    initializationDefinition: snapshotWord(EvaluationStateWord.InitializationDefinition),
    resultTop: snapshotWord(EvaluationStateWord.ResultTop),
    stats: {
      steps: snapshotWord(EvaluationStateWord.Steps),
      allocations: snapshotWord(EvaluationStateWord.Allocations),
      peakStack: snapshotWord(EvaluationStateWord.PeakStack),
      thunkEvaluations: snapshotWord(EvaluationStateWord.ThunkEvaluations),
    },
  };
}

function assertConsistentEvaluationCounters(
  snapshot: EvaluationSnapshot,
  limits: EvaluationLimits,
  module: GpuLazuliModule,
  laneDescription = "",
): void {
  if (
    snapshot.stats.steps > limits.maximumSteps ||
    snapshot.stats.allocations !== snapshot.heapTop ||
    snapshot.heapTop > limits.heapSlots ||
    snapshot.stats.peakStack > limits.stackFrames ||
    snapshot.stackTop > snapshot.stats.peakStack ||
    snapshot.initializationDefinition > module.definitionCount ||
    snapshot.resultTop > limits.resultNodes ||
    snapshot.stats.thunkEvaluations > snapshot.stats.steps
  ) {
    throw new Error(
      `GPU Lazuli evaluator returned inconsistent counters${laneDescription}: steps=${snapshot.stats.steps}, allocations=${snapshot.stats.allocations}, heapTop=${snapshot.heapTop}, peakStack=${snapshot.stats.peakStack}, stackTop=${snapshot.stackTop}, thunkEvaluations=${snapshot.stats.thunkEvaluations}, initializedDefinitions=${snapshot.initializationDefinition}`,
    );
  }
}

function completedBatchResults(
  results: readonly (AnyLazuliEvaluationResult | undefined)[],
): readonly AnyLazuliEvaluationResult[] {
  return results.map((result, resultIndex) => {
    if (result === undefined) {
      throw new Error(`GPU Lazuli evaluator did not produce batch result ${resultIndex}`);
    }
    return result;
  });
}

function scalarOptionsForBatchLane(
  options: LazuliBatchEvaluationOptions,
  input: LazuliInputValue | undefined,
): LazuliEvaluationOptions {
  const sharedOptions: LazuliEvaluationOptions = {
    ...(options.maximumSteps === undefined ? {} : { maximumSteps: options.maximumSteps }),
    ...(options.maximumStepsPerDispatch === undefined
      ? {}
      : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
    ...(options.heapSlots === undefined ? {} : { heapSlots: options.heapSlots }),
    ...(options.stackFrames === undefined ? {} : { stackFrames: options.stackFrames }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.resultForm === undefined ? {} : { resultForm: options.resultForm }),
    ...(options.maximumResultNodes === undefined
      ? {}
      : { maximumResultNodes: options.maximumResultNodes }),
    ...(input === undefined ? {} : { input }),
  };
  return sharedOptions;
}

function expectedValueName(expected: number): string {
  switch (expected) {
    case EXPECT_INTEGER:
      return "integer";
    case EXPECT_BOOLEAN:
      return "boolean";
    case EXPECT_CALLABLE:
      return "callable";
    case EXPECT_CONSTRUCTOR:
      return "constructor";
    default:
      return `unknown value kind ${expected}`;
  }
}

function actualValueName(tag: number): string {
  switch (tag) {
    case VALUE_INTEGER:
      return "integer";
    case VALUE_BOOLEAN:
      return "boolean";
    case VALUE_CLOSURE:
    case VALUE_CONSTRUCTOR_PARTIAL:
      return "callable";
    case VALUE_CONSTRUCTOR:
      return "constructor";
    default:
      return `unknown value tag ${tag}`;
  }
}

function decodeFault(
  state: EvaluationSnapshot,
  limits: EvaluationLimits,
  module: GpuLazuliModule,
): LazuliRuntimeFault {
  const sourceByteOffset = state.faultSourceOffset === LAZULI_NO_INDEX
    ? null
    : state.faultSourceOffset;

  switch (state.faultCode) {
    case FAULT_BAD_MODULE:
      return {
        kind: "bad-module",
        code: "L3001",
        message: `module contains an invalid tag or index (${state.faultDetail})`,
        sourceByteOffset,
      };
    case FAULT_OUT_OF_FUEL:
      return {
        kind: "out-of-fuel",
        code: "L3002",
        message: `evaluation exhausted its limit of ${limits.maximumSteps} steps`,
        sourceByteOffset,
      };
    case FAULT_OUT_OF_HEAP:
      return {
        kind: "out-of-heap",
        code: "L3003",
        message: `evaluation exhausted its heap of ${limits.heapSlots} slots`,
        sourceByteOffset,
      };
    case FAULT_STACK_OVERFLOW:
      return {
        kind: "stack-overflow",
        code: "L3004",
        message: `evaluation exhausted its continuation stack of ${limits.stackFrames} frames`,
        sourceByteOffset,
      };
    case FAULT_BLACKHOLE:
      return {
        kind: "blackhole",
        code: "L3005",
        message: `evaluation demanded thunk ${state.faultDetail} while it was already evaluating`,
        sourceByteOffset,
      };
    case FAULT_TYPE_ERROR:
      return {
        kind: "type-error",
        code: "L3006",
        message: `expected ${expectedValueName(state.faultDetail)}, received ${
          actualValueName(state.valueTag)
        }`,
        sourceByteOffset,
      };
    case FAULT_DIVIDE_BY_ZERO:
      return {
        kind: "divide-by-zero",
        code: "L3007",
        message: "integer division by zero",
        sourceByteOffset,
      };
    case FAULT_NON_EXHAUSTIVE_CASE: {
      const constructorName = module.constructorNames[state.faultDetail];
      if (state.faultDetail >= module.constructorCount || typeof constructorName !== "string") {
        throw new Error(
          `GPU Lazuli evaluator returned invalid non-exhaustive constructor ${state.faultDetail}`,
        );
      }
      return {
        kind: "non-exhaustive-case",
        code: "L3008",
        message: `non-exhaustive case: no arm matches constructor "${constructorName}"`,
        sourceByteOffset,
      };
    }
    case FAULT_RESULT_TOO_LARGE:
      return {
        kind: "result-too-large",
        code: "L3010",
        message: `deep result exceeded its limit of ${limits.resultNodes} nodes`,
        sourceByteOffset,
      };
    case FAULT_CYCLIC_RESULT:
      return {
        kind: "cyclic-result",
        code: "L3011",
        message: `deep result contains a constructor cycle through heap value ${state.faultDetail}`,
        sourceByteOffset,
      };
    default:
      throw new Error(`GPU Lazuli evaluator returned unknown fault code ${state.faultCode}`);
  }
}

function decodeDeepValue(
  bytes: ArrayBuffer,
  nodeCount: number,
  module: GpuLazuliModule,
  expectedType: LazuliType,
  enableCollectionSyntax: boolean,
): LazuliDeepValue {
  const view = new DataView(bytes);
  let root: LazuliDeepValue | undefined;
  const parents: Array<{ fields: LazuliDeepValue[]; remaining: number }> = [];

  for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex++) {
    const byteOffset = nodeIndex * RESULT_NODE_BYTE_LENGTH;
    const tag = view.getUint32(byteOffset, true);
    const payload = view.getUint32(byteOffset + 4, true);
    const fieldCount = view.getUint32(byteOffset + 8, true);
    let value: LazuliDeepValue;
    let constructorFields: LazuliDeepValue[] | undefined;
    switch (tag) {
      case VALUE_INTEGER:
        if (fieldCount !== 0) throw new Error(`deep integer ${nodeIndex} has ${fieldCount} fields`);
        value = { kind: "integer", value: payload | 0 };
        break;
      case VALUE_BOOLEAN:
        if (payload > 1 || fieldCount !== 0) {
          throw new Error(`deep Boolean ${nodeIndex} has payload=${payload}, fields=${fieldCount}`);
        }
        value = { kind: "boolean", value: payload === 1 };
        break;
      case VALUE_CLOSURE:
      case VALUE_CONSTRUCTOR_PARTIAL:
        if (fieldCount !== 0) throw new Error(`deep closure ${nodeIndex} has ${fieldCount} fields`);
        value = { kind: "closure" };
        break;
      case VALUE_CONSTRUCTOR: {
        const name = module.constructorNames[payload];
        const expectedFieldCount = module.constructorArities[payload];
        if (
          payload >= module.constructorCount || typeof name !== "string" ||
          fieldCount !== expectedFieldCount
        ) {
          throw new Error(
            `deep constructor ${nodeIndex} has index=${payload}, fields=${fieldCount}, expected=${expectedFieldCount}`,
          );
        }
        if (name === "$Unit") {
          if (fieldCount !== 0) throw new Error("deep unit value has fields");
          value = { kind: "unit" };
          break;
        }
        constructorFields = [];
        value = name === "$Tuple"
          ? { kind: "tuple", fieldCount: 2, fields: constructorFields }
          : { kind: "constructor", name, fieldCount, fields: constructorFields };
        break;
      }
      default:
        throw new Error(`deep result node ${nodeIndex} has unknown tag ${tag}`);
    }

    const parent = parents.at(-1);
    if (parent === undefined) {
      if (root !== undefined) throw new Error(`deep result has a second root at node ${nodeIndex}`);
      root = value;
    } else {
      parent.fields.push(value);
      parent.remaining--;
      while (parents.at(-1)?.remaining === 0) parents.pop();
    }
    if (constructorFields !== undefined && fieldCount > 0) {
      parents.push({ fields: constructorFields, remaining: fieldCount });
    }
  }

  if (root === undefined || parents.length !== 0) {
    throw new Error(
      `deep result is incomplete: nodes=${nodeCount}, openConstructors=${parents.length}`,
    );
  }
  return decodeTypedDeepValue(root, expectedType, enableCollectionSyntax);
}

function decodeTypedDeepValue(
  root: LazuliDeepValue,
  expectedType: LazuliType,
  enableCollectionSyntax: boolean,
): LazuliDeepValue {
  if (!enableCollectionSyntax) return root;
  if (expectedType.kind !== "named") return root;
  if (expectedType.name === "Text") return decodeTextValue(root);
  if (expectedType.name === "List") return decodeListValue(root);
  return root;
}

function decodeTextValue(root: LazuliDeepValue): LazuliDeepValue {
  if (root.kind !== "constructor" || root.name !== "Utf8" || root.fields.length !== 1) {
    return root;
  }
  const bytes: number[] = [];
  let cursor = root.fields[0];
  while (cursor?.kind === "constructor" && cursor.name === "BytesCons") {
    if (cursor.fields.length !== 2) return root;
    const byte = cursor.fields[0];
    if (byte?.kind !== "integer" || byte.value < 0 || byte.value > 255) return root;
    bytes.push(byte.value);
    cursor = cursor.fields[1];
  }
  if (
    cursor?.kind !== "constructor" || cursor.name !== "BytesNil" || cursor.fields.length !== 0
  ) {
    return root;
  }
  try {
    return {
      kind: "text",
      value: new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes)),
    };
  } catch {
    return root;
  }
}

function decodeListValue(root: LazuliDeepValue): LazuliDeepValue {
  const values: LazuliDeepValue[] = [];
  let cursor = root;
  while (cursor.kind === "constructor" && cursor.name === "Cons") {
    if (cursor.fields.length !== 2) return root;
    const head = cursor.fields[0];
    const tail = cursor.fields[1];
    if (head === undefined || tail === undefined) return root;
    values.push(head);
    cursor = tail;
  }
  if (cursor.kind !== "constructor" || cursor.name !== "Nil" || cursor.fields.length !== 0) {
    return root;
  }
  return { kind: "list", values };
}

function decodeValue(
  valueTag: number,
  valuePayload: number,
  module: GpuLazuliModule,
): LazuliValue {
  switch (valueTag) {
    case VALUE_INTEGER:
      return { kind: "integer", value: valuePayload | 0 };
    case VALUE_BOOLEAN:
      if (valuePayload > 1) {
        throw new Error(`GPU Lazuli evaluator returned invalid Boolean payload ${valuePayload}`);
      }
      return { kind: "boolean", value: valuePayload === 1 };
    case VALUE_CLOSURE:
    case VALUE_CONSTRUCTOR_PARTIAL:
      return { kind: "closure" };
    case VALUE_CONSTRUCTOR: {
      const name = module.constructorNames[valuePayload];
      const fieldCount = module.constructorArities[valuePayload];
      if (
        valuePayload >= module.constructorCount || typeof name !== "string" ||
        typeof fieldCount !== "number" || !Number.isSafeInteger(fieldCount) || fieldCount < 0 ||
        fieldCount > LAZULI_MAXIMUM_CONSTRUCTOR_ARITY
      ) {
        throw new Error(
          `GPU Lazuli evaluator returned invalid constructor metadata for index ${valuePayload}`,
        );
      }
      if (name === "$Unit") return { kind: "unit" };
      if (name === "$Tuple") return { kind: "tuple", fieldCount: 2 };
      return { kind: "constructor", name, fieldCount };
    }
    default:
      throw new Error(`GPU Lazuli evaluator returned unknown value tag ${valueTag}`);
  }
}

export class GpuLazuliEvaluator {
  readonly #device: GPUDevice;
  readonly #pipeline: GPUComputePipeline;
  readonly #maximumHeapSlots: number;
  readonly #maximumStackFrames: number;
  readonly #maximumResultNodes: number;
  readonly #enableCollectionSyntax: boolean;

  private constructor(
    device: GPUDevice,
    pipeline: GPUComputePipeline,
    maximumHeapSlots: number,
    maximumStackFrames: number,
    maximumResultNodes: number,
    enableCollectionSyntax: boolean,
  ) {
    this.#device = device;
    this.#pipeline = pipeline;
    this.#maximumHeapSlots = maximumHeapSlots;
    this.#maximumStackFrames = maximumStackFrames;
    this.#maximumResultNodes = maximumResultNodes;
    this.#enableCollectionSyntax = enableCollectionSyntax;
  }

  static async create(device: GPUDevice): Promise<GpuLazuliEvaluator> {
    return await GpuLazuliEvaluator.createBackend(device, true);
  }

  static async createFunctionalBackend(device: GPUDevice): Promise<GpuLazuliEvaluator> {
    return await GpuLazuliEvaluator.createBackend(device, false);
  }

  private static async createBackend(
    device: GPUDevice,
    enableCollectionSyntax: boolean,
  ): Promise<GpuLazuliEvaluator> {
    const maximumStorageBytes = Math.min(
      device.limits.maxStorageBufferBindingSize,
      device.limits.maxBufferSize,
    );
    const maximumHeapSlots = Math.min(
      HARD_MAXIMUM_HEAP_SLOTS,
      Math.floor(maximumStorageBytes / HEAP_SLOT_BYTE_LENGTH),
    );
    const maximumStackFrames = Math.min(
      HARD_MAXIMUM_STACK_FRAMES,
      Math.floor(maximumStorageBytes / STACK_FRAME_BYTE_LENGTH),
    );
    const maximumResultNodes = Math.min(
      HARD_MAXIMUM_RESULT_NODES,
      Math.floor(maximumStorageBytes / RESULT_NODE_BYTE_LENGTH),
    );
    if (maximumHeapSlots < 1 || maximumStackFrames < 1 || maximumResultNodes < 1) {
      throw new Error(
        `WebGPU device storage limit ${maximumStorageBytes} is too small for Lazuli runtime buffers`,
      );
    }

    const shaderModule = device.createShaderModule({
      label: "Lazuli lazy evaluator",
      code: LAZULI_EVALUATOR_SHADER,
    });
    const shaderCompilation = await shaderModule.getCompilationInfo();
    const shaderErrors = shaderCompilation.messages.filter((message) => message.type === "error");
    if (shaderErrors.length > 0) {
      const formattedShaderErrors = shaderErrors.map((message) =>
        `${message.lineNum}:${message.linePos}: ${message.message}`
      ).join("\n");
      throw new Error(`WebGPU rejected the Lazuli evaluator shader:\n${formattedShaderErrors}`);
    }

    try {
      const pipeline = await device.createComputePipelineAsync({
        label: "Lazuli lazy evaluator pipeline",
        layout: "auto",
        compute: {
          module: shaderModule,
          entryPoint: "evaluate_lazuli",
        },
      });
      return new GpuLazuliEvaluator(
        device,
        pipeline,
        maximumHeapSlots,
        maximumStackFrames,
        maximumResultNodes,
        enableCollectionSyntax,
      );
    } catch (cause) {
      throw new Error("WebGPU could not create the Lazuli evaluator pipeline", { cause });
    }
  }

  #validateModule(module: GpuLazuliModule): ModuleValidation {
    const nodeByteLength = checkedByteLength(module.nodeCount, LAZULI_NODE_BYTE_LENGTH);
    const definitionByteLength = checkedByteLength(
      module.definitionCount,
      LAZULI_DEFINITION_BYTE_LENGTH,
    );
    const constructorByteLength = checkedByteLength(
      module.constructorCount,
      LAZULI_CONSTRUCTOR_BYTE_LENGTH,
    );
    const constructorBindingByteLength = Math.max(
      LAZULI_CONSTRUCTOR_BYTE_LENGTH,
      constructorByteLength ?? 0,
    );
    if (
      nodeByteLength === null || definitionByteLength === null ||
      constructorByteLength === null ||
      module.nodeCount === 0 || module.definitionCount === 0 ||
      !Number.isSafeInteger(module.entryDefinition) || module.entryDefinition < 0 ||
      module.entryDefinition >= module.definitionCount ||
      !Number.isSafeInteger(module.typeCount) || module.typeCount < 0 ||
      module.typeCount >= LAZULI_NO_INDEX ||
      (module.constructorCount > 0 && module.typeCount === 0) ||
      module.constructorNames.length !== module.constructorCount ||
      module.constructorArities.length !== module.constructorCount
    ) {
      return {
        valid: false,
        result: badModuleFault(
          `module counts, metadata, or entry definition are invalid: nodes=${module.nodeCount}, definitions=${module.definitionCount}, types=${module.typeCount}, constructors=${module.constructorCount}, entry=${module.entryDefinition}`,
        ),
      };
    }

    const maximumModuleBindingSize = this.#device.limits.maxStorageBufferBindingSize;
    if (
      nodeByteLength > maximumModuleBindingSize ||
      definitionByteLength > maximumModuleBindingSize ||
      constructorBindingByteLength > maximumModuleBindingSize ||
      nodeByteLength > this.#device.limits.maxBufferSize ||
      definitionByteLength > this.#device.limits.maxBufferSize ||
      constructorBindingByteLength > this.#device.limits.maxBufferSize ||
      module.nodeBuffer.size < nodeByteLength ||
      module.definitionBuffer.size < definitionByteLength ||
      module.constructorBuffer.size < constructorBindingByteLength
    ) {
      return {
        valid: false,
        result: badModuleFault(
          `module buffers do not contain the declared ${module.nodeCount} nodes, ${module.definitionCount} definitions, and ${module.constructorCount} constructors within this device's limits`,
        ),
      };
    }

    return {
      valid: true,
      nodeByteLength,
      definitionByteLength,
      constructorByteLength,
      constructorBindingByteLength,
    };
  }

  #evaluationLimits(
    module: GpuLazuliModule,
    options: LazuliEvaluationOptions,
  ): EvaluationLimits {
    if (
      options.resultForm !== undefined && options.resultForm !== "weak-head" &&
      options.resultForm !== "deep"
    ) {
      throw new RangeError(
        `resultForm must be "weak-head" or "deep"; received ${JSON.stringify(options.resultForm)}`,
      );
    }
    const defaultMaximumSteps = Math.min(
      HARD_MAXIMUM_STEPS,
      Math.max(10_000, module.nodeCount * 64 + module.definitionCount * 8),
    );
    const defaultHeapSlots = Math.min(
      this.#maximumHeapSlots,
      Math.max(256, module.definitionCount + module.nodeCount * 4),
    );
    const defaultStackFrames = Math.min(
      this.#maximumStackFrames,
      Math.max(128, module.nodeCount * 2),
    );
    const defaultResultNodes = Math.min(
      this.#maximumResultNodes,
      Math.max(256, module.nodeCount * 2),
    );
    return {
      maximumSteps: boundedOption(
        "maximumSteps",
        options.maximumSteps,
        defaultMaximumSteps,
        HARD_MAXIMUM_STEPS,
      ),
      maximumStepsPerDispatch: boundedOption(
        "maximumStepsPerDispatch",
        options.maximumStepsPerDispatch,
        DEFAULT_MAXIMUM_STEPS_PER_DISPATCH,
        HARD_MAXIMUM_STEPS_PER_DISPATCH,
      ),
      heapSlots: boundedOption(
        "heapSlots",
        options.heapSlots,
        defaultHeapSlots,
        this.#maximumHeapSlots,
      ),
      stackFrames: boundedOption(
        "stackFrames",
        options.stackFrames,
        defaultStackFrames,
        this.#maximumStackFrames,
      ),
      resultNodes: boundedOption(
        "maximumResultNodes",
        options.maximumResultNodes,
        options.resultForm === "deep" ? defaultResultNodes : 1,
        this.#maximumResultNodes,
      ),
      deepResult: options.resultForm === "deep",
    };
  }

  async evaluate(
    module: GpuLazuliModule,
    options: LazuliDeepEvaluationOptions,
  ): Promise<LazuliDeepEvaluationResult>;
  async evaluate(
    module: GpuLazuliModule,
    options?: LazuliEvaluationOptions,
  ): Promise<LazuliEvaluationResult>;
  async evaluate(
    module: GpuLazuliModule,
    options: LazuliEvaluationOptions = {},
  ): Promise<AnyLazuliEvaluationResult> {
    options.signal?.throwIfAborted();

    const moduleValidation = this.#validateModule(module);
    if (!moduleValidation.valid) return moduleValidation.result;

    const inputType = options.input === undefined ? undefined : inputParameterType(module);
    if (inputType !== undefined && "ok" in inputType) return inputType;
    if (options.input !== undefined && inputType !== undefined) {
      const inputFault = validateInputValue(
        module,
        options.input,
        inputType,
        this.#enableCollectionSyntax,
      );
      if (inputFault !== undefined) return inputFault;
    }
    const outputType = evaluationOutputType(module, options.input !== undefined);
    let inputEncoding: EncodedInput | undefined;
    if (options.input !== undefined) {
      if (inputType === undefined || "ok" in inputType) {
        throw new Error("Lazuli evaluator omitted the main input type");
      }
      const encodedInput = encodeInputValue(
        module,
        options.input,
        inputType,
        this.#enableCollectionSyntax,
      );
      if ("ok" in encodedInput) return encodedInput;
      inputEncoding = encodedInput;
    }

    const limits = this.#evaluationLimits(module, options);
    const maximumModuleBindingSize = this.#device.limits.maxStorageBufferBindingSize;

    const heapBufferByteLength = limits.heapSlots * HEAP_SLOT_BYTE_LENGTH;
    const stackBufferByteLength = limits.stackFrames * STACK_FRAME_BYTE_LENGTH;
    const globalBufferByteLength = module.definitionCount * Uint32Array.BYTES_PER_ELEMENT;
    const inputNodeCount = inputEncoding?.nodeCount ?? 0;
    const inputBufferByteLength = (inputNodeCount + limits.resultNodes) * INPUT_NODE_BYTE_LENGTH;
    const resultBufferByteLength = limits.resultNodes * RESULT_NODE_BYTE_LENGTH;
    if (
      globalBufferByteLength > maximumModuleBindingSize ||
      globalBufferByteLength > this.#device.limits.maxBufferSize
    ) {
      return badModuleFault(
        `module requires ${globalBufferByteLength} bytes of global runtime storage, beyond this device's limit`,
      );
    }
    if (
      inputBufferByteLength > maximumModuleBindingSize ||
      inputBufferByteLength > this.#device.limits.maxBufferSize
    ) {
      throw new RangeError(
        `Lazuli evaluation values require ${inputBufferByteLength} bytes for ${inputNodeCount} input nodes and ${limits.resultNodes} result nodes, beyond maxBufferSize=${this.#device.limits.maxBufferSize} or maxStorageBufferBindingSize=${maximumModuleBindingSize}`,
      );
    }

    const initialState = createInitialEvaluationState(module, limits, inputEncoding);

    let heapBuffer: GPUBuffer | undefined;
    let stackBuffer: GPUBuffer | undefined;
    let globalBuffer: GPUBuffer | undefined;
    let stateBuffer: GPUBuffer | undefined;
    let stateReadbackBuffer: GPUBuffer | undefined;
    let inputBuffer: GPUBuffer | undefined;
    let resultReadbackBuffer: GPUBuffer | undefined;
    let stateReadbackMapped = false;

    try {
      let bindGroup: GPUBindGroup;
      this.#device.pushErrorScope("validation");
      let setupValidation: Promise<GPUError | null>;
      try {
        heapBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation heap",
          size: heapBufferByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        stackBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation continuation stack",
          size: stackBufferByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        globalBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation global thunks",
          size: globalBufferByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        stateBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation state",
          size: EVALUATION_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateReadbackBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation state readback",
          size: EVALUATION_STATE_BYTE_LENGTH,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        resultReadbackBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation deep result readback",
          size: resultBufferByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        inputBuffer = this.#device.createBuffer({
          label: "Lazuli evaluation values",
          size: inputBufferByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        if (inputEncoding !== undefined) {
          this.#device.queue.writeBuffer(inputBuffer, 0, inputEncoding.words);
        }

        this.#device.queue.writeBuffer(stateBuffer, 0, initialState);

        bindGroup = this.#device.createBindGroup({
          label: "Lazuli evaluator bindings",
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            {
              binding: 0,
              resource: { buffer: module.nodeBuffer, size: moduleValidation.nodeByteLength },
            },
            {
              binding: 1,
              resource: {
                buffer: module.definitionBuffer,
                size: moduleValidation.definitionByteLength,
              },
            },
            { binding: 2, resource: { buffer: heapBuffer } },
            { binding: 3, resource: { buffer: stackBuffer } },
            { binding: 4, resource: { buffer: globalBuffer } },
            { binding: 5, resource: { buffer: stateBuffer } },
            {
              binding: 6,
              resource: {
                buffer: module.constructorBuffer,
                size: moduleValidation.constructorBindingByteLength,
              },
            },
            {
              binding: 7,
              resource: { buffer: inputBuffer },
            },
          ],
        });
        setupValidation = this.#device.popErrorScope();
      } catch (cause) {
        const validationError = await this.#device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli evaluation setup for ${module.nodeCount} nodes: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }

      const setupValidationError = await setupValidation;
      if (setupValidationError !== null) {
        throw new Error(
          `WebGPU rejected Lazuli evaluation setup for ${module.nodeCount} nodes: ${setupValidationError.message}`,
        );
      }

      let previousSteps = 0;
      while (true) {
        options.signal?.throwIfAborted();
        this.#device.pushErrorScope("validation");
        let dispatchValidation: Promise<GPUError | null>;
        try {
          const commandEncoder = this.#device.createCommandEncoder({
            label: "Lazuli evaluation commands",
          });
          const computePass = commandEncoder.beginComputePass({
            label: "Evaluate Lazuli module",
          });
          computePass.setPipeline(this.#pipeline);
          computePass.setBindGroup(0, bindGroup);
          computePass.dispatchWorkgroups(1);
          computePass.end();
          commandEncoder.copyBufferToBuffer(
            stateBuffer,
            0,
            stateReadbackBuffer,
            0,
            EVALUATION_STATE_BYTE_LENGTH,
          );
          options.signal?.throwIfAborted();
          this.#device.queue.submit([commandEncoder.finish()]);
          dispatchValidation = this.#device.popErrorScope();
        } catch (cause) {
          const validationError = await this.#device.popErrorScope();
          if (validationError !== null) {
            throw new Error(
              `WebGPU rejected Lazuli evaluation for ${module.nodeCount} nodes: ${validationError.message}`,
              { cause },
            );
          }
          throw cause;
        }

        const validationError = await dispatchValidation;
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli evaluation for ${module.nodeCount} nodes: ${validationError.message}`,
          );
        }

        try {
          await stateReadbackBuffer.mapAsync(GPUMapMode.READ);
        } catch (cause) {
          throw new Error(
            `could not read GPU Lazuli evaluation status for ${module.nodeCount} nodes`,
            { cause },
          );
        }
        stateReadbackMapped = true;
        const snapshotBytes = stateReadbackBuffer.getMappedRange().slice(0);
        stateReadbackBuffer.unmap();
        stateReadbackMapped = false;
        options.signal?.throwIfAborted();

        const snapshot = readEvaluationSnapshot(new DataView(snapshotBytes));
        assertConsistentEvaluationCounters(snapshot, limits, module);

        const dispatchSteps = snapshot.stats.steps - previousSteps;
        if (dispatchSteps < 1 || dispatchSteps > limits.maximumStepsPerDispatch) {
          throw new Error(
            `GPU Lazuli evaluator returned invalid dispatch progress: previousSteps=${previousSteps}, steps=${snapshot.stats.steps}, maximumStepsPerDispatch=${limits.maximumStepsPerDispatch}`,
          );
        }

        if (snapshot.status === STATUS_PENDING) {
          if (
            snapshot.faultCode !== 0 ||
            snapshot.faultSourceOffset !== LAZULI_NO_INDEX ||
            snapshot.faultDetail !== 0 || snapshot.stats.steps >= limits.maximumSteps
          ) {
            throw new Error(
              `GPU Lazuli evaluator returned inconsistent pending state: fault=${snapshot.faultCode}, source=${snapshot.faultSourceOffset}, detail=${snapshot.faultDetail}, steps=${snapshot.stats.steps}`,
            );
          }
          previousSteps = snapshot.stats.steps;
          continue;
        }

        if (snapshot.status === STATUS_COMPLETE) {
          if (
            snapshot.faultCode !== 0 ||
            snapshot.faultSourceOffset !== LAZULI_NO_INDEX ||
            snapshot.stackTop !== 0
          ) {
            throw new Error(
              `GPU Lazuli evaluator returned inconsistent success state: fault=${snapshot.faultCode}, source=${snapshot.faultSourceOffset}, stackTop=${snapshot.stackTop}`,
            );
          }
          if (limits.deepResult) {
            const commandEncoder = this.#device.createCommandEncoder({
              label: "Read Lazuli deep result",
            });
            commandEncoder.copyBufferToBuffer(
              inputBuffer,
              inputNodeCount * INPUT_NODE_BYTE_LENGTH,
              resultReadbackBuffer,
              0,
              snapshot.resultTop * RESULT_NODE_BYTE_LENGTH,
            );
            this.#device.queue.submit([commandEncoder.finish()]);
            await resultReadbackBuffer.mapAsync(GPUMapMode.READ);
            const resultBytes = resultReadbackBuffer.getMappedRange().slice(0);
            resultReadbackBuffer.unmap();
            return {
              ok: true,
              value: decodeDeepValue(
                resultBytes,
                snapshot.resultTop,
                module,
                outputType,
                this.#enableCollectionSyntax,
              ),
              stats: snapshot.stats,
            };
          }
          return {
            ok: true,
            value: decodeValue(snapshot.valueTag, snapshot.valuePayload, module),
            stats: snapshot.stats,
          };
        }

        if (snapshot.status === STATUS_FAULT) {
          return {
            ok: false,
            fault: decodeFault(snapshot, limits, module),
            stats: snapshot.stats,
          };
        }

        throw new Error(`GPU Lazuli evaluator returned unknown status ${snapshot.status}`);
      }
    } finally {
      if (stateReadbackMapped) {
        stateReadbackBuffer?.unmap();
      }
      heapBuffer?.destroy();
      stackBuffer?.destroy();
      globalBuffer?.destroy();
      stateBuffer?.destroy();
      stateReadbackBuffer?.destroy();
      inputBuffer?.destroy();
      resultReadbackBuffer?.destroy();
    }
  }

  async evaluateBatch(
    modules: readonly GpuLazuliModule[],
    options: LazuliDeepBatchEvaluationOptions,
  ): Promise<readonly LazuliDeepEvaluationResult[]>;
  async evaluateBatch(
    modules: readonly GpuLazuliModule[],
    options?: LazuliBatchEvaluationOptions,
  ): Promise<readonly LazuliEvaluationResult[]>;
  async evaluateBatch(
    modules: readonly GpuLazuliModule[],
    options: LazuliBatchEvaluationOptions = {},
  ): Promise<readonly AnyLazuliEvaluationResult[]> {
    options.signal?.throwIfAborted();
    if (options.inputs !== undefined && options.inputs.length !== modules.length) {
      throw new RangeError(
        `Lazuli batch received ${options.inputs.length} inputs for ${modules.length} modules`,
      );
    }
    if (modules.length === 0) return [];
    if (modules.length === 1) {
      const [module] = modules;
      if (module === undefined) {
        throw new Error("Lazuli batch contains no module at index 0");
      }
      return [await this.evaluate(module, scalarOptionsForBatchLane(options, options.inputs?.[0]))];
    }

    const results: (AnyLazuliEvaluationResult | undefined)[] = new Array(modules.length);
    const preparedLanes: {
      readonly resultIndex: number;
      readonly module: GpuLazuliModule;
      readonly buffers: ValidatedModuleBuffers;
      readonly limits: EvaluationLimits;
      readonly encodedInput: EncodedInput | undefined;
      readonly inputValue: LazuliInputValue | undefined;
      readonly outputType: LazuliType;
    }[] = [];
    const maximumModuleBindingSize = this.#device.limits.maxStorageBufferBindingSize;
    for (const [resultIndex, module] of modules.entries()) {
      const moduleValidation = this.#validateModule(module);
      if (!moduleValidation.valid) {
        results[resultIndex] = moduleValidation.result;
        continue;
      }

      const inputValue = options.inputs?.[resultIndex];
      const inputType = inputValue === undefined ? undefined : inputParameterType(module);
      if (inputType !== undefined && "ok" in inputType) {
        results[resultIndex] = inputType;
        continue;
      }
      if (inputValue !== undefined && inputType !== undefined) {
        const inputFault = validateInputValue(
          module,
          inputValue,
          inputType,
          this.#enableCollectionSyntax,
        );
        if (inputFault !== undefined) {
          results[resultIndex] = inputFault;
          continue;
        }
      }
      const outputType = evaluationOutputType(module, inputValue !== undefined);
      let inputEncoding: EncodedInput | undefined;
      if (inputValue !== undefined) {
        if (inputType === undefined || "ok" in inputType) {
          throw new Error("Lazuli batch evaluator omitted a main input type");
        }
        const encodedInput = encodeInputValue(
          module,
          inputValue,
          inputType,
          this.#enableCollectionSyntax,
        );
        if ("ok" in encodedInput) {
          results[resultIndex] = encodedInput;
          continue;
        }
        inputEncoding = encodedInput;
      }

      const limits = this.#evaluationLimits(module, options);
      const globalByteLength = module.definitionCount * Uint32Array.BYTES_PER_ELEMENT;
      if (
        globalByteLength > maximumModuleBindingSize ||
        globalByteLength > this.#device.limits.maxBufferSize
      ) {
        results[resultIndex] = badModuleFault(
          `module requires ${globalByteLength} bytes of global runtime storage, beyond this device's limit`,
        );
        continue;
      }

      preparedLanes.push({
        resultIndex,
        module,
        buffers: moduleValidation,
        limits,
        encodedInput: inputEncoding,
        inputValue,
        outputType,
      });
    }

    if (preparedLanes.length === 0) return completedBatchResults(results);
    if (preparedLanes.length === 1) {
      const [lane] = preparedLanes;
      if (lane === undefined) {
        throw new Error("Lazuli batch contains no prepared lane at index 0");
      }
      results[lane.resultIndex] = await this.evaluate(
        lane.module,
        scalarOptionsForBatchLane(options, lane.inputValue),
      );
      return completedBatchResults(results);
    }

    const maximumWorkgroups = this.#device.limits.maxComputeWorkgroupsPerDimension;
    if (
      !Number.isSafeInteger(preparedLanes.length) || preparedLanes.length > LAZULI_NO_INDEX ||
      preparedLanes.length > maximumWorkgroups
    ) {
      throw new RangeError(
        `Lazuli batch dispatch requires ${preparedLanes.length} workgroups, beyond u32=${LAZULI_NO_INDEX} or maxComputeWorkgroupsPerDimension=${maximumWorkgroups}`,
      );
    }

    let totalNodes = 0;
    let totalDefinitions = 0;
    let totalConstructors = 0;
    let totalHeapSlots = 0;
    let totalStackFrames = 0;
    let totalGlobals = 0;
    let totalInputs = 0;
    let totalResultNodes = 0;
    const lanes: BatchEvaluationLane[] = preparedLanes.map((lane) => {
      const batchLane: BatchEvaluationLane = {
        ...lane,
        node: totalNodes,
        definition: totalDefinitions,
        constructor: totalConstructors,
        heap: totalHeapSlots,
        stack: totalStackFrames,
        global: totalGlobals,
        input: totalInputs,
        result: totalResultNodes,
      };
      totalNodes = checkedAggregateCount(
        "node",
        totalNodes,
        lane.module.nodeCount,
        lane.resultIndex,
      );
      totalDefinitions = checkedAggregateCount(
        "definition",
        totalDefinitions,
        lane.module.definitionCount,
        lane.resultIndex,
      );
      totalConstructors = checkedAggregateCount(
        "constructor",
        totalConstructors,
        lane.module.constructorCount,
        lane.resultIndex,
      );
      totalHeapSlots = checkedAggregateCount(
        "heap slot",
        totalHeapSlots,
        lane.limits.heapSlots,
        lane.resultIndex,
      );
      totalStackFrames = checkedAggregateCount(
        "stack frame",
        totalStackFrames,
        lane.limits.stackFrames,
        lane.resultIndex,
      );
      totalGlobals = checkedAggregateCount(
        "global thunk",
        totalGlobals,
        lane.module.definitionCount,
        lane.resultIndex,
      );
      totalInputs = checkedAggregateCount(
        "input node",
        totalInputs,
        lane.encodedInput?.nodeCount ?? 0,
        lane.resultIndex,
      );
      totalResultNodes = checkedAggregateCount(
        "result node",
        totalResultNodes,
        lane.limits.resultNodes,
        lane.resultIndex,
      );
      return batchLane;
    });

    const maximumBufferByteLength = this.#device.limits.maxBufferSize;
    const maximumBindingByteLength = this.#device.limits.maxStorageBufferBindingSize;
    const nodeByteLength = checkedAggregateByteLength(
      "nodes",
      totalNodes,
      LAZULI_NODE_BYTE_LENGTH,
      0,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );
    const definitionByteLength = checkedAggregateByteLength(
      "definitions",
      totalDefinitions,
      LAZULI_DEFINITION_BYTE_LENGTH,
      0,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );
    const constructorByteLength = checkedAggregateByteLength(
      "constructors",
      totalConstructors,
      LAZULI_CONSTRUCTOR_BYTE_LENGTH,
      LAZULI_CONSTRUCTOR_BYTE_LENGTH,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );
    const heapByteLength = checkedAggregateByteLength(
      "heap",
      totalHeapSlots,
      HEAP_SLOT_BYTE_LENGTH,
      0,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );
    const stackByteLength = checkedAggregateByteLength(
      "continuation stack",
      totalStackFrames,
      STACK_FRAME_BYTE_LENGTH,
      0,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );
    const globalByteLength = checkedAggregateByteLength(
      "global thunks",
      totalGlobals,
      Uint32Array.BYTES_PER_ELEMENT,
      0,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );
    const stateByteLength = checkedAggregateByteLength(
      "evaluation states",
      lanes.length,
      EVALUATION_STATE_BYTE_LENGTH,
      0,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );
    const resultByteLength = checkedAggregateByteLength(
      "deep result nodes",
      totalResultNodes,
      RESULT_NODE_BYTE_LENGTH,
      RESULT_NODE_BYTE_LENGTH,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );
    const valueByteLength = checkedAggregateByteLength(
      "input and result nodes",
      totalInputs + totalResultNodes,
      INPUT_NODE_BYTE_LENGTH,
      INPUT_NODE_BYTE_LENGTH,
      maximumBufferByteLength,
      maximumBindingByteLength,
    );

    const aggregateInputWords = new Uint32Array(valueByteLength / Uint32Array.BYTES_PER_ELEMENT);
    for (const lane of lanes) {
      if (lane.encodedInput !== undefined) {
        aggregateInputWords.set(lane.encodedInput.words, lane.input * 4);
      }
    }

    const initialStates = new Uint8Array(stateByteLength);
    for (const [laneIndex, lane] of lanes.entries()) {
      initialStates.set(
        new Uint8Array(
          createInitialEvaluationState(lane.module, lane.limits, lane.encodedInput, {
            ...lane,
            result: totalInputs + lane.result,
          }),
        ),
        laneIndex * EVALUATION_STATE_BYTE_LENGTH,
      );
    }

    let nodeBuffer: GPUBuffer | undefined;
    let definitionBuffer: GPUBuffer | undefined;
    let constructorBuffer: GPUBuffer | undefined;
    let heapBuffer: GPUBuffer | undefined;
    let stackBuffer: GPUBuffer | undefined;
    let globalBuffer: GPUBuffer | undefined;
    let stateBuffer: GPUBuffer | undefined;
    let stateReadbackBuffer: GPUBuffer | undefined;
    let inputBuffer: GPUBuffer | undefined;
    let resultReadbackBuffer: GPUBuffer | undefined;
    let stateReadbackMapped = false;

    try {
      let bindGroup: GPUBindGroup;
      this.#device.pushErrorScope("validation");
      let setupValidation: Promise<GPUError | null>;
      try {
        nodeBuffer = this.#device.createBuffer({
          label: "Lazuli batch nodes",
          size: nodeByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        definitionBuffer = this.#device.createBuffer({
          label: "Lazuli batch definitions",
          size: definitionByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        constructorBuffer = this.#device.createBuffer({
          label: "Lazuli batch constructors",
          size: constructorByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
        });
        heapBuffer = this.#device.createBuffer({
          label: "Lazuli batch heaps",
          size: heapByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        stackBuffer = this.#device.createBuffer({
          label: "Lazuli batch continuation stacks",
          size: stackByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        globalBuffer = this.#device.createBuffer({
          label: "Lazuli batch global thunks",
          size: globalByteLength,
          usage: GPUBufferUsage.STORAGE,
        });
        stateBuffer = this.#device.createBuffer({
          label: "Lazuli batch evaluation states",
          size: stateByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        stateReadbackBuffer = this.#device.createBuffer({
          label: "Lazuli batch evaluation state readback",
          size: stateByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        inputBuffer = this.#device.createBuffer({
          label: "Lazuli batch values",
          size: valueByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
        });
        resultReadbackBuffer = this.#device.createBuffer({
          label: "Lazuli batch deep result readback",
          size: resultByteLength,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        this.#device.queue.writeBuffer(stateBuffer, 0, initialStates);
        if (totalInputs > 0) {
          this.#device.queue.writeBuffer(inputBuffer, 0, aggregateInputWords);
        }

        bindGroup = this.#device.createBindGroup({
          label: "Lazuli batch evaluator bindings",
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: nodeBuffer } },
            { binding: 1, resource: { buffer: definitionBuffer } },
            { binding: 2, resource: { buffer: heapBuffer } },
            { binding: 3, resource: { buffer: stackBuffer } },
            { binding: 4, resource: { buffer: globalBuffer } },
            { binding: 5, resource: { buffer: stateBuffer } },
            { binding: 6, resource: { buffer: constructorBuffer } },
            { binding: 7, resource: { buffer: inputBuffer } },
          ],
        });
        setupValidation = this.#device.popErrorScope();
      } catch (cause) {
        const validationError = await this.#device.popErrorScope();
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli batch evaluation setup for ${lanes.length} lanes: ${validationError.message}`,
            { cause },
          );
        }
        throw cause;
      }

      const setupValidationError = await setupValidation;
      if (setupValidationError !== null) {
        throw new Error(
          `WebGPU rejected Lazuli batch evaluation setup for ${lanes.length} lanes: ${setupValidationError.message}`,
        );
      }

      const previousSteps = new Uint32Array(lanes.length);
      const terminalStates: (Uint32Array | undefined)[] = new Array(lanes.length);
      const terminalSnapshots: (EvaluationSnapshot | undefined)[] = new Array(lanes.length);
      let terminalLaneCount = 0;
      let moduleBuffersCopied = false;
      while (true) {
        options.signal?.throwIfAborted();
        this.#device.pushErrorScope("validation");
        let dispatchValidation: Promise<GPUError | null>;
        try {
          const commandEncoder = this.#device.createCommandEncoder({
            label: "Lazuli batch evaluation commands",
          });
          if (!moduleBuffersCopied) {
            for (const lane of lanes) {
              commandEncoder.copyBufferToBuffer(
                lane.module.nodeBuffer,
                0,
                nodeBuffer,
                lane.node * LAZULI_NODE_BYTE_LENGTH,
                lane.buffers.nodeByteLength,
              );
              commandEncoder.copyBufferToBuffer(
                lane.module.definitionBuffer,
                0,
                definitionBuffer,
                lane.definition * LAZULI_DEFINITION_BYTE_LENGTH,
                lane.buffers.definitionByteLength,
              );
              if (lane.buffers.constructorByteLength > 0) {
                commandEncoder.copyBufferToBuffer(
                  lane.module.constructorBuffer,
                  0,
                  constructorBuffer,
                  lane.constructor * LAZULI_CONSTRUCTOR_BYTE_LENGTH,
                  lane.buffers.constructorByteLength,
                );
              }
            }
          }
          const computePass = commandEncoder.beginComputePass({
            label: "Evaluate Lazuli batch",
          });
          computePass.setPipeline(this.#pipeline);
          computePass.setBindGroup(0, bindGroup);
          computePass.dispatchWorkgroups(lanes.length);
          computePass.end();
          commandEncoder.copyBufferToBuffer(
            stateBuffer,
            0,
            stateReadbackBuffer,
            0,
            stateByteLength,
          );
          options.signal?.throwIfAborted();
          this.#device.queue.submit([commandEncoder.finish()]);
          moduleBuffersCopied = true;
          dispatchValidation = this.#device.popErrorScope();
        } catch (cause) {
          const validationError = await this.#device.popErrorScope();
          if (validationError !== null) {
            throw new Error(
              `WebGPU rejected Lazuli batch evaluation for ${lanes.length} lanes: ${validationError.message}`,
              { cause },
            );
          }
          throw cause;
        }

        const validationError = await dispatchValidation;
        if (validationError !== null) {
          throw new Error(
            `WebGPU rejected Lazuli batch evaluation for ${lanes.length} lanes: ${validationError.message}`,
          );
        }

        try {
          await stateReadbackBuffer.mapAsync(GPUMapMode.READ);
        } catch (cause) {
          throw new Error(
            `could not read GPU Lazuli batch evaluation status for ${lanes.length} lanes`,
            { cause },
          );
        }
        stateReadbackMapped = true;
        const snapshotBytes = stateReadbackBuffer.getMappedRange().slice(0);
        stateReadbackBuffer.unmap();
        stateReadbackMapped = false;
        options.signal?.throwIfAborted();

        const snapshotView = new DataView(snapshotBytes);
        for (const [laneIndex, lane] of lanes.entries()) {
          const stateByteOffset = laneIndex * EVALUATION_STATE_BYTE_LENGTH;
          const terminalState = terminalStates[laneIndex];
          if (terminalState !== undefined) {
            for (const [word, expectedWord] of terminalState.entries()) {
              const currentWord = snapshotView.getUint32(
                stateByteOffset + word * Uint32Array.BYTES_PER_ELEMENT,
                true,
              );
              if (currentWord !== expectedWord) {
                throw new Error(
                  `GPU Lazuli evaluator changed terminal batch lane ${lane.resultIndex}: word=${word}, previous=${expectedWord}, current=${currentWord}`,
                );
              }
            }
            continue;
          }

          const snapshot = readEvaluationSnapshot(snapshotView, stateByteOffset);
          assertConsistentEvaluationCounters(
            snapshot,
            lane.limits,
            lane.module,
            ` for batch lane ${lane.resultIndex}`,
          );
          const previousStepCount = previousSteps[laneIndex];
          if (previousStepCount === undefined) {
            throw new Error(`Lazuli batch has no step counter for lane ${lane.resultIndex}`);
          }
          const dispatchSteps = snapshot.stats.steps - previousStepCount;
          if (dispatchSteps < 1 || dispatchSteps > lane.limits.maximumStepsPerDispatch) {
            throw new Error(
              `GPU Lazuli evaluator returned invalid dispatch progress for batch lane ${lane.resultIndex}: previousSteps=${previousStepCount}, steps=${snapshot.stats.steps}, maximumStepsPerDispatch=${lane.limits.maximumStepsPerDispatch}`,
            );
          }

          if (snapshot.status === STATUS_PENDING) {
            if (
              snapshot.faultCode !== 0 ||
              snapshot.faultSourceOffset !== LAZULI_NO_INDEX ||
              snapshot.faultDetail !== 0 || snapshot.stats.steps >= lane.limits.maximumSteps
            ) {
              throw new Error(
                `GPU Lazuli evaluator returned inconsistent pending state for batch lane ${lane.resultIndex}: fault=${snapshot.faultCode}, source=${snapshot.faultSourceOffset}, detail=${snapshot.faultDetail}, steps=${snapshot.stats.steps}`,
              );
            }
            previousSteps[laneIndex] = snapshot.stats.steps;
            continue;
          }

          if (snapshot.status === STATUS_COMPLETE) {
            if (
              snapshot.faultCode !== 0 ||
              snapshot.faultSourceOffset !== LAZULI_NO_INDEX ||
              snapshot.stackTop !== 0
            ) {
              throw new Error(
                `GPU Lazuli evaluator returned inconsistent success state for batch lane ${lane.resultIndex}: fault=${snapshot.faultCode}, source=${snapshot.faultSourceOffset}, stackTop=${snapshot.stackTop}`,
              );
            }
            results[lane.resultIndex] = {
              ok: true,
              value: lane.limits.deepResult
                ? { kind: "closure" }
                : decodeValue(snapshot.valueTag, snapshot.valuePayload, lane.module),
              stats: snapshot.stats,
            };
          } else if (snapshot.status === STATUS_FAULT) {
            results[lane.resultIndex] = {
              ok: false,
              fault: decodeFault(snapshot, lane.limits, lane.module),
              stats: snapshot.stats,
            };
          } else {
            throw new Error(
              `GPU Lazuli evaluator returned unknown status ${snapshot.status} for batch lane ${lane.resultIndex}`,
            );
          }

          const completedState = new Uint32Array(EVALUATION_STATE_WORD_LENGTH);
          for (let word = 0; word < EVALUATION_STATE_WORD_LENGTH; word++) {
            completedState[word] = snapshotView.getUint32(
              stateByteOffset + word * Uint32Array.BYTES_PER_ELEMENT,
              true,
            );
          }
          terminalStates[laneIndex] = completedState;
          terminalSnapshots[laneIndex] = snapshot;
          terminalLaneCount++;
        }

        if (terminalLaneCount === lanes.length) {
          if (options.resultForm === "deep") {
            const commandEncoder = this.#device.createCommandEncoder({
              label: "Read Lazuli batch deep results",
            });
            commandEncoder.copyBufferToBuffer(
              inputBuffer,
              totalInputs * INPUT_NODE_BYTE_LENGTH,
              resultReadbackBuffer,
              0,
              resultByteLength,
            );
            this.#device.queue.submit([commandEncoder.finish()]);
            await resultReadbackBuffer.mapAsync(GPUMapMode.READ);
            const resultBytes = resultReadbackBuffer.getMappedRange().slice(0);
            resultReadbackBuffer.unmap();
            for (const [laneIndex, lane] of lanes.entries()) {
              const snapshot = terminalSnapshots[laneIndex];
              const result = results[lane.resultIndex];
              if (snapshot === undefined || result === undefined || !result.ok) continue;
              const laneStart = lane.result * RESULT_NODE_BYTE_LENGTH;
              const laneEnd = laneStart + snapshot.resultTop * RESULT_NODE_BYTE_LENGTH;
              results[lane.resultIndex] = {
                ok: true,
                value: decodeDeepValue(
                  resultBytes.slice(laneStart, laneEnd),
                  snapshot.resultTop,
                  lane.module,
                  lane.outputType,
                  this.#enableCollectionSyntax,
                ),
                stats: snapshot.stats,
              };
            }
          }
          return completedBatchResults(results);
        }
      }
    } finally {
      if (stateReadbackMapped) {
        stateReadbackBuffer?.unmap();
      }
      nodeBuffer?.destroy();
      definitionBuffer?.destroy();
      constructorBuffer?.destroy();
      heapBuffer?.destroy();
      stackBuffer?.destroy();
      globalBuffer?.destroy();
      stateBuffer?.destroy();
      stateReadbackBuffer?.destroy();
      inputBuffer?.destroy();
      resultReadbackBuffer?.destroy();
    }
  }
}
