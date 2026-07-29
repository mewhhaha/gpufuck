import {
  AlgebraicTypeWord,
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  DEFINITION_WORD_LENGTH,
  type EncodedSemanticSurface,
  MAXIMUM_PARSE_DEPTH,
  MODULE_ABI_VERSION,
  NO_INDEX,
  type Type,
  TYPE_WORD_LENGTH,
  type TypeSchema,
} from "./abi.ts";

/** The schema buffer accompanies version 7 of the surface ABI. */
export const TYPE_SCHEMA_ABI_VERSION = MODULE_ABI_VERSION;
export const TYPE_SCHEMA_WORD_LENGTH = 6;
export const TYPE_SCHEMA_BYTE_LENGTH = TYPE_SCHEMA_WORD_LENGTH *
  Uint32Array.BYTES_PER_ELEMENT;
export const TYPE_SCHEMA_METADATA_ARRAY_COUNT = 7;
export const TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH = 2 +
  TYPE_SCHEMA_METADATA_ARRAY_COUNT * 2;

/** Word positions for one compact, linked-preorder type-schema record. */
export const TypeSchemaWord = {
  Tag: 0,
  Symbol: 1,
  FirstChild: 2,
  NextSibling: 3,
  StartByte: 4,
  EndByte: 5,
} as const;

/** Header positions for the single schema metadata storage-buffer binding. */
export const TypeSchemaMetadataWord = {
  AbiVersion: 0,
  HeaderWordLength: 1,
  SchemaWordsOffset: 2,
  SchemaWordsLength: 3,
  DefinitionAnnotationRootsOffset: 4,
  DefinitionAnnotationRootsLength: 5,
  TypeParameterOffsetsOffset: 6,
  TypeParameterOffsetsLength: 7,
  TypeParameterSymbolsOffset: 8,
  TypeParameterSymbolsLength: 9,
  ConstructorFieldOffsetsOffset: 10,
  ConstructorFieldOffsetsLength: 11,
  ConstructorFieldRootsOffset: 12,
  ConstructorFieldRootsLength: 13,
  ConstructorResultRootsOffset: 14,
  ConstructorResultRootsLength: 15,
} as const;

/**
 * Tags stored in `schemaWords`. `Symbol` holds a named-type surface symbol or a schema
 * parameter ID; a missing child or sibling is represented by `NO_INDEX`.
 */
export const TypeSchemaTag = {
  Integer: 1,
  Boolean: 2,
  Unit: 3,
  Parameter: 4,
  Tuple: 5,
  Named: 6,
  Function: 7,
  Forall: 8,
  SignedInteger64: 9,
  Float32: 10,
  Float64: 11,
} as const;

export type TypeSchemaTag = (typeof TypeSchemaTag)[keyof typeof TypeSchemaTag];

/** Numeric buffers ready to upload alongside an ABI-v7 surface. */
export interface FlattenedTypeSchemas {
  /** One GPU-uploadable buffer: a fixed header followed by the seven logical arrays below. */
  readonly metadataWords: Uint32Array;
  /** Surface symbol names followed by synthetic identifiers used only by schema records. */
  readonly identifierNames: readonly string[];
  /** Linked-preorder records, each `TYPE_SCHEMA_WORD_LENGTH` words long. */
  readonly schemaWords: Uint32Array;
  /** One schema root per encoded definition, or `NO_INDEX` when unannotated. */
  readonly definitionAnnotationRoots: Uint32Array;
  /** Prefix offsets into `typeParameterSymbols`, one entry for every encoded type plus one. */
  readonly typeParameterOffsets: Uint32Array;
  /** Type-parameter IDs in encoded-type order; IDs absent from the surface table are synthetic. */
  readonly typeParameterSymbols: Uint32Array;
  /** Prefix offsets into `constructorFieldRoots`, one entry for every constructor plus one. */
  readonly constructorFieldOffsets: Uint32Array;
  /** Field-schema roots in encoded-constructor and source-field order. */
  readonly constructorFieldRoots: Uint32Array;
  /** One canonical result-schema root for every encoded constructor. */
  readonly constructorResultRoots: Uint32Array;
}

/** A portable representation of one inferred, concrete type. */
export interface SerializedType {
  readonly schemaWords: Uint32Array;
  readonly root: number;
}

/**
 * Converts frontend type metadata into numeric schema buffers. Named types use the same
 * symbol IDs as `surface.nodeWords`; parameter IDs are synthetic when a frontend-built-in
 * declaration did not intern its parameter spelling.
 */
