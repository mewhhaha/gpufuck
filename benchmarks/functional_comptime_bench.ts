import {
  FunctionalBinaryOperator,
  type FunctionalComptimeExecutionResult,
  type FunctionalComptimeModuleArtifact,
  GpuFunctionalComptimeExecutor,
  IncrementalGpuFunctionalComptimeExecutor,
  MemoryFunctionalIncrementalCache,
  requestWebGpuDevice,
  surface,
} from "../functional.ts";

const scalarInteger: FunctionalComptimeModuleArtifact = {
  name: "scalar-integer",
  definitions: [{
    name: "answer",
    parameters: [],
    annotation: null,
    body: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(20),
      surface.integer(22),
    ),
  }],
  typeDeclarations: [],
  imports: [],
  exports: [{ name: "answer", definition: "answer", type: { kind: "integer" } }],
  sourceByteLength: 10,
};

const scalarInteger64: FunctionalComptimeModuleArtifact = {
  name: "scalar-integer-64",
  definitions: [{
    name: "answer",
    parameters: [],
    annotation: null,
    body: surface.binary(
      FunctionalBinaryOperator.AddSignedInteger64,
      surface.signedInteger64(20n),
      surface.signedInteger64(22n),
    ),
  }],
  typeDeclarations: [],
  imports: [],
  exports: [{
    name: "answer",
    definition: "answer",
    type: { kind: "signed-integer-64" },
  }],
  sourceByteLength: 10,
};

const reusableIncrement: FunctionalComptimeModuleArtifact = {
  name: "reusable-increment",
  definitions: [{
    name: "increment",
    parameters: ["value"],
    annotation: {
      kind: "function",
      parameter: { kind: "integer" },
      result: { kind: "integer" },
    },
    body: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.name("value"),
      surface.integer(1),
    ),
  }],
  typeDeclarations: [],
  imports: [],
  exports: [{
    name: "increment",
    definition: "increment",
    type: {
      kind: "function",
      parameter: { kind: "integer" },
      result: { kind: "integer" },
    },
  }],
  sourceByteLength: 20,
};

const device = await requestWebGpuDevice();
const executor = await GpuFunctionalComptimeExecutor.create(device);
const incremental = new IncrementalGpuFunctionalComptimeExecutor(executor, {
  cache: new MemoryFunctionalIncrementalCache(),
});
const scalarBatch = Array.from({ length: 32 }, () => [scalarInteger] as const);
const reusableCompilation = await executor.compileFunction(
  [reusableIncrement],
  { module: reusableIncrement.name, exportName: "increment" },
);
if (!reusableCompilation.ok) {
  throw new Error(
    `reusable comptime benchmark did not compile: ${reusableCompilation.diagnostics[0].message}`,
  );
}
const reusableFunction = reusableCompilation.compiledFunction;

assertAnswer(await executor.execute([scalarInteger]), "bounded WASM warmup");
assertAnswer(
  await executor.execute([scalarInteger], { maximumStepsPerDispatch: 4_096 }),
  "GPU warmup",
);
assertInvocation(
  await reusableFunction.invoke({ kind: "integer", value: 41 }),
  42,
  "function warmup",
);
const incrementalWarmup = await incremental.execute([scalarInteger]);
if (!incrementalWarmup.ok) {
  throw new Error(`incremental comptime warmup failed during ${incrementalWarmup.failure.stage}`);
}

globalThis.addEventListener("unload", () => {
  reusableFunction.destroy();
  device.destroy();
}, { once: true });

Deno.bench("comptime: execute scalar i32 through bounded WASM", async () => {
  assertAnswer(await executor.execute([scalarInteger]), "bounded WASM scalar i32");
});

Deno.bench("comptime: execute scalar i64 through bounded WASM", async () => {
  assertAnswer(await executor.execute([scalarInteger64]), "bounded WASM scalar i64");
});

Deno.bench("comptime: execute batch of 32 through bounded WASM", async () => {
  const results = await executor.executeBatch(scalarBatch);
  for (const result of results) assertAnswer(result, "bounded WASM batch");
});

Deno.bench("comptime: execute scalar i32 through explicit GPU controls", async () => {
  assertAnswer(
    await executor.execute([scalarInteger], { maximumStepsPerDispatch: 4_096 }),
    "explicit GPU scalar i32",
  );
});

Deno.bench("comptime: reuse unchanged incremental constant", async () => {
  const result = await incremental.execute([scalarInteger]);
  if (!result.ok) {
    throw new Error(`incremental comptime reuse failed during ${result.failure.stage}`);
  }
  const answer = result.exports[0]?.value;
  if (answer?.kind !== "integer" || answer.value !== 42) {
    throw new Error(`incremental comptime reuse returned ${JSON.stringify(answer)}; expected 42`);
  }
});

let nextArgument = 1_000;
Deno.bench("comptime: invoke compiled function with a new argument", async () => {
  const argument = nextArgument++;
  assertInvocation(
    await reusableFunction.invoke({ kind: "integer", value: argument }),
    argument + 1,
    "compiled function",
  );
});

Deno.bench("comptime: reuse memoized compiled-function call", async () => {
  assertInvocation(
    await reusableFunction.invoke({ kind: "integer", value: 41 }),
    42,
    "memoized function",
  );
});

function assertAnswer(result: FunctionalComptimeExecutionResult, context: string): void {
  if (!result.ok) throw new Error(`${context} failed during ${result.stage}`);
  const answer = result.exports[0]?.value;
  if (answer?.kind !== "integer" && answer?.kind !== "signed-integer-64") {
    throw new Error(`${context} returned ${JSON.stringify(answer)}; expected integer 42`);
  }
  const value = Number(answer.value);
  if (value !== 42) {
    throw new Error(`${context} returned ${answer.value}; expected 42`);
  }
}

function assertInvocation(
  result: Awaited<ReturnType<typeof reusableFunction.invoke>>,
  expected: number,
  context: string,
): void {
  if (!result.ok) throw new Error(`${context} failed during ${result.stage}`);
  if (result.value.kind !== "integer" || result.value.value !== expected) {
    throw new Error(`${context} returned ${result.value.kind}; expected integer ${expected}`);
  }
}
