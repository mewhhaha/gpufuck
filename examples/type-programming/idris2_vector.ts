import {
  buildFunctionalSurfaceModule,
  type EncodedFunctionalModule,
  type FunctionalDeepValue,
  type FunctionalEvaluationStats,
  functionalSchemaFromTypeCoreType,
  type FunctionalSurfaceExpression,
  type FunctionalType,
  type FunctionalTypeSchema,
  GpuFunctionalCompiler,
  GpuFunctionalEvaluator,
  GpuTypeCoreExecutor,
  requestWebGpuDevice,
  surface,
  type TypeCoreExecutionResult,
  type TypeCoreExpression,
  type TypeCoreProgram,
  type TypeCoreType,
} from "../../functional.ts";

const ZERO_TYPE = "Z";
const SUCCESSOR_TYPE = "S";
const VECTOR_TYPE = "Vect";

export interface Idris2VectorExecution {
  readonly computedType: TypeCoreType;
  readonly inferredType: FunctionalType;
  readonly value: FunctionalDeepValue;
  readonly typeExecution: FunctionalEvaluationStats;
  readonly valueExecution: FunctionalEvaluationStats;
}

export function idris2VectorTypeProgram(): TypeCoreProgram {
  const left = { kind: "reference", name: "left" } as const;
  const right = { kind: "reference", name: "right" } as const;
  const predecessor = { kind: "reference", name: "predecessor" } as const;
  return {
    typeConstructors: [
      { name: ZERO_TYPE, parameterKinds: [] },
      { name: SUCCESSOR_TYPE, parameterKinds: ["type"] },
      { name: VECTOR_TYPE, parameterKinds: ["type", "type"] },
    ],
    functions: [{
      name: "AppendLength",
      parameters: [
        { name: "left", kind: "type" },
        { name: "right", kind: "type" },
      ],
      resultKind: "type",
      body: {
        kind: "match",
        value: left,
        arms: [
          {
            pattern: {
              kind: "type",
              type: { kind: "named", name: ZERO_TYPE, arguments: [] },
            },
            result: right,
          },
          {
            pattern: {
              kind: "type",
              type: {
                kind: "named",
                name: SUCCESSOR_TYPE,
                arguments: [{ kind: "bind", name: "predecessor" }],
              },
            },
            result: successor({
              kind: "call",
              function: "AppendLength",
              arguments: [predecessor, right],
            }),
          },
        ],
        fallback: { kind: "type", type: { kind: "unit" } },
      },
    }],
    entry: {
      kind: "type",
      type: {
        kind: "named",
        name: VECTOR_TYPE,
        arguments: [
          {
            kind: "call",
            function: "AppendLength",
            arguments: [successor(successor(zero())), successor(zero())],
          },
          { kind: "type", type: { kind: "integer" } },
        ],
      },
    },
  };
}

export function idris2VectorModule(
  annotation: FunctionalTypeSchema,
  elements: readonly number[] = [40, 1, 1],
): EncodedFunctionalModule {
  const parameter = (name: string): FunctionalTypeSchema => ({ kind: "parameter", name });
  const named = (
    name: string,
    arguments_: readonly FunctionalTypeSchema[] = [],
  ): FunctionalTypeSchema => ({ kind: "named", name, arguments: arguments_ });
  const vector = (
    length: FunctionalTypeSchema,
    element: FunctionalTypeSchema,
  ): FunctionalTypeSchema => named(VECTOR_TYPE, [length, element]);
  const element = parameter("element");
  const length = parameter("length");
  const nil = surface.name("Nil");
  const cons = (head: number, tail: FunctionalSurfaceExpression) =>
    surface.apply(
      surface.apply(surface.name("Cons"), surface.integer(head)),
      tail,
    );
  let value: FunctionalSurfaceExpression = nil;
  for (let index = elements.length - 1; index >= 0; index--) {
    const elementValue = elements[index];
    if (elementValue === undefined) {
      throw new Error(`Idris2 vector elements omitted index ${index}`);
    }
    value = cons(elementValue, value);
  }

  return buildFunctionalSurfaceModule(
    [{ name: "main", parameters: [], annotation, body: value }],
    [
      { name: ZERO_TYPE, parameters: [], constructors: [] },
      { name: SUCCESSOR_TYPE, parameters: ["predecessor"], constructors: [] },
      {
        name: VECTOR_TYPE,
        parameters: ["length", "element"],
        constructors: [
          {
            name: "Nil",
            fields: [],
            result: vector(named(ZERO_TYPE), element),
          },
          {
            name: "Cons",
            fields: [
              { name: "head", type: element },
              { name: "tail", type: vector(length, element) },
            ],
            result: vector(named(SUCCESSOR_TYPE, [length]), element),
          },
        ],
      },
    ],
    "main",
    0,
  );
}

export async function runIdris2VectorExample(device: GPUDevice): Promise<Idris2VectorExecution> {
  const typeExecutor = await GpuTypeCoreExecutor.create(device);
  const typeResult = await typeExecutor.execute(idris2VectorTypeProgram());
  const computed = requireComputedType(typeResult, "Idris2 vector result");
  const computedType = computed.type;
  const annotation = functionalSchemaFromTypeCoreType(computedType);
  const [compiler, evaluator] = await Promise.all([
    GpuFunctionalCompiler.create(device),
    GpuFunctionalEvaluator.create(device),
  ]);
  const compilation = await compiler.compileModule(idris2VectorModule(annotation));
  if (!compilation.ok) {
    throw new Error(`Idris2 vector module did not compile: ${compilation.diagnostics[0].message}`);
  }
  try {
    const evaluation = await evaluator.evaluate(compilation.module, { resultForm: "deep" });
    if (!evaluation.ok) {
      throw new Error(`Idris2 vector evaluation failed: ${evaluation.fault.message}`);
    }
    return {
      computedType,
      inferredType: compilation.module.entryType,
      value: evaluation.value,
      typeExecution: computed.stats,
      valueExecution: evaluation.stats,
    };
  } finally {
    compilation.module.destroy();
  }
}

function zero(): TypeCoreExpression {
  return { kind: "type", type: { kind: "named", name: ZERO_TYPE, arguments: [] } };
}

function successor(predecessor: TypeCoreExpression): TypeCoreExpression {
  return {
    kind: "type",
    type: { kind: "named", name: SUCCESSOR_TYPE, arguments: [predecessor] },
  };
}

function requireComputedType(
  result: TypeCoreExecutionResult,
  context: string,
): { readonly type: TypeCoreType; readonly stats: FunctionalEvaluationStats } {
  if (!result.ok) {
    const reason = result.stage === "compile"
      ? result.diagnostics[0].message
      : result.fault.message;
    throw new Error(`${context} failed during ${result.stage}: ${reason}`);
  }
  if (result.value.kind !== "type") {
    throw new Error(`${context} produced ${result.value.kind}; expected type`);
  }
  return { type: result.value.type, stats: result.stats };
}

if (import.meta.main) {
  const device = await requestWebGpuDevice();
  try {
    console.log(JSON.stringify(await runIdris2VectorExample(device), null, 2));
  } finally {
    device.destroy();
  }
}
