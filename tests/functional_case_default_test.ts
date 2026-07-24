/**
 * Inference rejects a non-exhaustive case, so a frontend wanting a fallback had to enumerate the
 * owner's constructors itself and hoist the fallback into a thunk to avoid duplicating it per arm.
 * Gleam does exactly that in `lowerSequentialCase`.
 */
import { equal, ok, throws } from "node:assert/strict";

import {
  buildFunctionalSurfaceModule,
  FunctionalEvaluationProfile,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  requestWebGpuDevice,
  surface,
} from "../functional.ts";

let device: GPUDevice | undefined;
let compiler: GpuFunctionalCompiler | undefined;
let evaluator: GpuFunctionalEvaluator | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  compiler = await GpuFunctionalCompiler.create(device);
  evaluator = await GpuFunctionalEvaluator.create(device);
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

function colourModule(
  subject: string,
  otherwise: Parameters<typeof buildFunctionalSurfaceModule>[0],
) {
  return otherwise;
}

async function runColour(subject: string, binder?: string) {
  const module = buildFunctionalSurfaceModule(
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
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
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
      buildFunctionalSurfaceModule(
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
        { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
      ),
    /needs at least one arm naming a declared constructor/,
  );
});
