import {
  type EncodedFunctionalModule,
  FunctionalEvaluationProfile,
  type FunctionalSourceRange,
  type FunctionalSpan,
  type FunctionalTypeSchema,
} from "./abi.ts";
import type {
  FunctionalHostCapabilityDeclaration,
  FunctionalSurfaceModuleOptions,
} from "./host_contract.ts";
import { FUNCTIONAL_INIT_CONSTRUCTOR_NAME } from "./host_contract.ts";
import {
  buildFunctionalSurfaceModule,
  type FunctionalSurfaceCaseArm,
  type FunctionalSurfaceDefinition,
  type FunctionalSurfaceExpression,
  type FunctionalSurfaceTypeDeclaration,
} from "./surface_builder.ts";

export type FunctionalLinkDiagnosticCode =
  | "F4001"
  | "F4002"
  | "F4003"
  | "F4004"
  | "F4005"
  | "F4006"
  | "F4007";

export type FunctionalLinkFaultKind =
  | "invalid-artifact"
  | "duplicate-module"
  | "missing-import"
  | "incompatible-profile"
  | "incompatible-capability"
  | "missing-entry"
  | "duplicate-export";

export interface FunctionalLinkErrorDetails {
  readonly code: FunctionalLinkDiagnosticCode;
  readonly kind: FunctionalLinkFaultKind;
  readonly message: string;
  readonly module?: string;
  readonly reference?: string;
}

export class FunctionalLinkError extends Error {
  readonly code: FunctionalLinkDiagnosticCode;
  readonly kind: FunctionalLinkFaultKind;
  readonly module: string | undefined;
  readonly reference: string | undefined;

  constructor(details: FunctionalLinkErrorDetails, cause?: unknown) {
    super(`${details.code}: ${details.message}`, { cause });
    this.name = "FunctionalLinkError";
    this.code = details.code;
    this.kind = details.kind;
    this.module = details.module;
    this.reference = details.reference;
  }
}

export interface FunctionalModuleImport {
  readonly name: string;
  readonly fromModule: string;
  readonly exportName: string;
  readonly type?: FunctionalTypeSchema;
}

export interface FunctionalModuleExport {
  readonly name: string;
  readonly definition: string;
  readonly type?: FunctionalTypeSchema;
}

export interface FunctionalModuleTypeImport {
  readonly name: string;
  readonly fromModule: string;
  readonly exportName: string;
}

export interface FunctionalModuleConstructorImport {
  readonly name: string;
  readonly fromModule: string;
  readonly exportName: string;
}

export interface FunctionalModuleTypeExport {
  readonly name: string;
  readonly declaration: string;
}

export interface FunctionalModuleConstructorExport {
  readonly name: string;
  readonly constructor: string;
}

export interface FunctionalModuleArtifact {
  readonly name: string;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly imports: readonly FunctionalModuleImport[];
  readonly exports: readonly FunctionalModuleExport[];
  readonly typeImports?: readonly FunctionalModuleTypeImport[];
  readonly constructorImports?: readonly FunctionalModuleConstructorImport[];
  readonly typeExports?: readonly FunctionalModuleTypeExport[];
  readonly constructorExports?: readonly FunctionalModuleConstructorExport[];
  readonly sourceByteLength: number;
  readonly options: FunctionalSurfaceModuleOptions;
}

const snapshottedFunctionalModules = new WeakSet<FunctionalModuleArtifact>();

export type FunctionalLinkedSource = FunctionalSourceRange;

export interface LinkedFunctionalModule {
  readonly module: EncodedFunctionalModule;
  readonly sources: readonly FunctionalLinkedSource[];
}

