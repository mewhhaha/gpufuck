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
  readonly type: FunctionalTypeSchema;
}

export interface FunctionalModuleExport {
  readonly name: string;
  readonly definition: string;
  readonly type: FunctionalTypeSchema;
}

export interface FunctionalModuleArtifact {
  readonly name: string;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly imports: readonly FunctionalModuleImport[];
  readonly exports: readonly FunctionalModuleExport[];
  readonly sourceByteLength: number;
  readonly options: FunctionalSurfaceModuleOptions;
}

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
  return Object.freeze({
    ...artifact,
    definitions: Object.freeze([...artifact.definitions]),
    typeDeclarations: Object.freeze([...artifact.typeDeclarations]),
    imports: Object.freeze([...artifact.imports]),
    exports: Object.freeze([...artifact.exports]),
    options: Object.freeze({ ...artifact.options }),
  });
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
    const artifact = createFunctionalModuleArtifact(candidate);
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
  for (const artifact of modules.values()) {
    for (const exported of artifact.exports) {
      exportedDefinitions.set(
        exportKey(artifact.name, exported.name),
        qualified(artifact.name, exported.definition),
      );
    }
  }
  const linkedDefinitions: FunctionalSurfaceDefinition[] = [];
  const linkedTypes: FunctionalSurfaceTypeDeclaration[] = [];
  const sources: FunctionalLinkedSource[] = [];
  const capabilities: FunctionalHostCapabilityDeclaration[] = [];
  const capabilityKeys = new Set<string>();
  const linkedWasmExports: { readonly name: string; readonly definition: string }[] = [];
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
    for (const module of modules.values()) {
      for (const declaration of module.typeDeclarations) {
        const linkedName = qualified(module.name, declaration.name);
        availableTypeNames.set(linkedName, linkedName);
      }
    }
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
    const constructorNames = new Map<string, string>();
    for (const declaration of artifact.typeDeclarations) {
      for (const constructor of declaration.constructors) {
        constructorNames.set(constructor.name, qualified(artifact.name, constructor.name));
      }
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
        annotation: rewriteSchema(imported.type, availableTypeNames),
        body: { kind: "name", name: target, span: offsetSpan(undefined, sourceBase) },
        span: offsetSpan(undefined, sourceBase),
      });
    }
    const exportTypes = new Map(
      artifact.exports.map((exported) => [exported.definition, exported.type]),
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
          new Set(definition.parameters),
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
            ? { ...field, type: rewriteSchema(field.type, availableTypeNames)! }
            : {
              ...field,
              parameter: rewriteSchema(field.parameter, availableTypeNames)!,
              result: rewriteSchema(field.result, availableTypeNames)!,
            }
        ),
      };
      const key = JSON.stringify(linkedCapability);
      if (capabilityKeys.has(key)) continue;
      if (capabilities.some((candidate) => candidate.name === linkedCapability.name)) {
        throw new FunctionalLinkError({
          code: "F4005",
          kind: "incompatible-capability",
          module: artifact.name,
          reference: linkedCapability.name,
          message: `functional modules declare incompatible host capability ${
            JSON.stringify(linkedCapability.name)
          }`,
        });
      }
      capabilityKeys.add(key);
      capabilities.push(linkedCapability);
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
  const module = buildFunctionalSurfaceModule(
    linkedDefinitions,
    linkedTypes,
    entryDefinition,
    sourceBase,
    {
      hostCapabilities: capabilities,
      evaluationProfile: evaluationProfile ?? FunctionalEvaluationProfile.StrictEager,
      wasmExports: linkedWasmExports,
    },
  );
  return {
    module: { ...module, sources: Object.freeze(sources) },
    sources: Object.freeze(sources),
  };
}

function rewriteExpression(
  expression: FunctionalSurfaceExpression,
  bound: ReadonlySet<string>,
  definitions: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, string>,
  constructors: ReadonlyMap<string, string>,
  sourceBase: number,
): FunctionalSurfaceExpression {
  const rewrite = (value: FunctionalSurfaceExpression, scope = bound) =>
    rewriteExpression(value, scope, definitions, imports, constructors, sourceBase);
  const span = offsetSpan(expression.span, sourceBase);
  switch (expression.kind) {
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
      return { ...expression, span };
    case "name":
      return {
        ...expression,
        name: bound.has(expression.name)
          ? expression.name
          : imports.get(expression.name) ?? definitions.get(expression.name) ??
            constructors.get(expression.name) ?? expression.name,
        span,
      };
    case "lambda": {
      const scope = new Set(bound);
      scope.add(expression.parameter);
      return { ...expression, body: rewrite(expression.body, scope), span };
    }
    case "let": {
      const scope = new Set(bound);
      scope.add(expression.name);
      return {
        ...expression,
        value: rewrite(expression.value),
        body: rewrite(expression.body, scope),
        span,
      };
    }
    case "let-rec": {
      const scope = new Set(bound);
      scope.add(expression.name);
      return {
        ...expression,
        value: rewrite(expression.value, scope),
        body: rewrite(expression.body, scope),
        span,
      };
    }
    case "let-rec-group": {
      const scope = new Set(bound);
      for (const binding of expression.bindings) scope.add(binding.name);
      return {
        ...expression,
        bindings: expression.bindings.map((binding) => {
          const bindingScope = new Set(scope);
          for (const parameter of binding.parameters) bindingScope.add(parameter);
          return {
            ...binding,
            body: rewrite(binding.body, bindingScope),
            span: offsetSpan(binding.span, sourceBase),
          };
        }),
        body: rewrite(expression.body, scope),
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
          rewriteCaseArm(arm, bound, definitions, imports, constructors, sourceBase)
        ),
        span,
      };
  }
}

function rewriteCaseArm(
  arm: FunctionalSurfaceCaseArm,
  bound: ReadonlySet<string>,
  definitions: ReadonlyMap<string, string>,
  imports: ReadonlyMap<string, string>,
  constructors: ReadonlyMap<string, string>,
  sourceBase: number,
): FunctionalSurfaceCaseArm {
  const scope = new Set(bound);
  for (const binder of arm.binders) scope.add(binder);
  return {
    ...arm,
    constructor: constructors.get(arm.constructor) ?? arm.constructor,
    body: rewriteExpression(arm.body, scope, definitions, imports, constructors, sourceBase),
    span: offsetSpan(arm.span, sourceBase),
  };
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
