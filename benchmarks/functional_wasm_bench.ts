import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  FunctionalBinaryOperator,
  type FunctionalSurfaceDefinition,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../functional.ts";
import {
  encodeCompactScalarWasmModule,
  type WasmFunctionBody,
  WasmInstructions,
  WasmValueType,
} from "../src/functional/wasm_binary.ts";

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

const tailWorkerDefinitions: readonly FunctionalSurfaceDefinition[] = [
  {
    name: "loop",
    parameters: [],
    annotation: null,
    body: surface.lambda(
      "value",
      surface.lambda("remaining", {
        kind: "if",
        condition: surface.binary(
          FunctionalBinaryOperator.Equal,
          surface.name("remaining"),
          surface.integer(0),
        ),
        consequent: surface.name("value"),
        alternate: surface.apply(
          surface.apply(
            surface.name("loop"),
            surface.binary(
              FunctionalBinaryOperator.Add,
              surface.name("value"),
              surface.integer(42),
            ),
          ),
          surface.binary(
            FunctionalBinaryOperator.Subtract,
            surface.name("remaining"),
            surface.integer(1),
          ),
        ),
      }),
    ),
  },
  {
    name: "main",
    parameters: [],
    annotation: null,
    body: surface.apply(
      surface.apply(surface.name("loop"), surface.integer(0)),
      surface.integer(ITERATION_COUNT),
    ),
  },
];

const higherOrderModule = buildFunctionalSurfaceModule(
  higherOrderDefinitions,
  [],
  "main",
  0,
);
const directModule = buildFunctionalSurfaceModule(directDefinitions, [], "main", 0);
const tailWorkerModule = buildFunctionalSurfaceModule(tailWorkerDefinitions, [], "main", 0);
const device = await requestWebGpuDevice();
const compiler = await GpuFunctionalCompiler.create(device);
const higherOrderCompilation = await compiler.compileModule(higherOrderModule);
if (!higherOrderCompilation.ok) {
  throw new Error(
    `higher-order WASM benchmark did not compile: ${higherOrderCompilation.diagnostics[0].message}`,
  );
}
const directCompilation = await compiler.compileModule(directModule);
if (!directCompilation.ok) {
  higherOrderCompilation.module.destroy();
  throw new Error(
    `direct WASM benchmark did not compile: ${directCompilation.diagnostics[0].message}`,
  );
}
const tailWorkerCompilation = await compiler.compileModule(tailWorkerModule);
if (!tailWorkerCompilation.ok) {
  higherOrderCompilation.module.destroy();
  directCompilation.module.destroy();
  throw new Error(
    `tail-worker WASM benchmark did not compile: ${tailWorkerCompilation.diagnostics[0].message}`,
  );
}

const higherOrderBytes = await compileFunctionalModuleToWasm(higherOrderCompilation.module);
const directBytes = await compileFunctionalModuleToWasm(directCompilation.module);
const tailWorkerBytes = await compileFunctionalModuleToWasm(tailWorkerCompilation.module);
const higherOrderWasm = new WebAssembly.Module(higherOrderBytes);
const directWasm = new WebAssembly.Module(directBytes);
const tailWorkerWasm = new WebAssembly.Module(tailWorkerBytes);
const controlFlowWasm = new WebAssembly.Module(controlFlowBaseline());
const tailWorkerWarmInstance = new WebAssembly.Instance(tailWorkerWasm);
const tailWorkerWarmMain = tailWorkerWarmInstance.exports.main;
if (typeof tailWorkerWarmMain !== "function") throw new Error("tail-worker benchmark omitted main");
const cachedRunnerWarmup = await runFunctionalWasmModule(tailWorkerCompilation.module);
if (
  cachedRunnerWarmup.value.kind !== "integer" || cachedRunnerWarmup.value.value !== EXPECTED_RESULT
) {
  throw new Error("cached runner warmup returned the wrong value");
}

globalThis.addEventListener("unload", () => {
  higherOrderCompilation.module.destroy();
  directCompilation.module.destroy();
  tailWorkerCompilation.module.destroy();
  device.destroy();
}, { once: true });

