import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  FunctionalBinaryOperator,
  type FunctionalSurfaceDefinition,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  surface,
} from "../functional.ts";

const ITERATION_COUNT = 1_000;
const EXPECTED_RESULT = 42 * ITERATION_COUNT;

const higherOrderDefinitions: readonly FunctionalSurfaceDefinition[] = [
  {
    name: "applyOnce",
    parameters: [],
    annotation: null,
    body: surface.lambda(
      "function",
      surface.apply(surface.name("function"), surface.integer(41)),
    ),
  },
  {
    name: "increment",
    parameters: [],
    annotation: null,
    body: surface.lambda(
      "value",
      surface.binary(
        FunctionalBinaryOperator.Add,
        surface.name("value"),
        surface.integer(1),
      ),
    ),
  },
  {
    name: "loop",
    parameters: [],
    annotation: null,
    body: surface.lambda("remaining", {
      kind: "if",
      condition: surface.binary(
        FunctionalBinaryOperator.Equal,
        surface.name("remaining"),
        surface.integer(0),
      ),
      consequent: surface.integer(0),
      alternate: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.apply(surface.name("applyOnce"), surface.name("increment")),
        surface.apply(
          surface.name("loop"),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      ),
    }),
  },
  {
    name: "main",
    parameters: [],
    annotation: null,
    body: surface.apply(surface.name("loop"), surface.integer(ITERATION_COUNT)),
  },
];

const directDefinitions: readonly FunctionalSurfaceDefinition[] = [
  {
    name: "loop",
    parameters: [],
    annotation: null,
    body: surface.lambda("remaining", {
      kind: "if",
      condition: surface.binary(
        FunctionalBinaryOperator.Equal,
        surface.name("remaining"),
        surface.integer(0),
      ),
      consequent: surface.integer(0),
      alternate: surface.binary(
        FunctionalBinaryOperator.Add,
        surface.integer(42),
        surface.apply(
          surface.name("loop"),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      ),
    }),
  },
  {
    name: "main",
    parameters: [],
    annotation: null,
    body: surface.apply(surface.name("loop"), surface.integer(ITERATION_COUNT)),
  },
];

const higherOrderModule = buildFunctionalSurfaceModule(
  higherOrderDefinitions,
  [],
  "main",
  0,
);
const directModule = buildFunctionalSurfaceModule(directDefinitions, [], "main", 0);
const device = await requestWebGpuDevice();
const compiler = await GpuFunctionalCompiler.create(device);
const higherOrderCompilation = await compiler.compileModule(higherOrderModule);
const directCompilation = await compiler.compileModule(directModule);
if (!higherOrderCompilation.ok) {
  throw new Error(
    `higher-order WASM benchmark did not compile: ${higherOrderCompilation.diagnostics[0].message}`,
  );
}
if (!directCompilation.ok) {
  higherOrderCompilation.module.destroy();
  throw new Error(
    `direct WASM benchmark did not compile: ${directCompilation.diagnostics[0].message}`,
  );
}

const higherOrderBytes = await compileFunctionalModuleToWasm(higherOrderCompilation.module);
const directBytes = await compileFunctionalModuleToWasm(directCompilation.module);
const higherOrderWasm = new WebAssembly.Module(higherOrderBytes);
const directWasm = new WebAssembly.Module(directBytes);

globalThis.addEventListener("unload", () => {
  higherOrderCompilation.module.destroy();
  directCompilation.module.destroy();
  device.destroy();
}, { once: true });

Deno.bench("emit WebAssembly: lambda-set specialized higher-order loop", async () => {
  const bytes = await compileFunctionalModuleToWasm(higherOrderCompilation.module);
  if (!WebAssembly.validate(bytes)) throw new Error("higher-order benchmark emitted invalid WASM");
});

Deno.bench("emit WebAssembly: direct loop", async () => {
  const bytes = await compileFunctionalModuleToWasm(directCompilation.module);
  if (!WebAssembly.validate(bytes)) throw new Error("direct benchmark emitted invalid WASM");
});

Deno.bench("run WebAssembly: lambda-set specialized higher-order loop", () => {
  runBenchmarkModule(higherOrderWasm, "higher-order");
});

Deno.bench("run WebAssembly: direct loop", () => {
  runBenchmarkModule(directWasm, "direct");
});

function runBenchmarkModule(module: WebAssembly.Module, context: string): void {
  const instance = new WebAssembly.Instance(module);
  const main = instance.exports.main;
  if (typeof main !== "function") throw new Error(`${context} benchmark omitted main`);
  const result = main();
  if (result !== EXPECTED_RESULT) {
    throw new Error(`${context} benchmark returned ${result}; expected ${EXPECTED_RESULT}`);
  }
}
