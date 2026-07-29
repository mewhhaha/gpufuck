import type { Diagnostic, EvaluationProfile, SourceRange, Type, TypeDeclaration } from "./abi.ts";
import type { EffectSet } from "./effect_set.ts";
import type { HostCapabilityDeclaration, HostDefinitionBinding } from "./host_contract.ts";

export interface WasmExport {
  readonly name: string;
  readonly definitionIndex: number;
  readonly type: Type;
  readonly effects: EffectSet;
}

/** Declared once in the semantic layer; the two used to be field-identical twins. */
export type { CoreNode } from "../semantic/compiler_module.ts";
import type { CoreNode } from "../semantic/compiler_module.ts";

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
  readonly entryEffects: EffectSet;
  readonly declaredDefinitionEffects: readonly EffectSet[];
  readonly definitionEffects: readonly EffectSet[];
  readonly typeDeclarations: readonly TypeDeclaration[];
  readonly hostCapabilities: readonly HostCapabilityDeclaration[];
  readonly hostDefinitions: readonly HostDefinitionBinding[];
  readonly wasmExports: readonly WasmExport[];
  readonly sources: readonly SourceRange[];
  readonly evaluationProfile: EvaluationProfile;
  readCoreNodes(): Promise<readonly CoreNode[]>;
  destroy(): void;
}

const completedTypeDeclarationCache = new WeakMap<
  GpuModule,
  readonly TypeDeclaration[]
>();

export function registerCompleteTypeDeclarations(
  module: GpuModule,
  declarations: readonly TypeDeclaration[],
): void {
  if (completedTypeDeclarationCache.has(module)) {
    throw new Error("functional module complete type declarations were registered twice");
  }
  completedTypeDeclarationCache.set(module, declarations);
}

export function completeTypeDeclarations(
  module: GpuModule,
): readonly TypeDeclaration[] {
  return completedTypeDeclarationCache.get(module) ?? module.typeDeclarations;
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
