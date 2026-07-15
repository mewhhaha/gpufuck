import {
  buildFunctionalSurfaceModule,
  FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../../functional.ts";

const module = buildFunctionalSurfaceModule(
  [{
    name: "main",
    parameters: ["init"],
    annotation: null,
    body: {
      kind: "case",
      value: surface.name("init"),
      arms: [{
        constructor: FUNCTIONAL_INIT_CONSTRUCTOR_NAME,
        binders: ["write"],
        body: {
          kind: "case",
          value: surface.apply(surface.name("write"), surface.integer(7)),
          arms: [{
            constructor: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
            binders: [],
            body: surface.integer(42),
          }],
        },
      }],
    },
  }],
  [],
  "main",
  0,
  {
    hostCapabilities: [{
      name: "Console",
      fields: [{
        kind: "operation",
        name: "write",
        purity: "effectful",
        parameter: { kind: "integer" },
        result: { kind: "unit" },
      }],
    }],
  },
);

const device = await requestWebGpuDevice();
try {
  const compiler = await GpuFunctionalCompiler.create(device);
  const compilation = await compiler.compileModule(module);
  if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
  try {
    const execution = await runFunctionalWasmModule(compilation.module, {
      init: {
        Console: {
          write: (argument) => {
            if (argument.kind !== "integer") {
              throw new TypeError(`Console.write expected integer; received ${argument.kind}`);
            }
            console.log(`host write: ${argument.value}`);
            return { kind: "unit" };
          },
        },
      },
    });
    console.log(JSON.stringify(execution.value));
  } finally {
    compilation.module.destroy();
  }
} finally {
  device.destroy();
}
