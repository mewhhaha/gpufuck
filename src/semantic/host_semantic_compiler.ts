import {
  type CompilerPerformanceTrace,
  measureCompilerStage,
} from "../compiler_performance_trace.ts";
import {
  AlgebraicTypeWord,
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedSemanticSurface,
  EvaluationMode,
  ExpressionTag,
  NO_INDEX,
  NODE_WORD_LENGTH,
  NodeWord,
  type SemanticDiagnostic,
  TYPE_WORD_LENGTH,
} from "./abi.ts";
import {
  diagnosticFromSemanticState,
  SemanticCompilerErrorCode,
} from "./compilation_diagnostics.ts";
import {
  CompiledHostSemanticModule,
  type CoreNode,
  type SemanticModule,
} from "./compiler_module.ts";
import type { GpuSemanticStateSnapshot } from "./gpu_semantic_contract.ts";
import {
  createSymbolLookup,
  INDEXED_LOCAL_RESOLUTION_MAGIC,
  SYMBOL_LOOKUP_WORD_LENGTH,
  SymbolLookupWord,
} from "./symbol_lookup.ts";
import { inferTypes } from "./type_inference.ts";

export type HostSemanticCompileResult =
  | { readonly ok: true; readonly module: SemanticModule }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [SemanticDiagnostic, ...SemanticDiagnostic[]];
  };

export function compileSemanticOnHost(
  surface: EncodedSemanticSurface,
  sourceByteLength: number,
  trace?: CompilerPerformanceTrace,
): HostSemanticCompileResult {
  const validation = measureCompilerStage(
    trace,
    "semantic.validate-declarations",
    {
      definitions: surface.definitionCount,
      types: surface.typeCount,
      constructors: surface.constructorCount,
    },
    () => validateTopLevelDeclarations(surface, sourceByteLength),
  );
  if (validation !== undefined) return { ok: false, diagnostics: [validation] };

  const symbolLookup = measureCompilerStage(
    trace,
    "semantic.symbol-index",
    { nodes: surface.nodeCount, symbols: surface.symbolNames.length },
    () => createSymbolLookup(surface),
  );
  const header = surface.symbolNames.length * SYMBOL_LOOKUP_WORD_LENGTH;
  if (symbolLookup[header + SymbolLookupWord.Definition] !== INDEXED_LOCAL_RESOLUTION_MAGIC) {
    throw new Error(
      `host semantic lowering could not index ${surface.nodeCount} structurally valid nodes`,
    );
  }
  const errorNode = symbolLookup[header + SymbolLookupWord.CaseNode];
  if (errorNode !== undefined && errorNode !== NO_INDEX) {
    const record = (surface.symbolNames.length + 1 + errorNode) * SYMBOL_LOOKUP_WORD_LENGTH;
    const errorCode = symbolLookup[record + SymbolLookupWord.Constructor] ?? NO_INDEX;
    const errorDetail = symbolLookup[record + SymbolLookupWord.CaseNode] ?? NO_INDEX;
    const startByte = surface.nodeWords[errorNode * NODE_WORD_LENGTH + NodeWord.StartByte] ??
      NO_INDEX;
    const diagnostic = semanticDiagnostic(
      surface,
      errorCode,
      startByte,
      errorDetail,
      NO_INDEX,
      sourceByteLength,
    );
    if (diagnostic === undefined) {
      throw new Error(
        `host semantic lowering produced unknown diagnostic ${errorCode} at node ${errorNode}`,
      );
    }
    return { ok: false, diagnostics: [diagnostic] };
  }

  const inference = inferTypes(surface, trace);
  if (!inference.ok) return { ok: false, diagnostics: [inference.diagnostic] };

  const entryDefinition = findEntryDefinition(surface);
  const nodes = measureCompilerStage(
    trace,
    "semantic.lower-core",
    { nodes: surface.nodeCount },
    () =>
      Object.freeze(Array.from({ length: surface.nodeCount }, (_, nodeIndex) => {
        const source = nodeIndex * NODE_WORD_LENGTH;
        const lowering = (surface.symbolNames.length + 1 + nodeIndex) * SYMBOL_LOOKUP_WORD_LENGTH;
        const surfaceTag = surface.nodeWords[source + NodeWord.Tag];
        const tag = symbolLookup[lowering + SymbolLookupWord.Definition];
        const payload = symbolLookup[lowering + SymbolLookupWord.Type];
        if (surfaceTag === undefined || tag === undefined || payload === undefined) {
          throw new Error(`host semantic lowering omitted node ${nodeIndex}`);
        }
        return Object.freeze<CoreNode>({
          tag: tag as CoreNode["tag"],
          payload,
          child0: surface.nodeWords[source + NodeWord.Child0] ?? NO_INDEX,
          child1: surface.nodeWords[source + NodeWord.Child1] ?? NO_INDEX,
          child2: surfaceTag === ExpressionTag.Let
            ? NO_INDEX
            : surface.nodeWords[source + NodeWord.Child2] ?? NO_INDEX,
          sourceByteOffset: surface.nodeWords[source + NodeWord.StartByte] ?? 0,
          sourceEndByte: surface.nodeWords[source + NodeWord.EndByte] ?? 0,
          evaluationMode: surfaceTag === ExpressionTag.Let
            ? surface.nodeWords[source + NodeWord.Child2] as EvaluationMode
            : EvaluationMode.LazyCallByNeed,
        });
      })),
  );
  return {
    ok: true,
    module: new CompiledHostSemanticModule(
      surface,
      entryDefinition,
      inference.mainType,
      inference.typeDeclarations,
      nodes,
    ),
  };
}

