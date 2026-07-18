import {
  decodeFunctionalConstant,
  encodeFunctionalConstant,
  functionalConstantExpression,
} from "./comptime_constant.ts";
import type {
  FunctionalComptimeExecutionOptions,
  FunctionalComptimeExecutionResult,
  FunctionalComptimeExportValue,
  FunctionalComptimeModuleArtifact,
} from "./comptime_contract.ts";
import type { GpuFunctionalComptimeExecutor } from "./comptime.ts";
import type { FunctionalIncrementalCache } from "./incremental_cache.ts";
import {
  buildFunctionalModuleGraph,
  functionalDependencyClosure,
  type FunctionalModuleGraph,
} from "./incremental_graph.ts";
import type { FunctionalModuleArtifact } from "./module_linker.ts";

const FUNCTIONAL_COMPTIME_CACHE_FORMAT_VERSION = 1;
const DEFAULT_COMPTIME_COMPILER_VERSION = "@mewhhaha/gpufuck@0.1.0";
const DEFAULT_COMPTIME_TARGET = "functional-comptime-v1";

export interface FunctionalIncrementalComptimeStats {
  readonly compiledModules: readonly string[];
  readonly reusedModules: readonly string[];
  readonly compiledComponents: number;
  readonly reusedComponents: number;
}

export type FunctionalIncrementalComptimeResult =
  | {
    readonly ok: true;
    readonly exports: readonly FunctionalComptimeExportValue[];
    readonly incremental: FunctionalIncrementalComptimeStats;
  }
  | {
    readonly ok: false;
    readonly failure: Exclude<FunctionalComptimeExecutionResult, { readonly ok: true }>;
    readonly incremental: FunctionalIncrementalComptimeStats;
  };

interface CachedComptimeComponent {
  readonly cacheFormat: number;
  readonly key: string;
  readonly modules: readonly string[];
  readonly exports: readonly {
    readonly module: string;
    readonly exportName: string;
    readonly encodedConstant: string;
  }[];
  readonly outputFingerprint: string;
}

export class IncrementalGpuFunctionalComptimeExecutor {
  readonly #executor: GpuFunctionalComptimeExecutor;
  readonly #cache: FunctionalIncrementalCache | undefined;
  readonly #compilerVersion: string;
  readonly #target: string;

