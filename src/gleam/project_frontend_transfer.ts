import { effectNames, effectSetFrom } from "../functional/effect_set.ts";
import { createOwnedModuleArtifact, type ModuleArtifact } from "../functional/module_linker.ts";
import type { HostCapabilityDeclaration } from "../functional/host_contract.ts";
import type { SurfaceDefinition } from "../functional/surface_builder.ts";
import type { GleamModule } from "./ast.ts";
import type { LoweredGleamModule } from "./lowering.ts";

type TransferDefinition = Omit<SurfaceDefinition, "effects"> & {
  readonly effects?: readonly string[];
};

type TransferHostCapability = Omit<HostCapabilityDeclaration, "fields"> & {
  readonly fields: readonly (
    | Extract<HostCapabilityDeclaration["fields"][number], { readonly kind: "value" }>
    | (
      & Omit<
        Extract<HostCapabilityDeclaration["fields"][number], { readonly kind: "operation" }>,
        "effects"
      >
      & { readonly effects: readonly string[] }
    )
  )[];
};

export type TransferModuleArtifact = Omit<ModuleArtifact, "definitions" | "options"> & {
  readonly definitions: readonly TransferDefinition[];
  readonly options: Omit<ModuleArtifact["options"], "hostCapabilities"> & {
    readonly hostCapabilities?: readonly TransferHostCapability[];
  };
};

export interface TransferLoweredGleamModule {
  readonly source: GleamModule;
  readonly artifact: TransferModuleArtifact;
}

export function encodeLoweredGleamModule(
  lowered: LoweredGleamModule,
): TransferLoweredGleamModule {
  const artifact = lowered.artifact;
  const { hostCapabilities, ...options } = artifact.options;
  return {
    source: lowered.source,
    artifact: {
      ...artifact,
      definitions: artifact.definitions.map((definition) => {
        const { effects, ...withoutEffects } = definition;
        return effects === undefined
          ? withoutEffects
          : { ...withoutEffects, effects: effectNames(effects) };
      }),
      options: {
        ...options,
        ...(hostCapabilities === undefined ? {} : {
          hostCapabilities: hostCapabilities.map((capability) => ({
            ...capability,
            fields: capability.fields.map((field) =>
              field.kind === "value" ? field : { ...field, effects: effectNames(field.effects) }
            ),
          })),
        }),
      },
    },
  };
}

export function decodeLoweredGleamModule(
  transferred: TransferLoweredGleamModule,
): LoweredGleamModule {
  const { hostCapabilities, ...options } = transferred.artifact.options;
  const artifact = createOwnedModuleArtifact({
    ...transferred.artifact,
    definitions: transferred.artifact.definitions.map((definition) => {
      const { effects, ...withoutEffects } = definition;
      return effects === undefined
        ? withoutEffects
        : { ...withoutEffects, effects: effectSetFrom(effects) };
    }),
    options: {
      ...options,
      ...(hostCapabilities === undefined ? {} : {
        hostCapabilities: hostCapabilities.map((capability) => ({
          ...capability,
          fields: capability.fields.map((field) =>
            field.kind === "value" ? field : { ...field, effects: effectSetFrom(field.effects) }
          ),
        })),
      }),
    },
  });
  return {
    source: transferred.source,
    definitions: artifact.definitions,
    typeDeclarations: artifact.typeDeclarations,
    artifact,
  };
}

export function transferableArrayBuffers(value: unknown): readonly ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== "object") continue;
    if (ArrayBuffer.isView(current)) {
      if (current.buffer instanceof ArrayBuffer) buffers.add(current.buffer);
      continue;
    }
    if (current instanceof ArrayBuffer) {
      buffers.add(current);
      continue;
    }
    if (visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    pending.push(...Object.values(current));
  }
  return [...buffers];
}
