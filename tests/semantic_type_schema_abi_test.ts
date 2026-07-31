import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";

import {
  AlgebraicTypeWord,
  MAXIMUM_PARSE_DEPTH,
  MODULE_ABI_VERSION,
  NO_INDEX,
  type Type,
  TYPE_WORD_LENGTH,
} from "../src/semantic/abi.ts";
import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import {
  decodeType,
  decodeTypeSchema,
  flattenTypeSchemas,
  serializeType,
  TYPE_SCHEMA_ABI_VERSION,
  TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH,
  TYPE_SCHEMA_WORD_LENGTH,
  TypeSchemaMetadataWord,
  TypeSchemaTag,
  TypeSchemaWord,
} from "../src/semantic/type_schema_abi.ts";

const canonicalSource = "data Box a = Box(value: (a, Int)); let main : Box Bool = Box (true, 1);";

function parsedCanonicalSurface() {
  const parsing = parseLazuliSource(canonicalSource);
  ok(parsing.ok);
  if (!parsing.ok) throw new Error("unreachable");
  return parsing.surface;
}

function schemaWords(
  records: readonly (readonly [number, number, number, number, number, number])[],
): Uint32Array {
  return Uint32Array.from(records.flatMap((record) => record));
}

Deno.test("canonical schema metadata packs every ABI-v8 table into one buffer", () => {
  const surface = parsedCanonicalSurface();
  const flattened = flattenTypeSchemas(surface);

  equal(TYPE_SCHEMA_ABI_VERSION, MODULE_ABI_VERSION);
  equal(TYPE_SCHEMA_WORD_LENGTH, 6);
  equal(
    flattened.metadataWords[TypeSchemaMetadataWord.AbiVersion],
    MODULE_ABI_VERSION,
  );
  equal(
    flattened.metadataWords[TypeSchemaMetadataWord.HeaderWordLength],
    TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH,
  );

  const tables = [
    [
      TypeSchemaMetadataWord.SchemaWordsOffset,
      TypeSchemaMetadataWord.SchemaWordsLength,
      flattened.schemaWords,
    ],
    [
      TypeSchemaMetadataWord.DefinitionAnnotationRootsOffset,
      TypeSchemaMetadataWord.DefinitionAnnotationRootsLength,
      flattened.definitionAnnotationRoots,
    ],
    [
      TypeSchemaMetadataWord.TypeParameterOffsetsOffset,
      TypeSchemaMetadataWord.TypeParameterOffsetsLength,
      flattened.typeParameterOffsets,
    ],
    [
      TypeSchemaMetadataWord.TypeParameterSymbolsOffset,
      TypeSchemaMetadataWord.TypeParameterSymbolsLength,
      flattened.typeParameterSymbols,
    ],
    [
      TypeSchemaMetadataWord.ConstructorFieldOffsetsOffset,
      TypeSchemaMetadataWord.ConstructorFieldOffsetsLength,
      flattened.constructorFieldOffsets,
    ],
    [
      TypeSchemaMetadataWord.ConstructorFieldRootsOffset,
      TypeSchemaMetadataWord.ConstructorFieldRootsLength,
      flattened.constructorFieldRoots,
    ],
    [
      TypeSchemaMetadataWord.ConstructorResultRootsOffset,
      TypeSchemaMetadataWord.ConstructorResultRootsLength,
      flattened.constructorResultRoots,
    ],
  ] as const;
  for (const [offsetWord, lengthWord, table] of tables) {
    const offset = flattened.metadataWords[offsetWord];
    const length = flattened.metadataWords[lengthWord];
    ok(offset !== undefined && length !== undefined);
    equal(table.buffer, flattened.metadataWords.buffer);
    equal(table.byteOffset, offset * Uint32Array.BYTES_PER_ELEMENT);
    equal(table.length, length);
    deepStrictEqual(flattened.metadataWords.subarray(offset, offset + length), table);
  }

  const constructorResults = new Map(
    surface.typeDeclarations.flatMap((declaration, typeIndex) => {
      const firstConstructor = surface.typeWords[
        typeIndex * TYPE_WORD_LENGTH + AlgebraicTypeWord.FirstConstructor
      ];
      ok(firstConstructor !== undefined);
      return declaration.constructors.map((constructor, constructorOffset) => {
        const root = flattened.constructorResultRoots[firstConstructor + constructorOffset];
        ok(root !== undefined);
        return [
          constructor.name,
          decodeTypeSchema(flattened.schemaWords, root, flattened.identifierNames),
        ] as const;
      });
    }),
  );
  deepStrictEqual(constructorResults.get("Box"), {
    kind: "named",
    name: "Box",
    arguments: [{ kind: "parameter", name: "a" }],
  });
  deepStrictEqual(constructorResults.get("$Unit"), { kind: "unit" });
  deepStrictEqual(constructorResults.get("$Tuple"), {
    kind: "tuple",
    values: [
      { kind: "parameter", name: "first" },
      { kind: "parameter", name: "second" },
    ],
  });

  const boxResultRoot = flattened.constructorResultRoots[0];
  ok(boxResultRoot !== undefined);
  const boxResultRecord = boxResultRoot * TYPE_SCHEMA_WORD_LENGTH;
  equal(
    flattened.schemaWords[boxResultRecord + TypeSchemaWord.StartByte],
    NO_INDEX,
  );
  equal(flattened.schemaWords[boxResultRecord + TypeSchemaWord.EndByte], NO_INDEX);
});