  constructor(
    executor: GpuFunctionalComptimeExecutor,
    options: {
      readonly cache?: FunctionalIncrementalCache;
      readonly compilerVersion?: string;
      readonly target?: string;
    } = {},
  ) {
    this.#executor = executor;
    this.#cache = options.cache;
    this.#compilerVersion = nonemptyIdentity(
      "compilerVersion",
      options.compilerVersion ?? DEFAULT_COMPTIME_COMPILER_VERSION,
    );
    this.#target = nonemptyIdentity("target", options.target ?? DEFAULT_COMPTIME_TARGET);
  }

  async execute(
    artifacts: readonly FunctionalComptimeModuleArtifact[],
    options: FunctionalComptimeExecutionOptions & {
      readonly cache?: FunctionalIncrementalCache;
      readonly compilerVersion?: string;
      readonly target?: string;
    } = {},
  ): Promise<FunctionalIncrementalComptimeResult> {
    options.signal?.throwIfAborted();
    const functionalArtifacts = artifacts.map(functionalArtifact);
    const graph = await buildFunctionalModuleGraph(functionalArtifacts);
    const cache = options.cache ?? this.#cache;
    const compilerVersion = nonemptyIdentity(
      "compilerVersion",
      options.compilerVersion ?? this.#compilerVersion,
    );
    const target = nonemptyIdentity("target", options.target ?? this.#target);
    const completed = new Map<number, CachedComptimeComponent>();
    const remaining = new Set(graph.components.map((_, index) => index));
    const compiledModules = new Set<string>();
    const reusedModules = new Set<string>();

    while (remaining.size > 0) {
      options.signal?.throwIfAborted();
      const ready = [...remaining].filter((index) =>
        graph.components[index]!.dependencies.every((dependency) => completed.has(dependency))
      );
      if (ready.length === 0) {
        throw new Error(
          `functional comptime dependency graph could not schedule ${remaining.size} components`,
        );
      }
      const keys = await Promise.all(
        ready.map((index) =>
          comptimeComponentKey(graph, index, completed, compilerVersion, target)
        ),
      );
      const cached = await Promise.all(keys.map(async (key) => {
        const bytes = await cache?.read(key);
        return bytes === undefined ? undefined : await decodeCachedComponent(bytes, key, graph);
      }));
      const misses: {
        readonly componentIndex: number;
        readonly key: string;
        readonly artifacts: readonly FunctionalComptimeModuleArtifact[];
        readonly selections: readonly { readonly module: string; readonly exportName: string }[];
      }[] = [];
      for (const [readyIndex, componentIndex] of ready.entries()) {
        const hit = cached[readyIndex];
        if (hit !== undefined) {
          completed.set(componentIndex, hit);
          for (const module of graph.components[componentIndex]!.modules) reusedModules.add(module);
          remaining.delete(componentIndex);
          continue;
        }
        const members = graph.components[componentIndex]!.modules;
        misses.push({
          componentIndex,
          key: keys[readyIndex]!,
          artifacts: componentArtifacts(graph, componentIndex, completed),
          selections: members.flatMap((name) =>
            graph.artifacts.get(name)!.exports.map((exported) => ({
              module: name,
              exportName: exported.name,
            }))
          ),
        });
      }
      if (misses.length === 0) continue;
      const executions = await this.#executor.executeExportsBatch(
        misses.map((miss) => ({ artifacts: miss.artifacts, exports: miss.selections })),
        executionOptions(options),
      );
      if (executions.length !== misses.length) {
        throw new Error(
          `incremental functional comptime received ${executions.length} results for ${misses.length} components`,
        );
      }
      const writes: Promise<void>[] = [];
      for (const [executionIndex, execution] of executions.entries()) {
        const miss = misses[executionIndex]!;
        const component = graph.components[miss.componentIndex]!;
        for (const module of component.modules) compiledModules.add(module);
        if (!execution.ok) {
          return {
            ok: false,
            failure: execution,
            incremental: incrementalStats(compiledModules, reusedModules, graph),
          };
        }
        const cachedComponent = await cachedComponentFromExecution(
          miss.key,
          component.modules,
          execution.exports,
          graph,
        );
        completed.set(miss.componentIndex, cachedComponent);
        remaining.delete(miss.componentIndex);
        if (cache !== undefined) {
          writes.push(cache.write(miss.key, encodeCachedComponent(cachedComponent)));
        }
      }
      await Promise.all(writes);
    }

    const constants = new Map<string, ReturnType<typeof decodeFunctionalConstant>>();
    for (const component of completed.values()) {
      for (const exported of component.exports) {
        constants.set(
          exportKey(exported.module, exported.exportName),
          decodeFunctionalConstant(new TextEncoder().encode(exported.encodedConstant)),
        );
      }
    }
    const exportedValues = artifacts.flatMap((artifact) =>
      artifact.exports.map((exported) => {
        const value = constants.get(exportKey(artifact.name, exported.name));
        if (value === undefined) {
          throw new Error(
            `incremental functional comptime omitted export ${
              JSON.stringify(`${artifact.name}.${exported.name}`)
            }`,
          );
        }
        return Object.freeze({
          module: artifact.name,
          exportName: exported.name,
          definition: exported.definition,
          type: exported.type,
          value,
        });
      })
    );
    return {
      ok: true,
      exports: Object.freeze(exportedValues),
      incremental: incrementalStats(compiledModules, reusedModules, graph),
    };
  }
}

function functionalArtifact(artifact: FunctionalComptimeModuleArtifact): FunctionalModuleArtifact {
  return {
    name: artifact.name,
    definitions: artifact.definitions,
    typeDeclarations: artifact.typeDeclarations,
    imports: artifact.imports,
    exports: artifact.exports,
    sourceByteLength: artifact.sourceByteLength,
    options: {
      ...(artifact.evaluationProfile === undefined
        ? {}
        : { evaluationProfile: artifact.evaluationProfile }),
    },
  };
}

function componentArtifacts(
  graph: FunctionalModuleGraph,
  componentIndex: number,
  completed: ReadonlyMap<number, CachedComptimeComponent>,
): readonly FunctionalComptimeModuleArtifact[] {
  const members = new Set(graph.components[componentIndex]!.modules);
  return functionalDependencyClosure(graph, componentIndex).map((artifact) => {
    if (members.has(artifact.name)) return comptimeArtifact(artifact);
    const dependencyIndex = graph.componentByModule.get(artifact.name)!;
    const cached = completed.get(dependencyIndex);
    if (cached === undefined) {
      throw new Error(
        `functional comptime component ${componentIndex} omitted dependency ${dependencyIndex}`,
      );
    }
    return constantStub(artifact, cached);
  });
}

