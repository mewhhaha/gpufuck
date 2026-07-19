import {
  type EncodedLazuliSurface,
  LAZULI_CONSTRUCTOR_WORD_LENGTH,
  LAZULI_NO_INDEX,
  LAZULI_TYPE_WORD_LENGTH,
  LazuliConstructorWord,
  type LazuliDiagnostic,
  type LazuliType,
  type LazuliTypeDeclaration,
  type LazuliTypeSchema,
  LazuliTypeWord,
} from "./abi.ts";
import type { GpuLazuliSemanticStateSnapshot } from "./gpu_semantic_contract.ts";
import type {
  GpuLazuliTypeInferenceOptions,
  GpuLazuliTypeInferenceRun,
  InferenceStateSnapshot,
  WorkspaceLayout,
} from "./gpu_type_inference_contract.ts";
import { inferenceArenaName } from "./gpu_type_inference_workspace.ts";
import { LazuliCompilationStatus } from "./compiler_shader.ts";
import {
  LAZULI_INFERENCE_OUTPUT_WORD_LENGTH,
  LAZULI_INFERENCE_SCHEMA_WORD_LENGTH,
  LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH,
  LazuliInferenceDiagnosticCode,
  LazuliInferenceMetadataFailure,
  LazuliInferenceSchemaTag,
  LazuliInferenceSchemaWord,
  type LazuliInferenceShaderMetadata,
} from "./type_inference_shader.ts";
import type { LazuliTypeInferenceSuccess } from "./type_inference.ts";
import { decodeLazuliType } from "./type_schema_abi.ts";

const WORD_BYTES = Uint32Array.BYTES_PER_ELEMENT;

export function syntheticSemanticState(
  options: GpuLazuliTypeInferenceOptions,
  initialSteps: number,
): GpuLazuliSemanticStateSnapshot {
  return {
    nodeCount: options.surface.nodeCount,
    definitionCount: options.surface.definitionCount,
    typeCount: options.surface.typeCount,
    constructorCount: options.surface.constructorCount,
    entrySymbol: options.surface.mainSymbol,
    status: LazuliCompilationStatus.Ok,
    errorCode: 0,
    errorSource: LAZULI_NO_INDEX,
    errorDetail: LAZULI_NO_INDEX,
    entryDefinition: LAZULI_NO_INDEX,
    totalSteps: initialSteps,
    maximumSteps: options.maximumSteps,
    maximumStepsPerDispatch: options.maximumStepsPerDispatch,
  };
}

export function assertConsistentState(
  state: InferenceStateSnapshot,
  semanticState: GpuLazuliSemanticStateSnapshot,
  layout: WorkspaceLayout,
  outputCapacity: number,
  previousSemanticSteps: number,
  previousTransitions: number,
  dispatchTransitions: number,
): void {
  const semanticProgress = semanticState.totalSteps - previousSemanticSteps;
  const inferenceProgress = state.transitions - previousTransitions;
  const progress = semanticProgress + inferenceProgress;
  if (
    !Number.isSafeInteger(progress) || progress < 1 || progress > dispatchTransitions ||
    !Number.isSafeInteger(semanticProgress) || semanticProgress < 0 ||
    !Number.isSafeInteger(inferenceProgress) || inferenceProgress < 0 ||
    (semanticState.status !== LazuliCompilationStatus.Ok && inferenceProgress !== 0) ||
    state.typeTop > layout.typeCapacity || state.environmentTop > layout.environmentCapacity ||
    state.frameTop > layout.frameCapacity ||
    state.refinementTop > layout.refinementCapacity || state.outputCount > outputCapacity ||
    (state.outputCount !== 0 && state.outputRoot >= state.outputCount)
  ) {
    throw new Error(
      `GPU Lazuli compilation returned inconsistent dispatch progress: semanticSteps=${semanticState.totalSteps}, previousSemanticSteps=${previousSemanticSteps}, inferenceTransitions=${state.transitions}, previousInferenceTransitions=${previousTransitions}, maximumTransitions=${dispatchTransitions}, typeTop=${state.typeTop}, environmentTop=${state.environmentTop}, frameTop=${state.frameTop}, refinementTop=${state.refinementTop}, outputRoot=${state.outputRoot}, outputCount=${state.outputCount}`,
    );
  }
}

