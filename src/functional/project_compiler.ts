import { measureCompilerStage, measureCompilerStageAsync } from "../compiler_performance_trace.ts";
import type { CompilerPerformanceTrace } from "../compiler_performance_trace.ts";
import {
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type Diagnostic,
  type EncodedModule,
  TypecheckingProfile,
  type TypeSchema,
} from "./abi.ts";
import { rebindCompiledModuleSource } from "./compiled_module_rebinding.ts";
import { CpuCompiler, validateCompilationOptions } from "./compiler.ts";
import type { CompilationOptions, CompiledModule, CpuCompileResult } from "./compiler_module.ts";
import { linkRelocatableCore, type RelocatableCoreUnit } from "./core_linker.ts";
import { effectNames, type EffectSet } from "./effect_set.ts";
import { inferModuleDefinitionSchemes } from "./module_interface.ts";
import {
  createModuleArtifact,
  LinkError,
  linkModules,
  type ModuleArtifact,
} from "./module_linker.ts";
import { concreteType } from "./schema_contract.ts";
import { semanticModuleFingerprint, structuralFingerprint } from "./semantic_fingerprint.ts";
import { surface } from "./surface_builder.ts";

const PROJECT_ENTRY_EXPORT = "$project$entry";
const MAXIMUM_CACHED_PROJECT_UNITS = 128;

export interface ProjectBatchCompiler {
  compileBatch(
    modules: readonly EncodedModule[],
    options?: CompilationOptions,
  ): Promise<readonly CpuCompileResult[]>;
  compileBatchForLinking?(
    modules: readonly EncodedModule[],
    options?: CompilationOptions,
  ): Promise<readonly CpuCompileResult[]>;
}

export interface CompiledValueInterface {
  readonly name: string;
  readonly definition: string;
  readonly type: TypeSchema;
  readonly effects: EffectSet;
}

export interface CompiledModuleInterface {
  readonly name: string;
  readonly values: readonly CompiledValueInterface[];
  readonly fingerprint: string;
}

export interface ProjectCompilationSchedule {
  readonly waves: readonly (readonly string[])[];
  readonly maximumWidth: number;
}

export type ProjectCompileResult =
  | {
    readonly ok: true;
    readonly module: CompiledModule;
    readonly interfaces: readonly CompiledModuleInterface[];
    readonly schedule: ProjectCompilationSchedule;
  }
  | {
    readonly ok: false;
    readonly failures: readonly {
      readonly module: string;
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    }[];
    readonly schedule: ProjectCompilationSchedule;
  };

interface CachedProjectUnit {
  readonly module: CompiledModule;
  readonly schemes: ReadonlyMap<string, TypeSchema>;
}

interface PreparedProjectUnit {
  readonly name: string;
  readonly encoded: EncodedModule;
  readonly fingerprint: string;
  readonly schemes: ReadonlyMap<string, TypeSchema>;
}

/** Compiles one import graph in dependency waves and links the resulting Core into one program. */
export class FunctionalProjectCompiler {
  readonly #compiler: ProjectBatchCompiler;
  readonly #cache = new Map<string, CachedProjectUnit>();

  constructor(compiler: ProjectBatchCompiler = new CpuCompiler()) {
    this.#compiler = compiler;
  }

  async compile(
    artifacts: readonly ModuleArtifact[],
    entry: { readonly module: string; readonly exportName: string },
    options: CompilationOptions = {},
  ): Promise<ProjectCompileResult> {
    validateCompilationOptions(options);
    options.signal?.throwIfAborted();
    const project = indexedProject(artifacts, entry);
    const schedule = dependencySchedule(project, entry.module);
    const interfacesFromDeclarations = declaredInterfaces(project, schedule);
    if (interfacesFromDeclarations.size > 0) {
      return await this.#compileProjectWithDeclaredInterfaces(
        project,
        entry,
        schedule,
        interfacesFromDeclarations,
        options,
      );
    }
    const interfaces = new Map<string, CompiledModuleInterface>();
    const compiledUnits = new Map<string, CompiledModule>();

