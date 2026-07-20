import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
} from "../functional.ts";
import {
  encodeCompactScalarWasmModule,
  FunctionalWasmFunctionType,
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
const uniqueRebuildModule = constructorRebuildModule(128, "consume-once");
const aliasedRebuildModule = constructorRebuildModule(128, "retain-alias");
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
const uniqueRebuildCompilation = await compiler.compileModule(uniqueRebuildModule);
if (!uniqueRebuildCompilation.ok) {
  higherOrderCompilation.module.destroy();
  directCompilation.module.destroy();
  tailWorkerCompilation.module.destroy();
  throw new Error(
    `unique-rebuild WASM benchmark did not compile: ${
      uniqueRebuildCompilation.diagnostics[0].message
    }`,
  );
}
const aliasedRebuildCompilation = await compiler.compileModule(aliasedRebuildModule);
if (!aliasedRebuildCompilation.ok) {
  higherOrderCompilation.module.destroy();
  directCompilation.module.destroy();
  tailWorkerCompilation.module.destroy();
  uniqueRebuildCompilation.module.destroy();
  throw new Error(
    `aliased-rebuild WASM benchmark did not compile: ${
      aliasedRebuildCompilation.diagnostics[0].message
    }`,
  );
}

const higherOrderBytes = await compileFunctionalModuleToWasm(higherOrderCompilation.module);
const directBytes = await compileFunctionalModuleToWasm(directCompilation.module);
const tailWorkerBytes = await compileFunctionalModuleToWasm(tailWorkerCompilation.module);
const uniqueRebuildBytes = await compileFunctionalModuleToWasm(uniqueRebuildCompilation.module);
if (!WebAssembly.validate(uniqueRebuildBytes)) {
  throw new Error("unique-rebuild benchmark emitted invalid WASM");
}
const aliasedRebuildBytes = await compileFunctionalModuleToWasm(aliasedRebuildCompilation.module);
if (!WebAssembly.validate(aliasedRebuildBytes)) {
  throw new Error("aliased-rebuild benchmark emitted invalid WASM");
}
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
const uniqueRebuildWarmup = await runFunctionalWasmModule(uniqueRebuildCompilation.module);
if (
  uniqueRebuildWarmup.value.kind !== "tuple" ||
  uniqueRebuildWarmup.value.values[0].kind !== "integer" ||
  uniqueRebuildWarmup.value.values[0].value !== 128 ||
  uniqueRebuildWarmup.stats.allocatedBytes !== 56
) {
  throw new Error("unique-rebuild runner warmup returned the wrong value or allocation count");
}
const aliasedRebuildWarmup = await runFunctionalWasmModule(aliasedRebuildCompilation.module);
if (
  aliasedRebuildWarmup.value.kind !== "tuple" ||
  aliasedRebuildWarmup.value.values[0].kind !== "integer" ||
  aliasedRebuildWarmup.value.values[0].value !== 128 ||
  aliasedRebuildWarmup.stats.allocatedBytes !== 4_152
) {
  throw new Error("aliased-rebuild runner warmup returned the wrong value or allocation count");
}

globalThis.addEventListener("unload", () => {
  higherOrderCompilation.module.destroy();
  directCompilation.module.destroy();
  tailWorkerCompilation.module.destroy();
  uniqueRebuildCompilation.module.destroy();
  aliasedRebuildCompilation.module.destroy();
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

Deno.bench("compile and emit WebAssembly: unique constructor rebuild chain", async () => {
  const compilation = await compiler.compileModule(uniqueRebuildModule);
  if (!compilation.ok) {
    throw new Error(
      `unique-rebuild WASM benchmark did not compile: ${compilation.diagnostics[0].message}`,
    );
  }
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    if (!WebAssembly.validate(bytes)) {
      throw new Error("unique-rebuild benchmark emitted invalid WASM");
    }
  } finally {
    compilation.module.destroy();
  }
});

Deno.bench("compile and emit WebAssembly: aliased constructor rebuild chain", async () => {
  const compilation = await compiler.compileModule(aliasedRebuildModule);
  if (!compilation.ok) {
    throw new Error(
      `aliased-rebuild WASM benchmark did not compile: ${compilation.diagnostics[0].message}`,
    );
  }
  try {
    const bytes = await compileFunctionalModuleToWasm(compilation.module);
    if (!WebAssembly.validate(bytes)) {
      throw new Error("aliased-rebuild benchmark emitted invalid WASM");
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

Deno.bench("reuse emitted WebAssembly: unique constructor rebuild chain", async () => {
  const bytes = await compileFunctionalModuleToWasm(uniqueRebuildCompilation.module);
  if (!WebAssembly.validate(bytes)) {
    throw new Error("unique-rebuild benchmark emitted invalid WASM");
  }
});

Deno.bench("reuse emitted WebAssembly: aliased constructor rebuild chain", async () => {
  const bytes = await compileFunctionalModuleToWasm(aliasedRebuildCompilation.module);
  if (!WebAssembly.validate(bytes)) {
    throw new Error("aliased-rebuild benchmark emitted invalid WASM");
  }
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

Deno.bench("run WebAssembly: unique constructor rebuild chain", async () => {
  const execution = await runFunctionalWasmModule(uniqueRebuildCompilation.module);
  if (
    execution.value.kind !== "tuple" || execution.value.values[0].kind !== "integer" ||
    execution.value.values[0].value !== 128 || execution.stats.allocatedBytes !== 56
  ) {
    throw new Error("unique-rebuild benchmark returned the wrong value or allocation count");
  }
});

Deno.bench("run WebAssembly: aliased constructor rebuild chain", async () => {
  const execution = await runFunctionalWasmModule(aliasedRebuildCompilation.module);
  if (
    execution.value.kind !== "tuple" || execution.value.values[0].kind !== "integer" ||
    execution.value.values[0].value !== 128 || execution.stats.allocatedBytes !== 4_152
  ) {
    throw new Error("aliased-rebuild benchmark returned the wrong value or allocation count");
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

function constructorRebuildModule(
  rebuildCount: number,
  aliasing: "consume-once" | "retain-alias",
) {
  const pair = (
    left: FunctionalSurfaceExpression,
    right: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression =>
    surface.apply(surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME), left, right);
  let body: FunctionalSurfaceExpression = surface.name(`pair${rebuildCount}`);
  for (let index = rebuildCount; index > 0; index -= 1) {
    const previous = `pair${index - 1}`;
    if (aliasing === "retain-alias") {
      body = {
        kind: "let",
        name: `observed${index}`,
        value: {
          kind: "case",
          value: surface.name(previous),
          arms: [{
            constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
            binders: ["left", "right"],
            body: surface.name("left"),
          }],
        },
        body,
      };
    }
    body = {
      kind: "let",
      name: `pair${index}`,
      value: {
        kind: "case",
        value: surface.name(previous),
        arms: [{
          constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
          binders: ["left", "right"],
          body: pair(
            surface.binary(
              FunctionalBinaryOperator.Add,
              surface.name("left"),
              surface.integer(1),
            ),
            surface.name("right"),
          ),
        }],
      },
      body,
    };
  }
  return buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: {
        kind: "let",
        name: "pair0",
        value: pair(surface.integer(0), surface.integer(42)),
        body,
      },
    }],
    [],
    "main",
    0,
    { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  );
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
    typeIndex: FunctionalWasmFunctionType.NullaryI32,
    localTypes: instructions.localTypes,
    instructions: instructions.bytes,
    usesMemory: false,
    usesIndirectCalls: false,
  };
  return encodeCompactScalarWasmModule([body], 0, [], {
    runtimeGlobals: {},
  });
}