export function flattenTypeSchemas(
  surface: EncodedSemanticSurface,
): FlattenedTypeSchemas {
  const counts = validateSurfaceShape(surface);
  const identifiers = new TypeSchemaIdentifiers(
    surface.symbolNames,
    surface.typeDeclarations.map((declaration) => declaration.name),
  );
  const schemaEncoder = new TypeSchemaEncoder(identifiers);

  const definitionAnnotationRoots = new Uint32Array(counts.definitionCount);
  definitionAnnotationRoots.fill(NO_INDEX);

  const typeParameterOffsets: number[] = [0];
  const typeParameterSymbols: number[] = [];
  const constructorFieldOffsets: number[] = [0];
  const constructorFieldRoots: number[] = [];
  const constructorResultRoots: number[] = [];
  let constructorIndex = 0;

  for (let typeIndex = 0; typeIndex < counts.typeCount; typeIndex++) {
    const declaration = surface.typeDeclarations[typeIndex];
    if (declaration === undefined) {
      throw new Error(`type metadata omitted type ${typeIndex}.`);
    }
    validateTypeDeclaration(
      surface,
      counts,
      typeIndex,
      constructorIndex,
      declaration.name,
      declaration.constructors,
    );

    for (const parameter of declaration.parameters) {
      typeParameterSymbols.push(identifiers.parameterId(parameter, `type ${typeIndex} parameter`));
    }
    typeParameterOffsets.push(typeParameterSymbols.length);
    for (const constructor of declaration.constructors) {
      for (let fieldIndex = 0; fieldIndex < constructor.fields.length; fieldIndex++) {
        const field = constructor.fields[fieldIndex];
        if (field === undefined) {
          throw new Error(
            `type ${JSON.stringify(declaration.name)} constructor ${
              JSON.stringify(constructor.name)
            } omitted field ${fieldIndex}.`,
          );
        }
        if (containsForall(field.type)) {
          throw new Error(
            `constructor ${constructorIndex} field ${fieldIndex} cannot contain higher-rank forall`,
          );
        }
        constructorFieldRoots.push(schemaEncoder.encode(
          field.type,
          `constructor ${constructorIndex} field ${fieldIndex}`,
        ));
      }
      constructorFieldOffsets.push(constructorFieldRoots.length);
      if (constructor.result !== undefined && containsForall(constructor.result)) {
        throw new Error(`constructor ${constructorIndex} result cannot contain higher-rank forall`);
      }
      constructorResultRoots.push(schemaEncoder.encode(
        constructor.result ?? synthesizedConstructorResult(declaration, constructor.name),
        `constructor ${constructorIndex} result`,
        {
          implicitNamedParameters: false,
          syntheticResultRoot: constructor.result === undefined,
        },
      ));
      constructorIndex++;
    }
  }

  if (constructorIndex !== counts.constructorCount) {
    throw new Error(
      `type metadata described ${constructorIndex} constructors; the surface encodes ${counts.constructorCount}.`,
    );
  }

  for (let definitionIndex = 0; definitionIndex < counts.definitionCount; definitionIndex++) {
    const definitionType = surface.definitionTypes[definitionIndex];
    if (definitionType === undefined) {
      throw new Error(`type metadata omitted definition ${definitionIndex}.`);
    }
    if (definitionType.annotation !== null) {
      validateHigherRankDefinitionSchema(
        definitionType.annotation,
        `definition ${definitionIndex} annotation`,
      );
      definitionAnnotationRoots[definitionIndex] = schemaEncoder.encode(
        definitionType.annotation,
        `definition ${definitionIndex} annotation`,
        { implicitNamedParameters: true, syntheticResultRoot: false },
      );
    }
  }

  return packSchemaMetadata([
    Uint32Array.from(schemaEncoder.words),
    definitionAnnotationRoots,
    Uint32Array.from(typeParameterOffsets),
    Uint32Array.from(typeParameterSymbols),
    Uint32Array.from(constructorFieldOffsets),
    Uint32Array.from(constructorFieldRoots),
    Uint32Array.from(constructorResultRoots),
  ], identifiers.names);
}

