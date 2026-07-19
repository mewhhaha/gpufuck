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
  FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME,
  type FunctionalHostCapabilityDeclaration,
  type FunctionalHostOperationDeclaration,
  FunctionalWasmIntrinsic,
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
const GLEAM_RESULT_TYPE = "$GleamResult";
const GLEAM_RESULT_OK = "Ok";
const GLEAM_RESULT_ERROR = "Error";
export const GLEAM_FUNCTIONAL_PRELUDE_MODULE = "$gleam/prelude";
const TUPLE_OWNER = "$TupleType";
const GLEAM_TEXT_INTRINSIC_CAPABILITY = "$GleamTextIntrinsics";
const GLEAM_BIT_PATTERN_CAPABILITY = "$GleamBitPatternIntrinsics";
const GLEAM_TEXT_BYTE_LENGTH = "$gleam_text_byte_length";
const GLEAM_TEXT_BYTE_SLICE = "$gleam_text_byte_slice";

const binaryOperators: Readonly<Record<string, FunctionalBinaryOperator>> = {
  "==": FunctionalBinaryOperator.StructuralEqual,
  "!=": FunctionalBinaryOperator.StructuralNotEqual,
  "<": FunctionalBinaryOperator.LessWholeNumberF64,
  "<=": FunctionalBinaryOperator.LessEqualWholeNumberF64,
  ">": FunctionalBinaryOperator.GreaterWholeNumberF64,
  ">=": FunctionalBinaryOperator.GreaterEqualWholeNumberF64,
  "<.": FunctionalBinaryOperator.LessFloat64,
  "<=.": FunctionalBinaryOperator.LessEqualFloat64,
  ">.": FunctionalBinaryOperator.GreaterFloat64,
  ">=.": FunctionalBinaryOperator.GreaterEqualFloat64,
  "+": FunctionalBinaryOperator.AddWholeNumberF64,
  "-": FunctionalBinaryOperator.SubtractWholeNumberF64,
  "*": FunctionalBinaryOperator.MultiplyWholeNumberF64,
  "/": FunctionalBinaryOperator.DivideWholeNumberF64,
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
  const exportTypeNames = new Map(
    module.declarations.flatMap((declaration) =>
      declaration.kind === "type"
        ? [[declaration.name, qualifiedGleamTypeName(module.name, declaration.name)] as const]
        : []
    ),
  );
  for (const importedModule of module.imports) {
    const qualifier = importedModule.alias ?? importedModule.module.split("/").at(-1)!;
    const exportedTypes = availableExports.filter((candidate): candidate is Extract<
      GleamFunctionalExportSignature,
      { readonly kind: "type" }
    > => candidate.kind === "type" && candidate.module === importedModule.module);
    for (const exported of exportedTypes) {
      const linkedName = qualifiedGleamTypeName(importedModule.module, exported.name);
      exportTypeNames.set(
        `${qualifier}.${exported.name}`,
        linkedName,
      );
      exportTypeNames.set(
        qualifiedTypeImportName(importedModule.module, exported.name),
        linkedName,
      );
    }
    for (const imported of importedModule.names) {
      if (imported.kind !== "type") continue;
      exportTypeNames.set(
        imported.alias,
        qualifiedGleamTypeName(importedModule.module, imported.name),
      );
    }
  }
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
      type: qualifyGleamExportType(
        declaration.kind === "function"
          ? declaredFunctionType(declaration, typeResolver)
          : declaredConstantType(declaration, typeResolver),
        exportTypeNames,
      ),
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

export function gleamFunctionalPreludeArtifact(): FunctionalModuleArtifact {
  return createFunctionalModuleArtifact({
    name: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
    definitions: [],
    typeDeclarations: [
      gleamListDeclaration(0),
      gleamBitArrayDeclaration(0),
      gleamResultDeclaration(0),
    ],
    imports: [],
    exports: [],
    typeExports: [
      { name: "List", declaration: GLEAM_LIST_TYPE },
      { name: "BitArray", declaration: GLEAM_BIT_ARRAY_TYPE },
      { name: "Result", declaration: GLEAM_RESULT_TYPE },
    ],
    constructorExports: [
      { name: "ListNil", constructor: GLEAM_LIST_NIL },
      { name: "ListCons", constructor: GLEAM_LIST_CONS },
      { name: "BitArray", constructor: GLEAM_BIT_ARRAY_VALUE },
      { name: "Ok", constructor: GLEAM_RESULT_OK },
      { name: "Error", constructor: GLEAM_RESULT_ERROR },
    ],
    sourceByteLength: 0,
    options: { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
  });
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
  readonly #intrinsicDefinitions: FunctionalSurfaceDefinition[] = [];
  #textIntrinsicsRegistered = false;
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
    ];
    const sourceDefinitions = this.module.declarations.flatMap((declaration) =>
      declaration.kind === "function"
        ? declaration.external === null || declaration.body !== null
          ? [this.lowerFunction(declaration)]
          : this.lowerExternalFunction(declaration)
        : declaration.kind === "constant"
        ? [this.lowerConstant(declaration)]
        : []
    );
    const definitions = [...sourceDefinitions, ...this.#intrinsicDefinitions];
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
    this.#constructors.set(GLEAM_RESULT_OK, {
      owner: GLEAM_RESULT_TYPE,
      fields: [null],
      span,
    });
    this.#constructors.set(GLEAM_RESULT_ERROR, {
      owner: GLEAM_RESULT_TYPE,
      fields: [null],
      span,
    });
    this.#constructorsByOwner.set(GLEAM_RESULT_TYPE, [GLEAM_RESULT_OK, GLEAM_RESULT_ERROR]);
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
    const types: NonNullable<FunctionalModuleArtifact["typeImports"]>[number][] = [
      { name: GLEAM_LIST_TYPE, fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE, exportName: "List" },
      {
        name: GLEAM_BIT_ARRAY_TYPE,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "BitArray",
      },
      {
        name: GLEAM_RESULT_TYPE,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "Result",
      },
    ];
    const constructors: NonNullable<FunctionalModuleArtifact["constructorImports"]>[number][] = [
      {
        name: GLEAM_LIST_NIL,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "ListNil",
      },
      {
        name: GLEAM_LIST_CONS,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "ListCons",
      },
      {
        name: GLEAM_BIT_ARRAY_VALUE,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "BitArray",
      },
      { name: GLEAM_RESULT_OK, fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE, exportName: "Ok" },
      {
        name: GLEAM_RESULT_ERROR,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "Error",
      },
    ];
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
      const qualifier = declaration.alias ?? declaration.module.split("/").at(-1)!;
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
      if (declaration.names.length === 0) continue;
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
    const hasCompleteAnnotation = annotations.every((annotation) => annotation !== null) &&
      declaration.result !== null;
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
    if (
      external.target !== "javascript" || declaration.parameters.length === 0 ||
      parameters.some(schemaContainsParameter) || schemaContainsParameter(result)
    ) {
      return [{
        name: declaration.name,
        parameters: declaration.parameters.map((parameter) => parameter.name),
        annotation: declaredFunctionType(declaration, this.#typeResolver),
        body: {
          kind: "runtime-fault",
          message: `unbound Gleam external ${external.target}:${external.module}.${external.name}`,
          span: declaration.span,
        },
        span: declaration.span,
      }];
    }
    const hostParameter = nestedTupleSchema(parameters);
    const hostDefinition = `$gleam_external:${declaration.name}`;
    const capability = `GleamExternal:${external.module}`;
    const fields = this.#externalCapabilities.get(capability) ?? new Map();
    const operationName = `${external.name}@${this.module.name}.${declaration.name}`;
    const operation: FunctionalHostOperationDeclaration = {
      kind: "operation",
      name: operationName,
      purity: "effectful",
      parameter: hostParameter,
      result,
    };
    const existing = fields.get(operation.name);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(operation)) {
      throw new GleamFunctionalLoweringError(
        declaration.span,
        `Gleam externals disagree about host operation ${
          JSON.stringify(`${external.module}.${operation.name}`)
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
        return { kind: "whole-number-f64", value: expression.value, span: expression.span };
      case "boolean":
        return { ...expression };
      case "float":
        return { kind: "float-64", value: expression.value, span: expression.span };
      case "string":
        return { kind: "text", value: expression.value, span: expression.span };
      case "bit-array":
        return bitArrayExpression(expression.bytes, expression.span);
      case "bit-array-build":
        throw new GleamFunctionalLoweringError(
          expression.span,
          "Dynamic Gleam bit-array construction has not been lowered.",
        );
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
      case "field-access":
        return this.lowerRecordField(
          this.lowerExpression(expression.value),
          expression.field,
          expression.span,
        );
      case "tuple-index": {
        if (expression.index !== 0 && expression.index !== 1) {
          throw new GleamFunctionalLoweringError(
            expression.span,
            `The portable Gleam adapter currently accepts pair indices 0 and 1; received ${expression.index}.`,
          );
        }
        const first = `$gleam_tuple_first_${this.#discardIndex++}`;
        const second = `$gleam_tuple_second_${this.#discardIndex++}`;
        return {
          kind: "case",
          value: this.lowerExpression(expression.value),
          arms: [{
            constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
            binders: [first, second],
            body: name(expression.index === 0 ? first : second, expression.span),
            span: expression.span,
          }],
          span: expression.span,
        };
      }
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
      case "let": {
        if (expression.pattern.kind === "variable") {
          return {
            kind: "let",
            name: expression.pattern.name,
            value: this.lowerExpression(expression.value),
            body: this.lowerExpression(expression.body),
            span: expression.span,
          };
        }
        const subjectName = `$gleam_let_${this.#discardIndex++}`;
        return {
          kind: "let",
          name: subjectName,
          value: this.lowerExpression(expression.value),
          body: this.lowerPattern(
            subjectName,
            expression.pattern,
            this.lowerExpression(expression.body),
            {
              kind: "runtime-fault",
              message: "Gleam let pattern did not match",
              span: expression.pattern.span,
            },
          ),
          span: expression.span,
        };
      }
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
    const labeledIndices = new Set(
      expression.arguments.flatMap((argument) => {
        if (argument.label === null) return [];
        const index = labels.indexOf(argument.label);
        return index < 0 ? [] : [index];
      }),
    );
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
        while (labeledIndices.has(positionalIndex)) positionalIndex++;
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
      return {
        kind: "binary",
        operator: FunctionalBinaryOperator.RemainderWholeNumberF64,
        left,
        right,
        span: expression.span,
      };
    }
    if (expression.operator === "<>") {
      return { kind: "text-append", left, right, span: expression.span };
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
    const unguardedPatterns = expression.arms.flatMap((arm) =>
      arm.guard === null ? [arm.patterns] : []
    );
    if (!this.patternMatrixIsExhaustive(unguardedPatterns)) {
      throw new GleamFunctionalLoweringError(
        expression.span,
        "A Gleam case using guards, multiple subjects, or nested patterns is not exhaustive.",
      );
    }
    const subjectNames = expression.subjects.map(() => `$gleam_case_${this.#discardIndex++}`);
    let result: FunctionalSurfaceExpression = {
      kind: "runtime-fault",
      message: "unreachable exhaustive Gleam case",
      span: expression.span,
    };
    for (let index = expression.arms.length - 1; index >= 0; index--) {
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

  private patternMatrixIsExhaustive(
    rows: readonly (readonly GleamFunctionalPattern[])[],
  ): boolean {
    if (rows.some((row) => row.length === 0)) return true;
    if (rows.length === 0) return false;
    const firstPatterns = rows.map((row) => unaliasedPattern(row[0]!));
    const defaultRows = rows.flatMap((row, index) =>
      isIrrefutablePattern(firstPatterns[index]!) ? [row.slice(1)] : []
    );
    if (defaultRows.length > 0 && this.patternMatrixIsExhaustive(defaultRows)) return true;
    const refutablePatterns = firstPatterns.filter((pattern) => !isIrrefutablePattern(pattern));
    if (refutablePatterns.length === 0) {
      return this.patternMatrixIsExhaustive(rows.map((row) => row.slice(1)));
    }
    if (refutablePatterns.every((pattern) => pattern.kind === "boolean")) {
      return [false, true].every((value) =>
        this.patternMatrixIsExhaustive(rows.flatMap((row, index) => {
          const first = firstPatterns[index]!;
          if (isIrrefutablePattern(first)) return [row.slice(1)];
          return first.kind === "boolean" && first.value === value ? [row.slice(1)] : [];
        }))
      );
    }
    if (refutablePatterns.some((pattern) => pattern.kind === "boolean")) return false;
    if (
      refutablePatterns.some((pattern) =>
        pattern.kind === "integer" || pattern.kind === "float" ||
        pattern.kind === "string" || pattern.kind === "string-prefix" ||
        pattern.kind === "bit-array" || pattern.kind === "bit-array-segments"
      )
    ) return false;

    const normalized = refutablePatterns.map((pattern) =>
      this.normalizeConstructorPattern(pattern)
    );
    const firstShape = this.#constructors.get(normalized[0]!.constructor);
    if (firstShape === undefined) return false;
    const constructors = this.#constructorsByOwner.get(firstShape.owner);
    if (constructors === undefined) return false;
    if (
      normalized.some((pattern) =>
        this.#constructors.get(pattern.constructor)?.owner !== firstShape.owner
      )
    ) return false;
    return constructors.every((constructor) => {
      const arity = this.#constructors.get(constructor)?.fields.length;
      if (arity === undefined) return false;
      return this.patternMatrixIsExhaustive(rows.flatMap((row, index) => {
        const first = firstPatterns[index]!;
        if (isIrrefutablePattern(first)) {
          const discards = Array.from(
            { length: arity },
            (): GleamFunctionalPattern => ({ kind: "discard", span: first.span }),
          );
          return [[...discards, ...row.slice(1)]];
        }
        const pattern = this.normalizeConstructorPattern(first);
        return pattern.constructor === constructor ? [[...pattern.arguments, ...row.slice(1)]] : [];
      }));
    });
  }

  private lowerPatternSequence(
    subjects: readonly string[],
    patterns: readonly GleamFunctionalPattern[],
    success: FunctionalSurfaceExpression,
    failure: FunctionalSurfaceExpression,
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
    failure: FunctionalSurfaceExpression,
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
    if (pattern.kind === "string-prefix") {
      return this.lowerStringPrefixPattern(subjectName, pattern, success, failure);
    }
    if (pattern.kind === "bit-array-segments") {
      return this.lowerBitArraySegmentsPattern(subjectName, pattern, success, failure);
    }
    if (
      pattern.kind === "integer" || pattern.kind === "float" || pattern.kind === "boolean" ||
      pattern.kind === "bit-array" || pattern.kind === "string"
    ) {
      return {
        kind: "if",
        condition: {
          kind: "binary",
          operator: pattern.kind === "integer"
            ? FunctionalBinaryOperator.EqualWholeNumberF64
            : pattern.kind === "float"
            ? FunctionalBinaryOperator.EqualFloat64
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

  private lowerStringPrefixPattern(
    subjectName: string,
    pattern: Extract<GleamFunctionalPattern, { readonly kind: "string-prefix" }>,
    success: FunctionalSurfaceExpression,
    failure: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    this.registerTextIntrinsics();
    const prefixByteLength = new TextEncoder().encode(pattern.prefix).byteLength;
    const lengthName = `$gleam_prefix_length_${this.#discardIndex++}`;
    const restName = `$gleam_prefix_rest_${this.#discardIndex++}`;
    const subject = name(subjectName, pattern.span);
    const prefixLength = { kind: "integer" as const, value: prefixByteLength, span: pattern.span };
    const slice = (start: FunctionalSurfaceExpression, end: FunctionalSurfaceExpression) =>
      applyMany(
        name(GLEAM_TEXT_BYTE_SLICE, pattern.span),
        [nestedTupleExpression(
          [subject, nestedTupleExpression([start, end], pattern.span)],
          pattern.span,
        )],
        pattern.span,
      );
    const matchedRest = this.lowerPattern(restName, pattern.rest, success, failure);
    return {
      kind: "let",
      name: lengthName,
      value: applyMany(
        name(GLEAM_TEXT_BYTE_LENGTH, pattern.span),
        [subject],
        pattern.span,
      ),
      body: {
        kind: "if",
        condition: {
          kind: "binary",
          operator: FunctionalBinaryOperator.GreaterEqual,
          left: name(lengthName, pattern.span),
          right: prefixLength,
          span: pattern.span,
        },
        consequent: {
          kind: "if",
          condition: {
            kind: "binary",
            operator: FunctionalBinaryOperator.StructuralEqual,
            left: slice({ kind: "integer", value: 0, span: pattern.span }, prefixLength),
            right: { kind: "text", value: pattern.prefix, span: pattern.span },
            span: pattern.span,
          },
          consequent: {
            kind: "let",
            name: restName,
            value: slice(prefixLength, name(lengthName, pattern.span)),
            body: matchedRest,
            span: pattern.span,
          },
          alternate: failure,
          span: pattern.span,
        },
        alternate: failure,
        span: pattern.span,
      },
      span: pattern.span,
    };
  }

  private lowerBitArraySegmentsPattern(
    subjectName: string,
    pattern: Extract<GleamFunctionalPattern, { readonly kind: "bit-array-segments" }>,
    success: FunctionalSurfaceExpression,
    failure: FunctionalSurfaceExpression,
  ): FunctionalSurfaceExpression {
    const bitArray = { kind: "named" as const, name: GLEAM_BIT_ARRAY_TYPE, arguments: [] };
    const segmentTypes = pattern.segments.map((segment): FunctionalTypeSchema =>
      segment.options.some((option) => option.name === "bits" || option.name === "bytes")
        ? bitArray
        : wholeNumberF64Type()
    );
    const payload = segmentTypes.length === 1 ? segmentTypes[0]! : nestedTupleSchema(segmentTypes);
    const optionArguments = pattern.segments.flatMap((segment) =>
      segment.options.flatMap((option) => option.arguments)
    );
    const parameter = optionArguments.length === 0
      ? bitArray
      : nestedTupleSchema([bitArray, ...optionArguments.map(() => wholeNumberF64Type())]);
    const result: FunctionalTypeSchema = {
      kind: "named",
      name: GLEAM_RESULT_TYPE,
      arguments: [payload, { kind: "unit" }],
    };
    const operationName = `${this.module.name}:match:${this.#discardIndex++}`;
    const definitionName = `$gleam_bit_pattern:${operationName}`;
    const definitionSpan = {
      startByte: this.module.span.endByte,
      endByte: this.module.span.endByte,
    };
    const fields = this.#externalCapabilities.get(GLEAM_BIT_PATTERN_CAPABILITY) ?? new Map();
    fields.set(operationName, {
      kind: "operation",
      name: operationName,
      purity: "pure",
      parameter,
      result,
    });
    this.#externalCapabilities.set(GLEAM_BIT_PATTERN_CAPABILITY, fields);
    this.#hostDefinitions.push({
      definition: definitionName,
      capability: GLEAM_BIT_PATTERN_CAPABILITY,
      field: operationName,
    });
    this.#intrinsicDefinitions.push({
      name: definitionName,
      parameters: [],
      annotation: { kind: "function", parameter, result },
      body: {
        kind: "runtime-fault",
        message: `unbound Gleam bit-array pattern ${operationName}`,
        span: definitionSpan,
      },
      span: definitionSpan,
    });

    const payloadName = `$gleam_bit_payload_${this.#discardIndex++}`;
    const extractedPattern = pattern.segments.length === 1 ? pattern.segments[0]!.value : {
      kind: "tuple" as const,
      values: pattern.segments.map((segment) => segment.value) as [
        GleamFunctionalPattern,
        GleamFunctionalPattern,
        ...GleamFunctionalPattern[],
      ],
      span: pattern.span,
    };
    const matched = this.lowerPattern(payloadName, extractedPattern, success, failure);
    const argumentValues = [
      name(subjectName, pattern.span),
      ...optionArguments.map((argument) => this.lowerExpression(argument)),
    ];
    return {
      kind: "case",
      value: applyMany(
        name(definitionName, pattern.span),
        [
          argumentValues.length === 1
            ? argumentValues[0]!
            : nestedTupleExpression(argumentValues, pattern.span),
        ],
        pattern.span,
      ),
      arms: [{
        constructor: GLEAM_RESULT_OK,
        binders: [payloadName],
        body: matched,
        span: pattern.span,
      }, {
        constructor: GLEAM_RESULT_ERROR,
        binders: [this.discardName()],
        body: failure,
        span: pattern.span,
      }],
      span: pattern.span,
    };
  }

  private registerTextIntrinsics(): void {
    if (this.#textIntrinsicsRegistered) return;
    this.#textIntrinsicsRegistered = true;
    const definitionSpan = {
      startByte: this.module.span.endByte,
      endByte: this.module.span.endByte,
    };
    const integer = { kind: "integer" as const };
    const text = {
      kind: "named" as const,
      name: FUNCTIONAL_TEXT_TYPE_NAME,
      arguments: [],
    };
    const fields = new Map<string, FunctionalHostOperationDeclaration>();
    fields.set("byteLength", {
      kind: "operation",
      name: "byteLength",
      purity: "pure",
      parameter: text,
      result: integer,
      wasmIntrinsic: FunctionalWasmIntrinsic.BufferByteLength,
    });
    fields.set("byteSlice", {
      kind: "operation",
      name: "byteSlice",
      purity: "pure",
      parameter: {
        kind: "tuple",
        values: [text, { kind: "tuple", values: [integer, integer] }],
      },
      result: text,
      wasmIntrinsic: FunctionalWasmIntrinsic.BufferByteSlice,
    });
    this.#externalCapabilities.set(GLEAM_TEXT_INTRINSIC_CAPABILITY, fields);
    for (
      const [definition, field, annotation] of [
        [
          GLEAM_TEXT_BYTE_LENGTH,
          "byteLength",
          { kind: "function" as const, parameter: text, result: integer },
        ],
        [
          GLEAM_TEXT_BYTE_SLICE,
          "byteSlice",
          {
            kind: "function" as const,
            parameter: {
              kind: "tuple" as const,
              values: [text, { kind: "tuple" as const, values: [integer, integer] }],
            },
            result: text,
          },
        ],
      ] as const
    ) {
      this.#hostDefinitions.push({
        definition,
        capability: GLEAM_TEXT_INTRINSIC_CAPABILITY,
        field,
      });
      this.#intrinsicDefinitions.push({
        name: definition,
        parameters: [],
        annotation,
        body: {
          kind: "runtime-fault",
          message: `unbound Gleam text intrinsic ${field}`,
          span: definitionSpan,
        },
        span: definitionSpan,
      });
    }
  }

  private lowerScalarCase(
    subject: FunctionalSurfaceExpression,
    arms: Extract<GleamFunctionalExpression, { readonly kind: "case" }>["arms"],
    span: FunctionalSpan,
  ): FunctionalSurfaceExpression {
    const subjectName = `$gleam_case_${this.#discardIndex++}`;
    const booleanValues = new Set(
      arms.flatMap((arm) => {
        const pattern = arm.patterns[0];
        return pattern?.kind === "boolean" ? [pattern.value] : [];
      }),
    );
    const exhaustiveBoolean = booleanValues.size === 2 &&
      arms.every((arm) => arm.patterns[0]?.kind === "boolean");
    let fallback: FunctionalSurfaceExpression | null = exhaustiveBoolean
      ? { kind: "runtime-fault", message: "unreachable exhaustive Bool case", span }
      : null;
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
        pattern.kind !== "integer" && pattern.kind !== "float" && pattern.kind !== "boolean" &&
        pattern.kind !== "bit-array" && pattern.kind !== "string"
      ) {
        throw new Error(`Gleam scalar case retained unexpected pattern ${pattern.kind}.`);
      }
      fallback = {
        kind: "if",
        condition: {
          kind: "binary",
          operator: pattern.kind === "integer"
            ? FunctionalBinaryOperator.EqualWholeNumberF64
            : pattern.kind === "float"
            ? FunctionalBinaryOperator.EqualFloat64
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
    ["UtfCodepoint", { name: FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME, arity: 0 }],
    ["BitArray", { name: GLEAM_BIT_ARRAY_TYPE, arity: 0 }],
    ["Result", { name: GLEAM_RESULT_TYPE, arity: 2 }],
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
      const qualifier = declaration.alias ?? declaration.module.split("/").at(-1)!;
      for (const exported of exportedTypes) {
        this.#nominals.set(`${qualifier}.${exported.name}`, {
          name: qualifiedTypeImportName(declaration.module, exported.name),
          arity: exported.arity,
        });
      }
      if (declaration.names.length === 0) continue;
      for (const imported of declaration.names) {
        if (imported.kind !== "type") continue;
        const exported = exportedTypes.find((candidate) => candidate.name === imported.name);
        if (exported === undefined) continue;
        this.#nominals.set(imported.alias, {
          name: imported.alias,
          arity: exported.arity,
        });
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
      case "boolean":
      case "unit":
        return { kind: type.kind };
      case "integer":
        return wholeNumberF64Type();
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

