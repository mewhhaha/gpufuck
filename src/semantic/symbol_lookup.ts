import {
  AlgebraicTypeWord,
  ARGUMENT_WORD_LENGTH,
  ArgumentWord,
  CASE_ALTERNATIVE_WORD_LENGTH,
  CaseAlternativeWord,
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
  let errorNode = NO_INDEX;

  for (let node = 0; node < surface.nodeCount; node++) {
    const offset = node * NODE_WORD_LENGTH;
    const tag = surface.nodeWords[offset + NodeWord.Tag];
    const payload = surface.nodeWords[offset + NodeWord.Payload];
    if (tag === undefined || payload === undefined) return undefined;

    let plannedNode: PlannedLoweringNode;
    if (tag === ExpressionTag.Name) {
      plannedNode = planName(lookupWords, localDepths[node], payload, symbolCount);
    } else {
      plannedNode = {
        coreTag: normalizedCoreTag(tag),
        corePayload: tag === ExpressionTag.Let || tag === ExpressionTag.StrictLet
          ? bindingUses[node] ?? 0
          : payload,
        errorCode: SemanticCompilerErrorCode.None,
        errorDetail: NO_INDEX,
      };
      if (tag === ExpressionTag.Case) {
        const caseError = planCase(surface, node);
        if (caseError === undefined) return undefined;
        plannedNode = { ...plannedNode, ...caseError };
      }
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

function planCase(
  surface: EncodedSemanticSurface,
  node: number,
): Pick<PlannedLoweringNode, "errorCode" | "errorDetail"> | undefined {
  const offset = node * NODE_WORD_LENGTH;
  const firstAlternative = surface.nodeWords[offset + NodeWord.Payload];
  const alternativeCount = surface.nodeWords[offset + NodeWord.Child1];
  if (firstAlternative === undefined || alternativeCount === undefined) return undefined;
  if (
    firstAlternative > surface.caseAlternativeCount ||
    alternativeCount > surface.caseAlternativeCount - firstAlternative
  ) return undefined;
  const constructors = new Set<number>();
  for (let index = 0; index < alternativeCount; index++) {
    const alternative = firstAlternative + index;
    const alternativeOffset = alternative * CASE_ALTERNATIVE_WORD_LENGTH;
    const constructor =
      surface.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.Constructor];
    const binderCount =
      surface.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.BinderCount];
    if (constructor === undefined || binderCount === undefined) return undefined;
    if (constructor >= surface.constructorCount) {
      return {
        errorCode: SemanticCompilerErrorCode.UnknownCaseConstructor,
        errorDetail: alternative,
      };
    }
    const constructorArity = surface.constructorWords[
      constructor * CONSTRUCTOR_WORD_LENGTH + ConstructorWord.Arity
    ];
    if (constructorArity === undefined) return undefined;
    if (binderCount !== constructorArity) {
      return {
        errorCode: SemanticCompilerErrorCode.PatternArityMismatch,
        errorDetail: alternative,
      };
    }
    if (constructors.has(constructor)) {
      return {
        errorCode: SemanticCompilerErrorCode.DuplicateCaseArm,
        errorDetail: alternative,
      };
    }
    constructors.add(constructor);
  }
  return {
    errorCode: SemanticCompilerErrorCode.None,
    errorDetail: NO_INDEX,
  };
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
      tag === ExpressionTag.StrictLet || tag === ExpressionTag.LetRec;
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

    const child0 = surface.nodeWords[offset + NodeWord.Child0];
    const child1 = surface.nodeWords[offset + NodeWord.Child1];
    const child2 = surface.nodeWords[offset + NodeWord.Child2];
    if (child0 === undefined || child1 === undefined || child2 === undefined) return false;
    const pushNode = (child: number): boolean => {
      if (child === NO_INDEX || child >= surface.nodeCount) return false;
      if (surface.nodeWords[child * NODE_WORD_LENGTH + NodeWord.Parent] !== node) return false;
      pending.push({ kind: "node", node: child });
      return true;
    };
    const pushScopedNode = (
      child: number,
      symbols: ArrayLike<number>,
    ): boolean => {
      if (child === NO_INDEX || child >= surface.nodeCount) return false;
      if (surface.nodeWords[child * NODE_WORD_LENGTH + NodeWord.Parent] !== node) return false;
      for (let index = 0; index < symbols.length; index++) {
        const symbol = symbols[index]!;
        if (symbol >= symbolCount) return false;
        pending.push({ kind: "leave", symbol, node });
      }
      pending.push({ kind: "node", node: child });
      for (let index = symbols.length - 1; index >= 0; index--) {
        pending.push({ kind: "enter", symbol: symbols[index]!, node });
      }
      return true;
    };

    if (tag === ExpressionTag.Let || tag === ExpressionTag.StrictLet) {
      if (!pushScopedNode(child1, [payload]) || !pushNode(child0)) return false;
      continue;
    }
    if (tag === ExpressionTag.LetRec) {
      if (!pushScopedNode(child1, [payload]) || !pushScopedNode(child0, [payload])) return false;
      continue;
    }
    if (tag === ExpressionTag.Lambda) {
      if (
        payload > surface.parameterWords.length ||
        child1 > surface.parameterWords.length - payload
      ) return false;
      const parameters = surface.parameterWords.slice(payload, payload + child1);
      if (!pushScopedNode(child0, parameters)) return false;
      continue;
    }
    if (tag === ExpressionTag.Apply || tag === ExpressionTag.StrictApply) {
      if (
        payload > surface.argumentCount ||
        child1 > surface.argumentCount - payload
      ) return false;
      for (let index = child1; index > 0; index--) {
        const argumentOffset = (payload + index - 1) * ARGUMENT_WORD_LENGTH;
        const argument = surface.argumentWords[argumentOffset + ArgumentWord.Node];
        if (argument === undefined || !pushNode(argument)) return false;
      }
      if (!pushNode(child0)) return false;
      continue;
    }
    if (tag === ExpressionTag.Prim) {
      if (
        child0 > surface.argumentCount ||
        child1 > surface.argumentCount - child0
      ) return false;
      for (let index = child1; index > 0; index--) {
        const operandOffset = (child0 + index - 1) * ARGUMENT_WORD_LENGTH;
        const operand = surface.argumentWords[operandOffset + ArgumentWord.Node];
        if (operand === undefined || !pushNode(operand)) return false;
      }
      continue;
    }
    if (tag === ExpressionTag.Case) {
      if (
        payload > surface.caseAlternativeCount ||
        child1 > surface.caseAlternativeCount - payload
      ) return false;
      for (let index = child1; index > 0; index--) {
        const alternativeOffset = (payload + index - 1) * CASE_ALTERNATIVE_WORD_LENGTH;
        const firstBinder =
          surface.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.FirstBinder];
        const binderCount =
          surface.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.BinderCount];
        const body = surface.caseAlternativeWords[alternativeOffset + CaseAlternativeWord.Body];
        if (
          firstBinder === undefined || binderCount === undefined || body === undefined ||
          firstBinder > surface.caseBinderWords.length ||
          binderCount > surface.caseBinderWords.length - firstBinder
        ) return false;
        const binders = surface.caseBinderWords.slice(
          firstBinder,
          firstBinder + binderCount,
        ).reverse();
        if (!pushScopedNode(body, binders)) return false;
      }
      if (!pushNode(child0)) return false;
      continue;
    }

    const childCount = tag === ExpressionTag.If || tag === ExpressionTag.StoreWrite ||
        tag === ExpressionTag.StoreGrow
      ? 3
      : tag === ExpressionTag.Binary || tag === ExpressionTag.BufferAppend ||
          tag === ExpressionTag.StoreNew || tag === ExpressionTag.StoreRead
      ? 2
      : tag === ExpressionTag.Unary || tag === ExpressionTag.NumericConvert ||
          tag === ExpressionTag.StoreLength
      ? 1
      : 0;
    const children = [child0, child1, child2];
    for (let childIndex = childCount; childIndex > 0; childIndex--) {
      if (!pushNode(children[childIndex - 1]!)) return false;
    }
  }

  return visited.every((value) => value === 1) && bindings.length === 0 &&
    bindingNodes.length === 0;
}
