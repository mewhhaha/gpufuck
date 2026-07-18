import {
  type EncodedFunctionalModule,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  type FunctionalTypeSchema,
} from "../functional/abi.ts";
import type {
  TypeCoreCapabilityEvidence,
  TypeCoreCapabilityRule,
} from "../functional/capability_contract.ts";
import { TypeCoreCapabilityResolver } from "../functional/capability_resolver.ts";
import {
  type FunctionalRow,
  type FunctionalRowSubstitutionEntry,
  unifyFunctionalRows,
} from "../functional/row_types.ts";
import { buildFunctionalSurfaceModule, surface } from "../functional/surface_builder.ts";
import { FunctionalTypeNormalizer } from "../functional/type_program.ts";
import { type ParsedPureScriptTypeProfile, parsePureScriptTypeProfile } from "./parser.ts";

export interface PureScriptTypeProfile {
  readonly source: ParsedPureScriptTypeProfile;
  readonly projectedRow: FunctionalRow;
  readonly rowSubstitution: readonly FunctionalRowSubstitutionEntry[];
  readonly convertedType: FunctionalTypeSchema;
  readonly functorEvidence: TypeCoreCapabilityEvidence;
  readonly rank2Module: EncodedFunctionalModule;
  readonly transitions: {
    readonly rows: number;
    readonly associatedType: number;
    readonly capability: number;
  };
}

const rules: readonly TypeCoreCapabilityRule[] = [
  {
    id: "convert-int-text",
    predicate: "Convert",
    inputs: [{ kind: "type", type: { kind: "integer" } }],
    outputs: [{
      kind: "type",
      type: { kind: "named", name: "Text", arguments: [] },
    }],
    premises: [],
    witness: { kind: "compile-time", symbol: "convertIntText" },
  },
  {
    id: "functor-array",
    predicate: "Functor",
    inputs: [{
      kind: "type",
      type: { kind: "named", name: "Array", arguments: [] },
    }],
    outputs: [],
    premises: [],
    witness: { kind: "runtime-dictionary", symbol: "functorArray" },
  },
  {
    id: "functor-maybe",
    predicate: "Functor",
    inputs: [{
      kind: "type",
      type: { kind: "named", name: "Maybe", arguments: [] },
    }],
    outputs: [],
    premises: [],
    witness: { kind: "runtime-dictionary", symbol: "functorMaybe" },
  },
  {
    id: "functor-compose",
    predicate: "Functor",
    inputs: [{
      kind: "type",
      type: {
        kind: "named",
        name: "Compose",
        arguments: [
          { kind: "variable", name: "outer", valueKind: "type" },
          { kind: "variable", name: "inner", valueKind: "type" },
        ],
      },
    }],
    outputs: [],
    premises: [
      {
        predicate: "Functor",
        inputs: [{ kind: "variable", name: "outer", valueKind: "type" }],
      },
      {
        predicate: "Functor",
        inputs: [{ kind: "variable", name: "inner", valueKind: "type" }],
      },
    ],
    witness: { kind: "runtime-dictionary", symbol: "functorCompose" },
  },
];

export function createPureScriptTypeProfile(source: string): PureScriptTypeProfile {
  const parsedSource = parsePureScriptTypeProfile(source);
  requireProfileFeatures(parsedSource);
  const rows = unifyFunctionalRows(
    {
      kind: "record",
      fields: [{ label: "x", type: { kind: "integer" } }],
      tail: "rest",
    },
    {
      kind: "record",
      fields: [
        { label: "label", type: { kind: "named", name: "Text", arguments: [] } },
        { label: "x", type: { kind: "integer" } },
      ],
      tail: null,
    },
  );
  if (!rows.ok) throw new Error(`PureScript row profile failed: ${rows.message}`);

  const normalizer = new FunctionalTypeNormalizer({ constructors: [], functions: [] }, rules);
  const conversion = normalizer.normalize({
    kind: "associated",
    predicate: "Convert",
    inputs: [{ kind: "integer" }],
    output: 0,
  });

  const capability = new TypeCoreCapabilityResolver(rules).resolve({
    predicate: "Functor",
    inputs: [{
      kind: "type",
      type: {
        kind: "named",
        name: "Compose",
        arguments: [
          { kind: "type", type: { kind: "named", name: "Array", arguments: [] } },
          { kind: "type", type: { kind: "named", name: "Maybe", arguments: [] } },
        ],
      },
    }],
  });
  if (!capability.ok) {
    throw new Error(`PureScript higher-kinded capability profile failed: ${capability.message}`);
  }

  return Object.freeze({
    source: parsedSource,
    projectedRow: rows.row,
    rowSubstitution: rows.substitution,
    convertedType: conversion.schema,
    functorEvidence: capability.evidence,
    rank2Module: createRank2Module(),
    transitions: {
      rows: rows.transitions,
      associatedType: conversion.transitions,
      capability: capability.transitions,
    },
  });
}

function requireProfileFeatures(source: ParsedPureScriptTypeProfile): void {
  const compose = source.newtypes.find((declaration) => declaration.name === "Compose");
  if (compose === undefined || compose.parameters.length !== 3) {
    throw new Error("PureScript profile must declare newtype Compose with three parameters.");
  }
  const convert = source.classes.find((declaration) => declaration.name === "Convert");
  if (
    convert?.dependency === null || convert === undefined ||
    convert.dependency.inputs.join(",") !== "a" || convert.dependency.outputs.join(",") !== "b"
  ) {
    throw new Error(
      "PureScript profile must declare the functional dependency Convert a b | a -> b.",
    );
  }
  if (!source.instances.some((declaration) => declaration.className === "Convert")) {
    throw new Error("PureScript profile must declare a Convert instance.");
  }
  if (!source.signatures.some((signature) => signature.name === "getX" && signature.hasOpenRow)) {
    throw new Error("PureScript profile must declare getX with an open record row.");
  }
  if (
    !source.signatures.some((signature) =>
      signature.name === "applyTwice" && signature.acceptsPolymorphicArgument
    )
  ) {
    throw new Error("PureScript profile must declare applyTwice with a rank-2 argument.");
  }
}

function createRank2Module(): EncodedFunctionalModule {
  const polymorphicIdentity = {
    kind: "forall",
    parameters: ["value"],
    body: {
      kind: "function",
      parameter: { kind: "parameter", name: "value" },
      result: { kind: "parameter", name: "value" },
    },
  } as const;
  const result = {
    kind: "tuple",
    values: [{ kind: "integer" }, { kind: "boolean" }],
  } as const;
  return buildFunctionalSurfaceModule(
    [
      {
        name: "identity",
        parameters: [],
        annotation: null,
        body: surface.lambda("value", surface.name("value")),
      },
      {
        name: "applyTwice",
        parameters: [],
        annotation: { kind: "function", parameter: polymorphicIdentity, result },
        body: surface.lambda(
          "function",
          surface.apply(
            surface.apply(
              surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
              surface.apply(surface.name("function"), surface.integer(42)),
            ),
            surface.apply(surface.name("function"), surface.boolean(true)),
          ),
        ),
      },
      {
        name: "main",
        parameters: [],
        annotation: null,
        body: {
          kind: "case",
          value: surface.apply(surface.name("applyTwice"), surface.name("identity")),
          arms: [{
            constructor: FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
            binders: ["answer", "condition"],
            body: {
              kind: "if",
              condition: surface.name("condition"),
              consequent: surface.name("answer"),
              alternate: surface.integer(0),
            },
          }],
        },
      },
    ],
    [],
    "main",
    0,
  );
}
