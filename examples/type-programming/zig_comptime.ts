import {
  buildFunctionalSurfaceModule,
  GpuFunctionalCompiler,
  GpuTypeCoreExecutor,
  requestWebGpuDevice,
  runFunctionalWasmModule,
  surface,
  type TypeCoreExecutionResult,
  type TypeCoreProgram,
  type TypeCoreType,
} from "../../functional.ts";

const ARRAY_TYPE = "Array";

export interface ZigComptimeExecution {
  readonly matrixType: TypeCoreType;
  readonly cellCount: number;
  readonly wasmValue: number;
  readonly matrixTypeSteps: number;
  readonly cellCountSteps: number;
}

export function zigMatrixTypeProgram(): TypeCoreProgram {
  return {
    typeConstructors: [{ name: ARRAY_TYPE, parameterKinds: ["integer", "type"] }],
    functions: [{
      name: "Matrix",
      parameters: [
        { name: "element", kind: "type" },
        { name: "rows", kind: "integer" },
        { name: "columns", kind: "integer" },
      ],
      resultKind: "type",
      body: {
        kind: "type",
        type: {
          kind: "named",
          name: ARRAY_TYPE,
          arguments: [
            { kind: "reference", name: "rows" },
            {
              kind: "type",
              type: {
                kind: "named",
                name: ARRAY_TYPE,
                arguments: [
                  { kind: "reference", name: "columns" },
                  { kind: "reference", name: "element" },
                ],
              },
            },
          ],
        },
      },
    }],
    entry: {
      kind: "call",
      function: "Matrix",
      arguments: [
        { kind: "type", type: { kind: "integer" } },
        { kind: "integer", value: 6 },
        { kind: "integer", value: 7 },
      ],
    },
  };
}

export function zigCellCountProgram(): TypeCoreProgram {
  return {
    typeConstructors: [],
    functions: [{
      name: "CellCount",
      parameters: [
        { name: "rows", kind: "integer" },
        { name: "columns", kind: "integer" },
      ],
      resultKind: "integer",
      body: {
        kind: "integer-operation",
        operator: "multiply",
        left: { kind: "reference", name: "rows" },
        right: { kind: "reference", name: "columns" },
      },
    }],
    entry: {
      kind: "call",
      function: "CellCount",
      arguments: [
        { kind: "integer", value: 6 },
        { kind: "integer", value: 7 },
      ],
    },
  };
}

export async function runZigComptimeExample(device: GPUDevice): Promise<ZigComptimeExecution> {
  const typeExecutor = await GpuTypeCoreExecutor.create(device);
  const matrixResult = requireTypeResult(
    await typeExecutor.execute(zigMatrixTypeProgram()),
    "Zig Matrix comptime result",
  );
  const countResult = requireIntegerResult(
    await typeExecutor.execute(zigCellCountProgram()),
    "Zig cellCount comptime result",
  );
  const compiler = await GpuFunctionalCompiler.create(device);
  const compilation = await compiler.compileModule(buildFunctionalSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.integer(countResult.value),
    }],
    [],
    "main",
    0,
  ));
  if (!compilation.ok) {
    throw new Error(
      `Zig comptime-specialized module did not compile: ${compilation.diagnostics[0].message}`,
    );
  }
  try {
    const execution = await runFunctionalWasmModule(compilation.module);
    if (execution.value.kind !== "integer") {
      throw new Error(
        `Zig comptime-specialized WASM returned ${execution.value.kind}; expected integer`,
      );
    }
    return {
      matrixType: matrixResult.type,
      cellCount: countResult.value,
      wasmValue: execution.value.value,
      matrixTypeSteps: matrixResult.steps,
      cellCountSteps: countResult.steps,
    };
  } finally {
    compilation.module.destroy();
  }
}

function requireTypeResult(
  result: TypeCoreExecutionResult,
  context: string,
): { readonly type: TypeCoreType; readonly steps: number } {
  if (!result.ok) throw typeCoreFailure(result, context);
  if (result.value.kind !== "type") {
    throw new Error(`${context} produced ${result.value.kind}; expected type`);
  }
  return { type: result.value.type, steps: result.stats.steps };
}

function requireIntegerResult(
  result: TypeCoreExecutionResult,
  context: string,
): { readonly value: number; readonly steps: number } {
  if (!result.ok) throw typeCoreFailure(result, context);
  if (result.value.kind !== "integer") {
    throw new Error(`${context} produced ${result.value.kind}; expected integer`);
  }
  return { value: result.value.value, steps: result.stats.steps };
}

function typeCoreFailure(
  result: Extract<TypeCoreExecutionResult, { readonly ok: false }>,
  context: string,
): Error {
  const reason = result.stage === "compile" ? result.diagnostics[0].message : result.fault.message;
  return new Error(`${context} failed during ${result.stage}: ${reason}`);
}

if (import.meta.main) {
  const device = await requestWebGpuDevice();
  try {
    console.log(JSON.stringify(await runZigComptimeExample(device), null, 2));
  } finally {
    device.destroy();
  }
}
