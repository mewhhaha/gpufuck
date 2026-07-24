import type { FunctionalTypeSchema } from "./abi.ts";
import type { FunctionalSurfaceTypeDeclaration } from "./surface_builder.ts";

const TYPE_CORE_TYPE = "$TypeCoreType";
const TYPE_CORE_LIST = "$TypeCoreList";

export const TYPE_CORE_VALUE = "$TypeCoreValue";
export const TYPE_CORE_ENTRY_DEFINITION = "$TypeCoreEntry";

export const TypeCoreRuntimeConstructor = {
  ValueType: "$TypeCoreValueType",
  ValueInteger: "$TypeCoreValueInteger",
  ValueBoolean: "$TypeCoreValueBoolean",
  ValueSymbol: "$TypeCoreValueSymbol",
  TypeInteger: "$TypeCoreTypeInteger",
  TypeBoolean: "$TypeCoreTypeBoolean",
  TypeUnit: "$TypeCoreTypeUnit",
  TypeNamed: "$TypeCoreTypeNamed",
  TypeTuple: "$TypeCoreTypeTuple",
  TypeFunction: "$TypeCoreTypeFunction",
  ListNil: "$TypeCoreListNil",
  ListCons: "$TypeCoreListCons",
} as const;

export function compileValueFunctionType(parameterCount: number): FunctionalTypeSchema {
  let type = namedType(TYPE_CORE_VALUE);
  for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex++) {
    type = { kind: "function", parameter: namedType(TYPE_CORE_VALUE), result: type };
  }
  return type;
}

export function namedType(name: string): FunctionalTypeSchema {
  return { kind: "named", name, arguments: [] };
}

export function typeCoreRuntimeDeclarations(): readonly FunctionalSurfaceTypeDeclaration[] {
  return [
    {
      name: TYPE_CORE_VALUE,
      parameters: [],
      constructors: [
        constructor(TypeCoreRuntimeConstructor.ValueType, [["value", namedType(TYPE_CORE_TYPE)]]),
        constructor(TypeCoreRuntimeConstructor.ValueInteger, [["value", { kind: "integer" }]]),
        constructor(TypeCoreRuntimeConstructor.ValueBoolean, [["value", { kind: "boolean" }]]),
        constructor(TypeCoreRuntimeConstructor.ValueSymbol, [["value", { kind: "integer" }]]),
      ],
    },
    {
      name: TYPE_CORE_TYPE,
      parameters: [],
      constructors: [
        constructor(TypeCoreRuntimeConstructor.TypeInteger),
        constructor(TypeCoreRuntimeConstructor.TypeBoolean),
        constructor(TypeCoreRuntimeConstructor.TypeUnit),
        constructor(TypeCoreRuntimeConstructor.TypeNamed, [
          ["name", { kind: "integer" }],
          ["arguments", namedType(TYPE_CORE_LIST)],
        ]),
        constructor(TypeCoreRuntimeConstructor.TypeTuple, [
          ["first", namedType(TYPE_CORE_TYPE)],
          ["second", namedType(TYPE_CORE_TYPE)],
        ]),
        constructor(TypeCoreRuntimeConstructor.TypeFunction, [
          ["parameter", namedType(TYPE_CORE_TYPE)],
          ["result", namedType(TYPE_CORE_TYPE)],
        ]),
      ],
    },
    {
      name: TYPE_CORE_LIST,
      parameters: [],
      constructors: [
        constructor(TypeCoreRuntimeConstructor.ListNil),
        constructor(TypeCoreRuntimeConstructor.ListCons, [
          ["head", namedType(TYPE_CORE_VALUE)],
          ["tail", namedType(TYPE_CORE_LIST)],
        ]),
      ],
    },
  ];
}

function constructor(
  name: string,
  fields: readonly (readonly [string, FunctionalTypeSchema])[] = [],
): FunctionalSurfaceTypeDeclaration["constructors"][number] {
  return {
    name,
    fields: fields.map(([fieldName, type]) => ({ name: fieldName, type })),
  };
}
