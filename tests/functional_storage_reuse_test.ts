import { deepStrictEqual } from "node:assert/strict";

import { FunctionalPersistentSharing, planFunctionalStorageReuse } from "../functional.ts";

Deno.test("storage reuse pairs an exact-size allocation after the last release", () => {
  const plan = planFunctionalStorageReuse({
    persistentSharing: FunctionalPersistentSharing.ExplicitReferenceCounting,
    operations: [
      { kind: "declare", value: "first", lifetime: "owned" },
      { kind: "retain", value: "first" },
      { kind: "release", value: "first" },
      { kind: "release", value: "first" },
      { kind: "declare", value: "second", lifetime: "owned" },
      { kind: "release", value: "second" },
    ],
  }, [
    { value: "first", byteLength: 32 },
    { value: "second", byteLength: 32 },
  ]);

  deepStrictEqual(plan.referenceCounts, [
    { operation: 1, value: "first", kind: "retain", references: 2 },
    { operation: 2, value: "first", kind: "release", references: 1 },
    { operation: 3, value: "first", kind: "release", references: 0 },
    { operation: 5, value: "second", kind: "release", references: 0 },
  ]);
  deepStrictEqual(plan.reuses, [{
    releasedValue: "first",
    reusedBy: "second",
    byteLength: 32,
    releaseOperation: 3,
    allocationOperation: 4,
  }]);
});

Deno.test("storage reuse keeps differently sized allocations separate", () => {
  const plan = planFunctionalStorageReuse({
    persistentSharing: FunctionalPersistentSharing.ExplicitReferenceCounting,
    operations: [
      { kind: "declare", value: "small", lifetime: "owned" },
      { kind: "release", value: "small" },
      { kind: "declare", value: "large", lifetime: "owned" },
      { kind: "release", value: "large" },
    ],
  }, [
    { value: "small", byteLength: 24 },
    { value: "large", byteLength: 40 },
  ]);

  deepStrictEqual(plan.reuses, []);
});

Deno.test("storage reuse observes children released with their final owned parent", () => {
  const plan = planFunctionalStorageReuse({
    persistentSharing: FunctionalPersistentSharing.ExplicitReferenceCounting,
    operations: [
      { kind: "declare", value: "parent", lifetime: "owned" },
      { kind: "declare", value: "child", lifetime: "owned" },
      { kind: "reference", owner: "parent", target: "child" },
      { kind: "release", value: "parent" },
      { kind: "declare", value: "replacement", lifetime: "owned" },
      { kind: "release", value: "replacement" },
    ],
  }, [
    { value: "parent", byteLength: 40 },
    { value: "child", byteLength: 24 },
    { value: "replacement", byteLength: 24 },
  ]);

  deepStrictEqual(plan.referenceCounts.slice(0, 2), [
    { operation: 3, value: "parent", kind: "release", references: 0 },
    { operation: 3, value: "child", kind: "release", references: 0 },
  ]);
  deepStrictEqual(plan.reuses, [{
    releasedValue: "child",
    reusedBy: "replacement",
    byteLength: 24,
    releaseOperation: 3,
    allocationOperation: 4,
  }]);
});
