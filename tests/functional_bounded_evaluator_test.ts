import { deepStrictEqual, ok } from "node:assert/strict";

import {
  buildSurfaceModule,
  CpuCompiler,
  effectSet,
  evaluateModuleWithBoundedWasm,
  storeType,
  surface,
} from "../functional.ts";

Deno.test("bounded evaluation exposes deep Store results", async () => {
  const signedInteger64 = { kind: "signed-integer-64" as const };
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: storeType(signedInteger64),
      body: surface.storeNew(
        surface.integer(2),
        surface.signedInteger64(7n),
      ),
    }],
    [],
    "main",
    0,
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const evaluation = await evaluateModuleWithBoundedWasm(
      compilation.module,
      { resultForm: "deep" },
    );
    ok(evaluation.ok);
    if (!evaluation.ok) return;
    deepStrictEqual(evaluation.value, {
      kind: "array",
      values: [
        { kind: "signed-integer-64", value: 7n },
        { kind: "signed-integer-64", value: 7n },
      ],
    });
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("bounded evaluation uses the supplied host initialization", async () => {
  const signedInteger64 = { kind: "signed-integer-64" as const };
  const module = buildSurfaceModule(
    [
      {
        name: "emit",
        parameters: [],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: signedInteger64,
        },
        body: surface.runtimeFault("host operation Console.emit"),
      },
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.apply(
          surface.name("emit"),
          surface.signedInteger64(20n),
        ),
      },
    ],
    [],
    "main",
    0,
    {
      hostCapabilities: [{
        name: "Console",
        fields: [{
          kind: "operation",
          name: "emit",
          effects: effectSet("Console"),
          parameter: signedInteger64,
          result: signedInteger64,
        }],
      }],
      hostDefinitions: [{
        definition: "emit",
        capability: "Console",
        field: "emit",
      }],
    },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;

  try {
    const evaluation = await evaluateModuleWithBoundedWasm(
      compilation.module,
      {
        resultForm: "deep",
        wasmInit: {
          Console: {
            emit: () => ({ kind: "signed-integer-64", value: 42n }),
          },
        },
      },
    );
    ok(evaluation.ok);
    if (!evaluation.ok) return;
    deepStrictEqual(evaluation.value, {
      kind: "signed-integer-64",
      value: 42n,
    });
  } finally {
    compilation.module.destroy();
  }
});
