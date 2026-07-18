import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";

import {
  FunctionalPersistentSharing,
  FunctionalStorageCoreError,
  type FunctionalStorageCoreProgram,
  requireVerifiedFunctionalStorageCore,
  verifyFunctionalStorageCore,
} from "../functional.ts";

Deno.test("Storage Core accepts nested lexical arenas and explicit promotion", () => {
  const program: FunctionalStorageCoreProgram = {
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "declare", value: "constant", lifetime: "static" },
      { kind: "enter-arena", arena: "invocation" },
      {
        kind: "declare",
        value: "request",
        lifetime: "invocation-arena",
        arena: "invocation",
      },
      { kind: "enter-arena", arena: "branch" },
      {
        kind: "declare",
        value: "branch-result",
        lifetime: "invocation-arena",
        arena: "branch",
      },
      { kind: "reference", owner: "branch-result", target: "request" },
      {
        kind: "promote",
        source: "branch-result",
        target: "branch-result-in-invocation",
        targetLifetime: "parent-arena",
      },
      { kind: "leave-arena", arena: "branch" },
      { kind: "use", value: "branch-result-in-invocation" },
      {
        kind: "promote",
        source: "request",
        target: "owned-result",
        targetLifetime: "owned",
      },
      { kind: "leave-arena", arena: "invocation" },
      { kind: "use", value: "owned-result" },
      { kind: "release", value: "owned-result" },
    ],
  };

  deepStrictEqual(verifyFunctionalStorageCore(program), {
    ok: true,
    arenaCount: 2,
    valueCount: 5,
    promotionCount: 2,
  });
});

Deno.test("Storage Core reports an arena value escaping into an outer owner", () => {
  const verification = verifyFunctionalStorageCore({
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "enter-arena", arena: "outer" },
      {
        kind: "declare",
        value: "outer-value",
        lifetime: "invocation-arena",
        arena: "outer",
      },
      { kind: "enter-arena", arena: "inner" },
      {
        kind: "declare",
        value: "inner-value",
        lifetime: "invocation-arena",
        arena: "inner",
        coreNode: 17,
      },
      {
        kind: "reference",
        owner: "outer-value",
        target: "inner-value",
        coreNode: 18,
      },
    ],
  });

  equal(verification.ok, false);
  if (verification.ok) return;
  equal(verification.diagnostic.code, "F6002");
  equal(verification.diagnostic.kind, "lifetime-escape");
  equal(verification.diagnostic.operation, 4);
  equal(verification.diagnostic.coreNode, 18);
  ok(verification.diagnostic.message.includes('"outer-value"'));
  ok(verification.diagnostic.message.includes('"inner-value"'));
});

Deno.test("Storage Core rejects use after an arena leaves scope", () => {
  const program: FunctionalStorageCoreProgram = {
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "enter-arena", arena: "temporary" },
      {
        kind: "declare",
        value: "temporary-value",
        lifetime: "invocation-arena",
        arena: "temporary",
      },
      { kind: "leave-arena", arena: "temporary" },
      { kind: "use", value: "temporary-value", coreNode: 9 },
    ],
  };

  throws(
    () => requireVerifiedFunctionalStorageCore(program),
    (error) => {
      ok(error instanceof FunctionalStorageCoreError);
      equal(error.code, "F6003");
      equal(error.kind, "expired-value");
      equal(error.operation, 3);
      equal(error.coreNode, 9);
      return true;
    },
  );
});

Deno.test("Storage Core requires arenas to leave in lexical order", () => {
  const verification = verifyFunctionalStorageCore({
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "enter-arena", arena: "outer" },
      { kind: "enter-arena", arena: "inner" },
      { kind: "leave-arena", arena: "outer" },
    ],
  });

  equal(verification.ok, false);
  if (verification.ok) return;
  equal(verification.diagnostic.code, "F6006");
  ok(verification.diagnostic.message.includes('"inner"'));
});

Deno.test("Storage Core rejects implicit persistent sharing", () => {
  const verification = verifyFunctionalStorageCore(
    sharedOwnedValueProgram(FunctionalPersistentSharing.Reject, false),
  );

  equal(verification.ok, false);
  if (verification.ok) return;
  equal(verification.diagnostic.code, "F6005");
  equal(verification.diagnostic.kind, "persistent-sharing");
});

Deno.test("Storage Core accepts persistent sharing after an explicit retain", () => {
  const verification = verifyFunctionalStorageCore(
    sharedOwnedValueProgram(FunctionalPersistentSharing.ExplicitReferenceCounting, true),
  );

  equal(verification.ok, true);
});

Deno.test("Storage Core accepts shared values with host-managed lifetime", () => {
  const verification = verifyFunctionalStorageCore({
    persistentSharing: FunctionalPersistentSharing.HostManaged,
    operations: [
      { kind: "declare", value: "first-owner", lifetime: "owned" },
      { kind: "declare", value: "second-owner", lifetime: "owned" },
      { kind: "declare", value: "shared-value", lifetime: "host-managed" },
      { kind: "reference", owner: "first-owner", target: "shared-value" },
      { kind: "reference", owner: "second-owner", target: "shared-value" },
    ],
  });

  equal(verification.ok, true);
});

