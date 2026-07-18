import {
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FUNCTIONAL_UNIT_CONSTRUCTOR_NAME,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  type FunctionalSpan,
  type FunctionalTypeSchema,
} from "../functional/abi.ts";
import {
  createFunctionalModuleArtifact,
  type FunctionalModuleArtifact,
} from "../functional/module_linker.ts";
import {
  FUNCTIONAL_BYTES_TYPE_NAME,
  FUNCTIONAL_TEXT_TYPE_NAME,
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostOperationDeclaration,
} from "../functional/host_contract.ts";
import type {
  FunctionalSurfaceCaseArm,
  FunctionalSurfaceDefinition,
  FunctionalSurfaceExpression,
  FunctionalSurfaceTypeDeclaration,
} from "../functional/surface_builder.ts";
import type {
  GleamFunctionalConstant,
  GleamFunctionalExpression,
  GleamFunctionalFunction,
  GleamFunctionalModule,
  GleamFunctionalPattern,
  GleamFunctionalType,
  GleamFunctionalTypeAlias,
  GleamFunctionalTypeDeclaration,
} from "./ast.ts";
import { GleamFunctionalLoweringError } from "./diagnostic.ts";

export type GleamFunctionalExportSignature =
  | {
    readonly kind: "value";
    readonly module: string;
    readonly name: string;
    readonly type: FunctionalTypeSchema | null;
    readonly parameterLabels: readonly (string | null)[];
  }
  | {
    readonly kind: "type";
    readonly module: string;
    readonly name: string;
    readonly arity: number;
  }
  | {
    readonly kind: "constructor";
    readonly module: string;
    readonly name: string;
    readonly owner: string;
    readonly fields: readonly (string | null)[];
  };

export interface LoweredGleamFunctionalModule {
  readonly source: GleamFunctionalModule;
  readonly definitions: readonly FunctionalSurfaceDefinition[];
  readonly typeDeclarations: readonly FunctionalSurfaceTypeDeclaration[];
  readonly artifact: FunctionalModuleArtifact;
}

interface ConstructorShape {
  readonly owner: string;
  readonly fields: readonly (string | null)[];
  readonly span: FunctionalSpan;
}

interface LoweredGleamImports {
  readonly values: FunctionalModuleArtifact["imports"];
  readonly types: NonNullable<FunctionalModuleArtifact["typeImports"]>;
  readonly constructors: NonNullable<FunctionalModuleArtifact["constructorImports"]>;
}

const GLEAM_LIST_TYPE = "$GleamList";
const GLEAM_LIST_NIL = "$GleamNil";
const GLEAM_LIST_CONS = "$GleamCons";
const GLEAM_BIT_ARRAY_TYPE = "$GleamBitArray";
const GLEAM_BIT_ARRAY_VALUE = "$GleamBitArrayValue";
const TUPLE_OWNER = "$TupleType";

const binaryOperators: Readonly<Record<string, FunctionalBinaryOperator>> = {
  "==": FunctionalBinaryOperator.StructuralEqual,
  "!=": FunctionalBinaryOperator.StructuralNotEqual,
  "<": FunctionalBinaryOperator.Less,
  "<=": FunctionalBinaryOperator.LessEqual,
  ">": FunctionalBinaryOperator.Greater,
  ">=": FunctionalBinaryOperator.GreaterEqual,
  "<.": FunctionalBinaryOperator.LessFloat64,
  "<=.": FunctionalBinaryOperator.LessEqualFloat64,
  ">.": FunctionalBinaryOperator.GreaterFloat64,
  ">=.": FunctionalBinaryOperator.GreaterEqualFloat64,
  "+": FunctionalBinaryOperator.Add,
  "-": FunctionalBinaryOperator.Subtract,
  "*": FunctionalBinaryOperator.Multiply,
  "/": FunctionalBinaryOperator.Divide,
  "+.": FunctionalBinaryOperator.AddFloat64,
  "-.": FunctionalBinaryOperator.SubtractFloat64,
  "*.": FunctionalBinaryOperator.MultiplyFloat64,
  "/.": FunctionalBinaryOperator.DivideFloat64,
};

export function gleamFunctionalNominalExportSignatures(
  module: GleamFunctionalModule,
): readonly GleamFunctionalExportSignature[] {
  return module.declarations.flatMap((declaration): readonly GleamFunctionalExportSignature[] => {
    if (!declaration.public || declaration.kind !== "type") return [];
    const typeExport: GleamFunctionalExportSignature = {
      kind: "type",
      module: module.name,
      name: declaration.name,
      arity: declaration.parameters.length,
    };
    if (declaration.opaque) return [typeExport];
    return [
      typeExport,
      ...declaration.constructors.map((constructor): GleamFunctionalExportSignature => ({
        kind: "constructor",
        module: module.name,
        name: constructor.name,
        owner: declaration.name,
        fields: constructor.fields.map((field) => field.label),
      })),
    ];
  });
}

export function gleamFunctionalValueExportSignatures(
  module: GleamFunctionalModule,
  availableExports: readonly GleamFunctionalExportSignature[],
): readonly GleamFunctionalExportSignature[] {
  const typeResolver = new GleamTypeResolver(module, availableExports);
  typeResolver.validateAliases();
  return module.declarations.flatMap((declaration) => {
    if (
      !declaration.public ||
      (declaration.kind !== "function" && declaration.kind !== "constant")
    ) return [];
    return [{
      kind: "value" as const,
      module: module.name,
      name: declaration.name,
      type: declaration.kind === "function"
        ? declaredFunctionType(declaration, typeResolver)
        : declaredConstantType(declaration, typeResolver),
      parameterLabels: declaration.kind === "function"
        ? declaration.parameters.map((parameter) => parameter.label)
        : [],
    }];
  });
}

export function lowerGleamFunctionalModule(
  module: GleamFunctionalModule,
  availableExports: readonly GleamFunctionalExportSignature[],
): LoweredGleamFunctionalModule {
  return new GleamFunctionalLowering(module, availableExports).lower();
}

