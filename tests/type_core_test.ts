import { deepStrictEqual, equal, match, ok, rejects, throws } from "node:assert/strict";

import {
  GpuTypeCoreExecutor,
  requestWebGpuDevice,
  type TypeCoreCapabilityPattern,
  TypeCoreCapabilityResolver,
  type TypeCoreCapabilityRule,
  type TypeCoreExpression,
  type TypeCoreProgram,
  type TypeCoreValue,
} from "../functional.ts";

let device: GPUDevice | undefined;
let executor: GpuTypeCoreExecutor | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  executor = await GpuTypeCoreExecutor.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  executor = undefined;
});

function typeCoreExecutor(): GpuTypeCoreExecutor {
  if (executor === undefined) throw new Error("Type Core test executor was not initialized");
  return executor;
}

const integerType: TypeCoreValue = { kind: "type", type: { kind: "integer" } };
const booleanType: TypeCoreValue = { kind: "type", type: { kind: "boolean" } };

function vectorType(length: number): TypeCoreValue {
  return {
    kind: "type",
    type: {
      kind: "named",
      name: "Vector",
      arguments: [integerType, { kind: "integer", value: length }],
    },
  };
}

function vectorTypeExpression(length: number): TypeCoreExpression {
  return {
    kind: "type",
    type: {
      kind: "named",
      name: "Vector",
      arguments: [
        { kind: "type", type: { kind: "integer" } },
        { kind: "integer", value: length },
      ],
    },
  };
}

function vectorLengthSuccessorProgram(): TypeCoreProgram {
  return {
    typeConstructors: [{ name: "Vector", parameterKinds: ["type", "integer"] }],
    functions: [{
      name: "SuccessorLength",
      parameters: [{ name: "value", kind: "type" }],
      resultKind: "type",
      body: {
        kind: "match",
        value: { kind: "reference", name: "value" },
        arms: [{
          pattern: {
            kind: "type",
            type: {
              kind: "named",
              name: "Vector",
              arguments: [
                { kind: "bind", name: "element" },
                { kind: "bind", name: "length" },
              ],
            },
          },
          result: {
            kind: "type",
            type: {
              kind: "named",
              name: "Vector",
              arguments: [
                { kind: "reference", name: "element" },
                {
                  kind: "integer-operation",
                  operator: "add",
                  left: { kind: "reference", name: "length" },
                  right: { kind: "integer", value: 1 },
                },
              ],
            },
          },
        }],
        fallback: { kind: "type", type: { kind: "unit" } },
      },
    }],
    entry: {
      kind: "call",
      function: "SuccessorLength",
      arguments: [vectorTypeExpression(41)],
    },
  };
}

Deno.test("executes kinded type functions on the bounded GPU core", async () => {
  const result = await typeCoreExecutor().execute(vectorLengthSuccessorProgram());

  ok(result.ok, result.ok ? undefined : result.stage);
  if (!result.ok) return;
  deepStrictEqual(result.value, vectorType(42));
  ok(result.stats.steps > 0);
});

Deno.test("executes packed Type Core programs in input order", async () => {
  const programs = [40, 41, 42].map((length): TypeCoreProgram => ({
    typeConstructors: [{ name: "Vector", parameterKinds: ["type", "integer"] }],
    functions: [],
    entry: vectorTypeExpression(length),
  }));

  const results = await typeCoreExecutor().executeBatch(programs);

  deepStrictEqual(
    results.map((result) => result.ok ? result.value : result.stage),
    [vectorType(40), vectorType(41), vectorType(42)],
  );
});

Deno.test("preserves Type Core results and semantic step counts across dispatch quanta", async () => {
  const program: TypeCoreProgram = {
    typeConstructors: [{ name: "Vector", parameterKinds: ["type", "integer"] }],
    functions: [],
    entry: vectorTypeExpression(42),
  };

  const boundedQuantum = await typeCoreExecutor().execute(program, {
    maximumStepsPerDispatch: 256,
  });
  const fullQuantum = await typeCoreExecutor().execute(program, {
    maximumStepsPerDispatch: 4_096,
  });

  ok(boundedQuantum.ok, boundedQuantum.ok ? undefined : boundedQuantum.stage);
  ok(fullQuantum.ok, fullQuantum.ok ? undefined : fullQuantum.stage);
  if (!boundedQuantum.ok || !fullQuantum.ok) return;
  deepStrictEqual(boundedQuantum.value, fullQuantum.value);
  deepStrictEqual(boundedQuantum.stats, fullQuantum.stats);
});

