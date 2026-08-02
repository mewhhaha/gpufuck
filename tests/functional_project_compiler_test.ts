import { deepStrictEqual, equal, ok } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  CpuCompiler,
  effectSet,
  FunctionalProjectCompiler,
  inferModuleDefinitionSchemes,
  type ModuleArtifact,
  runWasmModule,
  surface,
} from "../functional.ts";

class RecordingCompiler {
  readonly batchSizes: number[] = [];
  readonly #compiler = new CpuCompiler();

  async compileBatch(modules: Parameters<CpuCompiler["compileBatch"]>[0]) {
    this.batchSizes.push(modules.length);
    return await this.#compiler.compileBatch(modules);
  }
}

Deno.test("module interface inference exposes every polymorphic definition", () => {
  const module = buildSurfaceModule(
    [
      {
        name: "identity",
        parameters: ["value"],
        annotation: null,
        body: surface.name("value"),
      },
      {
        name: "main",
        parameters: [],
        annotation: null,
        body: surface.integer(0),
      },
    ],
    [],
    "main",
    0,
  );
  const inferred = inferModuleDefinitionSchemes(module);
  ok(inferred.ok, inferred.ok ? undefined : inferred.diagnostics[0].message);
  if (!inferred.ok) return;
  deepStrictEqual(inferred.definitions[0]?.type, {
    kind: "forall",
    parameters: ["t0"],
    body: {
      kind: "function",
      parameter: { kind: "parameter", name: "t0" },
      result: { kind: "parameter", name: "t0" },
    },
  });
  deepStrictEqual(inferred.definitions[1]?.type, { kind: "integer" });
});

Deno.test("project compilation schedules dependency waves and reuses unchanged importers", async () => {
  const recording = new RecordingCompiler();
  const compiler = new FunctionalProjectCompiler(recording);

  const first = await compiler.compile(integerProject(1), {
    module: "entry",
    exportName: "main",
  });
  ok(first.ok, first.ok ? undefined : first.failures[0]?.diagnostics[0].message);
  if (!first.ok) return;
  try {
    deepStrictEqual(first.schedule.waves, [["leaf"], ["left", "right"], ["entry"]]);
    equal(first.schedule.maximumWidth, 2);
    deepStrictEqual(recording.batchSizes, [1, 2, 1]);
    deepStrictEqual((await runWasmModule(first.module)).value, {
      kind: "integer",
      value: 41,
    });
  } finally {
    first.module.destroy();
  }

  const edited = await compiler.compile(integerProject(2), {
    module: "entry",
    exportName: "main",
  });
  ok(edited.ok, edited.ok ? undefined : edited.failures[0]?.diagnostics[0].message);
  if (!edited.ok) return;
  try {
    deepStrictEqual(recording.batchSizes, [1, 2, 1, 1]);
    deepStrictEqual((await runWasmModule(edited.module)).value, {
      kind: "integer",
      value: 43,
    });
  } finally {
    edited.module.destroy();
  }
});

Deno.test("project Core linking preserves nominal constructors across modules", async () => {
  const option = {
    name: "Option",
    parameters: [],
    constructors: [
      { name: "None", fields: [] },
      { name: "Some", fields: [{ name: "value", type: { kind: "integer" as const } }] },
    ],
  };
  const library: ModuleArtifact = {
    name: "library",
    definitions: [{
      name: "answer",
      parameters: [],
      annotation: { kind: "named", name: "Option", arguments: [] },
      body: surface.apply(surface.name("Some"), surface.integer(42)),
    }],
    typeDeclarations: [option],
    imports: [],
    exports: [{ name: "answer", definition: "answer" }],
    typeExports: [{ name: "Option", declaration: "Option" }],
    constructorExports: [
      { name: "None", constructor: "None" },
      { name: "Some", constructor: "Some" },
    ],
    sourceByteLength: 0,
    options: {},
  };
  const entry: ModuleArtifact = {
    name: "entry",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.case(surface.name("answer"), [
        { constructor: "None", binders: [], body: surface.integer(0) },
        { constructor: "Some", binders: ["value"], body: surface.name("value") },
      ]),
    }],
    typeDeclarations: [],
    imports: [{ name: "answer", fromModule: "library", exportName: "answer" }],
    exports: [{ name: "main", definition: "main" }],
    typeImports: [{ name: "Option", fromModule: "library", exportName: "Option" }],
    constructorImports: [
      { name: "None", fromModule: "library", exportName: "None" },
      { name: "Some", fromModule: "library", exportName: "Some" },
    ],
    sourceByteLength: 0,
    options: {},
  };
  const result = await new FunctionalProjectCompiler().compile(
    [entry, library],
    { module: "entry", exportName: "main" },
  );
  ok(result.ok, result.ok ? undefined : result.failures[0]?.diagnostics[0].message);
  if (!result.ok) return;
  try {
    deepStrictEqual((await runWasmModule(result.module)).value, {
      kind: "integer",
      value: 42,
    });
  } finally {
    result.module.destroy();
  }
});

