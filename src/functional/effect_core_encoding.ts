import {
  FUNCTIONAL_MAXIMUM_EXPRESSION_NODES,
  type FunctionalSpan,
  type FunctionalTypeSchema,
} from "./abi.ts";
import type {
  FunctionalEffectCoreExpression,
  FunctionalEffectCoreModule,
} from "./effect_core_contract.ts";
import {
  FUNCTIONAL_EFFECT_CORE_NO_INDEX,
  FUNCTIONAL_EFFECT_CORE_NODE_WORD_LENGTH,
  FUNCTIONAL_EFFECT_CORE_OPERATION_WORD_LENGTH,
  FUNCTIONAL_EFFECT_CORE_PURE,
  FunctionalEffectCoreOperationKind,
  FunctionalEffectCoreOperationWord,
  FunctionalEffectCoreTag,
} from "./effect_core_shader.ts";
import {
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostType,
  normalizeFunctionalHostCapabilities,
} from "./host_contract.ts";

const MAXIMUM_EFFECT_CORE_OPERATIONS = 32;

export interface PreparedOperation {
  readonly key: string;
  readonly kind: "local" | "host";
  readonly parameter: FunctionalHostType;
  readonly result: FunctionalHostType;
  readonly effectBit: number | null;
  readonly host?: {
    readonly binder: string;
  };
}

export interface PreparedEffectCore {
  readonly module: FunctionalEffectCoreModule;
  readonly hostCapabilities: readonly FunctionalHostCapabilityDeclaration[];
  readonly nodeWords: Uint32Array;
  readonly operations: readonly PreparedOperation[];
  readonly operationWords: Uint32Array;
  readonly expressions: readonly FunctionalEffectCoreExpression[];
  readonly rootNode: number;
  readonly effectNames: readonly string[];
  readonly types: readonly FunctionalHostType[];
}

