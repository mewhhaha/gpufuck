import { deepStrictEqual, equal, ok } from "node:assert/strict";

import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import {
  type EncodedLazuliSurface,
  LAZULI_NO_INDEX,
  LAZULI_NODE_WORD_LENGTH,
  LazuliCoreTag,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
} from "../src/semantic/abi.ts";
import { LazuliSemanticCompilerErrorCode } from "../src/semantic/compilation_diagnostics.ts";
import {
  createLazuliSymbolLookup,
  LAZULI_INDEXED_LOCAL_RESOLUTION_MAGIC,
  LAZULI_SYMBOL_LOOKUP_WORD_LENGTH,
  LazuliSymbolLookupWord,
} from "../src/semantic/symbol_lookup.ts";

Deno.test("indexed lowering plans resolve local, global, and constructor names", () => {
  const surface = parseSurface(
    "data Maybe a = None | Some(value: a); let id = x => x; let main = id (Some 1);",
  );
  const lookup = createLazuliSymbolLookup(surface);
  const names = surfaceNodes(surface, LazuliSurfaceTag.Name).map((node) => ({
    symbol: surface.symbolNames[node.payload],
    lowering: loweringRecord(lookup, surface, node.index),
  }));

  deepStrictEqual(names, [
    {
      symbol: "x",
      lowering: {
        coreTag: LazuliCoreTag.Local,
        corePayload: 0,
        errorCode: LazuliSemanticCompilerErrorCode.None,
        errorDetail: LAZULI_NO_INDEX,
      },
    },
    {
      symbol: "id",
      lowering: {
        coreTag: LazuliCoreTag.Global,
        corePayload: 0,
        errorCode: LazuliSemanticCompilerErrorCode.None,
        errorDetail: LAZULI_NO_INDEX,
      },
    },
    {
      symbol: "Some",
      lowering: {
        coreTag: LazuliCoreTag.Constructor,
        corePayload: 1,
        errorCode: LazuliSemanticCompilerErrorCode.None,
        errorDetail: LAZULI_NO_INDEX,
      },
    },
  ]);
});

Deno.test("indexed lowering plans retain the first deterministic semantic diagnostic", () => {
  const unknownSurface = parseSurface("let main = missing;");
  const unknownLookup = createLazuliSymbolLookup(unknownSurface);
  const unknownNode = surfaceNodes(unknownSurface, LazuliSurfaceTag.Name)[0];
  ok(unknownNode);
  equal(loweringHeader(unknownLookup, unknownSurface).errorNode, unknownNode.index);
  deepStrictEqual(loweringRecord(unknownLookup, unknownSurface, unknownNode.index), {
    coreTag: LazuliSurfaceTag.Name,
    corePayload: unknownNode.payload,
    errorCode: LazuliSemanticCompilerErrorCode.UnknownName,
    errorDetail: unknownNode.payload,
  });

  const duplicateSurface = parseSurface(
    "data Flag = Off | On; let main = case Off of | Off -> 0 | Off -> 1 | On -> 2 end;",
  );
  const duplicateLookup = createLazuliSymbolLookup(duplicateSurface);
  const duplicateArms = surfaceNodes(duplicateSurface, LazuliSurfaceTag.CaseArm);
  const repeatedArm = duplicateArms[1];
  ok(repeatedArm);
  equal(loweringHeader(duplicateLookup, duplicateSurface).errorNode, repeatedArm.index);
  equal(
    loweringRecord(duplicateLookup, duplicateSurface, repeatedArm.index).errorCode,
    LazuliSemanticCompilerErrorCode.DuplicateCaseArm,
  );
});

interface SurfaceNodeSummary {
  readonly index: number;
  readonly payload: number;
}

interface LoweringRecord {
  readonly coreTag: number;
  readonly corePayload: number;
  readonly errorCode: number;
  readonly errorDetail: number;
}

function parseSurface(source: string): EncodedLazuliSurface {
  const parsed = parseLazuliSource(source);
  ok(parsed.ok, parsed.ok ? undefined : parsed.diagnostics[0]?.message);
  if (!parsed.ok) throw new Error("semantic lowering fixture did not parse");
  return parsed.surface;
}

function surfaceNodes(
  surface: EncodedLazuliSurface,
  tag: number,
): readonly SurfaceNodeSummary[] {
  const nodes: SurfaceNodeSummary[] = [];
  for (let index = 0; index < surface.nodeCount; index++) {
    const offset = index * LAZULI_NODE_WORD_LENGTH;
    if (surface.nodeWords[offset + LazuliSurfaceWord.Tag] !== tag) continue;
    const payload = surface.nodeWords[offset + LazuliSurfaceWord.Payload];
    if (payload === undefined) throw new Error(`surface node ${index} omits its payload`);
    nodes.push({ index, payload });
  }
  return nodes;
}

function loweringHeader(
  lookup: Uint32Array,
  surface: EncodedLazuliSurface,
): { readonly errorNode: number } {
  const offset = surface.symbolNames.length * LAZULI_SYMBOL_LOOKUP_WORD_LENGTH;
  equal(
    lookup[offset + LazuliSymbolLookupWord.Definition],
    LAZULI_INDEXED_LOCAL_RESOLUTION_MAGIC,
  );
  return {
    errorNode: lookup[offset + LazuliSymbolLookupWord.CaseNode]!,
  };
}

function loweringRecord(
  lookup: Uint32Array,
  surface: EncodedLazuliSurface,
  node: number,
): LoweringRecord {
  const offset = (surface.symbolNames.length + 1 + node) *
    LAZULI_SYMBOL_LOOKUP_WORD_LENGTH;
  return {
    coreTag: lookup[offset + LazuliSymbolLookupWord.Definition]!,
    corePayload: lookup[offset + LazuliSymbolLookupWord.Type]!,
    errorCode: lookup[offset + LazuliSymbolLookupWord.Constructor]!,
    errorDetail: lookup[offset + LazuliSymbolLookupWord.CaseNode]!,
  };
}
