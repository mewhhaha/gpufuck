import type { FunctionalSurfaceTypeDeclaration } from "../../../src/functional/surface_builder.ts";
import {
  FUNCTIONAL_MAXIMUM_STORE_LENGTH,
  functionalStoreType,
} from "../../../src/functional/store_contract.ts";

export const JAVASCRIPT_MAXIMUM_OBJECT_COUNT = FUNCTIONAL_MAXIMUM_STORE_LENGTH;
export const JAVASCRIPT_MAXIMUM_BINDING_COUNT = FUNCTIONAL_MAXIMUM_STORE_LENGTH;

export const JAVASCRIPT_VALUE_TYPE = "$javascript#Value";
export const JAVASCRIPT_VALUE_UNDEFINED = "$javascript#Undefined";
export const JAVASCRIPT_VALUE_NULL = "$javascript#Null";
export const JAVASCRIPT_VALUE_BOOLEAN = "$javascript#Boolean";
export const JAVASCRIPT_VALUE_NUMBER = "$javascript#Number";
export const JAVASCRIPT_VALUE_STRING = "$javascript#String";
export const JAVASCRIPT_VALUE_SYMBOL = "$javascript#Symbol";
export const JAVASCRIPT_VALUE_OBJECT = "$javascript#Object";

export const JAVASCRIPT_PROPERTY_KEY_TYPE = "$javascript#PropertyKey";
export const JAVASCRIPT_PROPERTY_KEY_STRING = "$javascript#StringKey";
export const JAVASCRIPT_PROPERTY_KEY_SYMBOL = "$javascript#SymbolKey";

export const JAVASCRIPT_OBJECT_KIND_TYPE = "$javascript#ObjectKind";
export const JAVASCRIPT_OBJECT_ORDINARY = "$javascript#OrdinaryObject";
export const JAVASCRIPT_OBJECT_CALLABLE = "$javascript#CallableObject";

export const JAVASCRIPT_PROPERTY_DESCRIPTOR_TYPE = "$javascript#PropertyDescriptor";
export const JAVASCRIPT_DATA_DESCRIPTOR = "$javascript#DataDescriptor";
export const JAVASCRIPT_ACCESSOR_DESCRIPTOR = "$javascript#AccessorDescriptor";

export const JAVASCRIPT_DESCRIPTOR_LOOKUP_TYPE = "$javascript#DescriptorLookup";
export const JAVASCRIPT_DESCRIPTOR_MISSING = "$javascript#MissingDescriptor";
export const JAVASCRIPT_DESCRIPTOR_FOUND = "$javascript#FoundDescriptor";

export const JAVASCRIPT_PROPERTY_LIST_TYPE = "$javascript#PropertyList";
export const JAVASCRIPT_PROPERTY_LIST_EMPTY = "$javascript#NoProperties";
export const JAVASCRIPT_DATA_PROPERTY = "$javascript#DataProperty";
export const JAVASCRIPT_ACCESSOR_PROPERTY = "$javascript#AccessorProperty";

export const JAVASCRIPT_OBJECT_RECORD_TYPE = "$javascript#ObjectRecord";
export const JAVASCRIPT_OBJECT_RECORD = "$javascript#ObjectRecordValue";

export const JAVASCRIPT_HEAP_TYPE = "$javascript#Heap";
export const JAVASCRIPT_HEAP = "$javascript#HeapValue";

export const JAVASCRIPT_ENVIRONMENT_TYPE = "$javascript#Environment";
export const JAVASCRIPT_ENVIRONMENT_EMPTY = "$javascript#EmptyEnvironment";
export const JAVASCRIPT_ENVIRONMENT_BINDING = "$javascript#EnvironmentBinding";

export const JAVASCRIPT_REFERENCE_TYPE = "$javascript#Reference";
export const JAVASCRIPT_UNRESOLVABLE_REFERENCE = "$javascript#UnresolvableReference";
export const JAVASCRIPT_BINDING_REFERENCE = "$javascript#BindingReference";
export const JAVASCRIPT_PROPERTY_REFERENCE = "$javascript#PropertyReference";

export const JAVASCRIPT_BINDING_STORE_TYPE = "$javascript#BindingStore";
export const JAVASCRIPT_BINDING_STORE = "$javascript#BindingStoreValue";

export const JAVASCRIPT_BINDING_STATE_TYPE = "$javascript#BindingState";
export const JAVASCRIPT_BINDING_UNINITIALIZED = "$javascript#UninitializedBinding";
export const JAVASCRIPT_BINDING_IMMUTABLE = "$javascript#ImmutableBinding";
export const JAVASCRIPT_BINDING_MUTABLE = "$javascript#MutableBinding";

