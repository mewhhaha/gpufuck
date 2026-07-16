import type { TypeCoreExpression, TypeCorePattern, TypeCoreProgram } from "../../functional.ts";

export const ZIG_REFLECTION_RESULT_TYPE = "ReflectionResult";

const FIELD_TYPE = "Field";
const FIELD_LIST_EMPTY_TYPE = "FieldListEmpty";
const FIELD_LIST_NODE_TYPE = "FieldListNode";
const METHOD_TYPE = "Method";
const METHOD_LIST_EMPTY_TYPE = "MethodListEmpty";
const METHOD_LIST_NODE_TYPE = "MethodListNode";
const OBJECT_TYPE = "Object";

export function zigReflectionProgram(requestedMethod = "get"): TypeCoreProgram {
  const wrappedInteger = call("BuildWrapped", [integerType()]);
  return {
    typeConstructors: [
      { name: FIELD_TYPE, parameterKinds: ["symbol", "type"] },
      { name: FIELD_LIST_EMPTY_TYPE, parameterKinds: [] },
      { name: FIELD_LIST_NODE_TYPE, parameterKinds: ["type", "type"] },
      { name: METHOD_TYPE, parameterKinds: ["symbol", "symbol", "type"] },
      { name: METHOD_LIST_EMPTY_TYPE, parameterKinds: [] },
      { name: METHOD_LIST_NODE_TYPE, parameterKinds: ["type", "type"] },
      { name: OBJECT_TYPE, parameterKinds: ["type", "type"] },
      {
        name: ZIG_REFLECTION_RESULT_TYPE,
        parameterKinds: ["type", "integer", "symbol", "type"],
      },
    ],
    functions: [
      buildWrappedFunction(),
      sizeOfFunction(),
      fieldBytesFunction(),
      objectFieldBytesFunction(),
      methodImplementationFunction(),
      methodResultFunction(),
      objectMethodImplementationFunction(),
      objectMethodResultFunction(),
    ],
    entry: namedType(ZIG_REFLECTION_RESULT_TYPE, [
      wrappedInteger,
      call("ObjectFieldBytes", [wrappedInteger]),
      call("ObjectMethodImplementation", [wrappedInteger, symbol(requestedMethod)]),
      call("ObjectMethodResult", [wrappedInteger, symbol(requestedMethod)]),
    ]),
  };
}

function buildWrappedFunction(): TypeCoreProgram["functions"][number] {
  const element = reference("element");
  return {
    name: "BuildWrapped",
    parameters: [{ name: "element", kind: "type" }],
    resultKind: "type",
    body: namedType(OBJECT_TYPE, [
      namedType(FIELD_LIST_NODE_TYPE, [
        namedType(FIELD_TYPE, [symbol("value"), element]),
        namedType(FIELD_LIST_NODE_TYPE, [
          namedType(FIELD_TYPE, [symbol("enabled"), booleanType()]),
          namedType(FIELD_LIST_EMPTY_TYPE),
        ]),
      ]),
      namedType(METHOD_LIST_NODE_TYPE, [
        namedType(METHOD_TYPE, [symbol("get"), symbol("Wrapped.get"), element]),
        namedType(METHOD_LIST_EMPTY_TYPE),
      ]),
    ]),
  };
}

function sizeOfFunction(): TypeCoreProgram["functions"][number] {
  return {
    name: "SizeOf",
    parameters: [{ name: "value", kind: "type" }],
    resultKind: "integer",
    body: {
      kind: "match",
      value: reference("value"),
      arms: [
        { pattern: { kind: "type", type: { kind: "integer" } }, result: integer(4) },
        { pattern: { kind: "type", type: { kind: "boolean" } }, result: integer(1) },
        { pattern: { kind: "type", type: { kind: "unit" } }, result: integer(0) },
      ],
      fallback: integer(-1),
    },
  };
}

function fieldBytesFunction(): TypeCoreProgram["functions"][number] {
  return {
    name: "FieldBytes",
    parameters: [{ name: "fields", kind: "type" }],
    resultKind: "integer",
    body: {
      kind: "match",
      value: reference("fields"),
      arms: [
        {
          pattern: typePattern(FIELD_LIST_EMPTY_TYPE),
          result: integer(0),
        },
        {
          pattern: typePattern(FIELD_LIST_NODE_TYPE, [
            typePattern(FIELD_TYPE, [bind("fieldName"), bind("fieldType")]),
            bind("remainingFields"),
          ]),
          result: {
            kind: "integer-operation",
            operator: "add",
            left: call("SizeOf", [reference("fieldType")]),
            right: call("FieldBytes", [reference("remainingFields")]),
          },
        },
      ],
      fallback: integer(-1),
    },
  };
}

