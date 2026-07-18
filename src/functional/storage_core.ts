export const FunctionalPersistentSharing = {
  Reject: "reject",
  HostManaged: "host-managed",
  ExplicitReferenceCounting: "explicit-reference-counting",
} as const;

export type FunctionalPersistentSharing =
  (typeof FunctionalPersistentSharing)[keyof typeof FunctionalPersistentSharing];

export type FunctionalStorageCoreLifetime =
  | "static"
  | "scalar-local"
  | "invocation-arena"
  | "owned"
  | "host-managed";

interface FunctionalStorageCoreEvidence {
  readonly coreNode?: number;
  readonly reason?: string;
}

export type FunctionalStorageCoreOperation =
  | (FunctionalStorageCoreEvidence & {
    readonly kind: "enter-arena";
    readonly arena: string;
  })
  | (FunctionalStorageCoreEvidence & {
    readonly kind: "leave-arena";
    readonly arena: string;
  })
  | (FunctionalStorageCoreEvidence & {
    readonly kind: "declare";
    readonly value: string;
    readonly lifetime: FunctionalStorageCoreLifetime;
    readonly arena?: string;
  })
  | (FunctionalStorageCoreEvidence & {
    readonly kind: "reference";
    readonly owner: string;
    readonly target: string;
  })
  | (FunctionalStorageCoreEvidence & {
    readonly kind: "promote";
    readonly source: string;
    readonly target: string;
    readonly targetLifetime: "parent-arena" | "owned";
  })
  | (FunctionalStorageCoreEvidence & {
    readonly kind: "retain";
    readonly value: string;
  })
  | (FunctionalStorageCoreEvidence & {
    readonly kind: "release";
    readonly value: string;
  })
  | (FunctionalStorageCoreEvidence & {
    readonly kind: "use";
    readonly value: string;
  });

export interface FunctionalStorageCoreProgram {
  readonly persistentSharing: FunctionalPersistentSharing;
  readonly operations: readonly FunctionalStorageCoreOperation[];
}

export type FunctionalStorageDiagnosticCode =
  | "F6001"
  | "F6002"
  | "F6003"
  | "F6004"
  | "F6005"
  | "F6006";

export type FunctionalStorageFaultKind =
  | "malformed-storage-core"
  | "lifetime-escape"
  | "expired-value"
  | "invalid-ownership"
  | "persistent-sharing"
  | "arena-order";

export interface FunctionalStorageDiagnostic {
  readonly code: FunctionalStorageDiagnosticCode;
  readonly kind: FunctionalStorageFaultKind;
  readonly operation: number;
  readonly coreNode?: number;
  readonly message: string;
}

export type FunctionalStorageVerification =
  | {
    readonly ok: true;
    readonly arenaCount: number;
    readonly valueCount: number;
    readonly promotionCount: number;
  }
  | { readonly ok: false; readonly diagnostic: FunctionalStorageDiagnostic };

interface ArenaState {
  readonly parent: string | undefined;
}

interface ValueState {
  readonly lifetime: FunctionalStorageCoreLifetime;
  readonly arena: string | undefined;
  readonly ownedTargets: Set<string>;
  readonly persistentOwners: Set<string>;
  references: number;
  active: boolean;
}

export class FunctionalStorageCoreError extends Error {
  readonly code: FunctionalStorageDiagnosticCode;
  readonly kind: FunctionalStorageFaultKind;
  readonly operation: number;
  readonly coreNode: number | undefined;

  constructor(readonly diagnostic: FunctionalStorageDiagnostic) {
    super(`${diagnostic.code}: ${diagnostic.message}`);
    this.name = "FunctionalStorageCoreError";
    this.code = diagnostic.code;
    this.kind = diagnostic.kind;
    this.operation = diagnostic.operation;
    this.coreNode = diagnostic.coreNode;
  }
}

export function requireVerifiedFunctionalStorageCore(
  program: FunctionalStorageCoreProgram,
): void {
  const verification = verifyFunctionalStorageCore(program);
  if (!verification.ok) throw new FunctionalStorageCoreError(verification.diagnostic);
}

