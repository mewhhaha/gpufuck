import {
  AlgebraicTypeWord,
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  CoreTag,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedSemanticSurface,
  ExpressionTag,
  NO_INDEX,
  NODE_WORD_LENGTH,
  NodeWord,
  TYPE_WORD_LENGTH,
} from "./abi.ts";
import { SemanticCompilerErrorCode } from "./compilation_diagnostics.ts";

export const SYMBOL_LOOKUP_WORD_LENGTH = 4;
export const INDEXED_LOCAL_RESOLUTION_MAGIC = 0x4c5a4c52;
export const INDEXED_LOCAL_RESOLUTION_SCALAR_MAGIC = 0x4c5a4c53;

export const SymbolLookupWord = {
  Definition: 0,
  Type: 1,
  Constructor: 2,
  CaseNode: 3,
} as const;

export function createSymbolLookup(surface: EncodedSemanticSurface): Uint32Array {
  const symbolCount = surface.symbolNames.length;
  const words = new Uint32Array(
    functionalSymbolLookupRecordCount(surface) * SYMBOL_LOOKUP_WORD_LENGTH,
  );
  words.fill(NO_INDEX);
  recordFirstIndices(
    words,
    surface.definitionWords,
    DEFINITION_WORD_LENGTH,
    DefinitionWord.Symbol,
    SymbolLookupWord.Definition,
    symbolCount,
  );
  recordFirstIndices(
    words,
    surface.typeWords,
    TYPE_WORD_LENGTH,
    AlgebraicTypeWord.Symbol,
    SymbolLookupWord.Type,
    symbolCount,
  );
  recordFirstIndices(
    words,
    surface.constructorWords,
    CONSTRUCTOR_WORD_LENGTH,
    ConstructorWord.Symbol,
    SymbolLookupWord.Constructor,
    symbolCount,
  );
  recordLocalResolutions(words, surface, symbolCount);
  return words;
}

export function functionalSymbolLookupRecordCount(surface: EncodedSemanticSurface): number {
  return surface.symbolNames.length + 1 + surface.nodeCount;
}

function recordFirstIndices(
  lookupWords: Uint32Array,
  records: Uint32Array,
  recordWordLength: number,
  symbolWord: number,
  lookupWord: number,
  symbolCount: number,
): void {
  for (let recordIndex = 0; recordIndex < records.length / recordWordLength; recordIndex++) {
    const symbol = records[recordIndex * recordWordLength + symbolWord]!;
    if (symbol >= symbolCount) continue;
    const offset = symbol * SYMBOL_LOOKUP_WORD_LENGTH + lookupWord;
    if (lookupWords[offset] === NO_INDEX) lookupWords[offset] = recordIndex;
  }
}

interface NodeTraversal {
  readonly kind: "node";
  readonly node: number;
}

interface BindingTraversal {
  readonly kind: "enter" | "leave";
  readonly symbol: number;
  readonly node: number;
}

function recordLocalResolutions(
  words: Uint32Array,
  surface: EncodedSemanticSurface,
  symbolCount: number,
): void {
  const localDepths = new Uint32Array(surface.nodeCount);
  localDepths.fill(NO_INDEX);
  const bindingUses = new Uint8Array(surface.nodeCount);
  if (!resolveLocalDepths(surface, localDepths, bindingUses, symbolCount)) return;
  const loweringPlan = createLoweringPlan(
    words,
    surface,
    localDepths,
    bindingUses,
    symbolCount,
  );
  if (loweringPlan === undefined) return;

  const header = symbolCount * SYMBOL_LOOKUP_WORD_LENGTH;
  words[header + SymbolLookupWord.Definition] = INDEXED_LOCAL_RESOLUTION_MAGIC;
  words[header + SymbolLookupWord.Type] = surface.nodeCount;
  words[header + SymbolLookupWord.CaseNode] = loweringPlan.errorNode;
  for (let node = 0; node < surface.nodeCount; node++) {
    const plannedNode = loweringPlan.nodes[node];
    if (plannedNode === undefined) return;
    const record = (symbolCount + 1 + node) * SYMBOL_LOOKUP_WORD_LENGTH;
    words[record + SymbolLookupWord.Definition] = plannedNode.coreTag;
    words[record + SymbolLookupWord.Type] = plannedNode.corePayload;
    words[record + SymbolLookupWord.Constructor] = plannedNode.errorCode;
    words[record + SymbolLookupWord.CaseNode] = plannedNode.errorDetail;
  }
}