    for (const [waveIndex, wave] of schedule.waves.entries()) {
      options.signal?.throwIfAborted();
      const prepared: PreparedProjectUnit[] = [];
      const failures: {
        readonly module: string;
        readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
      }[] = [];
      for (const name of wave) {
        const artifact = project.get(name)!;
        if (artifact.definitions.length === 0 && artifact.exports.length === 0) {
          interfaces.set(
            name,
            Object.freeze({
              name,
              values: Object.freeze([]),
              fingerprint: structuralFingerprint({
                values: [],
                typeDeclarations: artifact.typeDeclarations,
                typeExports: artifact.typeExports ?? [],
                constructorExports: artifact.constructorExports ?? [],
              }),
            }),
          );
          continue;
        }
        validateImportedEffects(artifact, interfaces);
        const encoded = measureCompilerStage(
          options.trace,
          "semantic.project-unit",
          { module: name, wave: waveIndex },
          () => buildProjectUnit(artifact, project, interfaces),
        );
        const inferred = projectUnitSchemes(encoded, artifact, options.trace);
        if (!inferred.ok) {
          failures.push({ module: name, diagnostics: inferred.diagnostics });
          continue;
        }
        prepared.push({
          name,
          encoded,
          fingerprint: projectUnitFingerprint(artifact, encoded, interfaces),
          schemes: inferred.schemes,
        });
      }
      if (failures.length > 0) return { ok: false, failures, schedule };

      const misses = prepared.filter((unit) => !this.#cache.has(unit.fingerprint));
      const compilations = misses.length === 0 ? [] : await measureCompilerStageAsync(
        options.trace,
        "semantic.project-wave",
        { wave: waveIndex, modules: wave.length, cacheMisses: misses.length },
        () => {
          const modules = misses.map((unit) => unit.encoded);
          return this.#compiler.compileBatchForLinking === undefined
            ? this.#compiler.compileBatch(modules, options)
            : this.#compiler.compileBatchForLinking(modules, options);
        },
      );
      if (compilations.length !== misses.length) {
        throw new Error(
          `functional project compiler received ${compilations.length} results for ${misses.length} modules in wave ${waveIndex}`,
        );
      }
      for (const [missIndex, compilation] of compilations.entries()) {
        const unit = misses[missIndex]!;
        if (!compilation.ok) {
          failures.push({ module: unit.name, diagnostics: compilation.diagnostics });
          continue;
        }
        let snapshot: CompiledModule;
        try {
          snapshot = await rebindCompiledModuleSource(compilation.module, unit.encoded);
        } finally {
          compilation.module.destroy();
        }
        this.#remember(unit.fingerprint, { module: snapshot, schemes: unit.schemes });
      }
      if (failures.length > 0) return { ok: false, failures, schedule };

      for (const unit of prepared) {
        const cached = this.#cache.get(unit.fingerprint);
        if (cached === undefined) {
          throw new Error(
            `functional project compiler omitted cached module ${JSON.stringify(unit.name)}`,
          );
        }
        this.#cache.delete(unit.fingerprint);
        this.#cache.set(unit.fingerprint, cached);
        const rebound = await rebindCompiledModuleSource(cached.module, unit.encoded);
        const artifact = project.get(unit.name)!;
        const moduleInterface = compiledInterface(artifact, rebound, cached.schemes);
        validateDeclaredExportEffects(artifact, moduleInterface);
        interfaces.set(unit.name, moduleInterface);
        compiledUnits.set(unit.name, rebound);
      }
    }

    return await linkProject(project, entry, schedule, interfaces, compiledUnits, options);
  }

