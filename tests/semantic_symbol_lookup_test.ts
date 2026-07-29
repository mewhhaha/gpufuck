import { deepStrictEqual, equal, ok } from "node:assert/strict";

import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import {
  CoreTag,
  type EncodedSemanticSurface,
  ExpressionTag,
  NO_INDEX,
  NODE_WORD_LENGTH,
  NodeWord,
} from "../src/semantic/abi.ts";
import { SemanticCompilerErrorCode } from "../src/semantic/compilation_diagnostics.ts";
import {
  createSymbolLookup,
  INDEXED_LOCAL_RESOLUTION_MAGIC,
  SYMBOL_LOOKUP_WORD_LENGTH,
  SymbolLookupWord,
} from "../src/semantic/symbol_lookup.ts";

Deno.test("indexed lowering plans resolve local, global, and constructor names", () => {
  const surface = parseSurface(
    "data Maybe a = None | Some(value: a); let id = x => x; let main = id (Some 1);",
  );
  const lookup = createSymbolLookup(surface);
  const names = surfaceNodes(surface, ExpressionTag.Name).map((node) => ({
    symbol: surface.symbolNames[node.payload],
    lowering: loweringRecord(lookup, surface, node.index),
  }));

  deepStrictEqual(names, [
    {
      symbol: "x",
      lowering: {
        coreTag: CoreTag.Local,
        corePayload: 0,
        errorCode: SemanticCompilerErrorCode.None,
        errorDetail: NO_INDEX,
      },
    },
    {
      symbol: "id",
      lowering: {
        coreTag: CoreTag.Global,
        corePayload: 0,
        errorCode: SemanticCompilerErrorCode.None,
        errorDetail: NO_INDEX,
      },
    },
    {
      symbol: "Some",
      lowering: {
        coreTag: CoreTag.Constructor,
        corePayload: 1,
        errorCode: SemanticCompilerErrorCode.None,
        errorDetail: NO_INDEX,
      },
    },
  ]);
});

Deno.test("indexed lowering plans retain the first deterministic semantic diagnostic", () => {
  const unknownSurface = parseSurface("let main = missing;");
  const unknownLookup = createSymbolLookup(unknownSurface);
  const unknownNode = surfaceNodes(unknownSurface, ExpressionTag.Name)[0];
  ok(unknownNode);
  equal(loweringHeader(unknownLookup, unknownSurface).errorNode, unknownNode.index);
  deepStrictEqual(loweringRecord(unknownLookup, unknownSurface, unknownNode.index), {
    coreTag: ExpressionTag.Name,
    corePayload: unknownNode.payload,
    errorCode: SemanticCompilerErrorCode.UnknownName,
    errorDetail: unknownNode.payload,
  });

  const duplicateSurface = parseSurface(
    "data Flag = Off | On; let main = case Off of | Off -> 0 | Off -> 1 | On -> 2 end;",
  );
  const duplicateLookup = createSymbolLookup(duplicateSurface);
  const duplicateCase = surfaceNodes(duplicateSurface, ExpressionTag.Case)[0];
  ok(duplicateCase);
  equal(loweringHeader(duplicateLookup, duplicateSurface).errorNode, duplicateCase.index);
  equal(
    loweringRecord(duplicateLookup, duplicateSurface, duplicateCase.index).errorCode,
    SemanticCompilerErrorCode.DuplicateCaseArm,
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

function parseSurface(source: string): EncodedSemanticSurface {
  const parsed = parseLazuliSource(source);
  ok(parsed.ok, parsed.ok ? undefined : parsed.diagnostics[0]?.message);
  if (!parsed.ok) throw new Error("semantic lowering fixture did not parse");
  return parsed.surface;
}

function surfaceNodes(
  surface: EncodedSemanticSurface,
  tag: number,
): readonly SurfaceNodeSummary[] {
  const nodes: SurfaceNodeSummary[] = [];
  for (let index = 0; index < surface.nodeCount; index++) {
    const offset = index * NODE_WORD_LENGTH;
    if (surface.nodeWords[offset + NodeWord.Tag] !== tag) continue;
    const payload = surface.nodeWords[offset + NodeWord.Payload];
    if (payload === undefined) throw new Error(`surface node ${index} omits its payload`);
    nodes.push({ index, payload });
  }
  return nodes;
}

function loweringHeader(
  lookup: Uint32Array,
  surface: EncodedSemanticSurface,
): { readonly errorNode: number } {
  const offset = surface.symbolNames.length * SYMBOL_LOOKUP_WORD_LENGTH;
  equal(
    lookup[offset + SymbolLookupWord.Definition],
    INDEXED_LOCAL_RESOLUTION_MAGIC,
  );
  return {
    errorNode: lookup[offset + SymbolLookupWord.CaseNode]!,
  };
}

function loweringRecord(
  lookup: Uint32Array,
  surface: EncodedSemanticSurface,
  node: number,
): LoweringRecord {
  const offset = (surface.symbolNames.length + 1 + node) *
    SYMBOL_LOOKUP_WORD_LENGTH;
  return {
    coreTag: lookup[offset + SymbolLookupWord.Definition]!,
    corePayload: lookup[offset + SymbolLookupWord.Type]!,
    errorCode: lookup[offset + SymbolLookupWord.Constructor]!,
    errorDetail: lookup[offset + SymbolLookupWord.CaseNode]!,
  };
}