function comptimeArtifact(artifact: FunctionalModuleArtifact): FunctionalComptimeModuleArtifact {
  return {
    name: artifact.name,
    definitions: artifact.definitions,
    typeDeclarations: artifact.typeDeclarations,
    imports: artifact.imports,
    exports: typedComptimeExports(artifact),
    sourceByteLength: artifact.sourceByteLength,
    ...(artifact.options.evaluationProfile === undefined
      ? {}
      : { evaluationProfile: artifact.options.evaluationProfile }),
  };
}

function constantStub(
  artifact: FunctionalModuleArtifact,
  cached: CachedComptimeComponent,
): FunctionalComptimeModuleArtifact {
  const cachedExports = new Map(cached.exports.map((exported) => [
    exportKey(exported.module, exported.exportName),
    exported,
  ]));
  const definitions = new Map<string, FunctionalComptimeModuleArtifact["definitions"][number]>();
  for (const exported of typedComptimeExports(artifact)) {
    if (definitions.has(exported.definition)) continue;
    const cachedExport = cachedExports.get(exportKey(artifact.name, exported.name));
    if (cachedExport === undefined) {
      throw new Error(
        `functional comptime cache omitted dependency export ${
          JSON.stringify(`${artifact.name}.${exported.name}`)
        }`,
      );
    }
    const original = artifact.definitions.find((definition) =>
      definition.name === exported.definition
    );
    definitions.set(exported.definition, {
      name: exported.definition,
      parameters: [],
      annotation: exported.type,
      body: functionalConstantExpression(
        decodeFunctionalConstant(new TextEncoder().encode(cachedExport.encodedConstant)),
        original?.span,
      ),
      ...(original?.span === undefined ? {} : { span: original.span }),
    });
  }
  return {
    name: artifact.name,
    definitions: Object.freeze([...definitions.values()]),
    typeDeclarations: artifact.typeDeclarations,
    imports: artifact.imports,
    exports: typedComptimeExports(artifact),
    sourceByteLength: artifact.sourceByteLength,
    ...(artifact.options.evaluationProfile === undefined
      ? {}
      : { evaluationProfile: artifact.options.evaluationProfile }),
  };
}

function typedComptimeExports(
  artifact: FunctionalModuleArtifact,
): FunctionalComptimeModuleArtifact["exports"] {
  return artifact.exports.flatMap((exported) =>
    exported.type === undefined ? [] : [{ ...exported, type: exported.type }]
  );
}

async function comptimeComponentKey(
  graph: FunctionalModuleGraph,
  componentIndex: number,
  completed: ReadonlyMap<number, CachedComptimeComponent>,
  compilerVersion: string,
  target: string,
): Promise<string> {
  const component = graph.components[componentIndex]!;
  return await sha256(JSON.stringify({
    cacheFormat: FUNCTIONAL_COMPTIME_CACHE_FORMAT_VERSION,
    compilerVersion,
    target,
    members: component.modules.map((name) => ({
      name,
      implementation: graph.fingerprints.get(name)!.implementationFingerprint,
    })),
    dependencies: component.dependencies.map((dependencyIndex) => ({
      modules: graph.components[dependencyIndex]!.modules,
      output: completed.get(dependencyIndex)!.outputFingerprint,
    })),
  }));
}

async function cachedComponentFromExecution(
  key: string,
  modules: readonly string[],
  exports: readonly FunctionalComptimeExportValue[],
  graph: FunctionalModuleGraph,
): Promise<CachedComptimeComponent> {
  const encodedExports = exports.map((exported) => ({
    module: exported.module,
    exportName: exported.exportName,
    encodedConstant: new TextDecoder().decode(encodeFunctionalConstant(exported.value)),
  }));
  const interfaces = modules.map((name) => ({
    name,
    fingerprint: graph.fingerprints.get(name)!.interfaceFingerprint,
  }));
  return Object.freeze({
    cacheFormat: FUNCTIONAL_COMPTIME_CACHE_FORMAT_VERSION,
    key,
    modules: Object.freeze([...modules]),
    exports: Object.freeze(encodedExports),
    outputFingerprint: await sha256(JSON.stringify({ interfaces, exports: encodedExports })),
  });
}

