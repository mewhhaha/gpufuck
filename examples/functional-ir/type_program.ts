import {
  FunctionalTypeNormalizer,
  type FunctionalTypeProgram,
  type TypeCoreCapabilityRule,
} from "../../functional.ts";

const typeKind = { kind: "type" } as const;
const unaryConstructorKind = {
  kind: "constructor",
  parameter: typeKind,
  result: typeKind,
} as const;
const program: FunctionalTypeProgram = {
  constructors: [{ name: "List", parameterKinds: [typeKind] }],
  functions: [{
    name: "Twice",
    parameters: [
      { name: "container", kind: unaryConstructorKind },
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
const listOfInteger = {
  kind: "type",
  type: {
    kind: "named",
    name: "List",
    arguments: [{ kind: "type", type: { kind: "integer" } }],
  },
} as const;
const families: readonly TypeCoreCapabilityRule[] = [{
  id: "list-element",
  predicate: "element",
  inputs: [listOfInteger],
  outputs: [{ kind: "type", type: { kind: "integer" } }],
  premises: [],
  witness: { kind: "erased-proof" },
}];
const types = new FunctionalTypeNormalizer(program, families);

const nestedList = types.normalize({
  kind: "apply",
  constructor: {
    kind: "apply",
    constructor: { kind: "reference", name: "Twice" },
    argument: { kind: "reference", name: "List" },
  },
  argument: { kind: "integer" },
});
const element = types.normalize({
  kind: "associated",
  predicate: "element",
  inputs: [{
    kind: "apply",
    constructor: { kind: "reference", name: "List" },
    argument: { kind: "integer" },
  }],
  output: 0,
});

console.log(JSON.stringify({ nestedList, element }, null, 2));