class GleamFunctionalLowering {
  readonly #constructors = new Map<string, ConstructorShape>();
  readonly #constructorsByOwner = new Map<string, readonly string[]>();
  readonly #declarations = new Map<string, FunctionalSpan>();
  readonly #qualifiedImports = new Map<string, string>();
  readonly #callLabels = new Map<string, readonly (string | null)[]>();
  readonly #importedConstructorOwners = new Set<string>();
  readonly #typeResolver: GleamTypeResolver;
  readonly #externalCapabilities = new Map<
    string,
    Map<string, FunctionalHostOperationDeclaration>
  >();
  readonly #hostDefinitions: {
    readonly definition: string;
    readonly capability: string;
    readonly field: string;
  }[] = [];
  #discardIndex = 0;

  constructor(
    private readonly module: GleamFunctionalModule,
    private readonly availableExports: readonly GleamFunctionalExportSignature[],
  ) {
    this.#typeResolver = new GleamTypeResolver(module, availableExports);
  }

  lower(): LoweredGleamFunctionalModule {
    this.#typeResolver.validateAliases();
    this.indexImplicitDeclarations();
    this.indexDeclarations();
    const imports = this.lowerImports();
    const typeDeclarations = [
      ...this.module.declarations.flatMap((declaration) =>
        declaration.kind === "type" ? [this.lowerTypeDeclaration(declaration)] : []
      ),
      gleamListDeclaration(this.module.span.endByte),
      gleamBitArrayDeclaration(this.module.span.endByte),
    ];
    const definitions = this.module.declarations.flatMap((declaration) =>
      declaration.kind === "function"
        ? declaration.external === null
          ? [this.lowerFunction(declaration)]
          : this.lowerExternalFunction(declaration)
        : declaration.kind === "constant"
        ? [this.lowerConstant(declaration)]
        : []
    );
    const exports = this.module.declarations.flatMap((declaration) => {
      if (
        !declaration.public ||
        (declaration.kind !== "function" && declaration.kind !== "constant")
      ) return [];
      const type = declaration.kind === "function"
        ? declaredFunctionType(declaration, this.#typeResolver)
        : declaredConstantType(declaration, this.#typeResolver);
      return [{
        name: declaration.name,
        definition: declaration.name,
        ...(type === null ? {} : { type }),
      }];
    });
    const artifact = createFunctionalModuleArtifact({
      name: this.module.name,
      definitions,
      typeDeclarations,
      imports: imports.values,
      exports,
      typeImports: imports.types,
      constructorImports: imports.constructors,
      typeExports: this.module.declarations.flatMap((declaration) =>
        declaration.public && declaration.kind === "type"
          ? [{ name: declaration.name, declaration: declaration.name }]
          : []
      ),
      constructorExports: this.module.declarations.flatMap((declaration) =>
        declaration.public && declaration.kind === "type" && !declaration.opaque
          ? declaration.constructors.map((constructor) => ({
            name: constructor.name,
            constructor: constructor.name,
          }))
          : []
      ),
      sourceByteLength: this.module.span.endByte,
      options: {
        evaluationProfile: FunctionalEvaluationProfile.StrictEager,
        hostCapabilities: this.hostCapabilities(),
        hostDefinitions: this.#hostDefinitions,
      },
    });
    return { source: this.module, definitions, typeDeclarations, artifact };
  }

  private indexImplicitDeclarations(): void {
    const span = { startByte: this.module.span.endByte, endByte: this.module.span.endByte };
    this.#constructors.set(GLEAM_LIST_NIL, { owner: GLEAM_LIST_TYPE, fields: [], span });
    this.#constructors.set(GLEAM_LIST_CONS, {
      owner: GLEAM_LIST_TYPE,
      fields: [null, null],
      span,
    });
    this.#constructorsByOwner.set(GLEAM_LIST_TYPE, [GLEAM_LIST_NIL, GLEAM_LIST_CONS]);
    this.#constructors.set(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, {
      owner: TUPLE_OWNER,
      fields: [null, null],
      span,
    });
    this.#constructorsByOwner.set(TUPLE_OWNER, [FUNCTIONAL_PAIR_CONSTRUCTOR_NAME]);
    this.#constructors.set(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, {
      owner: "$UnitType",
      fields: [],
      span,
    });
    this.#constructorsByOwner.set("$UnitType", [FUNCTIONAL_UNIT_CONSTRUCTOR_NAME]);
    this.#constructors.set(GLEAM_BIT_ARRAY_VALUE, {
      owner: GLEAM_BIT_ARRAY_TYPE,
      fields: [null, null],
      span,
    });
    this.#constructorsByOwner.set(GLEAM_BIT_ARRAY_TYPE, [GLEAM_BIT_ARRAY_VALUE]);
  }

  private indexDeclarations(): void {
    for (const declaration of this.module.declarations) {
      const existing = this.#declarations.get(declaration.name);
      if (existing !== undefined) {
        throw new GleamFunctionalLoweringError(
          declaration.span,
          `Gleam module ${JSON.stringify(this.module.name)} repeats declaration ${
            JSON.stringify(declaration.name)
          }; the first declaration starts at byte ${existing.startByte}.`,
        );
      }
      this.#declarations.set(declaration.name, declaration.span);
      if (declaration.kind === "function") {
        this.#callLabels.set(
          declaration.name,
          declaration.parameters.map((parameter) => parameter.label),
        );
        requireUniqueNames(
          declaration.parameters.map((parameter) => parameter.name),
          declaration.span,
          `function ${JSON.stringify(declaration.name)} parameters`,
        );
        requireUniqueNames(
          declaration.parameters.flatMap((parameter) =>
            parameter.label === null ? [] : [parameter.label]
          ),
          declaration.span,
          `function ${JSON.stringify(declaration.name)} labels`,
        );
        continue;
      }
      if (declaration.kind === "type") this.indexTypeDeclaration(declaration);
      if (declaration.kind === "type-alias") this.indexTypeAlias(declaration);
    }
  }

  private indexTypeDeclaration(declaration: GleamFunctionalTypeDeclaration): void {
    requireUniqueNames(
      declaration.parameters,
      declaration.span,
      `type ${JSON.stringify(declaration.name)} parameters`,
    );
    const constructorNames: string[] = [];
    for (const constructor of declaration.constructors) {
      const existing = this.#constructors.get(constructor.name);
      if (existing !== undefined) {
        throw new GleamFunctionalLoweringError(
          constructor.span,
          `Gleam constructor ${
            JSON.stringify(constructor.name)
          } was already declared at byte ${existing.span.startByte}.`,
        );
      }
      requireUniqueNames(
        constructor.fields.flatMap((field) => field.label === null ? [] : [field.label]),
        constructor.span,
        `constructor ${JSON.stringify(constructor.name)} field labels`,
      );
      this.#constructors.set(constructor.name, {
        owner: declaration.name,
        fields: constructor.fields.map((field) => field.label),
        span: constructor.span,
      });
      constructorNames.push(constructor.name);
    }
    this.#constructorsByOwner.set(declaration.name, constructorNames);
  }

  private indexTypeAlias(declaration: GleamFunctionalTypeAlias): void {
    requireUniqueNames(
      declaration.parameters,
      declaration.span,
      `type alias ${JSON.stringify(declaration.name)} parameters`,
    );
    requireDeclaredTypeParameters(
      declaration.type,
      new Set(declaration.parameters),
      declaration.name,
    );
  }

  private lowerImports(): LoweredGleamImports {
    const values: FunctionalModuleArtifact["imports"][number][] = [];
    const types: NonNullable<FunctionalModuleArtifact["typeImports"]>[number][] = [];
    const constructors: NonNullable<FunctionalModuleArtifact["constructorImports"]>[number][] = [];
    const localNames = new Set(this.#declarations.keys());
    const qualifiedConstructorOwners = new Set<string>();
    for (const declaration of this.module.imports) {
      const moduleExports = this.availableExports.filter((candidate) =>
        candidate.module === declaration.module
      );
      if (moduleExports.length === 0) {
        throw new GleamFunctionalLoweringError(
          declaration.span,
          `Gleam module ${JSON.stringify(this.module.name)} imports missing module ${
            JSON.stringify(declaration.module)
          }.`,
        );
      }
      if (declaration.names.length === 0) {
        const qualifier = declaration.module.split("/").at(-1)!;
        for (const exported of moduleExports) {
          if (exported.kind === "type") {
            types.push({
              name: qualifiedTypeImportName(declaration.module, exported.name),
              fromModule: declaration.module,
              exportName: exported.name,
            });
            continue;
          }
          if (exported.kind === "constructor") {
            const owner = qualifiedTypeImportName(declaration.module, exported.owner);
            if (qualifiedConstructorOwners.has(owner)) continue;
            qualifiedConstructorOwners.add(owner);
            const siblings = moduleExports.filter((candidate): candidate is Extract<
              GleamFunctionalExportSignature,
              { readonly kind: "constructor" }
            > => candidate.kind === "constructor" && candidate.owner === exported.owner);
            const importedNames = siblings.map((sibling) => {
              const name = `${qualifier}.${sibling.name}`;
              constructors.push({
                name,
                fromModule: declaration.module,
                exportName: sibling.name,
              });
              this.#constructors.set(name, {
                owner,
                fields: sibling.fields,
                span: declaration.span,
              });
              this.addQualifiedImport(name, name, declaration.span);
              return name;
            });
            this.#constructorsByOwner.set(owner, importedNames);
            continue;
          }
          const alias = qualifiedValueImportName(declaration.module, exported.name);
          values.push({
            name: alias,
            fromModule: declaration.module,
            exportName: exported.name,
            ...(exported.type === null ? {} : { type: exported.type }),
          });
          this.#callLabels.set(alias, exported.parameterLabels);
          const qualifiedName = `${qualifier}.${exported.name}`;
          this.addQualifiedImport(qualifiedName, alias, declaration.span);
        }
        continue;
      }
      for (const imported of declaration.names) {
        const expectedKind = imported.kind === "type" ? "type" : undefined;
        const exported = moduleExports.find((candidate) =>
          candidate.name === imported.name &&
          (expectedKind === undefined ? candidate.kind !== "type" : candidate.kind === expectedKind)
        );
        if (exported === undefined) {
          const category = imported.kind === "type" ? "type" : "value or constructor";
          throw new GleamFunctionalLoweringError(
            imported.span,
            `Gleam module ${JSON.stringify(this.module.name)} imports missing public ${category} ${
              JSON.stringify(`${declaration.module}.${imported.name}`)
            }.`,
          );
        }
        if (exported.kind === "type") {
          if (this.#typeResolver.isLocalTypeName(imported.alias)) {
            throw new GleamFunctionalLoweringError(
              imported.span,
              `Gleam type import alias ${
                JSON.stringify(imported.alias)
              } conflicts with a local type.`,
            );
          }
          types.push({
            name: imported.alias,
            fromModule: declaration.module,
            exportName: imported.name,
          });
          continue;
        }
        if (
          localNames.has(imported.alias) ||
          values.some((candidate) => candidate.name === imported.alias) ||
          constructors.some((candidate) =>
            candidate.name === imported.alias &&
            !(exported.kind === "constructor" && candidate.fromModule === declaration.module &&
              candidate.exportName === exported.name)
          )
        ) {
          throw new GleamFunctionalLoweringError(
            imported.span,
            `Gleam import alias ${
              JSON.stringify(imported.alias)
            } conflicts with another value or constructor in module ${
              JSON.stringify(this.module.name)
            }.`,
          );
        }
        if (exported.kind === "constructor") {
          this.addImportedConstructor(
            constructors,
            declaration.module,
            exported,
            imported.alias,
            imported.span,
          );
          const ownerImportName = qualifiedTypeImportName(declaration.module, exported.owner);
          if (!types.some((candidate) => candidate.name === ownerImportName)) {
            types.push({
              name: ownerImportName,
              fromModule: declaration.module,
              exportName: exported.owner,
            });
          }
          continue;
        }
        values.push({
          name: imported.alias,
          fromModule: declaration.module,
          exportName: imported.name,
          ...(exported.type === null ? {} : { type: exported.type }),
        });
        this.#callLabels.set(imported.alias, exported.parameterLabels);
      }
    }
    return { values, types, constructors };
  }

  private addImportedConstructor(
    imports: NonNullable<FunctionalModuleArtifact["constructorImports"]>[number][],
    fromModule: string,
    exported: Extract<GleamFunctionalExportSignature, { readonly kind: "constructor" }>,
    visibleName: string,
    span: FunctionalSpan,
  ): void {
    const siblings = this.availableExports.filter((candidate): candidate is Extract<
      GleamFunctionalExportSignature,
      { readonly kind: "constructor" }
    > =>
      candidate.kind === "constructor" && candidate.module === fromModule &&
      candidate.owner === exported.owner
    );
    const owner = qualifiedTypeImportName(fromModule, exported.owner);
    if (this.#importedConstructorOwners.has(owner)) return;
    this.#importedConstructorOwners.add(owner);
    const importedNames: string[] = [];
    for (const sibling of siblings) {
      const explicitlyImported = this.module.imports
        .filter((candidate) => candidate.module === fromModule)
        .flatMap((candidate) => candidate.names)
        .find((candidate) => candidate.kind === "value" && candidate.name === sibling.name);
      const name = explicitlyImported?.alias ?? qualifiedConstructorImportName(
        fromModule,
        sibling.name,
      );
      if (!imports.some((candidate) => candidate.name === name)) {
        imports.push({ name, fromModule, exportName: sibling.name });
      }
      this.#constructors.set(name, { owner, fields: sibling.fields, span });
      importedNames.push(name);
      if (sibling.name === exported.name && visibleName.includes(".")) {
        this.addQualifiedImport(visibleName, name, span);
      }
    }
    this.#constructorsByOwner.set(owner, importedNames);
  }

  private addQualifiedImport(sourceName: string, localName: string, span: FunctionalSpan): void {
    if (this.#qualifiedImports.has(sourceName)) {
      throw new GleamFunctionalLoweringError(
        span,
        `Gleam qualified import ${JSON.stringify(sourceName)} is ambiguous in module ${
          JSON.stringify(this.module.name)
        }.`,
      );
    }
    this.#qualifiedImports.set(sourceName, localName);
  }

  private lowerTypeDeclaration(
    declaration: GleamFunctionalTypeDeclaration,
  ): FunctionalSurfaceTypeDeclaration {
    const parameters = new Set(declaration.parameters);
    return {
      name: declaration.name,
      parameters: declaration.parameters,
      span: declaration.span,
      constructors: declaration.constructors.map((constructor) => ({
        name: constructor.name,
        span: constructor.span,
        fields: constructor.fields.map((field, index) => {
          requireDeclaredTypeParameters(field.type, parameters, declaration.name);
          return {
            name: field.label ?? `field${index}`,
            type: this.#typeResolver.lower(field.type),
            span: field.span,
          };
        }),
      })),
    };
  }

  private lowerFunction(declaration: GleamFunctionalFunction): FunctionalSurfaceDefinition {
    if (declaration.body === null) {
      throw new Error(`Gleam function ${JSON.stringify(declaration.name)} omitted its body.`);
    }
    const annotations = declaration.parameters.map((parameter) => parameter.annotation);
    const hasAnyAnnotation = annotations.some((annotation) => annotation !== null) ||
      declaration.result !== null;
    const hasCompleteAnnotation = annotations.every((annotation) => annotation !== null) &&
      declaration.result !== null;
    if (hasAnyAnnotation && !hasCompleteAnnotation) {
      throw new GleamFunctionalLoweringError(
        declaration.span,
        `Gleam function ${
          JSON.stringify(declaration.name)
        } must annotate every parameter and its result, or omit all annotations.`,
      );
    }
    for (const annotation of annotations) {
      if (annotation !== null) this.#typeResolver.lower(annotation);
    }
    if (declaration.result !== null) this.#typeResolver.lower(declaration.result);
    return {
      name: declaration.name,
      parameters: declaration.parameters.map((parameter) => parameter.name),
      annotation: hasCompleteAnnotation
        ? declaredFunctionType(declaration, this.#typeResolver)
        : null,
      body: this.lowerExpression(declaration.body),
      span: declaration.span,
    };
  }

  private lowerExternalFunction(
    declaration: GleamFunctionalFunction,
  ): readonly FunctionalSurfaceDefinition[] {
    const external = declaration.external;
    if (external === null || declaration.body !== null) {
      throw new Error(`Gleam external ${JSON.stringify(declaration.name)} has an invalid shape.`);
    }
    if (external.target !== "javascript") {
      throw new GleamFunctionalLoweringError(
        declaration.span,
        `Gleam external ${JSON.stringify(declaration.name)} targets ${
          JSON.stringify(external.target)
        }; the portable WASM adapter currently accepts JavaScript externals.`,
      );
    }
    if (declaration.parameters.length === 0) {
      throw new GleamFunctionalLoweringError(
        declaration.span,
        `Gleam external ${
          JSON.stringify(declaration.name)
        } needs at least one parameter at the functional host boundary.`,
      );
    }
    if (
      declaration.result === null ||
      declaration.parameters.some((parameter) => parameter.annotation === null)
    ) {
      throw new GleamFunctionalLoweringError(
        declaration.span,
        `Gleam external ${
          JSON.stringify(declaration.name)
        } must annotate every parameter and its result.`,
      );
    }
    const parameters = declaration.parameters.map((parameter) =>
      this.#typeResolver.lower(parameter.annotation!)
    );
    const result = this.#typeResolver.lower(declaration.result);
    if (parameters.some(schemaContainsParameter) || schemaContainsParameter(result)) {
      throw new GleamFunctionalLoweringError(
        declaration.span,
        `Gleam external ${JSON.stringify(declaration.name)} must use concrete host-boundary types.`,
      );
    }
    const hostParameter = nestedTupleSchema(parameters);
    const hostDefinition = `$gleam_external:${declaration.name}`;
    const capability = `GleamExternal:${external.module}`;
    const operation: FunctionalHostOperationDeclaration = {
      kind: "operation",
      name: external.name,
      purity: "effectful",
      parameter: hostParameter,
      result,
    };
    const fields = this.#externalCapabilities.get(capability) ?? new Map();
    const existing = fields.get(operation.name);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(operation)) {
      throw new GleamFunctionalLoweringError(
        declaration.span,
        `Gleam externals disagree about host operation ${
          JSON.stringify(`${external.module}.${external.name}`)
        }.`,
      );
    }
    fields.set(operation.name, operation);
    this.#externalCapabilities.set(capability, fields);
    this.#hostDefinitions.push({
      definition: hostDefinition,
      capability,
      field: operation.name,
    });
    const parameterValues = declaration.parameters.map((parameter) =>
      name(parameter.name, parameter.span)
    );
    return [{
      name: hostDefinition,
      parameters: [],
      annotation: { kind: "function", parameter: hostParameter, result },
      body: {
        kind: "runtime-fault",
        message: `unbound Gleam external ${external.module}.${external.name}`,
        span: declaration.span,
      },
      span: declaration.span,
    }, {
      name: declaration.name,
      parameters: declaration.parameters.map((parameter) => parameter.name),
      annotation: declaredFunctionType(declaration, this.#typeResolver),
      body: applyMany(
        name(hostDefinition, declaration.span),
        [nestedTupleExpression(parameterValues, declaration.span)],
        declaration.span,
      ),
      span: declaration.span,
    }];
  }

  private hostCapabilities(): readonly FunctionalHostCapabilityDeclaration[] {
    return [...this.#externalCapabilities].map(([name, fields]) => ({
      name,
      fields: [...fields.values()],
    }));
  }

  private lowerConstant(declaration: GleamFunctionalConstant): FunctionalSurfaceDefinition {
    if (declaration.annotation !== null) this.#typeResolver.lower(declaration.annotation);
    return {
      name: declaration.name,
      parameters: [],
      annotation: declaration.annotation === null
        ? null
        : this.#typeResolver.lower(declaration.annotation),
      body: this.lowerExpression(declaration.value),
      span: declaration.span,
    };
  }

  private lowerExpression(expression: GleamFunctionalExpression): FunctionalSurfaceExpression {
    switch (expression.kind) {
      case "integer":
      case "boolean":
        return { ...expression };
      case "float":
        return { kind: "float-64", value: expression.value, span: expression.span };
      case "string":
        return { kind: "text", value: expression.value, span: expression.span };
      case "bit-array":
        return bitArrayExpression(expression.bytes, expression.span);
      case "panic":
        if (expression.message !== null && expression.message.kind !== "string") {
          throw new GleamFunctionalLoweringError(
            expression.message.span,
            "A Gleam panic message must be a static string for the portable functional runtime.",
          );
        }
        return {
          kind: "runtime-fault",
          message: expression.message?.value ?? "Gleam panic",
          span: expression.span,
        };
      case "unit":
        return { kind: "name", name: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, span: expression.span };
      case "capture":
        throw new GleamFunctionalLoweringError(
          expression.span,
          "A Gleam function capture placeholder must appear in a function call.",
        );
      case "name":
        if (this.#qualifiedImports.has(expression.name)) {
          return {
            kind: "name",
            name: this.#qualifiedImports.get(expression.name)!,
            span: expression.span,
          };
        }
        if (expression.name.includes(".")) return this.lowerRecordAccess(expression);
        return {
          kind: "name",
          name: expression.name,
          span: expression.span,
        };
      case "tuple": {
        let result = this.lowerExpression(expression.values.at(-1)!);
        for (let index = expression.values.length - 2; index >= 0; index--) {
          result = applyMany(
            { kind: "name", name: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, span: expression.span },
            [this.lowerExpression(expression.values[index]!), result],
            expression.span,
          );
        }
        return result;
      }
      case "list": {
        let result: FunctionalSurfaceExpression = expression.tail === null
          ? {
            kind: "name",
            name: GLEAM_LIST_NIL,
            span: expression.span,
          }
          : this.lowerExpression(expression.tail);
        for (let index = expression.values.length - 1; index >= 0; index--) {
          result = applyMany(
            { kind: "name", name: GLEAM_LIST_CONS, span: expression.span },
            [this.lowerExpression(expression.values[index]!), result],
            expression.span,
          );
        }
        return result;
      }
      case "lambda": {
        let result = this.lowerExpression(expression.body);
        for (let index = expression.parameters.length - 1; index >= 0; index--) {
          result = {
            kind: "lambda",
            parameter: expression.parameters[index]!,
            body: result,
            span: expression.span,
          };
        }
        return result;
      }
      case "call": {
        if (expression.arguments.some((argument) => argument.spread)) {
          return this.lowerRecordUpdate(expression);
        }
        const arguments_ = this.orderedCallArguments(expression);
        const captures = arguments_.filter((argument) => argument.kind === "capture");
        if (captures.length === 0) {
          return applyMany(
            this.lowerExpression(expression.callee),
            arguments_.map((argument) => this.lowerExpression(argument)),
            expression.span,
          );
        }
        if (captures.length !== 1) {
          throw new GleamFunctionalLoweringError(
            expression.span,
            `A Gleam function capture needs exactly one placeholder; received ${captures.length}.`,
          );
        }
        const parameter = `$gleam_capture_${this.#discardIndex++}`;
        return {
          kind: "lambda",
          parameter,
          body: applyMany(
            this.lowerExpression(expression.callee),
            arguments_.map((argument) =>
              argument.kind === "capture"
                ? name(parameter, argument.span)
                : this.lowerExpression(argument)
            ),
            expression.span,
          ),
          span: expression.span,
        };
      }
      case "let":
        return {
          kind: "let",
          name: expression.name,
          value: this.lowerExpression(expression.value),
          body: this.lowerExpression(expression.body),
          span: expression.span,
        };
      case "binary":
        return this.lowerBinary(expression);
      case "case":
        return this.lowerCase(expression);
    }
  }

  private lowerRecordUpdate(
    expression: Extract<GleamFunctionalExpression, { readonly kind: "call" }>,
  ): FunctionalSurfaceExpression {
    if (expression.callee.kind !== "name") {
      throw new GleamFunctionalLoweringError(
        expression.span,
        "A Gleam record update must name its record constructor.",
      );
    }
    const shape = this.#constructors.get(expression.callee.name);
    if (shape === undefined || shape.fields.some((field) => field === null)) {
      throw new GleamFunctionalLoweringError(
        expression.span,
        `Gleam record update constructor ${
          JSON.stringify(expression.callee.name)
        } must have labeled fields.`,
      );
    }
    const spreadArguments = expression.arguments.filter((argument) => argument.spread);
    if (spreadArguments.length !== 1 || expression.arguments[0] !== spreadArguments[0]) {
      throw new GleamFunctionalLoweringError(
        expression.span,
        "A Gleam record update needs exactly one leading spread value.",
      );
    }
    const overrides = new Map<string, GleamFunctionalExpression>();
    for (const argument of expression.arguments.slice(1)) {
      if (argument.label === null || argument.spread) {
        throw new GleamFunctionalLoweringError(
          argument.span,
          "Gleam record update fields must use labels.",
        );
      }
      if (!shape.fields.includes(argument.label)) {
        throw new GleamFunctionalLoweringError(
          argument.span,
          `Gleam record ${JSON.stringify(expression.callee.name)} has no field ${
            JSON.stringify(argument.label)
          }.`,
        );
      }
      if (overrides.has(argument.label)) {
        throw new GleamFunctionalLoweringError(
          argument.span,
          `Gleam record update repeats field ${JSON.stringify(argument.label)}.`,
        );
      }
      overrides.set(argument.label, argument.value);
    }
    const binders = shape.fields.map(() => `$gleam_update_${this.#discardIndex++}`);
    const fields = shape.fields.map((field, index) => {
      const override = overrides.get(field!);
      return override === undefined
        ? name(binders[index]!, expression.span)
        : this.lowerExpression(override);
    });
    return {
      kind: "case",
      value: this.lowerExpression(spreadArguments[0]!.value),
      arms: [{
        constructor: expression.callee.name,
        binders,
        body: applyMany(
          name(expression.callee.name, expression.callee.span),
          fields,
          expression.span,
        ),
        span: expression.span,
      }],
      span: expression.span,
    };
  }

  private lowerRecordAccess(
    expression: Extract<GleamFunctionalExpression, { readonly kind: "name" }>,
  ): FunctionalSurfaceExpression {
    const [base, ...fields] = expression.name.split(".");
    let current: FunctionalSurfaceExpression = name(base!, expression.span);
    for (const field of fields) current = this.lowerRecordField(current, field!, expression.span);
    return current;
  }

  private lowerRecordField(
    value: FunctionalSurfaceExpression,
    field: string,
    span: FunctionalSpan,
  ): FunctionalSurfaceExpression {
    const owners = [...this.#constructorsByOwner].flatMap(([owner, constructorNames]) => {
      const constructors = constructorNames.map((constructorName) =>
        this.#constructors.get(constructorName)!
      );
      if (constructors.length === 0) return [];
      const fieldIndices = constructors.map((constructor) => constructor.fields.indexOf(field));
      return fieldIndices.every((index) => index >= 0)
        ? [{ owner, constructorNames, fieldIndices }]
        : [];
    });
    if (owners.length !== 1) {
      const evidence = owners.length === 0
        ? "no local record type defines it on every constructor"
        : `it is shared by ${owners.map((candidate) => candidate.owner).join(", ")}`;
      throw new GleamFunctionalLoweringError(
        span,
        `Gleam record field ${JSON.stringify(field)} cannot be resolved because ${evidence}.`,
      );
    }
    const selected = owners[0]!;
    return {
      kind: "case",
      value,
      arms: selected.constructorNames.map((constructor, constructorIndex) => {
        const shape = this.#constructors.get(constructor)!;
        const binders = shape.fields.map(() => `$gleam_field_${this.#discardIndex++}`);
        return {
          constructor,
          binders,
          body: name(binders[selected.fieldIndices[constructorIndex]!]!, span),
          span,
        };
      }),
      span,
    };
  }

  private orderedCallArguments(
    expression: Extract<GleamFunctionalExpression, { readonly kind: "call" }>,
  ): readonly GleamFunctionalExpression[] {
    if (expression.callee.kind !== "name") {
      const labeled = expression.arguments.find((argument) => argument.label !== null);
      if (labeled !== undefined) {
        throw new GleamFunctionalLoweringError(
          labeled.span,
          `Gleam cannot apply label ${JSON.stringify(labeled.label)} to a function value.`,
        );
      }
      return expression.arguments.map((argument) => argument.value);
    }
    const resolvedName = this.#qualifiedImports.get(expression.callee.name) ??
      expression.callee.name;
    const labels = this.#callLabels.get(resolvedName) ??
      this.#constructors.get(expression.callee.name)?.fields;
    if (labels === undefined) {
      const labeled = expression.arguments.find((argument) => argument.label !== null);
      if (labeled !== undefined) {
        throw new GleamFunctionalLoweringError(
          labeled.span,
          `Gleam call to ${JSON.stringify(expression.callee.name)} has unknown label ${
            JSON.stringify(labeled.label)
          }.`,
        );
      }
      return expression.arguments.map((argument) => argument.value);
    }
    if (expression.arguments.length !== labels.length) {
      throw new GleamFunctionalLoweringError(
        expression.span,
        `Gleam call to ${
          JSON.stringify(expression.callee.name)
        } receives ${expression.arguments.length} arguments; expected ${labels.length}.`,
      );
    }
    const ordered: Array<GleamFunctionalExpression | undefined> = Array(labels.length);
    let positionalIndex = 0;
    let receivedLabel = false;
    for (const argument of expression.arguments) {
      if (argument.label === null) {
        if (receivedLabel) {
          throw new GleamFunctionalLoweringError(
            argument.span,
            `Gleam call to ${
              JSON.stringify(expression.callee.name)
            } places a positional argument after a labeled argument.`,
          );
        }
        ordered[positionalIndex++] = argument.value;
        continue;
      }
      receivedLabel = true;
      const index = labels.indexOf(argument.label);
      if (index < 0) {
        throw new GleamFunctionalLoweringError(
          argument.span,
          `Gleam call to ${JSON.stringify(expression.callee.name)} has unknown label ${
            JSON.stringify(argument.label)
          }.`,
        );
      }
      if (ordered[index] !== undefined) {
        throw new GleamFunctionalLoweringError(
          argument.span,
          `Gleam call to ${JSON.stringify(expression.callee.name)} repeats argument ${
            JSON.stringify(argument.label)
          }.`,
        );
      }
      ordered[index] = argument.value;
    }
    const missing = ordered.findIndex((argument) => argument === undefined);
    if (missing >= 0) {
      throw new GleamFunctionalLoweringError(
        expression.span,
        `Gleam call to ${JSON.stringify(expression.callee.name)} omits argument ${
          JSON.stringify(labels[missing] ?? missing)
        }.`,
      );
    }
    return ordered as readonly GleamFunctionalExpression[];
  }

  private lowerBinary(
    expression: Extract<GleamFunctionalExpression, { readonly kind: "binary" }>,
  ): FunctionalSurfaceExpression {
    const left = this.lowerExpression(expression.left);
    const right = this.lowerExpression(expression.right);
    if (expression.operator === "&&") {
      return {
        kind: "if",
        condition: left,
        consequent: right,
        alternate: { kind: "boolean", value: false, span: expression.span },
        span: expression.span,
      };
    }
    if (expression.operator === "||") {
      return {
        kind: "if",
        condition: left,
        consequent: { kind: "boolean", value: true, span: expression.span },
        alternate: right,
        span: expression.span,
      };
    }
    if (expression.operator === "%") {
      const quotient: FunctionalSurfaceExpression = {
        kind: "binary",
        operator: FunctionalBinaryOperator.Divide,
        left,
        right,
        span: expression.span,
      };
      return {
        kind: "binary",
        operator: FunctionalBinaryOperator.Subtract,
        left,
        right: {
          kind: "binary",
          operator: FunctionalBinaryOperator.Multiply,
          left: quotient,
          right,
          span: expression.span,
        },
        span: expression.span,
      };
    }
    if (expression.operator === "/.") {
      return {
        kind: "if",
        condition: {
          kind: "binary",
          operator: FunctionalBinaryOperator.EqualFloat64,
          left: right,
          right: { kind: "float-64", value: 0, span: expression.right.span },
          span: expression.span,
        },
        consequent: { kind: "float-64", value: 0, span: expression.span },
        alternate: {
          kind: "binary",
          operator: FunctionalBinaryOperator.DivideFloat64,
          left,
          right,
          span: expression.span,
        },
        span: expression.span,
      };
    }
    return {
      kind: "binary",
      operator: binaryOperators[expression.operator]!,
      left,
      right,
      span: expression.span,
    };
  }

  private lowerCase(
    expression: Extract<GleamFunctionalExpression, { readonly kind: "case" }>,
  ): FunctionalSurfaceExpression {
    if (expression.arms.length === 0) {
      throw new GleamFunctionalLoweringError(
        expression.span,
        "Gleam case expressions need an arm.",
      );
    }
    for (const arm of expression.arms) {
      if (arm.patterns.length !== expression.subjects.length) {
        throw new GleamFunctionalLoweringError(
          arm.span,
          `Gleam case arm has ${arm.patterns.length} patterns for ${expression.subjects.length} subjects.`,
        );
      }
    }
    if (expression.subjects.length !== 1 || expression.arms.some((arm) => arm.guard !== null)) {
      return this.lowerSequentialCase(expression);
    }
    const subject = this.lowerExpression(expression.subjects[0]!);
    const patterns = expression.arms.map((arm) => arm.patterns[0]!);
    if (patterns.every((pattern) => isScalarPattern(pattern))) {
      return this.lowerScalarCase(subject, expression.arms, expression.span);
    }
    const hasNestedConstructorPattern = patterns.some((pattern) => {
      if (pattern.kind === "variable" || pattern.kind === "discard") return false;
      if (
        pattern.kind !== "constructor" && pattern.kind !== "list-cons" &&
        pattern.kind !== "list-nil" && pattern.kind !== "tuple" && pattern.kind !== "unit"
      ) return true;
      return this.normalizeConstructorPattern(pattern).arguments.some((argument) =>
        argument.kind !== "variable" && argument.kind !== "discard"
      );
    });
    if (hasNestedConstructorPattern) return this.lowerSequentialCase(expression);
    return {
      kind: "case",
      value: subject,
      arms: this.lowerConstructorArms(expression.arms),
      span: expression.span,
    };
  }

  private lowerSequentialCase(
    expression: Extract<GleamFunctionalExpression, { readonly kind: "case" }>,
  ): FunctionalSurfaceExpression {
    const finalArm = expression.arms.at(-1)!;
    if (
      finalArm.guard !== null ||
      finalArm.patterns.some((pattern) => !isIrrefutablePattern(pattern))
    ) {
      throw new GleamFunctionalLoweringError(
        finalArm.span,
        "A Gleam case using guards, multiple subjects, or nested patterns needs a final unguarded variable or discard arm.",
      );
    }
    const subjectNames = expression.subjects.map(() => `$gleam_case_${this.#discardIndex++}`);
    let result = this.lowerPatternSequence(
      subjectNames,
      finalArm.patterns,
      this.lowerExpression(finalArm.body),
      null,
    );
    for (let index = expression.arms.length - 2; index >= 0; index--) {
      const arm = expression.arms[index]!;
      const fallbackName = `$gleam_case_fallback_${this.#discardIndex++}`;
      const fallbackParameter = this.discardName();
      const fallback = applyMany(
        name(fallbackName, arm.span),
        [name(FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, arm.span)],
        arm.span,
      );
      const body = this.lowerExpression(arm.body);
      const success = arm.guard === null ? body : {
        kind: "if" as const,
        condition: this.lowerExpression(arm.guard),
        consequent: body,
        alternate: fallback,
        span: arm.span,
      };
      const attempt = this.lowerPatternSequence(
        subjectNames,
        arm.patterns,
        success,
        fallback,
      );
      result = {
        kind: "let",
        name: fallbackName,
        value: {
          kind: "lambda",
          parameter: fallbackParameter,
          body: result,
          span: arm.span,
        },
        body: attempt,
        span: arm.span,
      };
    }
    for (let index = expression.subjects.length - 1; index >= 0; index--) {
      result = {
        kind: "let",
        name: subjectNames[index]!,
        value: this.lowerExpression(expression.subjects[index]!),
        body: result,
        span: expression.span,
      };
    }
    return result;
  }

  private lowerPatternSequence(
    subjects: readonly string[],
    patterns: readonly GleamFunctionalPattern[],
    success: FunctionalSurfaceExpression,
    failure: FunctionalSurfaceExpression | null,
  ): FunctionalSurfaceExpression {
    let result = success;
    for (let index = patterns.length - 1; index >= 0; index--) {
      result = this.lowerPattern(subjects[index]!, patterns[index]!, result, failure);
    }
    return result;
  }

  private lowerPattern(
    subjectName: string,
    pattern: GleamFunctionalPattern,
    success: FunctionalSurfaceExpression,
    failure: FunctionalSurfaceExpression | null,
  ): FunctionalSurfaceExpression {
    const subject = name(subjectName, pattern.span);
    if (pattern.kind === "variable") {
      return { kind: "let", name: pattern.name, value: subject, body: success, span: pattern.span };
    }
    if (pattern.kind === "discard") return success;
    if (pattern.kind === "alias") {
      return {
        kind: "let",
        name: pattern.name,
        value: subject,
        body: this.lowerPattern(subjectName, pattern.pattern, success, failure),
        span: pattern.span,
      };
    }
    if (failure === null) {
      throw new GleamFunctionalLoweringError(
        pattern.span,
        "The final Gleam case arm must match every remaining value.",
      );
    }
    if (
      pattern.kind === "integer" || pattern.kind === "boolean" || pattern.kind === "bit-array"
    ) {
      return {
        kind: "if",
        condition: {
          kind: "binary",
          operator: pattern.kind === "integer"
            ? FunctionalBinaryOperator.Equal
            : FunctionalBinaryOperator.StructuralEqual,
          left: subject,
          right: scalarPatternValue(pattern),
          span: pattern.span,
        },
        consequent: success,
        alternate: failure,
        span: pattern.span,
      };
    }
    const normalized = this.normalizeConstructorPattern(pattern);
    const selected = this.#constructors.get(normalized.constructor);
    if (selected === undefined) {
      throw new GleamFunctionalLoweringError(
        pattern.span,
        `Gleam case references unknown constructor ${JSON.stringify(normalized.constructor)}.`,
      );
    }
    if (normalized.arguments.length !== selected.fields.length) {
      throw new GleamFunctionalLoweringError(
        pattern.span,
        `Gleam constructor ${
          JSON.stringify(normalized.constructor)
        } receives ${normalized.arguments.length} patterns; expected ${selected.fields.length}.`,
      );
    }
    const constructors = this.#constructorsByOwner.get(selected.owner);
    if (constructors === undefined) {
      throw new Error(`Gleam lowering omitted constructors for ${selected.owner}.`);
    }
    return {
      kind: "case",
      value: subject,
      arms: constructors.map((constructor) => {
        const shape = this.#constructors.get(constructor)!;
        const binders = Array.from({ length: shape.fields.length }, () => this.discardName());
        return {
          constructor,
          binders,
          body: constructor === normalized.constructor
            ? this.lowerPatternSequence(binders, normalized.arguments, success, failure)
            : failure,
          span: pattern.span,
        };
      }),
      span: pattern.span,
    };
  }

  private lowerScalarCase(
    subject: FunctionalSurfaceExpression,
    arms: Extract<GleamFunctionalExpression, { readonly kind: "case" }>["arms"],
    span: FunctionalSpan,
  ): FunctionalSurfaceExpression {
    const subjectName = `$gleam_case_${this.#discardIndex++}`;
    let fallback: FunctionalSurfaceExpression | null = null;
    for (let index = arms.length - 1; index >= 0; index--) {
      const arm = arms[index]!;
      const pattern = arm.patterns[0]!;
      if (arm.guard !== null) {
        throw new Error("Scalar Gleam case retained an unexpected guard.");
      }
      const body = this.lowerExpression(arm.body);
      if (pattern.kind === "variable" || pattern.kind === "discard") {
        if (fallback !== null) {
          throw new GleamFunctionalLoweringError(
            pattern.span,
            "A scalar Gleam catch-all case arm must be last.",
          );
        }
        fallback = pattern.kind === "variable"
          ? {
            kind: "let",
            name: pattern.name,
            value: name(subjectName, pattern.span),
            body,
            span: arm.span,
          }
          : body;
        continue;
      }
      if (fallback === null) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          "Scalar Gleam case expressions require a final variable or discard arm.",
        );
      }
      if (
        pattern.kind !== "integer" && pattern.kind !== "boolean" &&
        pattern.kind !== "bit-array"
      ) {
        throw new Error(`Gleam scalar case retained unexpected pattern ${pattern.kind}.`);
      }
      fallback = {
        kind: "if",
        condition: {
          kind: "binary",
          operator: pattern.kind === "integer"
            ? FunctionalBinaryOperator.Equal
            : FunctionalBinaryOperator.StructuralEqual,
          left: name(subjectName, pattern.span),
          right: scalarPatternValue(pattern),
          span: pattern.span,
        },
        consequent: body,
        alternate: fallback,
        span: arm.span,
      };
    }
    if (fallback === null) throw new Error("Gleam scalar case lowering omitted its fallback.");
    return { kind: "let", name: subjectName, value: subject, body: fallback, span };
  }

  private lowerConstructorArms(
    arms: Extract<GleamFunctionalExpression, { readonly kind: "case" }>["arms"],
  ): readonly FunctionalSurfaceCaseArm[] {
    const lowered: FunctionalSurfaceCaseArm[] = [];
    let owner: string | null = null;
    let catchAll: typeof arms[number] | null = null;
    for (const arm of arms) {
      const pattern = arm.patterns[0]!;
      if (pattern.kind === "variable" || pattern.kind === "discard") {
        if (catchAll !== null) {
          throw new GleamFunctionalLoweringError(
            pattern.span,
            "Gleam case repeats a catch-all arm.",
          );
        }
        catchAll = arm;
        continue;
      }
      if (catchAll !== null) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          "A Gleam catch-all case arm must be last.",
        );
      }
      const normalized = this.normalizeConstructorPattern(pattern);
      const shape = this.#constructors.get(normalized.constructor);
      if (shape === undefined) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          `Gleam case references unknown constructor ${JSON.stringify(normalized.constructor)}.`,
        );
      }
      if (owner !== null && owner !== shape.owner) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          `Gleam case mixes constructors from ${JSON.stringify(owner)} and ${
            JSON.stringify(shape.owner)
          }.`,
        );
      }
      if (normalized.arguments.length !== shape.fields.length) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          `Gleam constructor ${
            JSON.stringify(normalized.constructor)
          } receives ${normalized.arguments.length} patterns; expected ${shape.fields.length}.`,
        );
      }
      owner = shape.owner;
      lowered.push({
        constructor: normalized.constructor,
        binders: normalized.arguments.map((argument) => this.lowerPatternBinder(argument)),
        body: this.lowerExpression(arm.body),
        span: arm.span,
      });
    }
    if (owner === null) {
      throw new GleamFunctionalLoweringError(
        arms[0]!.span,
        "A constructor Gleam case needs at least one constructor pattern.",
      );
    }
    const constructors = this.#constructorsByOwner.get(owner);
    if (constructors === undefined) {
      throw new Error(`Gleam lowering omitted constructors for ${owner}.`);
    }
    const covered = new Set(lowered.map((arm) => arm.constructor));
    if (catchAll !== null) {
      const pattern = catchAll.patterns[0]!;
      for (const constructor of constructors) {
        if (covered.has(constructor)) continue;
        const shape = this.#constructors.get(constructor)!;
        const binders = Array.from({ length: shape.fields.length }, () => this.discardName());
        let body = this.lowerExpression(catchAll!.body);
        if (pattern.kind === "variable") {
          body = {
            kind: "let",
            name: pattern.name,
            value: applyMany(
              name(constructor, pattern.span),
              binders.map((binder) => name(binder, pattern.span)),
              pattern.span,
            ),
            body,
            span: catchAll.span,
          };
        }
        lowered.push({ constructor, binders, body, span: catchAll.span });
      }
    }
    const missing = constructors.filter((constructor) =>
      !lowered.some((arm) => arm.constructor === constructor)
    );
    if (missing.length > 0) {
      throw new GleamFunctionalLoweringError(
        arms[0]!.span,
        `Gleam case is not exhaustive; missing ${
          missing.map((value) => JSON.stringify(value)).join(", ")
        }.`,
      );
    }
    return lowered;
  }

  private normalizeConstructorPattern(pattern: GleamFunctionalPattern): {
    readonly constructor: string;
    readonly arguments: readonly GleamFunctionalPattern[];
  } {
    if (pattern.kind === "list-nil") return { constructor: GLEAM_LIST_NIL, arguments: [] };
    if (pattern.kind === "list-cons") {
      return { constructor: GLEAM_LIST_CONS, arguments: [pattern.head, pattern.tail] };
    }
    if (pattern.kind === "tuple") {
      return {
        constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
        arguments: nestedTuplePatternArguments(pattern),
      };
    }
    if (pattern.kind === "unit") {
      return { constructor: FUNCTIONAL_UNIT_CONSTRUCTOR_NAME, arguments: [] };
    }
    if (pattern.kind !== "constructor") {
      throw new GleamFunctionalLoweringError(
        pattern.span,
        `Gleam pattern ${JSON.stringify(pattern.kind)} cannot select an algebraic constructor.`,
      );
    }
    const shape = this.#constructors.get(pattern.name);
    if (shape === undefined) {
      throw new GleamFunctionalLoweringError(
        pattern.span,
        `Gleam case references unknown constructor ${JSON.stringify(pattern.name)}.`,
      );
    }
    const ordered: Array<GleamFunctionalPattern | undefined> = Array(shape.fields.length);
    let positionalIndex = 0;
    let receivedLabel = false;
    for (const argument of pattern.arguments) {
      if (argument.label === null) {
        if (receivedLabel) {
          throw new GleamFunctionalLoweringError(
            argument.span,
            `Gleam pattern ${
              JSON.stringify(pattern.name)
            } places a positional field after a labeled field.`,
          );
        }
        if (positionalIndex >= ordered.length) {
          throw new GleamFunctionalLoweringError(
            argument.span,
            `Gleam pattern ${JSON.stringify(pattern.name)} has too many positional fields.`,
          );
        }
        ordered[positionalIndex++] = argument.value;
        continue;
      }
      receivedLabel = true;
      const index = shape.fields.indexOf(argument.label);
      if (index < 0) {
        throw new GleamFunctionalLoweringError(
          argument.span,
          `Gleam pattern ${JSON.stringify(pattern.name)} has unknown field ${
            JSON.stringify(argument.label)
          }.`,
        );
      }
      if (ordered[index] !== undefined) {
        throw new GleamFunctionalLoweringError(
          argument.span,
          `Gleam pattern ${JSON.stringify(pattern.name)} repeats field ${
            JSON.stringify(argument.label)
          }.`,
        );
      }
      ordered[index] = argument.value;
    }
    for (let index = 0; index < ordered.length; index++) {
      if (ordered[index] !== undefined) continue;
      if (!pattern.discardRemaining) {
        throw new GleamFunctionalLoweringError(
          pattern.span,
          `Gleam pattern ${JSON.stringify(pattern.name)} omits field ${
            JSON.stringify(shape.fields[index] ?? index)
          } without '..'.`,
        );
      }
      ordered[index] = { kind: "discard", span: pattern.span };
    }
    return { constructor: pattern.name, arguments: ordered as readonly GleamFunctionalPattern[] };
  }

  private lowerPatternBinder(pattern: GleamFunctionalPattern): string {
    if (pattern.kind === "variable") return pattern.name;
    if (pattern.kind === "discard") return this.discardName();
    throw new GleamFunctionalLoweringError(
      pattern.span,
      "Nested Gleam constructor patterns currently accept only variables and discards.",
    );
  }

  private discardName(): string {
    return `$gleam_discard_${this.#discardIndex++}`;
  }
}

