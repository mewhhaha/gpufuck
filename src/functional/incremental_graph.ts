import { FUNCTIONAL_MODULE_ABI_VERSION, type FunctionalTypeSchema } from "./abi.ts";
import { createFunctionalModuleArtifact, type FunctionalModuleArtifact } from "./module_linker.ts";

export const FUNCTIONAL_INCREMENTAL_CACHE_FORMAT_VERSION = 1;

export interface FunctionalModuleFingerprint {
  readonly name: string;
  readonly interfaceFingerprint: string;
  readonly implementationFingerprint: string;
}

export interface FunctionalModuleScc {
  readonly modules: readonly string[];
  readonly dependencies: readonly number[];
}

export interface FunctionalModuleGraph {
  readonly artifacts: ReadonlyMap<string, FunctionalModuleArtifact>;
  readonly fingerprints: ReadonlyMap<string, FunctionalModuleFingerprint>;
  readonly components: readonly FunctionalModuleScc[];
  readonly componentByModule: ReadonlyMap<string, number>;
}

export interface FunctionalIncrementalCompilerIdentity {
  readonly compilerVersion: string;
  readonly target: string;
}

export async function fingerprintFunctionalModuleArtifact(
  candidate: FunctionalModuleArtifact,
): Promise<FunctionalModuleFingerprint> {
  const artifact = createFunctionalModuleArtifact(candidate);
  const [interfaceFingerprint, implementationFingerprint] = await Promise.all([
    fingerprint(interfaceShape(artifact)),
    fingerprint(artifact),
  ]);
  return Object.freeze({
    name: artifact.name,
    interfaceFingerprint,
    implementationFingerprint,
  });
}

export async function buildFunctionalModuleGraph(
  candidates: readonly FunctionalModuleArtifact[],
): Promise<FunctionalModuleGraph> {
  const artifacts = new Map<string, FunctionalModuleArtifact>();
  for (const candidate of candidates) {
    const artifact = createFunctionalModuleArtifact(candidate);
    if (artifacts.has(artifact.name)) {
      throw new Error(
        `incremental functional compilation repeats module ${JSON.stringify(artifact.name)}`,
      );
    }
    artifacts.set(artifact.name, artifact);
  }
  for (const artifact of artifacts.values()) {
    for (const dependency of moduleDependencies(artifact)) {
      if (artifacts.has(dependency.module)) continue;
      throw new Error(
        `incremental functional module ${JSON.stringify(artifact.name)} imports missing module ${
          JSON.stringify(dependency.module)
        } through ${JSON.stringify(dependency.name)}`,
      );
    }
  }

  const fingerprintEntries = await Promise.all(
    [...artifacts.values()].map(async (artifact) =>
      [artifact.name, await fingerprintFunctionalModuleArtifact(artifact)] as const
    ),
  );
  const fingerprints = new Map(fingerprintEntries);
  const { components, componentByModule } = stronglyConnectedComponents(artifacts);
  return Object.freeze({
    artifacts,
    fingerprints,
    components,
    componentByModule,
  });
}

export async function functionalSccCacheKey(
  graph: FunctionalModuleGraph,
  componentIndex: number,
  identity: FunctionalIncrementalCompilerIdentity,
  entry: { readonly module: string; readonly exportName: string },
): Promise<string> {
  const component = graph.components[componentIndex];
  if (component === undefined) {
    throw new Error(`incremental functional graph has no component ${componentIndex}`);
  }
  const members = component.modules.map((name) => {
    const moduleFingerprint = requiredFingerprint(graph, name);
    return {
      name,
      implementation: moduleFingerprint.implementationFingerprint,
    };
  });
  const dependencies = component.dependencies.flatMap((dependencyIndex) => {
    const dependency = graph.components[dependencyIndex];
    if (dependency === undefined) {
      throw new Error(
        `incremental functional component ${componentIndex} references missing component ${dependencyIndex}`,
      );
    }
    return dependency.modules.map((name) => ({
      name,
      interface: requiredFingerprint(graph, name).interfaceFingerprint,
    }));
  }).sort(compareNamed);
  return await fingerprint({
    cacheFormat: FUNCTIONAL_INCREMENTAL_CACHE_FORMAT_VERSION,
    moduleAbi: FUNCTIONAL_MODULE_ABI_VERSION,
    compilerVersion: identity.compilerVersion,
    target: identity.target,
    members,
    dependencies,
    entry: component.modules.includes(entry.module) ? entry : null,
  });
}

