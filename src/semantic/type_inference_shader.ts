import {
  type EncodedLazuliSurface,
  LAZULI_ABI_VERSION,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_DEFINITION_WORD_LENGTH,
  LAZULI_MAXIMUM_CONSTRUCTOR_ARITY,
  LAZULI_NO_INDEX,
  LAZULI_NODE_WORD_LENGTH,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliBinaryOperator,
  LazuliConstructorWord,
  LazuliCoreTag,
  LazuliTypeWord,
  LazuliUnaryOperator,
} from "./abi.ts";
import {
  LAZULI_COMPILATION_STATE_WORD_LENGTH,
  LazuliCompilationStatus,
} from "./compiler_shader.ts";
import {
  type FlattenedLazuliTypeSchemas,
  LAZULI_TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH,
  LAZULI_TYPE_SCHEMA_WORD_LENGTH,
  LazuliTypeSchemaMetadataWord,
  LazuliTypeSchemaWord,
} from "./type_schema_abi.ts";

/** Canonical linked-preorder source-type node supplied in binding 4. */
export const LAZULI_INFERENCE_SCHEMA_WORD_LENGTH = LAZULI_TYPE_SCHEMA_WORD_LENGTH;
export const LazuliInferenceSchemaWord = LazuliTypeSchemaWord;

export const LazuliInferenceSchemaTag = {
  Integer: 1,
  Boolean: 2,
  Unit: 3,
  Parameter: 4,
  Tuple: 5,
  Named: 6,
  Function: 7,
  Forall: 8,
  SignedInteger64: 9,
  Float32: 10,
  Float64: 11,
} as const;

/**
 * The schema binding is one raw word array. State words provide the bases of
 * these fixed-width tables. Child, parameter, and field offsets are relative
 * to their respective scalar tables.
 */
export const LAZULI_INFERENCE_TYPE_METADATA_WORD_LENGTH = 4;
export const LazuliInferenceTypeMetadataWord = {
  FirstParameter: 0,
  ParameterCount: 1,
  FirstConstructor: 2,
  ConstructorCount: 3,
} as const;

export const LAZULI_INFERENCE_CONSTRUCTOR_METADATA_WORD_LENGTH = 3;
export const LazuliInferenceConstructorMetadataWord = {
  FirstField: 0,
  FieldCount: 1,
  ResultRoot: 2,
} as const;

/** Internal type records occupy the caller-provided type region in binding 5. */
export const LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH = 5;
export const LazuliInferenceTypeRecordWord = {
  Kind: 0,
  Payload: 1,
  Child0: 2,
  Child1: 3,
  Mark: 4,
} as const;

export const LazuliInferenceInternalTypeKind = {
  Variable: 1,
  Generic: 2,
  Rigid: 3,
  Integer: 4,
  Boolean: 5,
  Unit: 6,
  Tuple: 7,
  Named: 8,
  Function: 9,
  List: 10,
  NamedGeneric: 11,
  Forall: 12,
  SignedInteger64: 13,
  Float32: 14,
  Float64: 15,
} as const;

export const LAZULI_INFERENCE_ENVIRONMENT_WORD_LENGTH = 3;
export const LazuliInferenceEnvironmentWord = {
  Symbol: 0,
  Type: 1,
  Parent: 2,
} as const;

export const LAZULI_INFERENCE_FRAME_WORD_LENGTH = 12;
export const LAZULI_INFERENCE_REFINEMENT_WORD_LENGTH = 2;
export const LazuliInferenceFrameWord = {
  Node: 0,
  Stage: 1,
  Environment: 2,
  Type0: 3,
  Type1: 4,
  Aux0: 5,
  Aux1: 6,
  Aux2: 7,
  Aux3: 8,
  SavedLevel: 9,
  Kind: 10,
  Cursor: 11,
} as const;

/** Concrete linked-preorder schema nodes in binding 6. */
export const LAZULI_INFERENCE_OUTPUT_WORD_LENGTH = 6;
export const LazuliInferenceOutputWord = {
  Tag: 0,
  Symbol: 1,
  FirstChild: 2,
  NextSibling: 3,
  StartByte: 4,
  EndByte: 5,
} as const;

export const LazuliInferenceOutputTag = {
  Integer: 1,
  Boolean: 2,
  Unit: 3,
  Tuple: 5,
  Named: 6,
  Function: 7,
  SignedInteger64: 9,
  Float32: 10,
  Float64: 11,
} as const;

export const LazuliInferenceStatus = {
  Uninitialized: 0,
  Pending: 1,
  Complete: 2,
  Diagnostic: 3,
  InvalidInput: 4,
  Exhausted: 5,
} as const;

/** Numeric counterparts of L2010/L2101-L2104 plus bounded-arena failures. */
export const LazuliInferenceDiagnosticCode = {
  None: 0,
  NonExhaustiveCase: 2010,
  InvalidTypeMetadata: 2101,
  TypeMismatch: 2102,
  InfiniteType: 2103,
  NonConcreteMain: 2104,
  InvalidSurface: 2201,
  TypeArenaExhausted: 2202,
  EnvironmentArenaExhausted: 2203,
  FrameArenaExhausted: 2204,
  ScratchArenaExhausted: 2205,
  OutputArenaExhausted: 2206,
  RefinementArenaExhausted: 2207,
} as const;

/**
 * Stable `ErrorContext` values for L2101. `ErrorDetail` and the two error
 * operands use the category-specific meanings documented on
 * `LazuliInferenceStateWord`.
 */
export const LazuliInferenceMetadataFailure = {
  UnknownName: 1,
  UnknownCaseConstructor: 2,
  CaseFieldCountMismatch: 3,
  UndeclaredTypeParameter: 4,
  UnknownType: 5,
  TypeArgumentCountMismatch: 6,
  UnsupportedExpression: 7,
  InvalidDefinitionAnnotation: 8,
  InvalidTypeDeclaration: 9,
  RepeatedTypeParameter: 10,
  InvalidConstructor: 12,
  ConstructorFieldCountMismatch: 13,
  InvalidConstructorField: 14,
  InvalidSchemaShape: 15,
  InvalidSchemaConversion: 16,
  DuplicateTypeName: 17,
  InvalidEmptyCaseScrutinee: 18,
  InvalidConstructorResult: 19,
  HiddenConstructorFieldParameter: 20,
  IndexedExpectedTypeMissing: 21,
  IndexedExpectedTypeUnresolved: 22,
  IndexedScrutineeUnresolved: 23,
  IndexedScrutineeTypeMismatch: 24,
  UntouchableIndexedVariable: 25,
} as const;

/**
 * Binding 7 is an array of state records. Words through `ConstructorResultBase`
 * and `IndexedMetadataFooterBase` are immutable dispatch inputs; the shader
 * initializes and owns the other trailing words.
 *
 * Diagnostic payloads are durable workspace references/scalars:
 *
 * - L2010: `ErrorDetail` is the missing constructor symbol.
 * - L2101: `ErrorContext` is `LazuliInferenceMetadataFailure`; `ErrorDetail`
 *   identifies the primary symbol/index, while `ErrorOperand0/1` carry any
 *   expected/received evidence required by that category. Name/type failures
 *   put the offending symbol in `ErrorDetail`; case-field, type-argument, and
 *   constructor-field failures put expected and received counts in operands 0
 *   and 1. A repeated parameter uses the type
 *   symbol as detail and the parameter symbol as operand 0. Structural
 *   metadata failures use the offending table index as detail and preserve
 *   the invalid indices/counts in the operands. An invalid empty-case
 *   scrutinee uses its inferred type root as operand 0. Constructor-result
 *   failures use the constructor index as detail and the result root as
 *   operand 0; hidden field parameters additionally put their symbol there.
 * - L2102: `ErrorOperand0/1` are the expected/received internal type roots.
 * - L2103: `ErrorOperand0/1` are the variable/candidate internal type roots.
 * - L2104: `ErrorDetail` is the main symbol and `ErrorOperand0` is its inferred
 *   type root, or `LAZULI_NO_INDEX` when main has no definition.
 */
export const LAZULI_INFERENCE_STATE_WORD_LENGTH = 73;
export const LAZULI_INFERENCE_SCHEDULER_WORD_LENGTH = 1 +
  LAZULI_COMPILATION_STATE_WORD_LENGTH;
export const LAZULI_INFERENCE_INTERNAL_STATE_WORD_LENGTH = LAZULI_INFERENCE_STATE_WORD_LENGTH +
  LAZULI_INFERENCE_SCHEDULER_WORD_LENGTH;
export const LazuliInferenceSchedulerWord = {
  PreviousSemanticSteps: LAZULI_INFERENCE_STATE_WORD_LENGTH,
  SemanticState: LAZULI_INFERENCE_STATE_WORD_LENGTH + 1,
} as const;
export const LazuliInferenceStateWord = {
  NodeCount: 0,
  DefinitionCount: 1,
  TypeCount: 2,
  ConstructorCount: 3,
  SchemaNodeCount: 4,
  MainSymbol: 5,
  MaximumTransitionsPerDispatch: 6,
  TypeBase: 7,
  TypeCapacity: 8,
  EnvironmentBase: 9,
  EnvironmentCapacity: 10,
  FrameBase: 11,
  FrameCapacity: 12,
  ScratchBase: 13,
  ScratchCapacity: 14,
  OutputCapacity: 15,
  DefinitionAnnotationBase: 16,
  SchemaBase: 17,
  TypeParameterBase: 18,
  TypeParameterCount: 19,
  TypeParameterOffsetsBase: 20,
  ConstructorFieldBase: 21,
  ConstructorFieldCount: 22,
  ConstructorFieldOffsetsBase: 23,
  ConstructorResultBase: 24,
  Status: 25,
  ErrorCode: 26,
  ErrorStartByte: 27,
  ErrorEndByte: 28,
  ErrorDetail: 29,
  Phase: 30,
  ValidationSection: 31,
  Cursor: 32,
  Transitions: 33,
  TypeTop: 34,
  EnvironmentTop: 35,
  FrameTop: 36,
  NextGeneric: 37,
  TraversalEpoch: 38,
  CurrentLevel: 39,
  TarjanNextIndex: 40,
  TarjanStackTop: 41,
  TarjanDfsTop: 42,
  TarjanRootCursor: 43,
  ComponentCount: 44,
  ComponentStage: 45,
  ComponentCursor: 46,
  ExpressionDefinition: 47,
  ReturnedType: 48,
  MainDefinition: 49,
  OutputRoot: 50,
  OutputCount: 51,
  CurrentArm: 52,
  ErrorOperand0: 53,
  ErrorOperand1: 54,
  ErrorContext: 55,
  Substage: 56,
  Cursor0: 57,
  Cursor1: 58,
  EpochClearCursor: 59,
  TarjanStage: 60,
  TarjanComponentRoot: 61,
  WorkResult: 62,
  WorkAux: 63,
  RefinementBase: 64,
  RefinementCapacity: 65,
  RefinementTop: 66,
  UntouchableTypeCutoff: 67,
  ComponentRecursive: 68,
  IndexedEliminationAllowed: 69,
  IndexedEliminationRestrictionKind: 70,
  IndexedEliminationRestrictionSymbol: 71,
  IndexedMetadataFooterBase: 72,
  /** @deprecated Alias retained for callers using the former reserved word. */
  Reserved0: 53,
  /** @deprecated Alias retained for callers using the former reserved word. */
  Reserved1: 54,
} as const;

export interface LazuliInferenceShaderMetadata {
  readonly words: Uint32Array;
  /** Surface and synthetic schema identifier spelling keyed by encoded ID. */
  readonly identifierNames: readonly string[];
  /** Original schema-parameter spelling keyed by its flattened synthetic ID. */
  readonly parameterNames: ReadonlyMap<number, string>;
  readonly schemaNodeCount: number;
  readonly definitionAnnotationBase: number;
  readonly schemaBase: number;
  readonly typeParameterBase: number;
  readonly typeParameterCount: number;
  readonly typeParameterOffsetsBase: number;
  readonly constructorFieldBase: number;
  readonly constructorFieldCount: number;
  readonly constructorFieldOffsetsBase: number;
  readonly constructorResultBase: number;
  readonly indexedMetadataFooterBase: number;
}

const INDEXED_METADATA_MAGIC = 0x4c5a4958;
const INDEXED_METADATA_FOOTER_WORD_LENGTH = 8;
const VALIDATION_RECORD_WORD_LENGTH = 6;

const ValidationRecordWord = {
  Context: 0,
  StartByte: 1,
  EndByte: 2,
  Detail: 3,
  Operand0: 4,
  Operand1: 5,
} as const;

function prepareIndexedInferenceMetadata(
  surface: EncodedLazuliSurface,
  flattened: FlattenedLazuliTypeSchemas,
): { readonly words: Uint32Array; readonly footerBase: number } {
  const typeLookup = new Uint32Array(flattened.identifierNames.length);
  typeLookup.fill(LAZULI_NO_INDEX);
  for (let typeIndex = 0; typeIndex < surface.typeCount; typeIndex++) {
    const symbol = surface.typeWords[typeIndex * LAZULI_TYPE_WORD_LENGTH + LazuliTypeWord.Symbol]!;
    if (symbol < typeLookup.length && typeLookup[symbol] === LAZULI_NO_INDEX) {
      typeLookup[symbol] = typeIndex;
    }
  }

  const typeValidation = new Uint32Array(
    surface.typeCount * VALIDATION_RECORD_WORD_LENGTH,
  );
  const writeFailure = (
    records: Uint32Array,
    index: number,
    context: number,
    startByte: number,
    endByte: number,
    detail: number,
    operand0: number,
    operand1: number,
  ): void => {
    const base = index * VALIDATION_RECORD_WORD_LENGTH;
    records[base + ValidationRecordWord.Context] = context;
    records[base + ValidationRecordWord.StartByte] = startByte;
    records[base + ValidationRecordWord.EndByte] = endByte;
    records[base + ValidationRecordWord.Detail] = detail;
    records[base + ValidationRecordWord.Operand0] = operand0;
    records[base + ValidationRecordWord.Operand1] = operand1;
  };
  for (let typeIndex = 0; typeIndex < surface.typeCount; typeIndex++) {
    const typeBase = typeIndex * LAZULI_TYPE_WORD_LENGTH;
    const symbol = surface.typeWords[typeBase + LazuliTypeWord.Symbol]!;
    const startByte = surface.typeWords[typeBase + LazuliTypeWord.StartByte]!;
    const endByte = surface.typeWords[typeBase + LazuliTypeWord.EndByte]!;
    if (symbol < typeLookup.length && typeLookup[symbol] !== typeIndex) {
      writeFailure(
        typeValidation,
        typeIndex,
        LazuliInferenceMetadataFailure.DuplicateTypeName,
        startByte,
        endByte,
        symbol,
        typeLookup[symbol]!,
        typeIndex,
      );
      continue;
    }
    const firstParameter = flattened.typeParameterOffsets[typeIndex]!;
    const parameterEnd = flattened.typeParameterOffsets[typeIndex + 1]!;
    const firstOccurrences = new Map<number, number>();
    for (let offset = 0; offset < parameterEnd - firstParameter; offset++) {
      const parameter = flattened.typeParameterSymbols[firstParameter + offset]!;
      const firstOccurrence = firstOccurrences.get(parameter);
      if (firstOccurrence !== undefined) {
        writeFailure(
          typeValidation,
          typeIndex,
          LazuliInferenceMetadataFailure.RepeatedTypeParameter,
          startByte,
          endByte,
          symbol,
          parameter,
          offset,
        );
        break;
      }
      firstOccurrences.set(parameter, offset);
    }
  }

  const schemaCount = flattened.schemaWords.length / LAZULI_TYPE_SCHEMA_WORD_LENGTH;
  const schemaParameterPositions = new Uint32Array(schemaCount);
  schemaParameterPositions.fill(LAZULI_NO_INDEX);
  const syntheticSchemaConstructors = new Uint32Array(schemaCount);
  syntheticSchemaConstructors.fill(LAZULI_NO_INDEX);
  const typesWithExplicitResults = new Uint32Array(surface.typeCount);
  const schemaWord = (schemaIndex: number, word: number): number =>
    flattened.schemaWords[schemaIndex * LAZULI_TYPE_SCHEMA_WORD_LENGTH + word]!;
  const parameterNodes = (root: number): readonly number[] => {
    const parameters: number[] = [];
    const pending = [root];
    while (pending.length !== 0) {
      const schemaIndex = pending.pop()!;
      if (
        schemaWord(schemaIndex, LazuliTypeSchemaWord.Tag) === LazuliInferenceSchemaTag.Parameter
      ) {
        parameters.push(schemaIndex);
      }
      const children: number[] = [];
      let child = schemaWord(schemaIndex, LazuliTypeSchemaWord.FirstChild);
      while (child !== LAZULI_NO_INDEX) {
        children.push(child);
        child = schemaWord(child, LazuliTypeSchemaWord.NextSibling);
      }
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!);
    }
    return parameters;
  };

  const constructorValidation = new Uint32Array(
    surface.constructorCount * VALIDATION_RECORD_WORD_LENGTH,
  );
  for (let constructorIndex = 0; constructorIndex < surface.constructorCount; constructorIndex++) {
    const constructorBase = constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH;
    const typeIndex = surface.constructorWords[
      constructorBase + LazuliConstructorWord.Type
    ]!;
    const constructorSymbol = surface.constructorWords[
      constructorBase + LazuliConstructorWord.Symbol
    ]!;
    const firstParameter = flattened.typeParameterOffsets[typeIndex]!;
    const parameterEnd = flattened.typeParameterOffsets[typeIndex + 1]!;
    const parameterPositions = new Map<number, number>();
    for (let offset = 0; offset < parameterEnd - firstParameter; offset++) {
      parameterPositions.set(flattened.typeParameterSymbols[firstParameter + offset]!, offset);
    }
    const firstField = flattened.constructorFieldOffsets[constructorIndex]!;
    const fieldEnd = flattened.constructorFieldOffsets[constructorIndex + 1]!;
    const fieldParameterNodes: number[] = [];
    for (let field = firstField; field < fieldEnd; field++) {
      fieldParameterNodes.push(...parameterNodes(flattened.constructorFieldRoots[field]!));
    }
    const resultRoot = flattened.constructorResultRoots[constructorIndex]!;
    syntheticSchemaConstructors[resultRoot] = constructorIndex;
    if (
      schemaWord(resultRoot, LazuliTypeSchemaWord.StartByte) !== LAZULI_NO_INDEX ||
      schemaWord(resultRoot, LazuliTypeSchemaWord.EndByte) !== LAZULI_NO_INDEX
    ) {
      typesWithExplicitResults[typeIndex] = 1;
    }
    const resultParameterNodes = parameterNodes(resultRoot);
    const resultParameters = new Set<number>();
    let failureWritten = false;
    for (const schemaIndex of [...fieldParameterNodes, ...resultParameterNodes]) {
      const parameter = schemaWord(schemaIndex, LazuliTypeSchemaWord.Symbol);
      const position = parameterPositions.get(parameter);
      if (position !== undefined) {
        schemaParameterPositions[schemaIndex] = position;
        continue;
      }
      writeFailure(
        constructorValidation,
        constructorIndex,
        LazuliInferenceMetadataFailure.UndeclaredTypeParameter,
        schemaWord(schemaIndex, LazuliTypeSchemaWord.StartByte),
        schemaWord(schemaIndex, LazuliTypeSchemaWord.EndByte),
        parameter,
        typeIndex,
        constructorSymbol,
      );
      failureWritten = true;
      break;
    }
    if (failureWritten) continue;
    const resultTag = schemaWord(resultRoot, LazuliTypeSchemaWord.Tag);
    const resultSymbol = schemaWord(resultRoot, LazuliTypeSchemaWord.Symbol);
    const declaredSymbol = surface.typeWords[
      typeIndex * LAZULI_TYPE_WORD_LENGTH + LazuliTypeWord.Symbol
    ]!;
    let resultHeadIsValid = resultTag === LazuliInferenceSchemaTag.Named &&
      resultSymbol === declaredSymbol;
    if (typeIndex + 2 === surface.typeCount) {
      resultHeadIsValid = resultTag === LazuliInferenceSchemaTag.Unit;
    } else if (typeIndex + 1 === surface.typeCount) {
      resultHeadIsValid = resultTag === LazuliInferenceSchemaTag.Tuple;
    }
    if (!resultHeadIsValid) {
      writeFailure(
        constructorValidation,
        constructorIndex,
        LazuliInferenceMetadataFailure.InvalidConstructorResult,
        schemaWord(resultRoot, LazuliTypeSchemaWord.StartByte),
        schemaWord(resultRoot, LazuliTypeSchemaWord.EndByte),
        constructorIndex,
        resultRoot,
        declaredSymbol,
      );
      continue;
    }
    for (const schemaIndex of resultParameterNodes) {
      resultParameters.add(schemaWord(schemaIndex, LazuliTypeSchemaWord.Symbol));
    }
    for (const schemaIndex of fieldParameterNodes) {
      const parameter = schemaWord(schemaIndex, LazuliTypeSchemaWord.Symbol);
      if (resultParameters.has(parameter)) continue;
      writeFailure(
        constructorValidation,
        constructorIndex,
        LazuliInferenceMetadataFailure.HiddenConstructorFieldParameter,
        schemaWord(schemaIndex, LazuliTypeSchemaWord.StartByte),
        schemaWord(schemaIndex, LazuliTypeSchemaWord.EndByte),
        constructorIndex,
        parameter,
        resultRoot,
      );
      break;
    }
  }

  const originalWordLength = flattened.metadataWords.length;
  const typeLookupBase = originalWordLength;
  const typeValidationBase = typeLookupBase + typeLookup.length;
  const constructorValidationBase = typeValidationBase + typeValidation.length;
  const schemaParameterPositionBase = constructorValidationBase + constructorValidation.length;
  const syntheticSchemaConstructorBase = schemaParameterPositionBase +
    schemaParameterPositions.length;
  const typeExplicitResultBase = syntheticSchemaConstructorBase +
    syntheticSchemaConstructors.length;
  const footerBase = typeExplicitResultBase + typesWithExplicitResults.length;
  const words = new Uint32Array(footerBase + INDEXED_METADATA_FOOTER_WORD_LENGTH);
  words.set(flattened.metadataWords);
  words.set(typeLookup, typeLookupBase);
  words.set(typeValidation, typeValidationBase);
  words.set(constructorValidation, constructorValidationBase);
  words.set(schemaParameterPositions, schemaParameterPositionBase);
  words.set(syntheticSchemaConstructors, syntheticSchemaConstructorBase);
  words.set(typesWithExplicitResults, typeExplicitResultBase);
  words.set([
    INDEXED_METADATA_MAGIC,
    typeLookupBase,
    typeLookup.length,
    typeValidationBase,
    constructorValidationBase,
    schemaParameterPositionBase,
    syntheticSchemaConstructorBase,
    typeExplicitResultBase,
  ], footerBase);
  return { words, footerBase };
}

/**
 * Exposes the repository's canonical linked-preorder schema ABI to the shader.
 * It does not parse types, alter parameter identity, resolve named types, or
 * repack the seven metadata tables.
 */