Deno.test("explicit constructor results retain their indexed schema and source span", () => {
  const source = "data Equal a b = Refl : Equal a a; let main : Equal Int Int = Refl;";
  const parsing = parseLazuliSource(source);
  ok(parsing.ok);
  if (!parsing.ok) return;
  const flattened = flattenTypeSchemas(parsing.surface);
  const result = parsing.surface.typeDeclarations[0]?.constructors[0]?.result;
  const root = flattened.constructorResultRoots[0];
  ok(result !== undefined && root !== undefined);

  deepStrictEqual(
    decodeTypeSchema(flattened.schemaWords, root, flattened.identifierNames),
    {
      kind: "named",
      name: "Equal",
      arguments: [
        { kind: "parameter", name: "a" },
        { kind: "parameter", name: "a" },
      ],
    },
  );
  const record = root * TYPE_SCHEMA_WORD_LENGTH;
  equal(flattened.schemaWords[record + TypeSchemaWord.StartByte], result.startByte);
  equal(flattened.schemaWords[record + TypeSchemaWord.EndByte], result.endByte);
});

Deno.test("flattened records preserve source spans and decode parameterized schemas", () => {
  const surface = parsedCanonicalSurface();
  const flattened = flattenTypeSchemas(surface);
  const boxTypeOffset = 0 * TYPE_WORD_LENGTH;
  const boxConstructor = surface.typeWords[boxTypeOffset + AlgebraicTypeWord.FirstConstructor];
  ok(boxConstructor !== undefined);
  const firstField = flattened.constructorFieldOffsets[boxConstructor];
  const fieldRoot = firstField === undefined
    ? undefined
    : flattened.constructorFieldRoots[firstField];
  ok(fieldRoot !== undefined);

  const field = surface.typeDeclarations[0]?.constructors[0]?.fields[0]?.type;
  ok(field !== undefined);
  const fieldRecord = fieldRoot * TYPE_SCHEMA_WORD_LENGTH;
  equal(flattened.schemaWords[fieldRecord + TypeSchemaWord.StartByte], field.startByte);
  equal(flattened.schemaWords[fieldRecord + TypeSchemaWord.EndByte], field.endByte);
  const firstChild = flattened.schemaWords[fieldRecord + TypeSchemaWord.FirstChild];
  ok(firstChild !== undefined && firstChild !== NO_INDEX);
  const childRecord = firstChild * TYPE_SCHEMA_WORD_LENGTH;
  equal(flattened.schemaWords[childRecord + TypeSchemaWord.StartByte], field.startByte);
  equal(flattened.schemaWords[childRecord + TypeSchemaWord.EndByte], field.endByte);

  deepStrictEqual(
    decodeTypeSchema(flattened.schemaWords, fieldRoot, flattened.identifierNames),
    {
      kind: "tuple",
      values: [{ kind: "parameter", name: "a" }, { kind: "integer" }],
    },
  );
});

