import {
  FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH,
  FUNCTIONAL_DEFINITION_WORD_LENGTH,
  FUNCTIONAL_NO_INDEX,
  FunctionalConstructorWord,
  FunctionalCoreTag,
  FunctionalDefinitionWord,
  type FunctionalDiagnostic,
  type FunctionalSpan,
  type FunctionalType,
} from "./abi.ts";
import type { FunctionalIncrementalCache } from "./incremental_cache.ts";
import {
  buildFunctionalModuleGraph,
  FUNCTIONAL_INCREMENTAL_CACHE_FORMAT_VERSION,
  functionalDependencyClosure,
  type FunctionalModuleFingerprint,
  type FunctionalModuleGraph,
  functionalSccCacheKey,
} from "./incremental_graph.ts";
import type {
  FunctionalCompilationOptions,
  FunctionalCoreNode,
  GpuFunctionalCompiler,
  GpuFunctionalModule,
} from "./compiler.ts";
import {
  type FunctionalLinkedSource,
  type FunctionalModuleArtifact,
  linkFunctionalModules,
} from "./module_linker.ts";

const DEFAULT_COMPILER_CACHE_VERSION = "@mewhhaha/gpufuck@0.1.0";
const DEFAULT_INCREMENTAL_TARGET = "wasm32-functional-v1";

export interface FunctionalIncrementalCompilationOptions extends FunctionalCompilationOptions {
  readonly cache?: FunctionalIncrementalCache;
  readonly compilerVersion?: string;
  readonly target?: string;
}

export interface FunctionalIncrementalCompilationStats {
  readonly compiledModules: readonly string[];
  readonly reusedModules: readonly string[];
  readonly compiledComponents: number;
  readonly reusedComponents: number;
  readonly fingerprints: readonly FunctionalModuleFingerprint[];
}

export type FunctionalIncrementalCompileResult =
  | {
    readonly ok: true;
    readonly module: GpuFunctionalModule;
    readonly incremental: FunctionalIncrementalCompilationStats;
  }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [FunctionalDiagnostic, ...FunctionalDiagnostic[]];
    readonly incremental: FunctionalIncrementalCompilationStats;
  };

interface PortableCoreNode extends FunctionalCoreNode {
  readonly reference?: string;
}

interface PortableDefinition {
  readonly name: string;
  readonly nodes: readonly PortableCoreNode[];
}

interface CachedComponent {
  readonly cacheFormat: number;
  readonly key: string;
  readonly modules: readonly string[];
  readonly definitions: readonly PortableDefinition[];
  readonly entryType?: FunctionalType;
}

interface ComponentBuild {
  readonly index: number;
  readonly key: string;
  readonly modules: readonly string[];
  readonly linked: ReturnType<typeof linkFunctionalModules>;
}

export class IncrementalGpuFunctionalCompiler {
  readonly #compiler: GpuFunctionalCompiler;
  readonly #defaultCache: FunctionalIncrementalCache | undefined;
  readonly #compilerVersion: string;
  readonly #target: string;