function validateHigherRankDefinitionSchema(schema: TypeSchema, context: string): void {
  const forallNames = new Set<string>();
  const freeParameters = new Set<string>();
  const visit = (
    current: TypeSchema,
    forallAllowed: boolean,
    bound: ReadonlySet<string>,
  ): void => {
    switch (current.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
      case "parameter":
        if (current.kind === "parameter" && !bound.has(current.name)) {
          freeParameters.add(current.name);
        }
        return;
      case "tuple":
        visit(current.values[0], false, bound);
        visit(current.values[1], false, bound);
        return;
      case "named":
        for (const argument of current.arguments) visit(argument, false, bound);
        return;
      case "function":
        visit(current.parameter, true, bound);
        visit(current.result, false, bound);
        return;
      case "forall": {
        if (!forallAllowed) {
          throw new Error(`${context} places forall outside a function parameter`);
        }
        if (current.parameters.length === 0) {
          throw new Error(`${context} forall must bind at least one type parameter`);
        }
        const nested = new Set(bound);
        for (const parameter of current.parameters) {
          requireTypeName(parameter, `${context} forall parameter`);
          if (nested.has(parameter)) {
            throw new Error(
              `${context} repeats forall parameter ${JSON.stringify(parameter)}`,
            );
          }
          if (forallNames.has(parameter)) {
            throw new Error(
              `${context} repeats forall parameter ${JSON.stringify(parameter)}`,
            );
          }
          forallNames.add(parameter);
          nested.add(parameter);
        }
        visit(current.body, false, nested);
        return;
      }
    }
  };
  visit(schema, false, new Set());
  for (const parameter of forallNames) {
    if (freeParameters.has(parameter)) {
      throw new Error(
        `${context} uses ${JSON.stringify(parameter)} as both free and forall-bound`,
      );
    }
  }
}

function containsForall(schema: TypeSchema): boolean {
  switch (schema.kind) {
    case "forall":
      return true;
    case "tuple":
      return containsForall(schema.values[0]) || containsForall(schema.values[1]);
    case "named":
      return schema.arguments.some(containsForall);
    case "function":
      return containsForall(schema.parameter) || containsForall(schema.result);
    case "integer":
    case "signed-integer-64":
    case "float-32":
    case "float-64":
    case "boolean":
    case "unit":
    case "parameter":
      return false;
  }
}

/** Serializes a concrete inferred type using the same records as `schemaWords`. */
export function serializeType(
  type: Type,
  symbolNames: readonly string[],
): SerializedType {
  const identifiers = new TypeSchemaIdentifiers(symbolNames);
  const encoder = new TypeSchemaEncoder(identifiers);
  const root = encoder.encode(type, "inferred type");
  if (identifiers.names.length !== symbolNames.length) {
    throw new Error(
      `inferred type references named type ${
        JSON.stringify(identifiers.names[symbolNames.length])
      }, which is absent from the symbol table`,
    );
  }
  return Object.freeze({ schemaWords: Uint32Array.from(encoder.words), root });
}

/**
 * Decodes one concrete inferred type from a schema buffer. Parameter-tagged records are
 * rejected because an inferred `Type` cannot contain a type parameter.
 */
export function decodeType(
  schemaWords: Uint32Array,
  root: number,
  symbolNames: readonly string[],
): Type {
  return decodeTypeRecords(schemaWords, root, symbolNames, false) as Type;
}

/** Decodes one possibly-parameterized schema from the canonical linked-preorder records. */
export function decodeTypeSchema(
  schemaWords: Uint32Array,
  root: number,
  identifierNames: readonly string[],
): TypeSchema {
  return decodeTypeRecords(schemaWords, root, identifierNames, true);
}