export function prepareLazuliInferenceShaderMetadata(
  surface: EncodedLazuliSurface,
  flattened: FlattenedLazuliTypeSchemas,
): LazuliInferenceShaderMetadata {
  const schemaCount = flattened.schemaWords.length / LAZULI_TYPE_SCHEMA_WORD_LENGTH;
  if (!Number.isInteger(schemaCount)) {
    throw new Error(
      `Lazuli schema buffer has ${flattened.schemaWords.length} words; expected a multiple of ${LAZULI_TYPE_SCHEMA_WORD_LENGTH}.`,
    );
  }
  const parameterNames = new Map<number, string>();
  const rememberParameterName = (symbol: number, name: string): void => {
    const existing = parameterNames.get(symbol);
    if (existing !== undefined && existing !== name) {
      throw new Error(
        `Lazuli schema parameter ${symbol} is both ${JSON.stringify(existing)} and ${
          JSON.stringify(name)
        }.`,
      );
    }
    parameterNames.set(symbol, name);
  };
  for (let schemaIndex = 0; schemaIndex < schemaCount; schemaIndex++) {
    const source = schemaIndex * LAZULI_TYPE_SCHEMA_WORD_LENGTH;
    const tag = flattened.schemaWords[source + LazuliTypeSchemaWord.Tag];
    const symbol = flattened.schemaWords[source + LazuliTypeSchemaWord.Symbol];
    if (tag === undefined || symbol === undefined) {
      throw new Error(`Lazuli schema record ${schemaIndex} is incomplete.`);
    }
    if (
      tag === LazuliInferenceSchemaTag.Parameter || tag === LazuliInferenceSchemaTag.Forall
    ) {
      const parameterName = flattened.identifierNames[symbol];
      if (parameterName === undefined) {
        throw new Error(
          `Lazuli schema parameter record ${schemaIndex} references missing identifier ${symbol}.`,
        );
      }
      rememberParameterName(symbol, parameterName);
    }
  }

  for (let typeIndex = 0; typeIndex < surface.typeCount; typeIndex++) {
    const firstParameter = flattened.typeParameterOffsets[typeIndex];
    const parameterEnd = flattened.typeParameterOffsets[typeIndex + 1];
    if (firstParameter === undefined || parameterEnd === undefined) {
      throw new Error(`Lazuli type ${typeIndex} metadata is incomplete.`);
    }
    for (
      let parameterOffset = 0;
      parameterOffset < parameterEnd - firstParameter;
      parameterOffset++
    ) {
      const parameterSymbol = flattened.typeParameterSymbols[firstParameter + parameterOffset];
      const parameterName = parameterSymbol === undefined
        ? undefined
        : flattened.identifierNames[parameterSymbol];
      if (parameterSymbol === undefined || parameterName === undefined) {
        throw new Error(`Lazuli type ${typeIndex} parameter ${parameterOffset} is incomplete.`);
      }
      rememberParameterName(parameterSymbol, parameterName);
    }
  }

  const header = flattened.metadataWords;
  if (
    header[LazuliTypeSchemaMetadataWord.AbiVersion] !== LAZULI_ABI_VERSION ||
    header[LazuliTypeSchemaMetadataWord.HeaderWordLength] !==
      LAZULI_TYPE_SCHEMA_METADATA_HEADER_WORD_LENGTH
  ) {
    throw new Error("Lazuli schema metadata has an incompatible header.");
  }
  if (flattened.constructorResultRoots.length !== surface.constructorCount) {
    throw new Error(
      `Lazuli schema metadata has ${flattened.constructorResultRoots.length} constructor results; expected ${surface.constructorCount}.`,
    );
  }
  const offset = (word: number): number => header[word] ?? 0;
  const indexed = prepareIndexedInferenceMetadata(surface, flattened);
  return Object.freeze({
    words: indexed.words,
    identifierNames: flattened.identifierNames,
    parameterNames,
    schemaNodeCount: schemaCount,
    definitionAnnotationBase: offset(
      LazuliTypeSchemaMetadataWord.DefinitionAnnotationRootsOffset,
    ),
    schemaBase: offset(LazuliTypeSchemaMetadataWord.SchemaWordsOffset),
    typeParameterBase: offset(LazuliTypeSchemaMetadataWord.TypeParameterSymbolsOffset),
    typeParameterCount: flattened.typeParameterSymbols.length,
    typeParameterOffsetsBase: offset(LazuliTypeSchemaMetadataWord.TypeParameterOffsetsOffset),
    constructorFieldBase: offset(LazuliTypeSchemaMetadataWord.ConstructorFieldRootsOffset),
    constructorFieldCount: flattened.constructorFieldRoots.length,
    constructorFieldOffsetsBase: offset(
      LazuliTypeSchemaMetadataWord.ConstructorFieldOffsetsOffset,
    ),
    constructorResultBase: offset(LazuliTypeSchemaMetadataWord.ConstructorResultRootsOffset),
    indexedMetadataFooterBase: indexed.footerBase,
  });
}

/**
 * Persistent, bounded Hindley-Milner and predicative rank-N inference for resolved core
 * nodes and flattened ABI-v5 type metadata. The eight bindings stay within WebGPU's portable
 * per-stage storage-buffer minimum. A dispatch performs at most
 * `maximum_transitions_per_dispatch` state-machine transitions; all durable
 * cursors, Tarjan stacks, expression frames, and arenas live in GPU buffers.
 *
 * Scratch layout is shader-owned: eight definition-sized vectors followed by
 * a temporary area used for schema-parameter mappings and constructor fields.
 * Only the definition vectors are statically required; temporary operations
 * report their exact required capacity before indexing through it.
 */