export function fuelExhausted(
  options: GpuLazuliTypeInferenceOptions,
  transitions: number,
  initialSteps: number,
): GpuLazuliTypeInferenceRun {
  const sourceByteLength = options.sourceByteLength ?? largestSourceOffset(options.surface);
  const diagnostic: LazuliDiagnostic = {
    stage: "compile",
    code: "L1003",
    message: `program exhausted the compiler limit after ${
      initialSteps + transitions
    } serial semantic transitions; the limit is ${options.maximumSteps}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
  return Object.freeze({
    ok: false,
    diagnostic,
    transitions,
    totalSteps: initialSteps + transitions,
  });
}

export function compilerWorkspaceExhausted(
  options: GpuLazuliTypeInferenceOptions,
  state: InferenceStateSnapshot,
  initialSteps: number,
  reason?: string,
): GpuLazuliTypeInferenceRun {
  const sourceByteLength = options.sourceByteLength ?? largestSourceOffset(options.surface);
  const diagnostic: LazuliDiagnostic = {
    stage: "compile",
    code: "L1003",
    message: `program exhausted the GPU compiler ${
      inferenceArenaName(state.errorCode)
    } workspace; required capacity is ${state.errorDetail}${
      reason === undefined ? "" : `; ${reason}`
    }`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
  return Object.freeze({
    ok: false,
    diagnostic,
    transitions: state.transitions,
    totalSteps: initialSteps + state.transitions,
  });
}

export function compilerWorkspacePreflightFailed(
  options: GpuLazuliTypeInferenceOptions,
  initialSteps: number,
  reason: string,
): GpuLazuliTypeInferenceRun {
  const sourceByteLength = options.sourceByteLength ?? largestSourceOffset(options.surface);
  const diagnostic: LazuliDiagnostic = {
    stage: "compile",
    code: "L1003",
    message: `program exceeds the GPU compiler workspace limit: ${reason}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
  return Object.freeze({
    ok: false,
    diagnostic,
    transitions: 0,
    totalSteps: initialSteps,
  });
}

export function compilerInferenceAllocationFailed(
  options: GpuLazuliTypeInferenceOptions,
  initialSteps: number,
  reason: string,
): GpuLazuliTypeInferenceRun {
  const sourceByteLength = options.sourceByteLength ?? largestSourceOffset(options.surface);
  const diagnostic: LazuliDiagnostic = {
    stage: "compile",
    code: "L1003",
    message: `program exhausted GPU memory before type inference: ${reason}`,
    span: { startByte: 0, endByte: sourceByteLength },
  };
  return Object.freeze({
    ok: false,
    diagnostic,
    transitions: 0,
    totalSteps: initialSteps,
  });
}

export function diagnosticFromState(
  state: InferenceStateSnapshot,
  surface: EncodedLazuliSurface,
  metadata: LazuliInferenceShaderMetadata,
  workspace: DataView | undefined,
): LazuliDiagnostic {
  const span = { startByte: state.errorStartByte, endByte: state.errorEndByte };
  switch (state.errorCode) {
    case LazuliInferenceDiagnosticCode.NonExhaustiveCase:
      return {
        stage: "compile",
        code: "L2010",
        message: `non-exhaustive case; missing constructor ${
          JSON.stringify(
            symbolName(surface, state.errorDetail),
          )
        }`,
        span,
      };
    case LazuliInferenceDiagnosticCode.InvalidTypeMetadata:
      return {
        stage: "compile",
        code: "L2101",
        message: metadataFailureMessage(
          state,
          metadata,
          workspace,
          surface,
        ),
        span,
      };
    case LazuliInferenceDiagnosticCode.TypeMismatch:
      if (state.errorContext === 1) {
        return {
          stage: "compile",
          code: "L2102",
          message: `constructor ${
            JSON.stringify(constructorName(surface, state.errorDetail))
          } is inaccessible: result ${
            formatWorkspaceType(
              state.errorOperand0,
              workspace,
              surface,
              metadata.identifierNames,
            )
          } is incompatible with scrutinee ${
            formatWorkspaceType(
              state.errorOperand1,
              workspace,
              surface,
              metadata.identifierNames,
            )
          }`,
          span,
        };
      }
      return {
        stage: "compile",
        code: "L2102",
        message: `type mismatch: expected ${
          formatWorkspaceType(
            state.errorOperand0,
            workspace,
            surface,
            metadata.identifierNames,
          )
        }, received ${
          formatWorkspaceType(state.errorOperand1, workspace, surface, metadata.identifierNames)
        }`,
        span,
      };
    case LazuliInferenceDiagnosticCode.InfiniteType:
      return {
        stage: "compile",
        code: "L2103",
        message: `cannot construct infinite type by unifying ${
          formatWorkspaceType(
            state.errorOperand0,
            workspace,
            surface,
            metadata.identifierNames,
          )
        } with ${
          formatWorkspaceType(state.errorOperand1, workspace, surface, metadata.identifierNames)
        }`,
        span,
      };
    case LazuliInferenceDiagnosticCode.NonConcreteMain:
      return {
        stage: "compile",
        code: "L2104",
        message: state.errorOperand0 === LAZULI_NO_INDEX
          ? "main has no inferred type"
          : `main must have a concrete type; inferred ${
            formatWorkspaceType(
              state.errorOperand0,
              workspace,
              surface,
              metadata.identifierNames,
            )
          }`,
        span,
      };
    default:
      throw new Error(
        `GPU Lazuli type inference returned unknown diagnostic code ${state.errorCode} at ${state.errorStartByte}..${state.errorEndByte}`,
      );
  }
}

function metadataFailureMessage(
  state: InferenceStateSnapshot,
  metadata: LazuliInferenceShaderMetadata,
  workspace: DataView | undefined,
  surface: EncodedLazuliSurface,
): string {
  const identifierNames = metadata.identifierNames;
  const name = (identifier: number): string => identifierName(identifierNames, identifier);
  switch (state.errorContext) {
    case LazuliInferenceMetadataFailure.UnknownName:
      return `cannot infer unknown name ${name(state.errorDetail)}`;
    case LazuliInferenceMetadataFailure.UnknownCaseConstructor:
      return `cannot infer unknown case constructor ${name(state.errorDetail)}`;
    case LazuliInferenceMetadataFailure.CaseFieldCountMismatch:
      return `constructor ${
        JSON.stringify(name(state.errorDetail))
      } has ${state.errorOperand0} fields but the arm binds ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.UndeclaredTypeParameter:
      return `type parameter ${JSON.stringify(name(state.errorDetail))} is not in scope`;
    case LazuliInferenceMetadataFailure.UnknownType:
      return `unknown type ${JSON.stringify(name(state.errorDetail))}`;
    case LazuliInferenceMetadataFailure.TypeArgumentCountMismatch:
      return `type ${
        JSON.stringify(name(state.errorDetail))
      } expects ${state.errorOperand0} arguments; received ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.UnsupportedExpression:
      return `Unsupported Lazuli expression tag ${state.errorDetail} at node ${state.errorOperand0}.`;
    case LazuliInferenceMetadataFailure.InvalidDefinitionAnnotation:
      return `definition ${state.errorDetail} annotation ${state.errorOperand0} is outside ${state.errorOperand1} schema nodes`;
    case LazuliInferenceMetadataFailure.InvalidTypeDeclaration:
      return `invalid type declaration ${state.errorDetail}: ${state.errorOperand0} constructors and ${state.errorOperand1} parameters`;
    case LazuliInferenceMetadataFailure.RepeatedTypeParameter:
      return `type ${JSON.stringify(name(state.errorDetail))} repeats parameter ${
        JSON.stringify(name(state.errorOperand0))
      }`;
    case LazuliInferenceMetadataFailure.InvalidConstructor:
      return `invalid constructor ${state.errorDetail}: type ${state.errorOperand0}, detail ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.ConstructorFieldCountMismatch:
      return `constructor ${
        JSON.stringify(name(state.errorDetail))
      } has ${state.errorOperand0} fields but metadata declares ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.InvalidConstructorField:
      return `constructor ${
        JSON.stringify(name(state.errorDetail))
      } field ${state.errorOperand0} references invalid schema ${state.errorOperand1}`;
    case LazuliInferenceMetadataFailure.InvalidSchemaShape:
      return `schema ${state.errorDetail} has invalid shape: tag ${state.errorOperand0}, ${state.errorOperand1} children`;
    case LazuliInferenceMetadataFailure.InvalidSchemaConversion:
      return `cannot convert invalid schema ${state.errorDetail}`;
    case LazuliInferenceMetadataFailure.DuplicateTypeName:
      return `duplicate type name ${JSON.stringify(name(state.errorDetail))}`;
    case LazuliInferenceMetadataFailure.InvalidEmptyCaseScrutinee:
      return `empty case requires a zero-constructor named type; received ${
        formatWorkspaceType(state.errorOperand0, workspace, surface, identifierNames)
      }`;
    case LazuliInferenceMetadataFailure.InvalidConstructorResult:
      return invalidConstructorResultMessage(state, metadata, surface);
    case LazuliInferenceMetadataFailure.HiddenConstructorFieldParameter:
      return `constructor ${
        JSON.stringify(constructorName(surface, state.errorDetail))
      } field parameter ${JSON.stringify(name(state.errorOperand0))} does not occur in its result`;
    case LazuliInferenceMetadataFailure.IndexedExpectedTypeMissing:
      return `indexed case for ${
        JSON.stringify(name(state.errorDetail))
      } requires a propagated expected type; received no expected type`;
    case LazuliInferenceMetadataFailure.IndexedExpectedTypeUnresolved:
      return `indexed case for ${
        JSON.stringify(name(state.errorDetail))
      } requires a fully zonked expected type; received ${
        formatWorkspaceType(state.errorOperand0, workspace, surface, identifierNames)
      } with unsolved inference variable ${
        formatWorkspaceType(state.errorOperand1, workspace, surface, identifierNames)
      }`;
    case LazuliInferenceMetadataFailure.IndexedScrutineeUnresolved:
      return `indexed case for ${
        JSON.stringify(name(state.errorDetail))
      } requires a fully zonked scrutinee; received ${
        formatWorkspaceType(state.errorOperand0, workspace, surface, identifierNames)
      } with unsolved inference variable ${
        formatWorkspaceType(state.errorOperand1, workspace, surface, identifierNames)
      }`;
    case LazuliInferenceMetadataFailure.IndexedScrutineeTypeMismatch:
      return `indexed case requires scrutinee ${
        JSON.stringify(name(state.errorDetail))
      }; received ${formatWorkspaceType(state.errorOperand0, workspace, surface, identifierNames)}`;
    case LazuliInferenceMetadataFailure.UntouchableIndexedVariable:
      return `indexed case arm cannot solve pre-existing inference variable ${
        formatWorkspaceType(state.errorOperand0, workspace, surface, identifierNames)
      } with ${formatWorkspaceType(state.errorOperand1, workspace, surface, identifierNames)}`;
    default:
      throw new Error(
        `GPU Lazuli type inference returned unknown L2101 context ${state.errorContext}`,
      );
  }
}

function invalidConstructorResultMessage(
  state: InferenceStateSnapshot,
  metadata: LazuliInferenceShaderMetadata,
  surface: EncodedLazuliSurface,
): string {
  const constructor = constructorName(surface, state.errorDetail);
  if (state.errorOperand0 >= metadata.schemaNodeCount) {
    return `constructor ${
      JSON.stringify(constructor)
    } references invalid result schema ${state.errorOperand0}`;
  }
  const constructorBase = state.errorDetail * LAZULI_CONSTRUCTOR_WORD_LENGTH;
  const typeIndex = surface.constructorWords[constructorBase + LazuliConstructorWord.Type];
  if (typeIndex === undefined || typeIndex >= surface.typeCount) {
    throw new Error(
      `GPU Lazuli result diagnostic references missing constructor type ${typeIndex}`,
    );
  }
  const typeSymbol = surface.typeWords[typeIndex * LAZULI_TYPE_WORD_LENGTH + LazuliTypeWord.Symbol];
  if (typeSymbol === undefined) {
    throw new Error(`GPU Lazuli result diagnostic references missing type ${typeIndex}`);
  }
  const firstParameter = metadata.words[metadata.typeParameterOffsetsBase + typeIndex];
  const parameterEnd = metadata.words[metadata.typeParameterOffsetsBase + typeIndex + 1];
  if (firstParameter === undefined || parameterEnd === undefined || parameterEnd < firstParameter) {
    throw new Error(`GPU Lazuli result diagnostic references invalid type ${typeIndex} metadata`);
  }
  return `constructor ${JSON.stringify(constructor)} result must have head ${
    JSON.stringify(symbolName(surface, typeSymbol))
  } with ${parameterEnd - firstParameter} arguments; received ${
    describeResultSchema(state.errorOperand0, metadata)
  }`;
}

function describeResultSchema(
  root: number,
  metadata: LazuliInferenceShaderMetadata,
): string {
  const word = (schema: number, offset: number): number => {
    const value = metadata.words[
      metadata.schemaBase + schema * LAZULI_INFERENCE_SCHEMA_WORD_LENGTH + offset
    ];
    if (value === undefined) {
      throw new Error(`GPU Lazuli result diagnostic references incomplete schema ${schema}`);
    }
    return value;
  };
  const tag = word(root, LazuliInferenceSchemaWord.Tag);
  if (tag === LazuliInferenceSchemaTag.Named) {
    let argumentCount = 0;
    let argument = word(root, LazuliInferenceSchemaWord.FirstChild);
    while (argument !== LAZULI_NO_INDEX) {
      argumentCount++;
      argument = word(argument, LazuliInferenceSchemaWord.NextSibling);
    }
    return `${
      JSON.stringify(
        identifierName(metadata.identifierNames, word(root, LazuliInferenceSchemaWord.Symbol)),
      )
    } with ${argumentCount} arguments`;
  }
  const kind = tag === LazuliInferenceSchemaTag.Integer
    ? "integer"
    : tag === LazuliInferenceSchemaTag.Boolean
    ? "boolean"
    : tag === LazuliInferenceSchemaTag.Unit
    ? "unit"
    : tag === LazuliInferenceSchemaTag.Parameter
    ? "parameter"
    : tag === LazuliInferenceSchemaTag.Tuple
    ? "tuple"
    : tag === LazuliInferenceSchemaTag.Function
    ? "function"
    : `unknown-${tag}`;
  return `a ${kind} result`;
}

function constructorName(surface: EncodedLazuliSurface, constructorIndex: number): string {
  const symbol = surface.constructorWords[
    constructorIndex * LAZULI_CONSTRUCTOR_WORD_LENGTH + LazuliConstructorWord.Symbol
  ];
  if (symbol === undefined) {
    throw new Error(`GPU Lazuli inference returned unknown constructor ${constructorIndex}`);
  }
  return symbolName(surface, symbol);
}

export function decodeMainType(
  output: DataView,
  state: InferenceStateSnapshot,
  surface: EncodedLazuliSurface,
): LazuliType {
  const byteLength = state.outputCount * LAZULI_INFERENCE_OUTPUT_WORD_LENGTH * WORD_BYTES;
  const schemaWords = new Uint32Array(
    output.buffer.slice(output.byteOffset, output.byteOffset + byteLength),
  );
  return decodeLazuliType(schemaWords, state.outputRoot, surface.symbolNames);
}

export function publicTypeMetadata(surface: EncodedLazuliSurface): Pick<
  LazuliTypeInferenceSuccess,
  "typeDeclarations" | "constructorFieldTypes"
> {
  const copySchema = (schema: LazuliTypeSchema): LazuliTypeSchema => {
    switch (schema.kind) {
      case "integer":
      case "signed-integer-64":
      case "float-32":
      case "float-64":
      case "boolean":
      case "unit":
        return Object.freeze({ kind: schema.kind });
      case "parameter":
        return Object.freeze({ kind: "parameter", name: schema.name });
      case "tuple":
        return Object.freeze({
          kind: "tuple",
          values: Object.freeze([copySchema(schema.values[0]), copySchema(schema.values[1])]),
        }) as LazuliTypeSchema;
      case "named":
        return Object.freeze({
          kind: "named",
          name: schema.name,
          arguments: Object.freeze(schema.arguments.map(copySchema)),
        });
      case "function":
        return Object.freeze({
          kind: "function",
          parameter: copySchema(schema.parameter),
          result: copySchema(schema.result),
        });
      case "forall":
        return Object.freeze({
          kind: "forall",
          parameters: Object.freeze([...schema.parameters]),
          body: copySchema(schema.body),
        });
    }
  };
  const typeDeclarations: LazuliTypeDeclaration[] = [];
  const constructorFieldTypes: (readonly LazuliTypeSchema[])[] = [];
  for (const declaration of surface.typeDeclarations) {
    const constructors = declaration.constructors.map((constructor) => {
      const fields = Object.freeze(
        constructor.fields.map((field) =>
          Object.freeze({ name: field.name, type: copySchema(field.type) })
        ),
      );
      constructorFieldTypes.push(Object.freeze(fields.map((field) => field.type)));
      return Object.freeze({
        name: constructor.name,
        fields,
        ...(constructor.result === undefined ? {} : {
          result: copySchema(constructor.result),
        }),
      });
    });
    if (!declaration.name.startsWith("$")) {
      typeDeclarations.push(Object.freeze({
        name: declaration.name,
        parameters: Object.freeze([...declaration.parameters]),
        constructors: Object.freeze(constructors),
      }));
    }
  }
  return {
    typeDeclarations: Object.freeze(typeDeclarations),
    constructorFieldTypes: Object.freeze(constructorFieldTypes),
  };
}

function formatWorkspaceType(
  root: number,
  workspace: DataView | undefined,
  surface: EncodedLazuliSurface,
  identifierNames: readonly string[],
): string {
  if (workspace === undefined) {
    throw new Error("GPU Lazuli type diagnostic omitted its workspace snapshot");
  }
  const typeCount = workspace.byteLength / (LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH * WORD_BYTES);
  const typeWord = (typeIndex: number, word: number): number => {
    if (!Number.isInteger(typeIndex) || typeIndex < 0 || typeIndex >= typeCount) {
      throw new Error(
        `GPU Lazuli diagnostic referenced type ${typeIndex} outside ${typeCount} records`,
      );
    }
    return workspace.getUint32(
      (typeIndex * LAZULI_INFERENCE_TYPE_RECORD_WORD_LENGTH + word) * WORD_BYTES,
      true,
    );
  };
  const prune = (typeIndex: number): number => {
    const seen = new Set<number>();
    let current = typeIndex;
    while (true) {
      const kind = typeWord(current, 0);
      const replacement = kind === 1
        ? typeWord(current, 1)
        : kind === 3
        ? typeWord(current, 3)
        : LAZULI_NO_INDEX;
      if (replacement === LAZULI_NO_INDEX) return current;
      if (seen.has(current)) {
        throw new Error(`GPU Lazuli diagnostic contains cyclic type link at type ${current}`);
      }
      seen.add(current);
      current = replacement;
    }
  };
  const names = new Map<number, string>();
  const variableName = (typeIndex: number): string => {
    const existing = names.get(typeIndex);
    if (existing !== undefined) return existing;
    const index = names.size;
    const name = `'${String.fromCharCode(97 + index % 26)}${
      index < 26 ? "" : Math.floor(index / 26)
    }`;
    names.set(typeIndex, name);
    return name;
  };
  const format = (raw: number, nestedFunction: boolean): string => {
    const typeIndex = prune(raw);
    const kind = typeWord(typeIndex, 0);
    switch (kind) {
      case 1:
      case 2:
        return variableName(typeIndex);
      case 3:
        return identifierName(identifierNames, typeWord(typeIndex, 1));
      case 11:
        return identifierName(identifierNames, typeWord(typeIndex, 1));
      case 4:
        return "Int";
      case 5:
        return "Bool";
      case 6:
        return "()";
      case 13:
        return "I64";
      case 14:
        return "F32";
      case 15:
        return "F64";
      case 7:
        return `(${format(typeWord(typeIndex, 2), false)}, ${
          format(typeWord(typeIndex, 3), false)
        })`;
      case 8: {
        const typeDeclaration = typeWord(typeIndex, 1);
        const typeOffset = typeDeclaration * 5;
        const symbol = surface.typeWords[typeOffset];
        if (symbol === undefined) {
          throw new Error(
            `GPU Lazuli diagnostic named missing type declaration ${typeDeclaration}`,
          );
        }
        const arguments_: string[] = [];
        let list = typeWord(typeIndex, 2);
        const seenLists = new Set<number>();
        while (list !== LAZULI_NO_INDEX) {
          if (seenLists.has(list) || typeWord(list, 0) !== 10) {
            throw new Error(
              `GPU Lazuli diagnostic named type ${typeIndex} has invalid argument list`,
            );
          }
          seenLists.add(list);
          arguments_.push(format(typeWord(list, 1), false));
          list = typeWord(list, 2);
        }
        const name = symbolName(surface, symbol);
        return arguments_.length === 0 ? name : `${name}[${arguments_.join(", ")}]`;
      }
      case 9: {
        const rendered = `${format(typeWord(typeIndex, 2), true)} -> ${
          format(
            typeWord(typeIndex, 3),
            false,
          )
        }`;
        return nestedFunction ? `(${rendered})` : rendered;
      }
      case 12:
        return `forall. ${format(typeWord(typeIndex, 2), false)}`;
      default:
        throw new Error(`GPU Lazuli diagnostic type ${typeIndex} has unknown kind ${kind}`);
    }
  };
  return format(root, false);
}

function identifierName(identifierNames: readonly string[], identifier: number): string {
  const name = identifierNames[identifier];
  if (name === undefined) {
    throw new Error(`GPU Lazuli inference returned unknown schema identifier ${identifier}`);
  }
  return name;
}

function symbolName(surface: EncodedLazuliSurface, symbol: number): string {
  const name = surface.symbolNames[symbol];
  if (name === undefined) throw new Error(`GPU Lazuli inference returned unknown symbol ${symbol}`);
  return name;
}

function largestSourceOffset(surface: EncodedLazuliSurface): number {
  let largest = 0;
  for (let node = 0; node < surface.nodeCount; node++) {
    const end = surface.nodeWords[node * 8 + 2];
    if (end !== undefined) largest = Math.max(largest, end);
  }
  return largest;
}
