import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_NO_INDEX,
  LAZULI_NODE_WORD_LENGTH,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliConstructorWord,
  LazuliCoreTag,
  LazuliDefinitionWord,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
  LazuliTypeWord,
} from "./abi.ts";
import { LazuliSemanticCompilerErrorCode } from "./compilation_diagnostics.ts";

export const LAZULI_SYMBOL_LOOKUP_WORD_LENGTH = 4;
export const LAZULI_INDEXED_LOCAL_RESOLUTION_MAGIC = 0x4c5a4c52;
export const LAZULI_INDEXED_LOCAL_RESOLUTION_SCALAR_MAGIC = 0x4c5a4c53;

export const LazuliSymbolLookupWord = {
  Definition: 0,
  Type: 1,
  Constructor: 2,
  CaseNode: 3,
} as const;

export function createLazuliSymbolLookup(surface: EncodedLazuliSurface): Uint32Array {
  const symbolCount = surface.symbolNames.length;
  const words = new Uint32Array(
    lazuliSymbolLookupRecordCount(surface) * LAZULI_SYMBOL_LOOKUP_WORD_LENGTH,
  );
  words.fill(LAZULI_NO_INDEX);
  recordFirstIndices(
    words,
    surface.definitionWords,
    LAZULI_DEFINITION_WORD_LENGTH,
    LazuliDefinitionWord.Symbol,
    LazuliSymbolLookupWord.Definition,
    symbolCount,
  );
  recordFirstIndices(
    words,
    surface.typeWords,
    LAZULI_TYPE_WORD_LENGTH,
    LazuliTypeWord.Symbol,
    LazuliSymbolLookupWord.Type,
    symbolCount,
  );
  recordFirstIndices(
    words,
    surface.constructorWords,
    LAZULI_CONSTRUCTOR_WORD_LENGTH,
    LazuliConstructorWord.Symbol,
    LazuliSymbolLookupWord.Constructor,
    symbolCount,
  );
  recordLocalResolutions(words, surface, symbolCount);
  return words;
}

export function lazuliSymbolLookupRecordCount(surface: EncodedLazuliSurface): number {
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
    const offset = symbol * LAZULI_SYMBOL_LOOKUP_WORD_LENGTH + lookupWord;
    if (lookupWords[offset] === LAZULI_NO_INDEX) lookupWords[offset] = recordIndex;
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
  surface: EncodedLazuliSurface,
  symbolCount: number,
): void {
  const localDepths = new Uint32Array(surface.nodeCount);
  localDepths.fill(LAZULI_NO_INDEX);
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

  const header = symbolCount * LAZULI_SYMBOL_LOOKUP_WORD_LENGTH;
  words[header + LazuliSymbolLookupWord.Definition] = LAZULI_INDEXED_LOCAL_RESOLUTION_MAGIC;
  words[header + LazuliSymbolLookupWord.Type] = surface.nodeCount;
  words[header + LazuliSymbolLookupWord.CaseNode] = loweringPlan.errorNode;
  for (let node = 0; node < surface.nodeCount; node++) {
    const plannedNode = loweringPlan.nodes[node];
    if (plannedNode === undefined) return;
    const record = (symbolCount + 1 + node) * LAZULI_SYMBOL_LOOKUP_WORD_LENGTH;
    words[record + LazuliSymbolLookupWord.Definition] = plannedNode.coreTag;
    words[record + LazuliSymbolLookupWord.Type] = plannedNode.corePayload;
    words[record + LazuliSymbolLookupWord.Constructor] = plannedNode.errorCode;
    words[record + LazuliSymbolLookupWord.CaseNode] = plannedNode.errorDetail;
  }
}

interface PlannedLoweringNode {
  readonly coreTag: number;
  readonly corePayload: number;
  readonly errorCode: number;
  readonly errorDetail: number;
}

interface LazuliLoweringPlan {
  readonly nodes: readonly PlannedLoweringNode[];
  readonly errorNode: number;
}

