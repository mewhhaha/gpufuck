import {
  buildFunctionalSurfaceModule,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  lowerFunctionalEffectProgram,
  requestWebGpuDevice,
  surface,
} from "../../functional.ts";

const handled = lowerFunctionalEffectProgram({
  operations: [{
    effect: "Reader",
    name: "ask",
    parameter: { kind: "unit" },
    result: { kind: "integer" },
  }],
  handlers: [{
    effect: "Reader",
    operation: "ask",
    implementation: surface.lambda(
      "$request",
      surface.lambda("$resume", surface.apply(surface.name("$resume"), surface.integer(40))),
    ),
  }],
  expression: {
    kind: "bind",
    name: "answer",
    computation: {
      kind: "perform",
      effect: "Reader",
      operation: "ask",
      argument: surface.name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME),
    },
    body: {
      kind: "pure",
      value: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.name("answer"),
        surface.integer(2),
      ),
      valueType: { kind: "integer" },
    },
  },
});
const module = buildFunctionalSurfaceModule(
  [
    ...handled.definitions,
    {
      name: "gpuMain",
      parameters: [],
      annotation: handled.resultType.value,
      body: handled.expression,
    },
  ],
  [],
  "gpuMain",
  0,
);
const device = await requestWebGpuDevice();
try {
  const [compiler, evaluator] = await Promise.all([
    GpuFunctionalCompiler.create(device),
    GpuFunctionalEvaluator.create(device),
  ]);
  const compilation = await compiler.compileModule(module);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
  try {
    const evaluation = await evaluator.evaluate(compilation.module);
    if (!evaluation.ok) throw new Error(evaluation.fault.message);
    console.log(JSON.stringify(
      {
        computationType: handled.computationType,
        resultType: handled.resultType,
        value: evaluation.value,
      },
      null,
      2,
    ));
  } finally {
    compilation.module.destroy();
  }
} finally {
  device.destroy();
}
