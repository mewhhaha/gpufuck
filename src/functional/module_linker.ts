import type { EncodedModule, SourceRange, Span, TypeSchema } from "./abi.ts";
import type { HostCapabilityDeclaration, SurfaceModuleOptions } from "./host_contract.ts";
import { INIT_CONSTRUCTOR_NAME } from "./host_contract.ts";
import { type EffectSet, effectSetFrom } from "./effect_set.ts";
import {
  buildSurfaceModule,
  type SurfaceCaseArm,
  type SurfaceCaseDefault,
  type SurfaceDefinition,
  type SurfaceExpression,
  type SurfaceTypeDeclaration,
} from "./surface_builder.ts";
import {
  type CompilerPerformanceTrace,
  measureCompilerStage,
} from "../compiler_performance_trace.ts";

export type LinkDiagnosticCode =
  | "F4001"
  | "F4002"
  | "F4003"
  | "F4004"
  | "F4005"
  | "F4006"
  | "F4007";

export type LinkFaultKind =
  | "invalid-artifact"
  | "duplicate-module"
  | "missing-import"
  | "incompatible-profile"
  | "incompatible-capability"
  | "missing-entry"
  | "duplicate-export";

export interface LinkErrorDetails {
  readonly code: LinkDiagnosticCode;
  readonly kind: LinkFaultKind;
  readonly message: string;
  readonly module?: string;
  readonly reference?: string;
}

export class LinkError extends Error {
  readonly code: LinkDiagnosticCode;
  readonly kind: LinkFaultKind;
  readonly module: string | undefined;
  readonly reference: string | undefined;

  constructor(details: LinkErrorDetails, cause?: unknown) {
    super(`${details.code}: ${details.message}`, { cause });
    this.name = "LinkError";
    this.code = details.code;
    this.kind = details.kind;
    this.module = details.module;
    this.reference = details.reference;
  }
}

export interface ModuleImport {
  readonly name: string;
  readonly fromModule: string;
  readonly exportName: string;
  readonly type?: TypeSchema;
  readonly effects?: EffectSet;
}

export interface ModuleExport {
  readonly name: string;
  readonly definition: string;
  readonly type?: TypeSchema;
  readonly effects?: EffectSet;
}

export interface ModuleTypeImport {
  readonly name: string;
  readonly fromModule: string;
  readonly exportName: string;
}

export interface ModuleConstructorImport {
  readonly name: string;
  readonly fromModule: string;
  readonly exportName: string;
}

export interface ModuleTypeExport {
  readonly name: string;
  readonly declaration: string;
}

export interface ModuleConstructorExport {
  readonly name: string;
  readonly constructor: string;
}

export interface ModuleArtifact {
  readonly name: string;
  readonly definitions: readonly SurfaceDefinition[];
  readonly typeDeclarations: readonly SurfaceTypeDeclaration[];
  readonly imports: readonly ModuleImport[];
  readonly exports: readonly ModuleExport[];
  readonly typeImports?: readonly ModuleTypeImport[];
  readonly constructorImports?: readonly ModuleConstructorImport[];
  readonly typeExports?: readonly ModuleTypeExport[];
  readonly constructorExports?: readonly ModuleConstructorExport[];
  readonly sourceByteLength: number;
  readonly options: SurfaceModuleOptions;
}

const snapshottedModules = new WeakSet<ModuleArtifact>();

export type LinkedSource = SourceRange;

export interface LinkedModule {
  readonly module: EncodedModule;
  readonly sources: readonly LinkedSource[];
}

export interface ModuleLinkOptions {
  readonly trace?: CompilerPerformanceTrace;
}