interface PlannedLoweringNode {
  readonly coreTag: number;
  readonly corePayload: number;
  readonly errorCode: number;
  readonly errorDetail: number;
}

interface LoweringPlan {
  readonly nodes: readonly PlannedLoweringNode[];
  readonly errorNode: number;
}

function createLoweringPlan(
  lookupWords: Uint32Array,
  surface: EncodedSemanticSurface,
  localDepths: Uint32Array,
  bindingUses: Uint8Array,
  symbolCount: number,
): LoweringPlan | undefined {
  const nodes: PlannedLoweringNode[] = [];
  const lastCaseBySymbol = new Uint32Array(symbolCount);
  lastCaseBySymbol.fill(NO_INDEX);
  let errorNode = NO_INDEX;

  for (let node = 0; node < surface.nodeCount; node++) {
    const offset = node * NODE_WORD_LENGTH;
    const tag = surface.nodeWords[offset + NodeWord.Tag];
    const payload = surface.nodeWords[offset + NodeWord.Payload];
    if (tag === undefined || payload === undefined) return undefined;

    let plannedNode: PlannedLoweringNode;
    if (tag === ExpressionTag.Name) {
      plannedNode = planName(lookupWords, localDepths[node], payload, symbolCount);
    } else if (tag === ExpressionTag.CaseArm) {
      const plannedCaseArm = planCaseArm(
        lookupWords,
        surface,
        lastCaseBySymbol,
        node,
        payload,
        symbolCount,
      );
      if (plannedCaseArm === undefined) return undefined;
      plannedNode = plannedCaseArm;
    } else {
      plannedNode = {
        coreTag: normalizedCoreTag(tag),
        corePayload: tag === ExpressionTag.Let || tag === ExpressionTag.StrictLet
          ? bindingUses[node] ?? 0
          : payload,
        errorCode: SemanticCompilerErrorCode.None,
        errorDetail: NO_INDEX,
      };
    }
    nodes.push(plannedNode);
    if (
      errorNode === NO_INDEX &&
      plannedNode.errorCode !== SemanticCompilerErrorCode.None
    ) {
      errorNode = node;
    }
  }

  return { nodes, errorNode };
}

function planName(
  lookupWords: Uint32Array,
  localDepth: number | undefined,
  symbol: number,
  symbolCount: number,
): PlannedLoweringNode {
  if (localDepth !== undefined && localDepth !== NO_INDEX) {
    return {
      coreTag: CoreTag.Local,
      corePayload: localDepth,
      errorCode: SemanticCompilerErrorCode.None,
      errorDetail: NO_INDEX,
    };
  }
  const definition = lookupWord(
    lookupWords,
    symbol,
    SymbolLookupWord.Definition,
    symbolCount,
  );
  if (definition !== NO_INDEX) {
    return {
      coreTag: CoreTag.Global,
      corePayload: definition,
      errorCode: SemanticCompilerErrorCode.None,
      errorDetail: NO_INDEX,
    };
  }
  const constructor = lookupWord(
    lookupWords,
    symbol,
    SymbolLookupWord.Constructor,
    symbolCount,
  );
  if (constructor !== NO_INDEX) {
    return {
      coreTag: CoreTag.Constructor,
      corePayload: constructor,
      errorCode: SemanticCompilerErrorCode.None,
      errorDetail: NO_INDEX,
    };
  }
  return {
    coreTag: ExpressionTag.Name,
    corePayload: symbol,
    errorCode: SemanticCompilerErrorCode.UnknownName,
    errorDetail: symbol,
  };
}

