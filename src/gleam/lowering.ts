import {
  BinaryOperator,
  EvaluationProfile,
  PAIR_CONSTRUCTOR_NAME,
  type Span,
  type TypeSchema,
  UNIT_CONSTRUCTOR_NAME,
} from "../functional/abi.ts";
import { createModuleArtifact, type ModuleArtifact } from "../functional/module_linker.ts";
import {
  BYTES_TYPE_NAME,
  type HostCapabilityDeclaration,
  type HostOperationDeclaration,
  TEXT_TYPE_NAME,
  WasmIntrinsic,
  WHOLE_NUMBER_F64_TYPE_NAME,
} from "../functional/host_contract.ts";
import {
  surface,
  type SurfaceCaseArm,
  type SurfaceDefinition,
  type SurfaceExpression,
  type SurfaceTypeDeclaration,
} from "../functional/surface_builder.ts";
import type {
  GleamConstant,
  GleamExpression,
  GleamFunction,
  GleamModule,
  GleamPattern,
  GleamType,
  GleamTypeAlias,
  GleamTypeDeclaration,
} from "./ast.ts";
import { GleamLoweringError } from "./diagnostic.ts";

export type GleamExportSignature =
  | {
    readonly kind: "value";
    readonly module: string;
    readonly name: string;
    readonly type: TypeSchema | null;
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

export interface LoweredGleamModule {
  readonly source: GleamModule;
  readonly definitions: readonly SurfaceDefinition[];
  readonly typeDeclarations: readonly SurfaceTypeDeclaration[];
  readonly artifact: ModuleArtifact;
}

interface ConstructorShape {
  readonly owner: string;
  readonly fields: readonly (string | null)[];
  readonly span: Span;
}

interface LoweredGleamImports {
  readonly values: ModuleArtifact["imports"];
  readonly types: NonNullable<ModuleArtifact["typeImports"]>;
  readonly constructors: NonNullable<ModuleArtifact["constructorImports"]>;
}

const GLEAM_LIST_TYPE = "$GleamList";
const GLEAM_LIST_NIL = "$GleamNil";
const GLEAM_LIST_CONS = "$GleamCons";
const GLEAM_BIT_ARRAY_TYPE = "$GleamBitArray";
const GLEAM_BIT_ARRAY_VALUE = "$GleamBitArrayValue";
const GLEAM_RESULT_TYPE = "$GleamResult";
const GLEAM_RESULT_OK = "Ok";
const GLEAM_RESULT_ERROR = "Error";
const GLEAM_TUPLE_ZERO_TYPE = "$GleamTupleZero";
const GLEAM_TUPLE_ZERO_VALUE = "$GleamTupleZeroValue";
const GLEAM_TUPLE_ONE_TYPE = "$GleamTupleOne";
const GLEAM_TUPLE_ONE_VALUE = "$GleamTupleOneValue";
export const GLEAM_FUNCTIONAL_PRELUDE_MODULE = "$gleam/prelude";
const TUPLE_OWNER = "$TupleType";
const GLEAM_TEXT_INTRINSIC_CAPABILITY = "$GleamTextIntrinsics";
const GLEAM_BIT_PATTERN_CAPABILITY = "$GleamBitPatternIntrinsics";
const GLEAM_BIT_ARRAY_INTRINSIC_CAPABILITY = "$GleamBitArrayIntrinsics";
const GLEAM_TEXT_BYTE_LENGTH = "$gleam_text_byte_length";
const GLEAM_TEXT_BYTE_SLICE = "$gleam_text_byte_slice";
const GLEAM_BIT_ARRAY_FROM_UTF8_CODEPOINT = "$gleam_bit_array_from_utf8_codepoint";

/**
 * Failure continuations this size or smaller are copied rather than bound to a join point, because
 * the binding plus a single call already costs about six nodes. The usual failure continuation is
 * itself a three-node call to an enclosing join point, so this keeps ordinary matches untouched.
 */
const JOIN_POINT_MINIMUM_NODES = 8;

/**
 * Whether an expression has at most `limit` nodes, stopping as soon as it does not.
 *
 * Written as a structural walk over anything carrying a string `kind` rather than a case per
 * surface variant, so a new node kind cannot silently escape the count. It is only ever used as a
 * threshold, so a small overcount from a nested schema is harmless, and the early exit keeps
 * calling it at every level of a pattern from turning the lowering quadratic.
 */
function surfaceExpressionNodesAtMost(expression: SurfaceExpression, limit: number): boolean {
  let counted = 0;
  const pending: unknown[] = [expression];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current === null || typeof current !== "object" || ArrayBuffer.isView(current)) continue;
    if (typeof (current as { readonly kind?: unknown }).kind === "string") {
      counted += 1;
      if (counted > limit) return false;
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === "span") continue;
      if (value !== null && typeof value === "object") pending.push(value);
    }
  }
  return true;
}

const binaryOperators: Readonly<Record<string, BinaryOperator>> = {
  "==": BinaryOperator.StructuralEqual,
  "!=": BinaryOperator.StructuralNotEqual,
  "<": BinaryOperator.LessSignedInteger64,
  "<=": BinaryOperator.LessEqualSignedInteger64,
  ">": BinaryOperator.GreaterSignedInteger64,
  ">=": BinaryOperator.GreaterEqualSignedInteger64,
  "<.": BinaryOperator.LessFloat64,
  "<=.": BinaryOperator.LessEqualFloat64,
  ">.": BinaryOperator.GreaterFloat64,
  ">=.": BinaryOperator.GreaterEqualFloat64,
  "+": BinaryOperator.AddSignedInteger64,
  "-": BinaryOperator.SubtractSignedInteger64,
  "*": BinaryOperator.MultiplySignedInteger64,
  "+.": BinaryOperator.AddFloat64,
  "-.": BinaryOperator.SubtractFloat64,
  "*.": BinaryOperator.MultiplyFloat64,
  "/.": BinaryOperator.DivideFloat64,
};

export function gleamNominalExportSignatures(
  module: GleamModule,
): readonly GleamExportSignature[] {
  return module.declarations.flatMap((declaration): readonly GleamExportSignature[] => {
    if (!declaration.public || declaration.kind !== "type") return [];
    const typeExport: GleamExportSignature = {
      kind: "type",
      module: module.name,
      name: declaration.name,
      arity: declaration.parameters.length,
    };
    if (declaration.opaque) return [typeExport];
    return [
      typeExport,
      ...declaration.constructors.map((constructor): GleamExportSignature => ({
        kind: "constructor",
        module: module.name,
        name: constructor.name,
        owner: declaration.name,
        fields: constructor.fields.map((field) => field.label),
      })),
    ];
  });
}