export function createFunctionalModuleArtifact(
  artifact: FunctionalModuleArtifact,
): FunctionalModuleArtifact {
  requireModuleName(artifact.name, "module name");
  if (!Number.isSafeInteger(artifact.sourceByteLength) || artifact.sourceByteLength < 0) {
    throw invalidFunctionalArtifact(
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
    if (importNames.has(imported.name)) {
      throw invalidFunctionalArtifact(
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
      throw invalidFunctionalArtifact(
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
    if (!definitionNames.has(exported.definition)) {
      throw invalidFunctionalArtifact(
        artifact.name,
        `functional module ${JSON.stringify(artifact.name)} export ${
          JSON.stringify(exported.name)
        } references unknown definition ${JSON.stringify(exported.definition)}`,
      );
    }
    if (exportNames.has(exported.name)) {
      throw new FunctionalLinkError({
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
  let snapshot: FunctionalModuleArtifact;
  try {
    snapshot = structuredClone(artifact);
  } catch (cause) {
    throw new FunctionalLinkError({
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
  const pendingObjects: object[] = [snapshot];
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
  snapshottedFunctionalModules.add(snapshot);
  return snapshot;
}

export function linkFunctionalModules(
  artifacts: readonly FunctionalModuleArtifact[],
  entry: { readonly module: string; readonly exportName: string },
): LinkedFunctionalModule {
  if (artifacts.length === 0) {
    throw new FunctionalLinkError({
      code: "F4001",
      kind: "invalid-artifact",
      message: "functional module linker requires at least one module",
    });
  }
  const modules = new Map<string, FunctionalModuleArtifact>();
  for (const candidate of artifacts) {
    const artifact = snapshottedFunctionalModules.has(candidate)
      ? candidate
      : createFunctionalModuleArtifact(candidate);
    if (modules.has(artifact.name)) {
      throw new FunctionalLinkError({
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
  const linkedDefinitions: FunctionalSurfaceDefinition[] = [];
  const linkedTypes: FunctionalSurfaceTypeDeclaration[] = [];
  const sources: FunctionalLinkedSource[] = [];
  const capabilities: FunctionalHostCapabilityDeclaration[] = [];
  const linkedWasmExports: { readonly name: string; readonly definition: string }[] = [];
  const linkedHostDefinitions: {
    readonly definition: string;
    readonly capability: string;
    readonly field: string;
  }[] = [];
  const linkedWasmExportNames = new Set<string>();
  let sourceBase = 0;
  let evaluationProfile: FunctionalEvaluationProfile | undefined;

  for (const artifact of modules.values()) {
    const profile = artifact.options.evaluationProfile ?? FunctionalEvaluationProfile.StrictEager;
    if (evaluationProfile !== undefined && evaluationProfile !== profile) {
      throw new FunctionalLinkError({
        code: "F4004",
        kind: "incompatible-profile",
        module: artifact.name,
        message: `functional module linker cannot mix evaluation profiles ${
          JSON.stringify(evaluationProfile)
        } and ${JSON.stringify(profile)}`,
      });
    }
    evaluationProfile = profile;
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
        throw invalidFunctionalArtifact(
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
        throw invalidFunctionalArtifact(
          artifact.name,
          `functional module ${JSON.stringify(artifact.name)} WASM export ${
            JSON.stringify(exported.name)
          } references unknown definition ${JSON.stringify(exported.definition)}`,
        );
      }
      if (linkedWasmExportNames.has(exported.name)) {
        throw new FunctionalLinkError({
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
        throw new FunctionalLinkError({
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
      linkedDefinitions.push({
        name: alias,
        parameters: [],
        annotation: imported.type === undefined
          ? null
          : rewriteSchema(imported.type, availableTypeNames),
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
      linkedDefinitions.push({
        ...definition,
        name: definitionNames.get(definition.name)!,
        annotation: rewriteSchema(
          exportTypes.get(definition.name) ?? definition.annotation,
          availableTypeNames,
        ),
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
      const linkedCapability: FunctionalHostCapabilityDeclaration = {
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
        if (JSON.stringify(previous) === JSON.stringify(field)) continue;
        throw new FunctionalLinkError({
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
  const entryDefinition = exportedDefinitions.get(exportKey(entry.module, entry.exportName));
  if (entryDefinition === undefined) {
    throw new FunctionalLinkError({
      code: "F4006",
      kind: "missing-entry",
      module: entry.module,
      reference: entry.exportName,
      message: `functional module linker entry references missing export ${
        JSON.stringify(`${entry.module}.${entry.exportName}`)
      }`,
    });
  }
  const reachability = analyzeLinkedDefinitionReachability(linkedDefinitions, [
    entryDefinition,
    ...linkedWasmExports.map((exported) => exported.definition),
  ]);
  const reachableDefinitions = linkedDefinitions.filter((definition) =>
    reachability.definitionNames.has(definition.name)
  );
  const reachableHostDefinitions = linkedHostDefinitions.filter((binding) =>
    reachability.definitionNames.has(binding.definition)
  );
  const reachableHostFields = new Map<string, Set<string>>();
  for (const binding of reachableHostDefinitions) {
    const fields = reachableHostFields.get(binding.capability) ?? new Set<string>();
    fields.add(binding.field);
    reachableHostFields.set(binding.capability, fields);
  }
  const reachableCapabilities = reachability.usesHostInit
    ? capabilities
    : capabilities.flatMap((capability) => {
      const fields = reachableHostFields.get(capability.name);
      if (fields === undefined) return [];
      return [{
        name: capability.name,
        fields: capability.fields.filter((field) => fields.has(field.name)),
      }];
    });
  const module = buildFunctionalSurfaceModule(
    reachableDefinitions,
    linkedTypes,
    entryDefinition,
    sourceBase,
    {
      hostCapabilities: reachableCapabilities,
      hostDefinitions: reachableHostDefinitions,
      evaluationProfile: evaluationProfile ?? FunctionalEvaluationProfile.StrictEager,
      wasmExports: linkedWasmExports,
    },
  );
  return {
    module: { ...module, sources: Object.freeze(sources) },
    sources: Object.freeze(sources),
  };
}

function analyzeLinkedDefinitionReachability(
  definitions: readonly FunctionalSurfaceDefinition[],
  roots: readonly string[],
): {
  readonly definitionNames: ReadonlySet<string>;
  readonly usesHostInit: boolean;
} {
  const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
  const reachable = new Set<string>();
  const pending = [...roots];
  let usesHostInit = false;
  while (pending.length > 0) {
    const definitionName = pending.pop()!;
    if (reachable.has(definitionName)) continue;
    const definition = definitionsByName.get(definitionName);
    if (definition === undefined) continue;
    reachable.add(definitionName);
    const expressions: FunctionalSurfaceExpression[] = [definition.body];
    while (expressions.length > 0) {
      const expression = expressions.pop()!;
      switch (expression.kind) {
        case "name":
          if (expression.name === FUNCTIONAL_INIT_CONSTRUCTOR_NAME) usesHostInit = true;
          if (definitionsByName.has(expression.name) && !reachable.has(expression.name)) {
            pending.push(expression.name);
          }
          break;
        case "text-append":
        case "bytes-append":
        case "binary":
          expressions.push(expression.left, expression.right);
          break;
        case "apply":
          expressions.push(expression.callee, expression.argument);
          break;
        case "lambda":
          expressions.push(expression.body);
          break;
        case "let":
        case "let-rec":
          expressions.push(expression.value, expression.body);
          break;
        case "let-rec-group":
          expressions.push(expression.body, ...expression.bindings.map((binding) => binding.body));
          break;
        case "if":
          expressions.push(expression.condition, expression.consequent, expression.alternate);
          break;
        case "unary":
        case "numeric-convert":
          expressions.push(expression.value);
          break;
        case "case":
          if (
            expression.arms.some((arm) => arm.constructor === FUNCTIONAL_INIT_CONSTRUCTOR_NAME)
          ) {
            usesHostInit = true;
          }
          expressions.push(expression.value, ...expression.arms.map((arm) => arm.body));
          break;
        case "integer":
        case "signed-integer-64":
        case "float-32":
        case "float-64":
        case "whole-number-f64":
        case "boolean":
        case "text":
        case "bytes":
        case "runtime-fault":
          break;
      }
    }
  }
  return { definitionNames: reachable, usesHostInit };
}

function rewriteExpression(
  expression: FunctionalSurfaceExpression,
  boundNames: Map<string, number>,
  definitions: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, string>,
  constructors: ReadonlyMap<string, string>,
  sourceBase: number,
): FunctionalSurfaceExpression {
  const rewrite = (value: FunctionalSurfaceExpression) =>
    rewriteExpression(value, boundNames, definitions, imports, constructors, sourceBase);
  const span = offsetSpan(expression.span, sourceBase);
  switch (expression.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "whole-number-f64":
    case "boolean":
    case "text":
    case "bytes":
    case "runtime-fault":
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
      addBoundNames(boundNames, [expression.parameter]);
      const body = rewrite(expression.body);
      removeBoundNames(boundNames, [expression.parameter]);
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
        argument: rewrite(expression.argument),
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
    case "numeric-convert":
      return { ...expression, value: rewrite(expression.value), span };
    case "case":
      return {
        ...expression,
        value: rewrite(expression.value),
        arms: expression.arms.map((arm) =>
          rewriteCaseArm(arm, boundNames, definitions, imports, constructors, sourceBase)
        ),
        span,
      };
  }
}

function rewriteCaseArm(
  arm: FunctionalSurfaceCaseArm,
  boundNames: Map<string, number>,
  definitions: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, string>,
  constructors: ReadonlyMap<string, string>,
  sourceBase: number,
): FunctionalSurfaceCaseArm {
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
  schema: FunctionalTypeSchema | null,
  types: ReadonlyMap<string, string>,
): FunctionalTypeSchema | null {
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
    case "tuple":
      return {
        kind: "tuple",
        values: [rewriteSchema(schema.values[0], types)!, rewriteSchema(schema.values[1], types)!],
      };
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

function offsetSpan(span: FunctionalSpan | undefined, offset: number): FunctionalSpan {
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
      throw invalidFunctionalArtifact(
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
      throw invalidFunctionalArtifact(
        module,
        `functional module ${JSON.stringify(module)} ${kind} export ${
          JSON.stringify(exported.name)
        } references unknown ${kind} ${JSON.stringify(declaration)}`,
      );
    }
    if (names.has(exported.name)) {
      throw new FunctionalLinkError({
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
): FunctionalLinkError {
  const reference = `${imported.fromModule}.${imported.exportName}`;
  return new FunctionalLinkError({
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
    throw new FunctionalLinkError({
      code: "F4001",
      kind: "invalid-artifact",
      message: `functional ${location} must be nonempty; received ${JSON.stringify(name)}`,
    });
  }
}

function invalidFunctionalArtifact(module: string, message: string): FunctionalLinkError {
  return new FunctionalLinkError({
    code: "F4001",
    kind: "invalid-artifact",
    module,
    message,
  });
}