export function functionalDependencyClosure(
  graph: FunctionalModuleGraph,
  componentIndex: number,
): readonly FunctionalModuleArtifact[] {
  const included = new Set<number>();
  const visit = (index: number): void => {
    if (included.has(index)) return;
    const component = graph.components[index];
    if (component === undefined) {
      throw new Error(`incremental functional graph has no component ${index}`);
    }
    included.add(index);
    for (const dependency of component.dependencies) visit(dependency);
  };
  visit(componentIndex);
  return Object.freeze(
    [...graph.artifacts.values()].filter((artifact) => {
      const index = graph.componentByModule.get(artifact.name);
      return index !== undefined && included.has(index);
    }),
  );
}

function requiredFingerprint(
  graph: FunctionalModuleGraph,
  name: string,
): FunctionalModuleFingerprint {
  const moduleFingerprint = graph.fingerprints.get(name);
  if (moduleFingerprint === undefined) {
    throw new Error(`incremental functional graph omitted fingerprint for ${JSON.stringify(name)}`);
  }
  return moduleFingerprint;
}

function interfaceShape(artifact: FunctionalModuleArtifact): unknown {
  const inferredExportDefinitions = new Set(
    artifact.exports.flatMap((exported) =>
      exported.type === undefined ? [exported.definition] : []
    ),
  );
  return {
    name: artifact.name,
    imports: [...artifact.imports].sort(compareNamed).map((imported) => ({
      name: imported.name,
      fromModule: imported.fromModule,
      exportName: imported.exportName,
      type: imported.type === undefined ? null : schemaShape(imported.type),
    })),
    exports: [...artifact.exports].sort(compareNamed).map((exported) => ({
      name: exported.name,
      definition: exported.definition,
      type: exported.type === undefined ? null : schemaShape(exported.type),
    })),
    typeImports: [...artifact.typeImports ?? []].sort(compareNamed),
    constructorImports: [...artifact.constructorImports ?? []].sort(compareNamed),
    typeExports: [...artifact.typeExports ?? []].sort(compareNamed),
    constructorExports: [...artifact.constructorExports ?? []].sort(compareNamed),
    inferredExportDefinitions: artifact.definitions.filter((definition) =>
      inferredExportDefinitions.has(definition.name)
    ),
    typeDeclarations: [...artifact.typeDeclarations].sort(compareNamed).map((declaration) => ({
      name: declaration.name,
      parameters: declaration.parameters,
      constructors: declaration.constructors.map((constructor) => ({
        name: constructor.name,
        fields: constructor.fields.map((field) => ({
          name: field.name,
          type: schemaShape(field.type),
        })),
        result: constructor.result === undefined ? null : schemaShape(constructor.result),
      })),
    })),
    evaluationProfile: artifact.options.evaluationProfile ?? null,
    hostCapabilities: artifact.options.hostCapabilities ?? [],
    hostDefinitions: artifact.options.hostDefinitions ?? [],
    wasmExports: artifact.options.wasmExports ?? [],
  };
}

function schemaShape(schema: FunctionalTypeSchema): unknown {
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return { kind: schema.kind };
    case "parameter":
      return { kind: "parameter", name: schema.name };
    case "tuple":
      return { kind: "tuple", values: schema.values.map(schemaShape) };
    case "named":
      return { kind: "named", name: schema.name, arguments: schema.arguments.map(schemaShape) };
    case "function":
      return {
        kind: "function",
        parameter: schemaShape(schema.parameter),
        result: schemaShape(schema.result),
      };
    case "forall":
      return { kind: "forall", parameters: schema.parameters, body: schemaShape(schema.body) };
  }
}