Deno.bench("compile and emit WebAssembly: higher-order loop", async () => {
  const compilation = await compiler.compileModule(higherOrderModule);
  if (!compilation.ok) {
    throw new Error(
      `higher-order WASM benchmark did not compile: ${compilation.diagnostics[0].message}`,
    );
  }
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    if (!WebAssembly.validate(bytes)) {
      throw new Error("higher-order benchmark emitted invalid WASM");
    }
  } finally {
    compilation.module.destroy();
  }
});

Deno.bench("reuse emitted WebAssembly: lambda-set specialized higher-order loop", async () => {
  const bytes = await compileFunctionalModuleToWasm(higherOrderCompilation.module);
  if (!WebAssembly.validate(bytes)) throw new Error("higher-order benchmark emitted invalid WASM");
});

Deno.bench("reuse emitted WebAssembly: direct loop", async () => {
  const bytes = await compileFunctionalModuleToWasm(directCompilation.module);
  if (!WebAssembly.validate(bytes)) throw new Error("direct benchmark emitted invalid WASM");
});

Deno.bench("reuse emitted WebAssembly: uncurried numeric tail worker", async () => {
  const bytes = await compileFunctionalModuleToWasm(tailWorkerCompilation.module);
  if (!WebAssembly.validate(bytes)) throw new Error("tail-worker benchmark emitted invalid WASM");
});

Deno.bench("run WebAssembly: lambda-set specialized higher-order loop", () => {
  runBenchmarkModule(higherOrderWasm, "higher-order");
});

Deno.bench("run WebAssembly: direct loop", () => {
  runBenchmarkModule(directWasm, "direct");
});

Deno.bench("run WebAssembly: uncurried numeric tail worker", () => {
  runBenchmarkModule(tailWorkerWasm, "tail-worker");
});

Deno.bench("run WebAssembly: hand-written control-flow loop", () => {
  runBenchmarkModule(controlFlowWasm, "control-flow");
});

Deno.bench("run WebAssembly: cached artifact with fresh instance", async () => {
  const execution = await runFunctionalWasmModule(tailWorkerCompilation.module);
  if (execution.value.kind !== "integer" || execution.value.value !== EXPECTED_RESULT) {
    throw new Error("cached runner benchmark returned the wrong value");
  }
});

Deno.bench("run WebAssembly: warm uncurried numeric tail worker", () => {
  const result = tailWorkerWarmMain();
  if (result !== EXPECTED_RESULT) {
    throw new Error(`warm tail-worker benchmark returned ${result}; expected ${EXPECTED_RESULT}`);
  }
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

function controlFlowBaseline(): Uint8Array<ArrayBuffer> {
  const instructions = new WasmInstructions(0);
  const remaining = instructions.addLocal(WasmValueType.I32);
  const total = instructions.addLocal(WasmValueType.I32);
  instructions.i32Const(ITERATION_COUNT);
  instructions.localSet(remaining);
  instructions.i32Const(0);
  instructions.localSet(total);
  instructions.emit(0x02, WasmValueType.I32, 0x03, 0x40);
  instructions.localGet(remaining);
  instructions.emit(0x45, 0x04, 0x40);
  instructions.localGet(total);
  instructions.branch(2);
  instructions.emit(0x0b);
  instructions.localGet(total);
  instructions.i32Const(42);
  instructions.emit(0x6a);
  instructions.localSet(total);
  instructions.localGet(remaining);
  instructions.i32Const(1);
  instructions.emit(0x6b);
  instructions.localSet(remaining);
  instructions.branch(0);
  instructions.emit(0x0b, 0x00, 0x0b);
  const body: WasmFunctionBody = {
    typeIndex: 3,
    localTypes: instructions.localTypes,
    instructions: instructions.bytes,
    usesMemory: false,
    usesIndirectCalls: false,
  };
  return encodeCompactScalarWasmModule([body], 0, [], {
    includesRuntimeFaults: false,
    instrumentedFuel: false,
  });
}
