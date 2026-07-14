import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";

import {
  LAZULI_ABI_VERSION,
  LAZULI_MAXIMUM_PARSE_DEPTH,
  LAZULI_NO_INDEX,
  type LazuliType,
  LazuliTypeWord,
} from "../src/lazuli/abi.ts";
import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import {
  decodeLazuliType,
  decodeLazuliTypeSchema,
  flattenLazuliTypeSchemas,
  LAZULI_TYPE_SCHEMA_ABI_VERSION,
  LAZULI_TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH,
  LAZULI_TYPE_SCHEMA_WORD_LENGTH,
  LazuliDeclaredResultKind,
  LazuliTypeSchemaMetadataWord,
  LazuliTypeSchemaTag,
  LazuliTypeSchemaWord,
  serializeLazuliType,
} from "../src/lazuli/type_schema_abi.ts";

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

Deno.test("canonical schema metadata packs every ABI-v4 table into one buffer", () => {
  const surface = parsedCanonicalSurface();
  const flattened = flattenLazuliTypeSchemas(surface);

  equal(LAZULI_TYPE_SCHEMA_ABI_VERSION, LAZULI_ABI_VERSION);
  equal(LAZULI_TYPE_SCHEMA_WORD_LENGTH, 6);
  equal(
    flattened.metadataWords[LazuliTypeSchemaMetadataWord.AbiVersion],
    LAZULI_ABI_VERSION,
  );
  equal(
    flattened.metadataWords[LazuliTypeSchemaMetadataWord.HeaderWordLength],
    LAZULI_TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH,
  );

  const tables = [
    [
      LazuliTypeSchemaMetadataWord.SchemaWordsOffset,
      LazuliTypeSchemaMetadataWord.SchemaWordsLength,
      flattened.schemaWords,
    ],
    [
      LazuliTypeSchemaMetadataWord.DefinitionAnnotationRootsOffset,
      LazuliTypeSchemaMetadataWord.DefinitionAnnotationRootsLength,
      flattened.definitionAnnotationRoots,
    ],
    [
      LazuliTypeSchemaMetadataWord.TypeParameterOffsetsOffset,
      LazuliTypeSchemaMetadataWord.TypeParameterOffsetsLength,
      flattened.typeParameterOffsets,
    ],
    [
      LazuliTypeSchemaMetadataWord.TypeParameterSymbolsOffset,
      LazuliTypeSchemaMetadataWord.TypeParameterSymbolsLength,
      flattened.typeParameterSymbols,
    ],
    [
      LazuliTypeSchemaMetadataWord.ConstructorFieldOffsetsOffset,
      LazuliTypeSchemaMetadataWord.ConstructorFieldOffsetsLength,
      flattened.constructorFieldOffsets,
    ],
    [
      LazuliTypeSchemaMetadataWord.ConstructorFieldRootsOffset,
      LazuliTypeSchemaMetadataWord.ConstructorFieldRootsLength,
      flattened.constructorFieldRoots,
    ],
    [
      LazuliTypeSchemaMetadataWord.DeclaredResultKindsOffset,
      LazuliTypeSchemaMetadataWord.DeclaredResultKindsLength,
      flattened.declaredResultKinds,
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

  const resultKinds = new Map(
    surface.typeDeclarations.map((declaration, typeIndex) => [
      declaration.name,
      flattened.declaredResultKinds[typeIndex],
    ]),
  );
  equal(resultKinds.get("Box"), LazuliDeclaredResultKind.Named);
  equal(resultKinds.get("$UnitType"), LazuliDeclaredResultKind.Unit);
  equal(resultKinds.get("$TupleType"), LazuliDeclaredResultKind.Tuple);
});

Deno.test("flattened records preserve source spans and decode parameterized schemas", () => {
  const surface = parsedCanonicalSurface();
  const flattened = flattenLazuliTypeSchemas(surface);
  const boxTypeOffset = 0 * 5;
  const boxConstructor = surface.typeWords[boxTypeOffset + LazuliTypeWord.FirstConstructor];
  ok(boxConstructor !== undefined);
  const firstField = flattened.constructorFieldOffsets[boxConstructor];
  const fieldRoot = firstField === undefined
    ? undefined
    : flattened.constructorFieldRoots[firstField];
  ok(fieldRoot !== undefined);

  const field = surface.typeDeclarations[0]?.constructors[0]?.fields[0]?.type;
  ok(field !== undefined);
  const fieldRecord = fieldRoot * LAZULI_TYPE_SCHEMA_WORD_LENGTH;
  equal(flattened.schemaWords[fieldRecord + LazuliTypeSchemaWord.StartByte], field.startByte);
  equal(flattened.schemaWords[fieldRecord + LazuliTypeSchemaWord.EndByte], field.endByte);
  const firstChild = flattened.schemaWords[fieldRecord + LazuliTypeSchemaWord.FirstChild];
  ok(firstChild !== undefined && firstChild !== LAZULI_NO_INDEX);
  const childRecord = firstChild * LAZULI_TYPE_SCHEMA_WORD_LENGTH;
  equal(flattened.schemaWords[childRecord + LazuliTypeSchemaWord.StartByte], field.startByte);
  equal(flattened.schemaWords[childRecord + LazuliTypeSchemaWord.EndByte], field.endByte);

  deepStrictEqual(
    decodeLazuliTypeSchema(flattened.schemaWords, fieldRoot, flattened.identifierNames),
    {
      kind: "tuple",
      values: [{ kind: "parameter", name: "a" }, { kind: "integer" }],
    },
  );
});

Deno.test("concrete types round-trip through the shared six-word records", () => {
  const type: LazuliType = {
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
  const serialized = serializeLazuliType(type, ["Box"]);

  equal(serialized.schemaWords.length % LAZULI_TYPE_SCHEMA_WORD_LENGTH, 0);
  for (
    let record = 0;
    record < serialized.schemaWords.length / LAZULI_TYPE_SCHEMA_WORD_LENGTH;
    record++
  ) {
    const offset = record * LAZULI_TYPE_SCHEMA_WORD_LENGTH;
    equal(serialized.schemaWords[offset + LazuliTypeSchemaWord.StartByte], 0);
    equal(serialized.schemaWords[offset + LazuliTypeSchemaWord.EndByte], 0);
  }
  deepStrictEqual(decodeLazuliType(serialized.schemaWords, serialized.root, ["Box"]), type);
});

Deno.test("schema decoding rejects cycles, reused records, and malformed links", () => {
  throws(
    () =>
      decodeLazuliTypeSchema(
        schemaWords([
          [LazuliTypeSchemaTag.Named, 0, 1, LAZULI_NO_INDEX, 0, 0],
          [LazuliTypeSchemaTag.Integer, LAZULI_NO_INDEX, LAZULI_NO_INDEX, 0, 0, 0],
        ]),
        0,
        ["Box"],
      ),
    /cycle through record 0/,
  );

  throws(
    () =>
      decodeLazuliTypeSchema(
        schemaWords([
          [LazuliTypeSchemaTag.Tuple, LAZULI_NO_INDEX, 1, LAZULI_NO_INDEX, 0, 0],
          [LazuliTypeSchemaTag.Named, 0, 3, 2, 0, 0],
          [LazuliTypeSchemaTag.Named, 0, 3, LAZULI_NO_INDEX, 0, 0],
          [
            LazuliTypeSchemaTag.Integer,
            LAZULI_NO_INDEX,
            LAZULI_NO_INDEX,
            LAZULI_NO_INDEX,
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
      decodeLazuliTypeSchema(
        schemaWords([
          [LazuliTypeSchemaTag.Integer, LAZULI_NO_INDEX, LAZULI_NO_INDEX, 1, 0, 0],
          [
            LazuliTypeSchemaTag.Boolean,
            LAZULI_NO_INDEX,
            LAZULI_NO_INDEX,
            LAZULI_NO_INDEX,
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
      decodeLazuliTypeSchema(
        schemaWords([
          [LazuliTypeSchemaTag.Named, 1, LAZULI_NO_INDEX, LAZULI_NO_INDEX, 0, 0],
        ]),
        0,
        ["Box"],
      ),
    /references missing symbol 1/,
  );

  throws(
    () =>
      decodeLazuliTypeSchema(
        schemaWords([
          [LazuliTypeSchemaTag.Tuple, LAZULI_NO_INDEX, 1, LAZULI_NO_INDEX, 0, 0],
          [
            LazuliTypeSchemaTag.Integer,
            LAZULI_NO_INDEX,
            LAZULI_NO_INDEX,
            LAZULI_NO_INDEX,
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
  for (let depth = 0; depth <= LAZULI_MAXIMUM_PARSE_DEPTH; depth++) {
    nestedRecords.push([
      LazuliTypeSchemaTag.Named,
      0,
      depth + 1,
      LAZULI_NO_INDEX,
      0,
      0,
    ]);
  }
  nestedRecords.push([
    LazuliTypeSchemaTag.Integer,
    LAZULI_NO_INDEX,
    LAZULI_NO_INDEX,
    LAZULI_NO_INDEX,
    0,
    0,
  ]);
  throws(
    () => decodeLazuliTypeSchema(schemaWords(nestedRecords), 0, ["Box"]),
    /exceeds the ABI nesting limit/,
  );
});
