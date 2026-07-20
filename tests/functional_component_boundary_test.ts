import { equal, match, rejects, throws } from "node:assert/strict";

import {
  compileFunctionalComponentBoundary,
  compileFunctionalModuleToWasm,
  FUNCTIONAL_RESOURCE_TYPE_PREFIX,
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

Deno.test("WIT generation rejects malformed boundary options with contract evidence", () => {
  const module = boundaryModule({});

  throws(
    () => functionalWitWorld(module, null as never),
    /component boundary options must be an object/,
  );
  throws(
    () => functionalWitWorld(module, { worldName: 42 as unknown as string }),
    /component world name must be a string; received 42/,
  );
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
    }, {
      name: "char",
      parameters: [],
      constructors: [{ name: "constructor", fields: [] }],
    }],
  });

  const wit = functionalWitWorld(module);

  match(wit, /enum gpufuck-unit \{ unit \}/);
  match(wit, /record %type \{/);
  match(wit, /%type: gpufuck-unit,/);
  match(wit, /enum %char \{\s+%constructor,/);
  match(wit, /export main: func\(\) -> %type;/);
});

Deno.test("WIT generation keeps type and capability names in their WIT scopes", () => {
  const module = boundaryModule({
    entryType: { kind: "named", name: "FileSystem", arguments: [] },
    typeDeclarations: [{
      name: "FileSystem",
      parameters: [],
      constructors: [{ name: "FileSystem", fields: [] }],
    }],
    hostCapabilities: [{ name: "FileSystem", fields: [] }],
  });

  const wit = functionalWitWorld(module);

  match(wit, /enum file-system \{/);
  match(wit, /interface file-system \{/);
  match(wit, /import file-system;/);
});

Deno.test("WIT generation rejects colliding record fields with both source names", () => {
  const module = boundaryModule({
    typeDeclarations: [{
      name: "Pair",
      parameters: [],
      constructors: [{
        name: "Pair",
        fields: [
          { name: "leftValue", type: { kind: "integer" } },
          { name: "left-value", type: { kind: "integer" } },
        ],
      }],
    }],
  });

  throws(
    () => functionalWitWorld(module),
    /Pair field "leftValue" and Pair field "left-value" both map to WIT identifier "left-value"/,
  );
});

Deno.test("WIT generation rejects an export that collides with the entry export", () => {
  const module = boundaryModule({
    wasmExports: [{
      name: "main",
      definitionIndex: 0,
      type: { kind: "integer" },
    }],
  });

  throws(
    () => functionalWitWorld(module),
    /entry export "main" and export "main" both map to WIT identifier "main"/,
  );
});

Deno.test("WIT generation rejects an empty algebraic type instead of emitting an empty variant", () => {
  const module = boundaryModule({
    typeDeclarations: [{ name: "Never", parameters: [], constructors: [] }],
  });

  throws(
    () => functionalWitWorld(module),
    /type "Never" has no constructors; WIT variants require at least one case/,
  );
});

Deno.test("WIT generation reports malformed resource encodings", () => {
  const malformedResource: GpuFunctionalModule["entryType"] = {
    kind: "named",
    name: `${FUNCTIONAL_RESOURCE_TYPE_PREFIX}%`,
    arguments: [],
  };

  throws(
    () => functionalWitWorld(boundaryModule({ entryType: malformedResource })),
    /resource type .* has invalid percent encoding/,
  );
});

Deno.test("WIT generation rejects cyclic type schemas without overflowing the host stack", () => {
  const values: GpuFunctionalModule["entryType"][] = [];
  const cyclicType = {
    kind: "tuple",
    values,
  } as unknown as GpuFunctionalModule["entryType"];
  values.push({ kind: "integer" }, cyclicType);

  throws(
    () => functionalWitWorld(boundaryModule({ entryType: cyclicType })),
    /type schema contains a structural cycle/,
  );
});

Deno.test("WIT generation rejects type schemas beyond its structural depth limit", () => {
  let deeplyNestedType: GpuFunctionalModule["entryType"] = { kind: "integer" };
  for (let depth = 0; depth < 514; depth += 1) {
    deeplyNestedType = {
      kind: "tuple",
      values: [deeplyNestedType, { kind: "integer" }],
    };
  }

  throws(
    () => functionalWitWorld(boundaryModule({ entryType: deeplyNestedType })),
    /type exceeds structural depth 512/,
  );
});

Deno.test("component compilation validates WIT before reading GPU core nodes", async () => {
  let coreNodeReads = 0;
  const module = boundaryModule({
    typeDeclarations: [{
      name: "Box",
      parameters: ["value"],
      constructors: [{ name: "Box", fields: [] }],
    }],
    readCoreNodes: () => {
      coreNodeReads += 1;
      return Promise.resolve([]);
    },
  });

  await rejects(
    () => compileFunctionalComponentBoundary(module),
    /WIT boundaries require concrete monomorphized types/,
  );
  equal(coreNodeReads, 0);
});

Deno.test("WASM compilation rejects malformed options before reading GPU core nodes", async () => {
  let coreNodeReads = 0;
  const module = boundaryModule({
    readCoreNodes: () => {
      coreNodeReads += 1;
      return Promise.resolve([]);
    },
  });

  await rejects(
    () => compileFunctionalModuleToWasm(module, null as never),
    /WASM compilation options must be an object/,
  );
  equal(coreNodeReads, 0);
});

function boundaryModule(overrides: {
  readonly entryType?: GpuFunctionalModule["entryType"];
  readonly hostCapabilities?: readonly FunctionalHostCapabilityDeclaration[];
  readonly readCoreNodes?: GpuFunctionalModule["readCoreNodes"];
  readonly typeDeclarations?: GpuFunctionalModule["typeDeclarations"];
  readonly wasmExports?: GpuFunctionalModule["wasmExports"];
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
    wasmExports: overrides.wasmExports ?? [],
    sources: [],
    evaluationProfile: "strict-eager-v1",
    readCoreNodes: overrides.readCoreNodes ?? (() => Promise.resolve([])),
    destroy: () => {},
  };
}