function encodeCachedComponent(component: CachedComptimeComponent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(component));
}

async function decodeCachedComponent(
  bytes: Uint8Array,
  key: string,
  graph: FunctionalModuleGraph,
): Promise<CachedComptimeComponent> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`functional comptime cache entry ${key} is not valid UTF-8 JSON`, { cause });
  }
  if (
    !isRecord(value) || value.cacheFormat !== FUNCTIONAL_COMPTIME_CACHE_FORMAT_VERSION ||
    value.key !== key || !isStringArray(value.modules) || !Array.isArray(value.exports) ||
    typeof value.outputFingerprint !== "string"
  ) {
    throw new Error(`functional comptime cache entry ${key} has an invalid envelope`);
  }
  const exports = value.exports.map((candidate, index) => {
    if (
      !isRecord(candidate) || typeof candidate.module !== "string" ||
      typeof candidate.exportName !== "string" || typeof candidate.encodedConstant !== "string"
    ) {
      throw new Error(`functional comptime cache entry ${key} has malformed export ${index}`);
    }
    decodeFunctionalConstant(new TextEncoder().encode(candidate.encodedConstant));
    return {
      module: candidate.module,
      exportName: candidate.exportName,
      encodedConstant: candidate.encodedConstant,
    };
  });
  const interfaces = value.modules.map((name) => {
    const fingerprint = graph.fingerprints.get(name)?.interfaceFingerprint;
    if (fingerprint === undefined) {
      throw new Error(
        `functional comptime cache entry ${key} references unknown module ${JSON.stringify(name)}`,
      );
    }
    return { name, fingerprint };
  });
  const outputFingerprint = await sha256(JSON.stringify({ interfaces, exports }));
  if (outputFingerprint !== value.outputFingerprint) {
    throw new Error(
      `functional comptime cache entry ${key} output fingerprint is ${
        JSON.stringify(value.outputFingerprint)
      }; expected ${outputFingerprint}`,
    );
  }
  return {
    cacheFormat: FUNCTIONAL_COMPTIME_CACHE_FORMAT_VERSION,
    key,
    modules: Object.freeze([...value.modules]),
    exports: Object.freeze(exports),
    outputFingerprint,
  };
}

function incrementalStats(
  compiledModules: ReadonlySet<string>,
  reusedModules: ReadonlySet<string>,
  graph: FunctionalModuleGraph,
): FunctionalIncrementalComptimeStats {
  const compiledComponents =
    graph.components.filter((component) =>
      component.modules.some((module) => compiledModules.has(module))
    ).length;
  const reusedComponents =
    graph.components.filter((component) =>
      component.modules.some((module) => reusedModules.has(module))
    ).length;
  return Object.freeze({
    compiledModules: Object.freeze([...compiledModules].sort()),
    reusedModules: Object.freeze([...reusedModules].sort()),
    compiledComponents,
    reusedComponents,
  });
}

function executionOptions(
  options: FunctionalComptimeExecutionOptions,
): FunctionalComptimeExecutionOptions {
  return {
    ...(options.maximumCompilationSteps === undefined
      ? {}
      : { maximumCompilationSteps: options.maximumCompilationSteps }),
    ...(options.maximumExecutionSteps === undefined
      ? {}
      : { maximumExecutionSteps: options.maximumExecutionSteps }),
    ...(options.maximumStepsPerDispatch === undefined
      ? {}
      : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
    ...(options.heapSlots === undefined ? {} : { heapSlots: options.heapSlots }),
    ...(options.stackFrames === undefined ? {} : { stackFrames: options.stackFrames }),
    ...(options.maximumOutputNodes === undefined
      ? {}
      : { maximumOutputNodes: options.maximumOutputNodes }),
    ...(options.maximumOutputBytes === undefined
      ? {}
      : { maximumOutputBytes: options.maximumOutputBytes }),
    ...(options.maximumOutputDepth === undefined
      ? {}
      : { maximumOutputDepth: options.maximumOutputDepth }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function nonemptyIdentity(name: string, value: string): string {
  if (value.length > 0) return value;
  throw new TypeError(
    `functional comptime ${name} must be nonempty; received ${JSON.stringify(value)}`,
  );
}

function exportKey(module: string, exportName: string): string {
  return `${module}\0${exportName}`;
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