export function prepareFunctionalEffectCore(
  module: FunctionalEffectCoreModule,
): PreparedEffectCore {
  requireName(module.entryName, "entry name");
  if (!Number.isSafeInteger(module.sourceByteLength) || module.sourceByteLength < 0) {
    throw new RangeError(
      `Functional Effect Core source byte length must be non-negative; received ${module.sourceByteLength}`,
    );
  }
  const hostCapabilities = normalizeFunctionalHostCapabilities(module.hostCapabilities);
  const types = new EffectCoreTypeTable();
  const operations: PreparedOperation[] = [];
  const localOperations = new Map<string, number>();
  const hostOperations = new Map<string, number>();
  const effectNames: string[] = [];

  for (const [operationIndex, operation] of module.operations.entries()) {
    requireName(operation.effect, `local operation ${operationIndex} effect`);
    requireName(operation.name, `local operation ${operationIndex} name`);
    const key = operationKey(operation.effect, operation.name);
    if (localOperations.has(key)) {
      throw new Error(`Functional Effect Core repeats local operation ${JSON.stringify(key)}`);
    }
    const parameter = requireEffectType(operation.parameter, `${key} parameter`);
    const result = requireEffectType(operation.result, `${key} result`);
    const effectBit = reserveEffectBit(effectNames, key);
    localOperations.set(key, operations.length);
    operations.push({ key, kind: "local", parameter, result, effectBit });
  }

  let hostFieldIndex = 0;
  for (const capability of hostCapabilities) {
    for (const field of capability.fields) {
      const binder = `$FunctionalHostField${hostFieldIndex}`;
      hostFieldIndex += 1;
      if (field.kind !== "operation") continue;
      const key = operationKey(capability.name, field.name);
      if (localOperations.has(key)) {
        throw new Error(
          `Functional Effect Core host operation ${
            JSON.stringify(key)
          } conflicts with a local operation`,
        );
      }
      if (hostOperations.has(key)) {
        throw new Error(`Functional Effect Core repeats host operation ${JSON.stringify(key)}`);
      }
      const effectBit = field.purity === "effectful" ? reserveEffectBit(effectNames, key) : null;
      hostOperations.set(key, operations.length);
      operations.push({
        key,
        kind: "host",
        parameter: requireEffectType(field.parameter, `${key} parameter`),
        result: requireEffectType(field.result, `${key} result`),
        effectBit,
        host: { binder },
      });
    }
  }

  const operationWords = new Uint32Array(
    operations.length * FUNCTIONAL_EFFECT_CORE_OPERATION_WORD_LENGTH,
  );
  for (const [index, operation] of operations.entries()) {
    const base = index * FUNCTIONAL_EFFECT_CORE_OPERATION_WORD_LENGTH;
    operationWords[base + FunctionalEffectCoreOperationWord.ParameterType] = types.id(
      operation.parameter,
    );
    operationWords[base + FunctionalEffectCoreOperationWord.ResultType] = types.id(
      operation.result,
    );
    operationWords[base + FunctionalEffectCoreOperationWord.EffectBit] = operation.effectBit ??
      FUNCTIONAL_EFFECT_CORE_PURE;
    operationWords[base + FunctionalEffectCoreOperationWord.Kind] = operation.kind === "host"
      ? FunctionalEffectCoreOperationKind.Host
      : FunctionalEffectCoreOperationKind.Local;
  }

  const expressions: FunctionalEffectCoreExpression[] = [];
  const words: number[] = [];
  const emitted = new WeakMap<object, number>();
  const emit = (expression: FunctionalEffectCoreExpression): number => {
    if (expression === null || typeof expression !== "object") {
      throw new TypeError(
        `Functional Effect Core expression must be an object; received ${
          JSON.stringify(expression)
        }`,
      );
    }
    const existing = emitted.get(expression);
    if (existing !== undefined) return existing;
    if (expressions.length >= FUNCTIONAL_MAXIMUM_EXPRESSION_NODES) {
      throw new RangeError(
        `Functional Effect Core exceeds ${FUNCTIONAL_MAXIMUM_EXPRESSION_NODES} computation nodes`,
      );
    }
    const node = expressions.length;
    const span = expression.span ?? { startByte: 0, endByte: 0 };
    if (
      !Number.isSafeInteger(span.startByte) || !Number.isSafeInteger(span.endByte) ||
      span.startByte < 0 || span.startByte > span.endByte ||
      span.endByte > module.sourceByteLength
    ) {
      throw new RangeError(
        `Functional Effect Core node ${node} has invalid source span ${span.startByte}..${span.endByte}; source length is ${module.sourceByteLength}`,
      );
    }
    emitted.set(expression, node);
    expressions.push(expression);
    words.push(
      0,
      0,
      FUNCTIONAL_EFFECT_CORE_NO_INDEX,
      FUNCTIONAL_EFFECT_CORE_NO_INDEX,
      0,
      0,
      span.startByte,
      span.endByte,
    );
    const base = node * FUNCTIONAL_EFFECT_CORE_NODE_WORD_LENGTH;
    switch (expression.kind) {
      case "return":
        words[base] = FunctionalEffectCoreTag.Return;
        words[base + 4] = types.id(expression.valueType);
        break;
      case "host-call": {
        const operation = requiredOperation(
          hostOperations,
          operationKey(expression.capability, expression.operation),
          "host",
        );
        words[base] = FunctionalEffectCoreTag.HostCall;
        words[base + 1] = operation;
        words[base + 4] = types.id(expression.argumentType);
        break;
      }
      case "perform": {
        const operation = requiredOperation(
          localOperations,
          operationKey(expression.effect, expression.operation),
          "local",
        );
        words[base] = FunctionalEffectCoreTag.Perform;
        words[base + 1] = operation;
        words[base + 4] = types.id(expression.argumentType);
        break;
      }
      case "bind":
        requireName(expression.name, `bind at node ${node}`);
        words[base] = FunctionalEffectCoreTag.Bind;
        words[base + 2] = emit(expression.computation);
        words[base + 3] = emit(expression.body);
        break;
      case "branch":
        words[base] = FunctionalEffectCoreTag.Branch;
        words[base + 2] = emit(expression.consequent);
        words[base + 3] = emit(expression.alternate);
        words[base + 4] = types.id(expression.conditionType);
        break;
      case "handle": {
        const operation = requiredOperation(
          localOperations,
          operationKey(expression.effect, expression.operation),
          "handled local",
        );
        words[base] = FunctionalEffectCoreTag.Handle;
        words[base + 1] = operation;
        words[base + 2] = emit(expression.computation);
        break;
      }
      default:
        throw new Error(
          `Functional Effect Core node ${node} has unsupported kind ${
            JSON.stringify((expression as { kind?: unknown }).kind)
          }`,
        );
    }
    return node;
  };
  const rootNode = emit(module.expression);
  return {
    module,
    hostCapabilities,
    nodeWords: Uint32Array.from(words),
    operations: Object.freeze(operations),
    operationWords,
    expressions: Object.freeze(expressions),
    rootNode,
    effectNames: Object.freeze(effectNames),
    types: types.values,
  };
}