  async #compileProjectWithDeclaredInterfaces(
    project: ReadonlyMap<string, ModuleArtifact>,
    entry: { readonly module: string; readonly exportName: string },
    schedule: ProjectCompilationSchedule,
    interfaces: Map<string, CompiledModuleInterface>,
    options: CompilationOptions,
  ): Promise<ProjectCompileResult> {
    const declaredNames = new Set(interfaces.keys());
    const compiledUnits = new Map<string, CompiledModule>();
    const pending = new Set(
      schedule.waves.flatMap((wave) =>
        wave.filter((name) => {
          const artifact = project.get(name)!;
          return !declaredNames.has(name) &&
            (artifact.definitions.length > 0 || artifact.exports.length > 0);
        })
      ),
    );
    let inferredWave = 0;
    while (pending.size > 0) {
      const ready = [...pending].filter((name) =>
        moduleDependencies(project.get(name)!).every((dependency) => interfaces.has(dependency))
      );
      if (ready.length === 0) {
        throw new Error(
          `functional project compiler cannot infer declared project dependencies ${
            JSON.stringify([...pending])
          }`,
        );
      }
      const prepared: PreparedProjectUnit[] = [];
      for (const name of ready) {
        const artifact = project.get(name)!;
        validateImportedEffects(artifact, interfaces);
        const encoded = measureCompilerStage(
          options.trace,
          "semantic.project-unit",
          { module: name, wave: inferredWave },
          () => buildProjectUnit(artifact, project, interfaces),
        );
        const inferred = projectUnitSchemes(encoded, artifact, options.trace);
        if (!inferred.ok) {
          destroyCompiledUnits(compiledUnits);
          return {
            ok: false,
            failures: [{ module: name, diagnostics: inferred.diagnostics }],
            schedule,
          };
        }
        prepared.push({
          name,
          encoded,
          fingerprint: projectUnitFingerprint(artifact, encoded, interfaces),
          schemes: inferred.schemes,
        });
      }
      const failures = await this.#compilePreparedUnits(
        prepared,
        project,
        interfaces,
        compiledUnits,
        options,
        "semantic.project-inferred-wave",
        { wave: inferredWave },
      );
      if (failures.length > 0) {
        destroyCompiledUnits(compiledUnits);
        return { ok: false, failures, schedule };
      }
      for (const name of ready) pending.delete(name);
      inferredWave += 1;
    }

    const declared: PreparedProjectUnit[] = [];
    for (const [waveIndex, wave] of schedule.waves.entries()) {
      for (const name of wave) {
        if (!declaredNames.has(name)) continue;
        const artifact = project.get(name)!;
        if (artifact.definitions.length === 0 && artifact.exports.length === 0) continue;
        validateImportedEffects(artifact, interfaces);
        const encoded = measureCompilerStage(
          options.trace,
          "semantic.project-unit",
          { module: name, wave: waveIndex },
          () => buildProjectUnit(artifact, project, interfaces),
        );
        const schemes = projectUnitSchemes(encoded, artifact, options.trace);
        if (!schemes.ok) {
          destroyCompiledUnits(compiledUnits);
          return {
            ok: false,
            failures: [{ module: name, diagnostics: schemes.diagnostics }],
            schedule,
          };
        }
        declared.push({
          name,
          encoded,
          fingerprint: projectUnitFingerprint(artifact, encoded, interfaces),
          schemes: schemes.schemes,
        });
      }
    }
    const failures = await this.#compilePreparedUnits(
      declared,
      project,
      interfaces,
      compiledUnits,
      options,
      "semantic.project-batch",
      {},
    );
    if (failures.length > 0) {
      destroyCompiledUnits(compiledUnits);
      return { ok: false, failures, schedule };
    }
    return await linkProject(project, entry, schedule, interfaces, compiledUnits, options);
  }

  async #compilePreparedUnits(
    prepared: readonly PreparedProjectUnit[],
    project: ReadonlyMap<string, ModuleArtifact>,
    interfaces: Map<string, CompiledModuleInterface>,
    compiledUnits: Map<string, CompiledModule>,
    options: CompilationOptions,
    stage: string,
    annotations: Readonly<Record<string, number>>,
  ): Promise<{
    readonly module: string;
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  }[]> {
    const misses = prepared.filter((unit) => !this.#cache.has(unit.fingerprint));
    const missedNames = new Set(misses.map((unit) => unit.name));
    for (const unit of prepared) {
      if (missedNames.has(unit.name)) continue;
      const cached = this.#cache.get(unit.fingerprint)!;
      this.#cache.delete(unit.fingerprint);
      this.#cache.set(unit.fingerprint, cached);
      const rebound = await rebindCompiledModuleSource(cached.module, unit.encoded);
      const artifact = project.get(unit.name)!;
      const moduleInterface = compiledInterface(artifact, rebound, cached.schemes);
      validateDeclaredExportEffects(artifact, moduleInterface);
      interfaces.set(unit.name, moduleInterface);
      compiledUnits.set(unit.name, rebound);
    }
    const compilations = misses.length === 0 ? [] : await measureCompilerStageAsync(
      options.trace,
      stage,
      { ...annotations, modules: prepared.length, cacheMisses: misses.length },
      () => {
        const modules = misses.map((unit) => unit.encoded);
        return this.#compiler.compileBatchForLinking === undefined
          ? this.#compiler.compileBatch(modules, options)
          : this.#compiler.compileBatchForLinking(modules, options);
      },
    );
    if (compilations.length !== misses.length) {
      throw new Error(
        `functional project compiler received ${compilations.length} results for ${misses.length} modules`,
      );
    }
    const failures: {
      readonly module: string;
      readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
    }[] = [];
    for (const [missIndex, compilation] of compilations.entries()) {
      const unit = misses[missIndex]!;
      if (!compilation.ok) {
        failures.push({ module: unit.name, diagnostics: compilation.diagnostics });
        continue;
      }
      let snapshot: CompiledModule;
      try {
        snapshot = await rebindCompiledModuleSource(compilation.module, unit.encoded);
      } finally {
        compilation.module.destroy();
      }
      this.#remember(unit.fingerprint, { module: snapshot, schemes: unit.schemes });
      const rebound = await rebindCompiledModuleSource(snapshot, unit.encoded);
      const artifact = project.get(unit.name)!;
      const moduleInterface = compiledInterface(artifact, rebound, unit.schemes);
      validateDeclaredExportEffects(artifact, moduleInterface);
      interfaces.set(unit.name, moduleInterface);
      compiledUnits.set(unit.name, rebound);
    }
    if (failures.length > 0) return failures;
    return failures;
  }

  clear(): void {
    for (const cached of this.#cache.values()) cached.module.destroy();
    this.#cache.clear();
  }

  #remember(fingerprint: string, unit: CachedProjectUnit): void {
    const previous = this.#cache.get(fingerprint);
    if (previous !== undefined && previous !== unit) previous.module.destroy();
    this.#cache.set(fingerprint, unit);
    while (this.#cache.size > MAXIMUM_CACHED_PROJECT_UNITS) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      const evicted = this.#cache.get(oldest);
      this.#cache.delete(oldest);
      evicted?.module.destroy();
    }
  }
}

