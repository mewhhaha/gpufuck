import { match, throws } from "node:assert/strict";

import {
  type FunctionalHostCapabilityDeclaration,
  FunctionalHostTypes,
  functionalWitWorld,
  type GpuFunctionalModule,
} from "../functional.ts";

Deno.test("WIT generation describes scalar exports and capability imports", () => {
  const module = boundaryModule({
    entryType: {
      kind: "function",
      parameter: { kind: "integer" },
      result: { kind: "boolean" },
    },
    hostCapabilities: [{
      name: "FileSystem",
      fields: [{
        kind: "operation",
        name: "readFile",
        purity: "effectful",
        execution: "suspending",
        parameter: FunctionalHostTypes.text,
        result: FunctionalHostTypes.bytes,
      }],
    }],
  });

  const wit = functionalWitWorld(module, {
    packageName: "example:compiler",
    worldName: "compiled-program",
  });

  match(wit, /package example:compiler;/);
  match(wit, /interface file-system \{/);
  match(wit, /read-file: async func\(value: string\) -> list<u8>;/);
  match(wit, /import file-system;/);
  match(wit, /export main: func\(argument-0: s32\) -> bool;/);
});

Deno.test("WIT generation rejects generic boundary declarations with evidence", () => {
  const module = boundaryModule({
    typeDeclarations: [{
      name: "Box",
      parameters: ["value"],
      constructors: [{
        name: "Box",
        fields: [{ name: "value", type: { kind: "parameter", name: "value" } }],
      }],
    }],
  });

  throws(
    () => functionalWitWorld(module),
    /type "Box" has 1 generic parameters; WIT boundaries require concrete monomorphized types/,
  );
});

Deno.test("WIT generation represents nested unit and escapes keyword identifiers", () => {
  const module = boundaryModule({
    entryType: { kind: "named", name: "type", arguments: [] },
    typeDeclarations: [{
      name: "type",
      parameters: [],
      constructors: [{
        name: "record",
        fields: [{ name: "type", type: { kind: "unit" } }],
      }],
    }],
  });

  const wit = functionalWitWorld(module);

  match(wit, /enum gpufuck-unit \{ unit \}/);
  match(wit, /record %type \{/);
  match(wit, /%type: gpufuck-unit,/);
  match(wit, /export main: func\(\) -> %type;/);
});

function boundaryModule(overrides: {
  readonly entryType?: GpuFunctionalModule["entryType"];
  readonly hostCapabilities?: readonly FunctionalHostCapabilityDeclaration[];
  readonly typeDeclarations?: GpuFunctionalModule["typeDeclarations"];
}): GpuFunctionalModule {
  return {
    nodeBuffer: undefined as unknown as GPUBuffer,
    definitionBuffer: undefined as unknown as GPUBuffer,
    constructorBuffer: undefined as unknown as GPUBuffer,
    nodeCount: 0,
    definitionCount: 1,
    constructorCount: 0,
    typeCount: 0,
    constructorNames: [],
    constructorArities: [],
    definitionNames: ["main"],
    typeNames: [],
    symbolNames: [],
    definitionRoots: [0],
    entryDefinition: 0,
    entryType: overrides.entryType ?? { kind: "integer" },
    entryEffects: [],
    typeDeclarations: overrides.typeDeclarations ?? [],
    hostCapabilities: overrides.hostCapabilities ?? [],
    hostDefinitions: [],
    wasmExports: [],
    sources: [],
    evaluationProfile: "strict-eager-v1",
    readCoreNodes: () => Promise.resolve([]),
    destroy: () => {},
  };
}