class GleamTypeResolver {
  readonly #aliases = new Map<string, GleamFunctionalTypeAlias>();
  readonly #nominals = new Map<string, { readonly name: string; readonly arity: number }>([
    ["List", { name: GLEAM_LIST_TYPE, arity: 1 }],
    ["String", { name: FUNCTIONAL_TEXT_TYPE_NAME, arity: 0 }],
    ["BitArray", { name: GLEAM_BIT_ARRAY_TYPE, arity: 0 }],
  ]);
  readonly #localTypes = new Set<string>();

  constructor(
    private readonly module: GleamFunctionalModule,
    availableExports: readonly GleamFunctionalExportSignature[],
  ) {
    for (const declaration of module.declarations) {
      if (declaration.kind === "type") {
        this.#localTypes.add(declaration.name);
        this.#nominals.set(declaration.name, {
          name: declaration.name,
          arity: declaration.parameters.length,
        });
      } else if (declaration.kind === "type-alias") {
        this.#localTypes.add(declaration.name);
        this.#aliases.set(declaration.name, declaration);
      }
    }
    for (const declaration of module.imports) {
      const exportedTypes = availableExports.filter((candidate): candidate is Extract<
        GleamFunctionalExportSignature,
        { readonly kind: "type" }
      > => candidate.kind === "type" && candidate.module === declaration.module);
      if (declaration.names.length === 0) {
        const qualifier = declaration.module.split("/").at(-1)!;
        for (const exported of exportedTypes) {
          this.#nominals.set(`${qualifier}.${exported.name}`, {
            name: qualifiedTypeImportName(declaration.module, exported.name),
            arity: exported.arity,
          });
        }
        continue;
      }
      for (const imported of declaration.names) {
        if (imported.kind !== "type") continue;
        const exported = exportedTypes.find((candidate) => candidate.name === imported.name);
        if (exported === undefined) continue;
        this.#nominals.set(imported.alias, { name: imported.alias, arity: exported.arity });
      }
    }
  }

  isLocalTypeName(name: string): boolean {
    return this.#localTypes.has(name);
  }

  validateAliases(): void {
    for (const alias of this.#aliases.values()) {
      requireUniqueNames(
        alias.parameters,
        alias.span,
        `type alias ${JSON.stringify(alias.name)} parameters`,
      );
      requireDeclaredTypeParameters(alias.type, new Set(alias.parameters), alias.name);
      const arguments_ = alias.parameters.map((name): GleamFunctionalType => ({
        kind: "parameter",
        name,
        span: alias.span,
      }));
      this.lower({ kind: "named", name: alias.name, arguments: arguments_, span: alias.span });
    }
  }

  lower(
    type: GleamFunctionalType,
    substitutions: ReadonlyMap<string, FunctionalTypeSchema> = new Map(),
    aliasStack: readonly string[] = [],
  ): FunctionalTypeSchema {
    switch (type.kind) {
      case "integer":
      case "boolean":
      case "unit":
        return { kind: type.kind };
      case "float":
        return { kind: "float-64" };
      case "parameter":
        return substitutions.get(type.name) ?? { kind: "parameter", name: type.name };
      case "tuple": {
        let result = this.lower(type.values.at(-1)!, substitutions, aliasStack);
        for (let index = type.values.length - 2; index >= 0; index--) {
          result = {
            kind: "tuple",
            values: [this.lower(type.values[index]!, substitutions, aliasStack), result],
          };
        }
        return result;
      }
      case "function":
        return curryType(
          type.parameters.map((parameter) => this.lower(parameter, substitutions, aliasStack)),
          this.lower(type.result, substitutions, aliasStack),
        );
      case "named": {
        const alias = this.#aliases.get(type.name);
        if (alias !== undefined) {
          if (type.arguments.length !== alias.parameters.length) {
            throw this.invalidArity(type, alias.parameters.length);
          }
          if (aliasStack.includes(alias.name)) {
            throw new GleamFunctionalLoweringError(
              type.span,
              `Gleam type alias cycle ${[...aliasStack, alias.name].join(" -> ")}.`,
            );
          }
          const expanded = new Map(substitutions);
          for (let index = 0; index < alias.parameters.length; index++) {
            expanded.set(
              alias.parameters[index]!,
              this.lower(type.arguments[index]!, substitutions, aliasStack),
            );
          }
          return this.lower(alias.type, expanded, [...aliasStack, alias.name]);
        }
        const nominal = this.#nominals.get(type.name);
        if (nominal === undefined) {
          throw new GleamFunctionalLoweringError(
            type.span,
            `Gleam type ${JSON.stringify(type.name)} is not declared in module ${
              JSON.stringify(this.module.name)
            }.`,
          );
        }
        if (type.arguments.length !== nominal.arity) {
          throw this.invalidArity(type, nominal.arity);
        }
        return {
          kind: "named",
          name: nominal.name,
          arguments: type.arguments.map((argument) =>
            this.lower(argument, substitutions, aliasStack)
          ),
        };
      }
    }
  }

  private invalidArity(
    type: Extract<GleamFunctionalType, { readonly kind: "named" }>,
    expected: number,
  ): GleamFunctionalLoweringError {
    return new GleamFunctionalLoweringError(
      type.span,
      `Gleam type ${
        JSON.stringify(type.name)
      } receives ${type.arguments.length} arguments; expected ${expected}.`,
    );
  }
}

