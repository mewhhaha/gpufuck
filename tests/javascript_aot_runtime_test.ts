import { deepStrictEqual, ok, rejects } from "node:assert/strict";

import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../functional.ts";
import {
  JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT,
  JAVASCRIPT_RUNTIME_DEFINE_BINDING,
  JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED,
  JAVASCRIPT_RUNTIME_EMPTY_HEAP,
  JAVASCRIPT_RUNTIME_EMPTY_STATE,
  JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE,
  JAVASCRIPT_RUNTIME_LOOKUP_BINDING,
  JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY,
  JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE,
  JAVASCRIPT_RUNTIME_RESOLVE_BINDING_REFERENCE,
  JAVASCRIPT_RUNTIME_SAME_VALUE,
  JAVASCRIPT_RUNTIME_SET_BINDING,
  JAVASCRIPT_RUNTIME_STRICT_EQUAL,
  javascriptRuntimeSurface,
} from "../examples/javascript-aot/src/runtime.ts";
import {
  JAVASCRIPT_ACCESSOR_DESCRIPTOR,
  JAVASCRIPT_BINDING_MUTABLE,
  JAVASCRIPT_BINDING_REFERENCE,
  JAVASCRIPT_BINDING_STORE,
  JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED,
  JAVASCRIPT_BINDING_UPDATE_IMMUTABLE,
  JAVASCRIPT_BINDING_UPDATE_NOT_FOUND,
  JAVASCRIPT_BINDING_UPDATE_UNINITIALIZED,
  JAVASCRIPT_BINDING_UPDATE_UPDATED,
  JAVASCRIPT_COMPLETION_BREAK,
  JAVASCRIPT_COMPLETION_CONTINUE,
  JAVASCRIPT_COMPLETION_NORMAL,
  JAVASCRIPT_COMPLETION_RETURN,
  JAVASCRIPT_COMPLETION_THROW,
  JAVASCRIPT_DATA_DESCRIPTOR,
  JAVASCRIPT_DESCRIPTOR_FOUND,
  JAVASCRIPT_DESCRIPTOR_MISSING,
  JAVASCRIPT_ENVIRONMENT_EMPTY,
  JAVASCRIPT_EXECUTION_CONTEXT,
  JAVASCRIPT_HEAP,
  JAVASCRIPT_HEAP_ALLOCATION,
  JAVASCRIPT_MAXIMUM_BINDING_COUNT,
  JAVASCRIPT_MAXIMUM_OBJECT_COUNT,
  JAVASCRIPT_OBJECT_ORDINARY,
  JAVASCRIPT_OBJECT_RECORD,
  JAVASCRIPT_PROPERTY_KEY_STRING,
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
} from "../examples/javascript-aot/src/runtime_contract.ts";
import { buildFunctionalSurfaceModule } from "../src/functional/surface_builder.ts";
import type {
  FunctionalSurfaceCaseArm,
  FunctionalSurfaceExpression,
} from "../src/functional/surface_builder.ts";

const span = { startByte: 0, endByte: 0 };
let device: GPUDevice | undefined;
let compiler: GpuFunctionalCompiler | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  compiler = await GpuFunctionalCompiler.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  compiler = undefined;
});

Deno.test("JavaScript runtime strict equality distinguishes object identities", async () => {
  const sameObject = call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [
    call(JAVASCRIPT_VALUE_OBJECT, [integer(7)]),
    call(JAVASCRIPT_VALUE_OBJECT, [integer(7)]),
  ]);
  const differentObject = call(JAVASCRIPT_RUNTIME_STRICT_EQUAL, [
    call(JAVASCRIPT_VALUE_OBJECT, [integer(7)]),
    call(JAVASCRIPT_VALUE_OBJECT, [integer(8)]),
  ]);
  const sameNaN = call(JAVASCRIPT_RUNTIME_SAME_VALUE, [
    call(JAVASCRIPT_VALUE_NUMBER, [float64(Number.NaN)]),
    call(JAVASCRIPT_VALUE_NUMBER, [float64(Number.NaN)]),
  ]);
  const differentZero = call(JAVASCRIPT_RUNTIME_SAME_VALUE, [
    call(JAVASCRIPT_VALUE_NUMBER, [float64(0)]),
    call(JAVASCRIPT_VALUE_NUMBER, [float64(-0)]),
  ]);
  const result = conditional(
    sameObject,
    conditional(
      differentObject,
      float64(0),
      conditional(sameNaN, conditional(differentZero, float64(0), float64(42)), float64(0)),
    ),
    float64(0),
  );

  deepStrictEqual(await compileAndRun(result), { kind: "float-64", value: 42 });
});

