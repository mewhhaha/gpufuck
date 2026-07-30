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

const CORE_NODE_TRANSFER_WORD_LENGTH = 8;

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
    readonly coreNodeWords: Uint32Array<ArrayBuffer>;
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
  const nodes = await module.readCoreNodes();
  const coreNodeWords = new Uint32Array(nodes.length * CORE_NODE_TRANSFER_WORD_LENGTH);
  for (const [nodeIndex, node] of nodes.entries()) {
    const offset = nodeIndex * CORE_NODE_TRANSFER_WORD_LENGTH;
    coreNodeWords[offset] = node.tag;
    coreNodeWords[offset + 1] = node.payload;
    coreNodeWords[offset + 2] = node.child0;
    coreNodeWords[offset + 3] = node.child1;
    coreNodeWords[offset + 4] = node.child2;
    coreNodeWords[offset + 5] = node.sourceByteOffset;
    coreNodeWords[offset + 6] = node.sourceEndByte;
    coreNodeWords[offset + 7] = node.evaluationMode;
  }
  return {
    ...metadata,
    coreNodeWords,
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
    coreNodeWords,
    entryEffects,
    declaredDefinitionEffects,
    definitionEffects,
    hostCapabilities,
    wasmExports,
    typeDeclarations,
    ...metadata
  } = transferred;
  if (coreNodeWords.length !== metadata.nodeCount * CORE_NODE_TRANSFER_WORD_LENGTH) {
    throw new Error(
      `transferred functional module contains ${coreNodeWords.length} Core words for ${metadata.nodeCount} nodes`,
    );
  }
  const nodes = Object.freeze(
    Array.from({ length: metadata.nodeCount }, (_, nodeIndex): CoreNode => {
      const offset = nodeIndex * CORE_NODE_TRANSFER_WORD_LENGTH;
      return Object.freeze({
        tag: coreNodeWords[offset]! as CoreNode["tag"],
        payload: coreNodeWords[offset + 1]!,
        child0: coreNodeWords[offset + 2]!,
        child1: coreNodeWords[offset + 3]!,
        child2: coreNodeWords[offset + 4]!,
        sourceByteOffset: coreNodeWords[offset + 5]!,
        sourceEndByte: coreNodeWords[offset + 6]!,
        evaluationMode: coreNodeWords[offset + 7]! as CoreNode["evaluationMode"],
      });
    }),
  );
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

export function compiledModuleTransferables(
  module: TransferCompiledModule,
): readonly ArrayBuffer[] {
  return [module.coreNodeWords.buffer];
}
