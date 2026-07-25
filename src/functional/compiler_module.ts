import type {
  CoreTag,
  Diagnostic,
  EvaluationMode,
  EvaluationProfile,
  SourceRange,
  Type,
  TypeDeclaration,
} from "./abi.ts";
import type { HostCapabilityDeclaration, HostDefinitionBinding } from "./host_contract.ts";

export interface WasmExport {
  readonly name: string;
  readonly definitionIndex: number;
  readonly type: Type;
}

export interface CoreNode {
  readonly tag: CoreTag;
  readonly payload: number;
  readonly child0: number;
  readonly child1: number;
  readonly child2: number;
  readonly sourceByteOffset: number;
  readonly sourceEndByte: number;
  readonly evaluationMode: EvaluationMode;
}

export interface GpuModule {
  readonly nodeBuffer: GPUBuffer;
  readonly definitionBuffer: GPUBuffer;
  readonly constructorBuffer: GPUBuffer;
  readonly nodeCount: number;
  readonly definitionCount: number;
  readonly constructorCount: number;
  readonly typeCount: number;
  readonly constructorNames: readonly string[];
  readonly constructorArities: readonly number[];
  readonly definitionNames: readonly string[];
  readonly typeNames: readonly string[];
  readonly symbolNames: readonly string[];
  readonly definitionRoots: readonly number[];
  readonly entryDefinition: number;
  readonly entryType: Type;
  readonly entryEffects: readonly string[];
  readonly typeDeclarations: readonly TypeDeclaration[];
  readonly hostCapabilities: readonly HostCapabilityDeclaration[];
  readonly hostDefinitions: readonly HostDefinitionBinding[];
  readonly wasmExports: readonly WasmExport[];
  readonly sources: readonly SourceRange[];
  readonly evaluationProfile: EvaluationProfile;
  readCoreNodes(): Promise<readonly CoreNode[]>;
  destroy(): void;
}

const completeTypeDeclarations = new WeakMap<
  GpuModule,
  readonly TypeDeclaration[]
>();

export function registerCompleteFunctionalTypeDeclarations(
  module: GpuModule,
  declarations: readonly TypeDeclaration[],
): void {
  if (completeTypeDeclarations.has(module)) {
    throw new Error("functional module complete type declarations were registered twice");
  }
  completeTypeDeclarations.set(module, declarations);
}

export function completeFunctionalTypeDeclarations(
  module: GpuModule,
): readonly TypeDeclaration[] {
  return completeTypeDeclarations.get(module) ?? module.typeDeclarations;
}

export interface CompilationOptions {
  readonly maximumSteps?: number;
  readonly maximumStepsPerDispatch?: number;
  readonly signal?: AbortSignal;
}

export type CompileResult =
  | { readonly ok: true; readonly module: GpuModule }
  | {
    readonly ok: false;
    readonly diagnostics: readonly [Diagnostic, ...Diagnostic[]];
  };