function qualifiedValueImportName(module: string, name: string): string {
  return `$gleam_value:${module}.${name}`;
}

function qualifiedTypeImportName(module: string, name: string): string {
  return `$gleam_type:${module}.${name}`;
}

function qualifiedConstructorImportName(module: string, name: string): string {
  return `$gleam_constructor:${module}.${name}`;
}

function declaredFunctionType(
  declaration: GleamFunctionalFunction,
  typeResolver: GleamTypeResolver,
): FunctionalTypeSchema | null {
  if (
    declaration.parameters.some((parameter) => parameter.annotation === null) ||
    declaration.result === null
  ) {
    return null;
  }
  const parameters = declaration.parameters.map((parameter) =>
    typeResolver.lower(parameter.annotation!)
  );
  return curryType(parameters, typeResolver.lower(declaration.result));
}

function declaredConstantType(
  declaration: GleamFunctionalConstant,
  typeResolver: GleamTypeResolver,
): FunctionalTypeSchema | null {
  if (declaration.annotation === null) return null;
  return typeResolver.lower(declaration.annotation);
}

function curryType(
  parameters: readonly FunctionalTypeSchema[],
  result: FunctionalTypeSchema,
): FunctionalTypeSchema {
  let current = result;
  for (let index = parameters.length - 1; index >= 0; index--) {
    current = { kind: "function", parameter: parameters[index]!, result: current };
  }
  return current;
}

