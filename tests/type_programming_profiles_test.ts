import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";

import {
  functionalSchemaFromTypeCoreType,
  GpuFunctionalCompiler,
  GpuTypeCoreExecutor,
  requestWebGpuDevice,
  type TypeCoreType,
  type TypeCoreValue,
} from "../functional.ts";
import {
  idris2VectorModule,
  idris2VectorTypeProgram,
  runIdris2VectorExample,
} from "../examples/type-programming/idris2_vector.ts";
import {
  runZigComptimeExample,
  zigMatrixTypeProgram,
} from "../examples/type-programming/zig_comptime.ts";
import { runZigReflectionExample } from "../examples/type-programming/zig_reflection.ts";
import { zigReflectionProgram } from "../examples/type-programming/zig_reflection_program.ts";

let device: GPUDevice | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
});

Deno.test("Idris2-style type reduction checks a length-indexed vector", async () => {
  const execution = await runIdris2VectorExample(typeProgrammingDevice());
  const zero: TypeCoreType = { kind: "named", name: "Z", arguments: [] };
  const length = successor(successor(successor(zero)));

  deepStrictEqual(execution.computedType, {
    kind: "named",
    name: "Vect",
    arguments: [typeValue(length), typeValue({ kind: "integer" })],
  });
  deepStrictEqual(execution.inferredType, {
    kind: "named",
    name: "Vect",
    arguments: [
      {
        kind: "named",
        name: "S",
        arguments: [{
          kind: "named",
          name: "S",
          arguments: [{
            kind: "named",
            name: "S",
            arguments: [{ kind: "named", name: "Z", arguments: [] }],
          }],
        }],
      },
      { kind: "integer" },
    ],
  });
  deepStrictEqual(execution.value, {
    kind: "constructor",
    name: "Cons",
    fieldCount: 2,
    fields: [
      { kind: "integer", value: 40 },
      {
        kind: "constructor",
        name: "Cons",
        fieldCount: 2,
        fields: [
          { kind: "integer", value: 1 },
          {
            kind: "constructor",
            name: "Cons",
            fieldCount: 2,
            fields: [
              { kind: "integer", value: 1 },
              { kind: "constructor", name: "Nil", fieldCount: 0, fields: [] },
            ],
          },
        ],
      },
    ],
  });
});

Deno.test("Idris2-style indexing rejects a vector with the wrong term length", async () => {
  const executor = await GpuTypeCoreExecutor.create(typeProgrammingDevice());
  const result = await executor.execute(idris2VectorTypeProgram());
  ok(result.ok, result.ok ? undefined : result.stage);
  if (!result.ok || result.value.kind !== "type") return;
  const compiler = await GpuFunctionalCompiler.create(typeProgrammingDevice());
  const compilation = await compiler.compileModule(idris2VectorModule(
    functionalSchemaFromTypeCoreType(result.value.type),
    [40, 2],
  ));

  equal(compilation.ok, false);
  if (!compilation.ok) equal(compilation.diagnostics[0].code, "F2102");
});

Deno.test("Zig-style comptime constructs a type and specializes executable WASM", async () => {
  const execution = await runZigComptimeExample(typeProgrammingDevice());

  deepStrictEqual(execution.matrixType, {
    kind: "named",
    name: "Array",
    arguments: [
      { kind: "integer", value: 6 },
      {
        kind: "type",
        type: {
          kind: "named",
          name: "Array",
          arguments: [
            { kind: "integer", value: 7 },
            typeValue({ kind: "integer" }),
          ],
        },
      },
    ],
  });
  equal(execution.cellCount, 42);
  equal(execution.wasmValue, 42);
});

Deno.test("Zig-style comptime iterates fields and statically dispatches an attached method", async () => {
  const execution = await runZigReflectionExample(typeProgrammingDevice());

  equal(execution.generatedType.kind, "named");
  if (execution.generatedType.kind === "named") equal(execution.generatedType.name, "Object");
  equal(execution.fieldBytes, 5);
  equal(execution.methodImplementation, "Wrapped.get");
  deepStrictEqual(execution.methodResult, { kind: "integer" });
  equal(execution.wasmValue, 42);
});

Deno.test("Zig-style method lookup reports a missing declaration", async () => {
  const executor = await GpuTypeCoreExecutor.create(typeProgrammingDevice());
  const result = await executor.execute(zigReflectionProgram("missing"));
  ok(result.ok, result.ok ? undefined : result.stage);
  if (!result.ok || result.value.kind !== "type" || result.value.type.kind !== "named") return;

  deepStrictEqual(result.value.type.arguments[2], { kind: "symbol", value: "<missing>" });
  deepStrictEqual(result.value.type.arguments[3], {
    kind: "type",
    type: { kind: "unit" },
  });
});

Deno.test("type-programming profiles preserve results across dispatch quanta", async () => {
  const executor = await GpuTypeCoreExecutor.create(typeProgrammingDevice());
  for (
    const program of [
      idris2VectorTypeProgram(),
      zigMatrixTypeProgram(),
      zigReflectionProgram(),
    ]
  ) {
    const bounded = await executor.execute(program, { maximumStepsPerDispatch: 256 });
    const full = await executor.execute(program, { maximumStepsPerDispatch: 4_096 });
    ok(bounded.ok, bounded.ok ? undefined : bounded.stage);
    ok(full.ok, full.ok ? undefined : full.stage);
    if (!bounded.ok || !full.ok) continue;
    deepStrictEqual(bounded.value, full.value);
    deepStrictEqual(bounded.stats, full.stats);
  }
});

Deno.test("functional schemas reject unerased comptime value indices", () => {
  throws(
    () =>
      functionalSchemaFromTypeCoreType({
        kind: "named",
        name: "Array",
        arguments: [{ kind: "integer", value: 6 }, typeValue({ kind: "integer" })],
      }),
    /result "Array" argument 0 has kind integer.*accepts type arguments only/,
  );
});

Deno.test("functional schema staging rejects cyclic Type Core results", () => {
  const arguments_: TypeCoreValue[] = [];
  const recursive: TypeCoreType = { kind: "named", name: "Recursive", arguments: arguments_ };
  arguments_.push(typeValue(recursive));

  throws(
    () => functionalSchemaFromTypeCoreType(recursive),
    /result contains a type cycle/,
  );
});

function typeProgrammingDevice(): GPUDevice {
  if (device === undefined) throw new Error("type-programming test device was not initialized");
  return device;
}

function typeValue(type: TypeCoreType): TypeCoreValue {
  return { kind: "type", type };
}

function successor(predecessor: TypeCoreType): TypeCoreType {
  return {
    kind: "named",
    name: "S",
    arguments: [typeValue(predecessor)],
  };
}
