import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  type CanonicalAbiInterface,
  compileModuleToComponentBoundary,
  ComponentReloadSlot,
  CpuCompiler,
  NumericConversion,
  surface,
} from "../functional.ts";

const signedInteger64 = { kind: "signed-integer-64" as const };
const addInterface: CanonicalAbiInterface = {
  version: 1,
  imports: [],
  exports: [{
    name: "add",
    function: {
      parameters: [signedInteger64, signedInteger64],
      result: signedInteger64,
    },
  }],
};

Deno.test("component boundary pairs canonical Core Wasm with deterministic WIT", async () => {
  const module = buildSurfaceModule(
    [
      {
        name: "main",
        parameters: [],
        annotation: signedInteger64,
        body: surface.signedInteger64(0n),
      },
      {
        name: "add",
        parameters: ["left", "right"],
        annotation: {
          kind: "function",
          parameter: signedInteger64,
          result: { kind: "function", parameter: signedInteger64, result: signedInteger64 },
        },
        body: surface.binary(
          BinaryOperator.AddSignedInteger64,
          surface.name("left"),
          surface.name("right"),
        ),
      },
    ],
    [],
    "main",
    0,
    { wasmExports: [{ name: "add", definition: "add" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("component boundary fixture did not compile");
  try {
    const artifact = await compileModuleToComponentBoundary(compilation.module, addInterface, {
      packageName: "mewhhaha:gpufuck-test@1.0.0",
      worldName: "calculator",
    });
    equal(
      artifact.wit,
      "package mewhhaha:gpufuck-test@1.0.0;\n\n" +
        "world calculator {\n" +
        "  export add: func(argument-0: s64, argument-1: s64) -> s64;\n" +
        "}\n",
    );
    const second = await compileModuleToComponentBoundary(compilation.module, addInterface, {
      packageName: "mewhhaha:gpufuck-test@1.0.0",
      worldName: "calculator",
    });
    deepStrictEqual(second, artifact);
    const { instance } = await WebAssembly.instantiate(artifact.coreWasm);
    const add = instance.exports.add;
    ok(typeof add === "function");
    equal(add(20n, 22n), 42n);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("component boundary renders canonical floating-point types", async () => {
  const float32 = { kind: "float-32" as const };
  const float64 = { kind: "float-64" as const };
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: float64,
      body: surface.float64(0),
    }, {
      name: "widen",
      parameters: ["value"],
      annotation: { kind: "function", parameter: float32, result: float64 },
      body: surface.convert(NumericConversion.Float32ToFloat64, surface.name("value")),
    }],
    [],
    "main",
    0,
    { wasmExports: [{ name: "widen", definition: "widen" }] },
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) throw new Error("floating-point component fixture did not compile");
  try {
    const artifact = await compileModuleToComponentBoundary(compilation.module, {
      version: 1,
      imports: [],
      exports: [{
        name: "widen",
        function: { parameters: [float32], result: float64 },
      }],
    });
    ok(artifact.wit.includes("func(argument-0: float32) -> float64"));
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("component boundary rejects names that cannot preserve the Core export", async () => {
  const invalidInterface: CanonicalAbiInterface = {
    ...addInterface,
    exports: [{ ...addInterface.exports[0]!, name: "blot:add" }],
  };
  await rejects(
    () => compileModuleToComponentBoundary({} as never, invalidInterface),
    /export name "blot:add" must be a lower-kebab WIT identifier/,
  );
});

Deno.test("component reload swaps compatible versions and drains active calls", async () => {
  const contract = "package mewhhaha:counter;\nworld counter {}\n";
  const hostState = { count: 0 };
  let releaseOldCall: (() => void) | undefined;
  let oldDisposed = false;
  const oldCallReleased = new Promise<void>((resolve) => releaseOldCall = resolve);
  const slot = new ComponentReloadSlot({
    wit: contract,
    exports: {
      increment: async (state: typeof hostState) => {
        await oldCallReleased;
        state.count += 1;
        return state.count;
      },
    },
    dispose: () => {
      oldDisposed = true;
    },
  });
  const inFlight = slot.call((exports) => exports.increment(hostState));
  await slot.replace({
    wit: contract,
    exports: {
      increment: (state: typeof hostState) => {
        state.count += 2;
        return Promise.resolve(state.count);
      },
    },
  }, async (exports) => {
    const isolatedState = { count: 0 };
    equal(await exports.increment(isolatedState), 2);
  });
  equal(oldDisposed, false);
  equal(await slot.call((exports) => exports.increment(hostState)), 2);
  releaseOldCall?.();
  equal(await inFlight, 3);
  equal(oldDisposed, true);
  equal(hostState.count, 3);
});