function nestedTupleSchema(
  values:
    | readonly [FunctionalTypeSchema, ...FunctionalTypeSchema[]]
    | readonly FunctionalTypeSchema[],
): FunctionalTypeSchema {
  if (values.length === 0) throw new Error("A host operation parameter list cannot be empty.");
  let result = values.at(-1)!;
  for (let index = values.length - 2; index >= 0; index--) {
    result = { kind: "tuple", values: [values[index]!, result] };
  }
  return result;
}

function nestedTupleExpression(
  values: readonly FunctionalSurfaceExpression[],
  span: FunctionalSpan,
): FunctionalSurfaceExpression {
  if (values.length === 0) throw new Error("A host operation argument list cannot be empty.");
  let result = values.at(-1)!;
  for (let index = values.length - 2; index >= 0; index--) {
    result = applyMany(
      name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME, span),
      [values[index]!, result],
      span,
    );
  }
  return result;
}

function schemaContainsParameter(schema: FunctionalTypeSchema): boolean {
  switch (schema.kind) {
    case "parameter":
    case "forall":
      return true;
    case "tuple":
      return schemaContainsParameter(schema.values[0]) || schemaContainsParameter(schema.values[1]);
    case "named":
      return schema.arguments.some(schemaContainsParameter);
    case "function":
      return schemaContainsParameter(schema.parameter) || schemaContainsParameter(schema.result);
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
      return false;
  }
}

