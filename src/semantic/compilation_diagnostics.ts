import {
  AlgebraicTypeWord,
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  DEFINITION_WORD_LENGTH,
  type EncodedSemanticSurface,
  ExpressionTag,
  NO_INDEX,
  NODE_WORD_LENGTH,
  NodeWord,
  type SemanticDiagnostic,
  TYPE_WORD_LENGTH,
} from "./abi.ts";
import type { GpuSemanticStateSnapshot } from "./gpu_semantic_contract.ts";

export const SemanticCompilerErrorCode = {
  None: 0,
  UnknownName: 1,
  DuplicateDefinition: 2,
  MissingMain: 3,
  DuplicateType: 4,
  DuplicateConstructor: 5,
  DefinitionConstructorCollision: 6,
  UnknownCaseConstructor: 7,
  PatternArityMismatch: 8,
  DuplicateCaseArm: 9,
  InvalidCounts: 100,
  InvalidNode: 101,
  InvalidDefinition: 102,
  InvalidType: 103,
  InvalidConstructor: 104,
} as const;

export function diagnosticFromSemanticState(
  state: GpuSemanticStateSnapshot,
  surface: EncodedSemanticSurface,
  sourceByteLength: number,
): SemanticDiagnostic | undefined {
  const symbolName = symbolNameFor(surface, state.errorDetail);
  switch (state.errorCode) {
    case SemanticCompilerErrorCode.UnknownName: {
      const span = nodeSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2001",
        message: `unknown name ${symbolName}`,
        span,
      };
    }
    case SemanticCompilerErrorCode.DuplicateDefinition: {
      const span = definitionSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      const previous = previousDefinitionSpan(surface, state.errorSource, state.errorDetail);
      return {
        stage: "compile",
        code: "L2002",
        message: `duplicate top-level definition ${symbolName}`,
        span,
        ...(previous === undefined
          ? {}
          : { related: [{ message: "first declaration", span: previous }] }),
      };
    }
    case SemanticCompilerErrorCode.MissingMain:
      if (state.errorSource !== NO_INDEX || state.errorDetail !== surface.entrySymbol) {
        return undefined;
      }
      return {
        stage: "compile",
        code: "L2003",
        message: `missing required entry definition ${symbolName}`,
        span: { startByte: sourceByteLength, endByte: sourceByteLength },
      };
    case SemanticCompilerErrorCode.DuplicateType: {
      const span = typeSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      const previous = previousTypeSpan(surface, state.errorSource, state.errorDetail);
      return {
        stage: "compile",
        code: "L2004",
        message: `duplicate algebraic type ${symbolName}`,
        span,
        ...(previous === undefined
          ? {}
          : { related: [{ message: "first declaration", span: previous }] }),
      };
    }
    case SemanticCompilerErrorCode.DuplicateConstructor: {
      const span = constructorSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      const previous = previousConstructorSpan(surface, state.errorSource, state.errorDetail);
      return {
        stage: "compile",
        code: "L2005",
        message: `duplicate constructor ${symbolName}`,
        span,
        ...(previous === undefined
          ? {}
          : { related: [{ message: "first declaration", span: previous }] }),
      };
    }
    case SemanticCompilerErrorCode.DefinitionConstructorCollision: {
      const span = topLevelSymbolSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      const previous = previousTopLevelSymbolSpan(surface, state.errorSource, state.errorDetail);
      return {
        stage: "compile",
        code: "L2006",
        message: `top-level function and constructor share the name ${symbolName}`,
        span,
        ...(previous === undefined
          ? {}
          : { related: [{ message: "conflicting declaration", span: previous }] }),
      };
    }
    case SemanticCompilerErrorCode.UnknownCaseConstructor: {
      const span = surfaceNodeSpanAt(
        surface,
        state.errorSource,
        state.errorDetail,
        ExpressionTag.CaseArm,
      );
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2007",
        message: `unknown case constructor ${symbolName}`,
        span,
      };
    }
    case SemanticCompilerErrorCode.PatternArityMismatch: {
      const arm = caseArmDetails(surface, state.errorSource, state.errorDetail);
      if (arm === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2008",
        message: `constructor ${
          symbolNameFor(surface, arm.constructorSymbol)
        } expects ${arm.arity} pattern binders, received ${arm.binderCount}`,
        span: arm.span,
      };
    }
    case SemanticCompilerErrorCode.DuplicateCaseArm: {
      const span = surfaceNodeSpanAt(
        surface,
        state.errorSource,
        state.errorDetail,
        ExpressionTag.CaseArm,
      );
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2009",
        message: `duplicate case arm for constructor ${symbolName}`,
        span,
      };
    }
    default:
      return undefined;
  }
}

