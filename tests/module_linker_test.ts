import { deepStrictEqual, equal } from "node:assert/strict";

import { linkModules, surface } from "../functional.ts";

Deno.test("linker follows reachable imports and prunes unused definitions", () => {
  const linked = linkModules([
    {
      name: "library",
      definitions: [
        {
          name: "used",
          parameters: [],
          annotation: { kind: "integer" },
          body: surface.integer(42),
        },
        {
          name: "unused",
          parameters: [],
          annotation: { kind: "integer" },
          body: surface.integer(0),
        },
      ],
      typeDeclarations: [],
      imports: [],
      exports: [{ name: "used", definition: "used", type: { kind: "integer" } }],
      sourceByteLength: 0,
      options: {},
    },
    {
      name: "application",
      definitions: [{
        name: "main",
        parameters: [],
        annotation: { kind: "integer" },
        body: surface.name("answer"),
      }],
      typeDeclarations: [],
      imports: [{
        name: "answer",
        fromModule: "library",
        exportName: "used",
        type: { kind: "integer" },
      }],
      exports: [{ name: "main", definition: "main", type: { kind: "integer" } }],
      sourceByteLength: 0,
      options: {},
    },
  ], { module: "application", exportName: "main" });

  equal(linked.module.definitionCount, 3);
  deepStrictEqual(
    linked.module.symbolNames.filter((name) =>
      name === "library::used" ||
      name === "application::$import$answer" ||
      name === "application::main"
    ),
    [
      "library::used",
      "application::$import$answer",
      "application::main",
    ],
  );
  equal(linked.module.symbolNames.includes("library::unused"), false);
});
