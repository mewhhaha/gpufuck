import {
  type FunctionalEffectCoreModule,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../../functional.ts";

const module: FunctionalEffectCoreModule = {
  definitions: [],
  typeDeclarations: [],
  operations: [],
  hostCapabilities: [{
    name: "Console",
    fields: [{
      kind: "operation",
      name: "record",
      purity: "effectful",
      parameter: { kind: "integer" },
      result: { kind: "integer" },
    }],
  }],
  expression: {
    kind: "bind",
    name: "first",
    computation: {
      kind: "host-call",
      capability: "Console",
      operation: "record",
      argument: surface.integer(1),
      argumentType: { kind: "integer" },
    },
    body: {
      kind: "host-call",
      capability: "Console",
      operation: "record",
      argument: surface.integer(2),
      argumentType: { kind: "integer" },
    },
  },
  entryName: "main",
  sourceByteLength: 0,
};

const device = await requestWebGpuDevice();
try {
  const compiler = await GpuFunctionalCompiler.create(device);
  const compilation = await compiler.compileEffectModule(module);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
  const observed: number[] = [];
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Console: {
          record: (argument) => {
            if (argument.kind !== "integer") {
              throw new TypeError(`Console.record expected integer; received ${argument.kind}`);
            }
            observed.push(argument.value);
            return argument;
          },
        },
      },
    });
    console.log(JSON.stringify(
      {
        effects: compilation.module.entryEffects,
        observed,
        value: execution.value,
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