export function sourceTooLargeDiagnostic(
  sourceByteLength: number,
  maximumSourceByteLength: number,
): SemanticDiagnostic {
  return {
    stage: "parse",
    code: "L1003",
    message:
      `source is ${sourceByteLength} UTF-8 bytes; this compiler accepts at most ${maximumSourceByteLength}`,
    span: { startByte: maximumSourceByteLength, endByte: sourceByteLength },
  };
}

export function nodeLimitDiagnostic(
  nodeCount: number,
  maximumNodeCount: number,
): SemanticDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program has ${nodeCount} surface nodes; this device accepts at most ${maximumNodeCount}`,
    span: { startByte: 0, endByte: 0 },
  };
}

export function definitionLimitDiagnostic(
  definitionCount: number,
  maximumDefinitionCount: number,
): SemanticDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program has ${definitionCount} definitions; this device accepts at most ${maximumDefinitionCount}`,
    span: { startByte: 0, endByte: 0 },
  };
}

export function typeLimitDiagnostic(
  typeCount: number,
  maximumTypeCount: number,
): SemanticDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program has ${typeCount} algebraic types; this device accepts at most ${maximumTypeCount}`,
    span: { startByte: 0, endByte: 0 },
  };
}

export function constructorLimitDiagnostic(
  constructorCount: number,
  maximumConstructorCount: number,
): SemanticDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program has ${constructorCount} constructors; this device accepts at most ${maximumConstructorCount}`,
    span: { startByte: 0, endByte: 0 },
  };
}

export function semanticWorkLimitDiagnostic(
  completedTransitions: number,
  sourceByteLength: number,
  maximumSteps: number,
): SemanticDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program exhausted the compiler limit after ${completedTransitions} serial semantic transitions; the limit is ${maximumSteps}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
}

export function formatSemanticState(state: GpuSemanticStateSnapshot): string {
  return `nodeCount=${state.nodeCount}, definitionCount=${state.definitionCount}, typeCount=${state.typeCount}, constructorCount=${state.constructorCount}, entrySymbol=${state.entrySymbol}, status=${state.status}, errorCode=${state.errorCode}, errorSource=${state.errorSource}, errorDetail=${state.errorDetail}, entryDefinition=${state.entryDefinition}`;
}

export function formatInvalidSurfaceState(state: GpuSemanticStateSnapshot): string {
  const reason = (() => {
    switch (state.errorCode) {
      case SemanticCompilerErrorCode.InvalidCounts:
        return "record counts exceed their bound storage buffers";
      case SemanticCompilerErrorCode.InvalidNode:
        return `node ${state.errorDetail} violates a tag, child, parent, or preorder invariant`;
      case SemanticCompilerErrorCode.InvalidDefinition:
        return `definition ${state.errorDetail} violates a root or source-order invariant`;
      case SemanticCompilerErrorCode.InvalidType:
        return `type ${state.errorDetail} violates a constructor-range or source-order invariant`;
      case SemanticCompilerErrorCode.InvalidConstructor:
        return `constructor ${state.errorDetail} violates a type, arity, or source-order invariant`;
      default:
        return `unknown invariant error ${state.errorCode}`;
    }
  })();
  return `${reason}; ${formatSemanticState(state)}`;
}