export const JAVASCRIPT_STATE_TYPE = "$javascript#State";
export const JAVASCRIPT_STATE = "$javascript#StateValue";

export const JAVASCRIPT_COMPLETION_TYPE = "$javascript#Completion";
export const JAVASCRIPT_COMPLETION_NORMAL = "$javascript#NormalCompletion";
export const JAVASCRIPT_COMPLETION_RETURN = "$javascript#ReturnCompletion";
export const JAVASCRIPT_COMPLETION_THROW = "$javascript#ThrowCompletion";
export const JAVASCRIPT_COMPLETION_BREAK = "$javascript#BreakCompletion";
export const JAVASCRIPT_COMPLETION_CONTINUE = "$javascript#ContinueCompletion";

export const JAVASCRIPT_COMPLETION_TARGET_TYPE = "$javascript#CompletionTarget";
export const JAVASCRIPT_COMPLETION_TARGET_EMPTY = "$javascript#EmptyTarget";
export const JAVASCRIPT_COMPLETION_TARGET_LABEL = "$javascript#LabelTarget";

export const JAVASCRIPT_VALUE_LOOKUP_TYPE = "$javascript#ValueLookup";
export const JAVASCRIPT_VALUE_MISSING = "$javascript#MissingValue";
export const JAVASCRIPT_VALUE_UNINITIALIZED = "$javascript#UninitializedValue";
export const JAVASCRIPT_VALUE_FOUND = "$javascript#FoundValue";

export const JAVASCRIPT_HEAP_ALLOCATION_TYPE = "$javascript#HeapAllocation";
export const JAVASCRIPT_HEAP_ALLOCATION = "$javascript#AllocatedObject";

export const JAVASCRIPT_BINDING_UPDATE_TYPE = "$javascript#BindingUpdate";
export const JAVASCRIPT_BINDING_UPDATE_NOT_FOUND = "$javascript#BindingNotFound";
export const JAVASCRIPT_BINDING_UPDATE_UNINITIALIZED = "$javascript#BindingUninitialized";
export const JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED =
  "$javascript#BindingAlreadyInitialized";
export const JAVASCRIPT_BINDING_UPDATE_IMMUTABLE = "$javascript#BindingImmutable";
export const JAVASCRIPT_BINDING_UPDATE_UPDATED = "$javascript#BindingUpdated";

const integerType = { kind: "integer" as const };
const float64Type = { kind: "float-64" as const };
const booleanType = { kind: "boolean" as const };
const textType = {
  kind: "named" as const,
  name: "$FunctionalText",
  arguments: [],
};
const valueType = namedType(JAVASCRIPT_VALUE_TYPE);
const propertyKeyType = namedType(JAVASCRIPT_PROPERTY_KEY_TYPE);
const propertyDescriptorType = namedType(JAVASCRIPT_PROPERTY_DESCRIPTOR_TYPE);
const objectKindType = namedType(JAVASCRIPT_OBJECT_KIND_TYPE);
const propertyListType = namedType(JAVASCRIPT_PROPERTY_LIST_TYPE);
const objectRecordType = namedType(JAVASCRIPT_OBJECT_RECORD_TYPE);
const heapType = namedType(JAVASCRIPT_HEAP_TYPE);
const environmentType = namedType(JAVASCRIPT_ENVIRONMENT_TYPE);
const bindingStateType = namedType(JAVASCRIPT_BINDING_STATE_TYPE);
const bindingStoreType = namedType(JAVASCRIPT_BINDING_STORE_TYPE);
const stateType = namedType(JAVASCRIPT_STATE_TYPE);
const completionTargetType = namedType(JAVASCRIPT_COMPLETION_TARGET_TYPE);