Deno.test("JavaScript runtime state starts with an execution context and realm global object", async () => {
  const result = match(reference(JAVASCRIPT_RUNTIME_EMPTY_STATE), [{
    constructor: JAVASCRIPT_STATE,
    binders: ["heap", "context", "bindings"],
    body: match(reference("context"), [{
      constructor: JAVASCRIPT_EXECUTION_CONTEXT,
      binders: ["realm", "lexicalEnvironment", "variableEnvironment", "thisValue"],
      body: match(reference("realm"), [{
        constructor: JAVASCRIPT_REALM,
        binders: ["globalObject"],
        body: expectObject("globalObject", "globalObjectIdentity", () => float64(42)),
        span,
      }]),
      span,
    }]),
    span,
  }]);

  deepStrictEqual(await compileAndRun(result), { kind: "float-64", value: 42 });
});

Deno.test("JavaScript runtime property lookup follows object prototypes", async () => {
  const inheritedKey = call(JAVASCRIPT_PROPERTY_KEY_STRING, [text("inherited")]);
  const inheritedDescriptor = call(JAVASCRIPT_DATA_DESCRIPTOR, [
    call(JAVASCRIPT_VALUE_NUMBER, [float64(42)]),
    boolean(true),
    boolean(true),
    boolean(true),
  ]);
  const result = letExpression(
    "prototypeAllocation",
    call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
      reference(JAVASCRIPT_RUNTIME_EMPTY_HEAP),
      reference(JAVASCRIPT_VALUE_NULL),
      reference(JAVASCRIPT_OBJECT_ORDINARY),
    ]),
    match(reference("prototypeAllocation"), [{
      constructor: JAVASCRIPT_HEAP_ALLOCATION,
      binders: ["prototypeHeap", "prototypeValue"],
      body: expectObject(
        "prototypeValue",
        "prototypeIdentity",
        (prototypeIdentity) =>
          letExpression(
            "heapWithInheritedProperty",
            call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
              reference("prototypeHeap"),
              prototypeIdentity,
              inheritedKey,
              inheritedDescriptor,
            ]),
            letExpression(
              "childAllocation",
              call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
                reference("heapWithInheritedProperty"),
                reference("prototypeValue"),
                reference(JAVASCRIPT_OBJECT_ORDINARY),
              ]),
              match(reference("childAllocation"), [{
                constructor: JAVASCRIPT_HEAP_ALLOCATION,
                binders: ["childHeap", "childValue"],
                body: expectObject("childValue", "childIdentity", (childIdentity) =>
                  match(reference("childHeap"), [{
                    constructor: JAVASCRIPT_HEAP,
                    binders: ["nextIdentity", "objects"],
                    body: match(
                      call(JAVASCRIPT_RUNTIME_LOOKUP_PROPERTY, [
                        reference("objects"),
                        childIdentity,
                        inheritedKey,
                      ]),
                      [{
                        constructor: JAVASCRIPT_DESCRIPTOR_MISSING,
                        binders: [],
                        body: fault("inherited property was not found"),
                        span,
                      }, {
                        constructor: JAVASCRIPT_DESCRIPTOR_FOUND,
                        binders: ["descriptor"],
                        body: match(reference("descriptor"), [{
                          constructor: JAVASCRIPT_DATA_DESCRIPTOR,
                          binders: ["value", "writable", "enumerable", "configurable"],
                          body: expectNumber("value"),
                          span,
                        }, {
                          constructor: JAVASCRIPT_ACCESSOR_DESCRIPTOR,
                          binders: ["getter", "setter", "enumerable", "configurable"],
                          body: fault("inherited property unexpectedly became an accessor"),
                          span,
                        }]),
                        span,
                      }],
                    ),
                    span,
                  }])),
                span,
              }]),
            ),
          ),
      ),
      span,
    }]),
  );

  deepStrictEqual(await compileAndRun(result), { kind: "float-64", value: 42 });
});