function qualifiedGleamTypeName(module: string, name: string): string {
  return `${module}::${name}`;
}

function qualifiedConstructorImportName(module: string, name: string): string {
  return `$gleam_constructor:${module}.${name}`;
}

function qualifyGleamExportType(
  schema: FunctionalTypeSchema | null,
  typeNames: ReadonlyMap<string, string>,
): FunctionalTypeSchema | null {
  if (schema === null) return null;
  if (schema.kind === "tuple") {
    return {
      kind: "tuple",
      values: [
        qualifyGleamExportType(schema.values[0], typeNames)!,
        qualifyGleamExportType(schema.values[1], typeNames)!,
      ],
    };
  }
  if (schema.kind === "function") {
    return {
      kind: "function",
      parameter: qualifyGleamExportType(schema.parameter, typeNames)!,
      result: qualifyGleamExportType(schema.result, typeNames)!,
    };
  }
  if (schema.kind === "forall") {
    return {
      kind: "forall",
      parameters: schema.parameters,
      body: qualifyGleamExportType(schema.body, typeNames)!,
    };
  }
  if (schema.kind !== "named") return schema;
  return {
    kind: "named",
    name: typeNames.get(schema.name) ?? schema.name,
    arguments: schema.arguments.map((argument) => qualifyGleamExportType(argument, typeNames)!),
  };
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
  const functionType = curryType(parameters, typeResolver.lower(declaration.result));
  const typeParameters: string[] = [];
  const seen = new Set<string>();
  const collect = (type: GleamFunctionalType): void => {
    if (type.kind === "parameter") {
      if (!seen.has(type.name)) {
        seen.add(type.name);
        typeParameters.push(type.name);
      }
      return;
    }
    if (type.kind === "tuple") {
      for (const value of type.values) collect(value);
      return;
    }
    if (type.kind === "named") {
      for (const argument of type.arguments) collect(argument);
      return;
    }
    if (type.kind === "function") {
      for (const parameter of type.parameters) collect(parameter);
      collect(type.result);
    }
  };
  for (const parameter of declaration.parameters) collect(parameter.annotation!);
  collect(declaration.result);
  return typeParameters.length === 0 ? functionType : null;
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
    pattern.kind === "float" || pattern.kind === "bit-array" || pattern.kind === "string" ||
    pattern.kind === "variable" || pattern.kind === "discard";
}

