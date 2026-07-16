import {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceDefinition,
  GpuFunctionalCompiler,
  GpuTypeCoreExecutor,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
  type TypeCoreExecutionResult,
  type TypeCoreType,
} from "../../functional.ts";
import { ZIG_REFLECTION_RESULT_TYPE, zigReflectionProgram } from "./zig_reflection_program.ts";

const GET_IMPLEMENTATION = "Wrapped.get";

export interface ZigReflectionExecution {
  readonly generatedType: TypeCoreType;
  readonly fieldBytes: number;
  readonly methodImplementation: string;
  readonly methodResult: TypeCoreType;
  readonly wasmValue: number;
  readonly typeExecutionSteps: number;
}

export async function runZigReflectionExample(device: GPUDevice): Promise<ZigReflectionExecution> {
  const typeExecutor = await GpuTypeCoreExecutor.create(device);
  const reflected = requireReflectionResult(
    await typeExecutor.execute(zigReflectionProgram()),
  );
  if (reflected.methodImplementation !== GET_IMPLEMENTATION) {
    throw new Error(
      `Zig reflection selected implementation ${
        JSON.stringify(reflected.methodImplementation)
      }; expected ${JSON.stringify(GET_IMPLEMENTATION)}`,
    );
  }
  const compiler = await GpuFunctionalCompiler.create(device);
  const compilation = await compiler.compileModule(buildRuntimeModule(
    reflected.methodImplementation,
  ));
  if (!compilation.ok) {
    throw new Error(
      `Zig reflection-specialized module did not compile: ${compilation.diagnostics[0].message}`,
    );
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    if (execution.value.kind !== "integer") {
      throw new Error(
        `Zig reflection-specialized WASM returned ${execution.value.kind}; expected integer`,
      );
    }
    return { ...reflected, wasmValue: execution.value.value };
  } finally {
    compilation.module.destroy();
  }
}

function buildRuntimeModule(implementation: string) {
  const wrappedInteger = {
    kind: "named",
    name: "Wrapped",
    arguments: [{ kind: "integer" }],
  } as const;
  const method: FunctionalSurfaceDefinition = {
    name: implementation,
    parameters: [],
    annotation: {
      kind: "function",
      parameter: wrappedInteger,
      result: { kind: "integer" },
    },
    body: surface.lambda("receiver", {
      kind: "case",
      value: surface.name("receiver"),
      arms: [{
        constructor: "Wrapped",
        binders: ["value", "enabled"],
        body: surface.name("value"),
      }],
    }),
  };
  const wrappedValue = surface.apply(
    surface.apply(surface.name("Wrapped"), surface.integer(42)),
    surface.boolean(true),
  );
  return buildFunctionalSurfaceModule(
    [
      method,
      {
        name: "main",
        parameters: [],
        annotation: { kind: "integer" },
        body: surface.apply(surface.name(implementation), wrappedValue),
      },
    ],
    [{
      name: "Wrapped",
      parameters: ["element"],
      constructors: [{
        name: "Wrapped",
        fields: [
          { name: "value", type: { kind: "parameter", name: "element" } },
          { name: "enabled", type: { kind: "boolean" } },
        ],
      }],
    }],
    "main",
    0,
  );
}

function requireReflectionResult(
  result: TypeCoreExecutionResult,
): Omit<ZigReflectionExecution, "wasmValue"> {
  if (!result.ok) {
    const reason = result.stage === "compile"
      ? result.diagnostics[0].message
      : result.fault.message;
    throw new Error(`Zig reflection failed during ${result.stage}: ${reason}`);
  }
  if (
    result.value.kind !== "type" || result.value.type.kind !== "named" ||
    result.value.type.name !== ZIG_REFLECTION_RESULT_TYPE
  ) {
    throw new Error("Zig reflection did not return its declared ReflectionResult type");
  }
  const arguments_ = result.value.type.arguments;
  if (arguments_.length !== 4) {
    throw new Error(`Zig ReflectionResult has ${arguments_.length} arguments; expected 4`);
  }
  const generatedType = arguments_[0];
  const fieldBytes = arguments_[1];
  const methodImplementation = arguments_[2];
  const methodResult = arguments_[3];
  if (generatedType?.kind !== "type") {
    throw new Error(`Zig ReflectionResult generated type has kind ${generatedType?.kind}`);
  }
  if (fieldBytes?.kind !== "integer") {
    throw new Error(`Zig ReflectionResult field byte count has kind ${fieldBytes?.kind}`);
  }
  if (methodImplementation?.kind !== "symbol") {
    throw new Error(
      `Zig ReflectionResult method implementation has kind ${methodImplementation?.kind}`,
    );
  }
  if (methodResult?.kind !== "type") {
    throw new Error(`Zig ReflectionResult method result has kind ${methodResult?.kind}`);
  }
  return {
    generatedType: generatedType.type,
    fieldBytes: fieldBytes.value,
    methodImplementation: methodImplementation.value,
    methodResult: methodResult.type,
    typeExecutionSteps: result.stats.steps,
  };
}

if (import.meta.main) {
  const device = await requestWebGpuDevice();
  try {
    console.log(JSON.stringify(await runZigReflectionExample(device), null, 2));
  } finally {
    device.destroy();
  }
}