export function javascriptRuntimeTypeDeclarations(
  sourceByteLength: number,
): readonly FunctionalSurfaceTypeDeclaration[] {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return [{
    name: JAVASCRIPT_VALUE_TYPE,
    parameters: [],
    span,
    constructors: [
      { name: JAVASCRIPT_VALUE_UNDEFINED, fields: [], span },
      { name: JAVASCRIPT_VALUE_NULL, fields: [], span },
      {
        name: JAVASCRIPT_VALUE_BOOLEAN,
        fields: [{ name: "value", type: booleanType, span }],
        span,
      },
      {
        name: JAVASCRIPT_VALUE_NUMBER,
        fields: [{ name: "value", type: float64Type, span }],
        span,
      },
      {
        name: JAVASCRIPT_VALUE_STRING,
        fields: [{ name: "value", type: textType, span }],
        span,
      },
      {
        name: JAVASCRIPT_VALUE_SYMBOL,
        fields: [{ name: "identity", type: integerType, span }],
        span,
      },
      {
        name: JAVASCRIPT_VALUE_OBJECT,
        fields: [{ name: "identity", type: integerType, span }],
        span,
      },
    ],
  }, {
    name: JAVASCRIPT_PROPERTY_KEY_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: JAVASCRIPT_PROPERTY_KEY_STRING,
      fields: [{ name: "value", type: textType, span }],
      span,
    }, {
      name: JAVASCRIPT_PROPERTY_KEY_SYMBOL,
      fields: [{ name: "identity", type: integerType, span }],
      span,
    }],
  }, {
    name: JAVASCRIPT_OBJECT_KIND_TYPE,
    parameters: [],
    span,
    constructors: [
      { name: JAVASCRIPT_OBJECT_ORDINARY, fields: [], span },
      {
        name: JAVASCRIPT_OBJECT_CALLABLE,
        fields: [
          { name: "target", type: integerType, span },
          { name: "environment", type: environmentType, span },
        ],
        span,
      },
    ],
  }, {
    name: JAVASCRIPT_PROPERTY_DESCRIPTOR_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: JAVASCRIPT_DATA_DESCRIPTOR,
      fields: [
        { name: "value", type: valueType, span },
        { name: "writable", type: booleanType, span },
        { name: "enumerable", type: booleanType, span },
        { name: "configurable", type: booleanType, span },
      ],
      span,
    }, {
      name: JAVASCRIPT_ACCESSOR_DESCRIPTOR,
      fields: [
        { name: "getter", type: valueType, span },
        { name: "setter", type: valueType, span },
        { name: "enumerable", type: booleanType, span },
        { name: "configurable", type: booleanType, span },
      ],
      span,
    }],
  }, {
    name: JAVASCRIPT_DESCRIPTOR_LOOKUP_TYPE,
    parameters: [],
    span,
    constructors: [
      { name: JAVASCRIPT_DESCRIPTOR_MISSING, fields: [], span },
      {
        name: JAVASCRIPT_DESCRIPTOR_FOUND,
        fields: [{ name: "descriptor", type: propertyDescriptorType, span }],
        span,
      },
    ],
  }, {
    name: JAVASCRIPT_PROPERTY_LIST_TYPE,
    parameters: [],
    span,
    constructors: [
      { name: JAVASCRIPT_PROPERTY_LIST_EMPTY, fields: [], span },
      {
        name: JAVASCRIPT_DATA_PROPERTY,
        fields: [
          { name: "key", type: propertyKeyType, span },
          { name: "value", type: valueType, span },
          { name: "writable", type: booleanType, span },
          { name: "enumerable", type: booleanType, span },
          { name: "configurable", type: booleanType, span },
          { name: "next", type: propertyListType, span },
        ],
        span,
      },
      {
        name: JAVASCRIPT_ACCESSOR_PROPERTY,
        fields: [
          { name: "key", type: propertyKeyType, span },
          { name: "getter", type: valueType, span },
          { name: "setter", type: valueType, span },
          { name: "enumerable", type: booleanType, span },
          { name: "configurable", type: booleanType, span },
          { name: "next", type: propertyListType, span },
        ],
        span,
      },
    ],
  }, {
    name: JAVASCRIPT_OBJECT_RECORD_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: JAVASCRIPT_OBJECT_RECORD,
      fields: [
        { name: "prototype", type: valueType, span },
        { name: "extensible", type: booleanType, span },
        { name: "kind", type: objectKindType, span },
        { name: "properties", type: propertyListType, span },
      ],
      span,
    }],
  }, {
    name: JAVASCRIPT_HEAP_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: JAVASCRIPT_HEAP,
      fields: [
        { name: "nextIdentity", type: integerType, span },
        { name: "objects", type: functionalStoreType(objectRecordType), span },
      ],
      span,
    }],
  }, {
    name: JAVASCRIPT_BINDING_STATE_TYPE,
    parameters: [],
    span,
    constructors: [
      {
        name: JAVASCRIPT_BINDING_UNINITIALIZED,
        fields: [{ name: "mutable", type: booleanType, span }],
        span,
      },
      {
        name: JAVASCRIPT_BINDING_IMMUTABLE,
        fields: [{ name: "value", type: valueType, span }],
        span,
      },
      {
        name: JAVASCRIPT_BINDING_MUTABLE,
        fields: [{ name: "value", type: valueType, span }],
        span,
      },
    ],
  }, {
    name: JAVASCRIPT_BINDING_STORE_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: JAVASCRIPT_BINDING_STORE,
      fields: [
        { name: "nextIdentity", type: integerType, span },
        { name: "cells", type: functionalStoreType(bindingStateType), span },
      ],
      span,
    }],
  }, {
    name: JAVASCRIPT_ENVIRONMENT_TYPE,
    parameters: [],
    span,
    constructors: [
      { name: JAVASCRIPT_ENVIRONMENT_EMPTY, fields: [], span },
      {
        name: JAVASCRIPT_ENVIRONMENT_BINDING,
        fields: [
          { name: "name", type: textType, span },
          { name: "bindingIdentity", type: integerType, span },
          { name: "outer", type: environmentType, span },
        ],
        span,
      },
    ],
  }, {
    name: JAVASCRIPT_REFERENCE_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: JAVASCRIPT_UNRESOLVABLE_REFERENCE,
      fields: [
        { name: "name", type: textType, span },
        { name: "strict", type: booleanType, span },
      ],
      span,
    }, {
      name: JAVASCRIPT_BINDING_REFERENCE,
      fields: [
        { name: "bindingIdentity", type: integerType, span },
        { name: "strict", type: booleanType, span },
      ],
      span,
    }, {
      name: JAVASCRIPT_PROPERTY_REFERENCE,
      fields: [
        { name: "base", type: valueType, span },
        { name: "key", type: propertyKeyType, span },
        { name: "receiver", type: valueType, span },
        { name: "strict", type: booleanType, span },
      ],
      span,
    }],
  }, {
    name: JAVASCRIPT_STATE_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: JAVASCRIPT_STATE,
      fields: [
        { name: "heap", type: heapType, span },
        { name: "environment", type: environmentType, span },
        { name: "bindings", type: bindingStoreType, span },
      ],
      span,
    }],
  }, {
    name: JAVASCRIPT_COMPLETION_TARGET_TYPE,
    parameters: [],
    span,
    constructors: [{ name: JAVASCRIPT_COMPLETION_TARGET_EMPTY, fields: [], span }, {
      name: JAVASCRIPT_COMPLETION_TARGET_LABEL,
      fields: [{ name: "label", type: textType, span }],
      span,
    }],
  }, {
    name: JAVASCRIPT_COMPLETION_TYPE,
    parameters: [],
    span,
    constructors: [
      completionWithValueConstructor(JAVASCRIPT_COMPLETION_NORMAL, span),
      completionWithValueConstructor(JAVASCRIPT_COMPLETION_RETURN, span),
      completionWithValueConstructor(JAVASCRIPT_COMPLETION_THROW, span),
      completionWithTargetConstructor(JAVASCRIPT_COMPLETION_BREAK, span),
      completionWithTargetConstructor(JAVASCRIPT_COMPLETION_CONTINUE, span),
    ],
  }, {
    name: JAVASCRIPT_VALUE_LOOKUP_TYPE,
    parameters: [],
    span,
    constructors: [
      { name: JAVASCRIPT_VALUE_MISSING, fields: [], span },
      { name: JAVASCRIPT_VALUE_UNINITIALIZED, fields: [], span },
      {
        name: JAVASCRIPT_VALUE_FOUND,
        fields: [{ name: "value", type: valueType, span }],
        span,
      },
    ],
  }, {
    name: JAVASCRIPT_HEAP_ALLOCATION_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: JAVASCRIPT_HEAP_ALLOCATION,
      fields: [
        { name: "heap", type: heapType, span },
        { name: "value", type: valueType, span },
      ],
      span,
    }],
  }, {
    name: JAVASCRIPT_BINDING_UPDATE_TYPE,
    parameters: [],
    span,
    constructors: [
      { name: JAVASCRIPT_BINDING_UPDATE_NOT_FOUND, fields: [], span },
      { name: JAVASCRIPT_BINDING_UPDATE_UNINITIALIZED, fields: [], span },
      { name: JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED, fields: [], span },
      { name: JAVASCRIPT_BINDING_UPDATE_IMMUTABLE, fields: [], span },
      {
        name: JAVASCRIPT_BINDING_UPDATE_UPDATED,
        fields: [{ name: "state", type: stateType, span }],
        span,
      },
    ],
  }];
}

function namedType(name: string) {
  return { kind: "named" as const, name, arguments: [] };
}

function completionWithValueConstructor(
  name: string,
  span: { readonly startByte: number; readonly endByte: number },
) {
  return {
    name,
    fields: [
      { name: "state", type: stateType, span },
      { name: "value", type: valueType, span },
    ],
    span,
  };
}

function completionWithTargetConstructor(
  name: string,
  span: { readonly startByte: number; readonly endByte: number },
) {
  return {
    name,
    fields: [
      { name: "state", type: stateType, span },
      { name: "target", type: completionTargetType, span },
    ],
    span,
  };
}
