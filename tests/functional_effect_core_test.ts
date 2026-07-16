import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";

import {
  FunctionalBinaryOperator,
  type FunctionalEffectCoreExpression,
  type FunctionalEffectCoreModule,
  type FunctionalEffectOperation,
  type FunctionalHostCapabilityDeclaration,
  type FunctionalSurfaceDefinition,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../functional.ts";
import { GpuFunctionalEffectCoreVerifier } from "../src/functional/effect_core.ts";

interface EffectCoreRuntime {
  readonly device: GPUDevice;
  readonly compiler: GpuFunctionalCompiler;
  readonly verifier: GpuFunctionalEffectCoreVerifier;
}

let runtime: EffectCoreRuntime | undefined;

Deno.test.beforeAll(async () => {
  const device = await requestWebGpuDevice();
  const [compiler, verifier] = await Promise.all([
    GpuFunctionalCompiler.create(device),
    GpuFunctionalEffectCoreVerifier.create(device),
  ]);
  runtime = { device, compiler, verifier };
});

Deno.test.afterAll(() => {
  runtime?.device.destroy();
  runtime = undefined;
});

Deno.test("GPU Effect Core preserves demanded host-call order", async () => {
  const module = effectModule({
    kind: "bind",
    name: "first",
    computation: hostCall("record", 1),
    body: {
      kind: "bind",
      name: "second",
      computation: hostCall("record", 2),
      body: { kind: "return", value: surface.name("second"), valueType: { kind: "integer" } },
    },
  }, [consoleCapability("effectful")]);
  const compilation = await effectCoreRuntime().compiler.compileEffectModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("ordered Effect Core module did not compile");
  const observed: number[] = [];
  try {
    deepStrictEqual(compilation.module.entryEffects, ["Console.record"]);
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Console: {
          record: (argument) => {
            if (argument.kind === "integer") observed.push(argument.value);
            return argument;
          },
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 2 });
    deepStrictEqual(observed, [1, 2]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("pure host calls remain lazy when their bound result is unused", async () => {
  const module = effectModule({
    kind: "bind",
    name: "unused",
    computation: hostCall("compute", 99),
    body: { kind: "return", value: surface.integer(42), valueType: { kind: "integer" } },
  }, [consoleCapability("pure", "compute")]);
  const compilation = await effectCoreRuntime().compiler.compileEffectModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("pure Effect Core module did not compile");
  let calls = 0;
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Console: {
          compute: (argument) => {
            calls += 1;
            return argument;
          },
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
    equal(calls, 0);
    deepStrictEqual(compilation.module.entryEffects, []);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("Effect Core executes only the selected effectful branch", async () => {
  const module = effectModule({
    kind: "branch",
    condition: surface.boolean(true),
    conditionType: { kind: "boolean" },
    consequent: hostCall("record", 1),
    alternate: hostCall("record", 2),
  }, [consoleCapability("effectful")]);
  const compilation = await effectCoreRuntime().compiler.compileEffectModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("branching Effect Core module did not compile");
  const observed: number[] = [];
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Console: {
          record: (argument) => {
            if (argument.kind === "integer") observed.push(argument.value);
            return argument;
          },
        },
      },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 1 });
    deepStrictEqual(observed, [1]);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("Effect Core handlers discharge local operations before the executable boundary", async () => {
  const module = effectModule(
    {
      kind: "handle",
      effect: "Reader",
      operation: "ask",
      implementation: surface.lambda("request", surface.integer(40)),
      computation: {
        kind: "bind",
        name: "answer",
        computation: {
          kind: "perform",
          effect: "Reader",
          operation: "ask",
          argument: surface.name("$Unit"),
          argumentType: { kind: "unit" },
        },
        body: {
          kind: "return",
          value: surface.binary(
            FunctionalBinaryOperator.Add,
            surface.name("answer"),
            surface.integer(2),
          ),
          valueType: { kind: "integer" },
        },
      },
    },
    [],
    [],
    [{
      effect: "Reader",
      name: "ask",
      parameter: { kind: "unit" },
      result: { kind: "integer" },
    }],
  );
  const compilation = await effectCoreRuntime().compiler.compileEffectModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("handled Effect Core module did not compile");
  try {
    deepStrictEqual(compilation.module.entryEffects, []);
    const execution = await runFunctionalWasmModule(compilation.module);
    deepStrictEqual(execution.value, { kind: "integer", value: 42 });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("GPU Effect Core rejects a computation record reused by two parents", async () => {
  const shared = {
    kind: "return",
    value: surface.integer(1),
    valueType: { kind: "integer" },
  } as const;
  const module = effectModule({
    kind: "bind",
    name: "value",
    computation: shared,
    body: shared,
  });
  const compilation = await effectCoreRuntime().compiler.compileEffectModule(module);
  equal(compilation.ok, false);
  if (!compilation.ok) {
    equal(compilation.diagnostics[0].code, "F2101");
    match(compilation.diagnostics[0].message, /exactly one parent/);
  }
});

Deno.test("GPU Effect Core rejects host argument annotations that contradict the contract", async () => {
  const module = effectModule({
    kind: "host-call",
    capability: "Console",
    operation: "record",
    argument: surface.boolean(true),
    argumentType: { kind: "boolean" },
  }, [consoleCapability("effectful")]);
  const compilation = await effectCoreRuntime().compiler.compileEffectModule(module);
  equal(compilation.ok, false);
  if (!compilation.ok) equal(compilation.diagnostics[0].code, "F2102");
});

Deno.test("GPU Effect Core rejects branches with different result types", async () => {
  const module = effectModule({
    kind: "branch",
    condition: surface.boolean(true),
    conditionType: { kind: "boolean" },
    consequent: { kind: "return", value: surface.integer(1), valueType: { kind: "integer" } },
    alternate: { kind: "return", value: surface.boolean(false), valueType: { kind: "boolean" } },
  });
  const compilation = await effectCoreRuntime().compiler.compileEffectModule(module);
  equal(compilation.ok, false);
  if (!compilation.ok) equal(compilation.diagnostics[0].code, "F2102");
});

Deno.test("Effect Core rejects a source span outside its module boundary", async () => {
  const module = effectModule({
    kind: "return",
    value: surface.integer(1),
    valueType: { kind: "integer" },
    span: { startByte: 0, endByte: 2 },
  });
  await rejects(
    () => effectCoreRuntime().compiler.compileEffectModule(module),
    /node 0 has invalid source span 0\.\.2; source length is 0/,
  );
});

Deno.test("Effect Core verification has invariant transitions and an exact fuel threshold", async () => {
  const module = effectModule({
    kind: "bind",
    name: "value",
    computation: hostCall("record", 1),
    body: { kind: "return", value: surface.name("value"), valueType: { kind: "integer" } },
  }, [consoleCapability("effectful")]);
  const successful = [];
  for (const maximumTransitionsPerDispatch of [1, 7, 4_096]) {
    successful.push(
      await effectCoreRuntime().verifier.verify(module, {
        maximumTransitions: 100,
        maximumTransitionsPerDispatch,
      }),
    );
  }
  const [one, seven, large] = successful;
  ok(one?.ok && seven?.ok && large?.ok);
  if (!one?.ok || !seven?.ok || !large?.ok) {
    throw new Error("Effect Core dispatch-invariance verification failed");
  }
  const transitions = one.transitions;
  equal(seven.transitions, transitions);
  equal(large.transitions, transitions);
  const exhausted = await effectCoreRuntime().verifier.verify(module, {
    maximumTransitions: transitions - 1,
    maximumTransitionsPerDispatch: 4_096,
  });
  equal(exhausted.ok, false);
  if (!exhausted.ok) equal(exhausted.diagnostic.code, "F1003");
  const exact = await effectCoreRuntime().verifier.verify(module, {
    maximumTransitions: transitions,
    maximumTransitionsPerDispatch: 4_096,
  });
  ok(exact.ok);
  equal(exact.transitions, transitions);
});

Deno.test("Effect Core cancellation after a GPU dispatch leaves the verifier reusable", async () => {
  const module = effectModule({
    kind: "bind",
    name: "value",
    computation: hostCall("record", 1),
    body: { kind: "return", value: surface.name("value"), valueType: { kind: "integer" } },
  }, [consoleCapability("effectful")]);
  const controller = new AbortController();
  await rejects(
    () =>
      effectCoreRuntime().verifier.verify(module, {
        maximumTransitions: 100,
        maximumTransitionsPerDispatch: 1,
        signal: controller.signal,
        observeDispatch: () => controller.abort(new Error("cancel Effect Core")),
      }),
    /cancel Effect Core/,
  );
  const resumed = await effectCoreRuntime().verifier.verify(module, {
    maximumTransitions: 100,
    maximumTransitionsPerDispatch: 7,
  });
  ok(resumed.ok);
});

Deno.test("Effect Core host calls accept recursively computed arguments and propagate host faults", async () => {
  const factorial: FunctionalSurfaceDefinition = {
    name: "factorial",
    parameters: ["value"],
    annotation: {
      kind: "function",
      parameter: { kind: "integer" },
      result: { kind: "integer" },
    },
    body: {
      kind: "if",
      condition: surface.equal(surface.name("value"), surface.integer(0)),
      consequent: surface.integer(1),
      alternate: surface.binary(
        FunctionalBinaryOperator.Multiply,
        surface.name("value"),
        surface.apply(
          surface.name("factorial"),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("value"),
            surface.integer(1),
          ),
        ),
      ),
    },
  };
  const module = effectModule(
    {
      kind: "host-call",
      capability: "Console",
      operation: "record",
      argument: surface.apply(surface.name("factorial"), surface.integer(5)),
      argumentType: { kind: "integer" },
    },
    [consoleCapability("effectful")],
    [factorial],
  );
  const compilation = await effectCoreRuntime().compiler.compileEffectModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("recursive Effect Core module did not compile");
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: { Console: { record: (argument) => argument } },
    });
    deepStrictEqual(execution.value, { kind: "integer", value: 120 });
    await rejects(
      () =>
        runFunctionalWasmModule(compilation.module, {
          init: {
            Console: {
              record: () => {
                throw new Error("host boom");
              },
            },
          },
        }),
      /host boom/,
    );
  } finally {
    compilation.module.destroy();
  }
});

function effectModule(
  expression: FunctionalEffectCoreExpression,
  hostCapabilities: readonly FunctionalHostCapabilityDeclaration[] = [],
  definitions: readonly FunctionalSurfaceDefinition[] = [],
  operations: readonly FunctionalEffectOperation[] = [],
): FunctionalEffectCoreModule {
  return {
    definitions,
    typeDeclarations: [],
    operations,
    hostCapabilities,
    expression,
    entryName: "main",
    sourceByteLength: 0,
  };
}

function hostCall(operation: string, argument: number): FunctionalEffectCoreExpression {
  return {
    kind: "host-call",
    capability: "Console",
    operation,
    argument: surface.integer(argument),
    argumentType: { kind: "integer" },
  };
}

function consoleCapability(
  purity: "pure" | "effectful",
  operation = "record",
): FunctionalHostCapabilityDeclaration {
  return {
    name: "Console",
    fields: [{
      kind: "operation",
      name: operation,
      purity,
      parameter: { kind: "integer" },
      result: { kind: "integer" },
    }],
  };
}

function effectCoreRuntime(): EffectCoreRuntime {
  if (runtime === undefined) throw new Error("Functional Effect Core runtime was not initialized");
  return runtime;
}