function createLoweringPlan(
  lookupWords: Uint32Array,
  surface: EncodedLazuliSurface,
  localDepths: Uint32Array,
  bindingUses: Uint8Array,
  symbolCount: number,
): LazuliLoweringPlan | undefined {
  const nodes: PlannedLoweringNode[] = [];
  const lastCaseBySymbol = new Uint32Array(symbolCount);
  lastCaseBySymbol.fill(LAZULI_NO_INDEX);
  let errorNode = LAZULI_NO_INDEX;

  for (let node = 0; node < surface.nodeCount; node++) {
    const offset = node * LAZULI_NODE_WORD_LENGTH;
    const tag = surface.nodeWords[offset + LazuliSurfaceWord.Tag];
    const payload = surface.nodeWords[offset + LazuliSurfaceWord.Payload];
    if (tag === undefined || payload === undefined) return undefined;

    let plannedNode: PlannedLoweringNode;
    if (tag === LazuliSurfaceTag.Name) {
      plannedNode = planName(lookupWords, localDepths[node], payload, symbolCount);
    } else if (tag === LazuliSurfaceTag.CaseArm) {
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
        corePayload: tag === LazuliSurfaceTag.Let || tag === LazuliSurfaceTag.StrictLet
          ? bindingUses[node] ?? 0
          : payload,
        errorCode: LazuliSemanticCompilerErrorCode.None,
        errorDetail: LAZULI_NO_INDEX,
      };
    }
    nodes.push(plannedNode);
    if (
      errorNode === LAZULI_NO_INDEX &&
      plannedNode.errorCode !== LazuliSemanticCompilerErrorCode.None
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
  if (localDepth !== undefined && localDepth !== LAZULI_NO_INDEX) {
    return {
      coreTag: LazuliCoreTag.Local,
      corePayload: localDepth,
      errorCode: LazuliSemanticCompilerErrorCode.None,
      errorDetail: LAZULI_NO_INDEX,
    };
  }
  const definition = lookupWord(
    lookupWords,
    symbol,
    LazuliSymbolLookupWord.Definition,
    symbolCount,
  );
  if (definition !== LAZULI_NO_INDEX) {
    return {
      coreTag: LazuliCoreTag.Global,
      corePayload: definition,
      errorCode: LazuliSemanticCompilerErrorCode.None,
      errorDetail: LAZULI_NO_INDEX,
    };
  }
  const constructor = lookupWord(
    lookupWords,
    symbol,
    LazuliSymbolLookupWord.Constructor,
    symbolCount,
  );
  if (constructor !== LAZULI_NO_INDEX) {
    return {
      coreTag: LazuliCoreTag.Constructor,
      corePayload: constructor,
      errorCode: LazuliSemanticCompilerErrorCode.None,
      errorDetail: LAZULI_NO_INDEX,
    };
  }
  return {
    coreTag: LazuliSurfaceTag.Name,
    corePayload: symbol,
    errorCode: LazuliSemanticCompilerErrorCode.UnknownName,
    errorDetail: symbol,
  };
}

function planCaseArm(
  lookupWords: Uint32Array,
  surface: EncodedLazuliSurface,
  lastCaseBySymbol: Uint32Array,
  node: number,
  symbol: number,
  symbolCount: number,
): PlannedLoweringNode | undefined {
  const constructor = lookupWord(
    lookupWords,
    symbol,
    LazuliSymbolLookupWord.Constructor,
    symbolCount,
  );
  if (constructor === LAZULI_NO_INDEX) {
    return {
      coreTag: LazuliSurfaceTag.CaseArm,
      corePayload: symbol,
      errorCode: LazuliSemanticCompilerErrorCode.UnknownCaseConstructor,
      errorDetail: symbol,
    };
  }

  const constructorArity = surface.constructorWords[
    constructor * LAZULI_CONSTRUCTOR_WORD_LENGTH + LazuliConstructorWord.Arity
  ];
  const patternArity = casePatternArity(surface, node);
  if (constructorArity === undefined || patternArity === undefined) return undefined;
  if (patternArity !== constructorArity) {
    return {
      coreTag: LazuliSurfaceTag.CaseArm,
      corePayload: constructor,
      errorCode: LazuliSemanticCompilerErrorCode.PatternArityMismatch,
      errorDetail: node,
    };
  }

  const caseNode = enclosingCaseNode(surface, node);
  if (caseNode === undefined) return undefined;
  if (caseNode !== LAZULI_NO_INDEX && lastCaseBySymbol[symbol] === caseNode) {
    return {
      coreTag: LazuliSurfaceTag.CaseArm,
      corePayload: constructor,
      errorCode: LazuliSemanticCompilerErrorCode.DuplicateCaseArm,
      errorDetail: symbol,
    };
  }
  if (caseNode !== LAZULI_NO_INDEX) lastCaseBySymbol[symbol] = caseNode;
  return {
    coreTag: LazuliSurfaceTag.CaseArm,
    corePayload: constructor,
    errorCode: LazuliSemanticCompilerErrorCode.None,
    errorDetail: LAZULI_NO_INDEX,
  };
}

function casePatternArity(surface: EncodedLazuliSurface, node: number): number | undefined {
  let pattern = surface.nodeWords[
    node * LAZULI_NODE_WORD_LENGTH + LazuliSurfaceWord.Child0
  ];
  let arity = 0;
  while (pattern !== undefined && pattern < surface.nodeCount) {
    const offset = pattern * LAZULI_NODE_WORD_LENGTH;
    if (surface.nodeWords[offset + LazuliSurfaceWord.Tag] !== LazuliSurfaceTag.PatternBind) break;
    arity += 1;
    pattern = surface.nodeWords[offset + LazuliSurfaceWord.Child0];
    if (arity > surface.nodeCount) return undefined;
  }
  return pattern === undefined ? undefined : arity;
}

function enclosingCaseNode(
  surface: EncodedLazuliSurface,
  node: number,
): number | undefined {
  let parent = surface.nodeWords[node * LAZULI_NODE_WORD_LENGTH + LazuliSurfaceWord.Parent];
  for (let depth = 0; depth <= surface.nodeCount; depth++) {
    if (parent === undefined) return undefined;
    if (parent === LAZULI_NO_INDEX || parent >= surface.nodeCount) return LAZULI_NO_INDEX;
    const offset = parent * LAZULI_NODE_WORD_LENGTH;
    if (surface.nodeWords[offset + LazuliSurfaceWord.Tag] === LazuliSurfaceTag.Case) return parent;
    parent = surface.nodeWords[offset + LazuliSurfaceWord.Parent];
  }
  return undefined;
}

function lookupWord(
  words: Uint32Array,
  symbol: number,
  word: number,
  symbolCount: number,
): number {
  if (symbol >= symbolCount) return LAZULI_NO_INDEX;
  return words[symbol * LAZULI_SYMBOL_LOOKUP_WORD_LENGTH + word] ?? LAZULI_NO_INDEX;
}

function normalizedCoreTag(tag: number): number {
  if (tag === LazuliSurfaceTag.StrictLet) return LazuliCoreTag.Let;
  if (tag === LazuliSurfaceTag.StrictApply) return LazuliCoreTag.Apply;
  return tag;
}

function resolveLocalDepths(
  surface: EncodedLazuliSurface,
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
      definition * LAZULI_DEFINITION_WORD_LENGTH + LazuliDefinitionWord.RootNode
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
    const offset = node * LAZULI_NODE_WORD_LENGTH;
    const tag = surface.nodeWords[offset + LazuliSurfaceWord.Tag];
    const payload = surface.nodeWords[offset + LazuliSurfaceWord.Payload];
    if (tag === undefined || payload === undefined) return false;
    const payloadIsSymbol = tag === LazuliSurfaceTag.Name || tag === LazuliSurfaceTag.Let ||
      tag === LazuliSurfaceTag.StrictLet || tag === LazuliSurfaceTag.LetRec ||
      tag === LazuliSurfaceTag.Lambda || tag === LazuliSurfaceTag.PatternBind ||
      tag === LazuliSurfaceTag.CaseArm;
    if (payloadIsSymbol && payload >= symbolCount) return false;
    if (tag === LazuliSurfaceTag.Name) {
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
      let childWord: number = LazuliSurfaceWord.Child2;
      childWord >= LazuliSurfaceWord.Child0;
      childWord--
    ) {
      const child = surface.nodeWords[offset + childWord];
      if (child === undefined) return false;
      if (child === LAZULI_NO_INDEX) continue;
      if (child >= surface.nodeCount) return false;
      const bindingApplies =
        ((tag === LazuliSurfaceTag.Let || tag === LazuliSurfaceTag.StrictLet) &&
          childWord === LazuliSurfaceWord.Child1) ||
        (tag === LazuliSurfaceTag.LetRec &&
          (childWord === LazuliSurfaceWord.Child0 || childWord === LazuliSurfaceWord.Child1)) ||
        ((tag === LazuliSurfaceTag.Lambda || tag === LazuliSurfaceTag.PatternBind) &&
          childWord === LazuliSurfaceWord.Child0);
      if (bindingApplies) pending.push({ kind: "leave", symbol: payload, node });
      pending.push({ kind: "node", node: child });
      if (bindingApplies) pending.push({ kind: "enter", symbol: payload, node });
    }
  }

  return visited.every((value) => value === 1) && bindings.length === 0 &&
    bindingNodes.length === 0;
}
