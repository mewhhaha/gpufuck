import { FunctionalBinaryOperator } from "../../../src/functional/abi.ts";
import type {
  FunctionalSurfaceCaseArm,
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "../../../src/functional/surface_builder.ts";
import {
  JAVASCRIPT_ACCESSOR_DESCRIPTOR,
  JAVASCRIPT_ACCESSOR_PROPERTY,
  JAVASCRIPT_BINDING_IMMUTABLE,
  JAVASCRIPT_BINDING_MUTABLE,
  JAVASCRIPT_BINDING_REFERENCE,
  JAVASCRIPT_BINDING_STORE,
  JAVASCRIPT_BINDING_UNINITIALIZED,
  JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED,
  JAVASCRIPT_BINDING_UPDATE_IMMUTABLE,
  JAVASCRIPT_BINDING_UPDATE_NOT_FOUND,
  JAVASCRIPT_BINDING_UPDATE_UNINITIALIZED,
  JAVASCRIPT_BINDING_UPDATE_UPDATED,
  JAVASCRIPT_DATA_DESCRIPTOR,
  JAVASCRIPT_DATA_PROPERTY,
  JAVASCRIPT_DESCRIPTOR_FOUND,
  JAVASCRIPT_DESCRIPTOR_MISSING,
  JAVASCRIPT_ENVIRONMENT_BINDING,
  JAVASCRIPT_ENVIRONMENT_EMPTY,
  JAVASCRIPT_EXECUTION_CONTEXT,
  JAVASCRIPT_HEAP,
  JAVASCRIPT_HEAP_ALLOCATION,
  JAVASCRIPT_MAXIMUM_BINDING_COUNT,
  JAVASCRIPT_MAXIMUM_OBJECT_COUNT,
  JAVASCRIPT_OBJECT_ORDINARY,
  JAVASCRIPT_OBJECT_RECORD,
  JAVASCRIPT_PROPERTY_KEY_STRING,
  JAVASCRIPT_PROPERTY_KEY_SYMBOL,
  JAVASCRIPT_PROPERTY_LIST_EMPTY,
  JAVASCRIPT_PROPERTY_REFERENCE,
  JAVASCRIPT_REALM,
  JAVASCRIPT_REFERENCE_UPDATE_ACCESSOR,
  JAVASCRIPT_REFERENCE_UPDATE_IMMUTABLE,
  JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE,
  JAVASCRIPT_REFERENCE_UPDATE_MISSING_SETTER,
  JAVASCRIPT_REFERENCE_UPDATE_NON_EXTENSIBLE,
  JAVASCRIPT_REFERENCE_UPDATE_NON_WRITABLE,
  JAVASCRIPT_REFERENCE_UPDATE_UNINITIALIZED,
  JAVASCRIPT_REFERENCE_UPDATE_UNRESOLVABLE,
  JAVASCRIPT_REFERENCE_UPDATE_UPDATED,
  JAVASCRIPT_STATE,
  JAVASCRIPT_UNRESOLVABLE_REFERENCE,
  JAVASCRIPT_VALUE_ACCESSOR,
  JAVASCRIPT_VALUE_BOOLEAN,
  JAVASCRIPT_VALUE_FOUND,
  JAVASCRIPT_VALUE_MISSING,
  JAVASCRIPT_VALUE_NULL,
  JAVASCRIPT_VALUE_NUMBER,
  JAVASCRIPT_VALUE_OBJECT,
  JAVASCRIPT_VALUE_STRING,
  JAVASCRIPT_VALUE_SYMBOL,
  JAVASCRIPT_VALUE_UNDEFINED,
  JAVASCRIPT_VALUE_UNINITIALIZED,
  javascriptRuntimeTypeDeclarations,
} from "./runtime_contract.ts";

export const JAVASCRIPT_RUNTIME_EMPTY_HEAP = "$javascript#emptyHeap";
export const JAVASCRIPT_RUNTIME_EMPTY_STATE = "$javascript#emptyState";
export const JAVASCRIPT_RUNTIME_PROPERTY_KEY_EQUAL = "$javascript#propertyKeyEqual";
export const JAVASCRIPT_RUNTIME_TO_BOOLEAN = "$javascript#toBoolean";
export const JAVASCRIPT_RUNTIME_STRICT_EQUAL = "$javascript#strictEqual";
export const JAVASCRIPT_RUNTIME_SAME_VALUE = "$javascript#sameValue";
export const JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY_DESCRIPTOR = "$javascript#lookupPropertyDescriptor";
export const JAVASCRIPT_RUNTIME_LOOKUP_OWN_PROPERTY = "$javascript#lookupOwnProperty";
export const JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY = "$javascript#lookupProperty";
export const JAVASCRIPT_RUNTIME_OBJECT_KIND = "$javascript#objectKind";
export const JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED =
  "$javascript#defineOwnPropertyUnchecked";
export const JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT = "$javascript#allocateObject";
export const JAVASCRIPT_RUNTIME_LOOKUP_BINDING = "$javascript#lookupBinding";
export const JAVASCRIPT_RUNTIME_DEFINE_BINDING = "$javascript#defineBinding";
export const JAVASCRIPT_RUNTIME_INITIALIZE_BINDING = "$javascript#initializeBinding";
export const JAVASCRIPT_RUNTIME_SET_BINDING = "$javascript#setBinding";
export const JAVASCRIPT_RUNTIME_RESOLVE_BINDING_REFERENCE = "$javascript#resolveBindingReference";
export const JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE = "$javascript#getReferenceValue";
export const JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE = "$javascript#putReferenceValue";
export const JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT = "$javascript#lexicalEnvironment";
export const JAVASCRIPT_RUNTIME_REALM = "$javascript#currentRealm";
export const JAVASCRIPT_RUNTIME_GLOBAL_OBJECT = "$javascript#globalObject";
export const JAVASCRIPT_RUNTIME_THIS_VALUE = "$javascript#thisValue";
export const JAVASCRIPT_RUNTIME_WITH_GLOBAL_THIS = "$javascript#withGlobalThis";

const DESCRIPTOR_TO_PROPERTY = "$javascript#descriptorToProperty";
const DEFINE_PROPERTY_IN_LIST = "$javascript#definePropertyInList";
const OBJECT_EXISTS = "$javascript#objectExists";
const LOOKUP_OBJECT = "$javascript#lookupObject";
const LOOKUP_BINDING_CELL = "$javascript#lookupBindingCell";
const RESOLVE_ENVIRONMENT_REFERENCE = "$javascript#resolveEnvironmentReference";
const PUT_BINDING_REFERENCE_VALUE = "$javascript#putBindingReferenceValue";
const PUT_OBJECT_PROPERTY = "$javascript#putObjectProperty";
const PUT_RECEIVER_DATA_PROPERTY = "$javascript#putReceiverDataProperty";
const INITIALIZE_ENVIRONMENT_BINDING = "$javascript#initializeEnvironmentBinding";
const INITIALIZE_BINDING_CELL = "$javascript#initializeBindingCell";
const SET_ENVIRONMENT_BINDING = "$javascript#setEnvironmentBinding";
const SET_BINDING_CELL = "$javascript#setBindingCell";
const WITH_LEXICAL_ENVIRONMENT = "$javascript#withLexicalEnvironment";

export interface JavaScriptRuntimeSurface {
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
}

export function javascriptRuntimeSurface(sourceByteLength: number): JavaScriptRuntimeSurface {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  const definitions: readonly FunctionalSurfaceDefinition[] = [{
    name: JAVASCRIPT_RUNTIME_EMPTY_HEAP,
    parameters: [],
    annotation: null,
    body: call(JAVASCRIPT_HEAP, [
      integer(0, span),
      storeNew(integer(0, span), defaultObjectRecord(span), span),
    ], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_EMPTY_STATE,
    parameters: [],
    annotation: null,
    body: match(
      call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
        reference(JAVASCRIPT_RUNTIME_EMPTY_HEAP, span),
        reference(JAVASCRIPT_VALUE_NULL, span),
        reference(JAVASCRIPT_OBJECT_ORDINARY, span),
      ], span),
      [{
        constructor: JAVASCRIPT_HEAP_ALLOCATION,
        binders: ["initialHeap", "globalObject"],
        body: call(JAVASCRIPT_STATE, [
          reference("initialHeap", span),
          call(JAVASCRIPT_EXECUTION_CONTEXT, [
            call(JAVASCRIPT_REALM, [
              reference("globalObject", span),
            ], span),
            reference(JAVASCRIPT_ENVIRONMENT_EMPTY, span),
            reference(JAVASCRIPT_ENVIRONMENT_EMPTY, span),
            reference(JAVASCRIPT_VALUE_UNDEFINED, span),
          ], span),
          call(JAVASCRIPT_BINDING_STORE, [
            integer(0, span),
            storeNew(
              integer(0, span),
              call(JAVASCRIPT_BINDING_UNINITIALIZED, [boolean(false, span)], span),
              span,
            ),
          ], span),
        ], span),
        span,
      }],
      span,
    ),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT,
    parameters: ["context"],
    annotation: null,
    body: match(reference("context", span), [{
      constructor: JAVASCRIPT_EXECUTION_CONTEXT,
      binders: ["realm", "lexicalEnvironment", "variableEnvironment", "thisValue"],
      body: reference("lexicalEnvironment", span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_REALM,
    parameters: ["context"],
    annotation: null,
    body: match(reference("context", span), [{
      constructor: JAVASCRIPT_EXECUTION_CONTEXT,
      binders: ["realm", "lexicalEnvironment", "variableEnvironment", "thisValue"],
      body: reference("realm", span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_THIS_VALUE,
    parameters: ["context"],
    annotation: null,
    body: match(reference("context", span), [{
      constructor: JAVASCRIPT_EXECUTION_CONTEXT,
      binders: ["realm", "lexicalEnvironment", "variableEnvironment", "thisValue"],
      body: reference("thisValue", span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_GLOBAL_OBJECT,
    parameters: ["state"],
    annotation: null,
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: match(reference("context", span), [{
        constructor: JAVASCRIPT_EXECUTION_CONTEXT,
        binders: ["realm", "lexicalEnvironment", "variableEnvironment", "thisValue"],
        body: match(reference("realm", span), [{
          constructor: JAVASCRIPT_REALM,
          binders: ["globalObject"],
          body: reference("globalObject", span),
          span,
        }], span),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_WITH_GLOBAL_THIS,
    parameters: ["state"],
    annotation: null,
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: match(reference("context", span), [{
        constructor: JAVASCRIPT_EXECUTION_CONTEXT,
        binders: ["realm", "lexicalEnvironment", "variableEnvironment", "thisValue"],
        body: match(reference("realm", span), [{
          constructor: JAVASCRIPT_REALM,
          binders: ["globalObject"],
          body: call(JAVASCRIPT_STATE, [
            reference("heap", span),
            call(JAVASCRIPT_EXECUTION_CONTEXT, [
              reference("realm", span),
              reference("lexicalEnvironment", span),
              reference("variableEnvironment", span),
              reference("globalObject", span),
            ], span),
            reference("bindings", span),
          ], span),
          span,
        }], span),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    name: WITH_LEXICAL_ENVIRONMENT,
    parameters: ["context", "lexicalEnvironment"],
    annotation: null,
    body: match(reference("context", span), [{
      constructor: JAVASCRIPT_EXECUTION_CONTEXT,
      binders: ["realm", "previousLexicalEnvironment", "variableEnvironment", "thisValue"],
      body: call(JAVASCRIPT_EXECUTION_CONTEXT, [
        reference("realm", span),
        reference("lexicalEnvironment", span),
        reference("variableEnvironment", span),
        reference("thisValue", span),
      ], span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_PROPERTY_KEY_EQUAL,
    parameters: ["left", "right"],
    annotation: null,
    body: match(reference("left", span), [{
      constructor: JAVASCRIPT_PROPERTY_KEY_STRING,
      binders: ["leftString"],
      body: match(reference("right", span), [{
        constructor: JAVASCRIPT_PROPERTY_KEY_STRING,
        binders: ["rightString"],
        body: binary(
          FunctionalBinaryOperator.StructuralEqual,
          reference("leftString", span),
          reference("rightString", span),
          span,
        ),
        span,
      }, {
        constructor: JAVASCRIPT_PROPERTY_KEY_SYMBOL,
        binders: ["rightSymbol"],
        body: boolean(false, span),
        span,
      }], span),
      span,
    }, {
      constructor: JAVASCRIPT_PROPERTY_KEY_SYMBOL,
      binders: ["leftSymbol"],
      body: match(reference("right", span), [{
        constructor: JAVASCRIPT_PROPERTY_KEY_STRING,
        binders: ["rightString"],
        body: boolean(false, span),
        span,
      }, {
        constructor: JAVASCRIPT_PROPERTY_KEY_SYMBOL,
        binders: ["rightSymbol"],
        body: binary(
          FunctionalBinaryOperator.Equal,
          reference("leftSymbol", span),
          reference("rightSymbol", span),
          span,
        ),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_TO_BOOLEAN,
    parameters: ["value"],
    annotation: null,
    body: match(reference("value", span), [{
      constructor: JAVASCRIPT_VALUE_UNDEFINED,
      binders: [],
      body: boolean(false, span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_NULL,
      binders: [],
      body: boolean(false, span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_BOOLEAN,
      binders: ["booleanValue"],
      body: reference("booleanValue", span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_NUMBER,
      binders: ["numberValue"],
      body: conditional(
        binary(
          FunctionalBinaryOperator.EqualFloat64,
          reference("numberValue", span),
          reference("numberValue", span),
          span,
        ),
        binary(
          FunctionalBinaryOperator.NotEqualFloat64,
          reference("numberValue", span),
          { kind: "float-64", value: 0, span },
          span,
        ),
        boolean(false, span),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_STRING,
      binders: ["stringValue"],
      body: binary(
        FunctionalBinaryOperator.StructuralNotEqual,
        reference("stringValue", span),
        { kind: "text", value: "", span },
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_SYMBOL,
      binders: ["symbolIdentity"],
      body: boolean(true, span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_OBJECT,
      binders: ["objectIdentity"],
      body: boolean(true, span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_STRICT_EQUAL,
    parameters: ["left", "right"],
    annotation: null,
    body: match(reference("left", span), [{
      constructor: JAVASCRIPT_VALUE_UNDEFINED,
      binders: [],
      body: compareMatchingValueKind(
        reference("right", span),
        JAVASCRIPT_VALUE_UNDEFINED,
        boolean(true, span),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_NULL,
      binders: [],
      body: compareMatchingValueKind(
        reference("right", span),
        JAVASCRIPT_VALUE_NULL,
        boolean(true, span),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_BOOLEAN,
      binders: ["leftBoolean"],
      body: compareMatchingValueKind(
        reference("right", span),
        JAVASCRIPT_VALUE_BOOLEAN,
        binary(
          FunctionalBinaryOperator.StructuralEqual,
          reference("leftBoolean", span),
          reference("matchingValue", span),
          span,
        ),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_NUMBER,
      binders: ["leftNumber"],
      body: compareMatchingValueKind(
        reference("right", span),
        JAVASCRIPT_VALUE_NUMBER,
        binary(
          FunctionalBinaryOperator.EqualFloat64,
          reference("leftNumber", span),
          reference("matchingValue", span),
          span,
        ),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_STRING,
      binders: ["leftString"],
      body: compareMatchingValueKind(
        reference("right", span),
        JAVASCRIPT_VALUE_STRING,
        binary(
          FunctionalBinaryOperator.StructuralEqual,
          reference("leftString", span),
          reference("matchingValue", span),
          span,
        ),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_SYMBOL,
      binders: ["leftSymbol"],
      body: compareMatchingValueKind(
        reference("right", span),
        JAVASCRIPT_VALUE_SYMBOL,
        binary(
          FunctionalBinaryOperator.Equal,
          reference("leftSymbol", span),
          reference("matchingValue", span),
          span,
        ),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_OBJECT,
      binders: ["leftObject"],
      body: compareMatchingValueKind(
        reference("right", span),
        JAVASCRIPT_VALUE_OBJECT,
        binary(
          FunctionalBinaryOperator.Equal,
          reference("leftObject", span),
          reference("matchingValue", span),
          span,
        ),
        span,
      ),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_SAME_VALUE,
    parameters: ["left", "right"],
    annotation: null,
    body: match(reference("left", span), [{
      constructor: JAVASCRIPT_VALUE_UNDEFINED,
      binders: [],
      body: call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [
        reference("left", span),
        reference("right", span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_NULL,
      binders: [],
      body: call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [
        reference("left", span),
        reference("right", span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_BOOLEAN,
      binders: ["leftBoolean"],
      body: call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [
        reference("left", span),
        reference("right", span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_NUMBER,
      binders: ["leftNumber"],
      body: compareMatchingValueKind(
        reference("right", span),
        JAVASCRIPT_VALUE_NUMBER,
        sameNumberValue(
          reference("leftNumber", span),
          reference("matchingValue", span),
          span,
        ),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_STRING,
      binders: ["leftString"],
      body: call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [
        reference("left", span),
        reference("right", span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_SYMBOL,
      binders: ["leftSymbol"],
      body: call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [
        reference("left", span),
        reference("right", span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_VALUE_OBJECT,
      binders: ["leftObject"],
      body: call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [
        reference("left", span),
        reference("right", span),
      ], span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY_DESCRIPTOR,
    parameters: ["properties", "key"],
    annotation: null,
    body: match(reference("properties", span), [{
      constructor: JAVASCRIPT_PROPERTY_LIST_EMPTY,
      binders: [],
      body: reference(JAVASCRIPT_DESCRIPTOR_MISSING, span),
      span,
    }, {
      constructor: JAVASCRIPT_DATA_PROPERTY,
      binders: [
        "existingKey",
        "value",
        "writable",
        "enumerable",
        "configurable",
        "remainingProperties",
      ],
      body: conditional(
        call(JAVASCRIPT_RUNTIME_PROPERTY_KEY_EQUAL, [
          reference("existingKey", span),
          reference("key", span),
        ], span),
        call(JAVASCRIPT_DESCRIPTOR_FOUND, [
          call(JAVASCRIPT_DATA_DESCRIPTOR, [
            reference("value", span),
            reference("writable", span),
            reference("enumerable", span),
            reference("configurable", span),
          ], span),
        ], span),
        call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY_DESCRIPTOR, [
          reference("remainingProperties", span),
          reference("key", span),
        ], span),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_ACCESSOR_PROPERTY,
      binders: [
        "existingKey",
        "getter",
        "setter",
        "enumerable",
        "configurable",
        "remainingProperties",
      ],
      body: conditional(
        call(JAVASCRIPT_RUNTIME_PROPERTY_KEY_EQUAL, [
          reference("existingKey", span),
          reference("key", span),
        ], span),
        call(JAVASCRIPT_DESCRIPTOR_FOUND, [
          call(JAVASCRIPT_ACCESSOR_DESCRIPTOR, [
            reference("getter", span),
            reference("setter", span),
            reference("enumerable", span),
            reference("configurable", span),
          ], span),
        ], span),
        call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY_DESCRIPTOR, [
          reference("remainingProperties", span),
          reference("key", span),
        ], span),
        span,
      ),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_LOOKUP_OWN_PROPERTY,
    parameters: ["objects", "identity", "key"],
    annotation: null,
    body: match(
      call(LOOKUP_OBJECT, [
        reference("objects", span),
        reference("identity", span),
      ], span),
      [{
        constructor: JAVASCRIPT_OBJECT_RECORD,
        binders: ["prototype", "extensible", "objectKind", "properties"],
        body: call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY_DESCRIPTOR, [
          reference("properties", span),
          reference("key", span),
        ], span),
        span,
      }],
      span,
    ),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_OBJECT_KIND,
    parameters: ["objects", "identity"],
    annotation: null,
    body: match(
      call(LOOKUP_OBJECT, [
        reference("objects", span),
        reference("identity", span),
      ], span),
      [{
        constructor: JAVASCRIPT_OBJECT_RECORD,
        binders: ["prototype", "extensible", "objectKind", "properties"],
        body: reference("objectKind", span),
        span,
      }],
      span,
    ),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY,
    parameters: ["objects", "identity", "key"],
    annotation: null,
    body: match(
      call(LOOKUP_OBJECT, [
        reference("objects", span),
        reference("identity", span),
      ], span),
      [{
        constructor: JAVASCRIPT_OBJECT_RECORD,
        binders: ["prototype", "extensible", "objectKind", "properties"],
        body: letExpression(
          "ownDescriptor",
          call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY_DESCRIPTOR, [
            reference("properties", span),
            reference("key", span),
          ], span),
          match(reference("ownDescriptor", span), [{
            constructor: JAVASCRIPT_DESCRIPTOR_MISSING,
            binders: [],
            body: lookupPrototypeProperty(span),
            span,
          }, {
            constructor: JAVASCRIPT_DESCRIPTOR_FOUND,
            binders: ["descriptor"],
            body: call(JAVASCRIPT_DESCRIPTOR_FOUND, [reference("descriptor", span)], span),
            span,
          }], span),
          span,
        ),
        span,
      }],
      span,
    ),
    span,
  }, {
    name: DESCRIPTOR_TO_PROPERTY,
    parameters: ["key", "descriptor", "next"],
    annotation: null,
    body: match(reference("descriptor", span), [{
      constructor: JAVASCRIPT_DATA_DESCRIPTOR,
      binders: ["value", "writable", "enumerable", "configurable"],
      body: call(JAVASCRIPT_DATA_PROPERTY, [
        reference("key", span),
        reference("value", span),
        reference("writable", span),
        reference("enumerable", span),
        reference("configurable", span),
        reference("next", span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_ACCESSOR_DESCRIPTOR,
      binders: ["getter", "setter", "enumerable", "configurable"],
      body: call(JAVASCRIPT_ACCESSOR_PROPERTY, [
        reference("key", span),
        reference("getter", span),
        reference("setter", span),
        reference("enumerable", span),
        reference("configurable", span),
        reference("next", span),
      ], span),
      span,
    }], span),
    span,
  }, {
    name: DEFINE_PROPERTY_IN_LIST,
    parameters: ["properties", "key", "descriptor"],
    annotation: null,
    body: match(reference("properties", span), [{
      constructor: JAVASCRIPT_PROPERTY_LIST_EMPTY,
      binders: [],
      body: call(DESCRIPTOR_TO_PROPERTY, [
        reference("key", span),
        reference("descriptor", span),
        reference(JAVASCRIPT_PROPERTY_LIST_EMPTY, span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_DATA_PROPERTY,
      binders: [
        "existingKey",
        "value",
        "writable",
        "enumerable",
        "configurable",
        "remainingProperties",
      ],
      body: conditional(
        call(JAVASCRIPT_RUNTIME_PROPERTY_KEY_EQUAL, [
          reference("existingKey", span),
          reference("key", span),
        ], span),
        call(DESCRIPTOR_TO_PROPERTY, [
          reference("key", span),
          reference("descriptor", span),
          reference("remainingProperties", span),
        ], span),
        call(JAVASCRIPT_DATA_PROPERTY, [
          reference("existingKey", span),
          reference("value", span),
          reference("writable", span),
          reference("enumerable", span),
          reference("configurable", span),
          call(DEFINE_PROPERTY_IN_LIST, [
            reference("remainingProperties", span),
            reference("key", span),
            reference("descriptor", span),
          ], span),
        ], span),
        span,
      ),
      span,
    }, {
      constructor: JAVASCRIPT_ACCESSOR_PROPERTY,
      binders: [
        "existingKey",
        "getter",
        "setter",
        "enumerable",
        "configurable",
        "remainingProperties",
      ],
      body: conditional(
        call(JAVASCRIPT_RUNTIME_PROPERTY_KEY_EQUAL, [
          reference("existingKey", span),
          reference("key", span),
        ], span),
        call(DESCRIPTOR_TO_PROPERTY, [
          reference("key", span),
          reference("descriptor", span),
          reference("remainingProperties", span),
        ], span),
        call(JAVASCRIPT_ACCESSOR_PROPERTY, [
          reference("existingKey", span),
          reference("getter", span),
          reference("setter", span),
          reference("enumerable", span),
          reference("configurable", span),
          call(DEFINE_PROPERTY_IN_LIST, [
            reference("remainingProperties", span),
            reference("key", span),
            reference("descriptor", span),
          ], span),
        ], span),
        span,
      ),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED,
    parameters: ["heap", "identity", "key", "descriptor"],
    annotation: null,
    body: match(reference("heap", span), [{
      constructor: JAVASCRIPT_HEAP,
      binders: ["nextIdentity", "objects"],
      body: match(
        call(LOOKUP_OBJECT, [
          reference("objects", span),
          reference("identity", span),
        ], span),
        [{
          constructor: JAVASCRIPT_OBJECT_RECORD,
          binders: ["prototype", "extensible", "objectKind", "properties"],
          body: call(JAVASCRIPT_HEAP, [
            reference("nextIdentity", span),
            storeWrite(
              reference("objects", span),
              reference("identity", span),
              call(JAVASCRIPT_OBJECT_RECORD, [
                reference("prototype", span),
                reference("extensible", span),
                reference("objectKind", span),
                call(DEFINE_PROPERTY_IN_LIST, [
                  reference("properties", span),
                  reference("key", span),
                  reference("descriptor", span),
                ], span),
              ], span),
              span,
            ),
          ], span),
          span,
        }],
        span,
      ),
      span,
    }], span),
    span,
  }, {
    name: OBJECT_EXISTS,
    parameters: ["objects", "identity"],
    annotation: null,
    body: conditional(
      binary(
        FunctionalBinaryOperator.Less,
        reference("identity", span),
        integer(0, span),
        span,
      ),
      boolean(false, span),
      binary(
        FunctionalBinaryOperator.Less,
        reference("identity", span),
        storeLength(reference("objects", span), span),
        span,
      ),
      span,
    ),
    span,
  }, {
    name: LOOKUP_OBJECT,
    parameters: ["objects", "identity"],
    annotation: null,
    body: conditional(
      call(OBJECT_EXISTS, [reference("objects", span), reference("identity", span)], span),
      storeRead(reference("objects", span), reference("identity", span), span),
      runtimeFault("JavaScript heap does not contain referenced object identity", span),
      span,
    ),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT,
    parameters: ["heap", "prototype", "objectKind"],
    annotation: null,
    body: match(reference("heap", span), [{
      constructor: JAVASCRIPT_HEAP,
      binders: ["nextIdentity", "objects"],
      body: conditional(
        binary(
          FunctionalBinaryOperator.Equal,
          reference("nextIdentity", span),
          integer(JAVASCRIPT_MAXIMUM_OBJECT_COUNT, span),
          span,
        ),
        runtimeFault("JavaScript object identity space is exhausted", span),
        match(reference("prototype", span), [{
          constructor: JAVASCRIPT_VALUE_NULL,
          binders: [],
          body: allocateObjectResult(span),
          span,
        }, {
          constructor: JAVASCRIPT_VALUE_OBJECT,
          binders: ["prototypeIdentity"],
          body: conditional(
            call(OBJECT_EXISTS, [
              reference("objects", span),
              reference("prototypeIdentity", span),
            ], span),
            allocateObjectResult(span),
            runtimeFault("JavaScript object prototype identity is not present in the heap", span),
            span,
          ),
          span,
        }, ...invalidPrototypeArms(span)], span),
        span,
      ),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_RESOLVE_BINDING_REFERENCE,
    parameters: ["state", "name", "strict"],
    annotation: null,
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: call(RESOLVE_ENVIRONMENT_REFERENCE, [
        call(JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT, [reference("context", span)], span),
        reference("name", span),
        reference("strict", span),
      ], span),
      span,
    }], span),
    span,
  }, {
    name: RESOLVE_ENVIRONMENT_REFERENCE,
    parameters: ["environment", "name", "strict"],
    annotation: null,
    body: match(reference("environment", span), [{
      constructor: JAVASCRIPT_ENVIRONMENT_EMPTY,
      binders: [],
      body: call(JAVASCRIPT_UNRESOLVABLE_REFERENCE, [
        reference("name", span),
        reference("strict", span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_ENVIRONMENT_BINDING,
      binders: ["bindingName", "bindingIdentity", "outer"],
      body: conditional(
        binary(
          FunctionalBinaryOperator.StructuralEqual,
          reference("bindingName", span),
          reference("name", span),
          span,
        ),
        call(JAVASCRIPT_BINDING_REFERENCE, [
          reference("bindingIdentity", span),
          reference("strict", span),
        ], span),
        call(RESOLVE_ENVIRONMENT_REFERENCE, [
          reference("outer", span),
          reference("name", span),
          reference("strict", span),
        ], span),
        span,
      ),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE,
    parameters: ["state", "resolvedReference"],
    annotation: null,
    body: match(reference("resolvedReference", span), [{
      constructor: JAVASCRIPT_UNRESOLVABLE_REFERENCE,
      binders: ["name", "strict"],
      body: reference(JAVASCRIPT_VALUE_MISSING, span),
      span,
    }, {
      constructor: JAVASCRIPT_BINDING_REFERENCE,
      binders: ["bindingIdentity", "strict"],
      body: match(reference("state", span), [{
        constructor: JAVASCRIPT_STATE,
        binders: ["heap", "context", "bindings"],
        body: match(reference("bindings", span), [{
          constructor: JAVASCRIPT_BINDING_STORE,
          binders: ["nextIdentity", "cells"],
          body: call(LOOKUP_BINDING_CELL, [
            reference("cells", span),
            reference("bindingIdentity", span),
          ], span),
          span,
        }], span),
        span,
      }], span),
      span,
    }, {
      constructor: JAVASCRIPT_PROPERTY_REFERENCE,
      binders: ["base", "key", "receiver", "strict"],
      body: getPropertyReferenceValue(span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE,
    parameters: ["state", "resolvedReference", "value"],
    annotation: null,
    body: match(reference("resolvedReference", span), [{
      constructor: JAVASCRIPT_UNRESOLVABLE_REFERENCE,
      binders: ["name", "strict"],
      body: reference(JAVASCRIPT_REFERENCE_UPDATE_UNRESOLVABLE, span),
      span,
    }, {
      constructor: JAVASCRIPT_BINDING_REFERENCE,
      binders: ["bindingIdentity", "strict"],
      body: call(PUT_BINDING_REFERENCE_VALUE, [
        reference("state", span),
        reference("bindingIdentity", span),
        reference("value", span),
      ], span),
      span,
    }, {
      constructor: JAVASCRIPT_PROPERTY_REFERENCE,
      binders: ["base", "key", "receiver", "strict"],
      body: match(reference("base", span), [{
        constructor: JAVASCRIPT_VALUE_OBJECT,
        binders: ["baseIdentity"],
        body: call(PUT_OBJECT_PROPERTY, [
          reference("state", span),
          reference("baseIdentity", span),
          reference("key", span),
          reference("receiver", span),
          reference("value", span),
        ], span),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_UNDEFINED,
        binders: [],
        body: reference(JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE, span),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_NULL,
        binders: [],
        body: reference(JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE, span),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_BOOLEAN,
        binders: ["booleanValue"],
        body: reference(JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE, span),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_NUMBER,
        binders: ["numberValue"],
        body: reference(JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE, span),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_STRING,
        binders: ["stringValue"],
        body: reference(JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE, span),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_SYMBOL,
        binders: ["symbolIdentity"],
        body: reference(JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE, span),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    name: PUT_BINDING_REFERENCE_VALUE,
    parameters: ["state", "bindingIdentity", "value"],
    annotation: null,
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: match(reference("bindings", span), [{
        constructor: JAVASCRIPT_BINDING_STORE,
        binders: ["nextIdentity", "cells"],
        body: conditional(
          binary(
            FunctionalBinaryOperator.Less,
            reference("bindingIdentity", span),
            integer(0, span),
            span,
          ),
          runtimeFault("JavaScript reference contains a negative binding identity", span),
          conditional(
            binary(
              FunctionalBinaryOperator.Less,
              reference("bindingIdentity", span),
              storeLength(reference("cells", span), span),
              span,
            ),
            match(
              storeRead(
                reference("cells", span),
                reference("bindingIdentity", span),
                span,
              ),
              [{
                constructor: JAVASCRIPT_BINDING_UNINITIALIZED,
                binders: ["mutable"],
                body: reference(JAVASCRIPT_REFERENCE_UPDATE_UNINITIALIZED, span),
                span,
              }, {
                constructor: JAVASCRIPT_BINDING_IMMUTABLE,
                binders: ["existingValue"],
                body: reference(JAVASCRIPT_REFERENCE_UPDATE_IMMUTABLE, span),
                span,
              }, {
                constructor: JAVASCRIPT_BINDING_MUTABLE,
                binders: ["existingValue"],
                body: call(JAVASCRIPT_REFERENCE_UPDATE_UPDATED, [call(JAVASCRIPT_STATE, [
                  reference("heap", span),
                  reference("context", span),
                  call(JAVASCRIPT_BINDING_STORE, [
                    reference("nextIdentity", span),
                    storeWrite(
                      reference("cells", span),
                      reference("bindingIdentity", span),
                      call(JAVASCRIPT_BINDING_MUTABLE, [reference("value", span)], span),
                      span,
                    ),
                  ], span),
                ], span)], span),
                span,
              }],
              span,
            ),
            runtimeFault("JavaScript reference contains a missing binding identity", span),
            span,
          ),
          span,
        ),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    name: PUT_OBJECT_PROPERTY,
    parameters: ["state", "baseIdentity", "key", "receiver", "value"],
    annotation: null,
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: match(reference("heap", span), [{
        constructor: JAVASCRIPT_HEAP,
        binders: ["nextIdentity", "objects"],
        body: match(
          call(LOOKUP_OBJECT, [
            reference("objects", span),
            reference("baseIdentity", span),
          ], span),
          [{
            constructor: JAVASCRIPT_OBJECT_RECORD,
            binders: ["prototype", "extensible", "objectKind", "properties"],
            body: match(
              call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY_DESCRIPTOR, [
                reference("properties", span),
                reference("key", span),
              ], span),
              [{
                constructor: JAVASCRIPT_DESCRIPTOR_MISSING,
                binders: [],
                body: match(reference("prototype", span), [{
                  constructor: JAVASCRIPT_VALUE_NULL,
                  binders: [],
                  body: call(PUT_RECEIVER_DATA_PROPERTY, [
                    reference("state", span),
                    reference("receiver", span),
                    reference("key", span),
                    reference("value", span),
                  ], span),
                  span,
                }, {
                  constructor: JAVASCRIPT_VALUE_OBJECT,
                  binders: ["prototypeIdentity"],
                  body: call(PUT_OBJECT_PROPERTY, [
                    reference("state", span),
                    reference("prototypeIdentity", span),
                    reference("key", span),
                    reference("receiver", span),
                    reference("value", span),
                  ], span),
                  span,
                }, ...invalidPrototypeArms(span)], span),
                span,
              }, {
                constructor: JAVASCRIPT_DESCRIPTOR_FOUND,
                binders: ["descriptor"],
                body: match(reference("descriptor", span), [{
                  constructor: JAVASCRIPT_DATA_DESCRIPTOR,
                  binders: ["existingValue", "writable", "enumerable", "configurable"],
                  body: conditional(
                    reference("writable", span),
                    call(PUT_RECEIVER_DATA_PROPERTY, [
                      reference("state", span),
                      reference("receiver", span),
                      reference("key", span),
                      reference("value", span),
                    ], span),
                    reference(JAVASCRIPT_REFERENCE_UPDATE_NON_WRITABLE, span),
                    span,
                  ),
                  span,
                }, {
                  constructor: JAVASCRIPT_ACCESSOR_DESCRIPTOR,
                  binders: ["getter", "setter", "enumerable", "configurable"],
                  body: match(reference("setter", span), [{
                    constructor: JAVASCRIPT_VALUE_UNDEFINED,
                    binders: [],
                    body: reference(JAVASCRIPT_REFERENCE_UPDATE_MISSING_SETTER, span),
                    span,
                  }, {
                    constructor: JAVASCRIPT_VALUE_OBJECT,
                    binders: ["setterIdentity"],
                    body: call(JAVASCRIPT_REFERENCE_UPDATE_ACCESSOR, [
                      reference("state", span),
                      reference("setter", span),
                      reference("receiver", span),
                      reference("value", span),
                    ], span),
                    span,
                  }, {
                    constructor: JAVASCRIPT_VALUE_NULL,
                    binders: [],
                    body: runtimeFault(
                      "JavaScript property descriptor has a non-callable setter",
                      span,
                    ),
                    span,
                  }, {
                    constructor: JAVASCRIPT_VALUE_BOOLEAN,
                    binders: ["booleanValue"],
                    body: runtimeFault(
                      "JavaScript property descriptor has a non-callable setter",
                      span,
                    ),
                    span,
                  }, {
                    constructor: JAVASCRIPT_VALUE_NUMBER,
                    binders: ["numberValue"],
                    body: runtimeFault(
                      "JavaScript property descriptor has a non-callable setter",
                      span,
                    ),
                    span,
                  }, {
                    constructor: JAVASCRIPT_VALUE_STRING,
                    binders: ["stringValue"],
                    body: runtimeFault(
                      "JavaScript property descriptor has a non-callable setter",
                      span,
                    ),
                    span,
                  }, {
                    constructor: JAVASCRIPT_VALUE_SYMBOL,
                    binders: ["symbolIdentity"],
                    body: runtimeFault(
                      "JavaScript property descriptor has a non-callable setter",
                      span,
                    ),
                    span,
                  }], span),
                  span,
                }], span),
                span,
              }],
              span,
            ),
            span,
          }],
          span,
        ),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    name: PUT_RECEIVER_DATA_PROPERTY,
    parameters: ["state", "receiver", "key", "value"],
    annotation: null,
    body: putReceiverDataProperty(span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_LOOKUP_BINDING,
    parameters: ["state", "name"],
    annotation: null,
    body: call(JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE, [
      reference("state", span),
      call(JAVASCRIPT_RUNTIME_RESOLVE_BINDING_REFERENCE, [
        reference("state", span),
        reference("name", span),
        boolean(false, span),
      ], span),
    ], span),
    span,
  }, {
    name: LOOKUP_BINDING_CELL,
    parameters: ["cells", "identity"],
    annotation: null,
    body: conditional(
      binary(
        FunctionalBinaryOperator.Less,
        reference("identity", span),
        storeLength(reference("cells", span), span),
        span,
      ),
      match(storeRead(reference("cells", span), reference("identity", span), span), [{
        constructor: JAVASCRIPT_BINDING_UNINITIALIZED,
        binders: ["mutable"],
        body: reference(JAVASCRIPT_VALUE_UNINITIALIZED, span),
        span,
      }, {
        constructor: JAVASCRIPT_BINDING_IMMUTABLE,
        binders: ["value"],
        body: call(JAVASCRIPT_VALUE_FOUND, [reference("value", span)], span),
        span,
      }, {
        constructor: JAVASCRIPT_BINDING_MUTABLE,
        binders: ["value"],
        body: call(JAVASCRIPT_VALUE_FOUND, [reference("value", span)], span),
        span,
      }], span),
      runtimeFault("JavaScript environment references a missing binding cell", span),
      span,
    ),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_DEFINE_BINDING,
    parameters: ["state", "name", "binding"],
    annotation: null,
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: match(reference("bindings", span), [{
        constructor: JAVASCRIPT_BINDING_STORE,
        binders: ["nextIdentity", "cells"],
        body: conditional(
          binary(
            FunctionalBinaryOperator.Equal,
            reference("nextIdentity", span),
            integer(JAVASCRIPT_MAXIMUM_BINDING_COUNT, span),
            span,
          ),
          runtimeFault("JavaScript binding identity space is exhausted", span),
          call(JAVASCRIPT_STATE, [
            reference("heap", span),
            call(WITH_LEXICAL_ENVIRONMENT, [
              reference("context", span),
              call(JAVASCRIPT_ENVIRONMENT_BINDING, [
                reference("name", span),
                reference("nextIdentity", span),
                call(JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT, [reference("context", span)], span),
              ], span),
            ], span),
            call(JAVASCRIPT_BINDING_STORE, [
              binary(
                FunctionalBinaryOperator.Add,
                reference("nextIdentity", span),
                integer(1, span),
                span,
              ),
              storeGrow(
                reference("cells", span),
                binary(
                  FunctionalBinaryOperator.Add,
                  reference("nextIdentity", span),
                  integer(1, span),
                  span,
                ),
                reference("binding", span),
                span,
              ),
            ], span),
          ], span),
          span,
        ),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_INITIALIZE_BINDING,
    parameters: ["state", "name", "value"],
    annotation: null,
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: call(INITIALIZE_ENVIRONMENT_BINDING, [
        reference("heap", span),
        reference("context", span),
        call(JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT, [reference("context", span)], span),
        reference("bindings", span),
        reference("name", span),
        reference("value", span),
      ], span),
      span,
    }], span),
    span,
  }, {
    name: INITIALIZE_ENVIRONMENT_BINDING,
    parameters: ["heap", "context", "environment", "bindings", "name", "value"],
    annotation: null,
    body: match(reference("environment", span), [{
      constructor: JAVASCRIPT_ENVIRONMENT_EMPTY,
      binders: [],
      body: reference(JAVASCRIPT_BINDING_UPDATE_NOT_FOUND, span),
      span,
    }, {
      constructor: JAVASCRIPT_ENVIRONMENT_BINDING,
      binders: ["bindingName", "bindingIdentity", "outer"],
      body: conditional(
        binary(
          FunctionalBinaryOperator.StructuralEqual,
          reference("bindingName", span),
          reference("name", span),
          span,
        ),
        match(reference("bindings", span), [{
          constructor: JAVASCRIPT_BINDING_STORE,
          binders: ["nextIdentity", "cells"],
          body: call(INITIALIZE_BINDING_CELL, [
            reference("heap", span),
            reference("context", span),
            reference("nextIdentity", span),
            reference("cells", span),
            reference("cells", span),
            reference("bindingIdentity", span),
            reference("value", span),
          ], span),
          span,
        }], span),
        call(INITIALIZE_ENVIRONMENT_BINDING, [
          reference("heap", span),
          reference("context", span),
          reference("outer", span),
          reference("bindings", span),
          reference("name", span),
          reference("value", span),
        ], span),
        span,
      ),
      span,
    }], span),
    span,
  }, {
    name: INITIALIZE_BINDING_CELL,
    parameters: ["heap", "context", "nextIdentity", "allCells", "cells", "identity", "value"],
    annotation: null,
    body: match(storeRead(reference("cells", span), reference("identity", span), span), [{
      constructor: JAVASCRIPT_BINDING_UNINITIALIZED,
      binders: ["mutable"],
      body: call(JAVASCRIPT_BINDING_UPDATE_UPDATED, [call(JAVASCRIPT_STATE, [
        reference("heap", span),
        reference("context", span),
        call(JAVASCRIPT_BINDING_STORE, [
          reference("nextIdentity", span),
          storeWrite(
            reference("allCells", span),
            reference("identity", span),
            conditional(
              reference("mutable", span),
              call(JAVASCRIPT_BINDING_MUTABLE, [reference("value", span)], span),
              call(JAVASCRIPT_BINDING_IMMUTABLE, [reference("value", span)], span),
              span,
            ),
            span,
          ),
        ], span),
      ], span)], span),
      span,
    }, {
      constructor: JAVASCRIPT_BINDING_IMMUTABLE,
      binders: ["existingValue"],
      body: reference(JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED, span),
      span,
    }, {
      constructor: JAVASCRIPT_BINDING_MUTABLE,
      binders: ["existingValue"],
      body: reference(JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED, span),
      span,
    }], span),
    span,
  }, {
    name: JAVASCRIPT_RUNTIME_SET_BINDING,
    parameters: ["state", "name", "value"],
    annotation: null,
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: call(SET_ENVIRONMENT_BINDING, [
        reference("heap", span),
        reference("context", span),
        call(JAVASCRIPT_RUNTIME_LEXICAL_ENVIRONMENT, [reference("context", span)], span),
        reference("bindings", span),
        reference("name", span),
        reference("value", span),
      ], span),
      span,
    }], span),
    span,
  }, {
    name: SET_ENVIRONMENT_BINDING,
    parameters: ["heap", "context", "environment", "bindings", "name", "value"],
    annotation: null,
    body: match(reference("environment", span), [{
      constructor: JAVASCRIPT_ENVIRONMENT_EMPTY,
      binders: [],
      body: reference(JAVASCRIPT_BINDING_UPDATE_NOT_FOUND, span),
      span,
    }, {
      constructor: JAVASCRIPT_ENVIRONMENT_BINDING,
      binders: ["bindingName", "bindingIdentity", "outer"],
      body: conditional(
        binary(
          FunctionalBinaryOperator.StructuralEqual,
          reference("bindingName", span),
          reference("name", span),
          span,
        ),
        match(reference("bindings", span), [{
          constructor: JAVASCRIPT_BINDING_STORE,
          binders: ["nextIdentity", "cells"],
          body: call(SET_BINDING_CELL, [
            reference("heap", span),
            reference("context", span),
            reference("nextIdentity", span),
            reference("cells", span),
            reference("cells", span),
            reference("bindingIdentity", span),
            reference("value", span),
          ], span),
          span,
        }], span),
        call(SET_ENVIRONMENT_BINDING, [
          reference("heap", span),
          reference("context", span),
          reference("outer", span),
          reference("bindings", span),
          reference("name", span),
          reference("value", span),
        ], span),
        span,
      ),
      span,
    }], span),
    span,
  }, {
    name: SET_BINDING_CELL,
    parameters: ["heap", "context", "nextIdentity", "allCells", "cells", "identity", "value"],
    annotation: null,
    body: match(storeRead(reference("cells", span), reference("identity", span), span), [{
      constructor: JAVASCRIPT_BINDING_UNINITIALIZED,
      binders: ["mutable"],
      body: reference(JAVASCRIPT_BINDING_UPDATE_UNINITIALIZED, span),
      span,
    }, {
      constructor: JAVASCRIPT_BINDING_IMMUTABLE,
      binders: ["existingValue"],
      body: reference(JAVASCRIPT_BINDING_UPDATE_IMMUTABLE, span),
      span,
    }, {
      constructor: JAVASCRIPT_BINDING_MUTABLE,
      binders: ["existingValue"],
      body: call(JAVASCRIPT_BINDING_UPDATE_UPDATED, [call(JAVASCRIPT_STATE, [
        reference("heap", span),
        reference("context", span),
        call(JAVASCRIPT_BINDING_STORE, [
          reference("nextIdentity", span),
          storeWrite(
            reference("allCells", span),
            reference("identity", span),
            call(JAVASCRIPT_BINDING_MUTABLE, [reference("value", span)], span),
            span,
          ),
        ], span),
      ], span)], span),
      span,
    }], span),
    span,
  }];

  return {
    definitions,
    typeDeclarations: javascriptRuntimeTypeDeclarations(sourceByteLength),
  };
}

function lookupPrototypeProperty(
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return match(reference("prototype", span), [{
    constructor: JAVASCRIPT_VALUE_NULL,
    binders: [],
    body: reference(JAVASCRIPT_DESCRIPTOR_MISSING, span),
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_OBJECT,
    binders: ["prototypeIdentity"],
    body: call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY, [
      reference("objects", span),
      reference("prototypeIdentity", span),
      reference("key", span),
    ], span),
    span,
  }, ...invalidPrototypeArms(span)], span);
}

function putReceiverDataProperty(
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  const invalidReceiver = reference(JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE, span);
  return match(reference("receiver", span), [{
    constructor: JAVASCRIPT_VALUE_OBJECT,
    binders: ["receiverIdentity"],
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: match(reference("heap", span), [{
        constructor: JAVASCRIPT_HEAP,
        binders: ["nextIdentity", "objects"],
        body: match(
          call(LOOKUP_OBJECT, [
            reference("objects", span),
            reference("receiverIdentity", span),
          ], span),
          [{
            constructor: JAVASCRIPT_OBJECT_RECORD,
            binders: ["prototype", "extensible", "objectKind", "properties"],
            body: match(
              call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY_DESCRIPTOR, [
                reference("properties", span),
                reference("key", span),
              ], span),
              [{
                constructor: JAVASCRIPT_DESCRIPTOR_MISSING,
                binders: [],
                body: conditional(
                  reference("extensible", span),
                  updatedReceiverState(
                    call(JAVASCRIPT_DATA_DESCRIPTOR, [
                      reference("value", span),
                      boolean(true, span),
                      boolean(true, span),
                      boolean(true, span),
                    ], span),
                    span,
                  ),
                  reference(JAVASCRIPT_REFERENCE_UPDATE_NON_EXTENSIBLE, span),
                  span,
                ),
                span,
              }, {
                constructor: JAVASCRIPT_DESCRIPTOR_FOUND,
                binders: ["receiverDescriptor"],
                body: match(reference("receiverDescriptor", span), [{
                  constructor: JAVASCRIPT_DATA_DESCRIPTOR,
                  binders: [
                    "receiverValue",
                    "receiverWritable",
                    "receiverEnumerable",
                    "receiverConfigurable",
                  ],
                  body: conditional(
                    reference("receiverWritable", span),
                    updatedReceiverState(
                      call(JAVASCRIPT_DATA_DESCRIPTOR, [
                        reference("value", span),
                        reference("receiverWritable", span),
                        reference("receiverEnumerable", span),
                        reference("receiverConfigurable", span),
                      ], span),
                      span,
                    ),
                    reference(JAVASCRIPT_REFERENCE_UPDATE_NON_WRITABLE, span),
                    span,
                  ),
                  span,
                }, {
                  constructor: JAVASCRIPT_ACCESSOR_DESCRIPTOR,
                  binders: [
                    "receiverGetter",
                    "receiverSetter",
                    "receiverEnumerable",
                    "receiverConfigurable",
                  ],
                  body: reference(JAVASCRIPT_REFERENCE_UPDATE_NON_WRITABLE, span),
                  span,
                }], span),
                span,
              }],
              span,
            ),
            span,
          }],
          span,
        ),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_UNDEFINED,
    binders: [],
    body: invalidReceiver,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_NULL,
    binders: [],
    body: invalidReceiver,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_BOOLEAN,
    binders: ["booleanValue"],
    body: invalidReceiver,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_NUMBER,
    binders: ["numberValue"],
    body: invalidReceiver,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_STRING,
    binders: ["stringValue"],
    body: invalidReceiver,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_SYMBOL,
    binders: ["symbolIdentity"],
    body: invalidReceiver,
    span,
  }], span);
}

function updatedReceiverState(
  descriptor: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return call(JAVASCRIPT_REFERENCE_UPDATE_UPDATED, [call(JAVASCRIPT_STATE, [
    call(JAVASCRIPT_HEAP, [
      reference("nextIdentity", span),
      storeWrite(
        reference("objects", span),
        reference("receiverIdentity", span),
        call(JAVASCRIPT_OBJECT_RECORD, [
          reference("prototype", span),
          reference("extensible", span),
          reference("objectKind", span),
          call(DEFINE_PROPERTY_IN_LIST, [
            reference("properties", span),
            reference("key", span),
            descriptor,
          ], span),
        ], span),
        span,
      ),
    ], span),
    reference("context", span),
    reference("bindings", span),
  ], span)], span);
}

function getPropertyReferenceValue(
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  const invalidBase = runtimeFault("JavaScript property reference base is not an object", span);
  return match(reference("base", span), [{
    constructor: JAVASCRIPT_VALUE_OBJECT,
    binders: ["objectIdentity"],
    body: match(reference("state", span), [{
      constructor: JAVASCRIPT_STATE,
      binders: ["heap", "context", "bindings"],
      body: match(reference("heap", span), [{
        constructor: JAVASCRIPT_HEAP,
        binders: ["nextIdentity", "objects"],
        body: match(
          call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY, [
            reference("objects", span),
            reference("objectIdentity", span),
            reference("key", span),
          ], span),
          [{
            constructor: JAVASCRIPT_DESCRIPTOR_MISSING,
            binders: [],
            body: reference(JAVASCRIPT_VALUE_MISSING, span),
            span,
          }, {
            constructor: JAVASCRIPT_DESCRIPTOR_FOUND,
            binders: ["descriptor"],
            body: match(reference("descriptor", span), [{
              constructor: JAVASCRIPT_DATA_DESCRIPTOR,
              binders: ["value", "writable", "enumerable", "configurable"],
              body: call(JAVASCRIPT_VALUE_FOUND, [reference("value", span)], span),
              span,
            }, {
              constructor: JAVASCRIPT_ACCESSOR_DESCRIPTOR,
              binders: ["getter", "setter", "enumerable", "configurable"],
              body: match(reference("getter", span), [{
                constructor: JAVASCRIPT_VALUE_UNDEFINED,
                binders: [],
                body: call(JAVASCRIPT_VALUE_FOUND, [
                  reference(JAVASCRIPT_VALUE_UNDEFINED, span),
                ], span),
                span,
              }, {
                constructor: JAVASCRIPT_VALUE_OBJECT,
                binders: ["getterIdentity"],
                body: call(JAVASCRIPT_VALUE_ACCESSOR, [
                  reference("getter", span),
                  reference("receiver", span),
                ], span),
                span,
              }, {
                constructor: JAVASCRIPT_VALUE_NULL,
                binders: [],
                body: runtimeFault(
                  "JavaScript property descriptor has a non-callable getter",
                  span,
                ),
                span,
              }, {
                constructor: JAVASCRIPT_VALUE_BOOLEAN,
                binders: ["booleanValue"],
                body: runtimeFault(
                  "JavaScript property descriptor has a non-callable getter",
                  span,
                ),
                span,
              }, {
                constructor: JAVASCRIPT_VALUE_NUMBER,
                binders: ["numberValue"],
                body: runtimeFault(
                  "JavaScript property descriptor has a non-callable getter",
                  span,
                ),
                span,
              }, {
                constructor: JAVASCRIPT_VALUE_STRING,
                binders: ["stringValue"],
                body: runtimeFault(
                  "JavaScript property descriptor has a non-callable getter",
                  span,
                ),
                span,
              }, {
                constructor: JAVASCRIPT_VALUE_SYMBOL,
                binders: ["symbolIdentity"],
                body: runtimeFault(
                  "JavaScript property descriptor has a non-callable getter",
                  span,
                ),
                span,
              }], span),
              span,
            }], span),
            span,
          }],
          span,
        ),
        span,
      }], span),
      span,
    }], span),
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_UNDEFINED,
    binders: [],
    body: invalidBase,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_NULL,
    binders: [],
    body: invalidBase,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_BOOLEAN,
    binders: ["booleanValue"],
    body: invalidBase,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_NUMBER,
    binders: ["numberValue"],
    body: invalidBase,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_STRING,
    binders: ["stringValue"],
    body: invalidBase,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_SYMBOL,
    binders: ["symbolIdentity"],
    body: invalidBase,
    span,
  }], span);
}

function allocateObjectResult(
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return call(JAVASCRIPT_HEAP_ALLOCATION, [
    call(JAVASCRIPT_HEAP, [
      binary(
        FunctionalBinaryOperator.Add,
        reference("nextIdentity", span),
        integer(1, span),
        span,
      ),
      storeGrow(
        reference("objects", span),
        binary(
          FunctionalBinaryOperator.Add,
          reference("nextIdentity", span),
          integer(1, span),
          span,
        ),
        call(JAVASCRIPT_OBJECT_RECORD, [
          reference("prototype", span),
          boolean(true, span),
          reference("objectKind", span),
          reference(JAVASCRIPT_PROPERTY_LIST_EMPTY, span),
        ], span),
        span,
      ),
    ], span),
    call(JAVASCRIPT_VALUE_OBJECT, [reference("nextIdentity", span)], span),
  ], span);
}

function invalidPrototypeArms(
  span: { readonly startByte: number; readonly endByte: number },
): readonly FunctionalSurfaceCaseArm[] {
  const invalid = runtimeFault("JavaScript object prototype must be null or an object", span);
  return [
    { constructor: "$javascript#Undefined", binders: [], body: invalid, span },
    { constructor: "$javascript#Boolean", binders: ["booleanValue"], body: invalid, span },
    { constructor: "$javascript#Number", binders: ["numberValue"], body: invalid, span },
    { constructor: "$javascript#String", binders: ["stringValue"], body: invalid, span },
    { constructor: "$javascript#Symbol", binders: ["symbolIdentity"], body: invalid, span },
  ];
}

function defaultObjectRecord(
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return call(JAVASCRIPT_OBJECT_RECORD, [
    reference(JAVASCRIPT_VALUE_NULL, span),
    boolean(true, span),
    reference(JAVASCRIPT_OBJECT_ORDINARY, span),
    reference(JAVASCRIPT_PROPERTY_LIST_EMPTY, span),
  ], span);
}

function compareMatchingValueKind(
  right: FunctionalSurfaceExpression,
  matchingConstructor: string,
  matchingComparison: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  const valueKinds = [
    { constructor: JAVASCRIPT_VALUE_UNDEFINED, carriesValue: false },
    { constructor: JAVASCRIPT_VALUE_NULL, carriesValue: false },
    { constructor: JAVASCRIPT_VALUE_BOOLEAN, carriesValue: true },
    { constructor: JAVASCRIPT_VALUE_NUMBER, carriesValue: true },
    { constructor: JAVASCRIPT_VALUE_STRING, carriesValue: true },
    { constructor: JAVASCRIPT_VALUE_SYMBOL, carriesValue: true },
    { constructor: JAVASCRIPT_VALUE_OBJECT, carriesValue: true },
  ];
  return match(
    right,
    valueKinds.map(({ constructor, carriesValue }) => ({
      constructor,
      binders: carriesValue ? ["matchingValue"] : [],
      body: constructor === matchingConstructor ? matchingComparison : boolean(false, span),
      span,
    })),
    span,
  );
}

function sameNumberValue(
  left: FunctionalSurfaceExpression,
  right: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return conditional(
    binary(FunctionalBinaryOperator.EqualFloat64, left, right, span),
    binary(
      FunctionalBinaryOperator.EqualFloat64,
      binary(
        FunctionalBinaryOperator.DivideFloat64,
        { kind: "float-64", value: 1, span },
        left,
        span,
      ),
      binary(
        FunctionalBinaryOperator.DivideFloat64,
        { kind: "float-64", value: 1, span },
        right,
        span,
      ),
      span,
    ),
    conditional(
      binary(FunctionalBinaryOperator.NotEqualFloat64, left, left, span),
      binary(FunctionalBinaryOperator.NotEqualFloat64, right, right, span),
      boolean(false, span),
      span,
    ),
    span,
  );
}

function reference(
  name: string,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "name", name, span };
}

function integer(
  value: number,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "integer", value, span };
}

function boolean(
  value: boolean,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "boolean", value, span };
}

function call(
  calleeName: string,
  arguments_: readonly FunctionalSurfaceExpression[],
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  let expression = reference(calleeName, span);
  for (const argument of arguments_) {
    expression = { kind: "apply", callee: expression, argument, span };
  }
  return expression;
}

function binary(
  operator: FunctionalBinaryOperator,
  left: FunctionalSurfaceExpression,
  right: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "binary", operator, left, right, span };
}

function storeNew(
  length: FunctionalSurfaceExpression,
  initial: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "store-new", length, initial, span };
}

function storeLength(
  store: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "store-length", store, span };
}

function storeRead(
  store: FunctionalSurfaceExpression,
  index: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "store-read", store, index, span };
}

function storeWrite(
  store: FunctionalSurfaceExpression,
  index: FunctionalSurfaceExpression,
  value: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "store-write", store, index, value, span };
}

function storeGrow(
  store: FunctionalSurfaceExpression,
  length: FunctionalSurfaceExpression,
  initial: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "store-grow", store, length, initial, span };
}

function conditional(
  condition: FunctionalSurfaceExpression,
  consequent: FunctionalSurfaceExpression,
  alternate: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "if", condition, consequent, alternate, span };
}

function letExpression(
  name: string,
  value: FunctionalSurfaceExpression,
  body: FunctionalSurfaceExpression,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "let", name, value, body, span };
}

function match(
  value: FunctionalSurfaceExpression,
  arms: readonly FunctionalSurfaceCaseArm[],
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "case", value, arms, span };
}

function runtimeFault(
  message: string,
  span: { readonly startByte: number; readonly endByte: number },
): FunctionalSurfaceExpression {
  return { kind: "runtime-fault", message, span };
}