function requireDeclaredTypeParameters(
  type: GleamFunctionalType,
  parameters: ReadonlySet<string>,
  declarationName: string,
): void {
  switch (type.kind) {
    case "integer":
    case "float":
    case "boolean":
    case "unit":
      return;
    case "parameter":
      if (parameters.has(type.name)) return;
      throw new GleamFunctionalLoweringError(
        type.span,
        `Type ${JSON.stringify(declarationName)} uses undeclared parameter ${
          JSON.stringify(type.name)
        }.`,
      );
    case "tuple":
      for (const value of type.values) {
        requireDeclaredTypeParameters(value, parameters, declarationName);
      }
      return;
    case "named":
      for (const argument of type.arguments) {
        requireDeclaredTypeParameters(argument, parameters, declarationName);
      }
      return;
    case "function":
      for (const parameter of type.parameters) {
        requireDeclaredTypeParameters(parameter, parameters, declarationName);
      }
      requireDeclaredTypeParameters(type.result, parameters, declarationName);
  }
}

function nestedTuplePatternArguments(
  pattern: Extract<GleamFunctionalPattern, { readonly kind: "tuple" }>,
): readonly [GleamFunctionalPattern, GleamFunctionalPattern] {
  let tail = pattern.values.at(-1)!;
  for (let index = pattern.values.length - 2; index >= 1; index--) {
    tail = {
      kind: "tuple",
      values: [pattern.values[index]!, tail],
      span: pattern.span,
    };
  }
  return [pattern.values[0], tail];
}