export function verifyFunctionalStorageCore(
  program: FunctionalStorageCoreProgram,
): FunctionalStorageVerification {
  if (program === null || typeof program !== "object") {
    return failure(
      "F6001",
      "malformed-storage-core",
      0,
      undefined,
      "Functional Storage Core program must be an object",
    );
  }
  if (!Object.values(FunctionalPersistentSharing).includes(program.persistentSharing)) {
    return failure(
      "F6001",
      "malformed-storage-core",
      0,
      undefined,
      `Functional Storage Core has unsupported persistent sharing policy ${
        JSON.stringify(program.persistentSharing)
      }`,
    );
  }
  if (!Array.isArray(program.operations)) {
    return failure(
      "F6001",
      "malformed-storage-core",
      0,
      undefined,
      "Functional Storage Core operations must be an array",
    );
  }

  const arenas = new Map<string, ArenaState>();
  const arenaStack: string[] = [];
  const values = new Map<string, ValueState>();
  let promotionCount = 0;
  for (const [operationIndex, operation] of program.operations.entries()) {
    const malformed = requireOperationShape(operation, operationIndex);
    if (malformed !== undefined) return malformed;
    const fail = (
      code: FunctionalStorageDiagnosticCode,
      kind: FunctionalStorageFaultKind,
      message: string,
    ): FunctionalStorageVerification =>
      failure(code, kind, operationIndex, operation.coreNode, message);

    if (operation.kind === "enter-arena") {
      if (arenas.has(operation.arena)) {
        return fail(
          "F6001",
          "malformed-storage-core",
          `Functional Storage Core operation ${operationIndex} repeats arena ${
            JSON.stringify(operation.arena)
          }`,
        );
      }
      arenas.set(operation.arena, {
        parent: arenaStack.at(-1),
      });
      arenaStack.push(operation.arena);
      continue;
    }

    if (operation.kind === "leave-arena") {
      const currentArena = arenaStack.at(-1);
      if (currentArena !== operation.arena) {
        return fail(
          "F6006",
          "arena-order",
          `Functional Storage Core operation ${operationIndex} leaves arena ${
            JSON.stringify(operation.arena)
          } while ${JSON.stringify(currentArena)} is innermost`,
        );
      }
      arenaStack.pop();
      for (const value of values.values()) {
        if (value.arena === operation.arena) value.active = false;
      }
      continue;
    }

    if (operation.kind === "declare") {
      if (values.has(operation.value)) {
        return fail(
          "F6001",
          "malformed-storage-core",
          `Functional Storage Core operation ${operationIndex} repeats value ${
            JSON.stringify(operation.value)
          }`,
        );
      }
      if (
        operation.lifetime === "invocation-arena" || operation.lifetime === "scalar-local"
      ) {
        const currentArena = arenaStack.at(-1);
        if (operation.arena === undefined || operation.arena !== currentArena) {
          return fail(
            "F6006",
            "arena-order",
            `Functional Storage Core arena value ${JSON.stringify(operation.value)} names ${
              JSON.stringify(operation.arena)
            } while ${JSON.stringify(currentArena)} is innermost`,
          );
        }
      } else if (operation.arena !== undefined) {
        return fail(
          "F6001",
          "malformed-storage-core",
          `Functional Storage Core ${operation.lifetime} value ${
            JSON.stringify(operation.value)
          } cannot name arena ${JSON.stringify(operation.arena)}`,
        );
      } else if (arenaStack.length !== 0) {
        return fail(
          "F6006",
          "arena-order",
          `Functional Storage Core ${operation.lifetime} value ${
            JSON.stringify(operation.value)
          } must be declared outside active arena ${JSON.stringify(arenaStack.at(-1))}`,
        );
      }
      values.set(operation.value, {
        lifetime: operation.lifetime,
        arena: operation.arena,
        ownedTargets: new Set(),
        persistentOwners: new Set(),
        references: operation.lifetime === "owned" ? 1 : 0,
        active: true,
      });
      continue;
    }

    if (operation.kind === "promote") {
      const source = activeValue(values, operation.source);
      if (source === undefined) {
        return fail(
          "F6003",
          "expired-value",
          `Functional Storage Core promotion source ${
            JSON.stringify(operation.source)
          } is absent or expired`,
        );
      }
      if (source.lifetime !== "invocation-arena") {
        return fail(
          "F6004",
          "invalid-ownership",
          `Functional Storage Core promotion source ${
            JSON.stringify(operation.source)
          } has ${source.lifetime} lifetime instead of invocation-arena`,
        );
      }
      if (values.has(operation.target)) {
        return fail(
          "F6001",
          "malformed-storage-core",
          `Functional Storage Core promotion target ${
            JSON.stringify(operation.target)
          } already exists`,
        );
      }
      const sourceArena = source.arena === undefined ? undefined : arenas.get(source.arena);
      if (operation.targetLifetime === "owned" && sourceArena?.parent !== undefined) {
        return fail(
          "F6006",
          "arena-order",
          `Functional Storage Core promotion ${JSON.stringify(operation.source)} -> ${
            JSON.stringify(operation.target)
          } must use parent-arena before leaving nested arena ${JSON.stringify(source.arena)}`,
        );
      }
      if (operation.targetLifetime === "parent-arena" && sourceArena?.parent === undefined) {
        return fail(
          "F6006",
          "arena-order",
          `Functional Storage Core promotion ${JSON.stringify(operation.source)} -> ${
            JSON.stringify(operation.target)
          } has no parent arena`,
        );
      }
      const targetArena = operation.targetLifetime === "parent-arena"
        ? sourceArena?.parent
        : undefined;
      values.set(operation.target, {
        lifetime: operation.targetLifetime === "owned" ? "owned" : "invocation-arena",
        arena: targetArena,
        ownedTargets: new Set(),
        persistentOwners: new Set(),
        references: operation.targetLifetime === "owned" ? 1 : 0,
        active: true,
      });
      promotionCount += 1;
      continue;
    }

    const valueName = operation.kind === "reference" ? operation.target : operation.value;
    const value = activeValue(values, valueName);
    if (value === undefined) {
      return fail(
        "F6003",
        "expired-value",
        `Functional Storage Core ${operation.kind} names absent or expired value ${
          JSON.stringify(valueName)
        }`,
      );
    }

    if (operation.kind === "use") continue;
    if (operation.kind === "retain") {
      if (value.lifetime !== "owned") {
        return fail(
          "F6004",
          "invalid-ownership",
          `Functional Storage Core cannot retain ${value.lifetime} value ${
            JSON.stringify(operation.value)
          }`,
        );
      }
      value.references += 1;
      continue;
    }
    if (operation.kind === "release") {
      if (value.lifetime !== "owned") {
        return fail(
          "F6004",
          "invalid-ownership",
          `Functional Storage Core cannot release ${value.lifetime} value ${
            JSON.stringify(operation.value)
          }`,
        );
      }
      const pendingReleases = [operation.value];
      while (pendingReleases.length !== 0) {
        const currentName = pendingReleases.pop();
        if (currentName === undefined) continue;
        const current = activeValue(values, currentName);
        if (current === undefined) {
          return fail(
            "F6004",
            "invalid-ownership",
            `Functional Storage Core owned release reached absent or expired value ${
              JSON.stringify(currentName)
            } from ${JSON.stringify(operation.value)}`,
          );
        }
        current.references -= 1;
        if (current.references < current.persistentOwners.size) {
          return fail(
            "F6004",
            "invalid-ownership",
            `Functional Storage Core owned value ${
              JSON.stringify(currentName)
            } has reference count ${current.references} below its ${current.persistentOwners.size} persistent owners`,
          );
        }
        if (current.references !== 0) continue;
        current.active = false;
        for (const targetName of current.ownedTargets) {
          const target = activeValue(values, targetName);
          if (target === undefined || !target.persistentOwners.delete(currentName)) {
            return fail(
              "F6004",
              "invalid-ownership",
              `Functional Storage Core owned value ${
                JSON.stringify(currentName)
              } has an invalid live edge to ${JSON.stringify(targetName)}`,
            );
          }
          pendingReleases.push(targetName);
        }
      }
      continue;
    }

    const owner = activeValue(values, operation.owner);
    if (owner === undefined) {
      return fail(
        "F6003",
        "expired-value",
        `Functional Storage Core reference owner ${
          JSON.stringify(operation.owner)
        } is absent or expired`,
      );
    }
    if (!canReference(owner, value, arenas)) {
      return fail(
        "F6002",
        "lifetime-escape",
        `Functional Storage Core ${owner.lifetime} value ${
          JSON.stringify(operation.owner)
        } cannot retain ${value.lifetime} value ${JSON.stringify(operation.target)}`,
      );
    }
    if (owner.lifetime === "owned" && value.lifetime === "owned") {
      if (
        operation.owner === operation.target ||
        ownedPathReaches(values, operation.target, operation.owner)
      ) {
        return fail(
          "F6005",
          "persistent-sharing",
          `Functional Storage Core reference ${JSON.stringify(operation.owner)} -> ${
            JSON.stringify(operation.target)
          } creates an owned cycle that explicit release cannot collect`,
        );
      }
      owner.ownedTargets.add(operation.target);
      value.persistentOwners.add(operation.owner);
      if (value.persistentOwners.size > 1) {
        if (program.persistentSharing === FunctionalPersistentSharing.Reject) {
          return fail(
            "F6005",
            "persistent-sharing",
            `Functional Storage Core owned value ${
              JSON.stringify(operation.target)
            } has ${value.persistentOwners.size} persistent owners under reject policy`,
          );
        }
        if (
          program.persistentSharing === FunctionalPersistentSharing.ExplicitReferenceCounting &&
          value.references < value.persistentOwners.size
        ) {
          return fail(
            "F6004",
            "invalid-ownership",
            `Functional Storage Core owned value ${
              JSON.stringify(operation.target)
            } has ${value.persistentOwners.size} owners but reference count ${value.references}`,
          );
        }
        if (program.persistentSharing === FunctionalPersistentSharing.HostManaged) {
          return fail(
            "F6005",
            "persistent-sharing",
            `Functional Storage Core owned value ${
              JSON.stringify(operation.target)
            } must be host-managed before persistent sharing`,
          );
        }
      }
    }
  }

  if (arenaStack.length !== 0) {
    return failure(
      "F6006",
      "arena-order",
      program.operations.length,
      undefined,
      `Functional Storage Core ends with active arenas ${
        JSON.stringify([...arenaStack].reverse())
      }`,
    );
  }
  return {
    ok: true,
    arenaCount: arenas.size,
    valueCount: values.size,
    promotionCount,
  };
}