Deno.test("Storage Core rejects owned cycles that reference counting cannot collect", () => {
  const verification = verifyFunctionalStorageCore({
    persistentSharing: FunctionalPersistentSharing.ExplicitReferenceCounting,
    operations: [
      { kind: "declare", value: "left", lifetime: "owned" },
      { kind: "declare", value: "right", lifetime: "owned" },
      { kind: "reference", owner: "left", target: "right" },
      { kind: "reference", owner: "right", target: "left" },
    ],
  });

  equal(verification.ok, false);
  if (verification.ok) return;
  equal(verification.diagnostic.code, "F6005");
  ok(verification.diagnostic.message.includes("owned cycle"));
});

Deno.test("Storage Core rejects releasing a value retained by a live owner", () => {
  const verification = verifyFunctionalStorageCore({
    persistentSharing: FunctionalPersistentSharing.ExplicitReferenceCounting,
    operations: [
      { kind: "declare", value: "owner", lifetime: "owned" },
      { kind: "declare", value: "target", lifetime: "owned" },
      { kind: "reference", owner: "owner", target: "target" },
      { kind: "release", value: "target" },
    ],
  });

  equal(verification.ok, false);
  if (verification.ok) return;
  equal(verification.diagnostic.code, "F6004");
  ok(verification.diagnostic.message.includes("persistent owners"));
});

Deno.test("Storage Core release recursively retires exclusively owned values", () => {
  const verification = verifyFunctionalStorageCore({
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "declare", value: "root", lifetime: "owned" },
      { kind: "declare", value: "child", lifetime: "owned" },
      { kind: "declare", value: "leaf", lifetime: "owned" },
      { kind: "reference", owner: "root", target: "child" },
      { kind: "reference", owner: "child", target: "leaf" },
      { kind: "release", value: "root" },
      { kind: "use", value: "leaf" },
    ],
  });

  equal(verification.ok, false);
  if (verification.ok) return;
  equal(verification.diagnostic.code, "F6003");
  ok(verification.diagnostic.message.includes('"leaf"'));
});

Deno.test("Storage Core retains a shared value until its final owner releases", () => {
  const verification = verifyFunctionalStorageCore({
    persistentSharing: FunctionalPersistentSharing.ExplicitReferenceCounting,
    operations: [
      { kind: "declare", value: "first-owner", lifetime: "owned" },
      { kind: "declare", value: "second-owner", lifetime: "owned" },
      { kind: "declare", value: "shared", lifetime: "owned" },
      { kind: "reference", owner: "first-owner", target: "shared" },
      { kind: "retain", value: "shared" },
      { kind: "reference", owner: "second-owner", target: "shared" },
      { kind: "release", value: "first-owner" },
      { kind: "use", value: "shared" },
      { kind: "release", value: "second-owner" },
      { kind: "use", value: "shared" },
    ],
  });

  equal(verification.ok, false);
  if (verification.ok) return;
  equal(verification.diagnostic.code, "F6003");
  equal(verification.diagnostic.operation, 9);
});

Deno.test("Storage Core verifies 1024 deterministic lexical ownership graphs", () => {
  let randomState = 0x6d2b79f5;
  const random = (): number => {
    randomState = Math.imul(randomState ^ randomState >>> 15, 1 | randomState);
    randomState ^= randomState + Math.imul(randomState ^ randomState >>> 7, 61 | randomState);
    return (randomState ^ randomState >>> 14) >>> 0;
  };

  for (let graph = 0; graph < 1_024; graph++) {
    const depth = random() % 8 + 1;
    const operations: FunctionalStorageCoreProgram["operations"][number][] = [];
    for (let arena = 0; arena < depth; arena++) {
      operations.push({ kind: "enter-arena", arena: `arena-${arena}` });
      operations.push({
        kind: "declare",
        value: `value-${arena}`,
        lifetime: "invocation-arena",
        arena: `arena-${arena}`,
      });
      if (arena > 0) {
        operations.push({
          kind: "reference",
          owner: `value-${arena}`,
          target: `value-${random() % arena}`,
        });
      }
    }
    for (let arena = depth - 1; arena >= 0; arena--) {
      operations.push({ kind: "leave-arena", arena: `arena-${arena}` });
    }
    const verification = verifyFunctionalStorageCore({
      persistentSharing: FunctionalPersistentSharing.Reject,
      operations,
    });
    ok(verification.ok, verification.ok ? undefined : verification.diagnostic.message);
  }
});

function sharedOwnedValueProgram(
  persistentSharing: FunctionalPersistentSharing,
  retainSharedValue: boolean,
): FunctionalStorageCoreProgram {
  return {
    persistentSharing,
    operations: [
      { kind: "declare", value: "first-owner", lifetime: "owned" },
      { kind: "declare", value: "second-owner", lifetime: "owned" },
      { kind: "declare", value: "shared-value", lifetime: "owned" },
      { kind: "reference", owner: "first-owner", target: "shared-value" },
      ...(retainSharedValue ? [{ kind: "retain" as const, value: "shared-value" }] : []),
      { kind: "reference", owner: "second-owner", target: "shared-value" },
    ],
  };
}
