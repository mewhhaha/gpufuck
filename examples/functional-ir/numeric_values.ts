import {
  buildFunctionalSurfaceModule,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalNumericConversion,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../../functional.ts";

const i64 = { kind: "signed-integer-64" } as const;
const module = buildFunctionalSurfaceModule(
  [{
    name: "main",
    parameters: ["input"],
    annotation: {
      kind: "function",
      parameter: i64,
      result: {
        kind: "tuple",
        values: [i64, { kind: "float-64" }],
      },
    },
    body: surface.apply(
      surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
      surface.binary(
        FunctionalBinaryOperator.AddSignedInteger64,
        surface.name("input"),
        surface.signedInteger64(1n),
      ),
      surface.convert(
        FunctionalNumericConversion.SignedInteger64ToFloat64,
        surface.name("input"),
      ),
    ),
  }],
  [],
  "main",
  0,
);

const device = await requestWebGpuDevice();
try {
  const compiler = await GpuFunctionalCompiler.create(device);
  const compilation = await compiler.compileModule(module);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      argument: { kind: "signed-integer-64", value: 9_007_199_254_740_992n },
    });
    console.log(execution.value);
  } finally {
    compilation.module.destroy();
  }
} finally {
  device.destroy();
}