function objectFieldBytesFunction(): TypeCoreProgram["functions"][number] {
  return {
    name: "ObjectFieldBytes",
    parameters: [{ name: "object", kind: "type" }],
    resultKind: "integer",
    body: {
      kind: "match",
      value: reference("object"),
      arms: [{
        pattern: typePattern(OBJECT_TYPE, [bind("fields"), bind("methods")]),
        result: call("FieldBytes", [reference("fields")]),
      }],
      fallback: integer(-1),
    },
  };
}

function methodImplementationFunction(): TypeCoreProgram["functions"][number] {
  return {
    name: "MethodImplementation",
    parameters: [
      { name: "methods", kind: "type" },
      { name: "requestedName", kind: "symbol" },
    ],
    resultKind: "symbol",
    body: {
      kind: "match",
      value: reference("methods"),
      arms: [
        {
          pattern: typePattern(METHOD_LIST_EMPTY_TYPE),
          result: symbol("<missing>"),
        },
        {
          pattern: methodListNodePattern(),
          result: {
            kind: "if",
            condition: {
              kind: "symbol-equal",
              left: reference("methodName"),
              right: reference("requestedName"),
            },
            consequent: reference("implementation"),
            alternate: call("MethodImplementation", [
              reference("remainingMethods"),
              reference("requestedName"),
            ]),
          },
        },
      ],
      fallback: symbol("<invalid-method-table>"),
    },
  };
}

function methodResultFunction(): TypeCoreProgram["functions"][number] {
  return {
    name: "MethodResult",
    parameters: [
      { name: "methods", kind: "type" },
      { name: "requestedName", kind: "symbol" },
    ],
    resultKind: "type",
    body: {
      kind: "match",
      value: reference("methods"),
      arms: [
        {
          pattern: typePattern(METHOD_LIST_EMPTY_TYPE),
          result: { kind: "type", type: { kind: "unit" } },
        },
        {
          pattern: methodListNodePattern(),
          result: {
            kind: "if",
            condition: {
              kind: "symbol-equal",
              left: reference("methodName"),
              right: reference("requestedName"),
            },
            consequent: reference("methodResult"),
            alternate: call("MethodResult", [
              reference("remainingMethods"),
              reference("requestedName"),
            ]),
          },
        },
      ],
      fallback: { kind: "type", type: { kind: "unit" } },
    },
  };
}

function objectMethodImplementationFunction(): TypeCoreProgram["functions"][number] {
  return {
    name: "ObjectMethodImplementation",
    parameters: [
      { name: "object", kind: "type" },
      { name: "requestedName", kind: "symbol" },
    ],
    resultKind: "symbol",
    body: objectMethodLookup("MethodImplementation", symbol("<invalid-object>")),
  };
}

function objectMethodResultFunction(): TypeCoreProgram["functions"][number] {
  return {
    name: "ObjectMethodResult",
    parameters: [
      { name: "object", kind: "type" },
      { name: "requestedName", kind: "symbol" },
    ],
    resultKind: "type",
    body: objectMethodLookup("MethodResult", { kind: "type", type: { kind: "unit" } }),
  };
}

function objectMethodLookup(
  functionName: string,
  fallback: TypeCoreExpression,
): TypeCoreExpression {
  return {
    kind: "match",
    value: reference("object"),
    arms: [{
      pattern: typePattern(OBJECT_TYPE, [bind("fields"), bind("methods")]),
      result: call(functionName, [reference("methods"), reference("requestedName")]),
    }],
    fallback,
  };
}

function methodListNodePattern(): TypeCorePattern {
  return typePattern(METHOD_LIST_NODE_TYPE, [
    typePattern(METHOD_TYPE, [
      bind("methodName"),
      bind("implementation"),
      bind("methodResult"),
    ]),
    bind("remainingMethods"),
  ]);
}

function reference(name: string): TypeCoreExpression {
  return { kind: "reference", name };
}

function integer(value: number): TypeCoreExpression {
  return { kind: "integer", value };
}

function symbol(value: string): TypeCoreExpression {
  return { kind: "symbol", value };
}

function integerType(): TypeCoreExpression {
  return { kind: "type", type: { kind: "integer" } };
}

function booleanType(): TypeCoreExpression {
  return { kind: "type", type: { kind: "boolean" } };
}

function namedType(
  name: string,
  arguments_: readonly TypeCoreExpression[] = [],
): TypeCoreExpression {
  return { kind: "type", type: { kind: "named", name, arguments: arguments_ } };
}

function call(functionName: string, arguments_: readonly TypeCoreExpression[]): TypeCoreExpression {
  return { kind: "call", function: functionName, arguments: arguments_ };
}

function bind(name: string): TypeCorePattern {
  return { kind: "bind", name };
}

function typePattern(
  name: string,
  arguments_: readonly TypeCorePattern[] = [],
): TypeCorePattern {
  return { kind: "type", type: { kind: "named", name, arguments: arguments_ } };
}