function planCaseArm(
  lookupWords: Uint32Array,
  surface: EncodedSemanticSurface,
  lastCaseBySymbol: Uint32Array,
  node: number,
  symbol: number,
  symbolCount: number,
): PlannedLoweringNode | undefined {
  const constructor = lookupWord(
    lookupWords,
    symbol,
    SymbolLookupWord.Constructor,
    symbolCount,
  );
  if (constructor === NO_INDEX) {
    return {
      coreTag: ExpressionTag.CaseArm,
      corePayload: symbol,
      errorCode: SemanticCompilerErrorCode.UnknownCaseConstructor,
      errorDetail: symbol,
    };
  }

  const constructorArity = surface.constructorWords[
    constructor * CONSTRUCTOR_WORD_LENGTH + ConstructorWord.Arity
  ];
  const patternArity = casePatternArity(surface, node);
  if (constructorArity === undefined || patternArity === undefined) return undefined;
  if (patternArity !== constructorArity) {
    return {
      coreTag: ExpressionTag.CaseArm,
      corePayload: constructor,
      errorCode: SemanticCompilerErrorCode.PatternArityMismatch,
      errorDetail: node,
    };
  }

  const caseNode = enclosingCaseNode(surface, node);
  if (caseNode === undefined) return undefined;
  if (caseNode !== NO_INDEX && lastCaseBySymbol[symbol] === caseNode) {
    return {
      coreTag: ExpressionTag.CaseArm,
      corePayload: constructor,
      errorCode: SemanticCompilerErrorCode.DuplicateCaseArm,
      errorDetail: symbol,
    };
  }
  if (caseNode !== NO_INDEX) lastCaseBySymbol[symbol] = caseNode;
  return {
    coreTag: ExpressionTag.CaseArm,
    corePayload: constructor,
    errorCode: SemanticCompilerErrorCode.None,
    errorDetail: NO_INDEX,
  };
}

function casePatternArity(surface: EncodedSemanticSurface, node: number): number | undefined {
  let pattern = surface.nodeWords[
    node * NODE_WORD_LENGTH + NodeWord.Child0
  ];
  let arity = 0;
  while (pattern !== undefined && pattern < surface.nodeCount) {
    const offset = pattern * NODE_WORD_LENGTH;
    if (surface.nodeWords[offset + NodeWord.Tag] !== ExpressionTag.PatternBind) break;
    arity += 1;
    pattern = surface.nodeWords[offset + NodeWord.Child0];
    if (arity > surface.nodeCount) return undefined;
  }
  return pattern === undefined ? undefined : arity;
}

function enclosingCaseNode(
  surface: EncodedSemanticSurface,
  node: number,
): number | undefined {
  let parent = surface.nodeWords[node * NODE_WORD_LENGTH + NodeWord.Parent];
  for (let depth = 0; depth <= surface.nodeCount; depth++) {
    if (parent === undefined) return undefined;
    if (parent === NO_INDEX || parent >= surface.nodeCount) return NO_INDEX;
    const offset = parent * NODE_WORD_LENGTH;
    if (surface.nodeWords[offset + NodeWord.Tag] === ExpressionTag.Case) return parent;
    parent = surface.nodeWords[offset + NodeWord.Parent];
  }
  return undefined;
}

function lookupWord(
  words: Uint32Array,
  symbol: number,
  word: number,
  symbolCount: number,
): number {
  if (symbol >= symbolCount) return NO_INDEX;
  return words[symbol * SYMBOL_LOOKUP_WORD_LENGTH + word] ?? NO_INDEX;
}

function normalizedCoreTag(tag: number): number {
  if (tag === ExpressionTag.StrictLet) return CoreTag.Let;
  if (tag === ExpressionTag.StrictApply) return CoreTag.Apply;
  return tag;
}