function declaredInterfaces(
  project: ReadonlyMap<string, ModuleArtifact>,
  schedule: ProjectCompilationSchedule,
): Map<string, CompiledModuleInterface> {
  const interfaces = new Map<string, CompiledModuleInterface>();
  for (const wave of schedule.waves) {
    for (const name of wave) {
      const artifact = project.get(name)!;
      const values: CompiledValueInterface[] = [];
      for (const exported of artifact.exports) {
        if (exported.type === undefined || exported.effects === undefined) {
          values.length = 0;
          break;
        }
        values.push(Object.freeze({
          name: exported.name,
          definition: exported.definition,
          type: exported.type,
          effects: exported.effects,
        }));
      }
      if (values.length !== artifact.exports.length) continue;
      interfaces.set(
        name,
        Object.freeze({
          name,
          values: Object.freeze(values),
          fingerprint: moduleInterfaceFingerprint(artifact, values),
        }),
      );
    }
  }
  return interfaces;
}

async function linkProject(
  project: ReadonlyMap<string, ModuleArtifact>,
  entry: { readonly module: string; readonly exportName: string },
  schedule: ProjectCompilationSchedule,
  interfaces: ReadonlyMap<string, CompiledModuleInterface>,
  compiledUnits: ReadonlyMap<string, CompiledModule>,
  options: CompilationOptions,
): Promise<ProjectCompileResult> {
  const entryArtifact = project.get(entry.module)!;
  const exported = entryArtifact.exports.find((candidate) => candidate.name === entry.exportName);
  const entryInterface = interfaces.get(entry.module)?.values.find((candidate) =>
    candidate.name === entry.exportName
  );
  if (exported === undefined || entryInterface === undefined) {
    throw new Error(
      `functional project compiler omitted entry ${
        JSON.stringify(`${entry.module}.${entry.exportName}`)
      }`,
    );
  }
  const units: RelocatableCoreUnit[] = schedule.waves.flatMap((wave) =>
    wave.flatMap((name) => {
      const module = compiledUnits.get(name);
      if (module === undefined) return [];
      return [{
        name,
        module,
        sourceByteLength: project.get(name)!.sourceByteLength,
      }];
    })
  );
  let module: CompiledModule;
  try {
    module = await measureCompilerStageAsync(
      options.trace,
      "semantic.project-link-core",
      { modules: units.length },
      () =>
        linkRelocatableCore(units, {
          definition: qualified(entry.module, exported.definition),
          type: concreteInterfaceType(entryInterface.type, entry),
        }),
    );
  } finally {
    for (const unit of units) unit.module.destroy();
  }
  return {
    ok: true,
    module,
    interfaces: Object.freeze(
      schedule.waves.flatMap((wave) => wave.map((name) => interfaces.get(name)!)),
    ),
    schedule,
  };
}