  constructor(
    compiler: GpuFunctionalCompiler,
    options: {
      readonly cache?: FunctionalIncrementalCache;
      readonly compilerVersion?: string;
      readonly target?: string;
    } = {},
  ) {
    this.#compiler = compiler;
    this.#defaultCache = options.cache;
    this.#compilerVersion = cacheIdentity(
      "compilerVersion",
      options.compilerVersion ?? DEFAULT_COMPILER_CACHE_VERSION,
    );
    this.#target = cacheIdentity("target", options.target ?? DEFAULT_INCREMENTAL_TARGET);
  }

  async compile(
    artifacts: readonly FunctionalModuleArtifact[],
    entry: { readonly module: string; readonly exportName: string },
    options: FunctionalIncrementalCompilationOptions = {},
  ): Promise<FunctionalIncrementalCompileResult> {
    options.signal?.throwIfAborted();
    const linked = linkFunctionalModules(artifacts, entry);
    const graph = await buildFunctionalModuleGraph(artifacts);
    options.signal?.throwIfAborted();
    const cache = options.cache ?? this.#defaultCache;
    const identity = {
      compilerVersion: cacheIdentity(
        "compilerVersion",
        options.compilerVersion ?? this.#compilerVersion,
      ),
      target: cacheIdentity("target", options.target ?? this.#target),
    };
    const keys = await Promise.all(
      graph.components.map((_, index) => functionalSccCacheKey(graph, index, identity, entry)),
    );
    const cached = await Promise.all(
      keys.map(async (key) => {
        const bytes = await cache?.read(key);
        return bytes === undefined ? undefined : decodeCachedComponent(bytes, key);
      }),
    );
    options.signal?.throwIfAborted();
    const misses: ComponentBuild[] = [];
    for (const [index, component] of graph.components.entries()) {
      if (cached[index] !== undefined) continue;
      const closure = compilationClosure(graph, index, entry);
      misses.push({
        index,
        key: keys[index]!,
        modules: component.modules,
        linked: linkFunctionalModules(closure.artifacts, closure.entry),
      });
    }
    const stats = compilationStats(graph, cached);
    if (misses.length > 0) {
      const results = await this.#compiler.compileBatch(
        misses.map((miss) => miss.linked.module),
        compilationOptions(options),
      );
      if (results.length !== misses.length) {
        for (const result of results) if (result.ok) result.module.destroy();
        throw new Error(
          `incremental functional compiler received ${results.length} GPU results for ${misses.length} components`,
        );
      }
      const completed: { readonly index: number; readonly value: CachedComponent }[] = [];
      try {
        for (const [resultIndex, result] of results.entries()) {
          const miss = misses[resultIndex]!;
          if (!result.ok) {
            return {
              ok: false,
              diagnostics: translateDiagnostics(
                result.diagnostics,
                miss.linked.sources,
                linked.sources,
                linked.module.sourceByteLength,
              ),
              incremental: stats,
            };
          }
          const nodes = await result.module.readCoreNodes();
          completed.push({
            index: miss.index,
            value: Object.freeze({
              cacheFormat: FUNCTIONAL_INCREMENTAL_CACHE_FORMAT_VERSION,
              key: miss.key,
              modules: miss.modules,
              definitions: extractDefinitions(result.module, nodes, miss.modules),
              ...(miss.modules.includes(entry.module)
                ? { entryType: result.module.entryType }
                : {}),
            }),
          });
        }
      } finally {
        for (const result of results) if (result.ok) result.module.destroy();
      }
      for (const completion of completed) cached[completion.index] = completion.value;
      if (cache !== undefined) {
        options.signal?.throwIfAborted();
        await Promise.all(
          completed.map((completion) =>
            cache.write(completion.value.key, encodeCachedComponent(completion.value))
          ),
        );
      }
    }
    options.signal?.throwIfAborted();
    const components = cached.map((component, index) => {
      if (component !== undefined) return component;
      throw new Error(`incremental functional compiler omitted component ${index}`);
    });
    const entryComponent = graph.componentByModule.get(entry.module);
    const entryType = entryComponent === undefined
      ? undefined
      : components[entryComponent]?.entryType;
    if (entryType === undefined) {
      throw new Error(
        `incremental functional cache omitted entry type for ${JSON.stringify(entry.module)}.${
          JSON.stringify(entry.exportName)
        }`,
      );
    }
    const assembled = assembleCompiledCore(linked, components);
    const module = await this.#compiler.restoreCompiledCore(assembled.module, {
      nodes: assembled.nodes,
      entryType,
    });
    return { ok: true, module, incremental: stats };
  }
}

function cacheIdentity(name: string, value: string): string {
  if (value.length > 0) return value;
  throw new TypeError(
    `functional incremental ${name} must be nonempty; received ${JSON.stringify(value)}`,
  );
}

