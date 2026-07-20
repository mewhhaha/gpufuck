import { deepStrictEqual, throws } from "node:assert/strict";

import {
  FunctionalPersistentSharing,
  planFunctionalStorageReuse,
  resolveFunctionalUniqueOwnership,
} from "../functional.ts";

Deno.test("unique ownership releases an immutable value after its final use for exact-size reuse", () => {
  const ownership = resolveFunctionalUniqueOwnership({
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "declare", value: "first", lifetime: "owned" },
      { kind: "use", value: "first" },
      { kind: "declare", value: "second", lifetime: "owned" },
      { kind: "use", value: "second" },
    ],
  });

  deepStrictEqual(ownership.releases, [
    { value: "first", lastUseOperation: 1, releaseOperation: 2 },
    { value: "second", lastUseOperation: 3, releaseOperation: 5 },
  ]);
  deepStrictEqual(
    ownership.core.operations.filter((operation) => operation.kind === "release"),
    [
      {
        kind: "release",
        value: "first",
        reason: "unique immutable ownership ends after the graph's final use",
      },
      {
        kind: "release",
        value: "second",
        reason: "unique immutable ownership ends after the graph's final use",
      },
    ],
  );

  const reuse = planFunctionalStorageReuse(ownership.core, [
    { value: "first", byteLength: 32 },
    { value: "second", byteLength: 32 },
  ]);
  deepStrictEqual(reuse.reuses, [{
    releasedValue: "first",
    reusedBy: "second",
    byteLength: 32,
    releaseOperation: 2,
    allocationOperation: 3,
  }]);
});

Deno.test("unique ownership retains a parent until the final use of its immutable child", () => {
  const ownership = resolveFunctionalUniqueOwnership({
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "declare", value: "parent", lifetime: "owned" },
      { kind: "declare", value: "child", lifetime: "owned" },
      { kind: "reference", owner: "parent", target: "child" },
      { kind: "use", value: "parent" },
      { kind: "use", value: "child" },
    ],
  });

  deepStrictEqual(ownership.releases, [{
    value: "parent",
    lastUseOperation: 4,
    releaseOperation: 5,
  }]);
});

Deno.test("unique ownership keeps an escaping immutable graph alive", () => {
  const ownership = resolveFunctionalUniqueOwnership({
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "declare", value: "parent", lifetime: "owned" },
      { kind: "declare", value: "child", lifetime: "owned" },
      { kind: "reference", owner: "parent", target: "child" },
      { kind: "use", value: "child" },
    ],
  }, { escapingValues: ["child"] });

  deepStrictEqual(ownership.releases, []);
  deepStrictEqual(ownership.core.operations, [
    { kind: "declare", value: "parent", lifetime: "owned" },
    { kind: "declare", value: "child", lifetime: "owned" },
    { kind: "reference", owner: "parent", target: "child" },
    { kind: "use", value: "child" },
  ]);
});

Deno.test("unique ownership preserves a graph retained by an arena value", () => {
  const ownership = resolveFunctionalUniqueOwnership({
    persistentSharing: FunctionalPersistentSharing.Reject,
    operations: [
      { kind: "declare", value: "owned", lifetime: "owned" },
      { kind: "enter-arena", arena: "invocation" },
      {
        kind: "declare",
        value: "borrower",
        lifetime: "invocation-arena",
        arena: "invocation",
      },
      { kind: "reference", owner: "borrower", target: "owned" },
      { kind: "use", value: "borrower" },
      { kind: "leave-arena", arena: "invocation" },
    ],
  });

  deepStrictEqual(ownership.releases, []);
});

Deno.test("unique ownership rejects traces that already require shared reference counting", () => {
  throws(
    () =>
      resolveFunctionalUniqueOwnership({
        persistentSharing: FunctionalPersistentSharing.ExplicitReferenceCounting,
        operations: [
          { kind: "declare", value: "shared", lifetime: "owned" },
          { kind: "retain", value: "shared" },
        ],
      }),
    /requires persistent sharing policy "reject"/,
  );
});

Deno.test("unique ownership rejects an explicitly released trace", () => {
  throws(
    () =>
      resolveFunctionalUniqueOwnership({
        persistentSharing: FunctionalPersistentSharing.Reject,
        operations: [
          { kind: "declare", value: "owned", lifetime: "owned" },
          { kind: "release", value: "owned" },
        ],
      }),
    /operation 1 already contains "release"/,
  );
});