function destroyCompiledUnits(units: Map<string, CompiledModule>): void {
  for (const module of units.values()) module.destroy();
  units.clear();
}

function projectUnitSchemes(
  module: EncodedModule,
  artifact: ModuleArtifact,
  trace: CompilerPerformanceTrace | undefined,
):
  | { readonly ok: true; readonly schemes: ReadonlyMap<string, TypeSchema> }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  } {
  if (artifact.exports.every((exported) => exported.type !== undefined)) {
    const schemes = new Map<string, TypeSchema>();
    for (const exported of artifact.exports) {
      const name = qualified(artifact.name, exported.definition);
      const type = exported.type;
      if (type === undefined) {
        throw new Error(
          `functional module ${JSON.stringify(artifact.name)} lost an explicit export type`,
        );
      }
      const previous = schemes.get(name);
      if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(type)) {
        throw new TypeError(
          `functional module ${JSON.stringify(artifact.name)} exports definition ${
            JSON.stringify(exported.definition)
          } with incompatible explicit types`,
        );
      }
      schemes.set(name, type);
    }
    return { ok: true, schemes };
  }
  const inferred = inferModuleDefinitionSchemes(module, trace);
  if (inferred.ok) {
    return {
      ok: true,
      schemes: new Map(
        inferred.definitions.map((definition) => [definition.name, definition.type]),
      ),
    };
  }
  if (
    module.typecheckingProfile === TypecheckingProfile.HindleyMilnerIndexed ||
    !inferred.diagnostics.some((diagnostic) =>
      diagnostic.message.includes("higher-rank forall schemas")
    )
  ) return inferred;

  const schemes = new Map<string, TypeSchema>();
  for (const exported of artifact.exports) {
    const name = qualified(artifact.name, exported.definition);
    const definitionIndex = encodedDefinitionIndex(module, name);
    const annotation = definitionIndex < 0
      ? undefined
      : module.definitionTypes[definitionIndex]?.annotation;
    if (annotation === undefined || annotation === null) {
      throw new TypeError(
        `functional project rank-N export ${
          JSON.stringify(`${artifact.name}.${exported.name}`)
        } requires an explicit type`,
      );
    }
    schemes.set(name, annotation);
  }
  return { ok: true, schemes };
}

function encodedDefinitionIndex(module: EncodedModule, name: string): number {
  for (let definitionIndex = 0; definitionIndex < module.definitionCount; definitionIndex++) {
    const symbol = module.definitionWords[
      definitionIndex * DEFINITION_WORD_LENGTH + DefinitionWord.Symbol
    ];
    if (symbol !== undefined && module.symbolNames[symbol] === name) return definitionIndex;
  }
  return -1;
}

function indexedProject(
  artifacts: readonly ModuleArtifact[],
  entry: { readonly module: string; readonly exportName: string },
): ReadonlyMap<string, ModuleArtifact> {
  if (artifacts.length === 0) {
    throw new LinkError({
      code: "F4001",
      kind: "invalid-artifact",
      message: "functional project compiler requires at least one module",
    });
  }
  const project = new Map<string, ModuleArtifact>();
  for (const candidate of artifacts) {
    const artifact = createModuleArtifact(candidate);
    if (project.has(artifact.name)) {
      throw new LinkError({
        code: "F4002",
        kind: "duplicate-module",
        module: artifact.name,
        message: `functional project compiler repeats module ${JSON.stringify(artifact.name)}`,
      });
    }
    project.set(artifact.name, artifact);
  }
  const entryArtifact = project.get(entry.module);
  if (entryArtifact?.exports.some((candidate) => candidate.name === entry.exportName) !== true) {
    throw new LinkError({
      code: "F4006",
      kind: "missing-entry",
      module: entry.module,
      reference: entry.exportName,
      message: `functional project compiler entry references missing export ${
        JSON.stringify(`${entry.module}.${entry.exportName}`)
      }`,
    });
  }
  return project;
}

