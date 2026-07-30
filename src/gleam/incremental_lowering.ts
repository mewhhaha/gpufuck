import { createOwnedModuleArtifact, type ModuleArtifact } from "../functional/module_linker.ts";
import type { GleamModule } from "./ast.ts";
import type { LoweredGleamModule } from "./lowering.ts";

export interface IncrementalGleamLowering {
  readonly lowered: LoweredGleamModule;
  readonly changedLiterals: number;
}

interface SignedIntegerChange {
  readonly startByte: number;
  readonly endByte: number;
  readonly previousValue: bigint;
  readonly updatedValue: bigint;
}

export function tryUpdateLoweredSignedIntegerLiterals(
  previous: LoweredGleamModule,
  updatedSource: GleamModule,
): IncrementalGleamLowering | undefined {
  const changes: SignedIntegerChange[] = [];
  if (!sameGleamStructure(previous.source, updatedSource, changes)) return undefined;
  if (changes.length === 0) return undefined;

  const changesBySpan = new Map(
    changes.map((change) => [`${change.startByte}:${change.endByte}`, change]),
  );
  if (changesBySpan.size !== changes.length) return undefined;
  const matchedSpans = new Set<string>();
  const artifact = updateArtifactLiterals(previous.artifact, changesBySpan, matchedSpans);
  if (artifact === previous.artifact || matchedSpans.size !== changes.length) return undefined;
  const ownedArtifact = createOwnedModuleArtifact(artifact as ModuleArtifact);
  return {
    lowered: {
      source: updatedSource,
      definitions: ownedArtifact.definitions,
      typeDeclarations: ownedArtifact.typeDeclarations,
      artifact: ownedArtifact,
    },
    changedLiterals: changes.length,
  };
}

function sameGleamStructure(
  previous: unknown,
  updated: unknown,
  changes: SignedIntegerChange[],
): boolean {
  if (previous === updated) return true;
  if (isGleamInteger(previous) && isGleamInteger(updated)) {
    const previousKeys = Object.keys(previous);
    if (
      previousKeys.length !== Object.keys(updated).length ||
      !previousKeys.every((key) => Object.hasOwn(updated, key))
    ) return false;
    for (const key of previousKeys) {
      if (key === "value") continue;
      if (
        !sameGleamStructure(
          (previous as Readonly<Record<string, unknown>>)[key],
          (updated as Readonly<Record<string, unknown>>)[key],
          changes,
        )
      ) return false;
    }
    if (previous.value !== updated.value) {
      changes.push({
        startByte: updated.span.startByte,
        endByte: updated.span.endByte,
        previousValue: BigInt(previous.value),
        updatedValue: BigInt(updated.value),
      });
    }
    return true;
  }
  if (Array.isArray(previous) && Array.isArray(updated)) {
    return previous.length === updated.length &&
      previous.every((member, index) => sameGleamStructure(member, updated[index], changes));
  }
  if (
    previous === null || updated === null ||
    typeof previous !== "object" || typeof updated !== "object"
  ) {
    return false;
  }
  const previousRecord = previous as Readonly<Record<string, unknown>>;
  const updatedRecord = updated as Readonly<Record<string, unknown>>;
  const keys = Object.keys(previousRecord);
  return keys.length === Object.keys(updatedRecord).length &&
    keys.every((key) =>
      Object.hasOwn(updatedRecord, key) &&
      sameGleamStructure(previousRecord[key], updatedRecord[key], changes)
    );
}

function updateArtifactLiterals(
  value: unknown,
  changesBySpan: ReadonlyMap<string, SignedIntegerChange>,
  matchedSpans: Set<string>,
): unknown {
  if (isSurfaceSignedInteger(value)) {
    const key = `${value.span.startByte}:${value.span.endByte}`;
    const change = changesBySpan.get(key);
    if (change !== undefined && value.value === change.previousValue) {
      matchedSpans.add(key);
      return { ...value, value: change.updatedValue };
    }
    return value;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const members = value.map((member) => {
      const updated = updateArtifactLiterals(member, changesBySpan, matchedSpans);
      if (updated !== member) changed = true;
      return updated;
    });
    return changed ? members : value;
  }
  if (
    value === null || typeof value !== "object" ||
    value instanceof Set || ArrayBuffer.isView(value)
  ) {
    return value;
  }
  const record = value as Readonly<Record<string, unknown>>;
  let changed = false;
  const updated: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(record)) {
    const updatedMember = updateArtifactLiterals(member, changesBySpan, matchedSpans);
    if (updatedMember !== member) changed = true;
    updated[key] = updatedMember;
  }
  return changed ? updated : value;
}

function isGleamInteger(
  value: unknown,
): value is {
  readonly kind: "integer";
  readonly value: number;
  readonly span: { readonly startByte: number; readonly endByte: number };
} {
  return value !== null && typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "integer" &&
    typeof (value as { readonly value?: unknown }).value === "number" &&
    isSpan((value as { readonly span?: unknown }).span);
}

function isSurfaceSignedInteger(
  value: unknown,
): value is {
  readonly kind: "signed-integer-64";
  readonly value: bigint;
  readonly span: { readonly startByte: number; readonly endByte: number };
} {
  return value !== null && typeof value === "object" &&
    (value as { readonly kind?: unknown }).kind === "signed-integer-64" &&
    typeof (value as { readonly value?: unknown }).value === "bigint" &&
    isSpan((value as { readonly span?: unknown }).span);
}

function isSpan(
  value: unknown,
): value is { readonly startByte: number; readonly endByte: number } {
  return value !== null && typeof value === "object" &&
    typeof (value as { readonly startByte?: unknown }).startByte === "number" &&
    typeof (value as { readonly endByte?: unknown }).endByte === "number";
}