Deno.test("rejects ill-kinded programs before GPU compilation", async () => {
  await rejects(
    () =>
      typeCoreExecutor().execute({
        typeConstructors: [{ name: "Vector", parameterKinds: ["type", "integer"] }],
        functions: [],
        entry: {
          kind: "type",
          type: {
            kind: "named",
            name: "Vector",
            arguments: [{ kind: "integer", value: 7 }, { kind: "integer", value: 1 }],
          },
        },
      }),
    /argument 0 to type "Vector" requires kind type; received integer/,
  );
});

Deno.test("matches maximum-width named types without exhausting the functional IR", async () => {
  const width = 256;
  const parameters = Array.from({ length: width }, (_, index) => `value${index}`);
  const result = await typeCoreExecutor().execute({
    typeConstructors: [{
      name: "Wide",
      parameterKinds: Array.from({ length: width }, () => "integer" as const),
    }],
    functions: [{
      name: "Last",
      parameters: [{ name: "wide", kind: "type" }],
      resultKind: "integer",
      body: {
        kind: "match",
        value: { kind: "reference", name: "wide" },
        arms: [{
          pattern: {
            kind: "type",
            type: {
              kind: "named",
              name: "Wide",
              arguments: parameters.map((name) => ({ kind: "bind", name })),
            },
          },
          result: { kind: "reference", name: parameters[width - 1] ?? "missing" },
        }],
        fallback: { kind: "integer", value: -1 },
      },
    }],
    entry: {
      kind: "call",
      function: "Last",
      arguments: [{
        kind: "type",
        type: {
          kind: "named",
          name: "Wide",
          arguments: Array.from(
            { length: width },
            (_, value) => ({ kind: "integer" as const, value }),
          ),
        },
      }],
    },
  });

  ok(result.ok, result.ok ? undefined : result.stage);
  if (result.ok) deepStrictEqual(result.value, { kind: "integer", value: 255 });
});

Deno.test("decodes every argument from a maximum-width Type Core result", async () => {
  const width = 256;
  const arguments_ = Array.from(
    { length: width },
    (_, value) => ({ kind: "integer" as const, value }),
  );
  const result = await typeCoreExecutor().execute({
    typeConstructors: [{
      name: "Wide",
      parameterKinds: Array.from({ length: width }, () => "integer" as const),
    }],
    functions: [],
    entry: { kind: "type", type: { kind: "named", name: "Wide", arguments: arguments_ } },
  });

  ok(result.ok, result.ok ? undefined : result.stage);
  if (!result.ok) return;
  deepStrictEqual(result.value, {
    kind: "type",
    type: { kind: "named", name: "Wide", arguments: arguments_ },
  });
});

Deno.test("rejects Type Core declarations wider than the lowering bound", async () => {
  await rejects(
    () =>
      typeCoreExecutor().execute({
        typeConstructors: [{
          name: "TooWide",
          parameterKinds: Array.from({ length: 257 }, () => "type" as const),
        }],
        functions: [],
        entry: { kind: "integer", value: 0 },
      }),
    /type constructor "TooWide" parameters exceed the maximum width of 256; received 257/,
  );
});

Deno.test("branches on symbols and constructs function and tuple types", async () => {
  const program = (mode: string): TypeCoreProgram => ({
    typeConstructors: [],
    functions: [{
      name: "Shape",
      parameters: [{ name: "mode", kind: "symbol" }],
      resultKind: "type",
      body: {
        kind: "if",
        condition: {
          kind: "symbol-equal",
          left: { kind: "reference", name: "mode" },
          right: { kind: "symbol", value: "callable" },
        },
        consequent: {
          kind: "type",
          type: {
            kind: "function",
            parameter: { kind: "type", type: { kind: "integer" } },
            result: { kind: "type", type: { kind: "boolean" } },
          },
        },
        alternate: {
          kind: "type",
          type: {
            kind: "tuple",
            values: [
              { kind: "type", type: { kind: "unit" } },
              { kind: "type", type: { kind: "integer" } },
            ],
          },
        },
      },
    }],
    entry: { kind: "call", function: "Shape", arguments: [{ kind: "symbol", value: mode }] },
  });

  const callable = await typeCoreExecutor().execute(program("callable"));
  const pair = await typeCoreExecutor().execute(program("pair"));

  ok(callable.ok, callable.ok ? undefined : callable.stage);
  ok(pair.ok, pair.ok ? undefined : pair.stage);
  if (!callable.ok || !pair.ok) return;
  deepStrictEqual(callable.value, {
    kind: "type",
    type: { kind: "function", parameter: { kind: "integer" }, result: { kind: "boolean" } },
  });
  deepStrictEqual(pair.value, {
    kind: "type",
    type: { kind: "tuple", values: [{ kind: "unit" }, { kind: "integer" }] },
  });
});