function compilationOptions(
  options: FunctionalIncrementalCompilationOptions,
): FunctionalCompilationOptions {
  return {
    ...(options.maximumSteps === undefined ? {} : { maximumSteps: options.maximumSteps }),
    ...(options.maximumStepsPerDispatch === undefined
      ? {}
      : { maximumStepsPerDispatch: options.maximumStepsPerDispatch }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

function compilationClosure(
  graph: FunctionalModuleGraph,
  componentIndex: number,
  requestedEntry: { readonly module: string; readonly exportName: string },
): {
  readonly artifacts: readonly FunctionalModuleArtifact[];
  readonly entry: { readonly module: string; readonly exportName: string };
} {
  const component = graph.components[componentIndex]!;
  const memberNames = new Set(component.modules);
  const artifacts = functionalDependencyClosure(graph, componentIndex).map((artifact) =>
    memberNames.has(artifact.name) ? artifact : dependencyInterfaceStub(artifact)
  );
  if (artifacts.some((artifact) => artifact.name === requestedEntry.module)) {
    if (memberNames.has(requestedEntry.module)) return { artifacts, entry: requestedEntry };
  }
  for (const moduleName of component.modules) {
    const artifact = graph.artifacts.get(moduleName)!;
    const exported = artifact.exports[0];
    if (exported !== undefined) {
      return { artifacts, entry: { module: moduleName, exportName: exported.name } };
    }
  }
  for (const artifact of artifacts) {
    const exported = artifact.exports[0];
    if (exported !== undefined) {
      return { artifacts, entry: { module: artifact.name, exportName: exported.name } };
    }
  }
  return { artifacts: [...graph.artifacts.values()], entry: requestedEntry };
}

function dependencyInterfaceStub(artifact: FunctionalModuleArtifact): FunctionalModuleArtifact {
  if (artifact.exports.some((exported) => exported.type === undefined)) return artifact;
  const exportsByDefinition = new Map<string, FunctionalModuleArtifact["exports"][number]>();
  for (const exported of artifact.exports) {
    if (!exportsByDefinition.has(exported.definition)) {
      exportsByDefinition.set(exported.definition, exported);
    }
  }
  const definitions = [...exportsByDefinition.values()].map((exported) => {
    const original = artifact.definitions.find((definition) =>
      definition.name === exported.definition
    );
    return {
      name: exported.definition,
      parameters: [],
      annotation: exported.type!,
      body: {
        kind: "name" as const,
        name: exported.definition,
        ...(original?.span === undefined ? {} : { span: original.span }),
      },
      ...(original?.span === undefined ? {} : { span: original.span }),
    };
  });
  return {
    name: artifact.name,
    definitions,
    typeDeclarations: artifact.typeDeclarations,
    imports: artifact.imports,
    exports: artifact.exports,
    ...(artifact.typeImports === undefined ? {} : { typeImports: artifact.typeImports }),
    ...(artifact.constructorImports === undefined
      ? {}
      : { constructorImports: artifact.constructorImports }),
    ...(artifact.typeExports === undefined ? {} : { typeExports: artifact.typeExports }),
    ...(artifact.constructorExports === undefined
      ? {}
      : { constructorExports: artifact.constructorExports }),
    sourceByteLength: artifact.sourceByteLength,
    options: {
      ...(artifact.options.evaluationProfile === undefined
        ? {}
        : { evaluationProfile: artifact.options.evaluationProfile }),
    },
  };
}

function compilationStats(
  graph: FunctionalModuleGraph,
  cached: readonly (CachedComponent | undefined)[],
): FunctionalIncrementalCompilationStats {
  const compiledModules: string[] = [];
  const reusedModules: string[] = [];
  let reusedComponents = 0;
  for (const [index, component] of graph.components.entries()) {
    if (cached[index] === undefined) compiledModules.push(...component.modules);
    else {
      reusedComponents++;
      reusedModules.push(...component.modules);
    }
  }
  return Object.freeze({
    compiledModules: Object.freeze(compiledModules.sort()),
    reusedModules: Object.freeze(reusedModules.sort()),
    compiledComponents: graph.components.length - reusedComponents,
    reusedComponents,
    fingerprints: Object.freeze([...graph.fingerprints.values()]),
  });
}

function extractDefinitions(
  module: GpuFunctionalModule,
  nodes: readonly FunctionalCoreNode[],
  members: readonly string[],
): readonly PortableDefinition[] {
  const ranges = new Map(module.sources.map((source) => [source.module, source]));
  const definitions: PortableDefinition[] = [];
  for (const [definitionIndex, name] of module.definitionNames.entries()) {
    const owner = definitionOwner(name, members);
    if (owner === undefined) continue;
    const root = module.definitionRoots[definitionIndex];
    const end = module.definitionRoots[definitionIndex + 1] ?? nodes.length;
    if (root === undefined || root >= end || end > nodes.length) {
      throw new Error(
        `incremental functional definition ${
          JSON.stringify(name)
        } has invalid Core range ${root}..${end}`,
      );
    }
    const source = ranges.get(owner);
    if (source === undefined) {
      throw new Error(
        `incremental functional definition ${JSON.stringify(name)} has no source range for ${
          JSON.stringify(owner)
        }`,
      );
    }
    definitions.push(Object.freeze({
      name,
      nodes: Object.freeze(
        nodes.slice(root, end).map((node, relativeIndex) =>
          portableNode(module, node, root, end, source, name, relativeIndex)
        ),
      ),
    }));
  }
  return Object.freeze(definitions);
}

function portableNode(
  module: GpuFunctionalModule,
  node: FunctionalCoreNode,
  root: number,
  end: number,
  source: FunctionalLinkedSource,
  definitionName: string,
  relativeIndex: number,
): PortableCoreNode {
  if (node.sourceByteOffset < source.startByte || node.sourceEndByte > source.endByte) {
    throw new Error(
      `incremental functional definition ${
        JSON.stringify(definitionName)
      } Core node ${relativeIndex} has span ${node.sourceByteOffset}..${node.sourceEndByte} outside module ${
        JSON.stringify(source.module)
      } range ${source.startByte}..${source.endByte}`,
    );
  }
  const reference = node.tag === FunctionalCoreTag.Global
    ? module.definitionNames[node.payload]
    : node.tag === FunctionalCoreTag.Constructor || node.tag === FunctionalCoreTag.CaseArm
    ? module.constructorNames[node.payload]
    : undefined;
  if (
    (node.tag === FunctionalCoreTag.Global || node.tag === FunctionalCoreTag.Constructor ||
      node.tag === FunctionalCoreTag.CaseArm) && reference === undefined
  ) {
    throw new Error(
      `incremental functional definition ${
        JSON.stringify(definitionName)
      } Core node ${relativeIndex} has unresolved payload ${node.payload}`,
    );
  }
  return Object.freeze({
    ...node,
    child0: portableChild(node, "child0", root, end, definitionName, relativeIndex),
    child1: portableChild(node, "child1", root, end, definitionName, relativeIndex),
    child2: portableChild(node, "child2", root, end, definitionName, relativeIndex),
    sourceByteOffset: node.sourceByteOffset - source.startByte,
    sourceEndByte: node.sourceEndByte - source.startByte,
    ...(reference === undefined ? {} : { reference }),
  });
}

function portableChild(
  node: FunctionalCoreNode,
  child: "child0" | "child1" | "child2",
  root: number,
  end: number,
  definitionName: string,
  relativeIndex: number,
): number {
  if (child === "child0" && isLiteralPayloadChild(node.tag)) return node[child];
  const value = node[child];
  if (value === FUNCTIONAL_NO_INDEX) return value;
  if (value >= root && value < end) return value - root;
  throw new Error(
    `incremental functional definition ${
      JSON.stringify(definitionName)
    } Core node ${relativeIndex} ${child} escapes its definition to node ${value}`,
  );
}

function assembleCompiledCore(
  linked: ReturnType<typeof linkFunctionalModules>,
  components: readonly CachedComponent[],
): {
  readonly module: ReturnType<typeof linkFunctionalModules>["module"];
  readonly nodes: readonly FunctionalCoreNode[];
} {
  const portableDefinitions = new Map<string, PortableDefinition>();
  for (const component of components) {
    for (const definition of component.definitions) {
      if (portableDefinitions.has(definition.name)) {
        throw new Error(
          `incremental functional cache repeats definition ${JSON.stringify(definition.name)}`,
        );
      }
      portableDefinitions.set(definition.name, definition);
    }
  }
  const definitionNames = encodedDefinitionNames(linked.module);
  const definitionIndices = new Map(definitionNames.map((name, index) => [name, index]));
  const constructorIndices = encodedConstructorNames(linked.module);
  const sourceRanges = new Map(linked.sources.map((source) => [source.module, source]));
  const moduleNames = linked.sources.map((source) => source.module);
  const definitionWords = linked.module.definitionWords.slice();
  const nodes: FunctionalCoreNode[] = [];
  for (const [definitionIndex, name] of definitionNames.entries()) {
    const portable = portableDefinitions.get(name);
    if (portable === undefined) {
      throw new Error(`incremental functional cache omitted definition ${JSON.stringify(name)}`);
    }
    const owner = definitionOwner(name, moduleNames);
    const source = owner === undefined ? undefined : sourceRanges.get(owner);
    if (source === undefined) {
      throw new Error(
        `incremental functional definition ${JSON.stringify(name)} has no linked source`,
      );
    }
    const root = nodes.length;
    definitionWords[
      definitionIndex * FUNCTIONAL_DEFINITION_WORD_LENGTH + FunctionalDefinitionWord.RootNode
    ] = root;
    for (const [relativeIndex, node] of portable.nodes.entries()) {
      if (node.sourceEndByte > source.endByte - source.startByte) {
        throw new Error(
          `incremental functional definition ${
            JSON.stringify(name)
          } Core node ${relativeIndex} has local span ${node.sourceByteOffset}..${node.sourceEndByte} outside module length ${
            source.endByte - source.startByte
          }`,
        );
      }
      const payload = node.reference === undefined
        ? node.payload
        : node.tag === FunctionalCoreTag.Global
        ? definitionIndices.get(node.reference)
        : constructorIndices.get(node.reference);
      if (payload === undefined) {
        throw new Error(
          `incremental functional definition ${
            JSON.stringify(name)
          } Core node ${relativeIndex} references missing ${JSON.stringify(node.reference)}`,
        );
      }
      nodes.push(Object.freeze({
        tag: node.tag,
        payload,
        child0: assembledChild(node, "child0", root),
        child1: assembledChild(node, "child1", root),
        child2: assembledChild(node, "child2", root),
        sourceByteOffset: source.startByte + node.sourceByteOffset,
        sourceEndByte: source.startByte + node.sourceEndByte,
        evaluationMode: node.evaluationMode,
      }));
    }
  }
  if (nodes.length !== linked.module.nodeCount) {
    throw new Error(
      `incremental functional Core assembled ${nodes.length} nodes; linked surface contains ${linked.module.nodeCount}`,
    );
  }
  return {
    module: { ...linked.module, definitionWords },
    nodes: Object.freeze(nodes),
  };
}

function assembledChild(
  node: PortableCoreNode,
  child: "child0" | "child1" | "child2",
  root: number,
): number {
  if (child === "child0" && isLiteralPayloadChild(node.tag)) return node[child];
  const value = node[child];
  return value === FUNCTIONAL_NO_INDEX ? value : root + value;
}

function isLiteralPayloadChild(tag: number): boolean {
  return tag === FunctionalCoreTag.SignedInteger64 || tag === FunctionalCoreTag.Float64;
}

function encodedDefinitionNames(
  module: ReturnType<typeof linkFunctionalModules>["module"],
): readonly string[] {
  return Object.freeze(Array.from({ length: module.definitionCount }, (_, definitionIndex) => {
    const symbol = module.definitionWords[
      definitionIndex * FUNCTIONAL_DEFINITION_WORD_LENGTH + FunctionalDefinitionWord.Symbol
    ];
    const name = symbol === undefined ? undefined : module.symbolNames[symbol];
    if (name === undefined) {
      throw new Error(
        `incremental functional linked definition ${definitionIndex} references missing symbol ${symbol}`,
      );
    }
    return name;
  }));
}

function encodedConstructorNames(
  module: ReturnType<typeof linkFunctionalModules>["module"],
): ReadonlyMap<string, number> {
  const constructors = new Map<string, number>();
  for (let index = 0; index < module.constructorCount; index++) {
    const symbol = module.constructorWords[
      index * FUNCTIONAL_CONSTRUCTOR_WORD_LENGTH + FunctionalConstructorWord.Symbol
    ];
    const name = symbol === undefined ? undefined : module.symbolNames[symbol];
    if (name === undefined) {
      throw new Error(
        `incremental functional linked constructor ${index} references missing symbol ${symbol}`,
      );
    }
    if (!constructors.has(name)) constructors.set(name, index);
  }
  return constructors;
}

function definitionOwner(name: string, modules: readonly string[]): string | undefined {
  let owner: string | undefined;
  for (const module of modules) {
    if (!name.startsWith(`${module}::`)) continue;
    if (owner === undefined || module.length > owner.length) owner = module;
  }
  return owner;
}

function encodeCachedComponent(component: CachedComponent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(component));
}

function decodeCachedComponent(bytes: Uint8Array, expectedKey: string): CachedComponent {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new Error(`functional incremental cache entry ${expectedKey} is not valid UTF-8 JSON`, {
      cause,
    });
  }
  if (!isRecord(decoded)) {
    throw new Error(`functional incremental cache entry ${expectedKey} must contain an object`);
  }
  if (decoded.cacheFormat !== FUNCTIONAL_INCREMENTAL_CACHE_FORMAT_VERSION) {
    throw new Error(
      `functional incremental cache entry ${expectedKey} has format ${
        String(decoded.cacheFormat)
      }; expected ${FUNCTIONAL_INCREMENTAL_CACHE_FORMAT_VERSION}`,
    );
  }
  if (decoded.key !== expectedKey) {
    throw new Error(
      `functional incremental cache entry ${expectedKey} contains key ${
        JSON.stringify(decoded.key)
      }`,
    );
  }
  if (!isStringArray(decoded.modules) || !Array.isArray(decoded.definitions)) {
    throw new Error(
      `functional incremental cache entry ${expectedKey} omits modules or definitions`,
    );
  }
  const definitions = decoded.definitions.map((candidate, definitionIndex) =>
    decodePortableDefinition(candidate, expectedKey, definitionIndex)
  );
  return {
    cacheFormat: FUNCTIONAL_INCREMENTAL_CACHE_FORMAT_VERSION,
    key: expectedKey,
    modules: Object.freeze([...decoded.modules]),
    definitions: Object.freeze(definitions),
    ...(decoded.entryType === undefined
      ? {}
      : { entryType: decodeFunctionalType(decoded.entryType, expectedKey) }),
  };
}

function decodeFunctionalType(candidate: unknown, key: string, depth = 0): FunctionalType {
  if (depth > 512 || !isRecord(candidate) || typeof candidate.kind !== "string") {
    throw new Error(`functional incremental cache entry ${key} has malformed entry type`);
  }
  switch (candidate.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return Object.freeze({ kind: candidate.kind });
    case "tuple":
      if (!Array.isArray(candidate.values) || candidate.values.length !== 2) {
        throw new Error(`functional incremental cache entry ${key} has malformed tuple entry type`);
      }
      return Object.freeze({
        kind: "tuple",
        values: Object.freeze([
          decodeFunctionalType(candidate.values[0], key, depth + 1),
          decodeFunctionalType(candidate.values[1], key, depth + 1),
        ]),
      }) as FunctionalType;
    case "named":
      if (typeof candidate.name !== "string" || !Array.isArray(candidate.arguments)) {
        throw new Error(`functional incremental cache entry ${key} has malformed named entry type`);
      }
      return Object.freeze({
        kind: "named",
        name: candidate.name,
        arguments: Object.freeze(
          candidate.arguments.map((argument) => decodeFunctionalType(argument, key, depth + 1)),
        ),
      });
    case "function":
      return Object.freeze({
        kind: "function",
        parameter: decodeFunctionalType(candidate.parameter, key, depth + 1),
        result: decodeFunctionalType(candidate.result, key, depth + 1),
      });
    default:
      throw new Error(
        `functional incremental cache entry ${key} has unknown entry type ${
          JSON.stringify(candidate.kind)
        }`,
      );
  }
}

function decodePortableDefinition(
  candidate: unknown,
  key: string,
  definitionIndex: number,
): PortableDefinition {
  if (
    !isRecord(candidate) || typeof candidate.name !== "string" || !Array.isArray(candidate.nodes)
  ) {
    throw new Error(
      `functional incremental cache entry ${key} has malformed definition ${definitionIndex}`,
    );
  }
  const nodes = candidate.nodes.map((node, nodeIndex) => {
    if (!isRecord(node)) {
      throw new Error(
        `functional incremental cache entry ${key} definition ${definitionIndex} has malformed node ${nodeIndex}`,
      );
    }
    for (
      const field of [
        "tag",
        "payload",
        "child0",
        "child1",
        "child2",
        "sourceByteOffset",
        "sourceEndByte",
        "evaluationMode",
      ] as const
    ) {
      if (isUint32(node[field])) continue;
      throw new Error(
        `functional incremental cache entry ${key} definition ${definitionIndex} node ${nodeIndex} has invalid ${field} ${
          String(node[field])
        }`,
      );
    }
    if (node.reference !== undefined && typeof node.reference !== "string") {
      throw new Error(
        `functional incremental cache entry ${key} definition ${definitionIndex} node ${nodeIndex} has invalid reference ${
          String(node.reference)
        }`,
      );
    }
    return Object.freeze({
      tag: node.tag,
      payload: node.payload,
      child0: node.child0,
      child1: node.child1,
      child2: node.child2,
      sourceByteOffset: node.sourceByteOffset,
      sourceEndByte: node.sourceEndByte,
      evaluationMode: node.evaluationMode,
      ...(node.reference === undefined ? {} : { reference: node.reference }),
    }) as PortableCoreNode;
  });
  for (const [nodeIndex, node] of nodes.entries()) {
    if (
      (node.tag === FunctionalCoreTag.Global || node.tag === FunctionalCoreTag.Constructor ||
        node.tag === FunctionalCoreTag.CaseArm) && node.reference === undefined
    ) {
      throw new Error(
        `functional incremental cache entry ${key} definition ${definitionIndex} node ${nodeIndex} omits its symbolic reference`,
      );
    }
    for (const child of portableChildValues(node)) {
      if (child === FUNCTIONAL_NO_INDEX || child < nodes.length) continue;
      throw new Error(
        `functional incremental cache entry ${key} definition ${definitionIndex} node ${nodeIndex} references local node ${child} outside ${nodes.length} nodes`,
      );
    }
  }
  return Object.freeze({ name: candidate.name, nodes: Object.freeze(nodes) });
}

function portableChildValues(node: PortableCoreNode): readonly number[] {
  switch (node.tag) {
    case FunctionalCoreTag.SignedInteger64:
    case FunctionalCoreTag.Float64:
    case FunctionalCoreTag.Integer:
    case FunctionalCoreTag.Float32:
    case FunctionalCoreTag.Boolean:
    case FunctionalCoreTag.Local:
    case FunctionalCoreTag.Global:
    case FunctionalCoreTag.Constructor:
      return [];
    case FunctionalCoreTag.Lambda:
    case FunctionalCoreTag.Unary:
    case FunctionalCoreTag.NumericConvert:
    case FunctionalCoreTag.PatternBind:
      return [node.child0];
    case FunctionalCoreTag.Apply:
    case FunctionalCoreTag.Let:
    case FunctionalCoreTag.LetRec:
    case FunctionalCoreTag.Binary:
    case FunctionalCoreTag.Case:
    case FunctionalCoreTag.CaseArm:
      return [node.child0, node.child1];
    case FunctionalCoreTag.If:
      return [node.child0, node.child1, node.child2];
    default:
      throw new Error(`functional incremental cache contains unknown Core tag ${node.tag}`);
  }
}

function translateDiagnostics(
  diagnostics: readonly [FunctionalDiagnostic, ...FunctionalDiagnostic[]],
  compiledSources: readonly FunctionalLinkedSource[],
  linkedSources: readonly FunctionalLinkedSource[],
  linkedSourceByteLength: number,
): readonly [FunctionalDiagnostic, ...FunctionalDiagnostic[]] {
  const translated = diagnostics.map((diagnostic) => ({
    ...diagnostic,
    span: translateSpan(
      diagnostic.span,
      compiledSources,
      linkedSources,
      linkedSourceByteLength,
    ),
    ...(diagnostic.related === undefined ? {} : {
      related: diagnostic.related.map((related) => ({
        ...related,
        span: translateSpan(
          related.span,
          compiledSources,
          linkedSources,
          linkedSourceByteLength,
        ),
      })),
    }),
  }));
  return translated as [FunctionalDiagnostic, ...FunctionalDiagnostic[]];
}

function translateSpan(
  span: FunctionalSpan,
  compiledSources: readonly FunctionalLinkedSource[],
  linkedSources: readonly FunctionalLinkedSource[],
  linkedSourceByteLength: number,
): FunctionalSpan {
  const source = compiledSources.find((candidate) =>
    span.startByte >= candidate.startByte && span.endByte <= candidate.endByte
  );
  if (source === undefined) return { startByte: 0, endByte: linkedSourceByteLength };
  const target = linkedSources.find((candidate) => candidate.module === source.module);
  if (target === undefined) return { startByte: 0, endByte: linkedSourceByteLength };
  return {
    startByte: target.startByte + span.startByte - source.startByte,
    endByte: target.startByte + span.endByte - source.startByte,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isUint32(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffffffff;
}