Deno.test("concrete types round-trip through the shared six-word records", () => {
  const type: Type = {
    kind: "function",
    parameter: {
      kind: "named",
      name: "Box",
      arguments: [{ kind: "boolean" }],
    },
    result: {
      kind: "tuple",
      values: [{ kind: "integer" }, { kind: "unit" }],
    },
  };
  const serialized = serializeType(type, ["Box"]);

  equal(serialized.schemaWords.length % TYPE_SCHEMA_WORD_LENGTH, 0);
  for (
    let record = 0;
    record < serialized.schemaWords.length / TYPE_SCHEMA_WORD_LENGTH;
    record++
  ) {
    const offset = record * TYPE_SCHEMA_WORD_LENGTH;
    equal(serialized.schemaWords[offset + TypeSchemaWord.StartByte], 0);
    equal(serialized.schemaWords[offset + TypeSchemaWord.EndByte], 0);
  }
  deepStrictEqual(decodeType(serialized.schemaWords, serialized.root, ["Box"]), type);
});

Deno.test("rank-2 forall schemas decode through canonical records", () => {
  const words = schemaWords([
    [TypeSchemaTag.Forall, 0, 1, NO_INDEX, 0, 0],
    [TypeSchemaTag.Function, NO_INDEX, 2, NO_INDEX, 0, 0],
    [TypeSchemaTag.Parameter, 0, NO_INDEX, 3, 0, 0],
    [TypeSchemaTag.Parameter, 0, NO_INDEX, NO_INDEX, 0, 0],
  ]);

  deepStrictEqual(decodeTypeSchema(words, 0, ["T"]), {
    kind: "forall",
    parameters: ["T"],
    body: {
      kind: "function",
      parameter: { kind: "parameter", name: "T" },
      result: { kind: "parameter", name: "T" },
    },
  });
  throws(() => decodeType(words, 0, ["T"]), /must not be a parameter|must not be a forall/);
});

Deno.test("schema decoding rejects cycles, reused records, and malformed links", () => {
  throws(
    () =>
      decodeTypeSchema(
        schemaWords([
          [TypeSchemaTag.Named, 0, 1, NO_INDEX, 0, 0],
          [TypeSchemaTag.Integer, NO_INDEX, NO_INDEX, 0, 0, 0],
        ]),
        0,
        ["Box"],
      ),
    /cycle through record 0/,
  );

  throws(
    () =>
      decodeTypeSchema(
        schemaWords([
          [TypeSchemaTag.Tuple, NO_INDEX, 1, NO_INDEX, 0, 0],
          [TypeSchemaTag.Named, 0, 3, 2, 0, 0],
          [TypeSchemaTag.Named, 0, 3, NO_INDEX, 0, 0],
          [
            TypeSchemaTag.Integer,
            NO_INDEX,
            NO_INDEX,
            NO_INDEX,
            0,
            0,
          ],
        ]),
        0,
        ["Box"],
      ),
    /record 3 is referenced more than once/,
  );

  throws(
    () =>
      decodeTypeSchema(
        schemaWords([
          [TypeSchemaTag.Integer, NO_INDEX, NO_INDEX, 1, 0, 0],
          [
            TypeSchemaTag.Boolean,
            NO_INDEX,
            NO_INDEX,
            NO_INDEX,
            0,
            0,
          ],
        ]),
        0,
        [],
      ),
    /root 0 must not have a next sibling/,
  );
});

Deno.test("schema decoding rejects bad symbols, child counts, and nesting depth", () => {
  throws(
    () =>
      decodeTypeSchema(
        schemaWords([
          [TypeSchemaTag.Named, 1, NO_INDEX, NO_INDEX, 0, 0],
        ]),
        0,
        ["Box"],
      ),
    /references missing symbol 1/,
  );

  throws(
    () =>
      decodeTypeSchema(
        schemaWords([
          [TypeSchemaTag.Tuple, NO_INDEX, 1, NO_INDEX, 0, 0],
          [
            TypeSchemaTag.Integer,
            NO_INDEX,
            NO_INDEX,
            NO_INDEX,
            0,
            0,
          ],
        ]),
        0,
        [],
      ),
    /has 1 children; expected 2/,
  );

  const nestedRecords: [number, number, number, number, number, number][] = [];
  for (let depth = 0; depth <= MAXIMUM_PARSE_DEPTH; depth++) {
    nestedRecords.push([
      TypeSchemaTag.Named,
      0,
      depth + 1,
      NO_INDEX,
      0,
      0,
    ]);
  }
  nestedRecords.push([
    TypeSchemaTag.Integer,
    NO_INDEX,
    NO_INDEX,
    NO_INDEX,
    0,
    0,
  ]);
  throws(
    () => decodeTypeSchema(schemaWords(nestedRecords), 0, ["Box"]),
    /exceeds the ABI nesting limit/,
  );
});