Deno.test("JavaScript runtime environments and completions preserve updated values", async () => {
  const state = call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
    reference(JAVASCRIPT_RUNTIME_EMPTY_STATE),
    text("answer"),
    call(JAVASCRIPT_BINDING_MUTABLE, [call(JAVASCRIPT_VALUE_NUMBER, [float64(40)])]),
  ]);
  const result = match(
    call(JAVASCRIPT_RUNTIME_SET_BINDING, [
      state,
      text("answer"),
      call(JAVASCRIPT_VALUE_NUMBER, [float64(42)]),
    ]),
    environmentUpdateArms(),
  );

  deepStrictEqual(await compileAndRun(result), { kind: "float-64", value: 42 });
});

Deno.test("JavaScript binding resolution produces explicit Reference records", async () => {
  const state = call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
    reference(JAVASCRIPT_RUNTIME_EMPTY_STATE),
    text("answer"),
    call(JAVASCRIPT_BINDING_MUTABLE, [call(JAVASCRIPT_VALUE_NUMBER, [float64(42)])]),
  ]);
  const resolved = call(JAVASCRIPT_RUNTIME_RESOLVE_BINDING_REFERENCE, [
    state,
    text("answer"),
    boolean(true),
  ]);
  const result = match(resolved, [{
    constructor: JAVASCRIPT_UNRESOLVABLE_REFERENCE,
    binders: ["name", "strict"],
    body: fault("defined binding resolved as unresolvable"),
    span,
  }, {
    constructor: JAVASCRIPT_BINDING_REFERENCE,
    binders: ["bindingIdentity", "strict"],
    body: match(
      call(JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE, [
        state,
        call(JAVASCRIPT_BINDING_REFERENCE, [
          reference("bindingIdentity"),
          reference("strict"),
        ]),
      ]),
      [{
        constructor: JAVASCRIPT_VALUE_MISSING,
        binders: [],
        body: fault("resolved binding lost its value"),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_UNINITIALIZED,
        binders: [],
        body: fault("resolved binding became uninitialized"),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_FOUND,
        binders: ["value"],
        body: expectNumber("value"),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_ACCESSOR,
        binders: ["getter", "receiver"],
        body: fault("binding lookup requested an accessor call"),
        span,
      }],
    ),
    span,
  }, {
    constructor: JAVASCRIPT_PROPERTY_REFERENCE,
    binders: ["base", "key", "receiver", "strict"],
    body: fault("binding resolved as a property reference"),
    span,
  }]);

  deepStrictEqual(await compileAndRun(result), { kind: "float-64", value: 42 });
});

Deno.test("JavaScript Reference writes update the resolved binding cell", async () => {
  const state = call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
    reference(JAVASCRIPT_RUNTIME_EMPTY_STATE),
    text("answer"),
    call(JAVASCRIPT_BINDING_MUTABLE, [call(JAVASCRIPT_VALUE_NUMBER, [float64(40)])]),
  ]);
  const resolved = call(JAVASCRIPT_RUNTIME_RESOLVE_BINDING_REFERENCE, [
    state,
    text("answer"),
    boolean(true),
  ]);
  const result = match(
    call(JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE, [
      state,
      resolved,
      call(JAVASCRIPT_VALUE_NUMBER, [float64(42)]),
    ]),
    expectUpdatedReference((updatedState) =>
      match(
        call(JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE, [updatedState, resolved]),
        [{
          constructor: JAVASCRIPT_VALUE_MISSING,
          binders: [],
          body: fault("updated Reference lost its binding"),
          span,
        }, {
          constructor: JAVASCRIPT_VALUE_UNINITIALIZED,
          binders: [],
          body: fault("updated Reference became uninitialized"),
          span,
        }, {
          constructor: JAVASCRIPT_VALUE_FOUND,
          binders: ["value"],
          body: expectNumber("value"),
          span,
        }, {
          constructor: JAVASCRIPT_VALUE_ACCESSOR,
          binders: ["getter", "receiver"],
          body: fault("binding Reference requested an accessor call"),
          span,
        }],
      )
    ),
  );

  deepStrictEqual(await compileAndRun(result), { kind: "float-64", value: 42 });
});