export function gleamValueExportSignatures(
  module: GleamModule,
  availableExports: readonly GleamExportSignature[],
): readonly GleamExportSignature[] {
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
      GleamExportSignature,
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

export function lowerGleamModule(
  module: GleamModule,
  availableExports: readonly GleamExportSignature[],
): LoweredGleamModule {
  return new GleamLowering(module, availableExports).lower();
}

export function gleamPreludeArtifact(): ModuleArtifact {
  return createModuleArtifact({
    name: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
    definitions: [],
    typeDeclarations: [
      gleamListDeclaration(0),
      gleamBitArrayDeclaration(0),
      gleamResultDeclaration(0),
      gleamTupleZeroDeclaration(0),
      gleamTupleOneDeclaration(0),
    ],
    imports: [],
    exports: [],
    typeExports: [
      { name: "List", declaration: GLEAM_LIST_TYPE },
      { name: "BitArray", declaration: GLEAM_BIT_ARRAY_TYPE },
      { name: "Result", declaration: GLEAM_RESULT_TYPE },
      { name: "TupleZero", declaration: GLEAM_TUPLE_ZERO_TYPE },
      { name: "TupleOne", declaration: GLEAM_TUPLE_ONE_TYPE },
    ],
    constructorExports: [
      { name: "ListNil", constructor: GLEAM_LIST_NIL },
      { name: "ListCons", constructor: GLEAM_LIST_CONS },
      { name: "BitArray", constructor: GLEAM_BIT_ARRAY_VALUE },
      { name: "Ok", constructor: GLEAM_RESULT_OK },
      { name: "Error", constructor: GLEAM_RESULT_ERROR },
      { name: "TupleZero", constructor: GLEAM_TUPLE_ZERO_VALUE },
      { name: "TupleOne", constructor: GLEAM_TUPLE_ONE_VALUE },
    ],
    sourceByteLength: 0,
    options: { evaluationProfile: EvaluationProfile.StrictEager },
  });
}

class GleamLowering {
  readonly #constructors = new Map<string, ConstructorShape>();
  readonly #constructorsByOwner = new Map<string, readonly string[]>();
  readonly #declarations = new Map<string, Span>();
  readonly #qualifiedImports = new Map<string, string>();
  readonly #callLabels = new Map<string, readonly (string | null)[]>();
  readonly #importedConstructorOwners = new Set<string>();
  readonly #typeResolver: GleamTypeResolver;
  readonly #externalCapabilities = new Map<
    string,
    Map<string, HostOperationDeclaration>
  >();
  readonly #hostDefinitions: {
    readonly definition: string;
    readonly capability: string;
    readonly field: string;
  }[] = [];
  readonly #intrinsicDefinitions: SurfaceDefinition[] = [];
  #textIntrinsicsRegistered = false;
  #discardIndex = 0;

  constructor(
    private readonly module: GleamModule,
    private readonly availableExports: readonly GleamExportSignature[],
  ) {
    this.#typeResolver = new GleamTypeResolver(module, availableExports);
  }

  lower(): LoweredGleamModule {
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
    const artifact = createModuleArtifact({
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
        evaluationProfile: EvaluationProfile.StrictEager,
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
    this.#constructors.set(PAIR_CONSTRUCTOR_NAME, {
      owner: TUPLE_OWNER,
      fields: [null, null],
      span,
    });
    this.#constructorsByOwner.set(TUPLE_OWNER, [PAIR_CONSTRUCTOR_NAME]);
    this.#constructors.set(UNIT_CONSTRUCTOR_NAME, {
      owner: "$UnitType",
      fields: [],
      span,
    });
    this.#constructorsByOwner.set("$UnitType", [UNIT_CONSTRUCTOR_NAME]);
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
    this.#constructors.set(GLEAM_TUPLE_ZERO_VALUE, {
      owner: GLEAM_TUPLE_ZERO_TYPE,
      fields: [],
      span,
    });
    this.#constructorsByOwner.set(GLEAM_TUPLE_ZERO_TYPE, [GLEAM_TUPLE_ZERO_VALUE]);
    this.#constructors.set(GLEAM_TUPLE_ONE_VALUE, {
      owner: GLEAM_TUPLE_ONE_TYPE,
      fields: [null],
      span,
    });
    this.#constructorsByOwner.set(GLEAM_TUPLE_ONE_TYPE, [GLEAM_TUPLE_ONE_VALUE]);
  }

  private indexDeclarations(): void {
    for (const declaration of this.module.declarations) {
      const existing = this.#declarations.get(declaration.name);
      if (existing !== undefined) {
        throw new GleamLoweringError(
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

  private indexTypeDeclaration(declaration: GleamTypeDeclaration): void {
    requireUniqueNames(
      declaration.parameters,
      declaration.span,
      `type ${JSON.stringify(declaration.name)} parameters`,
    );
    const constructorNames: string[] = [];
    for (const constructor of declaration.constructors) {
      const existing = this.#constructors.get(constructor.name);
      if (existing !== undefined) {
        throw new GleamLoweringError(
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

  private indexTypeAlias(declaration: GleamTypeAlias): void {
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
    const values: ModuleArtifact["imports"][number][] = [];
    const types: NonNullable<ModuleArtifact["typeImports"]>[number][] = [
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
      {
        name: GLEAM_TUPLE_ZERO_TYPE,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "TupleZero",
      },
      {
        name: GLEAM_TUPLE_ONE_TYPE,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "TupleOne",
      },
    ];
    const constructors: NonNullable<ModuleArtifact["constructorImports"]>[number][] = [
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
      {
        name: GLEAM_TUPLE_ZERO_VALUE,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "TupleZero",
      },
      {
        name: GLEAM_TUPLE_ONE_VALUE,
        fromModule: GLEAM_FUNCTIONAL_PRELUDE_MODULE,
        exportName: "TupleOne",
      },
    ];
    const localNames = new Set(this.#declarations.keys());
    const qualifiedConstructorOwners = new Set<string>();
    for (const declaration of this.module.imports) {
      const moduleExports = this.availableExports.filter((candidate) =>
        candidate.module === declaration.module
      );
      if (moduleExports.length === 0) {
        throw new GleamLoweringError(
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
            GleamExportSignature,
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
          throw new GleamLoweringError(
            imported.span,
            `Gleam module ${JSON.stringify(this.module.name)} imports missing public ${category} ${
              JSON.stringify(`${declaration.module}.${imported.name}`)
            }.`,
          );
        }
        if (exported.kind === "type") {
          if (this.#typeResolver.isLocalTypeName(imported.alias)) {
            throw new GleamLoweringError(
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
          throw new GleamLoweringError(
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
    imports: NonNullable<ModuleArtifact["constructorImports"]>[number][],
    fromModule: string,
    exported: Extract<GleamExportSignature, { readonly kind: "constructor" }>,
    visibleName: string,
    span: Span,
  ): void {
    const siblings = this.availableExports.filter((candidate): candidate is Extract<
      GleamExportSignature,
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

  private addQualifiedImport(sourceName: string, localName: string, span: Span): void {
    if (this.#qualifiedImports.has(sourceName)) {
      throw new GleamLoweringError(
        span,
        `Gleam qualified import ${JSON.stringify(sourceName)} is ambiguous in module ${
          JSON.stringify(this.module.name)
        }.`,
      );
    }
    this.#qualifiedImports.set(sourceName, localName);
  }

  private lowerTypeDeclaration(
    declaration: GleamTypeDeclaration,
  ): SurfaceTypeDeclaration {
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

  private lowerFunction(declaration: GleamFunction): SurfaceDefinition {
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
      parameters: declaration.parameters.length === 0
        ? ["$gleam_unit_parameter"]
        : declaration.parameters.map((parameter) => parameter.name),
      annotation: hasCompleteAnnotation
        ? declaredFunctionType(declaration, this.#typeResolver)
        : null,
      body: this.lowerExpression(declaration.body),
      span: declaration.span,
    };
  }

  private lowerExternalFunction(
    declaration: GleamFunction,
  ): readonly SurfaceDefinition[] {
    const external = declaration.external;
    if (external === null || declaration.body !== null) {
      throw new Error(`Gleam external ${JSON.stringify(declaration.name)} has an invalid shape.`);
    }
    if (
      declaration.result === null ||
      declaration.parameters.some((parameter) => parameter.annotation === null)
    ) {
      throw new GleamLoweringError(
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
      external.target !== "javascript" || parameters.some(schemaContainsParameter) ||
      schemaContainsParameter(result)
    ) {
      return [{
        name: declaration.name,
        parameters: declaration.parameters.length === 0
          ? ["$gleam_unit_parameter"]
          : declaration.parameters.map((parameter) => parameter.name),
        annotation: declaredFunctionType(declaration, this.#typeResolver),
        body: surface.at(declaration.span).runtimeFault(
          `unbound Gleam external ${external.target}:${external.module}.${external.name}`,
        ),
        span: declaration.span,
      }];
    }
    const hostParameter = parameters.length === 0
      ? { kind: "unit" as const }
      : nestedTupleSchema(parameters);
    const hostDefinition = `$gleam_external:${declaration.name}`;
    const capability = `GleamExternal:${external.module}`;
    const fields = this.#externalCapabilities.get(capability) ?? new Map();
    const operationName = `${external.name}@${this.module.name}.${declaration.name}`;
    const operation: HostOperationDeclaration = {
      kind: "operation",
      name: operationName,
      purity: "effectful",
      parameter: hostParameter,
      result,
    };
    const existing = fields.get(operation.name);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(operation)) {
      throw new GleamLoweringError(
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
    const parameterValues = declaration.parameters.length === 0
      ? [name(UNIT_CONSTRUCTOR_NAME, declaration.span)]
      : declaration.parameters.map((parameter) => name(parameter.name, parameter.span));
    return [{
      name: hostDefinition,
      parameters: [],
      annotation: { kind: "function", parameter: hostParameter, result },
      body: surface.at(declaration.span).runtimeFault(
        `unbound Gleam external ${external.module}.${external.name}`,
      ),
      span: declaration.span,
    }, {
      name: declaration.name,
      parameters: declaration.parameters.length === 0
        ? ["$gleam_unit_parameter"]
        : declaration.parameters.map((parameter) => parameter.name),
      annotation: declaredFunctionType(declaration, this.#typeResolver),
      body: surface.at(declaration.span).apply(
        name(hostDefinition, declaration.span),
        parameters.length === 0
          ? parameterValues[0]!
          : nestedTupleExpression(parameterValues, declaration.span),
      ),
      span: declaration.span,
    }];
  }

  private hostCapabilities(): readonly HostCapabilityDeclaration[] {
    return [...this.#externalCapabilities].map(([name, fields]) => ({
      name,
      fields: [...fields.values()],
    }));
  }

  private lowerConstant(declaration: GleamConstant): SurfaceDefinition {
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

  private lowerExpression(expression: GleamExpression): SurfaceExpression {
    switch (expression.kind) {
      case "integer":
        return surface.at(expression.span).signedInteger64(BigInt(expression.value));
      case "boolean":
        return { ...expression };
      case "float":
        return surface.at(expression.span).float64(expression.value);
      case "string":
        return surface.at(expression.span).text(expression.value);
      case "bit-array":
        return bitArrayExpression(expression.bytes, expression.bitLength, expression.span);
      case "bit-array-build":
        return this.lowerBitArrayBuild(expression);
      case "panic":
        if (expression.message === null || expression.message.kind === "string") {
          return surface.at(expression.span).runtimeFault(
            expression.message?.value ?? "Gleam panic",
          );
        }
        return surface.at(expression.span).let(
          this.discardName(),
          this.lowerExpression(expression.message),
          surface.at(expression.span).runtimeFault("Gleam panic"),
        );
      case "unit":
        return name(UNIT_CONSTRUCTOR_NAME, expression.span);
      case "capture":
        throw new GleamLoweringError(
          expression.span,
          "A Gleam function capture placeholder must appear in a function call.",
        );
      case "name": {
        const qualified = this.#qualifiedImports.get(expression.name);
        if (qualified !== undefined) return name(qualified, expression.span);
        if (expression.name.includes(".")) return this.lowerRecordAccess(expression);
        return name(expression.name, expression.span);
      }
      case "field-access":
        return this.lowerRecordField(
          this.lowerExpression(expression.value),
          expression.field,
          expression.span,
        );
      case "tuple-index": {
        if (expression.index !== 0 && expression.index !== 1) {
          throw new GleamLoweringError(
            expression.span,
            `The portable Gleam adapter currently accepts pair indices 0 and 1; received ${expression.index}.`,
          );
        }
        const first = `$gleam_tuple_first_${this.#discardIndex++}`;
        const second = `$gleam_tuple_second_${this.#discardIndex++}`;
        return surface.at(expression.span).case(this.lowerExpression(expression.value), [{
          constructor: PAIR_CONSTRUCTOR_NAME,
          binders: [first, second],
          body: name(expression.index === 0 ? first : second, expression.span),
        }]);
      }
      case "tuple": {
        if (expression.values.length === 0) {
          return name(GLEAM_TUPLE_ZERO_VALUE, expression.span);
        }
        if (expression.values.length === 1) {
          return surface.at(expression.span).apply(
            name(GLEAM_TUPLE_ONE_VALUE, expression.span),
            this.lowerExpression(expression.values[0]!),
          );
        }
        let result = this.lowerExpression(expression.values.at(-1)!);
        for (let index = expression.values.length - 2; index >= 0; index--) {
          result = applyMany(
            name(PAIR_CONSTRUCTOR_NAME, expression.span),
            [this.lowerExpression(expression.values[index]!), result],
            expression.span,
          );
        }
        return result;
      }
      case "list": {
        let result: SurfaceExpression = expression.tail === null
          ? name(GLEAM_LIST_NIL, expression.span)
          : this.lowerExpression(expression.tail);
        for (let index = expression.values.length - 1; index >= 0; index--) {
          result = applyMany(
            name(GLEAM_LIST_CONS, expression.span),
            [this.lowerExpression(expression.values[index]!), result],
            expression.span,
          );
        }
        return result;
      }
      case "lambda": {
        const body = this.lowerExpression(expression.body);
        const parameters = expression.parameters.length === 0
          ? [`$gleam_unit_${this.#discardIndex++}`]
          : expression.parameters;
        return surface.at(expression.span).lambda(parameters, body);
      }
      case "call": {
        if (expression.arguments.some((argument) => argument.spread)) {
          return this.lowerRecordUpdate(expression);
        }
        const arguments_ = this.orderedCallArguments(expression);
        if (arguments_.length === 0) {
          return surface.at(expression.span).apply(
            this.lowerExpression(expression.callee),
            name(UNIT_CONSTRUCTOR_NAME, expression.span),
          );
        }
        const captures = arguments_.filter((argument) => argument.kind === "capture");
        if (captures.length === 0) {
          return applyMany(
            this.lowerExpression(expression.callee),
            arguments_.map((argument) => this.lowerExpression(argument)),
            expression.span,
          );
        }
        if (captures.length !== 1) {
          throw new GleamLoweringError(
            expression.span,
            `A Gleam function capture needs exactly one placeholder; received ${captures.length}.`,
          );
        }
        const parameter = `$gleam_capture_${this.#discardIndex++}`;
        return surface.at(expression.span).lambda(
          parameter,
          applyMany(
            this.lowerExpression(expression.callee),
            arguments_.map((argument) =>
              argument.kind === "capture"
                ? name(parameter, argument.span)
                : this.lowerExpression(argument)
            ),
            expression.span,
          ),
        );
      }
      case "let": {
        const at = surface.at(expression.span);
        if (expression.pattern.kind === "variable") {
          return at.let(
            expression.pattern.name,
            this.lowerExpression(expression.value),
            this.lowerExpression(expression.body),
          );
        }
        const subjectName = `$gleam_let_${this.#discardIndex++}`;
        return at.let(
          subjectName,
          this.lowerExpression(expression.value),
          this.lowerPattern(
            subjectName,
            expression.pattern,
            this.lowerExpression(expression.body),
            surface.at(expression.pattern.span).runtimeFault("Gleam let pattern did not match"),
          ),
        );
      }
      case "binary":
        return this.lowerBinary(expression);
      case "case":
        return this.lowerCase(expression);
    }
  }

  private lowerRecordUpdate(
    expression: Extract<GleamExpression, { readonly kind: "call" }>,
  ): SurfaceExpression {
    if (expression.callee.kind !== "name") {
      throw new GleamLoweringError(
        expression.span,
        "A Gleam record update must name its record constructor.",
      );
    }
    const shape = this.#constructors.get(expression.callee.name);
    if (shape === undefined || shape.fields.some((field) => field === null)) {
      throw new GleamLoweringError(
        expression.span,
        `Gleam record update constructor ${
          JSON.stringify(expression.callee.name)
        } must have labeled fields.`,
      );
    }
    const spreadArguments = expression.arguments.filter((argument) => argument.spread);
    if (spreadArguments.length !== 1 || expression.arguments[0] !== spreadArguments[0]) {
      throw new GleamLoweringError(
        expression.span,
        "A Gleam record update needs exactly one leading spread value.",
      );
    }
    const overrides = new Map<string, GleamExpression>();
    for (const argument of expression.arguments.slice(1)) {
      if (argument.label === null || argument.spread) {
        throw new GleamLoweringError(
          argument.span,
          "Gleam record update fields must use labels.",
        );
      }
      if (!shape.fields.includes(argument.label)) {
        throw new GleamLoweringError(
          argument.span,
          `Gleam record ${JSON.stringify(expression.callee.name)} has no field ${
            JSON.stringify(argument.label)
          }.`,
        );
      }
      if (overrides.has(argument.label)) {
        throw new GleamLoweringError(
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
    return surface.at(expression.span).case(this.lowerExpression(spreadArguments[0]!.value), [{
      constructor: expression.callee.name,
      binders,
      body: applyMany(
        name(expression.callee.name, expression.callee.span),
        fields,
        expression.span,
      ),
    }]);
  }

  private lowerRecordAccess(
    expression: Extract<GleamExpression, { readonly kind: "name" }>,
  ): SurfaceExpression {
    const [base, ...fields] = expression.name.split(".");
    let current: SurfaceExpression = name(base!, expression.span);
    for (const field of fields) current = this.lowerRecordField(current, field!, expression.span);
    return current;
  }

  private lowerRecordField(
    value: SurfaceExpression,
    field: string,
    span: Span,
  ): SurfaceExpression {
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
      throw new GleamLoweringError(
        span,
        `Gleam record field ${JSON.stringify(field)} cannot be resolved because ${evidence}.`,
      );
    }
    const selected = owners[0]!;
    return surface.at(span).case(
      value,
      selected.constructorNames.map((constructor, constructorIndex) => {
        const shape = this.#constructors.get(constructor)!;
        const binders = shape.fields.map(() => `$gleam_field_${this.#discardIndex++}`);
        return {
          constructor,
          binders,
          body: name(binders[selected.fieldIndices[constructorIndex]!]!, span),
        };
      }),
    );
  }

  private orderedCallArguments(
    expression: Extract<GleamExpression, { readonly kind: "call" }>,
  ): readonly GleamExpression[] {
    if (expression.callee.kind !== "name") {
      const labeled = expression.arguments.find((argument) => argument.label !== null);
      if (labeled !== undefined) {
        throw new GleamLoweringError(
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
        throw new GleamLoweringError(
          labeled.span,
          `Gleam call to ${JSON.stringify(expression.callee.name)} has unknown label ${
            JSON.stringify(labeled.label)
          }.`,
        );
      }
      return expression.arguments.map((argument) => argument.value);
    }
    if (expression.arguments.length !== labels.length) {
      throw new GleamLoweringError(
        expression.span,
        `Gleam call to ${
          JSON.stringify(expression.callee.name)
        } receives ${expression.arguments.length} arguments; expected ${labels.length}.`,
      );
    }
    const ordered: Array<GleamExpression | undefined> = Array(labels.length);
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
          throw new GleamLoweringError(
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
        throw new GleamLoweringError(
          argument.span,
          `Gleam call to ${JSON.stringify(expression.callee.name)} has unknown label ${
            JSON.stringify(argument.label)
          }.`,
        );
      }
      if (ordered[index] !== undefined) {
        throw new GleamLoweringError(
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
      throw new GleamLoweringError(
        expression.span,
        `Gleam call to ${JSON.stringify(expression.callee.name)} omits argument ${
          JSON.stringify(labels[missing] ?? missing)
        }.`,
      );
    }
    return ordered as readonly GleamExpression[];
  }

  private lowerBinary(
    expression: Extract<GleamExpression, { readonly kind: "binary" }>,
  ): SurfaceExpression {
    const at = surface.at(expression.span);
    const left = this.lowerExpression(expression.left);
    const right = this.lowerExpression(expression.right);
    if (expression.operator === "&&") {
      return at.if(left, right, at.boolean(false));
    }
    if (expression.operator === "||") {
      return at.if(left, at.boolean(true), right);
    }
    if (expression.operator === "/" || expression.operator === "%") {
      return at.if(
        at.binary(
          BinaryOperator.EqualSignedInteger64,
          right,
          surface.at(expression.right.span).signedInteger64(0n),
        ),
        at.signedInteger64(0n),
        at.binary(
          expression.operator === "/"
            ? BinaryOperator.DivideSignedInteger64
            : BinaryOperator.RemainderSignedInteger64,
          left,
          right,
        ),
      );
    }
    if (expression.operator === "<>") {
      return { kind: "text-append", left, right, span: expression.span };
    }
    if (expression.operator === "/.") {
      return at.if(
        at.binary(
          BinaryOperator.EqualFloat64,
          right,
          surface.at(expression.right.span).float64(0),
        ),
        at.float64(0),
        at.binary(BinaryOperator.DivideFloat64, left, right),
      );
    }
    return at.binary(binaryOperators[expression.operator]!, left, right);
  }

  private lowerCase(
    expression: Extract<GleamExpression, { readonly kind: "case" }>,
  ): SurfaceExpression {
    if (expression.arms.length === 0) {
      throw new GleamLoweringError(
        expression.span,
        "Gleam case expressions need an arm.",
      );
    }
    for (const arm of expression.arms) {
      if (arm.patterns.length !== expression.subjects.length) {
        throw new GleamLoweringError(
          arm.span,
          `Gleam case arm has ${arm.patterns.length} patterns for ${expression.subjects.length} subjects.`,
        );
      }
    }
    const hasGuards = expression.arms.some((arm) => arm.guard !== null);
    if (expression.subjects.length > 1) {
      return this.lowerCase({
        kind: "case",
        subjects: [{ kind: "tuple", values: expression.subjects, span: expression.span }],
        arms: expression.arms.map((arm) => ({
          ...arm,
          patterns: [{ kind: "tuple", values: arm.patterns, span: arm.span }],
        })),
        span: expression.span,
      });
    }
    if (expression.subjects.length !== 1) {
      return this.lowerSequentialCase(expression);
    }
    const subject = this.lowerExpression(expression.subjects[0]!);
    const patterns = expression.arms.map((arm) => arm.patterns[0]!);
    if (!hasGuards && patterns.every((pattern) => isScalarPattern(pattern))) {
      return this.lowerScalarCase(subject, expression.arms, expression.span);
    }
    if (hasGuards) {
      const guardedCase = this.lowerConstructorDecisionCase(
        subject,
        expression.arms,
        expression.span,
      );
      return guardedCase ?? this.lowerSequentialCase(expression);
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
    if (hasNestedConstructorPattern) {
      const nestedCase = this.lowerConstructorDecisionCase(
        subject,
        expression.arms,
        expression.span,
      );
      if (nestedCase !== null) return nestedCase;
      return this.lowerSequentialCase(expression);
    }
    return surface.at(expression.span).case(subject, this.lowerConstructorArms(expression.arms));
  }

  private lowerConstructorDecisionCase(
    subject: SurfaceExpression,
    arms: Extract<GleamExpression, { readonly kind: "case" }>["arms"],
    span: Span,
  ): SurfaceExpression | null {
    const patterns = arms.map((arm) => arm.patterns[0]!);
    const normalizedPatterns = patterns.map(unaliasedPattern);
    const refutable = normalizedPatterns.filter((pattern) => !isIrrefutablePattern(pattern));
    if (refutable.length === 0) return null;
    if (
      refutable.some((pattern) =>
        pattern.kind !== "constructor" && pattern.kind !== "list-cons" &&
        pattern.kind !== "list-nil" && pattern.kind !== "tuple" && pattern.kind !== "unit"
      )
    ) return null;
    const normalizedConstructors = refutable.map((pattern) =>
      this.normalizeConstructorPattern(pattern)
    );
    const owner = this.#constructors.get(normalizedConstructors[0]!.constructor)?.owner;
    if (
      owner === undefined ||
      normalizedConstructors.some((pattern) =>
        this.#constructors.get(pattern.constructor)?.owner !== owner
      )
    ) return null;
    const constructors = this.#constructorsByOwner.get(owner);
    if (constructors === undefined) return null;

    const subjectName = `$gleam_case_${this.#discardIndex++}`;
    const loweredArms = constructors.map((constructor) => {
      const shape = this.#constructors.get(constructor)!;
      const binders = shape.fields.map(() => this.discardName());
      let body: SurfaceExpression = surface.at(span).runtimeFault(
        "unreachable exhaustive Gleam constructor case",
      );
      for (let index = arms.length - 1; index >= 0; index--) {
        const sourcePattern = patterns[index]!;
        const pattern = normalizedPatterns[index]!;
        let nestedPatterns: readonly GleamPattern[];
        if (isIrrefutablePattern(pattern)) {
          nestedPatterns = shape.fields.map(() => ({ kind: "discard", span: pattern.span }));
        } else {
          const normalized = this.normalizeConstructorPattern(pattern);
          if (normalized.constructor !== constructor) continue;
          nestedPatterns = normalized.arguments;
        }
        const arm = arms[index]!;
        let success = this.lowerExpression(arm.body);
        if (arm.guard !== null) {
          success = surface.at(arm.span).if(this.lowerExpression(arm.guard), success, body);
        }
        if (sourcePattern.kind === "variable" || sourcePattern.kind === "alias") {
          success = surface.at(sourcePattern.span).let(
            sourcePattern.name,
            name(subjectName, sourcePattern.span),
            success,
          );
        }
        body = this.lowerPatternSequence(binders, nestedPatterns, success, body);
      }
      return { constructor, binders, body, span };
    });
    const at = surface.at(span);
    return at.let(subjectName, subject, at.case(name(subjectName, span), loweredArms));
  }

  private lowerSequentialCase(
    expression: Extract<GleamExpression, { readonly kind: "case" }>,
  ): SurfaceExpression {
    const unguardedPatterns = expression.arms.flatMap((arm) =>
      arm.guard === null ? [arm.patterns] : []
    );
    if (!this.patternMatrixIsExhaustive(unguardedPatterns)) {
      throw new GleamLoweringError(
        expression.span,
        "A Gleam case using guards, multiple subjects, or nested patterns is not exhaustive.",
      );
    }
    const subjectNames = expression.subjects.map(() => `$gleam_case_${this.#discardIndex++}`);
    let result: SurfaceExpression = surface.at(expression.span).runtimeFault(
      "unreachable exhaustive Gleam case",
    );
    for (let index = expression.arms.length - 1; index >= 0; index--) {
      const arm = expression.arms[index]!;
      const at = surface.at(arm.span);
      const fallbackName = `$gleam_case_fallback_${this.#discardIndex++}`;
      const fallbackParameter = this.discardName();
      const fallback = at.apply(
        name(fallbackName, arm.span),
        name(UNIT_CONSTRUCTOR_NAME, arm.span),
      );
      const body = this.lowerExpression(arm.body);
      const success = arm.guard === null
        ? body
        : at.if(this.lowerExpression(arm.guard), body, fallback);
      const attempt = this.lowerPatternSequence(
        subjectNames,
        arm.patterns,
        success,
        fallback,
      );
      result = at.let(fallbackName, at.lambda(fallbackParameter, result), attempt);
    }
    for (let index = expression.subjects.length - 1; index >= 0; index--) {
      result = surface.at(expression.span).let(
        subjectNames[index]!,
        this.lowerExpression(expression.subjects[index]!),
        result,
      );
    }
    return result;
  }

  private patternMatrixIsExhaustive(
    rows: readonly (readonly GleamPattern[])[],
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
            (): GleamPattern => ({ kind: "discard", span: first.span }),
          );
          return [[...discards, ...row.slice(1)]];
        }
        const pattern = this.normalizeConstructorPattern(first);
        return pattern.constructor === constructor ? [[...pattern.arguments, ...row.slice(1)]] : [];
      }));
    });
  }

  /**
   * Binds a failure continuation to a join point and hands back a call to it.
   *
   * `SurfaceExpression` is a value tree, so handing the same object to two places emits the nodes
   * twice — sharing needs a real binding. Without one, `lowerPattern` copies the entire rest of the
   * match into every non-matching constructor arm of a test, and because that happens at every
   * level of a nested or multi-subject pattern the copies compound. Measured on two subjects over a
   * three-constructor type: 16x per arm, so three arms cost 19,134 surface nodes and four exceeded
   * the 65,536-node ABI cap outright.
   *
   * The lambda is not a closure in the end. The WebAssembly backend contifies exactly this shape —
   * a `let`-bound lambda whose binder is only ever tail-called — into a label, so the continuation
   * is shared without either duplicating it or losing tail position inside it.
   *
   * Continuations at or below {@link JOIN_POINT_MINIMUM_NODES} are passed through untouched. The
   * binding plus one call costs about six nodes, so hoisting something smaller than that would make
   * the ordinary single-constructor match bigger — and most matches in real code are that shape.
   */
  private shareFailure(failure: SurfaceExpression, span: Span): {
    readonly bind: (body: SurfaceExpression) => SurfaceExpression;
    readonly use: () => SurfaceExpression;
  } {
    if (surfaceExpressionNodesAtMost(failure, JOIN_POINT_MINIMUM_NODES)) {
      return { bind: (body) => body, use: () => failure };
    }
    const joinName = `$gleam_case_join_${this.#discardIndex++}`;
    const at = surface.at(span);
    const parameter = this.discardName();
    return {
      bind: (body) => at.let(joinName, at.lambda(parameter, failure), body),
      use: () => at.apply(name(joinName, span), name(UNIT_CONSTRUCTOR_NAME, span)),
    };
  }

  private lowerPatternSequence(
    subjects: readonly string[],
    patterns: readonly GleamPattern[],
    success: SurfaceExpression,
    failure: SurfaceExpression,
  ): SurfaceExpression {
    const first = patterns[0];
    if (first === undefined) return success;
    // One join point covers the whole sequence: every `lowerPattern` below then receives a
    // three-node call, which is under the threshold, so nothing hoists again further down.
    const shared = this.shareFailure(failure, first.span);
    let result = success;
    for (let index = patterns.length - 1; index >= 0; index--) {
      if (!isIrrefutablePattern(patterns[index]!)) continue;
      result = this.lowerPattern(subjects[index]!, patterns[index]!, result, shared.use());
    }
    for (let index = patterns.length - 1; index >= 0; index--) {
      if (isIrrefutablePattern(patterns[index]!)) continue;
      result = this.lowerPattern(subjects[index]!, patterns[index]!, result, shared.use());
    }
    return shared.bind(result);
  }

  private lowerPattern(
    subjectName: string,
    pattern: GleamPattern,
    success: SurfaceExpression,
    failure: SurfaceExpression,
  ): SurfaceExpression {
    const at = surface.at(pattern.span);
    const subject = name(subjectName, pattern.span);
    if (pattern.kind === "variable") {
      return at.let(pattern.name, subject, success);
    }
    if (pattern.kind === "discard") return success;
    if (pattern.kind === "alias") {
      const aliasedSuccess = at.let(pattern.name, subject, success);
      return this.lowerPattern(subjectName, pattern.pattern, aliasedSuccess, failure);
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
      return at.if(
        at.binary(
          scalarEqualityOperator(pattern.kind),
          subject,
          scalarPatternValue(pattern),
        ),
        success,
        failure,
      );
    }
    const normalized = this.normalizeConstructorPattern(pattern);
    const selected = this.#constructors.get(normalized.constructor);
    if (selected === undefined) {
      throw new GleamLoweringError(
        pattern.span,
        `Gleam case references unknown constructor ${JSON.stringify(normalized.constructor)}.`,
      );
    }
    if (normalized.arguments.length !== selected.fields.length) {
      throw new GleamLoweringError(
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
    return at.case(
      subject,
      constructors.map((constructor) => {
        const shape = this.#constructors.get(constructor)!;
        const binders = Array.from({ length: shape.fields.length }, () => this.discardName());
        return {
          constructor,
          binders,
          body: constructor === normalized.constructor
            ? this.lowerPatternSequence(binders, normalized.arguments, success, failure)
            : failure,
        };
      }),
    );
  }

  private lowerStringPrefixPattern(
    subjectName: string,
    pattern: Extract<GleamPattern, { readonly kind: "string-prefix" }>,
    success: SurfaceExpression,
    failure: SurfaceExpression,
  ): SurfaceExpression {
    this.registerTextIntrinsics();
    const at = surface.at(pattern.span);
    const prefixByteLength = new TextEncoder().encode(pattern.prefix).byteLength;
    const lengthName = `$gleam_prefix_length_${this.#discardIndex++}`;
    const restName = `$gleam_prefix_rest_${this.#discardIndex++}`;
    const subject = name(subjectName, pattern.span);
    const prefixLength = at.integer(prefixByteLength);
    const slice = (start: SurfaceExpression, end: SurfaceExpression) =>
      at.apply(
        name(GLEAM_TEXT_BYTE_SLICE, pattern.span),
        nestedTupleExpression(
          [subject, nestedTupleExpression([start, end], pattern.span)],
          pattern.span,
        ),
      );
    const matchedRest = this.lowerPattern(restName, pattern.rest, success, failure);
    return at.let(
      lengthName,
      at.apply(name(GLEAM_TEXT_BYTE_LENGTH, pattern.span), subject),
      at.if(
        at.binary(
          BinaryOperator.GreaterEqual,
          name(lengthName, pattern.span),
          prefixLength,
        ),
        at.if(
          at.structuralEqual(
            slice(at.integer(0), prefixLength),
            at.text(pattern.prefix),
          ),
          at.let(
            restName,
            slice(prefixLength, name(lengthName, pattern.span)),
            matchedRest,
          ),
          failure,
        ),
        failure,
      ),
    );
  }

  private lowerBitArraySegmentsPattern(
    subjectName: string,
    pattern: Extract<GleamPattern, { readonly kind: "bit-array-segments" }>,
    success: SurfaceExpression,
    failure: SurfaceExpression,
  ): SurfaceExpression {
    const bitArray = { kind: "named" as const, name: GLEAM_BIT_ARRAY_TYPE, arguments: [] };
    const segmentTypes = pattern.segments.map((segment): TypeSchema =>
      segment.options.some((option) => option.name === "bits" || option.name === "bytes")
        ? bitArray
        : signedInteger64Type()
    );
    const payload = segmentTypes.length === 1 ? segmentTypes[0]! : nestedTupleSchema(segmentTypes);
    const optionArguments = pattern.segments.flatMap((segment) =>
      segment.options.flatMap((option) => option.arguments)
    );
    const parameter = optionArguments.length === 0
      ? bitArray
      : nestedTupleSchema([bitArray, ...optionArguments.map(() => signedInteger64Type())]);
    const result: TypeSchema = {
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
      body: surface.at(definitionSpan).runtimeFault(
        `unbound Gleam bit-array pattern ${operationName}`,
      ),
      span: definitionSpan,
    });

    const payloadName = `$gleam_bit_payload_${this.#discardIndex++}`;
    const extractedPattern = pattern.segments.length === 1 ? pattern.segments[0]!.value : {
      kind: "tuple" as const,
      values: pattern.segments.map((segment) => segment.value) as [
        GleamPattern,
        GleamPattern,
        ...GleamPattern[],
      ],
      span: pattern.span,
    };
    const matched = this.lowerPattern(payloadName, extractedPattern, success, failure);
    const argumentValues = [
      name(subjectName, pattern.span),
      ...optionArguments.map((argument) => this.lowerExpression(argument)),
    ];
    const at = surface.at(pattern.span);
    return at.case(
      at.apply(
        name(definitionName, pattern.span),
        argumentValues.length === 1
          ? argumentValues[0]!
          : nestedTupleExpression(argumentValues, pattern.span),
      ),
      [{
        constructor: GLEAM_RESULT_OK,
        binders: [payloadName],
        body: matched,
      }, {
        constructor: GLEAM_RESULT_ERROR,
        binders: [this.discardName()],
        body: failure,
      }],
    );
  }

  private lowerBitArrayBuild(
    expression: Extract<GleamExpression, { readonly kind: "bit-array-build" }>,
  ): SurfaceExpression {
    const segment = expression.segments[0];
    if (
      expression.segments.length !== 1 || segment === undefined ||
      segment.options.length !== 1 || segment.options[0]?.name !== "utf8_codepoint" ||
      segment.options[0].arguments.length !== 0
    ) {
      throw new GleamLoweringError(
        expression.span,
        "A dynamic Gleam bit array currently requires one utf8_codepoint segment.",
      );
    }

    const parameter = signedInteger64Type();
    const result = { kind: "named" as const, name: GLEAM_BIT_ARRAY_TYPE, arguments: [] };
    if (!this.#externalCapabilities.has(GLEAM_BIT_ARRAY_INTRINSIC_CAPABILITY)) {
      this.#externalCapabilities.set(
        GLEAM_BIT_ARRAY_INTRINSIC_CAPABILITY,
        new Map([["fromUtf8Codepoint", {
          kind: "operation",
          name: "fromUtf8Codepoint",
          purity: "pure",
          parameter,
          result,
        }]]),
      );
      this.#hostDefinitions.push({
        definition: GLEAM_BIT_ARRAY_FROM_UTF8_CODEPOINT,
        capability: GLEAM_BIT_ARRAY_INTRINSIC_CAPABILITY,
        field: "fromUtf8Codepoint",
      });
      const definitionSpan = {
        startByte: this.module.span.endByte,
        endByte: this.module.span.endByte,
      };
      this.#intrinsicDefinitions.push({
        name: GLEAM_BIT_ARRAY_FROM_UTF8_CODEPOINT,
        parameters: [],
        annotation: { kind: "function", parameter, result },
        body: surface.at(definitionSpan).runtimeFault(
          "unbound Gleam utf8_codepoint bit-array construction",
        ),
        span: definitionSpan,
      });
    }
    return surface.at(expression.span).apply(
      name(GLEAM_BIT_ARRAY_FROM_UTF8_CODEPOINT, expression.span),
      this.lowerExpression(segment.value),
    );
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
      name: TEXT_TYPE_NAME,
      arguments: [],
    };
    const fields = new Map<string, HostOperationDeclaration>();
    fields.set("byteLength", {
      kind: "operation",
      name: "byteLength",
      purity: "pure",
      parameter: text,
      result: integer,
      wasmIntrinsic: WasmIntrinsic.BufferByteLength,
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
      wasmIntrinsic: WasmIntrinsic.BufferByteSlice,
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
        body: surface.at(definitionSpan).runtimeFault(`unbound Gleam text intrinsic ${field}`),
        span: definitionSpan,
      });
    }
  }

  private lowerScalarCase(
    subject: SurfaceExpression,
    arms: Extract<GleamExpression, { readonly kind: "case" }>["arms"],
    span: Span,
  ): SurfaceExpression {
    const subjectName = `$gleam_case_${this.#discardIndex++}`;
    const booleanValues = new Set(
      arms.flatMap((arm) => {
        const pattern = arm.patterns[0];
        return pattern?.kind === "boolean" ? [pattern.value] : [];
      }),
    );
    const exhaustiveBoolean = booleanValues.size === 2 &&
      arms.every((arm) => arm.patterns[0]?.kind === "boolean");
    let fallback: SurfaceExpression | null = exhaustiveBoolean
      ? surface.at(span).runtimeFault("unreachable exhaustive Bool case")
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
          throw new GleamLoweringError(
            pattern.span,
            "A scalar Gleam catch-all case arm must be last.",
          );
        }
        fallback = pattern.kind === "variable"
          ? surface.at(arm.span).let(pattern.name, name(subjectName, pattern.span), body)
          : body;
        continue;
      }
      if (fallback === null) {
        throw new GleamLoweringError(
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
      fallback = surface.at(arm.span).if(
        surface.at(pattern.span).binary(
          scalarEqualityOperator(pattern.kind),
          name(subjectName, pattern.span),
          scalarPatternValue(pattern),
        ),
        body,
        fallback,
      );
    }
    if (fallback === null) throw new Error("Gleam scalar case lowering omitted its fallback.");
    return surface.at(span).let(subjectName, subject, fallback);
  }

  private lowerConstructorArms(
    arms: Extract<GleamExpression, { readonly kind: "case" }>["arms"],
  ): readonly SurfaceCaseArm[] {
    const lowered: SurfaceCaseArm[] = [];
    let owner: string | null = null;
    let catchAll: typeof arms[number] | null = null;
    for (const arm of arms) {
      const pattern = arm.patterns[0]!;
      if (pattern.kind === "variable" || pattern.kind === "discard") {
        if (catchAll !== null) {
          throw new GleamLoweringError(
            pattern.span,
            "Gleam case repeats a catch-all arm.",
          );
        }
        catchAll = arm;
        continue;
      }
      if (catchAll !== null) {
        throw new GleamLoweringError(
          pattern.span,
          "A Gleam catch-all case arm must be last.",
        );
      }
      const normalized = this.normalizeConstructorPattern(pattern);
      const shape = this.#constructors.get(normalized.constructor);
      if (shape === undefined) {
        throw new GleamLoweringError(
          pattern.span,
          `Gleam case references unknown constructor ${JSON.stringify(normalized.constructor)}.`,
        );
      }
      if (owner !== null && owner !== shape.owner) {
        throw new GleamLoweringError(
          pattern.span,
          `Gleam case mixes constructors from ${JSON.stringify(owner)} and ${
            JSON.stringify(shape.owner)
          }.`,
        );
      }
      if (normalized.arguments.length !== shape.fields.length) {
        throw new GleamLoweringError(
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
      throw new GleamLoweringError(
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
          body = surface.at(catchAll.span).let(
            pattern.name,
            applyMany(
              name(constructor, pattern.span),
              binders.map((binder) => name(binder, pattern.span)),
              pattern.span,
            ),
            body,
          );
        }
        lowered.push({ constructor, binders, body, span: catchAll.span });
      }
    }
    const missing = constructors.filter((constructor) =>
      !lowered.some((arm) => arm.constructor === constructor)
    );
    if (missing.length > 0) {
      throw new GleamLoweringError(
        arms[0]!.span,
        `Gleam case is not exhaustive; missing ${
          missing.map((value) => JSON.stringify(value)).join(", ")
        }.`,
      );
    }
    return lowered;
  }

  private normalizeConstructorPattern(pattern: GleamPattern): {
    readonly constructor: string;
    readonly arguments: readonly GleamPattern[];
  } {
    if (pattern.kind === "list-nil") return { constructor: GLEAM_LIST_NIL, arguments: [] };
    if (pattern.kind === "list-cons") {
      return { constructor: GLEAM_LIST_CONS, arguments: [pattern.head, pattern.tail] };
    }
    if (pattern.kind === "tuple") {
      if (pattern.values.length === 0) {
        return { constructor: GLEAM_TUPLE_ZERO_VALUE, arguments: [] };
      }
      if (pattern.values.length === 1) {
        return { constructor: GLEAM_TUPLE_ONE_VALUE, arguments: [pattern.values[0]!] };
      }
      return {
        constructor: PAIR_CONSTRUCTOR_NAME,
        arguments: nestedTuplePatternArguments(pattern),
      };
    }
    if (pattern.kind === "unit") {
      return { constructor: UNIT_CONSTRUCTOR_NAME, arguments: [] };
    }
    if (pattern.kind !== "constructor") {
      throw new GleamLoweringError(
        pattern.span,
        `Gleam pattern ${JSON.stringify(pattern.kind)} cannot select an algebraic constructor.`,
      );
    }
    const shape = this.#constructors.get(pattern.name);
    if (shape === undefined) {
      throw new GleamLoweringError(
        pattern.span,
        `Gleam case references unknown constructor ${JSON.stringify(pattern.name)}.`,
      );
    }
    const ordered: Array<GleamPattern | undefined> = Array(shape.fields.length);
    let positionalIndex = 0;
    let receivedLabel = false;
    for (const argument of pattern.arguments) {
      if (argument.label === null) {
        if (receivedLabel) {
          throw new GleamLoweringError(
            argument.span,
            `Gleam pattern ${
              JSON.stringify(pattern.name)
            } places a positional field after a labeled field.`,
          );
        }
        if (positionalIndex >= ordered.length) {
          throw new GleamLoweringError(
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
        throw new GleamLoweringError(
          argument.span,
          `Gleam pattern ${JSON.stringify(pattern.name)} has unknown field ${
            JSON.stringify(argument.label)
          }.`,
        );
      }
      if (ordered[index] !== undefined) {
        throw new GleamLoweringError(
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
        throw new GleamLoweringError(
          pattern.span,
          `Gleam pattern ${JSON.stringify(pattern.name)} omits field ${
            JSON.stringify(shape.fields[index] ?? index)
          } without '..'.`,
        );
      }
      ordered[index] = { kind: "discard", span: pattern.span };
    }
    return { constructor: pattern.name, arguments: ordered as readonly GleamPattern[] };
  }

  private lowerPatternBinder(pattern: GleamPattern): string {
    if (pattern.kind === "variable") return pattern.name;
    if (pattern.kind === "discard") return this.discardName();
    throw new GleamLoweringError(
      pattern.span,
      "Nested Gleam constructor patterns currently accept only variables and discards.",
    );
  }

  private discardName(): string {
    return `$gleam_discard_${this.#discardIndex++}`;
  }
}

class GleamTypeResolver {
  readonly #aliases = new Map<string, GleamTypeAlias>();
  readonly #nominals = new Map<string, { readonly name: string; readonly arity: number }>([
    ["List", { name: GLEAM_LIST_TYPE, arity: 1 }],
    ["String", { name: TEXT_TYPE_NAME, arity: 0 }],
    ["UtfCodepoint", { name: WHOLE_NUMBER_F64_TYPE_NAME, arity: 0 }],
    ["BitArray", { name: GLEAM_BIT_ARRAY_TYPE, arity: 0 }],
    ["Result", { name: GLEAM_RESULT_TYPE, arity: 2 }],
  ]);
  readonly #localTypes = new Set<string>();

  constructor(
    private readonly module: GleamModule,
    availableExports: readonly GleamExportSignature[],
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
        GleamExportSignature,
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
      const arguments_ = alias.parameters.map((name): GleamType => ({
        kind: "parameter",
        name,
        span: alias.span,
      }));
      this.lower({ kind: "named", name: alias.name, arguments: arguments_, span: alias.span });
    }
  }

  lower(
    type: GleamType,
    substitutions: ReadonlyMap<string, TypeSchema> = new Map(),
    aliasStack: readonly string[] = [],
  ): TypeSchema {
    switch (type.kind) {
      case "boolean":
      case "unit":
        return { kind: type.kind };
      case "integer":
        return signedInteger64Type();
      case "float":
        return { kind: "float-64" };
      case "parameter":
        return substitutions.get(type.name) ?? { kind: "parameter", name: type.name };
      case "tuple": {
        if (type.values.length === 0) {
          return { kind: "named", name: GLEAM_TUPLE_ZERO_TYPE, arguments: [] };
        }
        if (type.values.length === 1) {
          return {
            kind: "named",
            name: GLEAM_TUPLE_ONE_TYPE,
            arguments: [this.lower(type.values[0]!, substitutions, aliasStack)],
          };
        }
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
          type.parameters.length === 0
            ? [{ kind: "unit" }]
            : type.parameters.map((parameter) => this.lower(parameter, substitutions, aliasStack)),
          this.lower(type.result, substitutions, aliasStack),
        );
      case "named": {
        const alias = this.#aliases.get(type.name);
        if (alias !== undefined) {
          if (type.arguments.length !== alias.parameters.length) {
            throw this.invalidArity(type, alias.parameters.length);
          }
          if (aliasStack.includes(alias.name)) {
            throw new GleamLoweringError(
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
          throw new GleamLoweringError(
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
    type: Extract<GleamType, { readonly kind: "named" }>,
    expected: number,
  ): GleamLoweringError {
    return new GleamLoweringError(
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
  schema: TypeSchema | null,
  typeNames: ReadonlyMap<string, string>,
): TypeSchema | null {
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
  declaration: GleamFunction,
  typeResolver: GleamTypeResolver,
): TypeSchema | null {
  if (
    declaration.parameters.some((parameter) => parameter.annotation === null) ||
    declaration.result === null
  ) {
    return null;
  }
  const parameters = declaration.parameters.length === 0
    ? [{ kind: "unit" as const }]
    : declaration.parameters.map((parameter) => typeResolver.lower(parameter.annotation!));
  const functionType = curryType(parameters, typeResolver.lower(declaration.result));
  const typeParameters: string[] = [];
  const seen = new Set<string>();
  const collect = (type: GleamType): void => {
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
  declaration: GleamConstant,
  typeResolver: GleamTypeResolver,
): TypeSchema | null {
  if (declaration.annotation === null) return null;
  return typeResolver.lower(declaration.annotation);
}

function curryType(
  parameters: readonly TypeSchema[],
  result: TypeSchema,
): TypeSchema {
  let current = result;
  for (let index = parameters.length - 1; index >= 0; index--) {
    current = { kind: "function", parameter: parameters[index]!, result: current };
  }
  return current;
}

function nestedTupleSchema(
  values:
    | readonly [TypeSchema, ...TypeSchema[]]
    | readonly TypeSchema[],
): TypeSchema {
  if (values.length === 0) throw new Error("A host operation parameter list cannot be empty.");
  let result = values.at(-1)!;
  for (let index = values.length - 2; index >= 0; index--) {
    result = { kind: "tuple", values: [values[index]!, result] };
  }
  return result;
}

function nestedTupleExpression(
  values: readonly SurfaceExpression[],
  span: Span,
): SurfaceExpression {
  if (values.length === 0) throw new Error("A host operation argument list cannot be empty.");
  let result = values.at(-1)!;
  for (let index = values.length - 2; index >= 0; index--) {
    result = applyMany(
      name(PAIR_CONSTRUCTOR_NAME, span),
      [values[index]!, result],
      span,
    );
  }
  return result;
}

function schemaContainsParameter(schema: TypeSchema): boolean {
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
  type: GleamType,
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
      throw new GleamLoweringError(
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
  pattern: Extract<GleamPattern, { readonly kind: "tuple" }>,
): readonly [GleamPattern, GleamPattern] {
  let tail = pattern.values.at(-1)!;
  for (let index = pattern.values.length - 2; index >= 1; index--) {
    tail = {
      kind: "tuple",
      values: [pattern.values[index]!, tail],
      span: pattern.span,
    };
  }
  return [pattern.values[0]!, tail];
}

function isScalarPattern(pattern: GleamPattern): boolean {
  return pattern.kind === "integer" || pattern.kind === "boolean" ||
    pattern.kind === "float" || pattern.kind === "bit-array" || pattern.kind === "string" ||
    pattern.kind === "variable" || pattern.kind === "discard";
}

function unaliasedPattern(pattern: GleamPattern): GleamPattern {
  let result = pattern;
  while (result.kind === "alias") result = result.pattern;
  return result;
}

function isIrrefutablePattern(pattern: GleamPattern): boolean {
  if (pattern.kind === "variable" || pattern.kind === "discard") return true;
  return pattern.kind === "alias" && isIrrefutablePattern(pattern.pattern);
}

function scalarEqualityOperator(
  kind: "integer" | "float" | "boolean" | "bit-array" | "string",
): BinaryOperator {
  if (kind === "integer") return BinaryOperator.EqualSignedInteger64;
  if (kind === "float") return BinaryOperator.EqualFloat64;
  return BinaryOperator.StructuralEqual;
}

function scalarPatternValue(
  pattern: Extract<
    GleamPattern,
    { readonly kind: "integer" | "float" | "boolean" | "bit-array" | "string" }
  >,
): SurfaceExpression {
  const at = surface.at(pattern.span);
  if (pattern.kind === "integer") return at.signedInteger64(BigInt(pattern.value));
  if (pattern.kind === "float") return at.float64(pattern.value);
  if (pattern.kind === "boolean") return at.boolean(pattern.value);
  if (pattern.kind === "string") return at.text(pattern.value);
  return bitArrayExpression(pattern.bytes, pattern.bitLength, pattern.span);
}

/**
 * `surface.at(span).apply` stamps only the outermost node of a variadic spine, but Gleam stamps
 * every node of the spine with the call's span, so the fold stays here and applies one argument at
 * a time.
 */
function applyMany(
  callee: SurfaceExpression,
  arguments_: readonly SurfaceExpression[],
  span: Span,
): SurfaceExpression {
  return surface.at(span).apply(callee, ...arguments_);
}

function name(value: string, span: Span): SurfaceExpression {
  return surface.at(span).name(value);
}

function bitArrayExpression(
  bytes: Uint8Array,
  bitLength: number,
  span: Span,
): SurfaceExpression {
  const at = surface.at(span);
  return applyMany(
    name(GLEAM_BIT_ARRAY_VALUE, span),
    [at.bytes(bytes), at.signedInteger64(BigInt(bitLength))],
    span,
  );
}

function gleamListDeclaration(sourceByteLength: number): SurfaceTypeDeclaration {
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

function gleamBitArrayDeclaration(sourceByteLength: number): SurfaceTypeDeclaration {
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
          type: { kind: "named", name: BYTES_TYPE_NAME, arguments: [] },
          span,
        },
        { name: "bitLength", type: signedInteger64Type(), span },
      ],
    }],
  };
}

function gleamResultDeclaration(sourceByteLength: number): SurfaceTypeDeclaration {
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

function gleamTupleZeroDeclaration(sourceByteLength: number): SurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: GLEAM_TUPLE_ZERO_TYPE,
    parameters: [],
    span,
    constructors: [{ name: GLEAM_TUPLE_ZERO_VALUE, fields: [], span }],
  };
}

function gleamTupleOneDeclaration(sourceByteLength: number): SurfaceTypeDeclaration {
  const span = { startByte: sourceByteLength, endByte: sourceByteLength };
  return {
    name: GLEAM_TUPLE_ONE_TYPE,
    parameters: ["value"],
    span,
    constructors: [{
      name: GLEAM_TUPLE_ONE_VALUE,
      fields: [{ name: "value", type: { kind: "parameter", name: "value" }, span }],
      span,
    }],
  };
}

function signedInteger64Type(): TypeSchema {
  return { kind: "signed-integer-64" };
}

function requireUniqueNames(
  names: readonly string[],
  span: Span,
  location: string,
): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      continue;
    }
    throw new GleamLoweringError(
      span,
      `Gleam ${location} repeat ${JSON.stringify(name)}.`,
    );
  }
}
