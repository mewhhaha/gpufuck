/**
 * Inference rejects a non-exhaustive case, so a frontend wanting a fallback had to enumerate the
 * owner's constructors itself and hoist the fallback into a thunk to avoid duplicating it per arm.
 * Gleam does exactly that in `lowerSequentialCase`.
 */
import { equal, ok, throws } from "node:assert/strict";

import {
  buildSurfaceModule,
  GpuCompiler,
  GpuEvaluator,
  linkModules,
  requestWebGpuDevice,
  surface,
} from "../functional.ts";

let device: GPUDevice | undefined;
let compiler: GpuCompiler | undefined;
let evaluator: GpuEvaluator | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  compiler = await GpuCompiler.create(device);
  evaluator = await GpuEvaluator.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  compiler = undefined;
  evaluator = undefined;
});

const COLOUR = {
  name: "Colour",
  parameters: [],
  constructors: [
    { name: "Red", fields: [] },
    { name: "Green", fields: [] },
    { name: "Blue", fields: [{ name: "shade", type: { kind: "integer" as const } }] },
  ],
};

async function runColour(subject: string, binder?: string) {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: {
        kind: "case",
        value: subject === "Blue"
          ? surface.apply(surface.name("Blue"), surface.integer(7))
          : surface.name(subject),
        arms: [{ constructor: "Red", binders: [], body: surface.integer(1) }],
        otherwise: {
          ...(binder === undefined ? {} : { binder }),
          body: binder === undefined ? surface.integer(99) : surface.integer(42),
        },
      },
    }],
    [COLOUR],
    "main",
    0,
  );
  const compilation = await compiler!.compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) throw new Error("case default module did not compile");
  try {
    const execution = await evaluator!.evaluate(compilation.module);
    ok(execution.ok, "evaluation failed");
    return execution.ok ? execution.value : undefined;
  } finally {
    compilation.module.destroy();
  }
}

Deno.test("an explicit arm still wins over the default", async () => {
  const value = await runColour("Red");
  equal(value?.kind, "integer");
  equal(value?.kind === "integer" ? value.value : undefined, 1);
});

Deno.test("the default covers a nullary constructor the arms omit", async () => {
  const value = await runColour("Green");
  equal(value?.kind === "integer" ? value.value : undefined, 99);
});

Deno.test("the default covers a constructor with fields", async () => {
  const value = await runColour("Blue");
  equal(value?.kind === "integer" ? value.value : undefined, 99);
});

Deno.test("a case default needs an arm naming a declared constructor", () => {
  throws(
    () =>
      buildSurfaceModule(
        [{
          name: "main",
          parameters: [],
          annotation: null,
          body: {
            kind: "case",
            value: surface.name("Red"),
            arms: [{ constructor: "NotDeclared", binders: [], body: surface.integer(1) }],
            otherwise: { body: surface.integer(0) },
          },
        }],
        [COLOUR],
        "main",
        0,
      ),
    /needs at least one arm naming a declared constructor/,
  );
});

Deno.test("a default body's names survive linking and reachability", async () => {
  // The default body is the only reference to an imported definition, so reachability has to walk
  // `otherwise` or the definition is pruned and the name is unresolvable. Reverting that walk fails
  // this test with `unknown name "colours::$import$borrowedFallback"`. The linker's matching rewrite
  // of the default body is exercised too, though an unqualified alias happens to resolve anyway, so
  // this test does not isolate it.
  const linked = linkModules([
    {
      name: "support",
      definitions: [{
        name: "fallbackValue",
        parameters: [],
        annotation: { kind: "integer" },
        body: surface.integer(77),
      }],
      typeDeclarations: [],
      imports: [],
      exports: [{ name: "fallbackValue", definition: "fallbackValue", type: { kind: "integer" } }],
      sourceByteLength: 0,
      options: {},
    },
    {
      name: "colours",
      definitions: [{
        name: "main",
        parameters: [],
        annotation: { kind: "integer" },
        body: {
          kind: "case",
          value: surface.name("Green"),
          arms: [{ constructor: "Red", binders: [], body: surface.integer(1) }],
          otherwise: { body: surface.name("borrowedFallback") },
        },
      }],
      typeDeclarations: [COLOUR],
      imports: [{
        name: "borrowedFallback",
        fromModule: "support",
        exportName: "fallbackValue",
        type: { kind: "integer" },
      }],
      exports: [{ name: "main", definition: "main", type: { kind: "integer" } }],
      sourceByteLength: 0,
      options: {},
    },
  ], { module: "colours", exportName: "main" });

  const compilation = await compiler!.compileModule(linked.module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0]?.message);
  if (!compilation.ok) return;
  try {
    const execution = await evaluator!.evaluate(compilation.module);
    ok(execution.ok, "evaluation failed");
    equal(
      execution.ok && execution.value.kind === "integer" ? execution.value.value : undefined,
      77,
    );
  } finally {
    compilation.module.destroy();
  }
});