function dependencySchedule(
  project: ReadonlyMap<string, ModuleArtifact>,
  entryModule: string,
): ProjectCompilationSchedule {
  const reachable = new Set<string>();
  const visiting: string[] = [];
  const visit = (name: string): void => {
    if (reachable.has(name)) return;
    const cycle = visiting.indexOf(name);
    if (cycle >= 0) {
      throw new LinkError({
        code: "F4001",
        kind: "invalid-artifact",
        module: name,
        message: `functional project import cycle ${[...visiting.slice(cycle), name].join(" -> ")}`,
      });
    }
    const artifact = project.get(name);
    if (artifact === undefined) {
      const importer = visiting.at(-1);
      throw new LinkError({
        code: "F4003",
        kind: "missing-import",
        module: importer ?? "<entry>",
        reference: name,
        message: `functional module ${JSON.stringify(importer)} imports missing module ${
          JSON.stringify(name)
        }`,
      });
    }
    visiting.push(name);
    for (const dependency of moduleDependencies(artifact)) visit(dependency);
    visiting.pop();
    reachable.add(name);
  };
  visit(entryModule);

  const completed = new Set<string>();
  const waves: string[][] = [];
  while (completed.size < reachable.size) {
    const wave = [...reachable].filter((name) => {
      if (completed.has(name)) return false;
      return moduleDependencies(project.get(name)!).every((dependency) =>
        completed.has(dependency)
      );
    }).sort();
    if (wave.length === 0) {
      throw new Error("functional project scheduler could not advance an acyclic import graph");
    }
    waves.push(wave);
    for (const name of wave) completed.add(name);
  }
  return Object.freeze({
    waves: Object.freeze(waves.map((wave) => Object.freeze(wave))),
    maximumWidth: Math.max(...waves.map((wave) => wave.length)),
  });
}

function moduleDependencies(artifact: ModuleArtifact): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...artifact.imports.map((imported) => imported.fromModule),
      ...(artifact.typeImports ?? []).map((imported) => imported.fromModule),
      ...(artifact.constructorImports ?? []).map((imported) => imported.fromModule),
    ]),
  ]);
}

function projectUnitFingerprint(
  artifact: ModuleArtifact,
  module: EncodedModule,
  interfaces: ReadonlyMap<string, CompiledModuleInterface>,
): string {
  return structuralFingerprint({
    body: semanticModuleFingerprint(module),
    imports: [...moduleDependencies(artifact)].sort().map((name) => {
      const moduleInterface = interfaces.get(name);
      if (moduleInterface === undefined) {
        throw new Error(
          `functional project compiler omitted interface fingerprint for ${JSON.stringify(name)}`,
        );
      }
      return [name, moduleInterface.fingerprint];
    }),
  });
}