function stronglyConnectedComponents(
  artifacts: ReadonlyMap<string, FunctionalModuleArtifact>,
): Pick<FunctionalModuleGraph, "components" | "componentByModule"> {
  let nextIndex = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const stacked = new Set<string>();
  const memberGroups: string[][] = [];

  const visit = (name: string): void => {
    const index = nextIndex++;
    indexes.set(name, index);
    lowLinks.set(name, index);
    stack.push(name);
    stacked.add(name);
    const artifact = artifacts.get(name)!;
    const dependencies = [...new Set(moduleDependencies(artifact).map((value) => value.module))]
      .sort();
    for (const dependency of dependencies) {
      if (!indexes.has(dependency)) {
        visit(dependency);
        lowLinks.set(name, Math.min(lowLinks.get(name)!, lowLinks.get(dependency)!));
      } else if (stacked.has(dependency)) {
        lowLinks.set(name, Math.min(lowLinks.get(name)!, indexes.get(dependency)!));
      }
    }
    if (lowLinks.get(name) !== indexes.get(name)) return;
    const members: string[] = [];
    while (stack.length > 0) {
      const member = stack.pop()!;
      stacked.delete(member);
      members.push(member);
      if (member === name) break;
    }
    memberGroups.push(members.sort());
  };

  for (const name of artifacts.keys()) if (!indexes.has(name)) visit(name);
  memberGroups.sort((left, right) => left[0]!.localeCompare(right[0]!));
  const componentByModule = new Map<string, number>();
  for (const [componentIndex, members] of memberGroups.entries()) {
    for (const member of members) componentByModule.set(member, componentIndex);
  }
  const components = memberGroups.map((modules, componentIndex) => {
    const dependencies = new Set<number>();
    for (const name of modules) {
      for (const dependency of moduleDependencies(artifacts.get(name)!)) {
        const dependencyIndex = componentByModule.get(dependency.module)!;
        if (dependencyIndex !== componentIndex) dependencies.add(dependencyIndex);
      }
    }
    return Object.freeze({
      modules: Object.freeze(modules),
      dependencies: Object.freeze([...dependencies].sort((left, right) => left - right)),
    });
  });
  return {
    components: Object.freeze(components),
    componentByModule,
  };
}

function moduleDependencies(
  artifact: FunctionalModuleArtifact,
): readonly { readonly module: string; readonly name: string }[] {
  return [
    ...artifact.imports.map((imported) => ({ module: imported.fromModule, name: imported.name })),
    ...(artifact.typeImports ?? []).map((imported) => ({
      module: imported.fromModule,
      name: imported.name,
    })),
    ...(artifact.constructorImports ?? []).map((imported) => ({
      module: imported.fromModule,
      name: imported.name,
    })),
  ];
}

function compareNamed(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string") return `s${JSON.stringify(value)}`;
  if (typeof value === "boolean") return value ? "b1" : "b0";
  if (typeof value === "bigint") return `i${value}`;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nNaN";
    if (value === Infinity) return "nInfinity";
    if (value === -Infinity) return "n-Infinity";
    if (Object.is(value, -0)) return "n-0";
    return `n${value}`;
  }
  if (typeof value === "undefined") return "u";
  if (typeof value !== "object") {
    throw new TypeError(`cannot fingerprint functional artifact value of type ${typeof value}`);
  }
  if (ancestors.has(value)) {
    throw new TypeError("cannot fingerprint a cyclic functional module artifact");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonical(entry, ancestors)).join(",")}]`;
    }
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${
      entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry, ancestors)}`).join(
        ",",
      )
    }}`;
  } finally {
    ancestors.delete(value);
  }
}
