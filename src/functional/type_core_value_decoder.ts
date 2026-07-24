import type { FunctionalDeepValue } from "./evaluator.ts";
import { TypeCoreRuntimeConstructor } from "./type_core_runtime.ts";
import type { TypeCoreKind, TypeCoreType, TypeCoreValue } from "./type_core_contract.ts";

type DecodeCategory = "value" | "type" | "list";

interface DecodeFrame {
  readonly category: DecodeCategory;
  readonly node: FunctionalDeepValue;
  readonly expanded: boolean;
}

interface DecodedListCell {
  readonly head: TypeCoreValue;
  readonly tail: DecodedList;
}

type DecodedList = DecodedListCell | null;

export function decodeTypeCoreValue(
  root: FunctionalDeepValue,
  symbolValues: readonly string[],
  expectedKind: TypeCoreKind,
): TypeCoreValue {
  const values = new WeakMap<object, TypeCoreValue>();
  const types = new WeakMap<object, TypeCoreType>();
  const lists = new WeakMap<object, DecodedList>();
  const frames: DecodeFrame[] = [{ category: "value", node: root, expanded: false }];

  while (frames.length > 0) {
    const frame = frames.pop();
    if (frame === undefined) throw new Error("Type Core decoder lost its pending frame");
    if (!frame.expanded) {
      validateAndSchedule(frame, frames);
      continue;
    }
    finishFrame(frame, symbolValues, values, types, lists);
  }

  const value = requiredDecoded(values, root, "root value");
  if (value.kind !== expectedKind) {
    throw new Error(
      `Type Core GPU result has kind ${value.kind}; validated entry requires ${expectedKind}`,
    );
  }
  return value;
}

function validateAndSchedule(frame: DecodeFrame, frames: DecodeFrame[]): void {
  const constructor = requireConstructor(frame.node, frame.category);
  frames.push({ ...frame, expanded: true });
  switch (frame.category) {
    case "value":
      switch (constructor.name) {
        case TypeCoreRuntimeConstructor.ValueType:
          requireArity(constructor, 1, frame.category);
          frames.push({ category: "type", node: requiredField(constructor, 0), expanded: false });
          return;
        case TypeCoreRuntimeConstructor.ValueInteger:
        case TypeCoreRuntimeConstructor.ValueBoolean:
        case TypeCoreRuntimeConstructor.ValueSymbol:
          requireArity(constructor, 1, frame.category);
          return;
        default:
          throw unexpectedConstructor(constructor.name, frame.category);
      }
      return;
    case "type":
      switch (constructor.name) {
        case TypeCoreRuntimeConstructor.TypeInteger:
        case TypeCoreRuntimeConstructor.TypeBoolean:
        case TypeCoreRuntimeConstructor.TypeUnit:
          requireArity(constructor, 0, frame.category);
          return;
        case TypeCoreRuntimeConstructor.TypeNamed:
          requireArity(constructor, 2, frame.category);
          frames.push({ category: "list", node: requiredField(constructor, 1), expanded: false });
          return;
        case TypeCoreRuntimeConstructor.TypeTuple:
        case TypeCoreRuntimeConstructor.TypeFunction:
          requireArity(constructor, 2, frame.category);
          frames.push({ category: "type", node: requiredField(constructor, 1), expanded: false });
          frames.push({ category: "type", node: requiredField(constructor, 0), expanded: false });
          return;
        default:
          throw unexpectedConstructor(constructor.name, frame.category);
      }
      return;
    case "list":
      switch (constructor.name) {
        case TypeCoreRuntimeConstructor.ListNil:
          requireArity(constructor, 0, frame.category);
          return;
        case TypeCoreRuntimeConstructor.ListCons:
          requireArity(constructor, 2, frame.category);
          frames.push({ category: "list", node: requiredField(constructor, 1), expanded: false });
          frames.push({ category: "value", node: requiredField(constructor, 0), expanded: false });
          return;
        default:
          throw unexpectedConstructor(constructor.name, frame.category);
      }
  }
}

function finishFrame(
  frame: DecodeFrame,
  symbolValues: readonly string[],
  values: WeakMap<object, TypeCoreValue>,
  types: WeakMap<object, TypeCoreType>,
  lists: WeakMap<object, DecodedList>,
): void {
  const constructor = requireConstructor(frame.node, frame.category);
  switch (frame.category) {
    case "value":
      values.set(frame.node, decodeValue(constructor, symbolValues, types));
      return;
    case "type":
      types.set(frame.node, decodeType(constructor, symbolValues, types, lists));
      return;
    case "list":
      lists.set(frame.node, decodeList(constructor, values, lists));
      return;
  }
}

function decodeValue(
  constructor: FunctionalConstructor,
  symbolValues: readonly string[],
  types: WeakMap<object, TypeCoreType>,
): TypeCoreValue {
  switch (constructor.name) {
    case TypeCoreRuntimeConstructor.ValueType:
      return Object.freeze({
        kind: "type",
        type: requiredDecoded(types, requiredField(constructor, 0), "type value"),
      });
    case TypeCoreRuntimeConstructor.ValueInteger:
      return Object.freeze({ kind: "integer", value: requireInteger(constructor, 0) });
    case TypeCoreRuntimeConstructor.ValueBoolean:
      return Object.freeze({ kind: "boolean", value: requireBoolean(constructor, 0) });
    case TypeCoreRuntimeConstructor.ValueSymbol:
      return Object.freeze({
        kind: "symbol",
        value: requireSymbol(symbolValues, requireInteger(constructor, 0)),
      });
    default:
      throw unexpectedConstructor(constructor.name, "value");
  }
}