function buildProjectUnit(
  artifact: ModuleArtifact,
  project: ReadonlyMap<string, ModuleArtifact>,
  interfaces: ReadonlyMap<string, CompiledModuleInterface>,
): EncodedModule {
  const declaredTypes = new Map<string, TypeSchema>();
  for (const exported of artifact.exports) {
    if (exported.type === undefined) continue;
    const previous = declaredTypes.get(exported.definition);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(exported.type)) {
      throw new TypeError(
        `functional module ${JSON.stringify(artifact.name)} exports definition ${
          JSON.stringify(exported.definition)
        } with incompatible explicit types`,
      );
    }
    declaredTypes.set(exported.definition, exported.type);
  }
  const definitions = artifact.definitions.map((definition) => {
    const declared = declaredTypes.get(definition.name);
    if (declared === undefined) return definition;
    if (
      definition.annotation !== null &&
      JSON.stringify(definition.annotation) !== JSON.stringify(declared)
    ) {
      throw new TypeError(
        `functional module ${JSON.stringify(artifact.name)} definition ${
          JSON.stringify(definition.name)
        } conflicts with its exported type`,
      );
    }
    return definition.annotation === null ? { ...definition, annotation: declared } : definition;
  });
  const reservedNames = new Set([
    ...definitions.map((definition) => definition.name),
    ...artifact.exports.map((exported) => exported.name),
  ]);
  const syntheticDefinition = takeAvailableSyntheticName(reservedNames, PROJECT_ENTRY_EXPORT);
  const syntheticExport = takeAvailableSyntheticName(reservedNames, PROJECT_ENTRY_EXPORT);
  let body = surface.integer(0);
  for (let index = definitions.length - 1; index >= 0; index--) {
    const definition = definitions[index]!;
    const binder = takeAvailableSyntheticName(reservedNames, `$project$keep${index}`);
    body = surface.let(binder, surface.name(definition.name), body);
  }
  const target: ModuleArtifact = {
    ...artifact,
    imports: artifact.imports.map((imported) => {
      const target = interfaces.get(imported.fromModule)?.values.find((value) =>
        value.name === imported.exportName
      );
      if (target === undefined) {
        throw new Error(
          `functional project compiler omitted imported interface ${
            JSON.stringify(`${imported.fromModule}.${imported.exportName}`)
          } for module ${JSON.stringify(artifact.name)}`,
        );
      }
      return {
        ...imported,
        type: imported.type ?? target.type,
        effects: imported.effects ?? target.effects,
      };
    }),
    definitions: [...definitions, {
      name: syntheticDefinition,
      parameters: [],
      annotation: { kind: "integer" },
      body,
    }],
    exports: [...artifact.exports, {
      name: syntheticExport,
      definition: syntheticDefinition,
      type: { kind: "integer" },
    }],
  };

  const dependencies = dependencyClosure(artifact, project);
  const interfaceArtifacts = dependencies.map((name) => {
    const source = project.get(name)!;
    const moduleInterface = interfaces.get(name);
    if (moduleInterface === undefined) {
      throw new Error(
        `functional project compiler module ${
          JSON.stringify(artifact.name)
        } has no interface for dependency ${JSON.stringify(name)}`,
      );
    }
    return interfaceArtifact(source, moduleInterface);
  });
  return linkModules(
    [target, ...interfaceArtifacts],
    { module: artifact.name, exportName: syntheticExport },
  ).module;
}

function dependencyClosure(
  artifact: ModuleArtifact,
  project: ReadonlyMap<string, ModuleArtifact>,
): readonly string[] {
  const found = new Set<string>();
  const pending = [...moduleDependencies(artifact)];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (found.has(name)) continue;
    found.add(name);
    const dependency = project.get(name);
    if (dependency === undefined) continue;
    pending.push(...moduleDependencies(dependency));
  }
  return Object.freeze([...found].sort());
}

function interfaceArtifact(
  source: ModuleArtifact,
  moduleInterface: CompiledModuleInterface,
): ModuleArtifact {
  const valuesByDefinition = new Map(
    moduleInterface.values.map((value) => [value.definition, value]),
  );
  return {
    name: source.name,
    definitions: [...new Set(source.exports.map((exported) => exported.definition))].map(
      (definition) => {
        const value = valuesByDefinition.get(definition);
        const exported = source.exports.find((candidate) => candidate.definition === definition);
        if (value === undefined || exported === undefined) {
          throw new Error(
            `functional project interface ${
              JSON.stringify(source.name)
            } omitted export definition ${JSON.stringify(definition)}`,
          );
        }
        return {
          name: definition,
          parameters: [],
          annotation: value.type,
          effects: value.effects,
          body: surface.unreachable(
            `unlinked project import ${source.name}.${exported.name}`,
          ),
        };
      },
    ),
    typeDeclarations: source.typeDeclarations,
    imports: source.imports,
    exports: source.exports.map((exported) => {
      const value = valuesByDefinition.get(exported.definition)!;
      return { ...exported, type: value.type, effects: value.effects };
    }),
    ...(source.typeImports === undefined ? {} : { typeImports: source.typeImports }),
    ...(source.constructorImports === undefined
      ? {}
      : { constructorImports: source.constructorImports }),
    ...(source.typeExports === undefined ? {} : { typeExports: source.typeExports }),
    ...(source.constructorExports === undefined
      ? {}
      : { constructorExports: source.constructorExports }),
    sourceByteLength: 0,
    options: {},
  };
}