function ownedPathReaches(
  values: ReadonlyMap<string, ValueState>,
  start: string,
  target: string,
): boolean {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length !== 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === target) return true;
    visited.add(current);
    const value = values.get(current);
    if (value !== undefined) pending.push(...value.ownedTargets);
  }
  return false;
}

function activeValue(
  values: ReadonlyMap<string, ValueState>,
  name: string,
): ValueState | undefined {
  const value = values.get(name);
  return value?.active === true ? value : undefined;
}

function canReference(
  owner: ValueState,
  target: ValueState,
  arenas: ReadonlyMap<string, ArenaState>,
): boolean {
  if (target.lifetime === "static" || target.lifetime === "host-managed") return true;
  if (owner.lifetime === "static" || owner.lifetime === "host-managed") return false;
  if (owner.lifetime === "owned") return target.lifetime === "owned";
  if (target.lifetime === "owned") return true;
  if (owner.arena === undefined || target.arena === undefined) return false;
  return owner.arena === target.arena || arenaIsAncestor(target.arena, owner.arena, arenas);
}

function arenaIsAncestor(
  possibleAncestor: string,
  arena: string,
  arenas: ReadonlyMap<string, ArenaState>,
): boolean {
  let parent = arenas.get(arena)?.parent;
  while (parent !== undefined) {
    if (parent === possibleAncestor) return true;
    parent = arenas.get(parent)?.parent;
  }
  return false;
}