Deno.test("JavaScript Reference writes create checked data properties", async () => {
  const key = call(JAVASCRIPT_PROPERTY_KEY_STRING, [text("answer")]);
  const result = match(
    call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
      reference(JAVASCRIPT_RUNTIME_EMPTY_HEAP),
      reference(JAVASCRIPT_VALUE_NULL),
      reference(JAVASCRIPT_OBJECT_ORDINARY),
    ]),
    [{
      constructor: JAVASCRIPT_HEAP_ALLOCATION,
      binders: ["heap", "object"],
      body: letExpression(
        "state",
        stateWithEmptyBindings(reference("heap")),
        letExpression(
          "propertyReference",
          call(JAVASCRIPT_PROPERTY_REFERENCE, [
            reference("object"),
            key,
            reference("object"),
            boolean(true),
          ]),
          match(
            call(JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE, [
              reference("state"),
              reference("propertyReference"),
              call(JAVASCRIPT_VALUE_NUMBER, [float64(42)]),
            ]),
            expectUpdatedReference((updatedState) =>
              match(
                call(JAVASCRIPT_RUNTIME_GET_REFERENCE_VALUE, [
                  updatedState,
                  reference("propertyReference"),
                ]),
                [{
                  constructor: JAVASCRIPT_VALUE_MISSING,
                  binders: [],
                  body: fault("created property was not found"),
                  span,
                }, {
                  constructor: JAVASCRIPT_VALUE_UNINITIALIZED,
                  binders: [],
                  body: fault("created property was uninitialized"),
                  span,
                }, {
                  constructor: JAVASCRIPT_VALUE_FOUND,
                  binders: ["value"],
                  body: expectNumber("value"),
                  span,
                }, {
                  constructor: JAVASCRIPT_VALUE_ACCESSOR,
                  binders: ["getter", "receiver"],
                  body: fault("data property requested an accessor call"),
                  span,
                }],
              )
            ),
          ),
        ),
      ),
      span,
    }],
  );

  deepStrictEqual(await compileAndRun(result), { kind: "float-64", value: 42 });
});

Deno.test("JavaScript Reference writes reject inherited non-writable properties", async () => {
  const key = call(JAVASCRIPT_PROPERTY_KEY_STRING, [text("fixed")]);
  const descriptor = call(JAVASCRIPT_DATA_DESCRIPTOR, [
    call(JAVASCRIPT_VALUE_NUMBER, [float64(41)]),
    boolean(false),
    boolean(true),
    boolean(true),
  ]);
  const result = match(
    call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
      reference(JAVASCRIPT_RUNTIME_EMPTY_HEAP),
      reference(JAVASCRIPT_VALUE_NULL),
      reference(JAVASCRIPT_OBJECT_ORDINARY),
    ]),
    [{
      constructor: JAVASCRIPT_HEAP_ALLOCATION,
      binders: ["prototypeHeap", "prototype"],
      body: expectObject("prototype", "prototypeIdentity", (prototypeIdentity) =>
        letExpression(
          "heapWithFixedProperty",
          call(JAVASCRIPT_RUNTIME_DEFINE_OWN_PROPERTY_UNCHECKED, [
            reference("prototypeHeap"),
            prototypeIdentity,
            key,
            descriptor,
          ]),
          match(
            call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
              reference("heapWithFixedProperty"),
              reference("prototype"),
              reference(JAVASCRIPT_OBJECT_ORDINARY),
            ]),
            [{
              constructor: JAVASCRIPT_HEAP_ALLOCATION,
              binders: ["childHeap", "child"],
              body: letExpression(
                "state",
                stateWithEmptyBindings(reference("childHeap")),
                match(
                  call(JAVASCRIPT_RUNTIME_PUT_REFERENCE_VALUE, [
                    reference("state"),
                    call(JAVASCRIPT_PROPERTY_REFERENCE, [
                      reference("child"),
                      key,
                      reference("child"),
                      boolean(true),
                    ]),
                    call(JAVASCRIPT_VALUE_NUMBER, [float64(42)]),
                  ]),
                  expectNonWritableReference(),
                ),
              ),
              span,
            }],
          ),
        )),
      span,
    }],
  );

  deepStrictEqual(await compileAndRun(result), { kind: "float-64", value: 42 });
});

