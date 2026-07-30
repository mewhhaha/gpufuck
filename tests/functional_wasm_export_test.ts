import { deepStrictEqual, ok, rejects } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  CpuCompiler,
  runWasmExport,
  storeType,
  surface,
} from "../functional.ts";

Deno.test("invokes named WebAssembly exports through the typed boundary", async () => {
  const signedInteger64 = { kind: "signed-integer-64" as const };
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "answer",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(42n),
      },
      {
        name: "add",
        parameters: ["left", "right"],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: {
            kind: "function",
            parameter: signedInteger64,
            result: signedInteger64,
          },
        },
        body: surface.binary(
          BinaryOperator.AddSignedInteger64,
          surface.name("left"),
          surface.name("right"),
        ),
      },
      {
        name: "values",
        parameters: [],
        annotation: storeType(signedInteger64),
        body: surface.storeNew(
          surface.integer(2),
          surface.signedInteger64(7n),
        ),
      },
    ],
    [],
    "main",
    0,
    {
      wasmExports: [
        { name: "answer", definition: "answer" },
        { name: "add", definition: "add" },
        { name: "values", definition: "values" },
      ],
    },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const answer = await runWasmExport(compilation.module, "answer");
    deepStrictEqual(answer.value, {
      kind: "signed-integer-64",
      value: 42n,
    });
    const sum = await runWasmExport(compilation.module, "add", {
      arguments: [
        { kind: "signed-integer-64", value: 20n },
        { kind: "signed-integer-64", value: 22n },
      ],
    });
    deepStrictEqual(sum.value, {
      kind: "signed-integer-64",
      value: 42n,
    });
    const values = await runWasmExport(compilation.module, "values");
    deepStrictEqual(values.value, {
      kind: "array",
      values: [
        { kind: "signed-integer-64", value: 7n },
        { kind: "signed-integer-64", value: 7n },
      ],
    });
    await rejects(
      () => runWasmExport(compilation.module, "missing"),
      /has no named export "missing"/,
    );
    await rejects(
      () => runWasmExport(compilation.module, "add"),
      /requires 2 arguments; received 0/,
    );
  } finally {
    compilation.module.destroy();
  }
});