function isScalarPattern(pattern: GleamFunctionalPattern): boolean {
  return pattern.kind === "integer" || pattern.kind === "boolean" ||
    pattern.kind === "bit-array" || pattern.kind === "variable" || pattern.kind === "discard";
}

function isIrrefutablePattern(pattern: GleamFunctionalPattern): boolean {
  if (pattern.kind === "variable" || pattern.kind === "discard") return true;
  return pattern.kind === "alias" && isIrrefutablePattern(pattern.pattern);
}

function scalarPatternValue(
  pattern: Extract<
    GleamFunctionalPattern,
    { readonly kind: "integer" | "boolean" | "bit-array" }
  >,
): FunctionalSurfaceExpression {
  if (pattern.kind === "integer") {
    return { kind: "integer", value: pattern.value, span: pattern.span };
  }
  if (pattern.kind === "boolean") {
    return { kind: "boolean", value: pattern.value, span: pattern.span };
  }
  return bitArrayExpression(pattern.bytes, pattern.span);
}

function applyMany(
  callee: FunctionalSurfaceExpression,
  arguments_: readonly FunctionalSurfaceExpression[],
  span: FunctionalSpan,
): FunctionalSurfaceExpression {
  let result = callee;
  for (const argument of arguments_) {
    result = { kind: "apply", callee: result, argument, span };
  }
  return result;
}