Deno.test("JavaScript runtime rejects a prototype identity outside its heap", async () => {
  const heap = call(JAVASCRIPT_HEAP, [integer(1), emptyObjectStore()]);
  await rejects(
    () =>
      compileAndRun(
        call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
          heap,
          call(JAVASCRIPT_VALUE_OBJECT, [integer(0)]),
          reference(JAVASCRIPT_OBJECT_ORDINARY),
        ]),
      ),
    /prototype identity is not present in the heap/,
  );
});

Deno.test("JavaScript runtime rejects object identity exhaustion before wrapping", async () => {
  const heap = call(JAVASCRIPT_HEAP, [
    integer(JAVASCRIPT_MAXIMUM_OBJECT_COUNT),
    emptyObjectStore(),
  ]);
  await rejects(
    () =>
      compileAndRun(
        call(JAVASCRIPT_RUNTIME_ALLOCATE_OBJECT, [
          heap,
          reference(JAVASCRIPT_VALUE_NULL),
          reference(JAVASCRIPT_OBJECT_ORDINARY),
        ]),
      ),
    /object identity space is exhausted/,
  );
});

Deno.test("JavaScript runtime rejects binding identity exhaustion before wrapping", async () => {
  const state = call(JAVASCRIPT_STATE, [
    reference(JAVASCRIPT_RUNTIME_EMPTY_HEAP),
    emptyExecutionContext(),
    call(JAVASCRIPT_BINDING_STORE, [
      integer(JAVASCRIPT_MAXIMUM_BINDING_COUNT),
      {
        kind: "store-new",
        length: integer(0),
        initial: call(JAVASCRIPT_BINDING_MUTABLE, [reference(JAVASCRIPT_VALUE_UNDEFINED)]),
        span,
      },
    ]),
  ]);
  await rejects(
    () =>
      compileAndRun(
        call(JAVASCRIPT_RUNTIME_DEFINE_BINDING, [
          state,
          text("overflow"),
          call(JAVASCRIPT_BINDING_MUTABLE, [reference(JAVASCRIPT_VALUE_UNDEFINED)]),
        ]),
      ),
    /binding identity space is exhausted/,
  );
});

function environmentUpdateArms(): readonly FunctionalSurfaceCaseArm[] {
  const failedUpdate = fault("mutable environment binding was not updated");
  return [{
    constructor: JAVASCRIPT_BINDING_UPDATE_NOT_FOUND,
    binders: [],
    body: failedUpdate,
    span,
  }, {
    constructor: JAVASCRIPT_BINDING_UPDATE_UNINITIALIZED,
    binders: [],
    body: failedUpdate,
    span,
  }, {
    constructor: JAVASCRIPT_BINDING_UPDATE_IMMUTABLE,
    binders: [],
    body: failedUpdate,
    span,
  }, {
    constructor: JAVASCRIPT_BINDING_UPDATE_ALREADY_INITIALIZED,
    binders: [],
    body: failedUpdate,
    span,
  }, {
    constructor: JAVASCRIPT_BINDING_UPDATE_UPDATED,
    binders: ["updatedState"],
    body: match(
      call(JAVASCRIPT_RUNTIME_LOOKUP_BINDING, [
        reference("updatedState"),
        text("answer"),
      ]),
      [{
        constructor: JAVASCRIPT_VALUE_MISSING,
        binders: [],
        body: fault("updated environment lost its binding"),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_UNINITIALIZED,
        binders: [],
        body: fault("updated environment binding became uninitialized"),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_FOUND,
        binders: ["answer"],
        body: letExpression(
          "state",
          reference("updatedState"),
          match(
            call(JAVASCRIPT_COMPLETION_RETURN, [
              reference("state"),
              reference("answer"),
            ]),
            completionArms(),
          ),
        ),
        span,
      }, {
        constructor: JAVASCRIPT_VALUE_ACCESSOR,
        binders: ["getter", "receiver"],
        body: fault("environment lookup requested an accessor call"),
        span,
      }],
    ),
    span,
  }];
}

