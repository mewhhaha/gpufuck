import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_NO_INDEX,
  LAZULI_NODE_WORD_LENGTH,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliConstructorWord,
  type LazuliDiagnostic,
  LazuliSurfaceTag,
  LazuliSurfaceWord,
  LazuliTypeWord,
} from "./abi.ts";
import type { GpuLazuliSemanticStateSnapshot } from "./gpu_semantic_contract.ts";

export const LazuliSemanticCompilerErrorCode = {
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
  state: GpuLazuliSemanticStateSnapshot,
  surface: EncodedLazuliSurface,
  sourceByteLength: number,
): LazuliDiagnostic | undefined {
  const symbolName = symbolNameFor(surface, state.errorDetail);
  switch (state.errorCode) {
    case LazuliSemanticCompilerErrorCode.UnknownName: {
      const span = nodeSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2001",
        message: `unknown name ${symbolName}`,
        span,
      };
    }
    case LazuliSemanticCompilerErrorCode.DuplicateDefinition: {
      const span = definitionSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2002",
        message: `duplicate top-level definition ${symbolName}`,
        span,
      };
    }
    case LazuliSemanticCompilerErrorCode.MissingMain:
      if (state.errorSource !== LAZULI_NO_INDEX || state.errorDetail !== surface.mainSymbol) {
        return undefined;
      }
      return {
        stage: "compile",
        code: "L2003",
        message: `missing required entry definition ${symbolName}`,
        span: { startByte: sourceByteLength, endByte: sourceByteLength },
      };
    case LazuliSemanticCompilerErrorCode.DuplicateType: {
      const span = typeSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2004",
        message: `duplicate algebraic type ${symbolName}`,
        span,
      };
    }
    case LazuliSemanticCompilerErrorCode.DuplicateConstructor: {
      const span = constructorSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2005",
        message: `duplicate constructor ${symbolName}`,
        span,
      };
    }
    case LazuliSemanticCompilerErrorCode.DefinitionConstructorCollision: {
      const span = topLevelSymbolSpanAt(surface, state.errorSource, state.errorDetail);
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2006",
        message: `top-level function and constructor share the name ${symbolName}`,
        span,
      };
    }
    case LazuliSemanticCompilerErrorCode.UnknownCaseConstructor: {
      const span = surfaceNodeSpanAt(
        surface,
        state.errorSource,
        state.errorDetail,
        LazuliSurfaceTag.CaseArm,
      );
      if (span === undefined) return undefined;
      return {
        stage: "compile",
        code: "L2007",
        message: `unknown case constructor ${symbolName}`,
        span,
      };
    }
    case LazuliSemanticCompilerErrorCode.PatternArityMismatch: {
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
    case LazuliSemanticCompilerErrorCode.DuplicateCaseArm: {
      const span = surfaceNodeSpanAt(
        surface,
        state.errorSource,
        state.errorDetail,
        LazuliSurfaceTag.CaseArm,
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
): LazuliDiagnostic {
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
): LazuliDiagnostic {
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
): LazuliDiagnostic {
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
): LazuliDiagnostic {
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
): LazuliDiagnostic {
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
): LazuliDiagnostic {
  return {
    stage: "compile",
    code: "L1003",
    message:
      `program exhausted the compiler limit after ${completedTransitions} serial semantic transitions; the limit is ${maximumSteps}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
}

export function formatSemanticState(state: GpuLazuliSemanticStateSnapshot): string {
  return `nodeCount=${state.nodeCount}, definitionCount=${state.definitionCount}, typeCount=${state.typeCount}, constructorCount=${state.constructorCount}, entrySymbol=${state.entrySymbol}, status=${state.status}, errorCode=${state.errorCode}, errorSource=${state.errorSource}, errorDetail=${state.errorDetail}, entryDefinition=${state.entryDefinition}`;
}

export function formatInvalidSurfaceState(state: GpuLazuliSemanticStateSnapshot): string {
  const reason = (() => {
    switch (state.errorCode) {
      case LazuliSemanticCompilerErrorCode.InvalidCounts:
        return "record counts exceed their bound storage buffers";
      case LazuliSemanticCompilerErrorCode.InvalidNode:
        return `node ${state.errorDetail} violates a tag, child, parent, or preorder invariant`;
      case LazuliSemanticCompilerErrorCode.InvalidDefinition:
        return `definition ${state.errorDetail} violates a root or source-order invariant`;
      case LazuliSemanticCompilerErrorCode.InvalidType:
        return `type ${state.errorDetail} violates a constructor-range or source-order invariant`;
      case LazuliSemanticCompilerErrorCode.InvalidConstructor:
        return `constructor ${state.errorDetail} violates a type, arity, or source-order invariant`;
      default:
        return `unknown invariant error ${state.errorCode}`;
    }
  })();
  return `${reason}; ${formatSemanticState(state)}`;
}

function nodeSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  for (let nodeIndex = 0; nodeIndex < surface.nodeCount; nodeIndex++) {
    const wordOffset = nodeIndex * LAZULI_NODE_WORD_LENGTH;
    if (
      surface.nodeWords[wordOffset + LazuliSurfaceWord.Tag] === LazuliSurfaceTag.Name &&
      surface.nodeWords[wordOffset + LazuliSurfaceWord.StartByte] === startByte &&
      surface.nodeWords[wordOffset + LazuliSurfaceWord.Payload] === symbol
    ) {
      const endByte = surface.nodeWords[wordOffset + LazuliSurfaceWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function definitionSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  for (let definitionIndex = 0; definitionIndex < surface.definitionCount; definitionIndex++) {
    const wordOffset = definitionIndex * LAZULI_DEFINITION_WORD_LENGTH;
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

function typeSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  for (let typeIndex = 0; typeIndex < surface.typeCount; typeIndex++) {
    const wordOffset = typeIndex * LAZULI_TYPE_WORD_LENGTH;
    if (
      surface.typeWords[wordOffset + LazuliTypeWord.Symbol] === symbol &&
      surface.typeWords[wordOffset + LazuliTypeWord.StartByte] === startByte
    ) {
      const endByte = surface.typeWords[wordOffset + LazuliTypeWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function constructorSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const wordOffset = constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH;
    if (
      surface.constructorWords[wordOffset + LazuliConstructorWord.Symbol] === symbol &&
      surface.constructorWords[wordOffset + LazuliConstructorWord.StartByte] === startByte
    ) {
      const endByte = surface.constructorWords[wordOffset + LazuliConstructorWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function topLevelSymbolSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
): LazuliDiagnostic["span"] | undefined {
  return definitionSpanAt(surface, startByte, symbol) ??
    constructorSpanAt(surface, startByte, symbol);
}

function surfaceNodeSpanAt(
  surface: EncodedLazuliSurface,
  startByte: number,
  symbol: number,
  tag: number,
): LazuliDiagnostic["span"] | undefined {
  for (let nodeIndex = 0; nodeIndex < surface.nodeCount; nodeIndex++) {
    const wordOffset = nodeIndex * LAZULI_NODE_WORD_LENGTH;
    if (
      surface.nodeWords[wordOffset + LazuliSurfaceWord.Tag] === tag &&
      surface.nodeWords[wordOffset + LazuliSurfaceWord.StartByte] === startByte &&
      surface.nodeWords[wordOffset + LazuliSurfaceWord.Payload] === symbol
    ) {
      const endByte = surface.nodeWords[wordOffset + LazuliSurfaceWord.EndByte];
      if (endByte === undefined) return undefined;
      return { startByte, endByte };
    }
  }
  return undefined;
}

function caseArmDetails(
  surface: EncodedLazuliSurface,
  startByte: number,
  armIndex: number,
): {
  readonly constructorSymbol: number;
  readonly arity: number;
  readonly binderCount: number;
  readonly span: LazuliDiagnostic["span"];
} | undefined {
  if (armIndex >= surface.nodeCount) return undefined;
  const armOffset = armIndex * LAZULI_NODE_WORD_LENGTH;
  if (
    surface.nodeWords[armOffset + LazuliSurfaceWord.Tag] !== LazuliSurfaceTag.CaseArm ||
    surface.nodeWords[armOffset + LazuliSurfaceWord.StartByte] !== startByte
  ) {
    return undefined;
  }
  const constructorSymbol = surface.nodeWords[armOffset + LazuliSurfaceWord.Payload];
  const endByte = surface.nodeWords[armOffset + LazuliSurfaceWord.EndByte];
  const firstPatternOrBody = surface.nodeWords[armOffset + LazuliSurfaceWord.Child0];
  if (
    constructorSymbol === undefined || endByte === undefined || firstPatternOrBody === undefined
  ) {
    return undefined;
  }

  let binderCount = 0;
  let nodeIndex: number = firstPatternOrBody;
  while (nodeIndex < surface.nodeCount) {
    const nodeOffset: number = nodeIndex * LAZULI_NODE_WORD_LENGTH;
    if (surface.nodeWords[nodeOffset + LazuliSurfaceWord.Tag] !== LazuliSurfaceTag.PatternBind) {
      break;
    }
    binderCount++;
    const child: number | undefined = surface.nodeWords[nodeOffset + LazuliSurfaceWord.Child0];
    if (child === undefined) return undefined;
    nodeIndex = child;
  }

  const constructorIndex = findConstructor(surface, constructorSymbol);
  if (constructorIndex === undefined) return undefined;
  const arity = surface.constructorWords[
    constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH + LazuliConstructorWord.Arity
  ];
  if (arity === undefined) return undefined;
  return {
    constructorSymbol,
    arity,
    binderCount,
    span: { startByte, endByte },
  };
}

function findConstructor(surface: EncodedLazuliSurface, symbol: number): number | undefined {
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const wordOffset = constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH;
    if (surface.constructorWords[wordOffset + LazuliConstructorWord.Symbol] === symbol) {
      return constructorIndex;
    }
  }
  return undefined;
}

function symbolNameFor(surface: EncodedLazuliSurface, symbol: number): string {
  const symbolName = surface.symbolNames[symbol];
  return symbolName === undefined ? `<symbol ${symbol}>` : JSON.stringify(symbolName);
}