function decodeTypeRecords(
  schemaWords: Uint32Array,
  root: number,
  identifierNames: readonly string[],
  allowParameters: boolean,
): TypeSchema {
  if (schemaWords.length % TYPE_SCHEMA_WORD_LENGTH !== 0) {
    throw new Error(
      `type schema has ${schemaWords.length} words, not a multiple of ${TYPE_SCHEMA_WORD_LENGTH}.`,
    );
  }
  if (root === NO_INDEX) {
    throw new Error("type schema root must not be NO_INDEX.");
  }

  const recordCount = schemaWords.length / TYPE_SCHEMA_WORD_LENGTH;
  const used = new Set<number>();
  const active = new Set<number>();
  const decode = (index: number, depth: number): TypeSchema => {
    if (depth > MAXIMUM_PARSE_DEPTH) {
      throw new Error(
        `type schema exceeds the ABI nesting limit of ${MAXIMUM_PARSE_DEPTH} at record ${index}.`,
      );
    }
    if (!Number.isInteger(index) || index < 0 || index >= recordCount) {
      throw new Error(
        `type schema references record ${index}; it has ${recordCount} records.`,
      );
    }
    if (active.has(index)) {
      throw new Error(`type schema contains a cycle through record ${index}.`);
    }
    if (used.has(index)) {
      throw new Error(`type schema record ${index} is referenced more than once.`);
    }
    used.add(index);
    active.add(index);

    try {
      const offset = index * TYPE_SCHEMA_WORD_LENGTH;
      const tag = requiredWord(schemaWords, offset + TypeSchemaWord.Tag, index);
      const symbol = requiredWord(schemaWords, offset + TypeSchemaWord.Symbol, index);
      const firstChild = requiredWord(
        schemaWords,
        offset + TypeSchemaWord.FirstChild,
        index,
      );
      const startByte = requiredWord(
        schemaWords,
        offset + TypeSchemaWord.StartByte,
        index,
      );
      const endByte = requiredWord(schemaWords, offset + TypeSchemaWord.EndByte, index);
      const isSyntheticResultRoot = depth === 0 &&
        startByte === NO_INDEX && endByte === NO_INDEX;
      if (startByte > endByte && !isSyntheticResultRoot) {
        throw new Error(
          `type schema record ${index} starts at byte ${startByte} after it ends at byte ${endByte}.`,
        );
      }
      const children = (expectedCount: number | null): TypeSchema[] => {
        const values: TypeSchema[] = [];
        const siblings = new Set<number>();
        let child = firstChild;
        while (child !== NO_INDEX) {
          if (siblings.has(child)) {
            throw new Error(
              `type schema contains a sibling cycle through record ${child}.`,
            );
          }
          siblings.add(child);
          if (expectedCount !== null && values.length === expectedCount) {
            throw new Error(
              `type schema record ${index} has more than ${expectedCount} children.`,
            );
          }
          if (child <= index && !active.has(child) && !used.has(child)) {
            throw new Error(
              `type schema record ${index} has non-forward child ${child}.`,
            );
          }
          values.push(decode(child, depth + 1));
          const childOffset = child * TYPE_SCHEMA_WORD_LENGTH;
          const sibling = requiredWord(
            schemaWords,
            childOffset + TypeSchemaWord.NextSibling,
            child,
          );
          if (sibling !== NO_INDEX && sibling <= child) {
            if (active.has(sibling) || siblings.has(sibling)) {
              throw new Error(
                `type schema contains a sibling cycle through record ${sibling}.`,
              );
            }
            if (used.has(sibling)) {
              throw new Error(
                `type schema record ${sibling} is referenced more than once.`,
              );
            }
            throw new Error(
              `type schema record ${child} has non-forward next sibling ${sibling}.`,
            );
          }
          child = sibling;
        }
        if (expectedCount !== null && values.length !== expectedCount) {
          throw new Error(
            `type schema record ${index} has ${values.length} children; expected ${expectedCount}.`,
          );
        }
        return values;
      };
      const noChildren = (): void => {
        if (firstChild !== NO_INDEX) {
          throw new Error(`type schema record ${index} must not have children.`);
        }
      };
      const noSymbol = (): void => {
        if (symbol !== NO_INDEX) {
          throw new Error(
            `type schema record ${index} must use NO_INDEX as its symbol.`,
          );
        }
      };

      switch (tag) {
        case TypeSchemaTag.Integer:
          noSymbol();
          noChildren();
          return Object.freeze({ kind: "integer" });
        case TypeSchemaTag.SignedInteger64:
          noSymbol();
          noChildren();
          return Object.freeze({ kind: "signed-integer-64" });
        case TypeSchemaTag.Float32:
          noSymbol();
          noChildren();
          return Object.freeze({ kind: "float-32" });
        case TypeSchemaTag.Float64:
          noSymbol();
          noChildren();
          return Object.freeze({ kind: "float-64" });
        case TypeSchemaTag.Boolean:
          noSymbol();
          noChildren();
          return Object.freeze({ kind: "boolean" });
        case TypeSchemaTag.Unit:
          noSymbol();
          noChildren();
          return Object.freeze({ kind: "unit" });
        case TypeSchemaTag.Parameter: {
          const name = symbolName(identifierNames, symbol, index);
          noChildren();
          if (!allowParameters) {
            throw new Error(`inferred type record ${index} must not be a parameter.`);
          }
          return Object.freeze({ kind: "parameter", name });
        }
        case TypeSchemaTag.Tuple: {
          noSymbol();
          const values = children(2);
          const left = values[0];
          const right = values[1];
          if (left === undefined || right === undefined) {
            throw new Error(`tuple schema record ${index} omitted a child.`);
          }
          return Object.freeze({
            kind: "tuple",
            values: Object.freeze([left, right]) as readonly [
              TypeSchema,
              TypeSchema,
            ],
          });
        }
        case TypeSchemaTag.Named:
          return Object.freeze({
            kind: "named",
            name: symbolName(identifierNames, symbol, index),
            arguments: Object.freeze(children(null)),
          });
        case TypeSchemaTag.Function: {
          noSymbol();
          const values = children(2);
          const parameter = values[0];
          const result = values[1];
          if (parameter === undefined || result === undefined) {
            throw new Error(`function schema record ${index} omitted a child.`);
          }
          return Object.freeze({ kind: "function", parameter, result });
        }
        case TypeSchemaTag.Forall: {
          const parameter = symbolName(identifierNames, symbol, index);
          const values = children(1);
          const body = values[0];
          if (body === undefined) {
            throw new Error(`forall schema record ${index} omitted its body.`);
          }
          if (!allowParameters) {
            throw new Error(`inferred type record ${index} must not be a forall.`);
          }
          if (body.kind === "forall") {
            return Object.freeze({
              kind: "forall",
              parameters: Object.freeze([parameter, ...body.parameters]),
              body: body.body,
            });
          }
          return Object.freeze({
            kind: "forall",
            parameters: Object.freeze([parameter]),
            body,
          });
        }
        default:
          throw new Error(`type schema record ${index} has unsupported tag ${tag}.`);
      }
    } finally {
      active.delete(index);
    }
  };

  const decoded = decode(root, 0);
  const rootOffset = root * TYPE_SCHEMA_WORD_LENGTH;
  const rootSibling = requiredWord(
    schemaWords,
    rootOffset + TypeSchemaWord.NextSibling,
    root,
  );
  if (rootSibling !== NO_INDEX) {
    throw new Error(`type schema root ${root} must not have a next sibling.`);
  }
  return decoded;
}