function expectUpdatedReference(
  onUpdated: (state: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
): readonly FunctionalSurfaceCaseArm[] {
  const rejected = fault("JavaScript Reference write was rejected");
  return [{
    constructor: JAVASCRIPT_REFERENCE_UPDATE_UPDATED,
    binders: ["updatedReferenceState"],
    body: onUpdated(reference("updatedReferenceState")),
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_ACCESSOR,
    binders: ["state", "setter", "receiver", "value"],
    body: rejected,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_UNRESOLVABLE,
    binders: [],
    body: rejected,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_UNINITIALIZED,
    binders: [],
    body: rejected,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_IMMUTABLE,
    binders: [],
    body: rejected,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_NON_WRITABLE,
    binders: [],
    body: rejected,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_MISSING_SETTER,
    binders: [],
    body: rejected,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_NON_EXTENSIBLE,
    binders: [],
    body: rejected,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE,
    binders: [],
    body: rejected,
    span,
  }];
}

function expectNonWritableReference(): readonly FunctionalSurfaceCaseArm[] {
  const wrongResult = fault("inherited non-writable property accepted a Reference write");
  return [{
    constructor: JAVASCRIPT_REFERENCE_UPDATE_UPDATED,
    binders: ["updatedState"],
    body: wrongResult,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_ACCESSOR,
    binders: ["state", "setter", "receiver", "value"],
    body: wrongResult,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_UNRESOLVABLE,
    binders: [],
    body: wrongResult,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_UNINITIALIZED,
    binders: [],
    body: wrongResult,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_IMMUTABLE,
    binders: [],
    body: wrongResult,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_NON_WRITABLE,
    binders: [],
    body: float64(42),
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_MISSING_SETTER,
    binders: [],
    body: wrongResult,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_NON_EXTENSIBLE,
    binders: [],
    body: wrongResult,
    span,
  }, {
    constructor: JAVASCRIPT_REFERENCE_UPDATE_INVALID_BASE,
    binders: [],
    body: wrongResult,
    span,
  }];
}

function completionArms(): readonly FunctionalSurfaceCaseArm[] {
  const wrongCompletion = fault("return completion changed kind");
  return [{
    constructor: JAVASCRIPT_COMPLETION_NORMAL,
    binders: ["state", "value"],
    body: wrongCompletion,
    span,
  }, {
    constructor: JAVASCRIPT_COMPLETION_RETURN,
    binders: ["state", "value"],
    body: expectNumber("value"),
    span,
  }, {
    constructor: JAVASCRIPT_COMPLETION_THROW,
    binders: ["state", "value"],
    body: wrongCompletion,
    span,
  }, {
    constructor: JAVASCRIPT_COMPLETION_BREAK,
    binders: ["state", "target"],
    body: wrongCompletion,
    span,
  }, {
    constructor: JAVASCRIPT_COMPLETION_CONTINUE,
    binders: ["state", "target"],
    body: wrongCompletion,
    span,
  }];
}

function expectObject(
  valueName: string,
  identityName: string,
  onObject: (identity: FunctionalSurfaceExpression) => FunctionalSurfaceExpression,
): FunctionalSurfaceExpression {
  const wrongValue = fault(`${valueName} was not an object`);
  return match(reference(valueName), [{
    constructor: JAVASCRIPT_VALUE_UNDEFINED,
    binders: [],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_NULL,
    binders: [],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_BOOLEAN,
    binders: ["booleanValue"],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_NUMBER,
    binders: ["numberValue"],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_STRING,
    binders: ["stringValue"],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_SYMBOL,
    binders: ["symbolIdentity"],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_OBJECT,
    binders: [identityName],
    body: onObject(reference(identityName)),
    span,
  }]);
}

function expectNumber(valueName: string): FunctionalSurfaceExpression {
  const wrongValue = fault(`${valueName} was not a number`);
  return match(reference(valueName), [{
    constructor: JAVASCRIPT_VALUE_UNDEFINED,
    binders: [],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_NULL,
    binders: [],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_BOOLEAN,
    binders: ["booleanValue"],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_NUMBER,
    binders: ["numberValue"],
    body: reference("numberValue"),
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_STRING,
    binders: ["stringValue"],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_SYMBOL,
    binders: ["symbolIdentity"],
    body: wrongValue,
    span,
  }, {
    constructor: JAVASCRIPT_VALUE_OBJECT,
    binders: ["objectIdentity"],
    body: wrongValue,
    span,
  }]);
}

async function compileAndRun(body: FunctionalSurfaceExpression) {
  if (compiler === undefined) throw new Error("JavaScript runtime compiler was not initialized");
  const runtime = javascriptRuntimeSurface(0);
  const definitions = [...runtime.definitions, {
    name: "main",
    parameters: [],
    annotation: null,
    body,
    span,
  }];
  const module = buildFunctionalSurfaceModule(
    definitions,
    runtime.typeDeclarations,
    "main",
    0,
  );
  const compilation = await compiler.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("JavaScript runtime fixture did not compile");
  try {
    return (await runFunctionalWasmModule(compilation.module)).value;
  } finally {
    compilation.module.destroy();
  }
}

function reference(name: string): FunctionalSurfaceExpression {
  return { kind: "name", name, span };
}

function integer(value: number): FunctionalSurfaceExpression {
  return { kind: "integer", value, span };
}

function emptyObjectStore(): FunctionalSurfaceExpression {
  return {
    kind: "store-new",
    length: integer(0),
    initial: call(JAVASCRIPT_OBJECT_RECORD, [
      reference(JAVASCRIPT_VALUE_NULL),
      boolean(true),
      reference(JAVASCRIPT_OBJECT_ORDINARY),
      reference(JAVASCRIPT_PROPERTY_LIST_EMPTY),
    ]),
    span,
  };
}

function stateWithEmptyBindings(heap: FunctionalSurfaceExpression): FunctionalSurfaceExpression {
  return call(JAVASCRIPT_STATE, [
    heap,
    emptyExecutionContext(),
    call(JAVASCRIPT_BINDING_STORE, [
      integer(0),
      {
        kind: "store-new",
        length: integer(0),
        initial: call(JAVASCRIPT_BINDING_MUTABLE, [reference(JAVASCRIPT_VALUE_UNDEFINED)]),
        span,
      },
    ]),
  ]);
}

function emptyExecutionContext(): FunctionalSurfaceExpression {
  return call(JAVASCRIPT_EXECUTION_CONTEXT, [
    call(JAVASCRIPT_REALM, [
      reference(JAVASCRIPT_VALUE_UNDEFINED),
    ]),
    reference(JAVASCRIPT_ENVIRONMENT_EMPTY),
    reference(JAVASCRIPT_ENVIRONMENT_EMPTY),
    reference(JAVASCRIPT_VALUE_UNDEFINED),
  ]);
}

function float64(value: number): FunctionalSurfaceExpression {
  return { kind: "float-64", value, span };
}

function boolean(value: boolean): FunctionalSurfaceExpression {
  return { kind: "boolean", value, span };
}

function text(value: string): FunctionalSurfaceExpression {
  return { kind: "text", value, span };
}

function call(
  calleeName: string,
  arguments_: readonly FunctionalSurfaceExpression[],
): FunctionalSurfaceExpression {
  let expression = reference(calleeName);
  for (const argument of arguments_) {
    expression = { kind: "apply", callee: expression, argument, span };
  }
  return expression;
}

function conditional(
  condition: FunctionalSurfaceExpression,
  consequent: FunctionalSurfaceExpression,
  alternate: FunctionalSurfaceExpression,
): FunctionalSurfaceExpression {
  return { kind: "if", condition, consequent, alternate, span };
}

function letExpression(
  name: string,
  value: FunctionalSurfaceExpression,
  body: FunctionalSurfaceExpression,
): FunctionalSurfaceExpression {
  return { kind: "let", name, value, body, span };
}

function match(
  value: FunctionalSurfaceExpression,
  arms: readonly FunctionalSurfaceCaseArm[],
): FunctionalSurfaceExpression {
  return { kind: "case", value, arms, span };
}

function fault(message: string): FunctionalSurfaceExpression {
  return { kind: "runtime-fault", message, span };
}