function unaliasedPattern(pattern: GleamFunctionalPattern): GleamFunctionalPattern {
  let result = pattern;
  while (result.kind === "alias") result = result.pattern;
  return result;
}

function isIrrefutablePattern(pattern: GleamFunctionalPattern): boolean {
  if (pattern.kind === "variable" || pattern.kind === "discard") return true;
  return pattern.kind === "alias" && isIrrefutablePattern(pattern.pattern);
}

function scalarPatternValue(
  pattern: Extract<
    GleamFunctionalPattern,
    { readonly kind: "integer" | "float" | "boolean" | "bit-array" | "string" }
  >,
): FunctionalSurfaceExpression {
  if (pattern.kind === "integer") {
    return { kind: "whole-number-f64", value: pattern.value, span: pattern.span };
  }
  if (pattern.kind === "float") {
    return { kind: "float-64", value: pattern.value, span: pattern.span };
  }
  if (pattern.kind === "boolean") {
    return { kind: "boolean", value: pattern.value, span: pattern.span };
  }
  if (pattern.kind === "string") {
    return { kind: "text", value: pattern.value, span: pattern.span };
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
      { kind: "whole-number-f64", value: bytes.byteLength * 8, span },
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
        { name: "bitLength", type: wholeNumberF64Type(), span },
      ],
    }],
  };
}

function gleamResultDeclaration(sourceByteLength: number): FunctionalSurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: GLEAM_RESULT_TYPE,
    parameters: ["ok", "error"],
    span,
    constructors: [
      {
        name: GLEAM_RESULT_OK,
        span,
        fields: [{ name: "value", type: { kind: "parameter", name: "ok" }, span }],
      },
      {
        name: GLEAM_RESULT_ERROR,
        span,
        fields: [{ name: "value", type: { kind: "parameter", name: "error" }, span }],
      },
    ],
  };
}

function wholeNumberF64Type(): FunctionalTypeSchema {
  return {
    kind: "named",
    name: FUNCTIONAL_WHOLE_NUMBER_F64_TYPE_NAME,
    arguments: [],
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
