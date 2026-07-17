import { deepStrictEqual, match, throws } from "node:assert/strict";

import {
  type FunctionalTypeExpression,
  FunctionalTypeNormalizer,
  type FunctionalTypeProgram,
  type TypeCoreCapabilityRule,
} from "../functional.ts";

const typeKind = { kind: "type" } as const;
const unaryTypeConstructorKind = {
  kind: "constructor",
  parameter: typeKind,
  result: typeKind,
} as const;

function higherKindedProgram(): FunctionalTypeProgram {
  return {
    constructors: [
      { name: "List", parameterKinds: [typeKind] },
      { name: "Maybe", parameterKinds: [typeKind] },
    ],
    functions: [{
      name: "Twice",
      parameters: [
        { name: "container", kind: unaryTypeConstructorKind },
        { name: "value", kind: typeKind },
      ],
      resultKind: typeKind,
      body: {
        kind: "apply",
        constructor: { kind: "reference", name: "container" },
        argument: {
          kind: "apply",
          constructor: { kind: "reference", name: "container" },
          argument: { kind: "reference", name: "value" },
        },
      },
    }],
  };
}

Deno.test("normalizes higher-kinded type functions to the first-order GPU schema", () => {
  const expression: FunctionalTypeExpression = {
    kind: "apply",
    constructor: {
      kind: "apply",
      constructor: { kind: "reference", name: "Twice" },
      argument: { kind: "reference", name: "List" },
    },
    argument: { kind: "integer" },
  };

  const normalized = new FunctionalTypeNormalizer(higherKindedProgram()).normalize(expression);

  deepStrictEqual(normalized.evidence, []);
  deepStrictEqual(normalized.schema, {
    kind: "named",
    name: "List",
    arguments: [{
      kind: "named",
      name: "List",
      arguments: [{ kind: "integer" }],
    }],
  });
});

Deno.test("rejects a saturated type where a higher-kinded argument is required", () => {
  const expression: FunctionalTypeExpression = {
    kind: "apply",
    constructor: {
      kind: "apply",
      constructor: { kind: "reference", name: "Twice" },
      argument: { kind: "integer" },
    },
    argument: { kind: "integer" },
  };

  throws(
    () => new FunctionalTypeNormalizer(higherKindedProgram()).normalize(expression),
    /requires argument kind \(type -> type\); received type/,
  );
});

Deno.test("normalizes associated family outputs selected by capability evidence", () => {
  const listOfInteger = {
    kind: "type",
    type: {
      kind: "named",
      name: "List",
      arguments: [{ kind: "type", type: { kind: "integer" } }],
    },
  } as const;
  const rules: readonly TypeCoreCapabilityRule[] = [{
    id: "list-element",
    predicate: "element",
    inputs: [listOfInteger],
    outputs: [{ kind: "type", type: { kind: "integer" } }],
    premises: [],
    witness: { kind: "erased-proof" },
  }];
  const normalizer = new FunctionalTypeNormalizer(higherKindedProgram(), rules);

  const normalized = normalizer.normalize({
    kind: "associated",
    predicate: "element",
    inputs: [{
      kind: "apply",
      constructor: { kind: "reference", name: "List" },
      argument: { kind: "integer" },
    }],
    output: 0,
  });

  deepStrictEqual(normalized.evidence.map((entry) => entry.ruleId), ["list-element"]);
  deepStrictEqual(normalized.schema, { kind: "integer" });
});

Deno.test("preserves wide numeric primitives through capability resolution", () => {
  const signedInteger64 = {
    kind: "type",
    type: { kind: "named", name: "signed-integer-64", arguments: [] },
  } as const;
  const normalizer = new FunctionalTypeNormalizer(higherKindedProgram(), [{
    id: "wide-identity",
    predicate: "identity",
    inputs: [signedInteger64],
    outputs: [signedInteger64],
    premises: [],
    witness: { kind: "erased-proof" },
  }]);

  const normalized = normalizer.normalize({
    kind: "associated",
    predicate: "identity",
    inputs: [{ kind: "signed-integer-64" }],
    output: 0,
  });

  deepStrictEqual(normalized.schema, { kind: "signed-integer-64" });
});

Deno.test("bounds recursive higher-kinded type execution by transitions", () => {
  const recursive: FunctionalTypeProgram = {
    constructors: [],
    functions: [{
      name: "Loop",
      parameters: [{ name: "value", kind: typeKind }],
      resultKind: typeKind,
      body: {
        kind: "apply",
        constructor: { kind: "reference", name: "Loop" },
        argument: { kind: "reference", name: "value" },
      },
    }],
  };

  throws(
    () =>
      new FunctionalTypeNormalizer(recursive).normalize({
        kind: "apply",
        constructor: { kind: "reference", name: "Loop" },
        argument: { kind: "integer" },
      }, { maximumTransitions: 20 }),
    (error) => {
      match(String(error), /exceeded 20 transitions/);
      return true;
    },
  );
});
