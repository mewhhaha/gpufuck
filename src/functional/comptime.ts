import {
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalEvaluationProfile,
  type FunctionalTypeSchema,
} from "./abi.ts";
import {
  encodeFunctionalConstant,
  functionalConstantFromDeepValue,
  measureFunctionalConstant,
  validateFunctionalConstant,
} from "./comptime_constant.ts";
import type {
  CompiledFunctionalComptimeFunction,
  FunctionalComptimeDiagnostic,
  FunctionalComptimeExecutionOptions,
  FunctionalComptimeExecutionResult,
  FunctionalComptimeExportSelection,
  FunctionalComptimeExportValue,
  FunctionalComptimeFunctionCompilationOptions,
  FunctionalComptimeFunctionCompilationResult,
  FunctionalComptimeInvocationOptions,
  FunctionalComptimeInvocationResult,
  FunctionalComptimeModuleArtifact,
  FunctionalComptimeStats,
  FunctionalConstant,
} from "./comptime_contract.ts";
import { GpuFunctionalCompiler, type GpuFunctionalModule } from "./compiler.ts";
import {
  evaluateFunctionalModuleWithBoundedWasm,
  type FunctionalDeepValue,
  GpuFunctionalEvaluator,
} from "./evaluator.ts";
import {
  createFunctionalModuleArtifact,
  type FunctionalModuleArtifact,
  linkFunctionalModules,
} from "./module_linker.ts";
import type {
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "./surface_builder.ts";
import { functionalResolvedCoreFingerprint } from "./wasm_artifacts.ts";

const DEFAULT_MAXIMUM_COMPTIME_STEPS = 1_000_000;
const DEFAULT_MAXIMUM_OUTPUT_NODES = 4_096;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAXIMUM_OUTPUT_DEPTH = 256;
const MAXIMUM_MEMOIZED_COMPTIME_INVOCATIONS = 4_096;

type MemoizedComptimeInvocation =
  | {
    readonly ok: true;
    readonly value: FunctionalConstant;
    readonly evaluation: FunctionalComptimeStats["evaluation"];
  }
  | {
    readonly ok: false;
    readonly fault: Extract<FunctionalComptimeInvocationResult, { readonly ok: false }>;
  };

const memoizedComptimeInvocations = new Map<string, Promise<MemoizedComptimeInvocation>>();

type ComptimeOutput = {
  readonly module: string;
  readonly exportName: string;
  readonly definition: string;
  readonly type: FunctionalTypeSchema;
  readonly span: { readonly startByte: number; readonly endByte: number } | undefined;
};

type PreparedComptimeProgram =
  | { readonly kind: "empty"; readonly outputs: readonly [] }
  | {
    readonly kind: "compiled";
    readonly module: ReturnType<typeof linkFunctionalModules>["module"];
    readonly outputs: readonly ComptimeOutput[];
  };

type CompiledComptimeProgram = Extract<PreparedComptimeProgram, { readonly kind: "compiled" }>;

export class GpuFunctionalComptimeExecutor {
  readonly #compiler: GpuFunctionalCompiler;
  readonly #evaluator: GpuFunctionalEvaluator;

  private constructor(
    compiler: GpuFunctionalCompiler,
    evaluator: GpuFunctionalEvaluator,
  ) {
    this.#compiler = compiler;
    this.#evaluator = evaluator;
  }

  static async create(device: GPUDevice): Promise<GpuFunctionalComptimeExecutor> {
    const [compiler, evaluator] = await Promise.all([
      GpuFunctionalCompiler.create(device),
      GpuFunctionalEvaluator.create(device),
    ]);
    return new GpuFunctionalComptimeExecutor(compiler, evaluator);
  }

  async execute(
    artifacts: readonly FunctionalComptimeModuleArtifact[],
    options: FunctionalComptimeExecutionOptions = {},
  ): Promise<FunctionalComptimeExecutionResult> {
    return (await this.#executeRequests([{ artifacts }], options))[0]!;
  }

  async executeBatch(
    programs: readonly (readonly FunctionalComptimeModuleArtifact[])[],
    options: FunctionalComptimeExecutionOptions = {},
  ): Promise<readonly FunctionalComptimeExecutionResult[]> {
    return await this.#executeRequests(programs.map((artifacts) => ({ artifacts })), options);
  }

  async executeExports(
    artifacts: readonly FunctionalComptimeModuleArtifact[],
    exports: readonly FunctionalComptimeExportSelection[],
    options: FunctionalComptimeExecutionOptions = {},
  ): Promise<FunctionalComptimeExecutionResult> {
    return (await this.#executeRequests([{ artifacts, exports }], options))[0]!;
  }

  async executeExportsBatch(
    requests: readonly {
      readonly artifacts: readonly FunctionalComptimeModuleArtifact[];
      readonly exports: readonly FunctionalComptimeExportSelection[];
    }[],
    options: FunctionalComptimeExecutionOptions = {},
  ): Promise<readonly FunctionalComptimeExecutionResult[]> {
    return await this.#executeRequests(requests, options);
  }

  async compileFunction(
    artifacts: readonly FunctionalComptimeModuleArtifact[],
    selection: FunctionalComptimeExportSelection,
    options: FunctionalComptimeFunctionCompilationOptions = {},
  ): Promise<FunctionalComptimeFunctionCompilationResult> {
    options.signal?.throwIfAborted();
    const modules = artifacts.map(comptimeArtifact);
    const selectedModule = artifacts.find((module) => module.name === selection.module);
    const selectedExport = selectedModule?.exports.find((exported) =>
      exported.name === selection.exportName
    );
    if (selectedModule === undefined || selectedExport === undefined) {
      throw new TypeError(
        `functional comptime function selection references missing export ${
          JSON.stringify(`${selection.module}.${selection.exportName}`)
        }`,
      );
    }
    const linked = linkFunctionalModules(modules, selection);
    const compilation = await this.#compiler.compileModule(linked.module, {
      ...(options.maximumCompilationSteps === undefined
        ? {}
        : { maximumSteps: options.maximumCompilationSteps }),
      ...(options.maximumStepsPerDispatch === undefined
        ? {}
        : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!compilation.ok) return compilation;
    if (compilation.module.entryType.kind !== "function") {
      compilation.module.destroy();
      throw new TypeError(
        `functional comptime export ${
          JSON.stringify(`${selection.module}.${selection.exportName}`)
        } has type ${compilation.module.entryType.kind}; expected a single-argument function`,
      );
    }
    try {
      const fingerprint = await functionalResolvedCoreFingerprint(compilation.module);
      options.signal?.throwIfAborted();
      return {
        ok: true,
        compiledFunction: new ReusableFunctionalComptimeFunction(
          compilation.module,
          fingerprint,
          {
            module: selection.module,
            exportName: selection.exportName,
            definition: selectedExport.definition,
            type: selectedExport.type,
            span: selectedModule.definitions.find((definition) =>
              definition.name === selectedExport.definition
            )?.span,
          },
        ),
      };
    } catch (error) {
      compilation.module.destroy();
      throw error;
    }
  }

  async #executeRequests(
    requests: readonly {
      readonly artifacts: readonly FunctionalComptimeModuleArtifact[];
      readonly exports?: readonly FunctionalComptimeExportSelection[];
    }[],
    options: FunctionalComptimeExecutionOptions,
  ): Promise<readonly FunctionalComptimeExecutionResult[]> {
    options.signal?.throwIfAborted();
    const limits = comptimeLimits(options);
    const results: (FunctionalComptimeExecutionResult | undefined)[] = new Array(requests.length);
    const prepared: { readonly resultIndex: number; readonly program: CompiledComptimeProgram }[] =
      [];
    for (const [resultIndex, request] of requests.entries()) {
      const program = prepareComptimeProgram(request.artifacts, request.exports);
      if (program.kind === "empty") {
        results[resultIndex] = {
          ok: true,
          exports: Object.freeze([]),
          stats: emptyComptimeStats(),
        };
      } else {
        prepared.push({ resultIndex, program });
      }
    }
    if (prepared.length === 0) return completedResults(results);
    const compilations = await this.#compiler.compileBatch(
      prepared.map(({ program }) => program.module),
      {
        maximumSteps: options.maximumCompilationSteps ?? DEFAULT_MAXIMUM_COMPTIME_STEPS,
        ...(options.maximumStepsPerDispatch === undefined
          ? {}
          : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (compilations.length !== prepared.length) {
      for (const compilation of compilations) if (compilation.ok) compilation.module.destroy();
      throw new Error(
        `functional comptime compiler returned ${compilations.length} results for ${prepared.length} programs`,
      );
    }
    const evaluable: {
      readonly preparedIndex: number;
      readonly resultIndex: number;
      readonly program: CompiledComptimeProgram;
      readonly module: GpuFunctionalModule;
    }[] = [];
    try {
      for (const [preparedIndex, compilation] of compilations.entries()) {
        const entry = prepared[preparedIndex]!;
        if (!compilation.ok) {
          results[entry.resultIndex] = {
            ok: false,
            stage: "compile",
            diagnostics: compilation.diagnostics,
          };
          continue;
        }
        evaluable.push({
          preparedIndex,
          resultIndex: entry.resultIndex,
          program: entry.program,
          module: compilation.module,
        });
      }
      if (evaluable.length > 0) {
        const evaluationOptions = {
          resultForm: "deep" as const,
          maximumSteps: options.maximumExecutionSteps ?? DEFAULT_MAXIMUM_COMPTIME_STEPS,
          maximumResultNodes: limits.maximumOutputNodes,
          maximumResultBytes: limits.maximumOutputBytes,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        };
        const evaluations = gpuEvaluationRequested(options)
          ? await this.#evaluator.evaluateBatch(
            evaluable.map(({ module }) => module),
            {
              ...evaluationOptions,
              ...(options.maximumStepsPerDispatch === undefined
                ? {}
                : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
              ...(options.heapSlots === undefined ? {} : { heapSlots: options.heapSlots }),
              ...(options.stackFrames === undefined ? {} : { stackFrames: options.stackFrames }),
            },
          )
          : await Promise.all(
            evaluable.map(({ module, program }) =>
              programProducesFirstOrderValues(program)
                ? evaluateFunctionalModuleWithBoundedWasm(module, evaluationOptions)
                : this.#evaluator.evaluate(module, evaluationOptions)
            ),
          );
        if (evaluations.length !== evaluable.length) {
          throw new Error(
            `functional comptime evaluator returned ${evaluations.length} results for ${evaluable.length} programs`,
          );
        }
        for (const [evaluationIndex, evaluation] of evaluations.entries()) {
          const entry = evaluable[evaluationIndex]!;
          if (!evaluation.ok) {
            results[entry.resultIndex] = {
              ok: false,
              stage: "execute",
              fault: evaluation.fault,
              stats: evaluation.stats,
            };
            continue;
          }
          results[entry.resultIndex] = comptimeSuccess(
            entry.program,
            evaluation.value,
            evaluation.stats,
            limits,
          );
        }
      }
      return completedResults(results);
    } finally {
      for (const entry of evaluable) entry.module.destroy();
      for (const compilation of compilations) {
        if (compilation.ok && !evaluable.some(({ module }) => module === compilation.module)) {
          compilation.module.destroy();
        }
      }
    }
  }
}

class ReusableFunctionalComptimeFunction implements CompiledFunctionalComptimeFunction {
  readonly parameterType;
  readonly resultType;
  readonly #module: GpuFunctionalModule;
  readonly #fingerprint: string;
  readonly #output: ComptimeOutput;
  #destroyed = false;

  constructor(module: GpuFunctionalModule, fingerprint: string, output: ComptimeOutput) {
    if (module.entryType.kind !== "function") {
      throw new Error(`reusable functional comptime entry has type ${module.entryType.kind}`);
    }
    this.#module = module;
    this.#fingerprint = fingerprint;
    this.#output = output;
    this.parameterType = module.entryType.parameter;
    this.resultType = module.entryType.result;
  }

  async invoke(
    argument: FunctionalConstant,
    options: FunctionalComptimeInvocationOptions = {},
  ): Promise<FunctionalComptimeInvocationResult> {
    if (this.#destroyed) {
      throw new Error(
        `cannot invoke destroyed functional comptime function ${
          JSON.stringify(`${this.#output.module}.${this.#output.exportName}`)
        }`,
      );
    }
    options.signal?.throwIfAborted();
    validateFunctionalConstant(argument);
    const maximumSteps = positiveLimit(
      "maximumExecutionSteps",
      options.maximumExecutionSteps,
      DEFAULT_MAXIMUM_COMPTIME_STEPS,
    );
    if (maximumSteps > DEFAULT_MAXIMUM_COMPTIME_STEPS) {
      throw new RangeError(
        `functional comptime maximumExecutionSteps must not exceed ${DEFAULT_MAXIMUM_COMPTIME_STEPS}; received ${maximumSteps}`,
      );
    }
    const limits = comptimeLimits(options);
    const key = `${this.#fingerprint}:${maximumSteps}:${limits.maximumOutputNodes}:` +
      `${limits.maximumOutputBytes}:` +
      new TextDecoder().decode(encodeFunctionalConstant(argument));
    let invocation = memoizedComptimeInvocations.get(key);
    const memoized = invocation !== undefined;
    if (invocation === undefined) {
      invocation = this.#evaluate(
        argument,
        maximumSteps,
        limits.maximumOutputNodes,
        limits.maximumOutputBytes,
      );
      memoizedComptimeInvocations.set(key, invocation);
      evictOldestComptimeInvocations();
    } else {
      memoizedComptimeInvocations.delete(key);
      memoizedComptimeInvocations.set(key, invocation);
    }
    const completed = await invocation;
    options.signal?.throwIfAborted();
    if (!completed.ok) {
      if (memoizedComptimeInvocations.get(key) === invocation) {
        memoizedComptimeInvocations.delete(key);
      }
      return completed.fault;
    }
    const measurements = measureFunctionalConstant(completed.value);
    const exceeded = exceededOutputLimit(
      this.#output,
      measurements.nodes,
      measurements.bytes,
      measurements.depth,
      limits,
    );
    if (exceeded !== undefined) {
      return {
        ok: false,
        stage: "comptime",
        diagnostic: exceeded,
        stats: completed.evaluation,
      };
    }
    return {
      ok: true,
      value: completed.value,
      stats: {
        evaluation: completed.evaluation,
        outputNodes: measurements.nodes,
        outputBytes: measurements.bytes,
        outputDepth: measurements.depth,
        memoized,
      },
    };
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#module.destroy();
  }

  async #evaluate(
    argument: FunctionalConstant,
    maximumSteps: number,
    maximumResultNodes: number,
    maximumResultBytes: number,
  ): Promise<MemoizedComptimeInvocation> {
    const evaluation = await evaluateFunctionalModuleWithBoundedWasm(this.#module, {
      resultForm: "deep",
      input: argument,
      maximumSteps,
      maximumResultNodes,
      maximumResultBytes,
    });
    if (!evaluation.ok) {
      return {
        ok: false,
        fault: {
          ok: false,
          stage: "execute",
          fault: evaluation.fault,
          stats: evaluation.stats,
        },
      };
    }
    const value = functionalConstantFromDeepValue(evaluation.value);
    if (value !== undefined) {
      return { ok: true, value, evaluation: evaluation.stats };
    }
    return {
      ok: false,
      fault: {
        ok: false,
        stage: "comptime",
        diagnostic: nonConstantOutput(this.#output),
        stats: evaluation.stats,
      },
    };
  }
}

function evictOldestComptimeInvocations(): void {
  while (memoizedComptimeInvocations.size > MAXIMUM_MEMOIZED_COMPTIME_INVOCATIONS) {
    const oldest = memoizedComptimeInvocations.keys().next().value;
    if (oldest === undefined) return;
    memoizedComptimeInvocations.delete(oldest);
  }
}

function gpuEvaluationRequested(options: FunctionalComptimeExecutionOptions): boolean {
  return options.maximumStepsPerDispatch !== undefined || options.heapSlots !== undefined ||
    options.stackFrames !== undefined;
}

function programProducesFirstOrderValues(program: CompiledComptimeProgram): boolean {
  return program.outputs.every((output) =>
    !schemaContainsFunction(output.type, program.module.typeDeclarations)
  );
}

function schemaContainsFunction(
  schema: FunctionalTypeSchema,
  declarations: readonly FunctionalSurfaceTypeDeclaration[],
  parameters: ReadonlyMap<string, FunctionalTypeSchema> = new Map(),
  visiting = new Set<string>(),
): boolean {
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return false;
    case "function":
    case "forall":
      return true;
    case "parameter": {
      const argument = parameters.get(schema.name);
      return argument === undefined ||
        schemaContainsFunction(argument, declarations, new Map(), visiting);
    }
    case "tuple":
      return schema.values.some((value) =>
        schemaContainsFunction(value, declarations, parameters, visiting)
      );
    case "named": {
      if (
        schema.arguments.some((argument) =>
          schemaContainsFunction(argument, declarations, parameters, visiting)
        )
      ) return true;
      const declaration = declarations.find((candidate) => candidate.name === schema.name);
      if (declaration === undefined) return false;
      const key = JSON.stringify(schema);
      if (visiting.has(key)) return false;
      visiting.add(key);
      try {
        const argumentsByParameter = new Map(
          declaration.parameters.map((parameter, index) => [parameter, schema.arguments[index]!]),
        );
        return declaration.constructors.some((constructor) =>
          constructor.fields.some((field) =>
            schemaContainsFunction(field.type, declarations, argumentsByParameter, visiting)
          )
        );
      } finally {
        visiting.delete(key);
      }
    }
  }
}

function prepareComptimeProgram(
  artifacts: readonly FunctionalComptimeModuleArtifact[],
  selections?: readonly FunctionalComptimeExportSelection[],
): PreparedComptimeProgram {
  const functionalArtifacts = artifacts.map(comptimeArtifact);
  const modules = new Map(functionalArtifacts.map((artifact) => [artifact.name, artifact]));
  const availableOutputs: ComptimeOutput[] = functionalArtifacts.flatMap((artifact, index) =>
    artifacts[index]!.exports.map((exported) => ({
      module: artifact.name,
      exportName: exported.name,
      definition: exported.definition,
      type: qualifySchema(exported.type, artifact, modules),
      span: artifact.definitions.find((definition) => definition.name === exported.definition)
        ?.span,
    }))
  );
  const outputs = selections === undefined ? availableOutputs : selections.map((selection) => {
    const output = availableOutputs.find((candidate) =>
      candidate.module === selection.module && candidate.exportName === selection.exportName
    );
    if (output !== undefined) return output;
    throw new TypeError(
      `functional comptime selection references missing export ${
        JSON.stringify(`${selection.module}.${selection.exportName}`)
      }`,
    );
  });
  if (outputs.length === 0) {
    return { kind: "empty", outputs: [] };
  }
  const collectorName = uniqueCollectorName(modules);
  const imports = outputs.map((output, index) => ({
    name: `value${index}`,
    fromModule: output.module,
    exportName: output.exportName,
    type: output.type,
  }));
  const collector: FunctionalModuleArtifact = {
    name: collectorName,
    definitions: [{
      name: "main",
      parameters: [],
      annotation: null,
      body: collectedExpression(imports.map((imported) => imported.name)),
    }],
    typeDeclarations: [],
    imports,
    exports: [{
      name: "main",
      definition: "main",
      type: collectedType(outputs.map((output) => output.type)),
    }],
    sourceByteLength: 0,
    options: {
      evaluationProfile: FunctionalEvaluationProfile.StrictEager,
    },
  };
  const linked = linkFunctionalModules(
    [...functionalArtifacts, collector],
    { module: collectorName, exportName: "main" },
  );
  return { kind: "compiled", module: linked.module, outputs: Object.freeze(outputs) };
}

function comptimeArtifact(artifact: FunctionalComptimeModuleArtifact): FunctionalModuleArtifact {
  if (artifact.name.length === 0) {
    throw new TypeError("functional comptime module name must be nonempty");
  }
  return createFunctionalModuleArtifact({
    name: artifact.name,
    definitions: artifact.definitions,
    typeDeclarations: artifact.typeDeclarations,
    imports: artifact.imports,
    exports: artifact.exports,
    sourceByteLength: artifact.sourceByteLength,
    options: {
      evaluationProfile: artifact.evaluationProfile ?? FunctionalEvaluationProfile.StrictEager,
    },
  });
}

function collectedExpression(names: readonly string[]): FunctionalSurfaceExpression {
  let expression: FunctionalSurfaceExpression = {
    kind: "name",
    name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  };
  for (let index = names.length - 1; index >= 0; index--) {
    expression = {
      kind: "apply",
      callee: {
        kind: "apply",
        callee: { kind: "name", name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME },
        argument: { kind: "name", name: names[index]! },
      },
      argument: expression,
    };
  }
  return expression;
}

function collectedType(types: readonly FunctionalTypeSchema[]): FunctionalTypeSchema {
  let result: FunctionalTypeSchema = { kind: "unit" };
  for (let index = types.length - 1; index >= 0; index--) {
    result = { kind: "tuple", values: [types[index]!, result] };
  }
  return result;
}

function comptimeSuccess(
  program: CompiledComptimeProgram,
  value: FunctionalDeepValue,
  evaluation: FunctionalComptimeStats["evaluation"],
  limits: ReturnType<typeof comptimeLimits>,
): FunctionalComptimeExecutionResult {
  const values = unpackCollectedValues(value, program.outputs.length);
  if (values === undefined) {
    return {
      ok: false,
      stage: "comptime",
      diagnostic: {
        stage: "comptime",
        code: "F5001",
        kind: "non-constant-output",
        message: "functional comptime collector returned a malformed output tuple",
      },
      stats: evaluation,
    };
  }
  const exports: FunctionalComptimeExportValue[] = [];
  let outputNodes = 0;
  let outputBytes = 0;
  let outputDepth = 0;
  for (const [outputIndex, output] of program.outputs.entries()) {
    const constant = functionalConstantFromDeepValue(values[outputIndex]!);
    if (constant === undefined) {
      return {
        ok: false,
        stage: "comptime",
        diagnostic: nonConstantOutput(output),
        stats: evaluation,
      };
    }
    const measurements = measureFunctionalConstant(constant);
    outputNodes += measurements.nodes;
    outputBytes += measurements.bytes;
    outputDepth = Math.max(outputDepth, measurements.depth);
    const exceeded = exceededOutputLimit(
      output,
      outputNodes,
      outputBytes,
      outputDepth,
      limits,
    );
    if (exceeded !== undefined) {
      return { ok: false, stage: "comptime", diagnostic: exceeded, stats: evaluation };
    }
    exports.push(Object.freeze({ ...output, value: constant }));
  }
  return {
    ok: true,
    exports: Object.freeze(exports),
    stats: Object.freeze({
      compilationCount: 1,
      evaluation,
      outputNodes,
      outputBytes,
      outputDepth,
    }),
  };
}

function unpackCollectedValues(
  value: FunctionalDeepValue,
  count: number,
): readonly FunctionalDeepValue[] | undefined {
  const values: FunctionalDeepValue[] = [];
  let current = value;
  for (let index = 0; index < count; index++) {
    if (current.kind !== "tuple" || current.fields.length !== 2) return undefined;
    values.push(current.fields[0]!);
    current = current.fields[1]!;
  }
  return current.kind === "unit" ? values : undefined;
}

function nonConstantOutput(
  output: ComptimeOutput,
): FunctionalComptimeDiagnostic {
  return {
    stage: "comptime",
    code: "F5001",
    kind: "non-constant-output",
    module: output.module,
    exportName: output.exportName,
    ...(output.span === undefined ? {} : { span: output.span }),
    message: `functional comptime export ${
      JSON.stringify(`${output.module}.${output.exportName}`)
    } produced a closure instead of a closed first-order constant`,
  };
}

function exceededOutputLimit(
  output: ComptimeOutput,
  nodes: number,
  bytes: number,
  depth: number,
  limits: ReturnType<typeof comptimeLimits>,
): FunctionalComptimeDiagnostic | undefined {
  const evidence = nodes > limits.maximumOutputNodes
    ? { label: "nodes", limit: limits.maximumOutputNodes, observed: nodes }
    : bytes > limits.maximumOutputBytes
    ? { label: "bytes", limit: limits.maximumOutputBytes, observed: bytes }
    : depth > limits.maximumOutputDepth
    ? { label: "depth", limit: limits.maximumOutputDepth, observed: depth }
    : undefined;
  if (evidence === undefined) return undefined;
  return {
    stage: "comptime",
    code: "F5002",
    kind: "output-limit",
    module: output.module,
    exportName: output.exportName,
    ...(output.span === undefined ? {} : { span: output.span }),
    limit: evidence.limit,
    observed: evidence.observed,
    message: `functional comptime output through ${
      JSON.stringify(`${output.module}.${output.exportName}`)
    } contains ${evidence.observed} ${evidence.label}; limit is ${evidence.limit}`,
  };
}

function qualifySchema(
  schema: FunctionalTypeSchema,
  artifact: FunctionalModuleArtifact,
  modules: ReadonlyMap<string, FunctionalModuleArtifact>,
): FunctionalTypeSchema {
  const names = new Map(
    artifact.typeDeclarations.map((
      declaration,
    ) => [declaration.name, `${artifact.name}::${declaration.name}`]),
  );
  for (const imported of artifact.imports) {
    const source = modules.get(imported.fromModule);
    if (source === undefined) continue;
    for (const declaration of source.typeDeclarations) {
      if (!names.has(declaration.name)) {
        names.set(declaration.name, `${source.name}::${declaration.name}`);
      }
    }
  }
  const rewrite = (value: FunctionalTypeSchema): FunctionalTypeSchema => {
    switch (value.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
      case "parameter":
        return value;
      case "tuple":
        return { kind: "tuple", values: [rewrite(value.values[0]), rewrite(value.values[1])] };
      case "named":
        return {
          kind: "named",
          name: names.get(value.name) ?? value.name,
          arguments: value.arguments.map(rewrite),
        };
      case "function":
        return {
          kind: "function",
          parameter: rewrite(value.parameter),
          result: rewrite(value.result),
        };
      case "forall":
        return { ...value, body: rewrite(value.body) };
    }
  };
  return rewrite(schema);
}

function comptimeLimits(options: FunctionalComptimeExecutionOptions): {
  readonly maximumOutputNodes: number;
  readonly maximumOutputBytes: number;
  readonly maximumOutputDepth: number;
} {
  return {
    maximumOutputNodes: positiveLimit(
      "maximumOutputNodes",
      options.maximumOutputNodes,
      DEFAULT_MAXIMUM_OUTPUT_NODES,
    ),
    maximumOutputBytes: positiveLimit(
      "maximumOutputBytes",
      options.maximumOutputBytes,
      DEFAULT_MAXIMUM_OUTPUT_BYTES,
    ),
    maximumOutputDepth: positiveLimit(
      "maximumOutputDepth",
      options.maximumOutputDepth,
      DEFAULT_MAXIMUM_OUTPUT_DEPTH,
    ),
  };
}

function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (Number.isSafeInteger(resolved) && resolved > 0) return resolved;
  throw new RangeError(
    `functional comptime ${name} must be a positive safe integer; received ${resolved}`,
  );
}

function uniqueCollectorName(modules: ReadonlyMap<string, FunctionalModuleArtifact>): string {
  let name = "$gpufuck-comptime-output";
  while (modules.has(name)) name += "$";
  return name;
}

function emptyComptimeStats(): FunctionalComptimeStats {
  return Object.freeze({
    compilationCount: 0,
    evaluation: Object.freeze({ steps: 0, allocations: 0, peakStack: 0, thunkEvaluations: 0 }),
    outputNodes: 0,
    outputBytes: 0,
    outputDepth: 0,
  });
}

function completedResults(
  results: readonly (FunctionalComptimeExecutionResult | undefined)[],
): readonly FunctionalComptimeExecutionResult[] {
  return results.map((result, index) => {
    if (result === undefined) throw new Error(`functional comptime batch omitted result ${index}`);
    return result;
  });
}