class TypeSchemaEncoder {
  readonly #identifiers: TypeSchemaIdentifiers;
  readonly words: number[] = [];

  constructor(identifiers: TypeSchemaIdentifiers) {
    this.#identifiers = identifiers;
  }

  encode(
    type: TypeSchema | Type,
    context: string,
    options: {
      readonly implicitNamedParameters: boolean;
      readonly syntheticResultRoot: boolean;
    } = { implicitNamedParameters: false, syntheticResultRoot: false },
  ): number {
    return this.encodeAtDepth(type, context, 0, { startByte: 0, endByte: 0 }, options);
  }

  private encodeAtDepth(
    type: TypeSchema | Type,
    context: string,
    depth: number,
    inheritedSpan: { readonly startByte: number; readonly endByte: number },
    options: {
      readonly implicitNamedParameters: boolean;
      readonly syntheticResultRoot: boolean;
    },
  ): number {
    if (depth > MAXIMUM_PARSE_DEPTH) {
      throw new Error(
        `${context} exceeds the ABI nesting limit of ${MAXIMUM_PARSE_DEPTH}.`,
      );
    }
    if (type === null || typeof type !== "object" || !("kind" in type)) {
      throw new Error(`${context} is not a type schema.`);
    }
    const index = this.words.length / TYPE_SCHEMA_WORD_LENGTH;
    if (index >= NO_INDEX) {
      throw new Error(`${context} exceeds the maximum schema-record index ${NO_INDEX - 1}.`);
    }
    const declaredSpan = typeSchemaSpan(type, context, inheritedSpan);
    const span = options.syntheticResultRoot && depth === 0
      ? { startByte: NO_INDEX, endByte: NO_INDEX }
      : declaredSpan;

    const write = (tag: TypeSchemaTag, symbol = NO_INDEX): number => {
      this.words.push(
        tag,
        symbol,
        NO_INDEX,
        NO_INDEX,
        span.startByte,
        span.endByte,
      );
      return index;
    };
    const attachChildren = (children: readonly (TypeSchema | Type)[]): void => {
      let previous = NO_INDEX;
      for (const child of children) {
        const childIndex = this.encodeAtDepth(child, context, depth + 1, declaredSpan, options);
        if (previous === NO_INDEX) {
          this
            .words[
              index * TYPE_SCHEMA_WORD_LENGTH + TypeSchemaWord.FirstChild
            ] = childIndex;
        } else {
          this
            .words[
              previous * TYPE_SCHEMA_WORD_LENGTH + TypeSchemaWord.NextSibling
            ] = childIndex;
        }
        previous = childIndex;
      }
    };

    switch (type.kind) {
      case "integer":
        return write(TypeSchemaTag.Integer);
      case "signed-integer-64":
        return write(TypeSchemaTag.SignedInteger64);
      case "float-32":
        return write(TypeSchemaTag.Float32);
      case "float-64":
        return write(TypeSchemaTag.Float64);
      case "boolean":
        return write(TypeSchemaTag.Boolean);
      case "unit":
        return write(TypeSchemaTag.Unit);
      case "parameter":
        requireTypeName(type.name, `${context} parameter`);
        return write(
          TypeSchemaTag.Parameter,
          this.#identifiers.parameterId(type.name, `${context} parameter`),
        );
      case "tuple":
        if (!Array.isArray(type.values) || type.values.length !== 2) {
          throw new Error(`${context} tuple must have exactly two type values.`);
        }
        write(TypeSchemaTag.Tuple);
        attachChildren(type.values);
        return index;
      case "named":
        requireTypeName(type.name, `${context} named type`);
        if (!Array.isArray(type.arguments)) {
          throw new Error(
            `${context} named type ${JSON.stringify(type.name)} has non-array arguments.`,
          );
        }
        if (
          options.implicitNamedParameters && type.arguments.length === 0 &&
          !this.#identifiers.hasNamedType(type.name)
        ) {
          return write(
            TypeSchemaTag.Parameter,
            this.#identifiers.parameterId(type.name, `${context} implicit parameter`),
          );
        }
        write(
          TypeSchemaTag.Named,
          this.#identifiers.namedTypeSymbol(
            type.name,
            `${context} named type`,
          ),
        );
        attachChildren(type.arguments);
        return index;
      case "function":
        if (type.parameter === undefined || type.result === undefined) {
          throw new Error(`${context} function must have parameter and result types.`);
        }
        write(TypeSchemaTag.Function);
        attachChildren([type.parameter, type.result]);
        return index;
      case "forall": {
        if (!Array.isArray(type.parameters) || type.parameters.length === 0) {
          throw new Error(`${context} forall must bind at least one type parameter.`);
        }
        const [parameter, ...remaining] = type.parameters;
        if (parameter === undefined) {
          throw new Error(`${context} forall omitted its first type parameter.`);
        }
        requireTypeName(parameter, `${context} forall parameter`);
        write(
          TypeSchemaTag.Forall,
          this.#identifiers.parameterId(parameter, `${context} forall parameter`),
        );
        const body: TypeSchema = remaining.length === 0
          ? type.body
          : { kind: "forall", parameters: remaining, body: type.body };
        attachChildren([body]);
        return index;
      }
      default:
        throw new Error(`${context} has an unsupported type kind.`);
    }
  }
}