export function createModuleArtifact(
  artifact: ModuleArtifact,
): ModuleArtifact {
  validateModuleArtifact(artifact);
  let snapshot: ModuleArtifact;
  try {
    const cloneableArtifact = {
      ...artifact,
      definitions: artifact.definitions.map((definition) =>
        definition.effects === undefined
          ? definition
          : { ...definition, effects: [...definition.effects] }
      ),
      imports: artifact.imports.map((imported) =>
        imported.effects === undefined ? imported : { ...imported, effects: [...imported.effects] }
      ),
      exports: artifact.exports.map((exported) =>
        exported.effects === undefined ? exported : { ...exported, effects: [...exported.effects] }
      ),
      options: {
        ...artifact.options,
        ...(artifact.options.hostCapabilities === undefined ? {} : {
          hostCapabilities: artifact.options.hostCapabilities.map((capability) => ({
            ...capability,
            fields: capability.fields.map((field) =>
              field.kind === "operation" ? { ...field, effects: [...field.effects] } : field
            ),
          })),
        }),
      },
    };
    snapshot = structuredClone(cloneableArtifact) as ModuleArtifact;
  } catch (cause) {
    throw new LinkError({
      code: "F4001",
      kind: "invalid-artifact",
      module: artifact.name,
      message: `functional module ${
        JSON.stringify(artifact.name)
      } contains metadata that cannot be snapshotted: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    }, cause);
  }
  for (const definition of snapshot.definitions) {
    if (definition.effects === undefined) continue;
    Object.defineProperty(definition, "effects", {
      value: effectSetFrom(definition.effects),
    });
  }
  for (const imported of snapshot.imports) {
    if (imported.effects === undefined) continue;
    Object.defineProperty(imported, "effects", {
      value: effectSetFrom(imported.effects),
    });
  }
  for (const exported of snapshot.exports) {
    if (exported.effects === undefined) continue;
    Object.defineProperty(exported, "effects", {
      value: effectSetFrom(exported.effects),
    });
  }
  for (const capability of snapshot.options.hostCapabilities ?? []) {
    for (const field of capability.fields) {
      if (field.kind !== "operation") continue;
      Object.defineProperty(field, "effects", {
        value: effectSetFrom(field.effects),
      });
    }
  }
  return freezeModuleArtifact(snapshot);
}

/**
 * Accepts ownership of a freshly built artifact, avoiding the defensive copy required at the
 * public linker boundary.
 */
export function createOwnedModuleArtifact(
  artifact: ModuleArtifact,
): ModuleArtifact {
  validateModuleArtifact(artifact);
  return freezeModuleArtifact(artifact);
}

function validateModuleArtifact(artifact: ModuleArtifact): void {
  requireModuleName(artifact.name, "module name");
  if (!Number.isSafeInteger(artifact.sourceByteLength) || artifact.sourceByteLength < 0) {
    throw invalidArtifact(
      artifact.name,
      `functional module ${
        JSON.stringify(artifact.name)
      } sourceByteLength must be non-negative; received ${artifact.sourceByteLength}`,
    );
  }
  const importNames = new Set<string>();
  for (const imported of artifact.imports) {
    requireModuleName(imported.name, `module ${JSON.stringify(artifact.name)} import name`);
    requireModuleName(imported.fromModule, `import ${JSON.stringify(imported.name)} source module`);
    requireModuleName(imported.exportName, `import ${JSON.stringify(imported.name)} export name`);
    requireEffectSet(
      artifact.name,
      `import ${JSON.stringify(imported.name)}`,
      imported.effects,
    );
    if (importNames.has(imported.name)) {
      throw invalidArtifact(
        artifact.name,
        `functional module ${JSON.stringify(artifact.name)} repeats import ${
          JSON.stringify(imported.name)
        }`,
      );
    }
    importNames.add(imported.name);
  }
  const typeNames = new Set(artifact.typeDeclarations.map((declaration) => declaration.name));
  validateNominalImports(artifact.name, "type", artifact.typeImports ?? [], typeNames);
  const constructorNames = new Set(
    artifact.typeDeclarations.flatMap((declaration) =>
      declaration.constructors.map((constructor) => constructor.name)
    ),
  );
  validateNominalImports(
    artifact.name,
    "constructor",
    artifact.constructorImports ?? [],
    constructorNames,
  );
  const definitionNames = new Set(artifact.definitions.map((definition) => definition.name));
  for (const imported of artifact.imports) {
    if (definitionNames.has(imported.name)) {
      throw invalidArtifact(
        artifact.name,
        `functional module ${JSON.stringify(artifact.name)} import ${
          JSON.stringify(imported.name)
        } conflicts with a definition`,
      );
    }
  }
  const exportNames = new Set<string>();
  for (const exported of artifact.exports) {
    requireModuleName(exported.name, `module ${JSON.stringify(artifact.name)} export name`);
    requireEffectSet(
      artifact.name,
      `export ${JSON.stringify(exported.name)}`,
      exported.effects,
    );
    if (!definitionNames.has(exported.definition)) {
      throw invalidArtifact(
        artifact.name,
        `functional module ${JSON.stringify(artifact.name)} export ${
          JSON.stringify(exported.name)
        } references unknown definition ${JSON.stringify(exported.definition)}`,
      );
    }
    if (exportNames.has(exported.name)) {
      throw new LinkError({
        code: "F4007",
        kind: "duplicate-export",
        module: artifact.name,
        reference: exported.name,
        message: `functional module ${JSON.stringify(artifact.name)} repeats export ${
          JSON.stringify(exported.name)
        }`,
      });
    }
    exportNames.add(exported.name);
  }
  validateNominalExports(
    artifact.name,
    "type",
    artifact.typeExports ?? [],
    typeNames,
    (exported) => exported.declaration,
  );
  validateNominalExports(
    artifact.name,
    "constructor",
    artifact.constructorExports ?? [],
    constructorNames,
    (exported) => exported.constructor,
  );
}

function freezeModuleArtifact(artifact: ModuleArtifact): ModuleArtifact {
  const pendingObjects: object[] = [artifact];
  const frozenObjects = new Set<object>();
  while (pendingObjects.length > 0) {
    const current = pendingObjects.pop()!;
    if (frozenObjects.has(current)) continue;
    frozenObjects.add(current);
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") pendingObjects.push(child);
    }
    if (!ArrayBuffer.isView(current)) Object.freeze(current);
  }
  snapshottedModules.add(artifact);
  return artifact;
}

export function linkModules(
  artifacts: readonly ModuleArtifact[],
  entry: { readonly module: string; readonly exportName: string },
  options: ModuleLinkOptions = {},
): LinkedModule {
  if (artifacts.length === 0) {
    throw new LinkError({
      code: "F4001",
      kind: "invalid-artifact",
      message: "functional module linker requires at least one module",
    });
  }
  const indexAnnotations = { modules: artifacts.length, exports: 0 };
  const indexSpan = options.trace?.start("frontend.link.index");
  const modules = new Map<string, ModuleArtifact>();
  for (const candidate of artifacts) {
    const artifact = snapshottedModules.has(candidate)
      ? candidate
      : createModuleArtifact(candidate);
    if (modules.has(artifact.name)) {
      throw new LinkError({
        code: "F4002",
        kind: "duplicate-module",
        module: artifact.name,
        message: `functional module linker repeats module ${JSON.stringify(artifact.name)}`,
      });
    }
    modules.set(artifact.name, artifact);
  }
  const exportedDefinitions = new Map<string, string>();
  const exportedTypes = new Map<string, string>();
  const exportedConstructors = new Map<string, string>();
  for (const artifact of modules.values()) {
    for (const exported of artifact.exports) {
      exportedDefinitions.set(
        exportKey(artifact.name, exported.name),
        qualified(artifact.name, exported.definition),
      );
    }
    for (const exported of artifact.typeExports ?? []) {
      exportedTypes.set(
        exportKey(artifact.name, exported.name),
        qualified(artifact.name, exported.declaration),
      );
    }
    for (const exported of artifact.constructorExports ?? []) {
      exportedConstructors.set(
        exportKey(artifact.name, exported.name),
        qualified(artifact.name, exported.constructor),
      );
    }
  }
  indexAnnotations.exports = exportedDefinitions.size + exportedTypes.size +
    exportedConstructors.size;
  indexSpan?.finish(indexAnnotations);
  const reachabilityAnnotations = { modules: modules.size, definitions: 0 };
  const artifactReachability = measureCompilerStage(
    options.trace,
    "frontend.link.reachability",
    reachabilityAnnotations,
    () =>
      artifactDefinitionReachability(
        modules,
        exportedDefinitions,
        entry,
      ),
    (reachability) => {
      reachabilityAnnotations.definitions = reachability.definitionNames.size;
    },
  );
  const linkedDefinitions: SurfaceDefinition[] = [];
  const linkedTypes: SurfaceTypeDeclaration[] = [];
  const sources: LinkedSource[] = [];
  const capabilities: HostCapabilityDeclaration[] = [];
  const linkedWasmExports: { readonly name: string; readonly definition: string }[] = [];
  const linkedHostDefinitions: {
    readonly definition: string;
    readonly capability: string;
    readonly field: string;
  }[] = [];
  const linkedWasmExportNames = new Set<string>();
  let sourceBase = 0;
  const rewriteSpan = options.trace?.start("frontend.link.rewrite");
  for (const artifact of modules.values()) {
    sources.push({
      module: artifact.name,
      startByte: sourceBase,
      endByte: sourceBase + artifact.sourceByteLength,
    });
    const definitionNames = new Map(
      artifact.definitions.map((
        definition,
      ) => [definition.name, qualified(artifact.name, definition.name)]),
    );
    for (const binding of artifact.options.hostDefinitions ?? []) {
      const definition = definitionNames.get(binding.definition);
      if (definition === undefined) {
        throw invalidArtifact(
          artifact.name,
          `functional module ${
            JSON.stringify(artifact.name)
          } host definition references unknown definition ${JSON.stringify(binding.definition)}`,
        );
      }
      linkedHostDefinitions.push({ ...binding, definition });
    }
    for (const exported of artifact.options.wasmExports ?? []) {
      const definition = definitionNames.get(exported.definition);
      if (definition === undefined) {
        throw invalidArtifact(
          artifact.name,
          `functional module ${JSON.stringify(artifact.name)} WASM export ${
            JSON.stringify(exported.name)
          } references unknown definition ${JSON.stringify(exported.definition)}`,
        );
      }
      if (linkedWasmExportNames.has(exported.name)) {
        throw new LinkError({
          code: "F4007",
          kind: "duplicate-export",
          module: artifact.name,
          reference: exported.name,
          message: `linked functional modules repeat WASM export ${JSON.stringify(exported.name)}`,
        });
      }
      linkedWasmExportNames.add(exported.name);
      linkedWasmExports.push({ name: exported.name, definition });
    }
    const localTypeNames = new Map(
      artifact.typeDeclarations.map((
        declaration,
      ) => [declaration.name, qualified(artifact.name, declaration.name)]),
    );
    const availableTypeNames = new Map(localTypeNames);
    for (const imported of artifact.imports) {
      const source = modules.get(imported.fromModule);
      if (source === undefined) continue;
      for (const declaration of source.typeDeclarations) {
        if (!availableTypeNames.has(declaration.name)) {
          availableTypeNames.set(
            declaration.name,
            qualified(source.name, declaration.name),
          );
        }
      }
    }
    for (const imported of artifact.typeImports ?? []) {
      const target = exportedTypes.get(exportKey(imported.fromModule, imported.exportName));
      if (target === undefined) {
        throw missingNominalImport(artifact.name, "type", imported);
      }
      availableTypeNames.set(imported.name, target);
    }
    const constructorNames = new Map<string, string>();
    for (const declaration of artifact.typeDeclarations) {
      for (const constructor of declaration.constructors) {
        constructorNames.set(constructor.name, qualified(artifact.name, constructor.name));
      }
    }
    for (const imported of artifact.constructorImports ?? []) {
      const target = exportedConstructors.get(exportKey(imported.fromModule, imported.exportName));
      if (target === undefined) {
        throw missingNominalImport(artifact.name, "constructor", imported);
      }
      constructorNames.set(imported.name, target);
    }
    const importNames = new Map<string, string>();
    for (const imported of artifact.imports) {
      const target = exportedDefinitions.get(exportKey(imported.fromModule, imported.exportName));
      if (target === undefined) {
        throw new LinkError({
          code: "F4003",
          kind: "missing-import",
          module: artifact.name,
          reference: `${imported.fromModule}.${imported.exportName}`,
          message: `functional module ${JSON.stringify(artifact.name)} import ${
            JSON.stringify(imported.name)
          } references missing export ${
            JSON.stringify(`${imported.fromModule}.${imported.exportName}`)
          }`,
        });
      }
      const alias = qualified(artifact.name, `$import$${imported.name}`);
      importNames.set(imported.name, alias);
      const annotation = imported.type === undefined
        ? null
        : rewriteSchema(imported.type, availableTypeNames);
      if (!artifactReachability.definitionNames.has(alias)) continue;
      linkedDefinitions.push({
        name: alias,
        parameters: [],
        annotation,
        ...(imported.effects === undefined ? {} : { effects: imported.effects }),
        body: { kind: "name", name: target, span: offsetSpan(undefined, sourceBase) },
        span: offsetSpan(undefined, sourceBase),
      });
    }
    const exportTypes = new Map(
      artifact.exports.flatMap((exported) =>
        exported.type === undefined ? [] : [[exported.definition, exported.type] as const]
      ),
    );
    for (const definition of artifact.definitions) {
      const annotation = rewriteSchema(
        exportTypes.get(definition.name) ?? definition.annotation,
        availableTypeNames,
      );
      const name = definitionNames.get(definition.name)!;
      if (!artifactReachability.definitionNames.has(name)) continue;
      linkedDefinitions.push({
        ...definition,
        name,
        annotation,
        body: rewriteExpression(
          definition.body,
          new Map(definition.parameters.map((parameter) => [parameter, 1])),
          definitionNames,
          importNames,
          constructorNames,
          sourceBase,
        ),
        span: offsetSpan(definition.span, sourceBase),
      });
    }
    for (const declaration of artifact.typeDeclarations) {
      linkedTypes.push({
        ...declaration,
        name: localTypeNames.get(declaration.name)!,
        span: offsetSpan(declaration.span, sourceBase),
        constructors: declaration.constructors.map((constructor) => ({
          ...constructor,
          name: constructorNames.get(constructor.name)!,
          span: offsetSpan(constructor.span, sourceBase),
          fields: constructor.fields.map((field) => ({
            ...field,
            type: rewriteSchema(field.type, availableTypeNames)!,
            span: offsetSpan(field.span, sourceBase),
          })),
          ...(constructor.result === undefined
            ? {}
            : { result: rewriteSchema(constructor.result, availableTypeNames)! }),
        })),
      });
    }
    for (const capability of artifact.options.hostCapabilities ?? []) {
      const linkedCapability: HostCapabilityDeclaration = {
        name: capability.name,
        fields: capability.fields.map((field) =>
          field.kind === "value"
            ? {
              ...field,
              type: rewriteSchema(field.type, availableTypeNames)!,
              ...(field.representation === undefined ? {} : {
                representation: rewriteSchema(field.representation, availableTypeNames)!,
              }),
            }
            : {
              ...field,
              parameter: rewriteSchema(field.parameter, availableTypeNames)!,
              result: rewriteSchema(field.result, availableTypeNames)!,
              ...(field.parameterRepresentation === undefined ? {} : {
                parameterRepresentation: rewriteSchema(
                  field.parameterRepresentation,
                  availableTypeNames,
                )!,
              }),
              ...(field.resultRepresentation === undefined ? {} : {
                resultRepresentation: rewriteSchema(
                  field.resultRepresentation,
                  availableTypeNames,
                )!,
              }),
            }
        ),
      };
      const existingIndex = capabilities.findIndex((candidate) =>
        candidate.name === linkedCapability.name
      );
      if (existingIndex < 0) {
        capabilities.push(linkedCapability);
        continue;
      }
      const existing = capabilities[existingIndex]!;
      const fields = [...existing.fields];
      for (const field of linkedCapability.fields) {
        const previous = fields.find((candidate) => candidate.name === field.name);
        if (previous === undefined) {
          fields.push(field);
          continue;
        }
        if (sameHostField(previous, field)) continue;
        throw new LinkError({
          code: "F4005",
          kind: "incompatible-capability",
          module: artifact.name,
          reference: linkedCapability.name,
          message: `functional modules declare incompatible host field ${
            JSON.stringify(`${linkedCapability.name}.${field.name}`)
          }`,
        });
      }
      capabilities[existingIndex] = { name: existing.name, fields };
    }
    sourceBase += artifact.sourceByteLength;
  }
  rewriteSpan?.finish({ modules: modules.size });
  const entryDefinition = exportedDefinitions.get(exportKey(entry.module, entry.exportName));
  if (entryDefinition === undefined) {
    throw new LinkError({
      code: "F4006",
      kind: "missing-entry",
      module: entry.module,
      reference: entry.exportName,
      message: `functional module linker entry references missing export ${
        JSON.stringify(`${entry.module}.${entry.exportName}`)
      }`,
    });
  }
  const reachableHostDefinitions = linkedHostDefinitions.filter((binding) =>
    artifactReachability.definitionNames.has(binding.definition)
  );
  const reachableHostFields = new Map<string, Set<string>>();
  for (const binding of reachableHostDefinitions) {
    const fields = reachableHostFields.get(binding.capability) ?? new Set<string>();
    fields.add(binding.field);
    reachableHostFields.set(binding.capability, fields);
  }
  const reachableCapabilities = artifactReachability.referencedSymbols.has(INIT_CONSTRUCTOR_NAME)
    ? capabilities
    : capabilities.flatMap((capability) => {
      const fields = reachableHostFields.get(capability.name);
      if (fields === undefined) return [];
      return [{
        name: capability.name,
        fields: capability.fields.filter((field) => fields.has(field.name)),
      }];
    });
  const module = measureCompilerStage(
    options.trace,
    "frontend.link.pack",
    {
      definitions: linkedDefinitions.length,
      types: linkedTypes.length,
      sourceBytes: sourceBase,
    },
    () =>
      buildSurfaceModule(
        linkedDefinitions,
        linkedTypes,
        entryDefinition,
        sourceBase,
        {
          hostCapabilities: reachableCapabilities,
          hostDefinitions: reachableHostDefinitions,
          wasmExports: linkedWasmExports,
        },
      ),
  );
  return {
    module: { ...module, sources: Object.freeze(sources) },
    sources: Object.freeze(sources),
  };
}

function requireEffectSet(
  module: string,
  boundary: string,
  effects: EffectSet | undefined,
): void {
  if (effects === undefined || effects instanceof Set) return;
  throw invalidArtifact(
    module,
    `functional module ${JSON.stringify(module)} ${boundary} effects must be a ReadonlySet`,
  );
}

function artifactDefinitionReachability(
  modules: ReadonlyMap<string, ModuleArtifact>,
  exportedDefinitions: ReadonlyMap<string, string>,
  entry: { readonly module: string; readonly exportName: string },
): {
  readonly definitionNames: ReadonlySet<string>;
  readonly referencedSymbols: ReadonlySet<string>;
} {
  const definitionScopes = new Map<string, {
    readonly definition: SurfaceDefinition;
    readonly localDefinitions: ReadonlyMap<string, string>;
    readonly importedDefinitions: ReadonlyMap<string, string>;
  }>();
  const importedTargets = new Map<string, string | undefined>();
  const roots: string[] = [];
  const entryDefinition = exportedDefinitions.get(exportKey(entry.module, entry.exportName));
  if (entryDefinition !== undefined) roots.push(entryDefinition);

  for (const artifact of modules.values()) {
    const localDefinitions = new Map(
      artifact.definitions.map((definition) => [
        definition.name,
        qualified(artifact.name, definition.name),
      ]),
    );
    const importedDefinitions = new Map<string, string>();
    for (const imported of artifact.imports) {
      const alias = qualified(artifact.name, `$import$${imported.name}`);
      const target = exportedDefinitions.get(
        exportKey(imported.fromModule, imported.exportName),
      );
      importedDefinitions.set(imported.name, alias);
      importedTargets.set(alias, target);
    }
    for (const definition of artifact.definitions) {
      const name = localDefinitions.get(definition.name)!;
      definitionScopes.set(name, {
        definition,
        localDefinitions,
        importedDefinitions,
      });
    }
    for (const exported of artifact.options.wasmExports ?? []) {
      const root = localDefinitions.get(exported.definition);
      if (root !== undefined) roots.push(root);
    }
  }

  const reachable = new Set<string>();
  const referencedSymbols = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const definition = pending.pop()!;
    if (reachable.has(definition)) continue;
    reachable.add(definition);
    if (importedTargets.has(definition)) {
      const target = importedTargets.get(definition);
      if (target !== undefined) {
        referencedSymbols.add(target);
        if (!reachable.has(target)) pending.push(target);
      }
      continue;
    }
    const scope = definitionScopes.get(definition);
    if (scope === undefined) continue;
    collectReferencedDefinitions(
      scope.definition.body,
      new Map(scope.definition.parameters.map((parameter) => [parameter, 1])),
      (reference) => {
        referencedSymbols.add(reference);
        const target = scope.importedDefinitions.get(reference) ??
          scope.localDefinitions.get(reference);
        if (target !== undefined && !reachable.has(target)) pending.push(target);
      },
      (constructor) => referencedSymbols.add(constructor),
    );
  }
  return { definitionNames: reachable, referencedSymbols };
}

function collectReferencedDefinitions(
  expression: SurfaceExpression,
  boundNames: Map<string, number>,
  reference: (name: string) => void,
  constructorReference: (name: string) => void,
): void {
  const collect = (value: SurfaceExpression): void =>
    collectReferencedDefinitions(value, boundNames, reference, constructorReference);
  switch (expression.kind) {
    case "name":
      if (!boundNames.has(expression.name)) reference(expression.name);
      return;
    case "lambda":
      addBoundNames(boundNames, expression.parameters);
      collect(expression.body);
      removeBoundNames(boundNames, expression.parameters);
      return;
    case "let":
      collect(expression.value);
      addBoundNames(boundNames, [expression.name]);
      collect(expression.body);
      removeBoundNames(boundNames, [expression.name]);
      return;
    case "let-rec":
      addBoundNames(boundNames, [expression.name]);
      collect(expression.value);
      collect(expression.body);
      removeBoundNames(boundNames, [expression.name]);
      return;
    case "let-rec-group": {
      const bindingNames = expression.bindings.map((binding) => binding.name);
      addBoundNames(boundNames, bindingNames);
      for (const binding of expression.bindings) {
        addBoundNames(boundNames, binding.parameters);
        collect(binding.body);
        removeBoundNames(boundNames, binding.parameters);
      }
      collect(expression.body);
      removeBoundNames(boundNames, bindingNames);
      return;
    }
    case "text-append":
    case "bytes-append":
    case "binary":
      collect(expression.left);
      collect(expression.right);
      return;
    case "store-new":
      collect(expression.length);
      collect(expression.initial);
      return;
    case "store-length":
      collect(expression.store);
      return;
    case "store-read":
      collect(expression.store);
      collect(expression.index);
      return;
    case "store-write":
      collect(expression.store);
      collect(expression.index);
      collect(expression.value);
      return;
    case "store-grow":
      collect(expression.store);
      collect(expression.length);
      collect(expression.initial);
      return;
    case "apply":
      collect(expression.callee);
      for (const argument of expression.arguments) collect(argument);
      return;
    case "if":
      collect(expression.condition);
      collect(expression.consequent);
      collect(expression.alternate);
      return;
    case "unary":
    case "numeric-convert":
      collect(expression.value);
      return;
    case "case":
      collect(expression.value);
      for (const arm of expression.arms) {
        constructorReference(arm.constructor);
        addBoundNames(boundNames, arm.binders);
        collect(arm.body);
        removeBoundNames(boundNames, arm.binders);
      }
      if (expression.otherwise !== undefined) {
        const binders = expression.otherwise.binder === undefined
          ? []
          : [expression.otherwise.binder];
        addBoundNames(boundNames, binders);
        collect(expression.otherwise.body);
        removeBoundNames(boundNames, binders);
      }
      return;
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "text":
    case "bytes":
    case "runtime-fault":
    case "store-empty":
      return;
  }
  throw new TypeError(
    `functional module contains unsupported surface expression ${
      JSON.stringify((expression as { readonly kind: unknown }).kind)
    }`,
  );
}

function sameHostField(
  left: HostCapabilityDeclaration["fields"][number],
  right: HostCapabilityDeclaration["fields"][number],
): boolean {
  const comparable = (field: HostCapabilityDeclaration["fields"][number]): unknown =>
    field.kind === "operation" ? { ...field, effects: [...field.effects].sort() } : field;
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function rewriteExpression(
  expression: SurfaceExpression,
  boundNames: Map<string, number>,
  definitions: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, string>,
  constructors: ReadonlyMap<string, string>,
  sourceBase: number,
): SurfaceExpression {
  const rewrite = (value: SurfaceExpression) =>
    rewriteExpression(value, boundNames, definitions, imports, constructors, sourceBase);
  const span = offsetSpan(expression.span, sourceBase);
  switch (expression.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "text":
    case "bytes":
    case "runtime-fault":
    case "store-empty":
      return { ...expression, span };
    case "name":
      return {
        ...expression,
        name: boundNames.has(expression.name)
          ? expression.name
          : imports.get(expression.name) ?? definitions.get(expression.name) ??
            constructors.get(expression.name) ?? expression.name,
        span,
      };
    case "lambda": {
      addBoundNames(boundNames, expression.parameters);
      const body = rewrite(expression.body);
      removeBoundNames(boundNames, expression.parameters);
      return { ...expression, body, span };
    }
    case "let": {
      const value = rewrite(expression.value);
      addBoundNames(boundNames, [expression.name]);
      const body = rewrite(expression.body);
      removeBoundNames(boundNames, [expression.name]);
      return {
        ...expression,
        value,
        body,
        span,
      };
    }
    case "let-rec": {
      addBoundNames(boundNames, [expression.name]);
      const value = rewrite(expression.value);
      const body = rewrite(expression.body);
      removeBoundNames(boundNames, [expression.name]);
      return {
        ...expression,
        value,
        body,
        span,
      };
    }
    case "let-rec-group": {
      const bindingNames = expression.bindings.map((binding) => binding.name);
      addBoundNames(boundNames, bindingNames);
      const bindings = expression.bindings.map((binding) => {
        addBoundNames(boundNames, binding.parameters);
        const body = rewrite(binding.body);
        removeBoundNames(boundNames, binding.parameters);
        return {
          ...binding,
          body,
          span: offsetSpan(binding.span, sourceBase),
        };
      });
      const body = rewrite(expression.body);
      removeBoundNames(boundNames, bindingNames);
      return {
        ...expression,
        bindings,
        body,
        span,
      };
    }
    case "if":
      return {
        ...expression,
        condition: rewrite(expression.condition),
        consequent: rewrite(expression.consequent),
        alternate: rewrite(expression.alternate),
        span,
      };
    case "apply":
      return {
        ...expression,
        callee: rewrite(expression.callee),
        arguments: expression.arguments.map(rewrite),
        span,
      };
    case "unary":
      return { ...expression, value: rewrite(expression.value), span };
    case "binary":
    case "text-append":
    case "bytes-append":
      return {
        ...expression,
        left: rewrite(expression.left),
        right: rewrite(expression.right),
        span,
      };
    case "store-new":
      return {
        ...expression,
        length: rewrite(expression.length),
        initial: rewrite(expression.initial),
        span,
      };
    case "store-length":
      return { ...expression, store: rewrite(expression.store), span };
    case "store-read":
      return {
        ...expression,
        store: rewrite(expression.store),
        index: rewrite(expression.index),
        span,
      };
    case "store-write":
      return {
        ...expression,
        store: rewrite(expression.store),
        index: rewrite(expression.index),
        value: rewrite(expression.value),
        span,
      };
    case "store-grow":
      return {
        ...expression,
        store: rewrite(expression.store),
        length: rewrite(expression.length),
        initial: rewrite(expression.initial),
        span,
      };
    case "numeric-convert":
      return { ...expression, value: rewrite(expression.value), span };
    case "case":
      return {
        ...expression,
        value: rewrite(expression.value),
        arms: expression.arms.map((arm) =>
          rewriteCaseArm(arm, boundNames, definitions, imports, constructors, sourceBase)
        ),
        ...(expression.otherwise === undefined ? {} : {
          otherwise: rewriteCaseDefault(
            expression.otherwise,
            boundNames,
            definitions,
            imports,
            constructors,
            sourceBase,
          ),
        }),
        span,
      };
  }
}

function rewriteCaseDefault(
  otherwise: SurfaceCaseDefault,
  boundNames: Map<string, number>,
  definitions: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, string>,
  constructors: ReadonlyMap<string, string>,
  sourceBase: number,
): SurfaceCaseDefault {
  const binders = otherwise.binder === undefined ? [] : [otherwise.binder];
  addBoundNames(boundNames, binders);
  const body = rewriteExpression(
    otherwise.body,
    boundNames,
    definitions,
    imports,
    constructors,
    sourceBase,
  );
  removeBoundNames(boundNames, binders);
  return { ...otherwise, body };
}

function rewriteCaseArm(
  arm: SurfaceCaseArm,
  boundNames: Map<string, number>,
  definitions: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, string>,
  constructors: ReadonlyMap<string, string>,
  sourceBase: number,
): SurfaceCaseArm {
  addBoundNames(boundNames, arm.binders);
  const body = rewriteExpression(
    arm.body,
    boundNames,
    definitions,
    imports,
    constructors,
    sourceBase,
  );
  removeBoundNames(boundNames, arm.binders);
  return {
    ...arm,
    constructor: constructors.get(arm.constructor) ?? arm.constructor,
    body,
    span: offsetSpan(arm.span, sourceBase),
  };
}

function addBoundNames(boundNames: Map<string, number>, names: readonly string[]): void {
  for (const name of names) boundNames.set(name, (boundNames.get(name) ?? 0) + 1);
}

function removeBoundNames(boundNames: Map<string, number>, names: readonly string[]): void {
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const name = names[index]!;
    const count = boundNames.get(name)!;
    if (count === 1) boundNames.delete(name);
    else boundNames.set(name, count - 1);
  }
}

function rewriteSchema(
  schema: TypeSchema | null,
  types: ReadonlyMap<string, string>,
): TypeSchema | null {
  if (schema === null) return null;
  switch (schema.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
    case "parameter":
      return schema;
    case "named":
      return {
        kind: "named",
        name: types.get(schema.name) ?? schema.name,
        arguments: schema.arguments.map((argument) => rewriteSchema(argument, types)!),
      };
    case "function":
      return {
        kind: "function",
        parameter: rewriteSchema(schema.parameter, types)!,
        result: rewriteSchema(schema.result, types)!,
      };
    case "forall":
      return { ...schema, body: rewriteSchema(schema.body, types)! };
  }
}

function offsetSpan(span: Span | undefined, offset: number): Span {
  return {
    startByte: offset + (span?.startByte ?? 0),
    endByte: offset + (span?.endByte ?? 0),
  };
}

function qualified(module: string, name: string): string {
  return `${module}::${name}`;
}

function exportKey(module: string, name: string): string {
  return `${module}\0${name}`;
}

function validateNominalImports(
  module: string,
  kind: "type" | "constructor",
  imports: readonly {
    readonly name: string;
    readonly fromModule: string;
    readonly exportName: string;
  }[],
  localNames: ReadonlySet<string>,
): void {
  const names = new Set<string>();
  for (const imported of imports) {
    requireModuleName(imported.name, `module ${JSON.stringify(module)} ${kind} import name`);
    requireModuleName(imported.fromModule, `${kind} import source module`);
    requireModuleName(imported.exportName, `${kind} import export name`);
    if (localNames.has(imported.name) || names.has(imported.name)) {
      throw invalidArtifact(
        module,
        `functional module ${JSON.stringify(module)} repeats ${kind} name ${
          JSON.stringify(imported.name)
        }`,
      );
    }
    names.add(imported.name);
  }
}

function validateNominalExports<Export extends { readonly name: string }>(
  module: string,
  kind: "type" | "constructor",
  exports: readonly Export[],
  localNames: ReadonlySet<string>,
  declarationName: (exported: Export) => string,
): void {
  const names = new Set<string>();
  for (const exported of exports) {
    requireModuleName(exported.name, `module ${JSON.stringify(module)} ${kind} export name`);
    const declaration = declarationName(exported);
    if (!localNames.has(declaration)) {
      throw invalidArtifact(
        module,
        `functional module ${JSON.stringify(module)} ${kind} export ${
          JSON.stringify(exported.name)
        } references unknown ${kind} ${JSON.stringify(declaration)}`,
      );
    }
    if (names.has(exported.name)) {
      throw new LinkError({
        code: "F4007",
        kind: "duplicate-export",
        module,
        reference: exported.name,
        message: `functional module ${JSON.stringify(module)} repeats ${kind} export ${
          JSON.stringify(exported.name)
        }`,
      });
    }
    names.add(exported.name);
  }
}

function missingNominalImport(
  module: string,
  kind: "type" | "constructor",
  imported: { readonly fromModule: string; readonly exportName: string },
): LinkError {
  const reference = `${imported.fromModule}.${imported.exportName}`;
  return new LinkError({
    code: "F4003",
    kind: "missing-import",
    module,
    reference,
    message: `functional module ${JSON.stringify(module)} references missing ${kind} export ${
      JSON.stringify(reference)
    }`,
  });
}

function requireModuleName(name: string, location: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new LinkError({
      code: "F4001",
      kind: "invalid-artifact",
      message: `functional ${location} must be nonempty; received ${JSON.stringify(name)}`,
    });
  }
}

function invalidArtifact(module: string, message: string): LinkError {
  return new LinkError({
    code: "F4001",
    kind: "invalid-artifact",
    module,
    message,
  });
}