function validateTopLevelDeclarations(
  surface: EncodedSemanticSurface,
  sourceByteLength: number,
): SemanticDiagnostic | undefined {
  const definitions = new Set<number>();
  for (let definition = 0; definition < surface.definitionCount; definition++) {
    const offset = definition * DEFINITION_WORD_LENGTH;
    const symbol = surface.definitionWords[offset + DefinitionWord.Symbol] ?? NO_INDEX;
    if (definitions.has(symbol)) {
      return semanticDiagnostic(
        surface,
        SemanticCompilerErrorCode.DuplicateDefinition,
        surface.definitionWords[offset + DefinitionWord.StartByte] ?? NO_INDEX,
        symbol,
        NO_INDEX,
        sourceByteLength,
      );
    }
    definitions.add(symbol);
  }

  const types = new Set<number>();
  for (let type = 0; type < surface.typeCount; type++) {
    const offset = type * TYPE_WORD_LENGTH;
    const symbol = surface.typeWords[offset + AlgebraicTypeWord.Symbol] ?? NO_INDEX;
    if (types.has(symbol)) {
      return semanticDiagnostic(
        surface,
        SemanticCompilerErrorCode.DuplicateType,
        surface.typeWords[offset + AlgebraicTypeWord.StartByte] ?? NO_INDEX,
        symbol,
        NO_INDEX,
        sourceByteLength,
      );
    }
    types.add(symbol);
  }

  const constructors = new Set<number>();
  for (let constructor = 0; constructor < surface.constructorCount; constructor++) {
    const offset = constructor * CONSTRUCTOR_WORD_LENGTH;
    const symbol = surface.constructorWords[offset + ConstructorWord.Symbol] ?? NO_INDEX;
    const startByte = surface.constructorWords[offset + ConstructorWord.StartByte] ?? NO_INDEX;
    if (constructors.has(symbol)) {
      return semanticDiagnostic(
        surface,
        SemanticCompilerErrorCode.DuplicateConstructor,
        startByte,
        symbol,
        NO_INDEX,
        sourceByteLength,
      );
    }
    if (definitions.has(symbol)) {
      return semanticDiagnostic(
        surface,
        SemanticCompilerErrorCode.DefinitionConstructorCollision,
        startByte,
        symbol,
        NO_INDEX,
        sourceByteLength,
      );
    }
    constructors.add(symbol);
  }

  if (!definitions.has(surface.entrySymbol)) {
    return semanticDiagnostic(
      surface,
      SemanticCompilerErrorCode.MissingMain,
      NO_INDEX,
      surface.entrySymbol,
      NO_INDEX,
      sourceByteLength,
    );
  }
  return undefined;
}

function findEntryDefinition(surface: EncodedSemanticSurface): number {
  for (let definition = 0; definition < surface.definitionCount; definition++) {
    const symbol = surface.definitionWords[
      definition * DEFINITION_WORD_LENGTH + DefinitionWord.Symbol
    ];
    if (symbol === surface.entrySymbol) return definition;
  }
  throw new Error(
    `host semantic lowering omitted entry symbol ${surface.entrySymbol} from ${surface.definitionCount} definitions`,
  );
}

function semanticDiagnostic(
  surface: EncodedSemanticSurface,
  errorCode: number,
  errorSource: number,
  errorDetail: number,
  entryDefinition: number,
  sourceByteLength: number,
): SemanticDiagnostic | undefined {
  const state: GpuSemanticStateSnapshot = {
    nodeCount: surface.nodeCount,
    definitionCount: surface.definitionCount,
    typeCount: surface.typeCount,
    constructorCount: surface.constructorCount,
    entrySymbol: surface.entrySymbol,
    status: 0,
    errorCode,
    errorSource,
    errorDetail,
    entryDefinition,
    totalSteps: 0,
    maximumSteps: 1,
    maximumStepsPerDispatch: 1,
  };
  return diagnosticFromSemanticState(state, surface, sourceByteLength);
}