export function expressionSpan(
  expression: FunctionalEffectCoreExpression | undefined,
  sourceByteLength: number,
): FunctionalSpan {
  return expression?.span ?? { startByte: 0, endByte: sourceByteLength };
}

export function scalarTypeFromTag(
  prepared: PreparedEffectCore,
  tag: number,
): FunctionalHostType {
  const type = prepared.types[tag - 1];
  if (type !== undefined) return type;
  throw new Error(`GPU Functional Effect Core verifier returned unknown type ${tag}`);
}

export function operationKey(owner: string, operation: string): string {
  requireName(owner, "operation owner");
  requireName(operation, "operation name");
  return `${owner}.${operation}`;
}

function requireEffectType(
  schema: FunctionalTypeSchema,
  location: string,
): FunctionalHostType {
  typeKey(schema, location);
  return schema;
}

class EffectCoreTypeTable {
  readonly #ids = new Map<string, number>();
  readonly #values: FunctionalHostType[] = [];

  constructor() {
    this.id({ kind: "integer" });
    this.id({ kind: "boolean" });
    this.id({ kind: "unit" });
  }

  get values(): readonly FunctionalHostType[] {
    return Object.freeze([...this.#values]);
  }

  id(type: FunctionalHostType): number {
    const key = typeKey(type, "type table");
    const existing = this.#ids.get(key);
    if (existing !== undefined) return existing;
    const id = this.#values.length + 1;
    this.#ids.set(key, id);
    this.#values.push(type);
    return id;
  }
}

function typeKey(type: FunctionalTypeSchema, location: string, depth = 0): string {
  if (depth > 64) throw new RangeError(`Functional Effect Core ${location} exceeds type depth 64`);
  switch (type.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return type.kind;
    case "tuple":
      return `tuple(${typeKey(type.values[0], location, depth + 1)},${
        typeKey(type.values[1], location, depth + 1)
      })`;
    case "named":
      return `named(${JSON.stringify(type.name)}:${
        type.arguments.map((argument) => typeKey(argument, location, depth + 1)).join(",")
      })`;
    case "parameter":
    case "function":
    case "forall":
      throw new TypeError(
        `Functional Effect Core ${location} must be a concrete first-order type; received ${type.kind}`,
      );
  }
}

function reserveEffectBit(effectNames: string[], name: string): number {
  if (effectNames.length >= MAXIMUM_EFFECT_CORE_OPERATIONS) {
    throw new RangeError(
      `Functional Effect Core supports at most ${MAXIMUM_EFFECT_CORE_OPERATIONS} effectful operations; ${
        JSON.stringify(name)
      } exceeds that bound`,
    );
  }
  const bit = effectNames.length;
  effectNames.push(name);
  return bit;
}

function requiredOperation(
  operations: ReadonlyMap<string, number>,
  key: string,
  kind: string,
): number {
  const operation = operations.get(key);
  if (operation === undefined) {
    throw new Error(
      `Functional Effect Core references unknown ${kind} operation ${JSON.stringify(key)}`,
    );
  }
  return operation;
}

function requireName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `Functional Effect Core ${location} must be nonempty; received ${JSON.stringify(name)}`,
    );
  }
}