Deno.test("bounds recursive type execution by fuel and keeps the executor reusable", async () => {
  const recursive: TypeCoreProgram = {
    typeConstructors: [],
    functions: [{
      name: "Loop",
      parameters: [{ name: "value", kind: "integer" }],
      resultKind: "integer",
      body: {
        kind: "call",
        function: "Loop",
        arguments: [{ kind: "reference", name: "value" }],
      },
    }],
    entry: { kind: "call", function: "Loop", arguments: [{ kind: "integer", value: 0 }] },
  };

  const exhausted = await typeCoreExecutor().execute(recursive, { maximumExecutionSteps: 1 });
  equal(exhausted.ok, false);
  if (exhausted.ok) return;
  equal(exhausted.stage, "execute");
  if (exhausted.stage === "execute") equal(exhausted.fault.code, "F3002");

  const retry = await typeCoreExecutor().execute({
    typeConstructors: [],
    functions: [],
    entry: { kind: "integer", value: 42 },
  });
  ok(retry.ok, retry.ok ? undefined : retry.stage);
  if (retry.ok) deepStrictEqual(retry.value, { kind: "integer", value: 42 });
});

function fieldCapabilityRules(): readonly TypeCoreCapabilityRule[] {
  const element = { kind: "variable", name: "element", valueKind: "type" } as const;
  return [
    {
      id: "integer-copy",
      predicate: "copy",
      inputs: [integerType],
      outputs: [],
      premises: [],
      witness: { kind: "compile-time", symbol: "copy_i32" },
    },
    {
      id: "box-value-field",
      predicate: "field",
      inputs: [
        {
          kind: "type",
          type: { kind: "named", name: "Box", arguments: [element] },
        },
        { kind: "symbol", value: "value" },
      ],
      outputs: [element],
      premises: [{ predicate: "copy", inputs: [element] }],
      witness: { kind: "runtime-dictionary", symbol: "read_box_value" },
    },
  ];
}

Deno.test("discovers associated field types and independently verifies evidence", () => {
  const resolver = new TypeCoreCapabilityResolver(fieldCapabilityRules());
  const goal = {
    predicate: "field",
    inputs: [
      {
        kind: "type",
        type: { kind: "named", name: "Box", arguments: [integerType] },
      },
      { kind: "symbol", value: "value" },
    ],
  } as const;

  const resolution = resolver.resolve(goal);

  ok(resolution.ok, resolution.ok ? undefined : resolution.message);
  if (!resolution.ok) return;
  deepStrictEqual(resolution.outputs, [integerType]);
  equal(resolution.evidence.ruleId, "box-value-field");
  equal(resolution.evidence.premises[0]?.ruleId, "integer-copy");
  const verification = resolver.verify(goal, resolution.evidence);
  ok(verification.ok, verification.ok ? undefined : verification.message);
  if (verification.ok) deepStrictEqual(verification.outputs, [integerType]);
});

Deno.test("rejects capability evidence with forged associated outputs", () => {
  const resolver = new TypeCoreCapabilityResolver(fieldCapabilityRules());
  const goal = {
    predicate: "field",
    inputs: [
      {
        kind: "type",
        type: { kind: "named", name: "Box", arguments: [integerType] },
      },
      { kind: "symbol", value: "value" },
    ],
  } as const;
  const resolution = resolver.resolve(goal);
  ok(resolution.ok, resolution.ok ? undefined : resolution.message);
  if (!resolution.ok) return;

  const forged = { ...resolution.evidence, outputs: [booleanType] };
  const rejected = resolver.verify(goal, forged);
  equal(rejected.ok, false);
  if (!rejected.ok) match(rejected.message, /changed outputs/);
});