function requireOperationShape(
  operation: FunctionalStorageCoreOperation,
  operationIndex: number,
): FunctionalStorageVerification | undefined {
  if (operation === null || typeof operation !== "object" || typeof operation.kind !== "string") {
    return failure(
      "F6001",
      "malformed-storage-core",
      operationIndex,
      undefined,
      `Functional Storage Core operation ${operationIndex} must be an object with a kind`,
    );
  }
  if (
    operation.coreNode !== undefined &&
    (!Number.isSafeInteger(operation.coreNode) || operation.coreNode < 0)
  ) {
    return failure(
      "F6001",
      "malformed-storage-core",
      operationIndex,
      undefined,
      `Functional Storage Core operation ${operationIndex} coreNode must be a non-negative safe integer; received ${
        JSON.stringify(operation.coreNode)
      }`,
    );
  }
  if (operation.reason !== undefined && typeof operation.reason !== "string") {
    return failure(
      "F6001",
      "malformed-storage-core",
      operationIndex,
      operation.coreNode,
      `Functional Storage Core operation ${operationIndex} reason must be a string; received ${
        JSON.stringify(operation.reason)
      }`,
    );
  }
  const names: unknown[] = [];
  if (operation.kind === "enter-arena" || operation.kind === "leave-arena") {
    names.push(operation.arena);
  } else if (operation.kind === "declare") {
    names.push(operation.value);
    if (
      operation.lifetime !== "static" && operation.lifetime !== "scalar-local" &&
      operation.lifetime !== "invocation-arena" && operation.lifetime !== "owned" &&
      operation.lifetime !== "host-managed"
    ) {
      return failure(
        "F6001",
        "malformed-storage-core",
        operationIndex,
        operation.coreNode,
        `Functional Storage Core declaration ${operationIndex} has unsupported lifetime ${
          JSON.stringify(operation.lifetime)
        }`,
      );
    }
  } else if (operation.kind === "reference") {
    names.push(operation.owner, operation.target);
  } else if (operation.kind === "promote") {
    names.push(operation.source, operation.target);
    if (
      operation.targetLifetime !== "parent-arena" && operation.targetLifetime !== "owned"
    ) {
      return failure(
        "F6001",
        "malformed-storage-core",
        operationIndex,
        operation.coreNode,
        `Functional Storage Core promotion ${operationIndex} has unsupported targetLifetime ${
          JSON.stringify(operation.targetLifetime)
        }`,
      );
    }
  } else if (
    operation.kind === "retain" || operation.kind === "release" || operation.kind === "use"
  ) {
    names.push(operation.value);
  } else {
    return failure(
      "F6001",
      "malformed-storage-core",
      operationIndex,
      undefined,
      `Functional Storage Core operation ${operationIndex} has unsupported kind ${
        JSON.stringify((operation as { readonly kind: unknown }).kind)
      }`,
    );
  }
  if (names.some((name) => typeof name !== "string" || name.length === 0)) {
    return failure(
      "F6001",
      "malformed-storage-core",
      operationIndex,
      operation.coreNode,
      `Functional Storage Core operation ${operationIndex} requires non-empty symbolic names`,
    );
  }
  return undefined;
}

function failure(
  code: FunctionalStorageDiagnosticCode,
  kind: FunctionalStorageFaultKind,
  operation: number,
  coreNode: number | undefined,
  message: string,
): FunctionalStorageVerification {
  return {
    ok: false,
    diagnostic: {
      code,
      kind,
      operation,
      ...(coreNode === undefined ? {} : { coreNode }),
      message,
    },
  };
}
