import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";

import {
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
} from "../functional.ts";
import {
  createPureScriptTypeProfile,
  parsePureScriptTypeProfile,
  PureScriptProfileSyntaxError,
} from "../purescript_type_profile.ts";

Deno.test("represents PureScript rows, functional dependencies, composed capabilities, and rank-2 use", async () => {
  const source = await Deno.readTextFile("examples/purescript-functional/type_profile.purs");
  const profile = createPureScriptTypeProfile(source);

  equal(profile.source.moduleName, "TypeProfile");
  deepStrictEqual(profile.source.imports, ["Prelude"]);

  deepStrictEqual(profile.rowSubstitution, [{
    variable: "rest",
    row: {
      kind: "record",
      fields: [{
        label: "label",
        type: { kind: "named", name: "Text", arguments: [] },
      }],
      tail: null,
    },
  }]);
  deepStrictEqual(profile.convertedType, { kind: "named", name: "Text", arguments: [] });
  equal(profile.functorEvidence.ruleId, "functor-compose");
  deepStrictEqual(
    profile.functorEvidence.premises.map((premise) => premise.ruleId),
    ["functor-array", "functor-maybe"],
  );

  const device = await requestWebGpuDevice();
  try {
    const compiler = await GpuFunctionalCompiler.create(device);
    const compilation = await compiler.compileModule(profile.rank2Module);
    ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
    if (!compilation.ok) return;
    try {
      const execution = await runFunctionalWasmModule(compilation.module);
      deepStrictEqual(execution.value, { kind: "integer", value: 42 });
    } finally {
      compilation.module.destroy();
    }
  } finally {
    device.destroy();
  }
});

Deno.test("reports malformed PureScript profile syntax through Baba", () => {
  let failure: unknown;
  try {
    parsePureScriptTypeProfile("module Broken where; main :: Int");
  } catch (error) {
    failure = error;
  }

  ok(failure instanceof PureScriptProfileSyntaxError);
  equal(failure.span.startByte, 32);
});

Deno.test("requires parsed PureScript profile features before constructing the workload", async () => {
  const source = await Deno.readTextFile("examples/purescript-functional/type_profile.purs");

  throws(
    () => createPureScriptTypeProfile(source.replace(" | a -> b", "")),
    /must declare the functional dependency Convert a b \| a -> b/,
  );
});