function resolveLocalDepths(
  surface: EncodedSemanticSurface,
  localDepths: Uint32Array,
  bindingUses: Uint8Array,
  symbolCount: number,
): boolean {
  const visited = new Uint8Array(surface.nodeCount);
  const bindings: number[] = [];
  const bindingNodes: number[] = [];
  const bindingPositions = new Map<number, number[]>();
  const pending: Array<NodeTraversal | BindingTraversal> = [];
  for (let definition = surface.definitionCount - 1; definition >= 0; definition--) {
    const root = surface.definitionWords[
      definition * DEFINITION_WORD_LENGTH + DefinitionWord.RootNode
    ];
    if (root === undefined || root >= surface.nodeCount) return false;
    pending.push({ kind: "node", node: root });
  }

  while (pending.length !== 0) {
    const traversal = pending.pop();
    if (traversal === undefined) return false;
    if (traversal.kind !== "node") {
      if (traversal.kind === "enter") {
        let positions = bindingPositions.get(traversal.symbol);
        if (positions === undefined) {
          positions = [];
          bindingPositions.set(traversal.symbol, positions);
        }
        positions.push(bindings.length);
        bindings.push(traversal.symbol);
        bindingNodes.push(traversal.node);
      } else {
        if (bindings.pop() !== traversal.symbol) return false;
        if (bindingNodes.pop() !== traversal.node) return false;
        const positions = bindingPositions.get(traversal.symbol);
        if (positions === undefined || positions.pop() === undefined) return false;
        if (positions.length === 0) bindingPositions.delete(traversal.symbol);
      }
      continue;
    }

    const node = traversal.node;
    if (node >= surface.nodeCount || visited[node] !== 0) return false;
    visited[node] = 1;
    const offset = node * NODE_WORD_LENGTH;
    const tag = surface.nodeWords[offset + NodeWord.Tag];
    const payload = surface.nodeWords[offset + NodeWord.Payload];
    if (tag === undefined || payload === undefined) return false;
    const payloadIsSymbol = tag === ExpressionTag.Name || tag === ExpressionTag.Let ||
      tag === ExpressionTag.StrictLet || tag === ExpressionTag.LetRec ||
      tag === ExpressionTag.Lambda || tag === ExpressionTag.PatternBind ||
      tag === ExpressionTag.CaseArm;
    if (payloadIsSymbol && payload >= symbolCount) return false;
    if (tag === ExpressionTag.Name) {
      const positions = bindingPositions.get(payload);
      const position = positions?.at(-1);
      if (position !== undefined) {
        localDepths[node] = bindings.length - position - 1;
        const bindingNode = bindingNodes[position];
        if (bindingNode === undefined) return false;
        bindingUses[bindingNode] = 1;
      }
    }

    for (
      let childWord: number = NodeWord.Child2;
      childWord >= NodeWord.Child0;
      childWord--
    ) {
      const child = surface.nodeWords[offset + childWord];
      if (child === undefined) return false;
      if (child === NO_INDEX) continue;
      if (child >= surface.nodeCount) return false;
      const bindingApplies = ((tag === ExpressionTag.Let || tag === ExpressionTag.StrictLet) &&
        childWord === NodeWord.Child1) ||
        (tag === ExpressionTag.LetRec &&
          (childWord === NodeWord.Child0 || childWord === NodeWord.Child1)) ||
        ((tag === ExpressionTag.Lambda || tag === ExpressionTag.PatternBind) &&
          childWord === NodeWord.Child0);
      if (bindingApplies) pending.push({ kind: "leave", symbol: payload, node });
      pending.push({ kind: "node", node: child });
      if (bindingApplies) pending.push({ kind: "enter", symbol: payload, node });
    }
  }

  return visited.every((value) => value === 1) && bindings.length === 0 &&
    bindingNodes.length === 0;
}