function validateSurfaceShape(surface: EncodedSemanticSurface): {
  readonly definitionCount: number;
  readonly typeCount: number;
  readonly constructorCount: number;
} {
  const definitionCount = abiCount(surface.definitionCount, "definitionCount");
  const typeCount = abiCount(surface.typeCount, "typeCount");
  const constructorCount = abiCount(surface.constructorCount, "constructorCount");
  if (surface.definitionWords.length !== definitionCount * DEFINITION_WORD_LENGTH) {
    throw new Error(
      `surface has ${surface.definitionWords.length} definition words for ${definitionCount} definitions.`,
    );
  }
  if (surface.typeWords.length !== typeCount * TYPE_WORD_LENGTH) {
    throw new Error(
      `surface has ${surface.typeWords.length} type words for ${typeCount} types.`,
    );
  }
  if (surface.constructorWords.length !== constructorCount * CONSTRUCTOR_WORD_LENGTH) {
    throw new Error(
      `surface has ${surface.constructorWords.length} constructor words for ${constructorCount} constructors.`,
    );
  }
  if (surface.definitionTypes.length !== definitionCount) {
    throw new Error(
      `surface has ${surface.definitionTypes.length} definition type entries for ${definitionCount} definitions.`,
    );
  }
  if (surface.typeDeclarations.length !== typeCount) {
    throw new Error(
      `surface has ${surface.typeDeclarations.length} typed declarations for ${typeCount} types.`,
    );
  }
  return { definitionCount, typeCount, constructorCount };
}