Deno.test("polymorphic export schemes instantiate in dependent modules", async () => {
  const library: ModuleArtifact = {
    name: "library",
    definitions: [{
      name: "identity",
      parameters: ["value"],
      annotation: null,
      body: surface.name("value"),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "identity", definition: "identity" }],
    sourceByteLength: 0,
    options: {},
  };
  const entry: ModuleArtifact = {
    name: "entry",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(surface.name("identity"), surface.integer(42)),
    }],
    typeDeclarations: [],
    imports: [{ name: "identity", fromModule: "library", exportName: "identity" }],
    exports: [{ name: "main", definition: "main" }],
    sourceByteLength: 0,
    options: {},
  };
  const result = await new FunctionalProjectCompiler().compile(
    [entry, library],
    { module: "entry", exportName: "main" },
  );
  ok(result.ok, result.ok ? undefined : result.failures[0]?.diagnostics[0].message);
  if (!result.ok) return;
  try {
    deepStrictEqual((await runWasmModule(result.module)).value, {
      kind: "integer",
      value: 42,
    });
  } finally {
    result.module.destroy();
  }
});

Deno.test("effect summaries cross separately compiled module boundaries", async () => {
  const tick = effectSet("Tick");
  const integer = { kind: "integer" as const };
  const library: ModuleArtifact = {
    name: "library",
    definitions: [{
      name: "tick",
      parameters: ["value"],
      annotation: { kind: "function", parameter: integer, result: integer },
      effects: tick,
      body: surface.name("value"),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "tick", definition: "tick", effects: tick }],
    sourceByteLength: 0,
    options: {},
  };
  const entry: ModuleArtifact = {
    name: "entry",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: integer,
      body: surface.apply(surface.name("tick"), surface.integer(42)),
    }],
    typeDeclarations: [],
    imports: [{
      name: "tick",
      fromModule: "library",
      exportName: "tick",
      effects: tick,
    }],
    exports: [{ name: "main", definition: "main", effects: tick }],
    sourceByteLength: 0,
    options: {},
  };
  const result = await new FunctionalProjectCompiler().compile(
    [entry, library],
    { module: "entry", exportName: "main" },
  );
  ok(result.ok, result.ok ? undefined : result.failures[0]?.diagnostics[0].message);
  if (!result.ok) return;
  try {
    deepStrictEqual([...result.module.entryEffects], ["Tick"]);
  } finally {
    result.module.destroy();
  }
});

function integerProject(value: number): readonly ModuleArtifact[] {
  const leaf: ModuleArtifact = {
    name: "leaf",
    definitions: [{
      name: "value",
      parameters: [],
      annotation: null,
      body: surface.integer(value),
    }],
    typeDeclarations: [],
    imports: [],
    exports: [{ name: "value", definition: "value" }],
    sourceByteLength: 0,
    options: {},
  };
  const branch = (name: string, increment: number): ModuleArtifact => ({
    name,
    definitions: [{
      name,
      parameters: [],
      annotation: null,
      body: surface.binary(
        BinaryOperator.Add,
        surface.name("value"),
        surface.integer(increment),
      ),
    }],
    typeDeclarations: [],
    imports: [{ name: "value", fromModule: "leaf", exportName: "value" }],
    exports: [{ name, definition: name }],
    sourceByteLength: 0,
    options: {},
  });
  const entry: ModuleArtifact = {
    name: "entry",
    definitions: [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.binary(
        BinaryOperator.Add,
        surface.name("left"),
        surface.name("right"),
      ),
    }],
    typeDeclarations: [],
    imports: [
      { name: "left", fromModule: "left", exportName: "left" },
      { name: "right", fromModule: "right", exportName: "right" },
    ],
    exports: [{ name: "main", definition: "main" }],
    sourceByteLength: 0,
    options: {},
  };
  return [entry, branch("right", 20), leaf, branch("left", 19)];
}