function name(value: string, span: FunctionalSpan): FunctionalSurfaceExpression {
  return { kind: "name", name: value, span };
}

function bitArrayExpression(
  bytes: Uint8Array,
  span: FunctionalSpan,
): FunctionalSurfaceExpression {
  return applyMany(
    name(GLEAM_BIT_ARRAY_VALUE, span),
    [
      { kind: "bytes", value: bytes, span },
      { kind: "integer", value: bytes.byteLength * 8, span },
    ],
    span,
  );
}

function gleamListDeclaration(sourceByteLength: number): FunctionalSurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: GLEAM_LIST_TYPE,
    parameters: ["value"],
    span,
    constructors: [
      { name: GLEAM_LIST_NIL, fields: [], span },
      {
        name: GLEAM_LIST_CONS,
        span,
        fields: [
          { name: "head", type: { kind: "parameter", name: "value" }, span },
          {
            name: "tail",
            type: {
              kind: "named",
              name: GLEAM_LIST_TYPE,
              arguments: [{ kind: "parameter", name: "value" }],
            },
            span,
          },
        ],
      },
    ],
  };
}

function gleamBitArrayDeclaration(sourceByteLength: number): FunctionalSurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: GLEAM_BIT_ARRAY_TYPE,
    parameters: [],
    span,
    constructors: [{
      name: GLEAM_BIT_ARRAY_VALUE,
      span,
      fields: [
        {
          name: "bytes",
          type: { kind: "named", name: FUNCTIONAL_BYTES_TYPE_NAME, arguments: [] },
          span,
        },
        { name: "bitLength", type: { kind: "integer" }, span },
      ],
    }],
  };
}

function requireUniqueNames(
  names: readonly string[],
  span: FunctionalSpan,
  location: string,
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      continue;
    }
    throw new GleamFunctionalLoweringError(
      span,
      `Gleam ${location} repeat ${JSON.stringify(name)}.`,
    );
  }
}
