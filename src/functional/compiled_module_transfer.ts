import type { TypeDeclaration } from "./abi.ts";
import type { CompiledModule, CoreNode, WasmExport } from "./compiler_module.ts";
import { completeTypeDeclarations, registerCompleteTypeDeclarations } from "./compiler_module.ts";
import { effectNames, effectSetFrom } from "./effect_set.ts";
import type {
  HostCapabilityDeclaration,
  HostOperationDeclaration,
  HostValueDeclaration,
} from "./host_contract.ts";

type TransferHostOperationDeclaration = Omit<HostOperationDeclaration, "effects"> & {
  readonly effects: readonly string[];
};

type TransferHostCapabilityDeclaration = Omit<HostCapabilityDeclaration, "fields"> & {
  readonly fields: readonly (HostValueDeclaration | TransferHostOperationDeclaration)[];
};

type TransferWasmExport = Omit<WasmExport, "effects"> & {
  readonly effects: readonly string[];
};

export type TransferCompiledModule =
  & Omit<
    CompiledModule,
    | "readCoreNodes"
    | "destroy"
    | "entryEffects"
    | "declaredDefinitionEffects"
    | "definitionEffects"
    | "hostCapabilities"
    | "wasmExports"
    | "typeDeclarations"
  >
  & {
    readonly coreNodes: readonly CoreNode[];
    readonly entryEffects: readonly string[];
    readonly declaredDefinitionEffects: readonly (readonly string[])[];
    readonly definitionEffects: readonly (readonly string[])[];
    readonly hostCapabilities: readonly TransferHostCapabilityDeclaration[];
    readonly wasmExports: readonly TransferWasmExport[];
    readonly typeDeclarations: readonly TypeDeclaration[];
  };

export async function encodeCompiledModuleForTransfer(
  module: CompiledModule,
): Promise<TransferCompiledModule> {
  const {
    readCoreNodes: _readCoreNodes,
    destroy: _destroy,
    entryEffects,
    declaredDefinitionEffects,
    definitionEffects,
    hostCapabilities,
    wasmExports,
    typeDeclarations: _typeDeclarations,
    ...metadata
  } = module;
  return {
    ...metadata,
    coreNodes: await module.readCoreNodes(),
    entryEffects: effectNames(entryEffects),
    declaredDefinitionEffects: declaredDefinitionEffects.map(effectNames),
    definitionEffects: definitionEffects.map(effectNames),
    hostCapabilities: hostCapabilities.map((capability) => ({
      ...capability,
      fields: capability.fields.map((field) =>
        field.kind === "value" ? field : { ...field, effects: effectNames(field.effects) }
      ),
    })),
    wasmExports: wasmExports.map((exported) => ({
      ...exported,
      effects: effectNames(exported.effects),
    })),
    typeDeclarations: completeTypeDeclarations(module),
  };
}

export function decodeTransferredCompiledModule(
  transferred: TransferCompiledModule,
): CompiledModule {
  const {
    coreNodes,
    entryEffects,
    declaredDefinitionEffects,
    definitionEffects,
    hostCapabilities,
    wasmExports,
    typeDeclarations,
    ...metadata
  } = transferred;
  const nodes = Object.freeze(coreNodes.map((node) => Object.freeze(node)));
  const module: CompiledModule = Object.freeze({
    ...metadata,
    entryEffects: effectSetFrom(entryEffects),
    declaredDefinitionEffects: Object.freeze(declaredDefinitionEffects.map(effectSetFrom)),
    definitionEffects: Object.freeze(definitionEffects.map(effectSetFrom)),
    hostCapabilities: Object.freeze(hostCapabilities.map((capability) =>
      Object.freeze({
        ...capability,
        fields: Object.freeze(capability.fields.map((field) =>
          Object.freeze(
            field.kind === "value" ? field : { ...field, effects: effectSetFrom(field.effects) },
          )
        )),
      })
    )),
    wasmExports: Object.freeze(
      wasmExports.map((exported) =>
        Object.freeze({ ...exported, effects: effectSetFrom(exported.effects) })
      ),
    ),
    typeDeclarations: Object.freeze(typeDeclarations),
    readCoreNodes: () => Promise.resolve(nodes),
    destroy: () => {},
  });
  registerCompleteTypeDeclarations(module, typeDeclarations);
  return module;
}