function validateTypeDeclaration(
  surface: EncodedSemanticSurface,
  counts: { readonly constructorCount: number },
  typeIndex: number,
  expectedFirstConstructor: number,
  declarationName: string,
  constructors: readonly { readonly name: string; readonly fields: readonly unknown[] }[],
): void {
  const typeOffset = typeIndex * TYPE_WORD_LENGTH;
  const encodedName = symbolName(
    surface.symbolNames,
    requiredSurfaceWord(
      surface.typeWords,
      typeOffset + AlgebraicTypeWord.Symbol,
      `type ${typeIndex}`,
    ),
    typeIndex,
  );
  if (declarationName !== encodedName) {
    throw new Error(
      `type metadata ${JSON.stringify(declarationName)} does not match encoded type ${
        JSON.stringify(encodedName)
      } at index ${typeIndex}.`,
    );
  }
  const firstConstructor = requiredSurfaceWord(
    surface.typeWords,
    typeOffset + AlgebraicTypeWord.FirstConstructor,
    `type ${typeIndex}`,
  );
  const constructorCount = requiredSurfaceWord(
    surface.typeWords,
    typeOffset + AlgebraicTypeWord.ConstructorCount,
    `type ${typeIndex}`,
  );
  if (firstConstructor !== expectedFirstConstructor) {
    throw new Error(
      `type ${typeIndex} starts at constructor ${firstConstructor}; ABI-v7 types must start at ${expectedFirstConstructor}.`,
    );
  }
  if (
    firstConstructor > counts.constructorCount ||
    constructorCount > counts.constructorCount - firstConstructor
  ) {
    throw new Error(
      `type ${typeIndex} references constructors ${firstConstructor} through ${
        firstConstructor + constructorCount
      }, outside the ${counts.constructorCount} encoded constructors.`,
    );
  }
  if (constructors.length !== constructorCount) {
    throw new Error(
      `type ${
        JSON.stringify(declarationName)
      } has ${constructors.length} typed constructors but ${constructorCount} encoded constructors.`,
    );
  }
  for (let offset = 0; offset < constructorCount; offset++) {
    const constructorIndex = firstConstructor + offset;
    const constructor = constructors[offset];
    if (constructor === undefined) {
      throw new Error(`type ${typeIndex} omitted constructor metadata ${constructorIndex}.`);
    }
    const constructorOffset = constructorIndex * CONSTRUCTOR_WORD_LENGTH;
    const encodedType = requiredSurfaceWord(
      surface.constructorWords,
      constructorOffset + ConstructorWord.Type,
      `constructor ${constructorIndex}`,
    );
    const encodedName = symbolName(
      surface.symbolNames,
      requiredSurfaceWord(
        surface.constructorWords,
        constructorOffset + ConstructorWord.Symbol,
        `constructor ${constructorIndex}`,
      ),
      constructorIndex,
    );
    const encodedArity = requiredSurfaceWord(
      surface.constructorWords,
      constructorOffset + ConstructorWord.Arity,
      `constructor ${constructorIndex}`,
    );
    if (encodedType !== typeIndex || encodedName !== constructor.name) {
      throw new Error(
        `constructor metadata ${
          JSON.stringify(constructor.name)
        } does not match encoded constructor ${
          JSON.stringify(encodedName)
        } at index ${constructorIndex}.`,
      );
    }
    if (constructor.fields.length !== encodedArity) {
      throw new Error(
        `constructor ${
          JSON.stringify(constructor.name)
        } has ${constructor.fields.length} typed fields but ${encodedArity} encoded fields.`,
      );
    }
  }
}

class TypeSchemaIdentifiers {
  readonly #surfaceSymbols = new Map<string, number>();
  readonly #namedTypes: ReadonlySet<string>;
  readonly #parameterIds = new Map<string, number>();
  readonly #unknownTypeIds = new Map<string, number>();
  readonly names: string[];
  #nextParameterId: number;

  constructor(symbolNames: readonly string[], namedTypes: readonly string[] = []) {
    this.#namedTypes = new Set(namedTypes);
    this.names = [...symbolNames];
    if (symbolNames.length >= NO_INDEX) {
      throw new Error(
        `symbol table has ${symbolNames.length} entries; the ABI maximum is ${NO_INDEX - 1}.`,
      );
    }
    for (let symbol = 0; symbol < symbolNames.length; symbol++) {
      const name = symbolNames[symbol];
      if (name === undefined || typeof name !== "string") {
        throw new Error(`symbol table omits name ${symbol}.`);
      }
      if (this.#surfaceSymbols.has(name)) {
        throw new Error(
          `symbol table repeats name ${JSON.stringify(name)} at index ${symbol}.`,
        );
      }
      this.#surfaceSymbols.set(name, symbol);
    }
    this.#nextParameterId = symbolNames.length;
  }

  namedTypeSymbol(name: string, context: string): number {
    const symbol = this.#surfaceSymbols.get(name);
    if (symbol !== undefined) return symbol;
    const existing = this.#unknownTypeIds.get(name);
    if (existing !== undefined) return existing;
    const id = this.allocateSyntheticId(context);
    this.#unknownTypeIds.set(name, id);
    this.names[id] = name;
    return id;
  }

  hasNamedType(name: string): boolean {
    return this.#namedTypes.has(name);
  }

  parameterId(name: string, context: string): number {
    requireTypeName(name, context);
    const existing = this.#parameterIds.get(name);
    if (existing !== undefined) return existing;
    const id = this.allocateSyntheticId(context);
    this.#parameterIds.set(name, id);
    this.names[id] = name;
    return id;
  }

  private allocateSyntheticId(context: string): number {
    if (this.#nextParameterId >= NO_INDEX) {
      throw new Error(`${context} exceeds the maximum schema identifier ${NO_INDEX - 1}.`);
    }
    return this.#nextParameterId++;
  }
}

function requireTypeName(name: string, context: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`${context} must have a non-empty name.`);
  }
}

