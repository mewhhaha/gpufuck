import type { EncodedModule } from "./abi.ts";
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

export type TransferEncodedModule =
  & Omit<
    EncodedModule,
    "declaredDefinitionEffects" | "hostCapabilities"
  >
  & {
    readonly declaredDefinitionEffects: readonly (readonly string[])[];
    readonly hostCapabilities?: readonly TransferHostCapabilityDeclaration[];
  };

/**
 * Converts immutable effect-set proxies into structured-cloneable name arrays at a Worker
 * boundary.
 */
export function encodeModuleForTransfer(module: EncodedModule): TransferEncodedModule {
  const { declaredDefinitionEffects, hostCapabilities, ...cloneableModule } = module;
  return {
    ...cloneableModule,
    declaredDefinitionEffects: declaredDefinitionEffects.map(effectNames),
    ...(hostCapabilities === undefined ? {} : {
      hostCapabilities: hostCapabilities.map((capability) => ({
        ...capability,
        fields: capability.fields.map((field) =>
          field.kind === "value" ? field : { ...field, effects: effectNames(field.effects) }
        ),
      })),
    }),
  };
}

export function decodeTransferredModule(module: TransferEncodedModule): EncodedModule {
  const { declaredDefinitionEffects, hostCapabilities, ...encodedModule } = module;
  return {
    ...encodedModule,
    declaredDefinitionEffects: Object.freeze(
      declaredDefinitionEffects.map(effectSetFrom),
    ),
    ...(hostCapabilities === undefined ? {} : {
      hostCapabilities: hostCapabilities.map((capability) => ({
        ...capability,
        fields: capability.fields.map((field) =>
          field.kind === "value" ? field : { ...field, effects: effectSetFrom(field.effects) }
        ),
      })),
    }),
  };
}

export function encodedModuleTransferables(
  module: TransferEncodedModule,
): readonly ArrayBuffer[] {
  const buffers = [
    module.nodeWords.buffer,
    module.parameterWords.buffer,
    module.argumentWords.buffer,
    module.caseAlternativeWords.buffer,
    module.caseBinderWords.buffer,
    module.definitionWords.buffer,
    module.typeWords.buffer,
    module.constructorWords.buffer,
  ];
  const transferable = new Set<ArrayBuffer>();
  for (const buffer of buffers) {
    if (buffer instanceof ArrayBuffer) transferable.add(buffer);
  }
  return [...transferable];
}
