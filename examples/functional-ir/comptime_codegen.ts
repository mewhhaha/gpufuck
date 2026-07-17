import {
  FUNCTIONAL_COMPTIME_IR_SCHEMA,
  FUNCTIONAL_COMPTIME_IR_TYPES,
  FunctionalBinaryOperator,
  type FunctionalComptimeModuleArtifact,
  functionalConstantExpression,
  functionalConstantFromGeneratedDefinitions,
  type FunctionalModuleArtifact,
  GpuFunctionalCompiler,
  GpuFunctionalComptimeExecutor,
  linkFunctionalModules,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  spliceFunctionalGeneratedDefinitions,
  surface,
} from "../../functional.ts";

const generatedDefinitions = functionalConstantFromGeneratedDefinitions([{
  name: "answer",
  parameters: [],
  body: surface.binary(
    FunctionalBinaryOperator.Add,
    surface.integer(20),
    surface.integer(22),
  ),
}]);
const generator: FunctionalComptimeModuleArtifact = {
  name: "generator",
  definitions: [{
    name: "generate",
    parameters: ["seed"],
    annotation: {
      kind: "function",
      parameter: { kind: "integer" },
      result: FUNCTIONAL_COMPTIME_IR_SCHEMA,
    },
    body: functionalConstantExpression(generatedDefinitions),
  }],
  typeDeclarations: FUNCTIONAL_COMPTIME_IR_TYPES,
  imports: [],
  exports: [{
    name: "generate",
    definition: "generate",
    type: {
      kind: "function",
      parameter: { kind: "integer" },
      result: FUNCTIONAL_COMPTIME_IR_SCHEMA,
    },
  }],
  sourceByteLength: 100,
};
const application: FunctionalModuleArtifact = {
  name: "application",
  definitions: [{
    name: "main",
    parameters: [],
    annotation: { kind: "integer" },
    body: surface.name("answer"),
  }],
  typeDeclarations: [],
  imports: [],
  exports: [{ name: "main", definition: "main", type: { kind: "integer" } }],
  sourceByteLength: 20,
  options: {},
};

const device = await requestWebGpuDevice();
try {
  const [compiler, comptime] = await Promise.all([
    GpuFunctionalCompiler.create(device),
    GpuFunctionalComptimeExecutor.create(device),
  ]);
  const generatorCompilation = await comptime.compileFunction(
    [generator],
    { module: generator.name, exportName: "generate" },
  );
  if (!generatorCompilation.ok) {
    throw new Error(generatorCompilation.diagnostics[0].message);
  }
  try {
    const generated = await generatorCompilation.compiledFunction.invoke({
      kind: "integer",
      value: 0,
    });
    if (!generated.ok) throw new Error(`metaprogram failed during ${generated.stage}`);
    const spliced = spliceFunctionalGeneratedDefinitions(application, generated.value);
    const linked = linkFunctionalModules(
      [spliced],
      { module: spliced.name, exportName: "main" },
    );
    const compilation = await compiler.compileModule(linked.module);
    if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
    try {
      const execution = await runFunctionalWasmModule(compilation.module);
      console.log(JSON.stringify({ value: execution.value, memoized: generated.stats.memoized }));
    } finally {
      compilation.module.destroy();
    }
  } finally {
    generatorCompilation.compiledFunction.destroy();
  }
} finally {
  device.destroy();
}
