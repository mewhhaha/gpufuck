/**
 * The public surface ABI: the packed module contract a frontend encodes to, and the diagnostics it
 * decodes back.
 *
 * The word layouts, tags, operators, and size constants are declared once in `../semantic/abi.ts`
 * and re-exported here. They used to be re-declared under a second set of names, which meant every
 * ABI change had to be made twice and agreeing was a convention rather than a fact.
 *
 * @module
 */
export {
  AlgebraicTypeWord,
  ARGUMENT_WORD_LENGTH,
  ArgumentWord,
  BinaryOperator,
  BranchLikelihood,
  CASE_ALTERNATIVE_WORD_LENGTH,
  CaseAlternativeWord,
  CONSTRUCTOR_BYTE_LENGTH,
  CONSTRUCTOR_WORD_LENGTH,
  ConstructorWord,
  CoreTag,
  DEFINITION_BYTE_LENGTH,
  DEFINITION_WORD_LENGTH,
  DefinitionWord,
  type EncodedDefinitionType,
  type EncodedTypeDeclaration,
  EvaluationMode,
  ExpressionTag,
  MAXIMUM_CONSTRUCTOR_ARITY,
  MAXIMUM_EXPRESSION_NODES,
  MAXIMUM_SOURCE_BYTE_LENGTH,
  MODULE_ABI_VERSION,
  NO_INDEX,
  NODE_BYTE_LENGTH,
  NODE_WORD_LENGTH,
  NodeWord,
  NumericConversion,
  RuntimeFaultCategory,
  TYPE_BYTE_LENGTH,
  TYPE_WORD_LENGTH,
  UnaryOperator,
} from "../semantic/abi.ts";
export { TypecheckingProfile } from "./schema_contract.ts";
export { type SourceRange, type WasmExportDeclaration } from "./module_contract.ts";
export {
  type SourceType,
  type Span,
  type Type,
  type TypeDeclaration,
  type TypeSchema,
} from "./schema_contract.ts";

import type {
  EncodedDefinitionType,
  EncodedTypeDeclaration,
  SemanticDiagnosticCode,
} from "../semantic/abi.ts";
import type { EffectSet } from "./effect_set.ts";
import type { HostCapabilityDeclaration, HostDefinitionBinding } from "./host_contract.ts";
import type { SourceRange, WasmExportDeclaration } from "./module_contract.ts";
import type { Span, TypecheckingProfile } from "./schema_contract.ts";

/** Reserved nominal names the surface builder installs; a frontend cannot declare them. */
export const UNIT_CONSTRUCTOR_NAME = "$Unit";
export const PAIR_TYPE_NAME = "$TupleType";
export const PAIR_CONSTRUCTOR_NAME = "$Tuple";
export const THUNK_TYPE_NAME = "$ThunkType";
export const THUNK_CONSTRUCTOR_NAME = "$Thunk";

export const PrimitiveCapability = {
  SignedInteger32: "signed-integer-i32",
  SignedInteger64: "signed-integer-i64",
  Float32: "float-f32",
  Float64: "float-f64",
  Boolean: "boolean",
  Unit: "unit",
  Pair: "pair",
  Function: "function",
  AlgebraicData: "algebraic-data",
  StaticText: "static-text",
  StaticBytes: "static-bytes",
  ExplicitFault: "explicit-fault",
  StructuralEquality: "structural-equality",
  BufferAppend: "buffer-append",
  Store: "store",
} as const;

export type PrimitiveCapability = (typeof PrimitiveCapability)[keyof typeof PrimitiveCapability];

export const CORE_V1_PRIMITIVE_CAPABILITIES: readonly PrimitiveCapability[] = Object.freeze(
  [
    PrimitiveCapability.SignedInteger32,
    PrimitiveCapability.SignedInteger64,
    PrimitiveCapability.Float32,
    PrimitiveCapability.Float64,
    PrimitiveCapability.Boolean,
    PrimitiveCapability.Unit,
    PrimitiveCapability.Pair,
    PrimitiveCapability.Function,
    PrimitiveCapability.AlgebraicData,
    PrimitiveCapability.StaticText,
    PrimitiveCapability.StaticBytes,
    PrimitiveCapability.ExplicitFault,
    PrimitiveCapability.StructuralEquality,
    PrimitiveCapability.BufferAppend,
    PrimitiveCapability.Store,
  ] as const,
);

/** One code namespace, shared with the layer that produces them. */
export type DiagnosticCode = SemanticDiagnosticCode;

export interface RelatedDiagnostic {
  readonly message: string;
  readonly span: Span;
}

export interface Diagnostic {
  readonly stage: "compile";
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly span: Span;
  readonly related?: readonly RelatedDiagnostic[];
}

export interface EncodedModule {
  readonly abiVersion: number;
  readonly sourceByteLength: number;
  readonly typecheckingProfile: TypecheckingProfile;
  readonly primitiveCapabilities: readonly PrimitiveCapability[];
  readonly hostCapabilities?: readonly HostCapabilityDeclaration[];
  readonly hostDefinitions?: readonly HostDefinitionBinding[];
  readonly declaredDefinitionEffects: readonly EffectSet[];
  readonly wasmExports?: readonly WasmExportDeclaration[];
  readonly sources?: readonly SourceRange[];
  readonly nodeWords: Uint32Array;
  readonly parameterWords: Uint32Array;
  readonly argumentWords: Uint32Array;
  readonly caseAlternativeWords: Uint32Array;
  readonly caseBinderWords: Uint32Array;
  readonly definitionWords: Uint32Array;
  readonly typeWords: Uint32Array;
  readonly constructorWords: Uint32Array;
  readonly nodeCount: number;
  readonly argumentCount: number;
  readonly caseAlternativeCount: number;
  readonly definitionCount: number;
  readonly typeCount: number;
  readonly constructorCount: number;
  readonly entrySymbol: number;
  readonly symbolNames: readonly string[];
  readonly definitionTypes: readonly EncodedDefinitionType[];
  readonly typeDeclarations: readonly EncodedTypeDeclaration[];
}