function decodeType(
  constructor: FunctionalConstructor,
  symbolValues: readonly string[],
  types: WeakMap<object, TypeCoreType>,
  lists: WeakMap<object, DecodedList>,
): TypeCoreType {
  switch (constructor.name) {
    case TypeCoreRuntimeConstructor.TypeInteger:
      return Object.freeze({ kind: "integer" });
    case TypeCoreRuntimeConstructor.TypeBoolean:
      return Object.freeze({ kind: "boolean" });
    case TypeCoreRuntimeConstructor.TypeUnit:
      return Object.freeze({ kind: "unit" });
    case TypeCoreRuntimeConstructor.TypeNamed: {
      const arguments_: TypeCoreValue[] = [];
      let list = requiredDecoded(lists, requiredField(constructor, 1), "named type arguments");
      while (list !== null) {
        arguments_.push(list.head);
        list = list.tail;
      }
      return Object.freeze({
        kind: "named",
        name: requireSymbol(symbolValues, requireInteger(constructor, 0)),
        arguments: Object.freeze(arguments_),
      });
    }
    case TypeCoreRuntimeConstructor.TypeTuple:
      return Object.freeze({
        kind: "tuple",
        values: Object.freeze([
          requiredDecoded(types, requiredField(constructor, 0), "tuple first type"),
          requiredDecoded(types, requiredField(constructor, 1), "tuple second type"),
        ]) as readonly [TypeCoreType, TypeCoreType],
      });
    case TypeCoreRuntimeConstructor.TypeFunction:
      return Object.freeze({
        kind: "function",
        parameter: requiredDecoded(types, requiredField(constructor, 0), "function parameter type"),
        result: requiredDecoded(types, requiredField(constructor, 1), "function result type"),
      });
    default:
      throw unexpectedConstructor(constructor.name, "type");
  }
}

function decodeList(
  constructor: FunctionalConstructor,
  values: WeakMap<object, TypeCoreValue>,
  lists: WeakMap<object, DecodedList>,
): DecodedList {
  switch (constructor.name) {
    case TypeCoreRuntimeConstructor.ListNil:
      return null;
    case TypeCoreRuntimeConstructor.ListCons:
      return Object.freeze({
        head: requiredDecoded(values, requiredField(constructor, 0), "type argument"),
        tail: requiredDecoded(lists, requiredField(constructor, 1), "type argument list tail"),
      });
    default:
      throw unexpectedConstructor(constructor.name, "list");
  }
}

type FunctionalConstructor = Extract<FunctionalDeepValue, { readonly kind: "constructor" }>;

function requireConstructor(
  value: FunctionalDeepValue,
  category: DecodeCategory,
): FunctionalConstructor {
  if (value.kind !== "constructor") {
    throw new Error(
      `Type Core GPU ${category} representation requires a constructor; received ${value.kind}`,
    );
  }
  if (value.fieldCount !== value.fields.length) {
    throw new Error(
      `Type Core GPU constructor ${
        JSON.stringify(value.name)
      } reports ${value.fieldCount} fields but returned ${value.fields.length}`,
    );
  }
  return value;
}

function requireArity(
  constructor: FunctionalConstructor,
  expected: number,
  category: DecodeCategory,
): void {
  if (constructor.fields.length !== expected) {
    throw new Error(
      `Type Core GPU ${category} constructor ${
        JSON.stringify(constructor.name)
      } has ${constructor.fields.length} fields; expected ${expected}`,
    );
  }
}

function requiredField(
  constructor: FunctionalConstructor,
  index: number,
): FunctionalDeepValue {
  const field = constructor.fields[index];
  if (field === undefined) {
    throw new Error(
      `Type Core GPU constructor ${JSON.stringify(constructor.name)} omitted field ${index}`,
    );
  }
  return field;
}

function requireInteger(constructor: FunctionalConstructor, fieldIndex: number): number {
  const field = requiredField(constructor, fieldIndex);
  if (field.kind !== "integer") {
    throw new Error(
      `Type Core GPU constructor ${
        JSON.stringify(constructor.name)
      } field ${fieldIndex} requires integer; received ${field.kind}`,
    );
  }
  return field.value;
}

function requireBoolean(constructor: FunctionalConstructor, fieldIndex: number): boolean {
  const field = requiredField(constructor, fieldIndex);
  if (field.kind !== "boolean") {
    throw new Error(
      `Type Core GPU constructor ${
        JSON.stringify(constructor.name)
      } field ${fieldIndex} requires Boolean; received ${field.kind}`,
    );
  }
  return field.value;
}

function requireSymbol(symbolValues: readonly string[], symbolIndex: number): string {
  const value = symbolValues[symbolIndex];
  if (value === undefined) {
    throw new Error(
      `Type Core GPU result references symbol ${symbolIndex}; table contains ${symbolValues.length}`,
    );
  }
  return value;
}

function requiredDecoded<Value>(
  decoded: WeakMap<object, Value>,
  node: FunctionalDeepValue,
  location: string,
): Value {
  const value = decoded.get(node);
  if (value === undefined) {
    throw new Error(`Type Core GPU result omitted decoded ${location}`);
  }
  return value;
}

function unexpectedConstructor(name: string, category: DecodeCategory): Error {
  return new Error(
    `Type Core GPU ${category} representation uses unexpected constructor ${JSON.stringify(name)}`,
  );
}