function typeSchemaSpan(
  type: TypeSchema | Type,
  context: string,
  inherited: { readonly startByte: number; readonly endByte: number },
): { readonly startByte: number; readonly endByte: number } {
  const source = type as TypeSchema & {
    readonly startByte?: unknown;
    readonly endByte?: unknown;
  };
  const startByte = source.startByte === undefined
    ? inherited.startByte
    : schemaByteOffset(source.startByte, `${context} start byte`);
  const endByte = source.endByte === undefined
    ? source.startByte === undefined ? inherited.endByte : startByte
    : schemaByteOffset(source.endByte, `${context} end byte`);
  if (startByte > endByte) {
    throw new Error(`${context} starts at byte ${startByte} after it ends at byte ${endByte}.`);
  }
  return { startByte, endByte };
}

function schemaByteOffset(value: unknown, context: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new Error(`${context} must be an unsigned 32-bit integer; received ${String(value)}.`);
  }
  return value as number;
}

function synthesizedConstructorResult(
  declaration: EncodedSemanticSurface["typeDeclarations"][number],
  constructorName: string,
): TypeSchema {
  const parameters = declaration.parameters.map((name): TypeSchema => ({
    kind: "parameter",
    name,
  }));
  if (constructorName === "$Unit") return { kind: "unit" };
  if (constructorName === "$Tuple") {
    const first = parameters[0];
    const second = parameters[1];
    if (first === undefined || second === undefined || parameters.length !== 2) {
      throw new Error("the built-in tuple constructor must declare exactly two parameters");
    }
    return { kind: "tuple", values: [first, second] };
  }
  return { kind: "named", name: declaration.name, arguments: parameters };
}

function packSchemaMetadata(
  arrays: readonly [
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
    Uint32Array,
  ],
  identifierNames: readonly string[],
): FlattenedTypeSchemas {
  let totalWords = TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH;
  for (const array of arrays) {
    if (array.length > NO_INDEX - totalWords) {
      throw new Error("type schema metadata exceeds the maximum ABI buffer length.");
    }
    totalWords += array.length;
  }

  const metadataWords = new Uint32Array(totalWords);
  metadataWords[TypeSchemaMetadataWord.AbiVersion] = TYPE_SCHEMA_ABI_VERSION;
  metadataWords[TypeSchemaMetadataWord.HeaderWordLength] = TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH;
  let offset = TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH;
  const views = arrays.map((array, arrayIndex) => {
    const headerOffset = 2 + arrayIndex * 2;
    metadataWords[headerOffset] = offset;
    metadataWords[headerOffset + 1] = array.length;
    metadataWords.set(array, offset);
    const view = metadataWords.subarray(offset, offset + array.length);
    offset += array.length;
    return view;
  });
  const [
    schemaWords,
    definitionAnnotationRoots,
    typeParameterOffsets,
    typeParameterSymbols,
    constructorFieldOffsets,
    constructorFieldRoots,
    constructorResultRoots,
  ] = views;
  if (
    schemaWords === undefined || definitionAnnotationRoots === undefined ||
    typeParameterOffsets === undefined || typeParameterSymbols === undefined ||
    constructorFieldOffsets === undefined || constructorFieldRoots === undefined ||
    constructorResultRoots === undefined
  ) {
    throw new Error("type schema metadata packing omitted a logical array.");
  }
  return Object.freeze({
    metadataWords,
    identifierNames: Object.freeze([...identifierNames]),
    schemaWords,
    definitionAnnotationRoots,
    typeParameterOffsets,
    typeParameterSymbols,
    constructorFieldOffsets,
    constructorFieldRoots,
    constructorResultRoots,
  });
}

function symbolName(symbolNames: readonly string[], symbol: number, recordIndex: number): string {
  if (symbol === NO_INDEX) {
    throw new Error(`type schema record ${recordIndex} omits its required symbol.`);
  }
  const name = symbolNames[symbol];
  if (name === undefined) {
    throw new Error(
      `type schema record ${recordIndex} references missing symbol ${symbol}.`,
    );
  }
  return name;
}

function abiCount(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value >= NO_INDEX) {
    throw new Error(
      `${name} must be an integer from 0 through ${NO_INDEX - 1}; received ${value}.`,
    );
  }
  return value;
}

function requiredSurfaceWord(words: Uint32Array, offset: number, context: string): number {
  const word = words[offset];
  if (word === undefined) throw new Error(`${context} omits ABI word ${offset}.`);
  return word;
}

function requiredWord(words: Uint32Array, offset: number, recordIndex: number): number {
  const word = words[offset];
  if (word === undefined) throw new Error(`type schema record ${recordIndex} is truncated.`);
  return word;
}