function compiledInterface(
  artifact: ModuleArtifact,
  module: CompiledModule,
  schemes: ReadonlyMap<string, TypeSchema>,
): CompiledModuleInterface {
  const values = artifact.exports.map((exported): CompiledValueInterface => {
    const definition = qualified(artifact.name, exported.definition);
    const definitionIndex = module.definitionNames.indexOf(definition);
    const type = schemes.get(definition);
    const effects = definitionIndex < 0 ? undefined : module.definitionEffects[definitionIndex];
    if (definitionIndex < 0 || type === undefined || effects === undefined) {
      throw new Error(
        `functional project compiler omitted interface definition ${JSON.stringify(definition)}`,
      );
    }
    return Object.freeze({
      name: exported.name,
      definition: exported.definition,
      type,
      effects,
    });
  });
  const fingerprint = moduleInterfaceFingerprint(artifact, values);
  return Object.freeze({
    name: artifact.name,
    values: Object.freeze(values),
    fingerprint,
  });
}

function moduleInterfaceFingerprint(
  artifact: ModuleArtifact,
  values: readonly CompiledValueInterface[],
): string {
  return structuralFingerprint({
    values: values.map((value) => ({ ...value, effects: effectNames(value.effects) })),
    typeDeclarations: artifact.typeDeclarations,
    typeExports: artifact.typeExports ?? [],
    constructorExports: artifact.constructorExports ?? [],
  });
}

function validateImportedEffects(
  artifact: ModuleArtifact,
  interfaces: ReadonlyMap<string, CompiledModuleInterface>,
): void {
  for (const imported of artifact.imports) {
    if (imported.effects === undefined) continue;
    const target = interfaces.get(imported.fromModule)?.values.find((value) =>
      value.name === imported.exportName
    );
    if (target === undefined || !sameEffects(imported.effects, target.effects)) {
      throw new TypeError(
        `functional module ${JSON.stringify(artifact.name)} import ${
          JSON.stringify(imported.name)
        } declares effects ${JSON.stringify(effectNames(imported.effects))}; ${
          JSON.stringify(`${imported.fromModule}.${imported.exportName}`)
        } exposes ${JSON.stringify(target === undefined ? [] : effectNames(target.effects))}`,
      );
    }
  }
}

function validateDeclaredExportEffects(
  artifact: ModuleArtifact,
  moduleInterface: CompiledModuleInterface,
): void {
  for (const exported of artifact.exports) {
    if (exported.effects === undefined) continue;
    const inferred = moduleInterface.values.find((value) => value.name === exported.name);
    if (inferred !== undefined && sameEffects(exported.effects, inferred.effects)) continue;
    throw new TypeError(
      `functional module ${JSON.stringify(artifact.name)} export ${
        JSON.stringify(exported.name)
      } declares effects ${JSON.stringify(effectNames(exported.effects))}; inferred ${
        JSON.stringify(inferred === undefined ? [] : effectNames(inferred.effects))
      }`,
    );
  }
}

function sameEffects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((effect) => right.has(effect));
}

function concreteInterfaceType(
  schema: TypeSchema,
  entry: { readonly module: string; readonly exportName: string },
) {
  if (schema.kind === "forall") {
    throw new TypeError(
      `functional project entry ${
        JSON.stringify(`${entry.module}.${entry.exportName}`)
      } must have a concrete type; inferred quantified parameters ${
        JSON.stringify(schema.parameters)
      }`,
    );
  }
  return concreteType(schema);
}

function takeAvailableSyntheticName(names: Set<string>, base: string): string {
  let name = base;
  let suffix = 0;
  while (names.has(name)) name = `${base}${++suffix}`;
  names.add(name);
  return name;
}

function qualified(module: string, definition: string): string {
  return `${module}::${definition}`;
}