export const LAZULI_TYPE_INFERENCE_SHADER = /* wgsl */ `
struct CoreNode {
  tag: u32,
  payload: u32,
  child0: u32,
  child1: u32,
  child2: u32,
  start_byte: u32,
  end_byte: u32,
  evaluation_mode: u32,
}

struct Definition {
  symbol: u32,
  root_node: u32,
  start_byte: u32,
  end_byte: u32,
}

struct AlgebraicType {
  symbol: u32,
  first_constructor: u32,
  constructor_count: u32,
  start_byte: u32,
  end_byte: u32,
}

struct Constructor {
  symbol: u32,
  type_index: u32,
  arity: u32,
  start_byte: u32,
  end_byte: u32,
}

struct SchemaNode {
  tag: u32,
  payload: u32,
  first_child: u32,
  next_sibling: u32,
  start_byte: u32,
  end_byte: u32,
}

struct OutputTypeNode {
  tag: u32,
  symbol: u32,
  first_child: u32,
  next_sibling: u32,
  start_byte: u32,
  end_byte: u32,
}

struct SemanticCompilationState {
  node_count: u32,
  definition_count: u32,
  type_count: u32,
  constructor_count: u32,
  entry_symbol: u32,
  status: u32,
  error_code: u32,
  error_source: u32,
  error_detail: u32,
  entry_definition: u32,
  total_steps: u32,
  maximum_steps: u32,
  maximum_steps_per_dispatch: u32,
  phase: u32,
  primary_cursor: u32,
  secondary_cursor: u32,
  tertiary_cursor: u32,
  resolution_node: u32,
  resolution_parent: u32,
  resolution_child: u32,
  resolution_depth: u32,
  resolution_symbol: u32,
  core_tag: u32,
  core_payload: u32,
}

struct InferenceState {
  node_count: u32,
  definition_count: u32,
  type_count: u32,
  constructor_count: u32,
  schema_node_count: u32,
  main_symbol: u32,
  maximum_transitions_per_dispatch: u32,
  type_base: u32,
  type_capacity: u32,
  environment_base: u32,
  environment_capacity: u32,
  frame_base: u32,
  frame_capacity: u32,
  scratch_base: u32,
  scratch_capacity: u32,
  output_capacity: u32,
  definition_annotation_base: u32,
  schema_base: u32,
  type_parameter_base: u32,
  type_parameter_count: u32,
  type_parameter_offsets_base: u32,
  constructor_field_base: u32,
  constructor_field_count: u32,
  constructor_field_offsets_base: u32,
  constructor_result_base: u32,
  status: u32,
  error_code: u32,
  error_start_byte: u32,
  error_end_byte: u32,
  error_detail: u32,
  phase: u32,
  validation_section: u32,
  cursor: u32,
  transitions: u32,
  type_top: u32,
  environment_top: u32,
  frame_top: u32,
  next_generic: u32,
  traversal_epoch: u32,
  current_level: u32,
  tarjan_next_index: u32,
  tarjan_stack_top: u32,
  tarjan_dfs_top: u32,
  tarjan_root_cursor: u32,
  component_count: u32,
  component_stage: u32,
  component_cursor: u32,
  expression_definition: u32,
  returned_type: u32,
  main_definition: u32,
  output_root: u32,
  output_count: u32,
  current_arm: u32,
  error_operand0: u32,
  error_operand1: u32,
  error_context: u32,
  substage: u32,
  cursor0: u32,
  cursor1: u32,
  epoch_clear_cursor: u32,
  tarjan_stage: u32,
  tarjan_component_root: u32,
  work_result: u32,
  work_aux: u32,
  refinement_base: u32,
  refinement_capacity: u32,
  refinement_top: u32,
  untouchable_type_cutoff: u32,
  component_recursive: u32,
  indexed_elimination_allowed: u32,
  indexed_elimination_restriction_kind: u32,
  indexed_elimination_restriction_symbol: u32,
  indexed_metadata_footer_base: u32,
  previous_semantic_steps: u32,
  semantic: SemanticCompilationState,
}

@group(0) @binding(0) var<storage, read> core_nodes: array<CoreNode>;
@group(0) @binding(1) var<storage, read> definitions: array<Definition>;
@group(0) @binding(2) var<storage, read> algebraic_types: array<AlgebraicType>;
@group(0) @binding(3) var<storage, read> constructors: array<Constructor>;
@group(0) @binding(4) var<storage, read> schema_words: array<u32>;
@group(0) @binding(5) var<storage, read_write> workspace: array<u32>;
@group(0) @binding(6) var<storage, read_write> output_types: array<OutputTypeNode>;
@group(0) @binding(7) var<storage, read_write> inference_states: array<InferenceState>;

var<private> state: InferenceState;

const NO_INDEX: u32 = ${LAZULI_NO_INDEX}u;
const NODE_WORD_LENGTH: u32 = ${LAZULI_NODE_WORD_LENGTH}u;
const DEFINITION_WORD_LENGTH: u32 = ${LAZULI_DEFINITION_WORD_LENGTH}u;
const TYPE_WORD_LENGTH: u32 = ${LAZULI_TYPE_WORD_LENGTH}u;
const CONSTRUCTOR_WORD_LENGTH: u32 = ${LAZULI_CONSTRUCTOR_WORD_LENGTH}u;
const MAXIMUM_CONSTRUCTOR_ARITY: u32 = ${LAZULI_MAXIMUM_CONSTRUCTOR_ARITY}u;

const STATUS_UNINITIALIZED: u32 = 0u;
const STATUS_PENDING: u32 = 1u;
const STATUS_COMPLETE: u32 = 2u;
const STATUS_DIAGNOSTIC: u32 = 3u;
const STATUS_INVALID_INPUT: u32 = 4u;
const STATUS_EXHAUSTED: u32 = 5u;
const SEMANTIC_STATUS_OK: u32 = ${LazuliCompilationStatus.Ok}u;

const ERROR_NONE: u32 = 0u;
const ERROR_NON_EXHAUSTIVE_CASE: u32 = 2010u;
const ERROR_INVALID_TYPE_METADATA: u32 = 2101u;
const ERROR_TYPE_MISMATCH: u32 = 2102u;
const ERROR_INFINITE_TYPE: u32 = 2103u;
const ERROR_NON_CONCRETE_MAIN: u32 = 2104u;
const ERROR_INVALID_SURFACE: u32 = 2201u;
const ERROR_TYPE_ARENA_EXHAUSTED: u32 = 2202u;
const ERROR_ENVIRONMENT_ARENA_EXHAUSTED: u32 = 2203u;
const ERROR_FRAME_ARENA_EXHAUSTED: u32 = 2204u;
const ERROR_SCRATCH_ARENA_EXHAUSTED: u32 = 2205u;
const ERROR_OUTPUT_ARENA_EXHAUSTED: u32 = 2206u;
const ERROR_REFINEMENT_ARENA_EXHAUSTED: u32 = 2207u;
const TYPE_MISMATCH_INACCESSIBLE_CONSTRUCTOR: u32 = 1u;

fn core_node(index: u32) -> CoreNode {
  return core_nodes[state.semantic.phase + index];
}

fn definition_record(index: u32) -> Definition {
  return definitions[state.semantic.primary_cursor + index];
}

fn algebraic_type_record(index: u32) -> AlgebraicType {
  return algebraic_types[state.semantic.secondary_cursor + index];
}

fn constructor_record(index: u32) -> Constructor {
  return constructors[state.semantic.tertiary_cursor + index];
}

fn output_address(index: u32) -> u32 {
  return state.semantic.resolution_node + index;
}

const METADATA_CASE_FIELD_COUNT_MISMATCH: u32 = ${LazuliInferenceMetadataFailure.CaseFieldCountMismatch}u;
const METADATA_UNDECLARED_TYPE_PARAMETER: u32 = ${LazuliInferenceMetadataFailure.UndeclaredTypeParameter}u;
const METADATA_UNKNOWN_TYPE: u32 = ${LazuliInferenceMetadataFailure.UnknownType}u;
const METADATA_TYPE_ARGUMENT_COUNT_MISMATCH: u32 = ${LazuliInferenceMetadataFailure.TypeArgumentCountMismatch}u;
const METADATA_UNSUPPORTED_EXPRESSION: u32 = ${LazuliInferenceMetadataFailure.UnsupportedExpression}u;
const METADATA_INVALID_DEFINITION_ANNOTATION: u32 = ${LazuliInferenceMetadataFailure.InvalidDefinitionAnnotation}u;
const METADATA_INVALID_TYPE_DECLARATION: u32 = ${LazuliInferenceMetadataFailure.InvalidTypeDeclaration}u;
const METADATA_REPEATED_TYPE_PARAMETER: u32 = ${LazuliInferenceMetadataFailure.RepeatedTypeParameter}u;
const METADATA_INVALID_CONSTRUCTOR: u32 = ${LazuliInferenceMetadataFailure.InvalidConstructor}u;
const METADATA_CONSTRUCTOR_FIELD_COUNT_MISMATCH: u32 = ${LazuliInferenceMetadataFailure.ConstructorFieldCountMismatch}u;
const METADATA_INVALID_CONSTRUCTOR_FIELD: u32 = ${LazuliInferenceMetadataFailure.InvalidConstructorField}u;
const METADATA_INVALID_SCHEMA_SHAPE: u32 = ${LazuliInferenceMetadataFailure.InvalidSchemaShape}u;
const METADATA_INVALID_SCHEMA_CONVERSION: u32 = ${LazuliInferenceMetadataFailure.InvalidSchemaConversion}u;
const METADATA_DUPLICATE_TYPE_NAME: u32 = ${LazuliInferenceMetadataFailure.DuplicateTypeName}u;
const METADATA_INVALID_EMPTY_CASE_SCRUTINEE: u32 = ${LazuliInferenceMetadataFailure.InvalidEmptyCaseScrutinee}u;
const METADATA_INVALID_CONSTRUCTOR_RESULT: u32 = ${LazuliInferenceMetadataFailure.InvalidConstructorResult}u;
const METADATA_HIDDEN_CONSTRUCTOR_FIELD_PARAMETER: u32 = ${LazuliInferenceMetadataFailure.HiddenConstructorFieldParameter}u;
const METADATA_INDEXED_EXPECTED_TYPE_MISSING: u32 = ${LazuliInferenceMetadataFailure.IndexedExpectedTypeMissing}u;
const METADATA_INDEXED_EXPECTED_TYPE_UNRESOLVED: u32 = ${LazuliInferenceMetadataFailure.IndexedExpectedTypeUnresolved}u;
const METADATA_INDEXED_SCRUTINEE_UNRESOLVED: u32 = ${LazuliInferenceMetadataFailure.IndexedScrutineeUnresolved}u;
const METADATA_INDEXED_SCRUTINEE_TYPE_MISMATCH: u32 = ${LazuliInferenceMetadataFailure.IndexedScrutineeTypeMismatch}u;
const METADATA_UNTOUCHABLE_INDEXED_VARIABLE: u32 = ${LazuliInferenceMetadataFailure.UntouchableIndexedVariable}u;

const PHASE_VALIDATE: u32 = 1u;
const PHASE_TARJAN: u32 = 2u;
const PHASE_COMPONENT: u32 = 3u;
const PHASE_SERIALIZE: u32 = 4u;

const SCHEMA_INTEGER: u32 = 1u;
const SCHEMA_BOOLEAN: u32 = 2u;
const SCHEMA_UNIT: u32 = 3u;
const SCHEMA_PARAMETER: u32 = 4u;
const SCHEMA_TUPLE: u32 = 5u;
const SCHEMA_NAMED: u32 = 6u;
const SCHEMA_FUNCTION: u32 = 7u;
const SCHEMA_FORALL: u32 = 8u;
const SCHEMA_SIGNED_INTEGER_64: u32 = 9u;
const SCHEMA_FLOAT_32: u32 = 10u;
const SCHEMA_FLOAT_64: u32 = 11u;

const INDEXED_METADATA_MAGIC: u32 = ${INDEXED_METADATA_MAGIC}u;
const INDEXED_METADATA_FOOTER_WORDS: u32 = ${INDEXED_METADATA_FOOTER_WORD_LENGTH}u;
const VALIDATION_RECORD_WORDS: u32 = ${VALIDATION_RECORD_WORD_LENGTH}u;

fn indexed_metadata_footer_base() -> u32 {
  return state.indexed_metadata_footer_base;
}

fn indexed_metadata_is_available() -> bool {
  return state.indexed_metadata_footer_base <= arrayLength(&schema_words) &&
    INDEXED_METADATA_FOOTER_WORDS <=
      arrayLength(&schema_words) - state.indexed_metadata_footer_base &&
    schema_words[indexed_metadata_footer_base()] == INDEXED_METADATA_MAGIC;
}

fn indexed_metadata_base(word: u32) -> u32 {
  return schema_words[indexed_metadata_footer_base() + word];
}

const TYPE_VARIABLE: u32 = 1u;
const TYPE_GENERIC: u32 = 2u;
const TYPE_RIGID: u32 = 3u;
const TYPE_INTEGER: u32 = 4u;
const TYPE_BOOLEAN: u32 = 5u;
const TYPE_UNIT: u32 = 6u;
const TYPE_TUPLE: u32 = 7u;
const TYPE_NAMED: u32 = 8u;
const TYPE_FUNCTION: u32 = 9u;
const TYPE_LIST: u32 = 10u;
const TYPE_NAMED_GENERIC: u32 = 11u;
const TYPE_FORALL: u32 = 12u;
const TYPE_SIGNED_INTEGER_64: u32 = 13u;
const TYPE_FLOAT_32: u32 = 14u;
const TYPE_FLOAT_64: u32 = 15u;
const TYPE_RECORD_WORDS: u32 = 5u;
const ENVIRONMENT_WORDS: u32 = 3u;
const FRAME_WORDS: u32 = 12u;
const REFINEMENT_WORDS: u32 = ${LAZULI_INFERENCE_REFINEMENT_WORD_LENGTH}u;

const FRAME_EXPRESSION: u32 = 0u;
const FRAME_PRUNE: u32 = 1u;
const FRAME_UNIFY: u32 = 2u;
const FRAME_OCCURS: u32 = 3u;
const FRAME_OCCURS_VISIT: u32 = 4u;
const FRAME_GENERALIZE: u32 = 5u;
const FRAME_GENERALIZE_VISIT: u32 = 6u;
const FRAME_INSTANTIATE: u32 = 7u;
const FRAME_INSTANTIATE_VISIT: u32 = 8u;
const FRAME_SCHEMA_CONVERT: u32 = 9u;
const FRAME_SCHEMA_VISIT: u32 = 10u;
const FRAME_MAPPING_LOOKUP: u32 = 11u;
const FRAME_CONSTRUCTOR: u32 = 12u;
const FRAME_LOCAL_LOOKUP: u32 = 13u;
const FRAME_CASE_BIND: u32 = 14u;
const FRAME_CASE_COVERAGE: u32 = 15u;
const FRAME_CONCRETE: u32 = 16u;
const FRAME_CONCRETE_VISIT: u32 = 17u;
const FRAME_SERIALIZE: u32 = 18u;
const FRAME_EPOCH_CLEAR: u32 = 19u;
const FRAME_FIND_TYPE: u32 = 20u;
const FRAME_SCHEMA_PARAMETER_CHECK: u32 = 21u;
const FRAME_FIELD_PARAMETER_RECOVERABILITY: u32 = 22u;
const FRAME_PATTERN_MATCH: u32 = 23u;
const FRAME_REFINEMENT_ROLLBACK: u32 = 24u;
const FRAME_FULLY_ZONKED: u32 = 25u;
const FRAME_FULLY_ZONKED_VISIT: u32 = 26u;
const FRAME_RIGIDIFY: u32 = 27u;
const FRAME_RIGIDIFY_VISIT: u32 = 28u;
const FRAME_INDEXED_SHAPE: u32 = 29u;
const FRAME_SUBSUME: u32 = 30u;
const FRAME_FORALL_SEARCH: u32 = 31u;
const FRAME_SCHEMA_OCCURRENCE: u32 = 32u;

fn type_kind_is_primitive(kind: u32) -> bool {
  return kind == TYPE_INTEGER || kind == TYPE_BOOLEAN || kind == TYPE_UNIT ||
    kind == TYPE_SIGNED_INTEGER_64 || kind == TYPE_FLOAT_32 || kind == TYPE_FLOAT_64;
}

const TAG_INTEGER: u32 = ${LazuliCoreTag.Integer}u;
const TAG_BOOLEAN: u32 = ${LazuliCoreTag.Boolean}u;
const TAG_LET: u32 = ${LazuliCoreTag.Let}u;
const TAG_IF: u32 = ${LazuliCoreTag.If}u;
const TAG_LAMBDA: u32 = ${LazuliCoreTag.Lambda}u;
const TAG_APPLY: u32 = ${LazuliCoreTag.Apply}u;
const TAG_UNARY: u32 = ${LazuliCoreTag.Unary}u;
const TAG_BINARY: u32 = ${LazuliCoreTag.Binary}u;
const BINARY_STRUCTURAL_EQUAL: u32 = ${LazuliBinaryOperator.StructuralEqual}u;
const BINARY_STRUCTURAL_NOT_EQUAL: u32 = ${LazuliBinaryOperator.StructuralNotEqual}u;
const BINARY_EQUAL_WHOLE_NUMBER_F64: u32 = ${LazuliBinaryOperator.EqualWholeNumberF64}u;
const BINARY_GREATER_EQUAL_WHOLE_NUMBER_F64: u32 = ${LazuliBinaryOperator.GreaterEqualWholeNumberF64}u;
const BINARY_REMAINDER_WHOLE_NUMBER_F64: u32 = ${LazuliBinaryOperator.RemainderWholeNumberF64}u;
const TAG_CASE: u32 = ${LazuliCoreTag.Case}u;
const TAG_CASE_ARM: u32 = ${LazuliCoreTag.CaseArm}u;
const TAG_PATTERN_BIND: u32 = ${LazuliCoreTag.PatternBind}u;
const TAG_LOCAL: u32 = ${LazuliCoreTag.Local}u;
const TAG_GLOBAL: u32 = ${LazuliCoreTag.Global}u;
const TAG_CONSTRUCTOR: u32 = ${LazuliCoreTag.Constructor}u;
const TAG_LET_REC: u32 = ${LazuliCoreTag.LetRec}u;
const TAG_SIGNED_INTEGER_64: u32 = ${LazuliCoreTag.SignedInteger64}u;
const TAG_FLOAT_32: u32 = ${LazuliCoreTag.Float32}u;
const TAG_FLOAT_64: u32 = ${LazuliCoreTag.Float64}u;
const TAG_NUMERIC_CONVERT: u32 = ${LazuliCoreTag.NumericConvert}u;
const TAG_TEXT: u32 = ${LazuliCoreTag.Text}u;
const TAG_BYTES: u32 = ${LazuliCoreTag.Bytes}u;
const TAG_RUNTIME_FAULT: u32 = ${LazuliCoreTag.RuntimeFault}u;
const TAG_WHOLE_NUMBER_F64: u32 = ${LazuliCoreTag.WholeNumberF64}u;
const TAG_BUFFER_APPEND: u32 = ${LazuliCoreTag.BufferAppend}u;

const OUTPUT_INTEGER: u32 = 1u;
const OUTPUT_BOOLEAN: u32 = 2u;
const OUTPUT_UNIT: u32 = 3u;
const OUTPUT_TUPLE: u32 = 5u;
const OUTPUT_NAMED: u32 = 6u;
const OUTPUT_FUNCTION: u32 = 7u;
const OUTPUT_SIGNED_INTEGER_64: u32 = 9u;
const OUTPUT_FLOAT_32: u32 = 10u;
const OUTPUT_FLOAT_64: u32 = 11u;

fn primitive_type_index_for_schema(tag: u32) -> u32 {
  if tag == SCHEMA_INTEGER { return 0u; }
  if tag == SCHEMA_BOOLEAN { return 1u; }
  if tag == SCHEMA_UNIT { return 2u; }
  if tag == SCHEMA_SIGNED_INTEGER_64 { return 3u; }
  if tag == SCHEMA_FLOAT_32 { return 4u; }
  if tag == SCHEMA_FLOAT_64 { return 5u; }
  return NO_INDEX;
}

fn numeric_type_index_for_operator(operation: u32) -> u32 {
  if operation <= 10u { return 0u; }
  if operation <= 20u { return 3u; }
  if operation <= 30u { return 4u; }
  if operation <= 40u { return 5u; }
  if operation <= 46u { return 0u; }
  return 3u;
}

fn numeric_type_index_for_unary(operation: u32) -> u32 {
  if operation == 1u { return 0u; }
  if operation == 2u { return 3u; }
  if operation == 4u { return 5u; }
  return 4u;
}

fn numeric_operator_is_comparison(operation: u32) -> bool {
  return (operation >= 1u && operation <= 40u && (operation - 1u) % 10u < 6u) ||
    (operation >= BINARY_EQUAL_WHOLE_NUMBER_F64 &&
      operation <= BINARY_GREATER_EQUAL_WHOLE_NUMBER_F64);
}

fn operator_is_structural_equality(operation: u32) -> bool {
  return operation == BINARY_STRUCTURAL_EQUAL || operation == BINARY_STRUCTURAL_NOT_EQUAL;
}

fn numeric_conversion_source(conversion: u32) -> u32 {
  switch conversion {
    case 1u, 3u, 4u: { return 0u; }
    case 2u, 5u, 6u: { return 3u; }
    case 7u, 8u, 9u, 13u: { return 4u; }
    case 14u: { return 0u; }
    default: { return 5u; }
  }
}

fn numeric_conversion_result(conversion: u32) -> u32 {
  switch conversion {
    case 2u, 7u, 10u, 13u: { return 0u; }
    case 1u, 8u, 11u: { return 3u; }
    case 3u, 5u, 12u, 14u: { return 4u; }
    default: { return 5u; }
  }
}

fn range_is_valid(base: u32, count: u32, length: u32) -> bool {
  return base <= length && count <= length - base;
}

fn fail(status: u32, code: u32, start_byte: u32, end_byte: u32, detail: u32) {
  state.status = status;
  state.error_code = code;
  state.error_start_byte = start_byte;
  state.error_end_byte = end_byte;
  state.error_detail = detail;
}

fn report_diagnostic(code: u32, start_byte: u32, end_byte: u32, detail: u32) {
  fail(STATUS_DIAGNOSTIC, code, start_byte, end_byte, detail);
}

fn report_diagnostic_with_operands(
  code: u32,
  start_byte: u32,
  end_byte: u32,
  detail: u32,
  operand0: u32,
  operand1: u32,
) {
  state.error_operand0 = operand0;
  state.error_operand1 = operand1;
  report_diagnostic(code, start_byte, end_byte, detail);
}

fn report_metadata_diagnostic(
  context: u32,
  start_byte: u32,
  end_byte: u32,
  detail: u32,
  operand0: u32,
  operand1: u32,
) {
  state.error_context = context;
  report_diagnostic_with_operands(
    ERROR_INVALID_TYPE_METADATA, start_byte, end_byte, detail, operand0, operand1);
}

fn exhausted(code: u32, detail: u32) {
  fail(STATUS_EXHAUSTED, code, 0u, 0u, detail);
}

fn invalid_input(code: u32, detail: u32) {
  fail(STATUS_INVALID_INPUT, code, 0u, 0u, detail);
}

fn schema_node(index: u32) -> SchemaNode {
  let base = state.schema_base + index * 6u;
  return SchemaNode(
    schema_words[base], schema_words[base + 1u], schema_words[base + 2u],
    schema_words[base + 3u], schema_words[base + 4u], schema_words[base + 5u],
  );
}

fn validation_schema_start(schema: SchemaNode) -> u32 {
  if schema.start_byte == NO_INDEX && schema.end_byte == NO_INDEX &&
    state.work_result < state.constructor_count {
    return constructor_record(state.work_result).start_byte;
  }
  return schema.start_byte;
}

fn validation_schema_end(schema: SchemaNode) -> u32 {
  if schema.start_byte == NO_INDEX && schema.end_byte == NO_INDEX &&
    state.work_result < state.constructor_count {
    return constructor_record(state.work_result).end_byte;
  }
  return schema.end_byte;
}

fn schema_table_word(base: u32, index: u32) -> u32 {
  return schema_words[base + index];
}

fn type_metadata(type_index: u32, word: u32) -> u32 {
  if word == 0u {
    return schema_words[state.type_parameter_offsets_base + type_index];
  }
  if word == 1u {
    return schema_words[state.type_parameter_offsets_base + type_index + 1u] -
      schema_words[state.type_parameter_offsets_base + type_index];
  }
  if word == 2u { return algebraic_type_record(type_index).first_constructor; }
  return algebraic_type_record(type_index).constructor_count;
}

fn constructor_metadata(constructor_index: u32, word: u32) -> u32 {
  if word == 0u { return schema_words[state.constructor_field_offsets_base + constructor_index]; }
  if word == 1u {
    return schema_words[state.constructor_field_offsets_base + constructor_index + 1u] -
      schema_words[state.constructor_field_offsets_base + constructor_index];
  }
  return schema_words[state.constructor_result_base + constructor_index];
}

fn constructor_result_is_explicit(constructor_index: u32) -> bool {
  let result = schema_node(constructor_metadata(constructor_index, 2u));
  return result.start_byte != NO_INDEX || result.end_byte != NO_INDEX;
}

fn scratch_index(vector: u32, index: u32) -> u32 {
  return state.scratch_base + vector * state.definition_count + index;
}

fn scratch_get(vector: u32, index: u32) -> u32 {
  return workspace[scratch_index(vector, index)];
}

fn scratch_set(vector: u32, index: u32, value: u32) {
  workspace[scratch_index(vector, index)] = value;
}

fn temporary_base() -> u32 {
  return state.scratch_base + state.definition_count * 8u;
}

fn temporary_capacity() -> u32 {
  return state.scratch_capacity - state.definition_count * 8u;
}

fn type_address(type_index: u32) -> u32 {
  return state.type_base + type_index * TYPE_RECORD_WORDS;
}

fn type_get(type_index: u32, word: u32) -> u32 {
  return workspace[type_address(type_index) + word];
}

fn type_set(type_index: u32, word: u32, value: u32) {
  workspace[type_address(type_index) + word] = value;
}

fn allocate_type(kind: u32, payload: u32, child0: u32, child1: u32) -> u32 {
  if state.type_top >= state.type_capacity {
    exhausted(ERROR_TYPE_ARENA_EXHAUSTED, state.type_top + 1u);
    return NO_INDEX;
  }
  let result = state.type_top;
  state.type_top += 1u;
  let address = type_address(result);
  workspace[address] = kind;
  workspace[address + 1u] = payload;
  workspace[address + 2u] = child0;
  workspace[address + 3u] = child1;
  workspace[address + 4u] = 0u;
  return result;
}

fn fresh_variable() -> u32 {
  return allocate_type(TYPE_VARIABLE, NO_INDEX, state.current_level, NO_INDEX);
}

fn require_frame_slots(count: u32) -> bool {
  if state.frame_top > state.frame_capacity || count > state.frame_capacity - state.frame_top {
    exhausted(ERROR_FRAME_ARENA_EXHAUSTED, state.frame_top + count);
    return false;
  }
  return true;
}

fn require_type_slots(count: u32) -> bool {
  if state.type_top > state.type_capacity || count > state.type_capacity - state.type_top {
    exhausted(ERROR_TYPE_ARENA_EXHAUSTED, state.type_top + count);
    return false;
  }
  return true;
}

fn require_environment_slots(count: u32) -> bool {
  if state.environment_top > state.environment_capacity ||
    count > state.environment_capacity - state.environment_top {
    exhausted(ERROR_ENVIRONMENT_ARENA_EXHAUSTED, state.environment_top + count);
    return false;
  }
  return true;
}

fn require_refinement_slots(count: u32) -> bool {
  if state.refinement_top > state.refinement_capacity ||
    count > state.refinement_capacity - state.refinement_top {
    exhausted(ERROR_REFINEMENT_ARENA_EXHAUSTED, state.refinement_top + count);
    return false;
  }
  return true;
}

fn refinement_address(index: u32) -> u32 {
  return state.refinement_base + index * REFINEMENT_WORDS;
}

fn refinement_get(index: u32, word: u32) -> u32 {
  return workspace[refinement_address(index) + word];
}

fn push_refinement(source: u32, refinement_target: u32) -> bool {
  if !require_refinement_slots(1u) { return false; }
  let address = refinement_address(state.refinement_top);
  workspace[address] = source;
  workspace[address + 1u] = type_get(source, 3u);
  type_set(source, 3u, refinement_target);
  state.refinement_top += 1u;
  return true;
}

fn start_refinement_rollback(checkpoint: u32) -> bool {
  let frame = push_work_frame(FRAME_REFINEMENT_ROLLBACK);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, checkpoint);
  return true;
}

fn clear_frame(index: u32, kind: u32) {
  let address = frame_address(index);
  var word = 0u;
  loop {
    if word >= FRAME_WORDS { break; }
    workspace[address + word] = NO_INDEX;
    word += 1u;
  }
  workspace[address + 10u] = kind;
}

fn push_work_frame(kind: u32) -> u32 {
  if !require_frame_slots(1u) { return NO_INDEX; }
  let result = state.frame_top;
  clear_frame(result, kind);
  state.frame_top += 1u;
  return result;
}

fn pop_work_frame() {
  state.frame_top -= 1u;
}

fn start_prune(type_index: u32) -> bool {
  let frame = push_work_frame(FRAME_PRUNE);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index);
  return true;
}

fn prune_transition(frame: u32) {
  let current = frame_get(frame, 0u);
  if type_get(current, 0u) == TYPE_VARIABLE && type_get(current, 1u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 1u));
    return;
  }
  if type_get(current, 0u) == TYPE_RIGID && type_get(current, 3u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 3u));
    return;
  }
  state.returned_type = current;
  pop_work_frame();
}

fn refinement_rollback_transition(frame: u32) {
  if state.refinement_top <= frame_get(frame, 0u) {
    pop_work_frame();
    return;
  }
  state.refinement_top -= 1u;
  let source = refinement_get(state.refinement_top, 0u);
  type_set(source, 3u, refinement_get(state.refinement_top, 1u));
}

fn epoch_clear_transition(frame: u32) {
  let cursor = frame_get(frame, 0u);
  if cursor < state.type_top {
    type_set(cursor, 4u, 0u);
    frame_set(frame, 0u, cursor + 1u);
    return;
  }
  state.traversal_epoch = 0u;
  pop_work_frame();
}

fn acquire_epoch(frame: u32, epoch_word: u32, next_stage: u32) -> bool {
  if state.traversal_epoch == NO_INDEX {
    let clear = push_work_frame(FRAME_EPOCH_CLEAR);
    if clear == NO_INDEX { return false; }
    frame_set(clear, 0u, 0u);
    return false;
  }
  state.traversal_epoch += 1u;
  frame_set(frame, epoch_word, state.traversal_epoch);
  frame_set(frame, 1u, next_stage);
  return true;
}

fn report_type_mismatch(left: u32, right: u32, start_byte: u32, end_byte: u32) {
  report_diagnostic_with_operands(
    ERROR_TYPE_MISMATCH,
    start_byte,
    end_byte,
    (type_get(left, 0u) << 16u) | type_get(right, 0u),
    left,
    right,
  );
}

fn configure_unify_frame(frame: u32, left: u32, right: u32, start_byte: u32, end_byte: u32) {
  frame_set(frame, 0u, left);
  frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, right);
  frame_set(frame, 3u, start_byte);
  frame_set(frame, 4u, end_byte);
  frame_set(frame, 7u, NO_INDEX);
  frame_set(frame, 10u, FRAME_UNIFY);
}

fn start_unify(expected: u32, received: u32, start_byte: u32, end_byte: u32) -> bool {
  let frame = push_work_frame(FRAME_UNIFY);
  if frame == NO_INDEX { return false; }
  configure_unify_frame(frame, expected, received, start_byte, end_byte);
  return true;
}

fn start_application_unify(
  callee: u32,
  expected_function: u32,
  fresh_result: u32,
  start_byte: u32,
  end_byte: u32,
) -> bool {
  // The result is allocated after callee and argument inference, so the older
  // callee graph cannot contain it and does not need an occurs traversal.
  let frame = push_work_frame(FRAME_UNIFY);
  if frame == NO_INDEX { return false; }
  configure_unify_frame(frame, callee, expected_function, start_byte, end_byte);
  frame_set(frame, 7u, fresh_result);
  return true;
}

fn start_occurs(variable: u32, candidate: u32) -> bool {
  let frame = push_work_frame(FRAME_OCCURS);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, variable);
  frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, candidate);
  frame_set(frame, 4u, type_get(variable, 2u));
  return true;
}

fn configure_occurs_visit(frame: u32, candidate: u32, variable: u32, level: u32, epoch: u32) {
  frame_set(frame, 0u, candidate);
  frame_set(frame, 1u, variable);
  frame_set(frame, 2u, level);
  frame_set(frame, 3u, epoch);
  frame_set(frame, 10u, FRAME_OCCURS_VISIT);
}

fn occurs_transition(frame: u32) {
  let stage = frame_get(frame, 1u);
  if stage == 0u {
    acquire_epoch(frame, 3u, 1u);
    return;
  }
  if stage == 1u {
    if !require_frame_slots(1u) { return; }
    state.work_result = 0u;
    let visit = push_work_frame(FRAME_OCCURS_VISIT);
    configure_occurs_visit(
      visit, frame_get(frame, 2u), frame_get(frame, 0u), frame_get(frame, 4u), frame_get(frame, 3u));
    frame_set(frame, 1u, 2u);
    return;
  }
  pop_work_frame();
}

fn occurs_visit_transition(frame: u32) {
  if state.work_result != 0u { pop_work_frame(); return; }
  let current = frame_get(frame, 0u);
  if type_get(current, 0u) == TYPE_VARIABLE && type_get(current, 1u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 1u));
    return;
  }
  if type_get(current, 0u) == TYPE_RIGID && type_get(current, 3u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 3u));
    return;
  }
  if current == frame_get(frame, 1u) {
    state.work_result = 1u;
    pop_work_frame();
    return;
  }
  let epoch = frame_get(frame, 3u);
  if type_get(current, 4u) == epoch { pop_work_frame(); return; }
  let kind = type_get(current, 0u);
  var first = NO_INDEX;
  var second = NO_INDEX;
  if kind == TYPE_TUPLE || kind == TYPE_FUNCTION {
    first = type_get(current, 2u); second = type_get(current, 3u);
  } else if kind == TYPE_NAMED {
    first = type_get(current, 2u);
  } else if kind == TYPE_LIST {
    first = type_get(current, 1u); second = type_get(current, 2u);
  }
  let child_count = select(0u, select(1u, 2u, second != NO_INDEX), first != NO_INDEX);
  if child_count == 2u && !require_frame_slots(1u) { return; }
  type_set(current, 4u, epoch);
  if kind == TYPE_VARIABLE && type_get(current, 2u) > frame_get(frame, 2u) {
    type_set(current, 2u, frame_get(frame, 2u));
  }
  if child_count == 0u { pop_work_frame(); return; }
  configure_occurs_visit(
    frame, first, frame_get(frame, 1u), frame_get(frame, 2u), epoch);
  if child_count == 2u {
    let sibling = push_work_frame(FRAME_OCCURS_VISIT);
    configure_occurs_visit(
      sibling, second, frame_get(frame, 1u), frame_get(frame, 2u), epoch);
  }
}

fn unify_transition(frame: u32) {
  let stage = frame_get(frame, 1u);
  if stage == 0u {
    if !start_prune(frame_get(frame, 0u)) { return; }
    frame_set(frame, 1u, 1u);
    return;
  }
  if stage == 1u {
    frame_set(frame, 5u, state.returned_type);
    if !start_prune(frame_get(frame, 2u)) { return; }
    frame_set(frame, 1u, 2u);
    return;
  }
  if stage == 3u || stage == 4u {
    if state.work_result != 0u {
      let variable = select(frame_get(frame, 6u), frame_get(frame, 5u), stage == 3u);
      let candidate = select(frame_get(frame, 5u), frame_get(frame, 6u), stage == 3u);
      report_diagnostic_with_operands(
        ERROR_INFINITE_TYPE, frame_get(frame, 3u), frame_get(frame, 4u),
        variable, variable, candidate);
      return;
    }
    if stage == 3u { type_set(frame_get(frame, 5u), 1u, frame_get(frame, 6u)); }
    else { type_set(frame_get(frame, 6u), 1u, frame_get(frame, 5u)); }
    pop_work_frame();
    return;
  }
  let left = frame_get(frame, 5u);
  let right = state.returned_type;
  frame_set(frame, 6u, right);
  if left == right { pop_work_frame(); return; }
  let left_kind = type_get(left, 0u);
  let right_kind = type_get(right, 0u);
  if left_kind == TYPE_VARIABLE {
    if state.untouchable_type_cutoff != NO_INDEX && left < state.untouchable_type_cutoff {
      report_metadata_diagnostic(
        METADATA_UNTOUCHABLE_INDEXED_VARIABLE,
        frame_get(frame, 3u), frame_get(frame, 4u), left, left, right);
      return;
    }
    if !start_occurs(left, right) { return; }
    frame_set(frame, 1u, 3u);
    return;
  }
  if right_kind == TYPE_VARIABLE {
    if state.untouchable_type_cutoff != NO_INDEX && right < state.untouchable_type_cutoff {
      report_metadata_diagnostic(
        METADATA_UNTOUCHABLE_INDEXED_VARIABLE,
        frame_get(frame, 3u), frame_get(frame, 4u), right, right, left);
      return;
    }
    if right == frame_get(frame, 7u) {
      type_set(right, 1u, left);
      pop_work_frame();
      return;
    }
    if !start_occurs(right, left) { return; }
    frame_set(frame, 1u, 4u);
    return;
  }
  if left_kind != right_kind || left_kind == TYPE_RIGID || left_kind == TYPE_GENERIC ||
    left_kind == TYPE_NAMED_GENERIC {
    report_type_mismatch(left, right, frame_get(frame, 3u), frame_get(frame, 4u));
    return;
  }
  if left_kind == TYPE_INTEGER || left_kind == TYPE_BOOLEAN || left_kind == TYPE_UNIT ||
    left_kind == TYPE_SIGNED_INTEGER_64 || left_kind == TYPE_FLOAT_32 ||
    left_kind == TYPE_FLOAT_64 {
    pop_work_frame();
    return;
  }
  var left_first = NO_INDEX;
  var right_first = NO_INDEX;
  var left_second = NO_INDEX;
  var right_second = NO_INDEX;
  if left_kind == TYPE_TUPLE || left_kind == TYPE_FUNCTION {
    left_first = type_get(left, 2u); right_first = type_get(right, 2u);
    left_second = type_get(left, 3u); right_second = type_get(right, 3u);
  } else if left_kind == TYPE_NAMED {
    if type_get(left, 1u) != type_get(right, 1u) {
      report_type_mismatch(left, right, frame_get(frame, 3u), frame_get(frame, 4u)); return;
    }
    left_first = type_get(left, 2u); right_first = type_get(right, 2u);
  } else if left_kind == TYPE_LIST {
    left_first = type_get(left, 1u); right_first = type_get(right, 1u);
    left_second = type_get(left, 2u); right_second = type_get(right, 2u);
  } else {
    report_type_mismatch(left, right, frame_get(frame, 3u), frame_get(frame, 4u)); return;
  }
  if (left_first == NO_INDEX) != (right_first == NO_INDEX) ||
    (left_second == NO_INDEX) != (right_second == NO_INDEX) {
    report_type_mismatch(left, right, frame_get(frame, 3u), frame_get(frame, 4u)); return;
  }
  if left_first == NO_INDEX { pop_work_frame(); return; }
  if left_second != NO_INDEX && !require_frame_slots(1u) { return; }
  let start_byte = frame_get(frame, 3u);
  let end_byte = frame_get(frame, 4u);
  let fresh_application_result = frame_get(frame, 7u);
  if left_second == NO_INDEX {
    configure_unify_frame(frame, left_first, right_first, start_byte, end_byte);
    frame_set(frame, 7u, fresh_application_result);
  } else {
    configure_unify_frame(frame, left_second, right_second, start_byte, end_byte);
    frame_set(frame, 7u, fresh_application_result);
    let first = push_work_frame(FRAME_UNIFY);
    configure_unify_frame(first, left_first, right_first, start_byte, end_byte);
    frame_set(first, 7u, fresh_application_result);
  }
}

fn start_generalize(type_index: u32, cutoff_level: u32) -> bool {
  let frame = push_work_frame(FRAME_GENERALIZE);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index);
  frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, cutoff_level);
  return true;
}

fn configure_generalize_visit(frame: u32, source: u32, cutoff: u32, epoch: u32) {
  frame_set(frame, 0u, source); frame_set(frame, 2u, cutoff); frame_set(frame, 3u, epoch);
  frame_set(frame, 10u, FRAME_GENERALIZE_VISIT);
}

fn generalize_transition(frame: u32) {
  if frame_get(frame, 1u) == 0u {
    if !acquire_epoch(frame, 3u, 1u) { return; }
  }
  configure_generalize_visit(frame, frame_get(frame, 0u), frame_get(frame, 2u), frame_get(frame, 3u));
}

fn generalize_visit_transition(frame: u32) {
  let current = frame_get(frame, 0u);
  if type_get(current, 0u) == TYPE_VARIABLE && type_get(current, 1u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 1u)); return;
  }
  if type_get(current, 0u) == TYPE_RIGID && type_get(current, 3u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 3u)); return;
  }
  let epoch = frame_get(frame, 3u);
  if type_get(current, 4u) == epoch { pop_work_frame(); return; }
  let kind = type_get(current, 0u);
  var first = NO_INDEX; var second = NO_INDEX;
  if kind == TYPE_TUPLE || kind == TYPE_FUNCTION {
    first = type_get(current, 2u); second = type_get(current, 3u);
  } else if kind == TYPE_NAMED { first = type_get(current, 2u); }
  else if kind == TYPE_LIST { first = type_get(current, 1u); second = type_get(current, 2u); }
  if first != NO_INDEX && second != NO_INDEX && !require_frame_slots(1u) { return; }
  type_set(current, 4u, epoch);
  let cutoff = frame_get(frame, 2u);
  if kind == TYPE_VARIABLE && type_get(current, 2u) > cutoff {
    type_set(current, 0u, TYPE_GENERIC); type_set(current, 1u, state.next_generic);
    type_set(current, 2u, NO_INDEX); type_set(current, 3u, NO_INDEX);
    state.next_generic += 1u;
  } else if kind == TYPE_RIGID && type_get(current, 2u) > cutoff {
    type_set(current, 0u, TYPE_NAMED_GENERIC); type_set(current, 2u, NO_INDEX);
    type_set(current, 3u, NO_INDEX); state.next_generic += 1u;
  }
  if first == NO_INDEX { pop_work_frame(); return; }
  configure_generalize_visit(frame, first, cutoff, epoch);
  if second != NO_INDEX {
    let sibling = push_work_frame(FRAME_GENERALIZE_VISIT);
    configure_generalize_visit(sibling, second, cutoff, epoch);
  }
}

fn assign_type_field(parent: u32, field: u32, value: u32) {
  if field == 1u { type_set(parent, 1u, value); }
  else if field == 2u { type_set(parent, 2u, value); }
  else { type_set(parent, 3u, value); }
}

fn start_instantiate_mode(source: u32, mode: u32) -> bool {
  let frame = push_work_frame(FRAME_INSTANTIATE);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, source); frame_set(frame, 1u, 0u);
  frame_set(frame, 4u, mode); frame_set(frame, 5u, 1u);
  state.work_result = 0u;
  return true;
}

fn start_instantiate(source: u32) -> bool {
  return start_instantiate_mode(source, 0u);
}

fn configure_instantiate_visit(
  frame: u32, source: u32, parent: u32, field: u32, epoch: u32,
  mode: u32, open_forall: u32,
) {
  frame_set(frame, 0u, source); frame_set(frame, 1u, parent); frame_set(frame, 2u, field);
  frame_set(frame, 3u, epoch); frame_set(frame, 4u, mode); frame_set(frame, 5u, open_forall);
  frame_set(frame, 10u, FRAME_INSTANTIATE_VISIT);
}

fn instantiate_transition(frame: u32) {
  if frame_get(frame, 1u) == 0u {
    if !acquire_epoch(frame, 3u, 1u) { return; }
  }
  configure_instantiate_visit(
    frame, frame_get(frame, 0u), NO_INDEX, 0u, frame_get(frame, 3u),
    frame_get(frame, 4u), frame_get(frame, 5u));
}

fn attach_instantiated(parent: u32, field: u32, replacement: u32) {
  if parent == NO_INDEX { state.returned_type = replacement; }
  else { assign_type_field(parent, field, replacement); }
}

fn instantiate_visit_transition(frame: u32) {
  let current = frame_get(frame, 0u);
  if type_get(current, 0u) == TYPE_VARIABLE && type_get(current, 1u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 1u)); return;
  }
  if type_get(current, 0u) == TYPE_RIGID && type_get(current, 3u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 3u)); return;
  }
  let parent = frame_get(frame, 1u); let field = frame_get(frame, 2u);
  let epoch = frame_get(frame, 3u); let kind = type_get(current, 0u);
  if kind == TYPE_FORALL {
    state.work_result = 1u;
    if frame_get(frame, 5u) == 0u {
      attach_instantiated(parent, field, current); pop_work_frame(); return;
    }
    configure_instantiate_visit(
      frame, type_get(current, 2u), parent, field, epoch,
      frame_get(frame, 4u), 1u);
    return;
  }
  if kind == TYPE_GENERIC || kind == TYPE_NAMED_GENERIC {
    if type_get(current, 2u) == epoch {
      attach_instantiated(parent, field, type_get(current, 3u)); pop_work_frame(); return;
    }
    if !require_type_slots(1u) { return; }
    var replacement = NO_INDEX;
    if frame_get(frame, 4u) == 1u {
      replacement = allocate_type(TYPE_RIGID, state.next_generic, state.current_level, NO_INDEX);
      state.next_generic += 1u;
    } else {
      replacement = fresh_variable();
    }
    type_set(current, 2u, epoch); type_set(current, 3u, replacement);
    state.work_result = 1u;
    attach_instantiated(parent, field, replacement); pop_work_frame(); return;
  }
  var first = NO_INDEX; var second = NO_INDEX; var first_field = 0u; var second_field = 0u;
  var replacement = current;
  if kind == TYPE_TUPLE || kind == TYPE_FUNCTION {
    first = type_get(current, 2u); second = type_get(current, 3u);
    first_field = 2u; second_field = 3u;
  } else if kind == TYPE_NAMED {
    first = type_get(current, 2u); first_field = 2u;
  } else if kind == TYPE_LIST {
    first = type_get(current, 1u); second = type_get(current, 2u);
    first_field = 1u; second_field = 2u;
  } else {
    attach_instantiated(parent, field, current); pop_work_frame(); return;
  }
  if !require_type_slots(1u) { return; }
  if first != NO_INDEX && second != NO_INDEX && !require_frame_slots(1u) { return; }
  replacement = allocate_type(kind, type_get(current, 1u), NO_INDEX, NO_INDEX);
  if kind == TYPE_LIST { type_set(replacement, 1u, NO_INDEX); }
  attach_instantiated(parent, field, replacement);
  if first == NO_INDEX { pop_work_frame(); return; }
  configure_instantiate_visit(
    frame, first, replacement, first_field, epoch, frame_get(frame, 4u), 0u);
  if second != NO_INDEX {
    let sibling = push_work_frame(FRAME_INSTANTIATE_VISIT);
    configure_instantiate_visit(
      sibling, second, replacement, second_field, epoch, frame_get(frame, 4u), 0u);
  }
}

fn configure_subsume_frame(
  frame: u32, actual: u32, expected: u32, start_byte: u32, end_byte: u32,
) {
  frame_set(frame, 0u, actual); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, expected); frame_set(frame, 3u, start_byte);
  frame_set(frame, 4u, end_byte); frame_set(frame, 10u, FRAME_SUBSUME);
}

fn start_subsume(actual: u32, expected: u32, start_byte: u32, end_byte: u32) -> bool {
  let frame = push_work_frame(FRAME_SUBSUME);
  if frame == NO_INDEX { return false; }
  configure_subsume_frame(frame, actual, expected, start_byte, end_byte);
  return true;
}

fn subsume_transition(frame: u32) {
  let stage = frame_get(frame, 1u);
  if stage == 0u {
    if start_instantiate(frame_get(frame, 0u)) { frame_set(frame, 1u, 1u); }
    return;
  }
  if stage == 1u {
    frame_set(frame, 5u, state.returned_type);
    frame_set(frame, 6u, state.work_result);
    if start_prune(frame_get(frame, 2u)) { frame_set(frame, 1u, 2u); }
    return;
  }
  if stage == 2u {
    frame_set(frame, 7u, state.returned_type);
    if type_get(state.returned_type, 0u) != TYPE_FORALL {
      frame_set(frame, 1u, 4u);
      return;
    }
    if frame_get(frame, 6u) == 0u {
      report_type_mismatch(
        frame_get(frame, 0u), frame_get(frame, 2u),
        frame_get(frame, 3u), frame_get(frame, 4u));
      return;
    }
    if start_instantiate_mode(state.returned_type, 1u) {
      frame_set(frame, 1u, 3u);
    }
    return;
  }
  if stage == 3u {
    frame_set(frame, 7u, state.returned_type);
    frame_set(frame, 1u, 4u);
    return;
  }
  if stage == 5u { pop_work_frame(); return; }

  let actual = frame_get(frame, 5u);
  let expected = frame_get(frame, 7u);
  let actual_kind = type_get(actual, 0u);
  let expected_kind = type_get(expected, 0u);
  if expected_kind == TYPE_FUNCTION && actual_kind != TYPE_FUNCTION {
    report_type_mismatch(actual, expected, frame_get(frame, 3u), frame_get(frame, 4u));
    return;
  }
  if actual_kind != TYPE_FUNCTION || expected_kind != TYPE_FUNCTION {
    if start_unify(actual, expected, frame_get(frame, 3u), frame_get(frame, 4u)) {
      frame_set(frame, 1u, 5u);
    }
    return;
  }
  if !require_frame_slots(1u) { return; }
  let start_byte = frame_get(frame, 3u);
  let end_byte = frame_get(frame, 4u);
  configure_subsume_frame(
    frame, type_get(actual, 3u), type_get(expected, 3u), start_byte, end_byte);
  let parameter = push_work_frame(FRAME_SUBSUME);
  configure_subsume_frame(
    parameter, type_get(expected, 2u), type_get(actual, 2u), start_byte, end_byte);
}

fn start_forall_search(type_index: u32) -> bool {
  let frame = push_work_frame(FRAME_FORALL_SEARCH);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index);
  state.work_result = 0u;
  return true;
}

fn configure_forall_search(frame: u32, type_index: u32) {
  frame_set(frame, 0u, type_index);
  frame_set(frame, 10u, FRAME_FORALL_SEARCH);
}

fn forall_search_transition(frame: u32) {
  if state.work_result != 0u { pop_work_frame(); return; }
  let current = frame_get(frame, 0u);
  if type_get(current, 0u) == TYPE_VARIABLE && type_get(current, 1u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 1u));
    return;
  }
  let kind = type_get(current, 0u);
  if kind == TYPE_FORALL {
    state.work_result = 1u;
    pop_work_frame();
    return;
  }
  if kind != TYPE_FUNCTION {
    pop_work_frame();
    return;
  }
  if !require_frame_slots(1u) { return; }
  configure_forall_search(frame, type_get(current, 2u));
  let result = push_work_frame(FRAME_FORALL_SEARCH);
  configure_forall_search(result, type_get(current, 3u));
}

fn start_local_lookup(depth: u32, environment: u32, node_index: u32) -> bool {
  let frame = push_work_frame(FRAME_LOCAL_LOOKUP);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, depth); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, environment); frame_set(frame, 3u, node_index);
  frame_set(frame, 4u, 0u);
  return true;
}

fn start_local_scheme_lookup(depth: u32, environment: u32, node_index: u32) -> bool {
  let frame = push_work_frame(FRAME_LOCAL_LOOKUP);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, depth); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, environment); frame_set(frame, 3u, node_index);
  frame_set(frame, 4u, 1u);
  return true;
}

fn local_lookup_transition(frame: u32) {
  if frame_get(frame, 1u) == 1u { pop_work_frame(); return; }
  let entry = frame_get(frame, 2u);
  if entry == NO_INDEX {
    invalid_input(ERROR_INVALID_SURFACE, frame_get(frame, 3u));
    return;
  }
  let address = environment_address(entry);
  let remaining = frame_get(frame, 0u);
  if remaining > 0u {
    frame_set(frame, 0u, remaining - 1u);
    frame_set(frame, 2u, workspace[address + 1u]);
    return;
  }
  if frame_get(frame, 4u) != 0u {
    state.returned_type = workspace[address];
    pop_work_frame();
    return;
  }
  let scheme = workspace[address];
  if type_kind_is_primitive(type_get(scheme, 0u)) {
    state.returned_type = scheme;
    pop_work_frame();
    return;
  }
  if !start_instantiate(scheme) { return; }
  frame_set(frame, 1u, 1u);
}

fn start_concrete(type_index: u32) -> bool {
  let frame = push_work_frame(FRAME_CONCRETE);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index); frame_set(frame, 1u, 0u); frame_set(frame, 2u, 0u);
  return true;
}

fn start_stable_concrete(type_index: u32) -> bool {
  let frame = push_work_frame(FRAME_CONCRETE);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index); frame_set(frame, 1u, 0u); frame_set(frame, 2u, 1u);
  return true;
}

fn configure_concrete_visit(frame: u32, source: u32, mode: u32, epoch: u32) {
  frame_set(frame, 0u, source); frame_set(frame, 2u, mode); frame_set(frame, 3u, epoch);
  frame_set(frame, 10u, FRAME_CONCRETE_VISIT);
}

fn concrete_transition(frame: u32) {
  if frame_get(frame, 1u) == 0u {
    if !acquire_epoch(frame, 3u, 1u) { return; }
  }
  state.work_result = 1u;
  configure_concrete_visit(
    frame, frame_get(frame, 0u), frame_get(frame, 2u), frame_get(frame, 3u));
}

fn concrete_visit_transition(frame: u32) {
  if state.work_result == 0u { pop_work_frame(); return; }
  let current = frame_get(frame, 0u);
  if type_get(current, 0u) == TYPE_VARIABLE && type_get(current, 1u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 1u)); return;
  }
  if frame_get(frame, 2u) == 0u && type_get(current, 0u) == TYPE_RIGID &&
    type_get(current, 3u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 3u)); return;
  }
  let epoch = frame_get(frame, 3u);
  if type_get(current, 4u) == epoch { pop_work_frame(); return; }
  let kind = type_get(current, 0u);
  if kind == TYPE_VARIABLE || kind == TYPE_GENERIC || kind == TYPE_RIGID ||
    kind == TYPE_NAMED_GENERIC || kind == TYPE_FORALL {
    state.work_result = 0u; pop_work_frame(); return;
  }
  var first = NO_INDEX; var second = NO_INDEX;
  if kind == TYPE_TUPLE || kind == TYPE_FUNCTION {
    first = type_get(current, 2u); second = type_get(current, 3u);
  } else if kind == TYPE_NAMED { first = type_get(current, 2u); }
  else if kind == TYPE_LIST { first = type_get(current, 1u); second = type_get(current, 2u); }
  if first != NO_INDEX && second != NO_INDEX && !require_frame_slots(1u) { return; }
  type_set(current, 4u, epoch);
  if first == NO_INDEX { pop_work_frame(); return; }
  configure_concrete_visit(frame, first, frame_get(frame, 2u), epoch);
  if second != NO_INDEX {
    let sibling = push_work_frame(FRAME_CONCRETE_VISIT);
    configure_concrete_visit(sibling, second, frame_get(frame, 2u), epoch);
  }
}

fn configure_pattern_match(frame: u32, left: u32, right: u32) {
  frame_set(frame, 0u, left);
  frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, right);
  frame_set(frame, 10u, FRAME_PATTERN_MATCH);
}

fn start_pattern_match(left: u32, right: u32) -> bool {
  let frame = push_work_frame(FRAME_PATTERN_MATCH);
  if frame == NO_INDEX { return false; }
  state.work_result = 0u;
  configure_pattern_match(frame, left, right);
  return true;
}

fn pattern_mismatch() {
  state.work_result = 1u;
  pop_work_frame();
}

fn pattern_match_transition(frame: u32) {
  if state.work_result != 0u { pop_work_frame(); return; }
  let stage = frame_get(frame, 1u);
  if stage == 0u {
    if start_prune(frame_get(frame, 0u)) { frame_set(frame, 1u, 1u); }
    return;
  }
  if stage == 1u {
    frame_set(frame, 5u, state.returned_type);
    if start_prune(frame_get(frame, 2u)) { frame_set(frame, 1u, 2u); }
    return;
  }
  if stage == 3u {
    if state.work_result != 0u { pattern_mismatch(); return; }
    if push_refinement(frame_get(frame, 6u), frame_get(frame, 7u)) {
      pop_work_frame();
    }
    return;
  }

  let left = frame_get(frame, 5u);
  let right = state.returned_type;
  if left == right { pop_work_frame(); return; }
  let left_kind = type_get(left, 0u);
  let right_kind = type_get(right, 0u);
  if left_kind == TYPE_VARIABLE || right_kind == TYPE_VARIABLE ||
    left_kind == TYPE_GENERIC || right_kind == TYPE_GENERIC ||
    left_kind == TYPE_NAMED_GENERIC || right_kind == TYPE_NAMED_GENERIC {
    pattern_mismatch();
    return;
  }
  if left_kind == TYPE_RIGID || right_kind == TYPE_RIGID {
    var source = left;
    var refinement_target = right;
    if left_kind == TYPE_RIGID && right_kind == TYPE_RIGID {
      source = max(left, right);
      refinement_target = min(left, right);
      if push_refinement(source, refinement_target) { pop_work_frame(); }
      return;
    }
    if right_kind == TYPE_RIGID {
      source = right;
      refinement_target = left;
    }
    if !start_occurs(source, refinement_target) { return; }
    frame_set(frame, 6u, source);
    frame_set(frame, 7u, refinement_target);
    frame_set(frame, 1u, 3u);
    return;
  }
  if left_kind != right_kind {
    pattern_mismatch();
    return;
  }
  if left_kind == TYPE_INTEGER || left_kind == TYPE_BOOLEAN || left_kind == TYPE_UNIT ||
    left_kind == TYPE_SIGNED_INTEGER_64 || left_kind == TYPE_FLOAT_32 ||
    left_kind == TYPE_FLOAT_64 {
    pop_work_frame();
    return;
  }

  var left_first = NO_INDEX;
  var right_first = NO_INDEX;
  var left_second = NO_INDEX;
  var right_second = NO_INDEX;
  if left_kind == TYPE_TUPLE || left_kind == TYPE_FUNCTION {
    left_first = type_get(left, 2u); right_first = type_get(right, 2u);
    left_second = type_get(left, 3u); right_second = type_get(right, 3u);
  } else if left_kind == TYPE_NAMED {
    if type_get(left, 1u) != type_get(right, 1u) { pattern_mismatch(); return; }
    left_first = type_get(left, 2u); right_first = type_get(right, 2u);
  } else if left_kind == TYPE_LIST {
    left_first = type_get(left, 1u); right_first = type_get(right, 1u);
    left_second = type_get(left, 2u); right_second = type_get(right, 2u);
  } else {
    pattern_mismatch();
    return;
  }
  if (left_first == NO_INDEX) != (right_first == NO_INDEX) ||
    (left_second == NO_INDEX) != (right_second == NO_INDEX) {
    pattern_mismatch();
    return;
  }
  if left_first == NO_INDEX { pop_work_frame(); return; }
  if left_second != NO_INDEX && !require_frame_slots(1u) { return; }
  if left_second == NO_INDEX {
    configure_pattern_match(frame, left_first, right_first);
    return;
  }
  configure_pattern_match(frame, left_second, right_second);
  let first = push_work_frame(FRAME_PATTERN_MATCH);
  configure_pattern_match(first, left_first, right_first);
}

fn start_fully_zonked(type_index: u32) -> bool {
  let frame = push_work_frame(FRAME_FULLY_ZONKED);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index);
  frame_set(frame, 1u, 0u);
  return true;
}

fn configure_fully_zonked_visit(frame: u32, type_index: u32, epoch: u32) {
  frame_set(frame, 0u, type_index);
  frame_set(frame, 3u, epoch);
  frame_set(frame, 10u, FRAME_FULLY_ZONKED_VISIT);
}

fn fully_zonked_transition(frame: u32) {
  if frame_get(frame, 1u) == 0u {
    if !acquire_epoch(frame, 3u, 1u) { return; }
  }
  state.work_result = 0u;
  configure_fully_zonked_visit(frame, frame_get(frame, 0u), frame_get(frame, 3u));
}

fn fully_zonked_visit_transition(frame: u32) {
  if state.work_result != 0u { pop_work_frame(); return; }
  let current = frame_get(frame, 0u);
  if type_get(current, 0u) == TYPE_VARIABLE && type_get(current, 1u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 1u)); return;
  }
  if type_get(current, 0u) == TYPE_RIGID && type_get(current, 3u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 3u)); return;
  }
  let epoch = frame_get(frame, 3u);
  if type_get(current, 4u) == epoch { pop_work_frame(); return; }
  let kind = type_get(current, 0u);
  if kind == TYPE_VARIABLE || kind == TYPE_GENERIC || kind == TYPE_NAMED_GENERIC {
    state.work_result = 1u;
    state.returned_type = current;
    pop_work_frame();
    return;
  }
  var first = NO_INDEX;
  var second = NO_INDEX;
  if kind == TYPE_TUPLE || kind == TYPE_FUNCTION {
    first = type_get(current, 2u); second = type_get(current, 3u);
  } else if kind == TYPE_NAMED {
    first = type_get(current, 2u);
  } else if kind == TYPE_LIST {
    first = type_get(current, 1u); second = type_get(current, 2u);
  }
  if first != NO_INDEX && second != NO_INDEX && !require_frame_slots(1u) { return; }
  type_set(current, 4u, epoch);
  if first == NO_INDEX { pop_work_frame(); return; }
  configure_fully_zonked_visit(frame, first, epoch);
  if second != NO_INDEX {
    let sibling = push_work_frame(FRAME_FULLY_ZONKED_VISIT);
    configure_fully_zonked_visit(sibling, second, epoch);
  }
}

fn start_rigidify(type_index: u32, identifier: u32) -> bool {
  let frame = push_work_frame(FRAME_RIGIDIFY);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, identifier);
  return true;
}

fn configure_rigidify_visit(frame: u32, type_index: u32, identifier: u32, epoch: u32) {
  frame_set(frame, 0u, type_index); frame_set(frame, 2u, identifier);
  frame_set(frame, 3u, epoch); frame_set(frame, 10u, FRAME_RIGIDIFY_VISIT);
}

fn rigidify_transition(frame: u32) {
  if frame_get(frame, 1u) == 0u {
    if !acquire_epoch(frame, 3u, 1u) { return; }
  }
  configure_rigidify_visit(
    frame, frame_get(frame, 0u), frame_get(frame, 2u), frame_get(frame, 3u));
}

fn rigidify_visit_transition(frame: u32) {
  let current = frame_get(frame, 0u);
  let kind = type_get(current, 0u);
  if kind == TYPE_VARIABLE && type_get(current, 1u) != NO_INDEX {
    frame_set(frame, 0u, type_get(current, 1u)); return;
  }
  if kind == TYPE_VARIABLE {
    type_set(current, 0u, TYPE_RIGID);
    type_set(current, 1u, frame_get(frame, 2u));
    type_set(current, 3u, NO_INDEX);
    pop_work_frame();
    return;
  }
  let epoch = frame_get(frame, 3u);
  if type_get(current, 4u) == epoch { pop_work_frame(); return; }
  var first = NO_INDEX;
  var second = NO_INDEX;
  if kind == TYPE_TUPLE || kind == TYPE_FUNCTION {
    first = type_get(current, 2u); second = type_get(current, 3u);
  } else if kind == TYPE_NAMED {
    first = type_get(current, 2u);
  } else if kind == TYPE_LIST {
    first = type_get(current, 1u); second = type_get(current, 2u);
  }
  if first != NO_INDEX && second != NO_INDEX && !require_frame_slots(1u) { return; }
  type_set(current, 4u, epoch);
  if first == NO_INDEX { pop_work_frame(); return; }
  configure_rigidify_visit(frame, first, frame_get(frame, 2u), epoch);
  if second != NO_INDEX {
    let sibling = push_work_frame(FRAME_RIGIDIFY_VISIT);
    configure_rigidify_visit(sibling, second, frame_get(frame, 2u), epoch);
  }
}

fn start_indexed_shape(type_index: u32) -> bool {
  let frame = push_work_frame(FRAME_INDEXED_SHAPE);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, 0u); frame_set(frame, 3u, NO_INDEX); frame_set(frame, 4u, NO_INDEX);
  return true;
}

fn indexed_shape_transition(frame: u32) {
  let stage = frame_get(frame, 1u);
  if stage == 0u {
    if !require_type_slots(1u) { return; }
    frame_set(frame, 3u, allocate_type(TYPE_NAMED, frame_get(frame, 0u), NO_INDEX, NO_INDEX));
    frame_set(frame, 1u, 1u);
    return;
  }
  let cursor = frame_get(frame, 2u);
  let type_index = frame_get(frame, 0u);
  if stage == 1u {
    if cursor >= type_metadata(type_index, 1u) {
      state.returned_type = frame_get(frame, 3u);
      pop_work_frame();
      return;
    }
    if !require_type_slots(1u) { return; }
    let list = allocate_type(TYPE_LIST, NO_INDEX, NO_INDEX, NO_INDEX);
    let tail = frame_get(frame, 4u);
    if tail == NO_INDEX { type_set(frame_get(frame, 3u), 2u, list); }
    else { type_set(tail, 2u, list); }
    frame_set(frame, 4u, list);
    frame_set(frame, 1u, 2u);
    return;
  }
  if !require_type_slots(1u) { return; }
  let first_parameter = type_metadata(type_index, 0u);
  let identifier = schema_words[state.type_parameter_base + first_parameter + cursor];
  let parameter = allocate_type(TYPE_RIGID, identifier, state.current_level, NO_INDEX);
  type_set(frame_get(frame, 4u), 1u, parameter);
  frame_set(frame, 2u, cursor + 1u);
  frame_set(frame, 1u, 1u);
}

fn work_transition() {
  let frame = state.frame_top - 1u;
  let kind = frame_get(frame, 10u);
  if kind == FRAME_PRUNE { prune_transition(frame); }
  else if kind == FRAME_UNIFY { unify_transition(frame); }
  else if kind == FRAME_OCCURS { occurs_transition(frame); }
  else if kind == FRAME_OCCURS_VISIT { occurs_visit_transition(frame); }
  else if kind == FRAME_GENERALIZE { generalize_transition(frame); }
  else if kind == FRAME_GENERALIZE_VISIT { generalize_visit_transition(frame); }
  else if kind == FRAME_INSTANTIATE { instantiate_transition(frame); }
  else if kind == FRAME_INSTANTIATE_VISIT { instantiate_visit_transition(frame); }
  else if kind == FRAME_SCHEMA_CONVERT { schema_convert_transition(frame); }
  else if kind == FRAME_SCHEMA_VISIT { schema_visit_transition(frame); }
  else if kind == FRAME_MAPPING_LOOKUP { mapping_lookup_transition(frame); }
  else if kind == FRAME_CONSTRUCTOR { constructor_transition(frame); }
  else if kind == FRAME_LOCAL_LOOKUP { local_lookup_transition(frame); }
  else if kind == FRAME_CASE_BIND { case_bind_transition(frame); }
  else if kind == FRAME_CASE_COVERAGE { case_coverage_transition(frame); }
  else if kind == FRAME_CONCRETE { concrete_transition(frame); }
  else if kind == FRAME_CONCRETE_VISIT { concrete_visit_transition(frame); }
  else if kind == FRAME_EPOCH_CLEAR { epoch_clear_transition(frame); }
  else if kind == FRAME_FIND_TYPE { find_type_transition(frame); }
  else if kind == FRAME_SCHEMA_PARAMETER_CHECK { schema_parameter_check_transition(frame); }
  else if kind == FRAME_FIELD_PARAMETER_RECOVERABILITY {
    field_parameter_recoverability_transition(frame);
  }
  else if kind == FRAME_PATTERN_MATCH { pattern_match_transition(frame); }
  else if kind == FRAME_REFINEMENT_ROLLBACK { refinement_rollback_transition(frame); }
  else if kind == FRAME_FULLY_ZONKED { fully_zonked_transition(frame); }
  else if kind == FRAME_FULLY_ZONKED_VISIT { fully_zonked_visit_transition(frame); }
  else if kind == FRAME_RIGIDIFY { rigidify_transition(frame); }
  else if kind == FRAME_RIGIDIFY_VISIT { rigidify_visit_transition(frame); }
  else if kind == FRAME_INDEXED_SHAPE { indexed_shape_transition(frame); }
  else if kind == FRAME_SUBSUME { subsume_transition(frame); }
  else if kind == FRAME_FORALL_SEARCH { forall_search_transition(frame); }
  else if kind == FRAME_SCHEMA_OCCURRENCE { schema_occurrence_transition(frame); }
  else { invalid_input(ERROR_INVALID_SURFACE, kind); }
}

fn schema_mapping_capacity() -> u32 {
  return max(state.schema_node_count, state.type_parameter_count);
}

fn schema_task_offset() -> u32 {
  return schema_mapping_capacity() * 2u;
}

fn schema_field_offset() -> u32 {
  return schema_task_offset() + state.schema_node_count * 3u;
}

fn start_mapping_lookup(symbol: u32, map_count: u32) -> bool {
  let frame = push_work_frame(FRAME_MAPPING_LOOKUP);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, symbol); frame_set(frame, 1u, map_count); frame_set(frame, 2u, 0u);
  return true;
}

fn mapping_lookup_transition(frame: u32) {
  let cursor = frame_get(frame, 2u);
  if cursor >= frame_get(frame, 1u) {
    state.work_result = 0u; state.returned_type = NO_INDEX; pop_work_frame(); return;
  }
  let address = temporary_base() + cursor * 2u;
  if workspace[address] == frame_get(frame, 0u) {
    state.work_result = 1u; state.returned_type = workspace[address + 1u];
    pop_work_frame(); return;
  }
  frame_set(frame, 2u, cursor + 1u);
}

fn start_find_type(symbol: u32) -> bool {
  let frame = push_work_frame(FRAME_FIND_TYPE);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, symbol); frame_set(frame, 1u, 0u);
  return true;
}

fn find_type_transition(frame: u32) {
  if indexed_metadata_is_available() {
    let symbol = frame_get(frame, 0u);
    let count = indexed_metadata_base(2u);
    state.returned_type = NO_INDEX;
    if symbol < count {
      state.returned_type = schema_words[indexed_metadata_base(1u) + symbol];
    }
    pop_work_frame();
    return;
  }
  let cursor = frame_get(frame, 1u);
  if cursor >= state.type_count {
    state.returned_type = NO_INDEX; pop_work_frame(); return;
  }
  if algebraic_type_record(cursor).symbol == frame_get(frame, 0u) {
    state.returned_type = cursor; pop_work_frame(); return;
  }
  frame_set(frame, 1u, cursor + 1u);
}

fn start_schema_convert(root: u32, map_count: u32, allow_implicit: u32) -> bool {
  let frame = push_work_frame(FRAME_SCHEMA_CONVERT);
  if frame == NO_INDEX { return false; }
  state.work_aux = map_count;
  frame_set(frame, 0u, root); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, allow_implicit); frame_set(frame, 3u, NO_INDEX);
  return true;
}

fn configure_schema_visit(
  frame: u32, schema_index: u32, parent: u32, field: u32,
  allow_implicit: u32, owner: u32,
) {
  frame_set(frame, 0u, schema_index); frame_set(frame, 1u, parent);
  frame_set(frame, 2u, field); frame_set(frame, 3u, 0u);
  frame_set(frame, 8u, allow_implicit); frame_set(frame, 9u, owner);
  frame_set(frame, 10u, FRAME_SCHEMA_VISIT);
}

fn schema_convert_transition(frame: u32) {
  if frame_get(frame, 1u) == 1u {
    state.returned_type = frame_get(frame, 3u);
    pop_work_frame();
    return;
  }
  if !require_frame_slots(1u) { return; }
  let visit = push_work_frame(FRAME_SCHEMA_VISIT);
  configure_schema_visit(visit, frame_get(frame, 0u), NO_INDEX, 0u, frame_get(frame, 2u), frame);
  frame_set(frame, 1u, 1u);
}

fn attach_schema_type(parent: u32, field: u32, converted: u32, owner: u32) {
  if parent == NO_INDEX { frame_set(owner, 3u, converted); }
  else { assign_type_field(parent, field, converted); }
}

fn schema_visit_transition(frame: u32) {
  let node = schema_node(frame_get(frame, 0u));
  let stage = frame_get(frame, 3u);
  let parent = frame_get(frame, 1u); let field = frame_get(frame, 2u);
  if stage == 1u {
    if state.work_result != 0u {
      attach_schema_type(parent, field, state.returned_type, frame_get(frame, 9u));
      pop_work_frame(); return;
    }
    if frame_get(frame, 8u) == 0u {
      report_metadata_diagnostic(
        METADATA_UNDECLARED_TYPE_PARAMETER, node.start_byte, node.end_byte,
        node.payload, NO_INDEX, NO_INDEX);
      return;
    }
    if state.work_aux >= schema_mapping_capacity() ||
      state.work_aux * 2u + 2u > temporary_capacity() {
      exhausted(ERROR_SCRATCH_ARENA_EXHAUSTED, state.work_aux * 2u + 2u); return;
    }
    if !require_type_slots(1u) { return; }
    let converted = allocate_type(TYPE_RIGID, node.payload, state.current_level, NO_INDEX);
    let address = temporary_base() + state.work_aux * 2u;
    workspace[address] = node.payload; workspace[address + 1u] = converted;
    state.work_aux += 1u;
    attach_schema_type(parent, field, converted, frame_get(frame, 9u));
    pop_work_frame(); return;
  }
  if stage == 4u {
    if state.work_result != 0u {
      report_metadata_diagnostic(
        METADATA_INVALID_SCHEMA_CONVERSION, node.start_byte, node.end_byte,
        frame_get(frame, 0u), node.payload, NO_INDEX);
      return;
    }
    if state.work_aux >= schema_mapping_capacity() ||
      state.work_aux * 2u + 2u > temporary_capacity() {
      exhausted(ERROR_SCRATCH_ARENA_EXHAUSTED, state.work_aux * 2u + 2u); return;
    }
    if !require_type_slots(1u) { return; }
    let generic = allocate_type(TYPE_GENERIC, state.next_generic, NO_INDEX, NO_INDEX);
    state.next_generic += 1u;
    let mapping = temporary_base() + state.work_aux * 2u;
    workspace[mapping] = node.payload; workspace[mapping + 1u] = generic;
    state.work_aux += 1u;
    frame_set(frame, 3u, 5u);
    return;
  }
  if stage == 5u {
    if !require_type_slots(1u) { return; }
    let converted = allocate_type(TYPE_FORALL, NO_INDEX, NO_INDEX, NO_INDEX);
    let owner = frame_get(frame, 9u);
    let allow_implicit = frame_get(frame, 8u);
    attach_schema_type(parent, field, converted, owner);
    configure_schema_visit(frame, node.first_child, converted, 2u, allow_implicit, owner);
    return;
  }
  if stage == 2u {
    if state.returned_type == NO_INDEX {
      report_metadata_diagnostic(
        METADATA_UNKNOWN_TYPE, node.start_byte, node.end_byte,
        node.payload, NO_INDEX, NO_INDEX);
      return;
    }
    if !require_type_slots(1u) { return; }
    let converted = allocate_type(TYPE_NAMED, state.returned_type, NO_INDEX, NO_INDEX);
    attach_schema_type(parent, field, converted, frame_get(frame, 9u));
    frame_set(frame, 4u, converted); frame_set(frame, 5u, node.first_child);
    frame_set(frame, 6u, NO_INDEX); frame_set(frame, 3u, 3u);
    return;
  }
  if stage == 3u {
    let child = frame_get(frame, 5u);
    if child == NO_INDEX { pop_work_frame(); return; }
    if !require_type_slots(1u) || !require_frame_slots(1u) { return; }
    let list = allocate_type(TYPE_LIST, NO_INDEX, NO_INDEX, NO_INDEX);
    let tail = frame_get(frame, 6u);
    if tail == NO_INDEX { type_set(frame_get(frame, 4u), 2u, list); }
    else { type_set(tail, 2u, list); }
    frame_set(frame, 6u, list);
    frame_set(frame, 5u, schema_node(child).next_sibling);
    let child_frame = push_work_frame(FRAME_SCHEMA_VISIT);
    configure_schema_visit(
      child_frame, child, list, 1u, frame_get(frame, 8u), frame_get(frame, 9u));
    return;
  }
  let primitive_type = primitive_type_index_for_schema(node.tag);
  if primitive_type != NO_INDEX {
    attach_schema_type(parent, field, primitive_type, frame_get(frame, 9u));
    pop_work_frame(); return;
  }
  if node.tag == SCHEMA_PARAMETER {
    if indexed_metadata_is_available() {
      let position = schema_words[indexed_metadata_base(5u) + frame_get(frame, 0u)];
      if position != NO_INDEX {
        if position >= state.work_aux {
          report_metadata_diagnostic(
            METADATA_INVALID_SCHEMA_CONVERSION, node.start_byte, node.end_byte,
            frame_get(frame, 0u), node.payload, position);
          return;
        }
        let address = temporary_base() + position * 2u;
        if workspace[address] != node.payload {
          report_metadata_diagnostic(
            METADATA_INVALID_SCHEMA_CONVERSION, node.start_byte, node.end_byte,
            frame_get(frame, 0u), node.payload, workspace[address]);
          return;
        }
        attach_schema_type(parent, field, workspace[address + 1u], frame_get(frame, 9u));
        pop_work_frame();
        return;
      }
    }
    if start_mapping_lookup(node.payload, state.work_aux) { frame_set(frame, 3u, 1u); }
    return;
  }
  if node.tag == SCHEMA_TUPLE || node.tag == SCHEMA_FUNCTION {
    let first_child = node.first_child;
    let second_child = select(NO_INDEX, schema_node(first_child).next_sibling, first_child != NO_INDEX);
    if first_child == NO_INDEX || second_child == NO_INDEX {
      report_metadata_diagnostic(
        METADATA_INVALID_SCHEMA_CONVERSION, node.start_byte, node.end_byte,
        frame_get(frame, 0u), NO_INDEX, NO_INDEX);
      return;
    }
    if !require_type_slots(1u) || !require_frame_slots(1u) { return; }
    let kind = select(TYPE_FUNCTION, TYPE_TUPLE, node.tag == SCHEMA_TUPLE);
    let converted = allocate_type(kind, NO_INDEX, NO_INDEX, NO_INDEX);
    let owner = frame_get(frame, 9u);
    attach_schema_type(parent, field, converted, owner);
    configure_schema_visit(frame, first_child, converted, 2u, frame_get(frame, 8u), owner);
    let sibling = push_work_frame(FRAME_SCHEMA_VISIT);
    configure_schema_visit(sibling, second_child, converted, 3u, frame_get(frame, 8u), owner);
    return;
  }
  if node.tag == SCHEMA_FORALL {
    if start_mapping_lookup(node.payload, state.work_aux) { frame_set(frame, 3u, 4u); }
    return;
  }
  if node.tag == SCHEMA_NAMED {
    if start_find_type(node.payload) { frame_set(frame, 3u, 2u); }
    return;
  }
  report_metadata_diagnostic(
    METADATA_INVALID_SCHEMA_CONVERSION, node.start_byte, node.end_byte,
    frame_get(frame, 0u), NO_INDEX, NO_INDEX);
}

fn temporary_field_base() -> u32 {
  return temporary_base() + schema_field_offset();
}

fn start_constructor(constructor_index: u32, curry_fields: u32, pattern_mode: u32) -> bool {
  let frame = push_work_frame(FRAME_CONSTRUCTOR);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, constructor_index); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, curry_fields);
  frame_set(frame, 6u, pattern_mode);
  return true;
}

fn constructor_transition(frame: u32) {
  let constructor_index = frame_get(frame, 0u);
  let constructor = constructor_record(constructor_index);
  let stage = frame_get(frame, 1u);
  let map_count = type_metadata(constructor.type_index, 1u);
  if stage == 0u {
    let field_count = constructor_metadata(constructor_index, 1u);
    let field_offset = schema_field_offset();
    if map_count > schema_mapping_capacity() || field_offset > temporary_capacity() ||
      field_count > temporary_capacity() - field_offset {
      exhausted(ERROR_SCRATCH_ARENA_EXHAUSTED, max(map_count * 2u, field_offset + field_count));
      return;
    }
    state.work_aux = map_count;
    frame_set(frame, 3u, 0u); frame_set(frame, 4u, 0u);
    frame_set(frame, 5u, NO_INDEX); frame_set(frame, 1u, 1u);
    return;
  }
  if stage == 1u {
    let cursor = frame_get(frame, 3u);
    if cursor >= map_count { frame_set(frame, 1u, 2u); return; }
    if !require_type_slots(1u) { return; }
    let first_parameter = type_metadata(constructor.type_index, 0u);
    let address = temporary_base() + cursor * 2u;
    workspace[address] = schema_words[state.type_parameter_base + first_parameter + cursor];
    if frame_get(frame, 6u) == 0u {
      workspace[address + 1u] = fresh_variable();
    } else {
      workspace[address + 1u] = allocate_type(
        TYPE_RIGID, workspace[address], 0u, NO_INDEX);
    }
    frame_set(frame, 3u, cursor + 1u);
    return;
  }
  if stage == 2u {
    let field_cursor = frame_get(frame, 4u);
    let field_count = constructor_metadata(constructor_index, 1u);
    if field_cursor >= field_count { frame_set(frame, 1u, 4u); return; }
    let first_field = constructor_metadata(constructor_index, 0u);
    let field_schema = schema_words[state.constructor_field_base + first_field + field_cursor];
    if start_schema_convert(field_schema, map_count, 0u) { frame_set(frame, 1u, 3u); }
    return;
  }
  if stage == 3u {
    let field_cursor = frame_get(frame, 4u);
    workspace[temporary_field_base() + field_cursor] = state.returned_type;
    frame_set(frame, 4u, field_cursor + 1u); frame_set(frame, 1u, 2u);
    return;
  }
  if stage == 4u {
    let result_root = constructor_metadata(constructor_index, 2u);
    if start_schema_convert(result_root, map_count, 0u) { frame_set(frame, 1u, 5u); }
    return;
  }
  if stage == 5u {
    frame_set(frame, 5u, state.returned_type); frame_set(frame, 1u, 6u);
    return;
  }
  let field_cursor = frame_get(frame, 4u);
  if frame_get(frame, 2u) == 0u || field_cursor == 0u {
    state.returned_type = frame_get(frame, 5u); pop_work_frame(); return;
  }
  if !require_type_slots(1u) { return; }
  let next_field = field_cursor - 1u;
  frame_set(frame, 5u, allocate_type(
    TYPE_FUNCTION, NO_INDEX, workspace[temporary_field_base() + next_field],
    frame_get(frame, 5u)));
  frame_set(frame, 4u, next_field);
}

fn environment_address(index: u32) -> u32 {
  return state.environment_base + index * ENVIRONMENT_WORDS;
}

fn allocate_environment(type_index: u32, parent: u32) -> u32 {
  if state.environment_top >= state.environment_capacity {
    exhausted(ERROR_ENVIRONMENT_ARENA_EXHAUSTED, state.environment_top + 1u);
    return NO_INDEX;
  }
  let result = state.environment_top;
  state.environment_top += 1u;
  let address = environment_address(result);
  workspace[address] = type_index;
  workspace[address + 1u] = parent;
  workspace[address + 2u] = NO_INDEX;
  return result;
}

fn frame_address(index: u32) -> u32 {
  return state.frame_base + index * FRAME_WORDS;
}

fn frame_get(index: u32, word: u32) -> u32 {
  return workspace[frame_address(index) + word];
}

fn frame_set(index: u32, word: u32, value: u32) {
  workspace[frame_address(index) + word] = value;
}

fn push_expression(node: u32, environment: u32) -> bool {
  if state.frame_top >= state.frame_capacity {
    exhausted(ERROR_FRAME_ARENA_EXHAUSTED, state.frame_top + 1u);
    return false;
  }
  clear_frame(state.frame_top, FRAME_EXPRESSION);
  let address = frame_address(state.frame_top);
  workspace[address] = node;
  workspace[address + 1u] = 0u;
  workspace[address + 2u] = environment;
  state.frame_top += 1u;
  return true;
}

fn start_case_bind(arm_index: u32, constructor_index: u32, environment: u32) -> bool {
  let frame = push_work_frame(FRAME_CASE_BIND);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, arm_index); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, constructor_index); frame_set(frame, 3u, environment);
  frame_set(frame, 4u, core_node(arm_index).child0); frame_set(frame, 5u, 0u);
  return true;
}

fn case_bind_transition(frame: u32) {
  if frame_get(frame, 1u) == 0u {
    let body = frame_get(frame, 4u);
    if core_node(body).tag == TAG_PATTERN_BIND {
      let count = frame_get(frame, 5u);
      if count >= MAXIMUM_CONSTRUCTOR_ARITY {
        invalid_input(ERROR_INVALID_SURFACE, frame_get(frame, 0u)); return;
      }
      frame_set(frame, 4u, core_node(body).child0);
      frame_set(frame, 5u, count + 1u);
      return;
    }
    let field_count = constructor_metadata(frame_get(frame, 2u), 1u);
    if frame_get(frame, 5u) != field_count {
      let arm = core_node(frame_get(frame, 0u));
      report_metadata_diagnostic(
        METADATA_CASE_FIELD_COUNT_MISMATCH, arm.start_byte, arm.end_byte,
        constructor_record(frame_get(frame, 2u)).symbol, field_count, frame_get(frame, 5u));
      return;
    }
    frame_set(frame, 5u, field_count); frame_set(frame, 1u, 1u);
    return;
  }
  let field_cursor = frame_get(frame, 5u);
  if field_cursor == 0u {
    state.current_arm = frame_get(frame, 4u);
    state.returned_type = frame_get(frame, 3u);
    pop_work_frame();
    return;
  }
  if !require_environment_slots(1u) { return; }
  let next_field = field_cursor - 1u;
  frame_set(frame, 3u, allocate_environment(
    workspace[temporary_field_base() + next_field], frame_get(frame, 3u)));
  frame_set(frame, 5u, next_field);
}

fn start_case_coverage(type_index: u32, first_arm: u32) -> bool {
  let frame = push_work_frame(FRAME_CASE_COVERAGE);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, type_index); frame_set(frame, 1u, 0u);
  frame_set(frame, 2u, first_arm); frame_set(frame, 3u, first_arm);
  frame_set(frame, 4u, 0u);
  return true;
}

fn case_coverage_transition(frame: u32) {
  let type_index = frame_get(frame, 0u);
  let declared = algebraic_type_record(type_index);
  let stage = frame_get(frame, 4u);
  let cursor = frame_get(frame, 1u);
  if stage == 0u {
    if cursor >= declared.constructor_count {
      frame_set(frame, 1u, 0u);
      frame_set(frame, 4u, 1u);
      return;
    }
    workspace[temporary_base() + cursor] = 0u;
    frame_set(frame, 1u, cursor + 1u);
    return;
  }
  if stage == 1u {
    let arm = frame_get(frame, 3u);
    if arm == NO_INDEX {
      frame_set(frame, 1u, 0u);
      frame_set(frame, 4u, 2u);
      return;
    }
    let constructor_index = core_node(arm).payload;
    if constructor_index >= declared.first_constructor &&
      constructor_index - declared.first_constructor < declared.constructor_count {
      workspace[temporary_base() + constructor_index - declared.first_constructor] = 1u;
    }
    frame_set(frame, 3u, core_node(arm).child1);
    return;
  }
  if cursor >= declared.constructor_count {
    state.returned_type = NO_INDEX; pop_work_frame(); return;
  }
  let constructor_index = declared.first_constructor + cursor;
  if workspace[temporary_base() + cursor] == 0u {
    state.returned_type = constructor_record(constructor_index).symbol; pop_work_frame(); return;
  }
  frame_set(frame, 1u, cursor + 1u);
}

fn start_schema_parameter_check(root: u32, type_index: u32) -> bool {
  let frame = push_work_frame(FRAME_SCHEMA_PARAMETER_CHECK);
  if frame == NO_INDEX { return false; }
  state.work_result = 0u;
  frame_set(frame, 0u, root); frame_set(frame, 1u, type_index);
  frame_set(frame, 2u, 0u); frame_set(frame, 3u, 0u);
  return true;
}

fn schema_parameter_check_transition(frame: u32) {
  if state.work_result != 0u { pop_work_frame(); return; }
  let node = schema_node(frame_get(frame, 0u));
  let stage = frame_get(frame, 2u);
  if stage == 0u {
    if node.tag == SCHEMA_PARAMETER {
      frame_set(frame, 2u, 1u); frame_set(frame, 3u, 0u); return;
    }
    frame_set(frame, 2u, 2u); frame_set(frame, 3u, node.first_child); return;
  }
  if stage == 1u {
    let type_index = frame_get(frame, 1u);
    let cursor = frame_get(frame, 3u);
    let count = type_metadata(type_index, 1u);
    if cursor >= count {
      state.work_result = 1u; state.returned_type = frame_get(frame, 0u);
      pop_work_frame(); return;
    }
    let first = type_metadata(type_index, 0u);
    if schema_words[state.type_parameter_base + first + cursor] == node.payload {
      pop_work_frame(); return;
    }
    frame_set(frame, 3u, cursor + 1u);
    return;
  }
  let child = frame_get(frame, 3u);
  if child == NO_INDEX { pop_work_frame(); return; }
  if !require_frame_slots(1u) { return; }
  frame_set(frame, 3u, schema_node(child).next_sibling);
  let child_frame = push_work_frame(FRAME_SCHEMA_PARAMETER_CHECK);
  frame_set(child_frame, 0u, child); frame_set(child_frame, 1u, frame_get(frame, 1u));
  frame_set(child_frame, 2u, 0u); frame_set(child_frame, 3u, 0u);
}

fn start_field_parameter_recoverability(
  field_root: u32,
  result_root: u32,
  constructor_index: u32,
) -> bool {
  let frame = push_work_frame(FRAME_FIELD_PARAMETER_RECOVERABILITY);
  if frame == NO_INDEX { return false; }
  frame_set(frame, 0u, field_root); frame_set(frame, 1u, result_root);
  frame_set(frame, 2u, constructor_index); frame_set(frame, 3u, 0u);
  frame_set(frame, 4u, NO_INDEX);
  return true;
}

fn configure_schema_occurrence(frame: u32, root: u32, parameter: u32) {
  frame_set(frame, 0u, root); frame_set(frame, 1u, NO_INDEX);
  frame_set(frame, 2u, parameter); frame_set(frame, 3u, 0u);
  frame_set(frame, 10u, FRAME_SCHEMA_OCCURRENCE);
}

fn start_schema_occurrence(root: u32, parameter: u32) -> bool {
  let frame = push_work_frame(FRAME_SCHEMA_OCCURRENCE);
  if frame == NO_INDEX { return false; }
  state.work_result = 0u;
  configure_schema_occurrence(frame, root, parameter);
  return true;
}

fn schema_occurrence_transition(frame: u32) {
  if state.work_result != 0u { pop_work_frame(); return; }
  let node = schema_node(frame_get(frame, 0u));
  if frame_get(frame, 3u) == 0u {
    if node.tag == SCHEMA_PARAMETER && node.payload == frame_get(frame, 2u) {
      state.work_result = 1u;
      pop_work_frame();
      return;
    }
    frame_set(frame, 1u, node.first_child);
    frame_set(frame, 3u, 1u);
    return;
  }
  let child = frame_get(frame, 1u);
  if child == NO_INDEX { pop_work_frame(); return; }
  if !require_frame_slots(1u) { return; }
  frame_set(frame, 1u, schema_node(child).next_sibling);
  let child_frame = push_work_frame(FRAME_SCHEMA_OCCURRENCE);
  configure_schema_occurrence(child_frame, child, frame_get(frame, 2u));
}

fn field_parameter_recoverability_transition(frame: u32) {
  let field_schema = schema_node(frame_get(frame, 0u));
  let stage = frame_get(frame, 3u);
  if stage == 0u {
    if field_schema.tag == SCHEMA_PARAMETER {
      if start_schema_occurrence(frame_get(frame, 1u), field_schema.payload) {
        frame_set(frame, 3u, 1u);
      }
      return;
    }
    frame_set(frame, 3u, 2u); frame_set(frame, 4u, field_schema.first_child);
    return;
  }
  if stage == 1u {
    if state.work_result != 0u {
      pop_work_frame();
      return;
    }
    report_metadata_diagnostic(
      METADATA_HIDDEN_CONSTRUCTOR_FIELD_PARAMETER,
      field_schema.start_byte,
      field_schema.end_byte,
      frame_get(frame, 2u),
      field_schema.payload,
      frame_get(frame, 1u),
    );
    return;
  }
  let child = frame_get(frame, 4u);
  if child == NO_INDEX { pop_work_frame(); return; }
  if !require_frame_slots(1u) { return; }
  frame_set(frame, 4u, schema_node(child).next_sibling);
  let child_frame = push_work_frame(FRAME_FIELD_PARAMETER_RECOVERABILITY);
  frame_set(child_frame, 0u, child); frame_set(child_frame, 1u, frame_get(frame, 1u));
  frame_set(child_frame, 2u, frame_get(frame, 2u)); frame_set(child_frame, 3u, 0u);
  frame_set(child_frame, 4u, NO_INDEX);
}

fn complete_expression(type_index: u32) {
  state.frame_top -= 1u;
  state.returned_type = type_index;
}

fn expression_transition() {
  if state.frame_top == 0u { return; }
  let frame = state.frame_top - 1u;
  let node_index = frame_get(frame, 0u);
  let stage = frame_get(frame, 1u);
  let environment = frame_get(frame, 2u);
  let node = core_node(node_index);

  if stage == 0u {
    if node.tag == TAG_INTEGER { complete_expression(0u); return; }
    if node.tag == TAG_BOOLEAN { complete_expression(1u); return; }
    if node.tag == TAG_SIGNED_INTEGER_64 { complete_expression(3u); return; }
    if node.tag == TAG_FLOAT_32 { complete_expression(4u); return; }
    if node.tag == TAG_FLOAT_64 { complete_expression(5u); return; }
    if node.tag == TAG_WHOLE_NUMBER_F64 {
      if !require_type_slots(1u) { return; }
      complete_expression(allocate_type(TYPE_NAMED, node.child1, NO_INDEX, NO_INDEX));
      return;
    }
    if node.tag == TAG_TEXT || node.tag == TAG_BYTES {
      if !require_type_slots(1u) { return; }
      complete_expression(allocate_type(TYPE_NAMED, node.child0, NO_INDEX, NO_INDEX));
      return;
    }
    if node.tag == TAG_RUNTIME_FAULT {
      if !require_type_slots(1u) { return; }
      complete_expression(fresh_variable());
      return;
    }
    if node.tag == TAG_LOCAL {
      let expected = frame_get(frame, 11u);
      if node.payload == 0u && environment != NO_INDEX && expected != NO_INDEX {
        let scheme = workspace[environment_address(environment)];
        if scheme == expected && type_kind_is_primitive(type_get(scheme, 0u)) {
          complete_expression(scheme);
          return;
        }
      }
      if start_local_lookup(node.payload, environment, node_index) { frame_set(frame, 1u, 90u); }
      return;
    }
    if node.tag == TAG_GLOBAL {
      let scheme = scratch_get(0u, node.payload);
      if scheme == NO_INDEX { invalid_input(ERROR_INVALID_SURFACE, node_index); return; }
      if type_kind_is_primitive(type_get(scheme, 0u)) {
        complete_expression(scheme);
        return;
      }
      if start_instantiate(scheme) { frame_set(frame, 1u, 91u); }
      return;
    }
    if node.tag == TAG_CONSTRUCTOR {
      if start_constructor(node.payload, 1u, 0u) { frame_set(frame, 1u, 92u); }
      return;
    }
    if node.tag == TAG_LET {
      if !require_frame_slots(1u) { return; }
      frame_set(frame, 1u, 1u);
      frame_set(frame, 9u, state.current_level);
      state.current_level += 1u;
      push_expression(node.child0, environment);
      return;
    }
    if node.tag == TAG_LET_REC {
      if !require_type_slots(1u) || !require_environment_slots(1u) ||
        !require_frame_slots(1u) { return; }
      frame_set(frame, 1u, 10u);
      frame_set(frame, 9u, state.current_level);
      state.current_level += 1u;
      let placeholder = fresh_variable();
      if state.status != STATUS_PENDING { return; }
      let recursive_environment = allocate_environment(placeholder, environment);
      if state.status != STATUS_PENDING { return; }
      frame_set(frame, 3u, placeholder);
      frame_set(frame, 5u, recursive_environment);
      if push_expression(node.child0, recursive_environment) {
        frame_set(state.frame_top - 1u, 11u, placeholder);
      }
      return;
    }
    if node.tag == TAG_IF {
      if !require_frame_slots(1u) { return; }
      frame_set(frame, 1u, 20u);
      frame_set(frame, 4u, select(
        0u, 1u,
        core_node(node.child1).tag == TAG_CASE && core_node(node.child2).tag != TAG_CASE));
      if push_expression(node.child0, environment) {
        frame_set(state.frame_top - 1u, 11u, 1u);
      }
      return;
    }
    if node.tag == TAG_LAMBDA {
      let expected = frame_get(frame, 11u);
      if expected != NO_INDEX {
        if start_prune(expected) { frame_set(frame, 1u, 31u); }
        return;
      }
      if !require_type_slots(1u) || !require_environment_slots(1u) ||
        !require_frame_slots(1u) { return; }
      let parameter = fresh_variable();
      if state.status != STATUS_PENDING { return; }
      let body_environment = allocate_environment(parameter, environment);
      if state.status != STATUS_PENDING { return; }
      frame_set(frame, 3u, parameter);
      frame_set(frame, 6u, NO_INDEX);
      frame_set(frame, 1u, 30u);
      push_expression(node.child0, body_environment);
      return;
    }
    if node.tag == TAG_APPLY {
      if !require_frame_slots(1u) { return; }
      frame_set(frame, 1u, 40u);
      push_expression(node.child0, environment);
      return;
    }
    if node.tag == TAG_UNARY {
      let whole_number = node.payload == ${LazuliUnaryOperator.NegateWholeNumberF64}u;
      if !require_frame_slots(1u) || (whole_number && !require_type_slots(1u)) { return; }
      frame_set(frame, 1u, 50u);
      var operand_type = numeric_type_index_for_unary(node.payload);
      if whole_number {
        operand_type = allocate_type(TYPE_NAMED, node.child1, NO_INDEX, NO_INDEX);
      }
      frame_set(frame, 3u, operand_type);
      if push_expression(node.child0, environment) {
        frame_set(state.frame_top - 1u, 11u, operand_type);
      }
      return;
    }
    if node.tag == TAG_BINARY {
      let structural = operator_is_structural_equality(node.payload);
      let whole_number = node.payload >= BINARY_EQUAL_WHOLE_NUMBER_F64 &&
        node.payload <= BINARY_REMAINDER_WHOLE_NUMBER_F64;
      if !require_frame_slots(1u) || ((structural || whole_number) && !require_type_slots(1u)) {
        return;
      }
      var operand_type = numeric_type_index_for_operator(node.payload);
      if structural { operand_type = fresh_variable(); }
      if whole_number {
        operand_type = allocate_type(TYPE_NAMED, node.child2, NO_INDEX, NO_INDEX);
      }
      if state.status != STATUS_PENDING { return; }
      frame_set(frame, 3u, operand_type);
      frame_set(frame, 1u, 60u);
      if push_expression(node.child0, environment) {
        frame_set(state.frame_top - 1u, 11u, operand_type);
      }
      return;
    }
    if node.tag == TAG_BUFFER_APPEND {
      if !require_frame_slots(1u) || !require_type_slots(1u) { return; }
      let operand_type = allocate_type(TYPE_NAMED, node.child2, NO_INDEX, NO_INDEX);
      frame_set(frame, 3u, operand_type);
      frame_set(frame, 1u, 60u);
      if push_expression(node.child0, environment) {
        frame_set(state.frame_top - 1u, 11u, operand_type);
      }
      return;
    }
    if node.tag == TAG_NUMERIC_CONVERT {
      if !require_frame_slots(1u) { return; }
      frame_set(frame, 1u, 64u);
      if push_expression(node.child0, environment) {
        frame_set(state.frame_top - 1u, 11u, numeric_conversion_source(node.payload));
      }
      return;
    }
    if node.tag == TAG_CASE {
      if !require_frame_slots(1u) { return; }
      frame_set(frame, 1u, 70u);
      frame_set(frame, 8u, node.child1);
      push_expression(node.child0, environment);
      return;
    }
    report_metadata_diagnostic(
      METADATA_UNSUPPORTED_EXPRESSION,
      node.start_byte,
      node.end_byte,
      node.tag,
      node_index,
      NO_INDEX,
    );
    return;
  }

  if stage == 90u || stage == 91u || stage == 92u {
    complete_expression(state.returned_type);
    return;
  }

  if stage == 1u {
    state.current_level = frame_get(frame, 9u);
    if type_kind_is_primitive(type_get(state.returned_type, 0u)) {
      if !require_environment_slots(1u) || !require_frame_slots(1u) { return; }
      let body_environment = allocate_environment(state.returned_type, environment);
      if state.status != STATUS_PENDING { return; }
      frame_set(frame, 1u, 2u);
      if push_expression(node.child1, body_environment) {
        frame_set(state.frame_top - 1u, 11u, frame_get(frame, 11u));
      }
      return;
    }
    if start_generalize(state.returned_type, state.current_level) { frame_set(frame, 1u, 3u); }
    return;
  }
  if stage == 3u {
    if !require_environment_slots(1u) || !require_frame_slots(1u) { return; }
    let body_environment = allocate_environment(state.returned_type, environment);
    if state.status != STATUS_PENDING { return; }
    frame_set(frame, 1u, 2u);
    if push_expression(node.child1, body_environment) {
      frame_set(state.frame_top - 1u, 11u, frame_get(frame, 11u));
    }
    return;
  }
  if stage == 2u { complete_expression(state.returned_type); return; }

  if stage == 10u {
    if start_unify(frame_get(frame, 3u), state.returned_type, node.start_byte, node.end_byte) {
      frame_set(frame, 1u, 12u);
    }
    return;
  }
  if stage == 12u {
    state.current_level = frame_get(frame, 9u);
    if start_generalize(frame_get(frame, 3u), state.current_level) { frame_set(frame, 1u, 13u); }
    return;
  }
  if stage == 13u {
    if !require_frame_slots(1u) { return; }
    frame_set(frame, 1u, 11u);
    if push_expression(node.child1, frame_get(frame, 5u)) {
      frame_set(state.frame_top - 1u, 11u, frame_get(frame, 11u));
    }
    return;
  }
  if stage == 11u { complete_expression(state.returned_type); return; }

  if stage == 20u {
    if start_unify(1u, state.returned_type, node.start_byte, node.end_byte) {
      frame_set(frame, 1u, 23u);
    }
    return;
  }
  if stage == 23u {
    if !require_frame_slots(1u) { return; }
    frame_set(frame, 1u, 21u);
    let first = select(node.child1, node.child2, frame_get(frame, 4u) != 0u);
    if push_expression(first, environment) {
      frame_set(state.frame_top - 1u, 11u, frame_get(frame, 11u));
    }
    return;
  }
  if stage == 21u {
    frame_set(frame, 3u, state.returned_type);
    if frame_get(frame, 11u) != NO_INDEX {
      let first = select(node.child1, node.child2, frame_get(frame, 4u) != 0u);
      let first_node = core_node(first);
      if start_unify(
        frame_get(frame, 11u), state.returned_type,
        first_node.start_byte, first_node.end_byte) {
        frame_set(frame, 1u, 25u);
      }
      return;
    }
    frame_set(frame, 1u, 25u);
    return;
  }
  if stage == 25u {
    if !require_frame_slots(1u) { return; }
    let second = select(node.child2, node.child1, frame_get(frame, 4u) != 0u);
    frame_set(frame, 1u, 22u);
    if push_expression(second, environment) {
      let expected = select(
        frame_get(frame, 3u), frame_get(frame, 11u), frame_get(frame, 11u) != NO_INDEX);
      frame_set(state.frame_top - 1u, 11u, expected);
    }
    return;
  }
  if stage == 22u {
    let second = select(node.child2, node.child1, frame_get(frame, 4u) != 0u);
    let second_node = core_node(second);
    if start_unify(
      frame_get(frame, 3u), state.returned_type,
      second_node.start_byte, second_node.end_byte) {
      frame_set(frame, 1u, 24u);
    }
    return;
  }
  if stage == 24u {
    complete_expression(select(
      frame_get(frame, 3u), frame_get(frame, 11u), frame_get(frame, 11u) != NO_INDEX));
    return;
  }

  if stage == 30u {
    if frame_get(frame, 6u) != NO_INDEX {
      if start_unify(
        type_get(frame_get(frame, 6u), 3u), state.returned_type,
        node.start_byte, node.end_byte) {
        frame_set(frame, 1u, 35u);
      }
      return;
    }
    if !require_type_slots(1u) { return; }
    let function_type = allocate_type(TYPE_FUNCTION, NO_INDEX, frame_get(frame, 3u), state.returned_type);
    if state.status == STATUS_PENDING { complete_expression(function_type); }
    return;
  }
  if stage == 35u { complete_expression(frame_get(frame, 6u)); return; }
  if stage == 31u {
    let expected = state.returned_type;
    let expected_is_function = type_get(expected, 0u) == TYPE_FUNCTION;
    if type_get(expected, 0u) == TYPE_VARIABLE {
      if !require_type_slots(1u) { return; }
      frame_set(frame, 4u, expected);
      frame_set(frame, 3u, fresh_variable());
      frame_set(frame, 1u, 32u);
      return;
    }
    let required_types = select(1u, 0u, expected_is_function);
    if !require_type_slots(required_types) || !require_environment_slots(1u) ||
      !require_frame_slots(1u) { return; }
    var parameter = NO_INDEX;
    var expected_body = NO_INDEX;
    if expected_is_function {
      parameter = type_get(expected, 2u);
      expected_body = type_get(expected, 3u);
      frame_set(frame, 6u, expected);
    } else {
      parameter = fresh_variable();
      if state.status != STATUS_PENDING { return; }
      frame_set(frame, 6u, NO_INDEX);
    }
    let body_environment = allocate_environment(parameter, environment);
    if state.status != STATUS_PENDING { return; }
    if !push_expression(node.child0, body_environment) { return; }
    frame_set(frame, 3u, parameter);
    frame_set(frame, 1u, 30u);
    frame_set(state.frame_top - 1u, 11u, expected_body);
    return;
  }
  if stage == 32u {
    if !require_type_slots(1u) { return; }
    frame_set(frame, 5u, fresh_variable());
    frame_set(frame, 1u, 33u);
    return;
  }
  if stage == 33u {
    if !require_type_slots(1u) { return; }
    let function_type = allocate_type(
      TYPE_FUNCTION, NO_INDEX, frame_get(frame, 3u), frame_get(frame, 5u));
    frame_set(frame, 6u, function_type);
    if start_unify(frame_get(frame, 4u), function_type, node.start_byte, node.end_byte) {
      frame_set(frame, 1u, 34u);
    }
    return;
  }
  if stage == 34u {
    if !require_environment_slots(1u) || !require_frame_slots(1u) { return; }
    let body_environment = allocate_environment(frame_get(frame, 3u), environment);
    if state.status != STATUS_PENDING { return; }
    frame_set(frame, 1u, 30u);
    if push_expression(node.child0, body_environment) {
      frame_set(state.frame_top - 1u, 11u, frame_get(frame, 5u));
    }
    return;
  }

  if stage == 40u {
    if !require_frame_slots(1u) { return; }
    frame_set(frame, 3u, state.returned_type);
    frame_set(frame, 1u, 41u);
    push_expression(node.child1, environment);
    return;
  }
  if stage == 41u {
    if frame_get(frame, 11u) != NO_INDEX {
      frame_set(frame, 4u, frame_get(frame, 11u));
    } else {
      if !require_type_slots(1u) { return; }
      frame_set(frame, 4u, fresh_variable());
    }
    let callee = frame_get(frame, 3u);
    if type_get(callee, 0u) == TYPE_FUNCTION {
      let parameter = type_get(callee, 2u);
      let parameter_kind = type_get(parameter, 0u);
      if parameter_kind == TYPE_FORALL {
        frame_set(frame, 6u, parameter);
        state.work_result = 1u;
        frame_set(frame, 1u, 47u);
        return;
      }
      if parameter_kind == TYPE_FUNCTION {
        frame_set(frame, 6u, parameter);
        if start_forall_search(parameter) { frame_set(frame, 1u, 47u); }
        return;
      }
    }
    frame_set(frame, 1u, 42u);
    return;
  }
  if stage == 47u {
    if state.work_result == 0u {
      frame_set(frame, 1u, 42u);
      return;
    }
    let argument = core_node(node.child1);
    if argument.tag == TAG_GLOBAL {
      let scheme = scratch_get(0u, argument.payload);
      if scheme == NO_INDEX { invalid_input(ERROR_INVALID_SURFACE, node.child1); return; }
      if start_subsume(scheme, frame_get(frame, 6u), argument.start_byte, argument.end_byte) {
        frame_set(frame, 1u, 46u);
      }
      return;
    }
    if argument.tag == TAG_LOCAL {
      if start_local_scheme_lookup(argument.payload, environment, node.child1) {
        frame_set(frame, 1u, 45u);
      }
      return;
    }
    if start_subsume(
      state.returned_type, frame_get(frame, 6u), argument.start_byte, argument.end_byte) {
      frame_set(frame, 1u, 46u);
    }
    return;
  }
  if stage == 45u {
    let argument = core_node(node.child1);
    if start_subsume(
      state.returned_type, frame_get(frame, 6u), argument.start_byte, argument.end_byte) {
      frame_set(frame, 1u, 46u);
    }
    return;
  }
  if stage == 46u {
    state.returned_type = frame_get(frame, 6u);
    frame_set(frame, 1u, 42u);
    return;
  }
  if stage == 42u {
    if !require_type_slots(1u) || !require_frame_slots(1u) { return; }
    let function_type = allocate_type(
      TYPE_FUNCTION, NO_INDEX, state.returned_type, frame_get(frame, 4u));
    start_application_unify(
      frame_get(frame, 3u), function_type, frame_get(frame, 4u),
      node.start_byte, node.end_byte);
    frame_set(frame, 1u, 43u);
    return;
  }
  if stage == 43u { complete_expression(frame_get(frame, 4u)); return; }

  if stage == 50u {
    let operand_type = frame_get(frame, 3u);
    if operand_type == state.returned_type {
      complete_expression(operand_type);
      return;
    }
    if start_unify(operand_type, state.returned_type, node.start_byte, node.end_byte) {
      frame_set(frame, 1u, 51u);
    }
    return;
  }
  if stage == 51u {
    complete_expression(frame_get(frame, 3u));
    return;
  }

  if stage == 60u {
    let operand_type = frame_get(frame, 3u);
    if operand_type == state.returned_type {
      if !require_frame_slots(1u) { return; }
      frame_set(frame, 1u, 61u);
      if push_expression(node.child1, environment) {
        frame_set(state.frame_top - 1u, 11u, operand_type);
      }
      return;
    }
    if start_unify(operand_type, state.returned_type, node.start_byte, node.end_byte) {
      frame_set(frame, 1u, 62u);
    }
    return;
  }
  if stage == 62u {
    if !require_frame_slots(1u) { return; }
    frame_set(frame, 1u, 61u);
    if push_expression(node.child1, environment) {
      frame_set(state.frame_top - 1u, 11u, frame_get(frame, 3u));
    }
    return;
  }
  if stage == 61u {
    let operand_type = frame_get(frame, 3u);
    if operand_type == state.returned_type {
      complete_expression(select(
        operand_type, 1u,
        node.tag == TAG_BINARY &&
          (numeric_operator_is_comparison(node.payload) ||
            operator_is_structural_equality(node.payload))));
      return;
    }
    if start_unify(operand_type, state.returned_type, node.start_byte, node.end_byte) {
      frame_set(frame, 1u, 63u);
    }
    return;
  }
  if stage == 63u {
    complete_expression(select(
      frame_get(frame, 3u), 1u,
      node.tag == TAG_BINARY &&
        (numeric_operator_is_comparison(node.payload) ||
          operator_is_structural_equality(node.payload))));
    return;
  }
  if stage == 64u {
    if start_unify(
      numeric_conversion_source(node.payload), state.returned_type,
      node.start_byte, node.end_byte) {
      frame_set(frame, 1u, 65u);
    }
    return;
  }
  if stage == 65u {
    complete_expression(numeric_conversion_result(node.payload));
    return;
  }

  if stage == 70u {
    frame_set(frame, 3u, state.returned_type);
    frame_set(frame, 5u, node.child1);
    if start_prune(state.returned_type) { frame_set(frame, 1u, 79u); }
    return;
  }
  if stage == 79u {
    if type_get(state.returned_type, 0u) == TYPE_NAMED {
      let type_index = type_get(state.returned_type, 1u);
      frame_set(frame, 6u, type_index);
      if indexed_metadata_is_available() {
        frame_set(frame, 1u, select(
          81u, 83u, schema_words[indexed_metadata_base(7u) + type_index] != 0u));
        return;
      }
      frame_set(frame, 7u, 0u);
      frame_set(frame, 1u, 80u);
    } else {
      frame_set(frame, 1u, 81u);
    }
    return;
  }
  if stage == 80u {
    let type_index = frame_get(frame, 6u);
    let offset = frame_get(frame, 7u);
    if offset >= type_metadata(type_index, 3u) {
      frame_set(frame, 1u, 81u);
      return;
    }
    let constructor_index = type_metadata(type_index, 2u) + offset;
    if constructor_result_is_explicit(constructor_index) {
      frame_set(frame, 1u, 83u);
      return;
    }
    frame_set(frame, 7u, offset + 1u);
    return;
  }
  if stage == 81u {
    let arm_index = frame_get(frame, 5u);
    if arm_index == NO_INDEX {
      if !require_type_slots(1u) { return; }
      frame_set(frame, 4u, fresh_variable());
      frame_set(frame, 5u, node.child1);
      frame_set(frame, 6u, NO_INDEX);
      frame_set(frame, 8u, node.child1);
      frame_set(frame, 1u, select(71u, 78u, node.child1 == NO_INDEX));
      return;
    }
    let constructor_index = core_node(arm_index).payload;
    frame_set(frame, 5u, core_node(arm_index).child1);
    let type_index = constructor_record(constructor_index).type_index;
    frame_set(frame, 6u, type_index);
    if indexed_metadata_is_available() {
      frame_set(frame, 1u, select(
        81u, 83u, schema_words[indexed_metadata_base(7u) + type_index] != 0u));
      return;
    }
    frame_set(frame, 7u, 0u);
    frame_set(frame, 1u, 80u);
    return;
  }
  if stage == 83u {
    if start_fully_zonked(frame_get(frame, 3u)) { frame_set(frame, 1u, 84u); }
    return;
  }
  if stage == 84u {
    if start_prune(frame_get(frame, 3u)) {
      frame_set(frame, 1u, select(87u, 86u, state.work_result == 0u));
    }
    return;
  }
  if stage == 87u {
    if type_get(state.returned_type, 0u) == TYPE_VARIABLE {
      if start_indexed_shape(frame_get(frame, 6u)) { frame_set(frame, 1u, 88u); }
      return;
    }
    let parameter_count = type_metadata(frame_get(frame, 6u), 1u);
    var identifier = 0u;
    if parameter_count > 0u {
      identifier = schema_words[
        state.type_parameter_base + type_metadata(frame_get(frame, 6u), 0u)];
    }
    if start_rigidify(frame_get(frame, 3u), identifier) { frame_set(frame, 1u, 93u); }
    return;
  }
  if stage == 88u {
    frame_set(frame, 7u, state.returned_type);
    if start_unify(
      frame_get(frame, 3u), state.returned_type, node.start_byte, node.end_byte) {
      frame_set(frame, 1u, 89u);
    }
    return;
  }
  if stage == 89u {
    let parameter_count = type_metadata(frame_get(frame, 6u), 1u);
    var identifier = 0u;
    if parameter_count > 0u {
      identifier = schema_words[
        state.type_parameter_base + type_metadata(frame_get(frame, 6u), 0u)];
    }
    if start_rigidify(frame_get(frame, 3u), identifier) { frame_set(frame, 1u, 93u); }
    return;
  }
  if stage == 93u {
    if start_fully_zonked(frame_get(frame, 3u)) { frame_set(frame, 1u, 85u); }
    return;
  }
  if stage == 85u {
    if state.work_result != 0u {
      report_metadata_diagnostic(
        METADATA_INDEXED_SCRUTINEE_UNRESOLVED, node.start_byte, node.end_byte,
        algebraic_type_record(frame_get(frame, 6u)).symbol,
        frame_get(frame, 3u), state.returned_type);
      return;
    }
    if start_prune(frame_get(frame, 3u)) { frame_set(frame, 1u, 86u); }
    return;
  }
  if stage == 86u {
    let scrutinee_type = state.returned_type;
    if type_get(scrutinee_type, 0u) != TYPE_NAMED ||
      type_get(scrutinee_type, 1u) != frame_get(frame, 6u) {
      report_metadata_diagnostic(
        METADATA_INDEXED_SCRUTINEE_TYPE_MISMATCH, node.start_byte, node.end_byte,
        algebraic_type_record(frame_get(frame, 6u)).symbol, scrutinee_type, NO_INDEX);
      return;
    }
    frame_set(frame, 3u, scrutinee_type);
    frame_set(frame, 5u, node.child1);
    frame_set(frame, 7u, 0u);
    frame_set(frame, 1u, 100u);
    return;
  }

  if stage == 78u {
    let scrutinee_type = state.returned_type;
    if type_get(scrutinee_type, 0u) == TYPE_NAMED {
      let type_index = type_get(scrutinee_type, 1u);
      let constructor_count = type_metadata(type_index, 3u);
      if constructor_count == 0u {
        complete_expression(frame_get(frame, 4u));
        return;
      }
      report_diagnostic_with_operands(
        ERROR_NON_EXHAUSTIVE_CASE, node.start_byte, node.end_byte,
        constructor_record(algebraic_type_record(type_index).first_constructor).symbol,
        NO_INDEX, NO_INDEX);
      return;
    }
    report_metadata_diagnostic(
      METADATA_INVALID_EMPTY_CASE_SCRUTINEE, node.start_byte, node.end_byte,
      NO_INDEX, scrutinee_type, NO_INDEX);
    return;
  }
  if stage == 71u {
    let arm_index = frame_get(frame, 5u);
    if arm_index == NO_INDEX {
      let matched_type = frame_get(frame, 6u);
      if matched_type == NO_INDEX {
        complete_expression(frame_get(frame, 4u));
        return;
      }
      if start_case_coverage(matched_type, frame_get(frame, 8u)) {
        frame_set(frame, 1u, 76u);
      }
      return;
    }
    let constructor_index = core_node(arm_index).payload;
    if !start_constructor(constructor_index, 0u, 0u) { return; }
    frame_set(frame, 7u, constructor_index);
    frame_set(frame, 1u, 75u);
    return;
  }
  if stage == 75u {
    let arm_index = frame_get(frame, 5u);
    if !start_unify(frame_get(frame, 3u), state.returned_type,
      core_node(arm_index).start_byte, core_node(arm_index).end_byte) { return; }
    frame_set(frame, 1u, 73u);
    return;
  }
  if stage == 73u {
    let arm_index = frame_get(frame, 5u);
    let constructor_index = frame_get(frame, 7u);
    if frame_get(frame, 6u) == NO_INDEX {
      frame_set(frame, 6u, constructor_record(constructor_index).type_index);
    }
    if !start_case_bind(arm_index, constructor_index, environment) { return; }
    frame_set(frame, 1u, 77u);
    return;
  }
  if stage == 77u {
    if !require_frame_slots(1u) { return; }
    let arm_index = frame_get(frame, 5u);
    frame_set(frame, 7u, core_node(arm_index).child1);
    frame_set(frame, 1u, 72u);
    push_expression(state.current_arm, state.returned_type);
    return;
  }
  if stage == 76u {
    if state.returned_type != NO_INDEX {
      report_diagnostic_with_operands(
        ERROR_NON_EXHAUSTIVE_CASE, node.start_byte, node.end_byte,
        state.returned_type, NO_INDEX, NO_INDEX);
      return;
    }
    complete_expression(frame_get(frame, 4u));
    return;
  }
  if stage == 72u {
    if !start_unify(frame_get(frame, 4u), state.returned_type,
      core_node(frame_get(frame, 5u)).start_byte,
      core_node(frame_get(frame, 5u)).end_byte) { return; }
    frame_set(frame, 1u, 74u);
    return;
  }
  if stage == 74u {
    frame_set(frame, 5u, frame_get(frame, 7u));
    frame_set(frame, 1u, 71u);
    return;
  }

  if stage == 100u {
    let arm_index = frame_get(frame, 5u);
    if arm_index == NO_INDEX {
      frame_set(frame, 7u, 0u);
      frame_set(frame, 1u, 110u);
      return;
    }
    let constructor_index = core_node(arm_index).payload;
    let previous_cutoff = state.untouchable_type_cutoff;
    let arm_cutoff = state.type_top;
    if !start_constructor(constructor_index, 0u, 1u) { return; }
    frame_set(frame, 4u, previous_cutoff);
    frame_set(frame, 9u, state.refinement_top);
    state.untouchable_type_cutoff = arm_cutoff;
    frame_set(frame, 7u, constructor_index);
    frame_set(frame, 1u, 101u);
    return;
  }
  if stage == 101u {
    frame_set(frame, 8u, state.returned_type);
    if start_pattern_match(state.returned_type, frame_get(frame, 3u)) {
      frame_set(frame, 1u, 102u);
    }
    return;
  }
  if stage == 102u {
    if state.work_result != 0u {
      if start_refinement_rollback(frame_get(frame, 9u)) { frame_set(frame, 1u, 108u); }
      return;
    }
    if !start_case_bind(
      frame_get(frame, 5u), frame_get(frame, 7u), environment) { return; }
    frame_set(frame, 1u, 103u);
    return;
  }
  if stage == 103u {
    if frame_get(frame, 11u) == NO_INDEX {
      if !require_frame_slots(1u) { return; }
      frame_set(frame, 1u, 115u);
      if push_expression(state.current_arm, state.returned_type) {
        frame_set(state.frame_top - 1u, 11u, NO_INDEX);
      }
      return;
    }
    frame_set(frame, 8u, state.returned_type);
    if start_fully_zonked(frame_get(frame, 11u)) { frame_set(frame, 1u, 107u); }
    return;
  }
  if stage == 107u {
    if !require_frame_slots(1u) { return; }
    frame_set(frame, 1u, select(115u, 104u, state.work_result == 0u));
    if push_expression(state.current_arm, frame_get(frame, 8u)) {
      frame_set(state.frame_top - 1u, 11u, frame_get(frame, 11u));
    }
    return;
  }
  if stage == 104u {
    let arm = core_node(frame_get(frame, 5u));
    if start_unify(frame_get(frame, 11u), state.returned_type, arm.start_byte, arm.end_byte) {
      frame_set(frame, 1u, 105u);
    }
    return;
  }
  if stage == 105u {
    if start_refinement_rollback(frame_get(frame, 9u)) { frame_set(frame, 1u, 106u); }
    return;
  }
  if stage == 106u {
    state.untouchable_type_cutoff = frame_get(frame, 4u);
    frame_set(frame, 5u, core_node(frame_get(frame, 5u)).child1);
    frame_set(frame, 1u, 100u);
    return;
  }
  if stage == 108u {
    state.untouchable_type_cutoff = frame_get(frame, 4u);
    let arm = core_node(frame_get(frame, 5u));
    state.error_context = TYPE_MISMATCH_INACCESSIBLE_CONSTRUCTOR;
    report_diagnostic_with_operands(
      ERROR_TYPE_MISMATCH, arm.start_byte, arm.end_byte,
      frame_get(frame, 7u), frame_get(frame, 8u), frame_get(frame, 3u));
    return;
  }
  if stage == 115u {
    frame_set(frame, 7u, state.returned_type);
    if frame_get(frame, 11u) != NO_INDEX {
      if start_prune(state.returned_type) { frame_set(frame, 1u, 119u); }
      return;
    }
    if start_stable_concrete(state.returned_type) { frame_set(frame, 1u, 116u); }
    return;
  }
  if stage == 119u {
    frame_set(frame, 8u, state.returned_type);
    if start_prune(frame_get(frame, 11u)) { frame_set(frame, 1u, 120u); }
    return;
  }
  if stage == 120u {
    if state.returned_type == frame_get(frame, 8u) {
      frame_set(frame, 7u, frame_get(frame, 11u));
      if start_refinement_rollback(frame_get(frame, 9u)) { frame_set(frame, 1u, 117u); }
      return;
    }
    if start_stable_concrete(frame_get(frame, 7u)) { frame_set(frame, 1u, 116u); }
    return;
  }
  if stage == 116u {
    if state.work_result == 0u {
      report_metadata_diagnostic(
        METADATA_INDEXED_EXPECTED_TYPE_MISSING, node.start_byte, node.end_byte,
        algebraic_type_record(frame_get(frame, 6u)).symbol, NO_INDEX, NO_INDEX);
      return;
    }
    if start_refinement_rollback(frame_get(frame, 9u)) { frame_set(frame, 1u, 117u); }
    return;
  }
  if stage == 117u {
    state.untouchable_type_cutoff = frame_get(frame, 4u);
    if frame_get(frame, 11u) == NO_INDEX {
      frame_set(frame, 11u, frame_get(frame, 7u));
      frame_set(frame, 5u, core_node(frame_get(frame, 5u)).child1);
      frame_set(frame, 1u, 100u);
      return;
    }
    let arm = core_node(frame_get(frame, 5u));
    if start_unify(frame_get(frame, 11u), frame_get(frame, 7u), arm.start_byte, arm.end_byte) {
      frame_set(frame, 1u, 118u);
    }
    return;
  }
  if stage == 118u {
    frame_set(frame, 5u, core_node(frame_get(frame, 5u)).child1);
    frame_set(frame, 1u, 100u);
    return;
  }

  if stage == 110u {
    let offset = frame_get(frame, 7u);
    let type_index = frame_get(frame, 6u);
    if offset >= type_metadata(type_index, 3u) {
      complete_expression(frame_get(frame, 11u));
      return;
    }
    let constructor_index = type_metadata(type_index, 2u) + offset;
    frame_set(frame, 8u, constructor_index);
    frame_set(frame, 9u, state.refinement_top);
    if start_constructor(constructor_index, 0u, 1u) { frame_set(frame, 1u, 111u); }
    return;
  }
  if stage == 111u {
    if start_pattern_match(state.returned_type, frame_get(frame, 3u)) {
      frame_set(frame, 1u, 112u);
    }
    return;
  }
  if stage == 112u {
    frame_set(frame, 5u, state.work_result);
    if start_refinement_rollback(frame_get(frame, 9u)) { frame_set(frame, 1u, 113u); }
    return;
  }
  if stage == 113u {
    if frame_get(frame, 5u) != 0u {
      frame_set(frame, 7u, frame_get(frame, 7u) + 1u);
      frame_set(frame, 1u, 110u);
      return;
    }
    frame_set(frame, 5u, node.child1);
    frame_set(frame, 1u, 114u);
    return;
  }
  if stage == 114u {
    let arm_index = frame_get(frame, 5u);
    if arm_index == NO_INDEX {
      report_diagnostic_with_operands(
        ERROR_NON_EXHAUSTIVE_CASE, node.start_byte, node.end_byte,
        constructor_record(frame_get(frame, 8u)).symbol, NO_INDEX, NO_INDEX);
      return;
    }
    if core_node(arm_index).payload == frame_get(frame, 8u) {
      frame_set(frame, 7u, frame_get(frame, 7u) + 1u);
      frame_set(frame, 1u, 110u);
      return;
    }
    frame_set(frame, 5u, core_node(arm_index).child1);
    return;
  }
}

fn required_child_is_valid(parent_index: u32, child_index: u32) -> bool {
  return child_index != NO_INDEX && child_index < state.node_count && child_index > parent_index;
}

fn optional_child_is_valid(parent_index: u32, child_index: u32) -> bool {
  return child_index == NO_INDEX || required_child_is_valid(parent_index, child_index);
}

fn node_shape_is_valid(node_index: u32) -> bool {
  let node = core_node(node_index);
  if node.start_byte > node.end_byte || node.evaluation_mode > 1u { return false; }
  if node.tag == TAG_INTEGER || node.tag == TAG_BOOLEAN || node.tag == TAG_FLOAT_32 ||
    node.tag == TAG_LOCAL ||
    node.tag == TAG_GLOBAL || node.tag == TAG_CONSTRUCTOR {
    return node.child0 == NO_INDEX && node.child1 == NO_INDEX && node.child2 == NO_INDEX &&
      node.evaluation_mode == 0u &&
      (node.tag != TAG_BOOLEAN || node.payload <= 1u) &&
      (node.tag != TAG_GLOBAL || node.payload < state.definition_count) &&
      (node.tag != TAG_CONSTRUCTOR || node.payload < state.constructor_count);
  }
  if node.tag == TAG_SIGNED_INTEGER_64 || node.tag == TAG_FLOAT_64 {
    return node.child1 == NO_INDEX && node.child2 == NO_INDEX && node.evaluation_mode == 0u;
  }
  if node.tag == TAG_WHOLE_NUMBER_F64 {
    return node.child1 < state.type_count && node.child2 == NO_INDEX &&
      node.evaluation_mode == 0u;
  }
  if node.tag == TAG_TEXT || node.tag == TAG_BYTES {
    return node.child0 < state.type_count && node.child1 == NO_INDEX && node.child2 == NO_INDEX &&
      node.evaluation_mode == 0u;
  }
  if node.tag == TAG_RUNTIME_FAULT {
    return node.child0 == NO_INDEX && node.child1 == NO_INDEX && node.child2 == NO_INDEX &&
      node.evaluation_mode == 0u;
  }
  if node.tag == TAG_LET || node.tag == TAG_LET_REC || node.tag == TAG_APPLY ||
    node.tag == TAG_BINARY || node.tag == TAG_BUFFER_APPEND {
    let whole_number = node.tag == TAG_BINARY &&
      node.payload >= BINARY_EQUAL_WHOLE_NUMBER_F64 &&
      node.payload <= BINARY_REMAINDER_WHOLE_NUMBER_F64;
    return required_child_is_valid(node_index, node.child0) &&
      required_child_is_valid(node_index, node.child1) &&
      select(
        node.child2 == NO_INDEX,
        node.child2 < state.type_count,
        whole_number || node.tag == TAG_BUFFER_APPEND,
      ) &&
      (node.evaluation_mode == 0u || node.tag == TAG_LET || node.tag == TAG_APPLY) &&
      (node.tag != TAG_BUFFER_APPEND || node.payload == 0u) &&
      (node.tag != TAG_LET_REC || core_node(node.child0).tag == TAG_LAMBDA) &&
      (node.tag != TAG_BINARY || (node.payload >= 1u && node.payload <= 65u));
  }
  if node.tag == TAG_IF {
    return required_child_is_valid(node_index, node.child0) &&
      required_child_is_valid(node_index, node.child1) &&
      required_child_is_valid(node_index, node.child2) && node.evaluation_mode == 0u;
  }
  if node.tag == TAG_LAMBDA || node.tag == TAG_UNARY ||
    node.tag == TAG_NUMERIC_CONVERT || node.tag == TAG_PATTERN_BIND {
    let whole_number = node.tag == TAG_UNARY &&
      node.payload == ${LazuliUnaryOperator.NegateWholeNumberF64}u;
    return required_child_is_valid(node_index, node.child0) &&
      select(node.child1 == NO_INDEX, node.child1 < state.type_count, whole_number) &&
      node.child2 == NO_INDEX && node.evaluation_mode == 0u &&
      (node.tag != TAG_UNARY || (node.payload >= 1u && node.payload <= 6u)) &&
      (node.tag != TAG_NUMERIC_CONVERT || (node.payload >= 1u && node.payload <= 14u));
  }
  if node.tag == TAG_CASE {
    return required_child_is_valid(node_index, node.child0) &&
      optional_child_is_valid(node_index, node.child1) && node.child2 == NO_INDEX &&
      node.evaluation_mode == 0u;
  }
  if node.tag == TAG_CASE_ARM {
    return required_child_is_valid(node_index, node.child0) &&
      optional_child_is_valid(node_index, node.child1) && node.child2 == NO_INDEX &&
      node.payload < state.constructor_count && node.evaluation_mode == 0u;
  }
  return false;
}

fn workspace_region_is_valid(base: u32, records: u32, words: u32) -> bool {
  let length = arrayLength(&workspace);
  return base <= length && records <= (length - base) / words;
}

fn regions_overlap(left_base: u32, left_words: u32, right_base: u32, right_words: u32) -> bool {
  return left_words > 0u && right_words > 0u &&
    left_base < right_base + right_words && right_base < left_base + left_words;
}

fn validation_transition() {
  if state.frame_top > 0u {
    work_transition();
    return;
  }
  let section = state.validation_section;
  let index = state.cursor;
  if section == 0u {
    let schema_length = arrayLength(&schema_words);
    let scratch_required = state.definition_count * 8u;
    if state.maximum_transitions_per_dispatch == 0u ||
      !range_is_valid(state.semantic.phase, state.node_count, arrayLength(&core_nodes)) ||
      !range_is_valid(
        state.semantic.primary_cursor,
        state.definition_count,
        arrayLength(&definitions),
      ) ||
      !range_is_valid(
        state.semantic.secondary_cursor,
        state.type_count,
        arrayLength(&algebraic_types),
      ) ||
      !range_is_valid(
        state.semantic.tertiary_cursor,
        state.constructor_count,
        arrayLength(&constructors),
      ) ||
      !range_is_valid(
        state.schema_base, state.schema_node_count * 6u, schema_length) ||
      !range_is_valid(state.definition_annotation_base, state.definition_count, schema_length) ||
      !range_is_valid(state.type_parameter_base, state.type_parameter_count, schema_length) ||
      !range_is_valid(state.type_parameter_offsets_base, state.type_count + 1u, schema_length) ||
      !range_is_valid(state.constructor_field_base, state.constructor_field_count, schema_length) ||
      !range_is_valid(state.constructor_field_offsets_base,
        state.constructor_count + 1u, schema_length) ||
      !range_is_valid(state.constructor_result_base, state.constructor_count, schema_length) ||
      !workspace_region_is_valid(state.type_base, state.type_capacity, TYPE_RECORD_WORDS) ||
      !workspace_region_is_valid(state.environment_base, state.environment_capacity,
        ENVIRONMENT_WORDS) ||
      !workspace_region_is_valid(state.frame_base, state.frame_capacity, FRAME_WORDS) ||
      !workspace_region_is_valid(
        state.refinement_base, state.refinement_capacity, REFINEMENT_WORDS) ||
      !range_is_valid(state.scratch_base, state.scratch_capacity, arrayLength(&workspace)) ||
      regions_overlap(state.type_base, state.type_capacity * TYPE_RECORD_WORDS,
        state.environment_base, state.environment_capacity * ENVIRONMENT_WORDS) ||
      regions_overlap(state.type_base, state.type_capacity * TYPE_RECORD_WORDS,
        state.frame_base, state.frame_capacity * FRAME_WORDS) ||
      regions_overlap(state.type_base, state.type_capacity * TYPE_RECORD_WORDS,
        state.refinement_base, state.refinement_capacity * REFINEMENT_WORDS) ||
      regions_overlap(state.type_base, state.type_capacity * TYPE_RECORD_WORDS,
        state.scratch_base, state.scratch_capacity) ||
      regions_overlap(state.environment_base, state.environment_capacity * ENVIRONMENT_WORDS,
        state.frame_base, state.frame_capacity * FRAME_WORDS) ||
      regions_overlap(state.environment_base, state.environment_capacity * ENVIRONMENT_WORDS,
        state.refinement_base, state.refinement_capacity * REFINEMENT_WORDS) ||
      regions_overlap(state.environment_base, state.environment_capacity * ENVIRONMENT_WORDS,
        state.scratch_base, state.scratch_capacity) ||
      regions_overlap(state.frame_base, state.frame_capacity * FRAME_WORDS,
        state.refinement_base, state.refinement_capacity * REFINEMENT_WORDS) ||
      regions_overlap(state.frame_base, state.frame_capacity * FRAME_WORDS,
        state.scratch_base, state.scratch_capacity) ||
      regions_overlap(state.refinement_base, state.refinement_capacity * REFINEMENT_WORDS,
        state.scratch_base, state.scratch_capacity) ||
      state.scratch_capacity < scratch_required ||
      !range_is_valid(
        state.semantic.resolution_node,
        state.output_capacity,
        arrayLength(&output_types),
      ) {
      invalid_input(ERROR_INVALID_SURFACE, 0u);
      return;
    }
    state.validation_section = 1u;
    state.cursor = 0u;
    return;
  }
  if section == 1u {
    if index >= state.node_count {
      state.validation_section = 2u; state.cursor = 0u; return;
    }
    if !node_shape_is_valid(index) { invalid_input(ERROR_INVALID_SURFACE, index); return; }
    state.cursor += 1u;
    return;
  }
  if section == 2u {
    if index >= state.definition_count {
      state.validation_section = 3u; state.cursor = 0u; return;
    }
    let definition = definition_record(index);
    var root_order_is_valid = definition.root_node == 0u;
    if index > 0u {
      root_order_is_valid = definition.root_node > definition_record(index - 1u).root_node;
    }
    if definition.root_node >= state.node_count || definition.start_byte > definition.end_byte ||
      !root_order_is_valid {
      invalid_input(ERROR_INVALID_SURFACE, index); return;
    }
    let annotation = schema_words[state.definition_annotation_base + index];
    if annotation != NO_INDEX && annotation >= state.schema_node_count {
      report_metadata_diagnostic(
        METADATA_INVALID_DEFINITION_ANNOTATION,
        definition.start_byte,
        definition.end_byte,
        index,
        annotation,
        state.schema_node_count,
      );
      return;
    }
    state.cursor += 1u;
    return;
  }
  if section == 3u {
    if index >= state.type_count {
      state.validation_section = 4u; state.cursor = 0u; state.substage = 0u; return;
    }
    let declared = algebraic_type_record(index);
    let first_parameter = type_metadata(index, 0u);
    let parameter_count = type_metadata(index, 1u);
    let first_constructor = type_metadata(index, 2u);
    let constructor_count = type_metadata(index, 3u);
    if state.substage == 0u {
      if declared.start_byte > declared.end_byte ||
        first_parameter > state.type_parameter_count ||
        parameter_count > state.type_parameter_count - first_parameter ||
        first_constructor != declared.first_constructor ||
        constructor_count != declared.constructor_count ||
        first_constructor > state.constructor_count ||
        constructor_count > state.constructor_count - first_constructor {
        report_metadata_diagnostic(
          METADATA_INVALID_TYPE_DECLARATION, declared.start_byte, declared.end_byte,
          index, constructor_count, parameter_count);
        return;
      }
      if indexed_metadata_is_available() {
        let record = indexed_metadata_base(3u) + index * VALIDATION_RECORD_WORDS;
        let context = schema_words[record];
        if context != 0u {
          report_metadata_diagnostic(
            context,
            schema_words[record + 1u],
            schema_words[record + 2u],
            schema_words[record + 3u],
            schema_words[record + 4u],
            schema_words[record + 5u],
          );
          return;
        }
        state.cursor += 1u;
        return;
      }
      state.cursor0 = 0u; state.substage = 1u;
      return;
    }
    if state.substage == 1u {
      if state.cursor0 >= index {
        state.cursor0 = 0u; state.cursor1 = 0u; state.substage = 2u;
        return;
      }
      if algebraic_type_record(state.cursor0).symbol == declared.symbol {
        report_metadata_diagnostic(
          METADATA_DUPLICATE_TYPE_NAME, declared.start_byte, declared.end_byte,
          declared.symbol, state.cursor0, index);
        return;
      }
      state.cursor0 += 1u;
      return;
    }
    if state.cursor0 >= parameter_count {
      state.cursor += 1u; state.substage = 0u;
      return;
    }
    if state.cursor1 >= state.cursor0 {
      state.cursor0 += 1u; state.cursor1 = 0u;
      return;
    }
    if schema_words[state.type_parameter_base + first_parameter + state.cursor0] ==
      schema_words[state.type_parameter_base + first_parameter + state.cursor1] {
      report_metadata_diagnostic(
        METADATA_REPEATED_TYPE_PARAMETER, declared.start_byte, declared.end_byte,
        declared.symbol,
        schema_words[state.type_parameter_base + first_parameter + state.cursor0],
        state.cursor0);
      return;
    }
    state.cursor1 += 1u;
    return;
  }
  if section == 4u {
    if index >= state.constructor_count {
      state.validation_section = 5u; state.cursor = 0u; state.substage = 0u; return;
    }
    let constructor = constructor_record(index);
    let first_field = constructor_metadata(index, 0u);
    let field_count = constructor_metadata(index, 1u);
    let result_root = constructor_metadata(index, 2u);
    if state.substage == 0u {
      if field_count != constructor.arity {
        report_metadata_diagnostic(
          METADATA_CONSTRUCTOR_FIELD_COUNT_MISMATCH,
          constructor.start_byte, constructor.end_byte, constructor.symbol,
          constructor.arity, field_count);
        return;
      }
      if constructor.type_index >= state.type_count ||
        constructor.arity > MAXIMUM_CONSTRUCTOR_ARITY ||
        constructor.start_byte > constructor.end_byte ||
        first_field > state.constructor_field_count ||
        field_count > state.constructor_field_count - first_field {
        report_metadata_diagnostic(
          METADATA_INVALID_CONSTRUCTOR, constructor.start_byte, constructor.end_byte,
          index, constructor.type_index, constructor.arity);
        return;
      }
      let declared = algebraic_type_record(constructor.type_index);
      if index < declared.first_constructor ||
        index - declared.first_constructor >= declared.constructor_count {
        report_metadata_diagnostic(
          METADATA_INVALID_CONSTRUCTOR, constructor.start_byte, constructor.end_byte,
          index, constructor.type_index, declared.symbol);
        return;
      }
      if result_root >= state.schema_node_count {
        report_metadata_diagnostic(
          METADATA_INVALID_CONSTRUCTOR_RESULT,
          constructor.start_byte,
          constructor.end_byte,
          index,
          result_root,
          state.schema_node_count,
        );
        return;
      }
      state.cursor0 = 0u; state.substage = 1u;
      return;
    }
    if state.cursor0 >= field_count {
      state.cursor += 1u; state.substage = 0u;
      return;
    }
    let root = schema_words[state.constructor_field_base + first_field + state.cursor0];
    if root >= state.schema_node_count {
      report_metadata_diagnostic(
        METADATA_INVALID_CONSTRUCTOR_FIELD, constructor.start_byte, constructor.end_byte,
        constructor.symbol, state.cursor0, root);
      return;
    }
    state.cursor0 += 1u;
    return;
  }
  if section == 5u {
    if index >= state.schema_node_count {
      state.validation_section = 6u; state.cursor = 0u; state.substage = 0u; return;
    }
    let schema = schema_node(index);
    if state.substage == 0u {
      let synthetic_result_root = schema.start_byte == NO_INDEX && schema.end_byte == NO_INDEX;
      if synthetic_result_root {
        if indexed_metadata_is_available() {
          let constructor_index = schema_words[indexed_metadata_base(6u) + index];
          if constructor_index == NO_INDEX {
            report_metadata_diagnostic(
              METADATA_INVALID_SCHEMA_SHAPE, schema.start_byte, schema.end_byte,
              index, schema.tag, 0u);
            return;
          }
          state.work_result = constructor_index;
          state.substage = 4u;
          return;
        }
        state.work_result = NO_INDEX; state.cursor0 = 0u; state.substage = 3u; return;
      }
      if schema.start_byte > schema.end_byte {
        report_metadata_diagnostic(
          METADATA_INVALID_SCHEMA_SHAPE,
          validation_schema_start(schema), validation_schema_end(schema),
          index, schema.tag, 0u);
        return;
      }
    }
    if state.substage == 0u || state.substage == 4u {
      if schema.tag == SCHEMA_NAMED {
        if start_find_type(schema.payload) { state.substage = 1u; }
        return;
      }
      if schema.tag == SCHEMA_TUPLE || schema.tag == SCHEMA_FUNCTION {
        state.work_aux = 2u;
      } else if schema.tag == SCHEMA_FORALL {
        state.work_aux = 1u;
      } else if (schema.tag >= SCHEMA_INTEGER && schema.tag <= SCHEMA_PARAMETER) ||
        (schema.tag >= SCHEMA_SIGNED_INTEGER_64 && schema.tag <= SCHEMA_FLOAT_64) {
        state.work_aux = 0u;
      } else {
        report_metadata_diagnostic(
          METADATA_INVALID_SCHEMA_SHAPE,
          validation_schema_start(schema), validation_schema_end(schema),
          index, schema.tag, 0u);
        return;
      }
      state.cursor0 = schema.first_child; state.cursor1 = 0u; state.substage = 2u;
      return;
    }
    if state.substage == 3u {
      if state.cursor0 >= state.constructor_count {
        report_metadata_diagnostic(
          METADATA_INVALID_SCHEMA_SHAPE, schema.start_byte, schema.end_byte,
          index, schema.tag, 0u);
        return;
      }
      if constructor_metadata(state.cursor0, 2u) == index {
        state.work_result = state.cursor0; state.substage = 4u; return;
      }
      state.cursor0 += 1u;
      return;
    }
    if state.substage == 1u {
      if state.returned_type == NO_INDEX {
        report_metadata_diagnostic(
          METADATA_UNKNOWN_TYPE,
          validation_schema_start(schema), validation_schema_end(schema),
          schema.payload, NO_INDEX, NO_INDEX);
        return;
      }
      state.work_aux = type_metadata(state.returned_type, 1u);
      state.cursor0 = schema.first_child; state.cursor1 = 0u; state.substage = 2u;
      return;
    }
    if state.cursor0 == NO_INDEX {
      if state.cursor1 != state.work_aux {
        let context = select(
          METADATA_INVALID_SCHEMA_SHAPE, METADATA_TYPE_ARGUMENT_COUNT_MISMATCH,
          schema.tag == SCHEMA_NAMED);
        report_metadata_diagnostic(
          context, validation_schema_start(schema), validation_schema_end(schema),
          select(index, schema.payload, schema.tag == SCHEMA_NAMED),
          state.work_aux, state.cursor1);
        return;
      }
      state.cursor += 1u; state.substage = 0u;
      return;
    }
    let child = state.cursor0;
    if child >= state.schema_node_count || child <= index {
      report_metadata_diagnostic(
        METADATA_INVALID_SCHEMA_SHAPE,
        validation_schema_start(schema), validation_schema_end(schema),
        index, schema.tag, state.cursor1);
      return;
    }
    let next = schema_node(child).next_sibling;
    if next != NO_INDEX && (next >= state.schema_node_count || next <= child) {
      report_metadata_diagnostic(
        METADATA_INVALID_SCHEMA_SHAPE,
        validation_schema_start(schema), validation_schema_end(schema),
        index, schema.tag, state.cursor1);
      return;
    }
    state.cursor0 = next; state.cursor1 += 1u;
    return;
  }
  if section == 6u {
    if index >= state.constructor_count {
      state.validation_section = 7u; state.cursor = 0u; state.substage = 0u; return;
    }
    let constructor = constructor_record(index);
    let first_field = constructor_metadata(index, 0u);
    let field_count = constructor_metadata(index, 1u);
    let result_root = constructor_metadata(index, 2u);
    if state.substage == 0u {
      if indexed_metadata_is_available() {
        let record = indexed_metadata_base(4u) + index * VALIDATION_RECORD_WORDS;
        let context = schema_words[record];
        if context != 0u {
          report_metadata_diagnostic(
            context,
            schema_words[record + 1u],
            schema_words[record + 2u],
            schema_words[record + 3u],
            schema_words[record + 4u],
            schema_words[record + 5u],
          );
          return;
        }
        state.cursor += 1u;
        return;
      }
      state.cursor0 = 0u; state.substage = 1u; return;
    }
    if state.substage == 2u {
      if state.work_result != 0u {
        let schema = schema_node(state.returned_type);
        report_metadata_diagnostic(
          METADATA_UNDECLARED_TYPE_PARAMETER, schema.start_byte, schema.end_byte,
          schema.payload, constructor.type_index, constructor.symbol);
        return;
      }
      state.cursor0 += 1u; state.substage = 1u; return;
    }
    if state.substage == 3u {
      if state.work_result != 0u {
        let schema = schema_node(state.returned_type);
        report_metadata_diagnostic(
          METADATA_UNDECLARED_TYPE_PARAMETER, schema.start_byte, schema.end_byte,
          schema.payload, constructor.type_index, constructor.symbol);
        return;
      }
      let result_schema = schema_node(result_root);
      let declared = algebraic_type_record(constructor.type_index);
      var result_head_is_valid = result_schema.tag == SCHEMA_NAMED &&
        result_schema.payload == declared.symbol;
      if constructor.type_index + 2u == state.type_count {
        result_head_is_valid = result_schema.tag == SCHEMA_UNIT;
      } else if constructor.type_index + 1u == state.type_count {
        result_head_is_valid = result_schema.tag == SCHEMA_TUPLE;
      }
      if !result_head_is_valid {
        report_metadata_diagnostic(
          METADATA_INVALID_CONSTRUCTOR_RESULT,
          result_schema.start_byte,
          result_schema.end_byte,
          index,
          result_root,
          declared.symbol,
        );
        return;
      }
      state.cursor0 = 0u; state.substage = 4u;
      return;
    }
    if state.substage == 5u {
      state.cursor0 += 1u; state.substage = 4u; return;
    }
    if state.substage == 4u {
      if state.cursor0 >= field_count {
        state.cursor += 1u; state.substage = 0u; return;
      }
      let field_root = schema_words[state.constructor_field_base + first_field + state.cursor0];
      if start_field_parameter_recoverability(field_root, result_root, index) {
        state.substage = 5u;
      }
      return;
    }
    if state.cursor0 >= field_count {
      if start_schema_parameter_check(result_root, constructor.type_index) {
        state.substage = 3u;
      }
      return;
    }
    let root = schema_words[state.constructor_field_base + first_field + state.cursor0];
    if start_schema_parameter_check(root, constructor.type_index) {
      state.substage = 2u;
    }
    return;
  }
  if section == 7u {
    if index >= state.definition_count {
      state.validation_section = 8u; state.cursor = 0u; return;
    }
    scratch_set(0u, index, NO_INDEX);
    scratch_set(1u, index, NO_INDEX);
    scratch_set(2u, index, NO_INDEX);
    scratch_set(3u, index, 0u);
    state.cursor += 1u;
    return;
  }
  if section == 8u {
    if state.substage == 0u {
      state.type_top = 0u; state.cursor0 = 0u; state.substage = 1u;
      return;
    }
    if state.substage <= 6u {
      if !require_type_slots(1u) { return; }
      var kind = TYPE_INTEGER;
      if state.substage == 2u { kind = TYPE_BOOLEAN; }
      else if state.substage == 3u { kind = TYPE_UNIT; }
      else if state.substage == 4u { kind = TYPE_SIGNED_INTEGER_64; }
      else if state.substage == 5u { kind = TYPE_FLOAT_32; }
      else if state.substage == 6u { kind = TYPE_FLOAT_64; }
      let expected = state.substage - 1u;
      if allocate_type(kind, NO_INDEX, NO_INDEX, NO_INDEX) != expected {
        invalid_input(ERROR_INVALID_SURFACE, expected);
        return;
      }
      state.substage += 1u;
      return;
    }
    if state.cursor0 >= state.definition_count {
      report_diagnostic_with_operands(
        ERROR_NON_CONCRETE_MAIN, 0u, 0u, state.main_symbol, NO_INDEX, NO_INDEX);
      return;
    }
    if definition_record(state.cursor0).symbol != state.main_symbol {
      state.cursor0 += 1u;
      return;
    }
    state.main_definition = state.cursor0;
    state.phase = PHASE_TARJAN;
    state.cursor = 0u;
    state.substage = 0u;
    return;
  }
}

fn definition_node_end(definition_index: u32) -> u32 {
  if definition_index + 1u < state.definition_count {
    return definition_record(definition_index + 1u).root_node;
  }
  return state.node_count;
}

fn enter_tarjan_definition(definition_index: u32) {
  let index = state.tarjan_next_index;
  state.tarjan_next_index += 1u;
  scratch_set(1u, definition_index, index);
  scratch_set(2u, definition_index, index);
  scratch_set(3u, definition_index, 1u);
  scratch_set(4u, state.tarjan_stack_top, definition_index);
  state.tarjan_stack_top += 1u;
  scratch_set(5u, state.tarjan_dfs_top, definition_index);
  scratch_set(6u, state.tarjan_dfs_top, definition_record(definition_index).root_node);
  state.tarjan_dfs_top += 1u;
}

fn tarjan_transition() {
  if state.tarjan_stage == 1u {
    if state.tarjan_stack_top == 0u {
      invalid_input(ERROR_INVALID_SURFACE, state.tarjan_component_root);
      return;
    }
    state.tarjan_stack_top -= 1u;
    let member = scratch_get(4u, state.tarjan_stack_top);
    scratch_set(3u, member, 0u);
    scratch_set(7u, state.component_count, member);
    state.component_count += 1u;
    if member != state.tarjan_component_root { return; }
    state.tarjan_stage = 0u;
    state.component_stage = 0u;
    state.component_cursor = 0u;
    state.component_recursive = select(
      0u,
      1u,
      state.component_count > 1u || scratch_get(0u, member) == 0u,
    );
    state.expression_definition = NO_INDEX;
    state.current_level = 1u;
    state.phase = PHASE_COMPONENT;
    return;
  }
  if state.tarjan_dfs_top == 0u {
    if state.tarjan_root_cursor >= state.definition_count {
      state.phase = PHASE_SERIALIZE;
      return;
    }
    let root = state.tarjan_root_cursor;
    state.tarjan_root_cursor += 1u;
    if scratch_get(1u, root) == NO_INDEX {
      enter_tarjan_definition(root);
    }
    return;
  }

  let depth = state.tarjan_dfs_top - 1u;
  let current = scratch_get(5u, depth);
  let node_index = scratch_get(6u, depth);
  if node_index < definition_node_end(current) {
    scratch_set(6u, depth, node_index + 1u);
    let node = core_node(node_index);
    if node.tag != TAG_GLOBAL { return; }
    let dependency = node.payload;
    if dependency == current { scratch_set(0u, current, 0u); }
    if scratch_get(1u, dependency) == NO_INDEX {
      enter_tarjan_definition(dependency);
      return;
    }
    if scratch_get(3u, dependency) != 0u {
      scratch_set(2u, current, min(scratch_get(2u, current), scratch_get(1u, dependency)));
    }
    return;
  }

  state.tarjan_dfs_top -= 1u;
  if state.tarjan_dfs_top > 0u {
    let parent = scratch_get(5u, state.tarjan_dfs_top - 1u);
    scratch_set(2u, parent, min(scratch_get(2u, parent), scratch_get(2u, current)));
  }
  if scratch_get(2u, current) != scratch_get(1u, current) { return; }

  state.component_count = 0u;
  state.tarjan_component_root = current;
  state.tarjan_stage = 1u;
}

fn component_transition() {
  if state.frame_top > 0u &&
    frame_get(state.frame_top - 1u, 10u) != FRAME_EXPRESSION {
    work_transition();
    return;
  }
  let stage = state.component_stage;
  let cursor = state.component_cursor;
  if stage == 0u {
    if cursor >= state.component_count {
      state.component_stage = 1u; state.component_cursor = 0u; return;
    }
    if !require_type_slots(1u) { return; }
    let definition_index = scratch_get(7u, cursor);
    scratch_set(0u, definition_index, fresh_variable());
    if state.status == STATUS_PENDING { state.component_cursor += 1u; }
    return;
  }
  if stage == 1u {
    if cursor >= state.component_count {
      state.component_stage = 2u; state.component_cursor = 0u; state.substage = 0u; return;
    }
    let definition_index = scratch_get(7u, cursor);
    if state.substage == 2u {
      state.substage = 0u;
      state.component_cursor += 1u;
      return;
    }
    let root = schema_words[state.definition_annotation_base + definition_index];
    if root != NO_INDEX {
      if state.substage == 0u {
        if start_schema_convert(root, 0u, 1u) { state.substage = 1u; }
        return;
      }
      if !start_unify(scratch_get(0u, definition_index), state.returned_type,
        schema_node(root).start_byte, schema_node(root).end_byte) { return; }
      state.substage = 2u;
      return;
    }
    state.component_cursor += 1u;
    return;
  }
  if stage == 2u {
    if cursor >= state.component_count {
      state.component_stage = 3u; state.component_cursor = 0u;
      state.expression_definition = NO_INDEX;
      return;
    }
    let definition_index = scratch_get(7u, cursor);
    if state.expression_definition == NO_INDEX {
      if !require_frame_slots(1u) { return; }
      state.frame_top = 0u;
      state.returned_type = NO_INDEX;
      state.expression_definition = definition_index;
      if push_expression(definition_record(definition_index).root_node, NO_INDEX) {
        frame_set(state.frame_top - 1u, 11u, scratch_get(0u, definition_index));
      }
      return;
    }
    if state.frame_top > 0u {
      expression_transition();
      return;
    }
    if state.substage == 1u {
      state.substage = 0u;
      state.expression_definition = NO_INDEX;
      state.component_cursor += 1u;
      return;
    }
    let root = definition_record(definition_index).root_node;
    if start_unify(scratch_get(0u, definition_index), state.returned_type,
      core_node(root).start_byte, core_node(root).end_byte) {
      state.substage = 1u;
    }
    return;
  }
  if stage == 3u {
    if cursor >= state.component_count {
      state.current_level = 0u;
      state.component_count = 0u;
      state.phase = PHASE_TARJAN;
      return;
    }
    let definition_index = scratch_get(7u, cursor);
    if state.substage == 1u {
      state.substage = 0u;
      state.component_cursor += 1u;
      return;
    }
    if start_generalize(scratch_get(0u, definition_index), 0u) {
      state.substage = 1u;
    }
    return;
  }
}

fn reserve_output(count: u32) -> u32 {
  if state.output_count > state.output_capacity || count > state.output_capacity - state.output_count {
    exhausted(ERROR_OUTPUT_ARENA_EXHAUSTED, state.output_count + count);
    return NO_INDEX;
  }
  let first = state.output_count;
  state.output_count += count;
  return first;
}

fn push_serialization_task(type_index: u32, output_index: u32) -> bool {
  if state.frame_top >= state.frame_capacity {
    exhausted(ERROR_FRAME_ARENA_EXHAUSTED, state.frame_top + 1u);
    return false;
  }
  clear_frame(state.frame_top, FRAME_SERIALIZE);
  let address = frame_address(state.frame_top);
  workspace[address] = type_index;
  workspace[address + 1u] = output_index;
  workspace[address + 2u] = 0u;
  state.frame_top += 1u;
  return true;
}

fn require_output_slots(count: u32) -> bool {
  if state.output_count > state.output_capacity ||
    count > state.output_capacity - state.output_count {
    exhausted(ERROR_OUTPUT_ARENA_EXHAUSTED, state.output_count + count);
    return false;
  }
  return true;
}

fn initialize_output(index: u32, next_sibling: u32) {
  output_types[output_address(index)] = OutputTypeNode(
    0u, NO_INDEX, NO_INDEX, next_sibling, 0u, 0u);
}

fn write_output(index: u32, tag: u32, symbol: u32, first_child: u32) {
  output_types[output_address(index)] = OutputTypeNode(
    tag, symbol, first_child, output_types[output_address(index)].next_sibling, 0u, 0u);
}

fn serialize_main_type() {
  if state.frame_top > 0u && frame_get(state.frame_top - 1u, 10u) != FRAME_SERIALIZE {
    work_transition();
    return;
  }
  let main_type = scratch_get(0u, state.main_definition);
  if state.output_root == NO_INDEX {
    if state.substage == 0u {
      if start_concrete(main_type) { state.substage = 1u; }
      return;
    }
    if state.work_result == 0u {
      if state.status == STATUS_PENDING {
        let definition = definition_record(state.main_definition);
        report_diagnostic_with_operands(
          ERROR_NON_CONCRETE_MAIN, definition.start_byte, definition.end_byte,
          state.main_symbol, main_type, NO_INDEX);
      }
      return;
    }
    state.output_count = 0u;
    if !require_output_slots(1u) || !require_frame_slots(1u) { return; }
    state.substage = 0u;
    state.output_root = reserve_output(1u);
    initialize_output(state.output_root, NO_INDEX);
    state.frame_top = 0u;
    push_serialization_task(main_type, state.output_root);
    return;
  }

  if state.frame_top == 0u {
    state.status = STATUS_COMPLETE;
    return;
  }
  let frame = state.frame_top - 1u;
  let stage = frame_get(frame, 2u);
  if stage == 0u {
    if start_prune(frame_get(frame, 0u)) { frame_set(frame, 2u, 1u); }
    return;
  }
  if stage == 1u {
    let source = state.returned_type;
    let output_index = frame_get(frame, 1u);
    let kind = type_get(source, 0u);
    frame_set(frame, 0u, source);
    if kind == TYPE_INTEGER || kind == TYPE_BOOLEAN || kind == TYPE_UNIT ||
      kind == TYPE_SIGNED_INTEGER_64 || kind == TYPE_FLOAT_32 || kind == TYPE_FLOAT_64 {
      var tag = OUTPUT_INTEGER;
      if kind == TYPE_BOOLEAN { tag = OUTPUT_BOOLEAN; }
      else if kind == TYPE_UNIT { tag = OUTPUT_UNIT; }
      else if kind == TYPE_SIGNED_INTEGER_64 { tag = OUTPUT_SIGNED_INTEGER_64; }
      else if kind == TYPE_FLOAT_32 { tag = OUTPUT_FLOAT_32; }
      else if kind == TYPE_FLOAT_64 { tag = OUTPUT_FLOAT_64; }
      write_output(output_index, tag, NO_INDEX, NO_INDEX);
      pop_work_frame();
      return;
    }
    if kind == TYPE_TUPLE || kind == TYPE_FUNCTION {
      let tag = select(OUTPUT_FUNCTION, OUTPUT_TUPLE, kind == TYPE_TUPLE);
      write_output(output_index, tag, NO_INDEX, NO_INDEX);
      frame_set(frame, 2u, 2u);
      return;
    }
    if kind == TYPE_NAMED {
      write_output(
        output_index, OUTPUT_NAMED,
        algebraic_type_record(type_get(source, 1u)).symbol, NO_INDEX);
      frame_set(frame, 3u, type_get(source, 2u));
      frame_set(frame, 4u, NO_INDEX);
      frame_set(frame, 2u, 5u);
      return;
    }
    invalid_input(ERROR_INVALID_SURFACE, source);
    return;
  }
  if stage == 2u {
    if !require_output_slots(1u) || !require_frame_slots(1u) { return; }
    let source = frame_get(frame, 0u);
    let child_output = reserve_output(1u);
    initialize_output(child_output, NO_INDEX);
    output_types[output_address(frame_get(frame, 1u))].first_child = child_output;
    frame_set(frame, 4u, child_output);
    frame_set(frame, 2u, 3u);
    push_serialization_task(type_get(source, 2u), child_output);
    return;
  }
  if stage == 3u {
    if !require_output_slots(1u) || !require_frame_slots(1u) { return; }
    let source = frame_get(frame, 0u);
    let child_output = reserve_output(1u);
    initialize_output(child_output, NO_INDEX);
    output_types[output_address(frame_get(frame, 4u))].next_sibling = child_output;
    frame_set(frame, 2u, 4u);
    push_serialization_task(type_get(source, 3u), child_output);
    return;
  }
  if stage == 4u {
    pop_work_frame();
    return;
  }
  let list = frame_get(frame, 3u);
  if list == NO_INDEX {
    pop_work_frame();
    return;
  }
  if !require_output_slots(1u) || !require_frame_slots(1u) { return; }
  let child_output = reserve_output(1u);
  initialize_output(child_output, NO_INDEX);
  let previous = frame_get(frame, 4u);
  if previous == NO_INDEX {
    output_types[output_address(frame_get(frame, 1u))].first_child = child_output;
  } else {
    output_types[output_address(previous)].next_sibling = child_output;
  }
  frame_set(frame, 3u, type_get(list, 2u));
  frame_set(frame, 4u, child_output);
  push_serialization_task(type_get(list, 1u), child_output);
}
fn initialize_inference() {
  state.status = STATUS_PENDING;
  state.error_code = ERROR_NONE;
  state.error_start_byte = 0u;
  state.error_end_byte = 0u;
  state.error_detail = NO_INDEX;
  state.error_operand0 = NO_INDEX;
  state.error_operand1 = NO_INDEX;
  state.error_context = 0u;
  state.phase = PHASE_VALIDATE;
  state.validation_section = 0u;
  state.cursor = 0u;
  state.transitions = 0u;
  state.type_top = 0u;
  state.environment_top = 0u;
  state.frame_top = 0u;
  state.next_generic = 0u;
  state.traversal_epoch = 0u;
  state.current_level = 0u;
  state.tarjan_next_index = 0u;
  state.tarjan_stack_top = 0u;
  state.tarjan_dfs_top = 0u;
  state.tarjan_root_cursor = 0u;
  state.component_count = 0u;
  state.component_stage = 0u;
  state.component_cursor = 0u;
  state.expression_definition = NO_INDEX;
  state.returned_type = NO_INDEX;
  state.main_definition = NO_INDEX;
  state.output_root = NO_INDEX;
  state.output_count = 0u;
  state.current_arm = NO_INDEX;
  state.substage = 0u;
  state.cursor0 = 0u;
  state.cursor1 = 0u;
  state.epoch_clear_cursor = 0u;
  state.tarjan_stage = 0u;
  state.tarjan_component_root = NO_INDEX;
  state.work_result = 0u;
  state.work_aux = NO_INDEX;
  state.refinement_top = 0u;
  state.untouchable_type_cutoff = NO_INDEX;
  state.component_recursive = 0u;
  state.indexed_elimination_allowed = 1u;
  state.indexed_elimination_restriction_kind = 0u;
  state.indexed_elimination_restriction_symbol = NO_INDEX;
}

fn infer_lane() {
  let semantic_steps = state.semantic.total_steps;
  if state.semantic.status != SEMANTIC_STATUS_OK {
    state.previous_semantic_steps = semantic_steps;
    return;
  }
  if semantic_steps < state.previous_semantic_steps {
    invalid_input(ERROR_INVALID_SURFACE, semantic_steps);
    return;
  }
  let semantic_dispatch_transitions = semantic_steps - state.previous_semantic_steps;
  state.previous_semantic_steps = semantic_steps;
  let dispatch_quantum = min(
    state.maximum_transitions_per_dispatch,
    state.semantic.maximum_steps_per_dispatch,
  );
  if semantic_dispatch_transitions >= dispatch_quantum ||
    semantic_steps >= state.semantic.maximum_steps {
    return;
  }
  let completed_transitions = semantic_steps + state.transitions;
  if completed_transitions >= state.semantic.maximum_steps {
    return;
  }
  let dispatch_limit = min(
    dispatch_quantum - semantic_dispatch_transitions,
    state.semantic.maximum_steps - completed_transitions,
  );
  if dispatch_limit == 0u { return; }
  if state.status == STATUS_UNINITIALIZED { initialize_inference(); }
  if state.status != STATUS_PENDING { return; }
  var dispatch_transitions = 0u;
  loop {
    if dispatch_transitions >= dispatch_limit ||
      state.status != STATUS_PENDING { break; }
    if state.phase == PHASE_VALIDATE { validation_transition(); }
    else if state.phase == PHASE_TARJAN { tarjan_transition(); }
    else if state.phase == PHASE_COMPONENT { component_transition(); }
    else if state.phase == PHASE_SERIALIZE { serialize_main_type(); }
    else { invalid_input(ERROR_INVALID_SURFACE, state.phase); }
    dispatch_transitions += 1u;
    state.transitions += 1u;
  }
}

@compute @workgroup_size(1)
fn infer_lazuli_types(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let lane_index = invocation.x;
  if lane_index >= arrayLength(&inference_states) {
    return;
  }
  state = inference_states[lane_index];
  infer_lane();
  inference_states[lane_index] = state;
}
`;