function nodeSpanAt(
  surface: EncodedSemanticSurface,
  startByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  for (let nodeIndex = 0; nodeIndex < surface.nodeCount; nodeIndex++) {
    const wordOffset = nodeIndex * NODE_WORD_LENGTH;
    if (
      surface.nodeWords[wordOffset + NodeWord.Tag] === ExpressionTag.Name &&
      surface.nodeWords[wordOffset + NodeWord.StartByte] === startByte &&
      surface.nodeWords[wordOffset + NodeWord.Payload] === symbol
    ) {
      const endByte = surface.nodeWords[wordOffset + NodeWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function definitionSpanAt(
  surface: EncodedSemanticSurface,
  startByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  for (let definitionIndex = 0; definitionIndex < surface.definitionCount; definitionIndex++) {
    const wordOffset = definitionIndex * DEFINITION_WORD_LENGTH;
    if (
      surface.definitionWords[wordOffset] === symbol &&
      surface.definitionWords[wordOffset + 2] === startByte
    ) {
      const endByte = surface.definitionWords[wordOffset + 3];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function previousDefinitionSpan(
  surface: EncodedSemanticSurface,
  beforeStartByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  return previousRecordSpan(
    surface.definitionWords,
    surface.definitionCount,
    DEFINITION_WORD_LENGTH,
    symbol,
    beforeStartByte,
    0,
    2,
    3,
  );
}

function typeSpanAt(
  surface: EncodedSemanticSurface,
  startByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  for (let typeIndex = 0; typeIndex < surface.typeCount; typeIndex++) {
    const wordOffset = typeIndex * TYPE_WORD_LENGTH;
    if (
      surface.typeWords[wordOffset + AlgebraicTypeWord.Symbol] === symbol &&
      surface.typeWords[wordOffset + AlgebraicTypeWord.StartByte] === startByte
    ) {
      const endByte = surface.typeWords[wordOffset + AlgebraicTypeWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function previousTypeSpan(
  surface: EncodedSemanticSurface,
  beforeStartByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  return previousRecordSpan(
    surface.typeWords,
    surface.typeCount,
    TYPE_WORD_LENGTH,
    symbol,
    beforeStartByte,
    AlgebraicTypeWord.Symbol,
    AlgebraicTypeWord.StartByte,
    AlgebraicTypeWord.EndByte,
  );
}

function constructorSpanAt(
  surface: EncodedSemanticSurface,
  startByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const wordOffset = constructorIndex * CONSTRUCTOR_WORD_LENGTH;
    if (
      surface.constructorWords[wordOffset + ConstructorWord.Symbol] === symbol &&
      surface.constructorWords[wordOffset + ConstructorWord.StartByte] === startByte
    ) {
      const endByte = surface.constructorWords[wordOffset + ConstructorWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function previousConstructorSpan(
  surface: EncodedSemanticSurface,
  beforeStartByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  return previousRecordSpan(
    surface.constructorWords,
    surface.constructorCount,
    CONSTRUCTOR_WORD_LENGTH,
    symbol,
    beforeStartByte,
    ConstructorWord.Symbol,
    ConstructorWord.StartByte,
    ConstructorWord.EndByte,
  );
}

function topLevelSymbolSpanAt(
  surface: EncodedSemanticSurface,
  startByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  return definitionSpanAt(surface, startByte, symbol) ??
    constructorSpanAt(surface, startByte, symbol);
}

function previousTopLevelSymbolSpan(
  surface: EncodedSemanticSurface,
  beforeStartByte: number,
  symbol: number,
): SemanticDiagnostic["span"] | undefined {
  const definition = previousDefinitionSpan(surface, beforeStartByte, symbol);
  const constructor = previousConstructorSpan(surface, beforeStartByte, symbol);
  if (definition === undefined) return constructor;
  if (constructor === undefined) return definition;
  return definition.startByte > constructor.startByte ? definition : constructor;
}

function previousRecordSpan(
  words: Uint32Array,
  count: number,
  wordLength: number,
  symbol: number,
  beforeStartByte: number,
  symbolWord: number,
  startWord: number,
  endWord: number,
): SemanticDiagnostic["span"] | undefined {
  let previous: SemanticDiagnostic["span"] | undefined;
  for (let index = 0; index < count; index++) {
    const wordOffset = index * wordLength;
    const startByte = words[wordOffset + startWord];
    const endByte = words[wordOffset + endWord];
    if (
      words[wordOffset + symbolWord] !== symbol || startByte === undefined ||
      endByte === undefined || startByte >= beforeStartByte
    ) continue;
    if (previous === undefined || startByte > previous.startByte) {
      previous = { startByte, endByte };
    }
  }
  return previous;
}

function surfaceNodeSpanAt(
  surface: EncodedSemanticSurface,
  startByte: number,
  symbol: number,
  tag: number,
): SemanticDiagnostic["span"] | undefined {
  for (let nodeIndex = 0; nodeIndex < surface.nodeCount; nodeIndex++) {
    const wordOffset = nodeIndex * NODE_WORD_LENGTH;
    if (
      surface.nodeWords[wordOffset + NodeWord.Tag] === tag &&
      surface.nodeWords[wordOffset + NodeWord.StartByte] === startByte &&
      surface.nodeWords[wordOffset + NodeWord.Payload] === symbol
    ) {
      const endByte = surface.nodeWords[wordOffset + NodeWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function caseArmDetails(
  surface: EncodedSemanticSurface,
  startByte: number,
  armIndex: number,
): {
  readonly constructorSymbol: number;
  readonly arity: number;
  readonly binderCount: number;
  readonly span: SemanticDiagnostic["span"];
} | undefined {
  if (armIndex >= surface.nodeCount) return undefined;
  const armOffset = armIndex * NODE_WORD_LENGTH;
  if (
    surface.nodeWords[armOffset + NodeWord.Tag] !== ExpressionTag.CaseArm ||
    surface.nodeWords[armOffset + NodeWord.StartByte] !== startByte
  ) {
    return undefined;
  }
  const constructorSymbol = surface.nodeWords[armOffset + NodeWord.Payload];
  const endByte = surface.nodeWords[armOffset + NodeWord.EndByte];
  const firstPatternOrBody = surface.nodeWords[armOffset + NodeWord.Child0];
  if (
    constructorSymbol === undefined || endByte === undefined || firstPatternOrBody === undefined
  ) {
    return undefined;
  }

  let binderCount = 0;
  let nodeIndex: number = firstPatternOrBody;
  while (nodeIndex < surface.nodeCount) {
    const nodeOffset: number = nodeIndex * NODE_WORD_LENGTH;
    if (surface.nodeWords[nodeOffset + NodeWord.Tag] !== ExpressionTag.PatternBind) {
      break;
    }
    binderCount++;
    const child: number | undefined = surface.nodeWords[nodeOffset + NodeWord.Child0];
    if (child === undefined) return undefined;
    nodeIndex = child;
  }

  const constructorIndex = findConstructor(surface, constructorSymbol);
  if (constructorIndex === undefined) return undefined;
  const arity = surface.constructorWords[
    constructorIndex * CONSTRUCTOR_WORD_LENGTH + ConstructorWord.Arity
  ];
  if (arity === undefined) return undefined;
  return {
    constructorSymbol,
    arity,
    binderCount,
    span: { startByte, endByte },
  };
}

function findConstructor(surface: EncodedSemanticSurface, symbol: number): number | undefined {
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const wordOffset = constructorIndex * CONSTRUCTOR_WORD_LENGTH;
    if (surface.constructorWords[wordOffset + ConstructorWord.Symbol] === symbol) {
      return constructorIndex;
    }
  }
  return undefined;
}

function symbolNameFor(surface: EncodedSemanticSurface, symbol: number): string {
  const symbolName = surface.symbolNames[symbol];
  return symbolName === undefined ? `<symbol ${symbol}>` : JSON.stringify(symbolName);
}