Deno.test("reports overlapping capability proofs as ambiguous", () => {
  const duplicateRules: readonly TypeCoreCapabilityRule[] = [
    {
      id: "first-integer-copy",
      predicate: "copy",
      inputs: [integerType],
      outputs: [],
      premises: [],
      witness: { kind: "erased-proof" },
    },
    {
      id: "second-integer-copy",
      predicate: "copy",
      inputs: [integerType],
      outputs: [],
      premises: [],
      witness: { kind: "erased-proof" },
    },
  ];
  const ambiguous = new TypeCoreCapabilityResolver(duplicateRules).resolve({
    predicate: "copy",
    inputs: [integerType],
  });
  equal(ambiguous.ok, false);
  if (!ambiguous.ok) equal(ambiguous.kind, "ambiguous");
});

Deno.test("reports recursive capability prerequisites as a cycle", () => {
  const value = { kind: "variable", name: "value", valueKind: "type" } as const;
  const recursive = new TypeCoreCapabilityResolver([{
    id: "recursive-copy",
    predicate: "copy",
    inputs: [value],
    outputs: [],
    premises: [{ predicate: "copy", inputs: [value] }],
    witness: { kind: "erased-proof" },
  }]);
  const cycle = recursive.resolve({ predicate: "copy", inputs: [integerType] });
  equal(cycle.ok, false);
  if (!cycle.ok) equal(cycle.kind, "cycle");
});

Deno.test("stops capability search at its transition limit", () => {
  const value = { kind: "variable", name: "value", valueKind: "type" } as const;
  const recursive = new TypeCoreCapabilityResolver([{
    id: "recursive-copy",
    predicate: "copy",
    inputs: [value],
    outputs: [],
    premises: [{ predicate: "copy", inputs: [value] }],
    witness: { kind: "erased-proof" },
  }]);
  const exhausted = recursive.resolve(
    { predicate: "copy", inputs: [integerType] },
    { maximumTransitions: 1 },
  );
  equal(exhausted.ok, false);
  if (!exhausted.ok) equal(exhausted.kind, "out-of-fuel");
});

Deno.test("stops capability search at its proof-depth limit", () => {
  const resolver = new TypeCoreCapabilityResolver([
    {
      id: "first-depth",
      predicate: "first",
      inputs: [integerType],
      outputs: [],
      premises: [{ predicate: "second", inputs: [integerType] }],
      witness: { kind: "erased-proof" },
    },
    {
      id: "second-depth",
      predicate: "second",
      inputs: [integerType],
      outputs: [],
      premises: [{ predicate: "third", inputs: [integerType] }],
      witness: { kind: "erased-proof" },
    },
    {
      id: "third-depth",
      predicate: "third",
      inputs: [integerType],
      outputs: [],
      premises: [],
      witness: { kind: "erased-proof" },
    },
  ]);

  const exhausted = resolver.resolve(
    { predicate: "first", inputs: [integerType] },
    { maximumDepth: 1 },
  );

  equal(exhausted.ok, false);
  if (!exhausted.ok) equal(exhausted.kind, "depth-exhausted");
});

Deno.test("rejects capability outputs that are not determined by rule inputs", () => {
  throws(
    () =>
      new TypeCoreCapabilityResolver([{
        id: "invented-output",
        predicate: "element",
        inputs: [integerType],
        outputs: [{ kind: "variable", name: "unknown", valueKind: "type" }],
        premises: [],
        witness: { kind: "erased-proof" },
      }]),
    /output 0 references unbound variable "unknown"/,
  );
});

Deno.test("rejects cyclic capability rule patterns at the public boundary", () => {
  const arguments_: TypeCoreCapabilityPattern[] = [];
  const recursive: TypeCoreCapabilityPattern = {
    kind: "type",
    type: { kind: "named", name: "Recursive", arguments: arguments_ },
  };
  arguments_.push(recursive);

  throws(
    () =>
      new TypeCoreCapabilityResolver([{
        id: "cyclic-pattern",
        predicate: "invalid",
        inputs: [recursive],
        outputs: [],
        premises: [],
        witness: { kind: "erased-proof" },
      }]),
    /input 0 type argument 0 contains a pattern cycle/,
  );
});
