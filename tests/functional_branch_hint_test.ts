import { deepStrictEqual, equal, ok } from "node:assert/strict";

import {
  BranchLikelihood,
  buildSurfaceModule,
  compileModuleToWasm,
  CoreTag,
  CpuCompiler,
  surface,
} from "../functional.ts";
import {
  encodeWasmModule,
  WasmFunctionTypeIndex,
  WasmInstructions,
  WasmValueType,
} from "../src/functional/wasm_binary.ts";
import { functionBody } from "../src/functional/wasm_runtime_binary.ts";

Deno.test("surface if annotations survive semantic lowering", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.if(
        surface.boolean(false),
        surface.integer(1),
        surface.integer(2),
        { likely: "alternate" },
      ),
    }],
    [],
    "main",
    0,
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const nodes = await compilation.module.readCoreNodes();
    const conditional = nodes.find((node) => node.tag === CoreTag.If);
    equal(conditional?.payload, BranchLikelihood.Alternate);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("explicit thunks mark their resolved cache path likely", async () => {
  const module = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: { kind: "integer" },
      body: surface.force(surface.delay(surface.integer(42))),
    }],
    [],
    "main",
    0,
  );
  const compilation = await new CpuCompiler().compileModule(module);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const bytes = await compileModuleToWasm(compilation.module);
    const wasm = new WebAssembly.Module(bytes);
    const sections = WebAssembly.Module.customSections(
      wasm,
      "metadata.code.branch_hint",
    );
    equal(sections.length, 1);
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("Wasm branch hints encode function-local instruction offsets", () => {
  const instructions = new WasmInstructions(0);
  instructions.addLocal(WasmValueType.I64);
  instructions.i32Const(1);
  instructions.hintedIf(WasmValueType.I32, true);
  instructions.i32Const(1);
  instructions.emit(0x05);
  instructions.i32Const(0);
  instructions.emit(0x0b);
  const body = functionBody(
    WasmFunctionTypeIndex.NullaryI32,
    instructions,
    "branch hint test",
  );
  const bytes = encodeWasmModule({
    imports: [],
    functions: [body],
    indirectFunctionIndices: [],
    entryFunctionIndex: 0,
    heapStart: 65_536,
    additionalFunctionTypes: [],
  }).bytes;

  ok(WebAssembly.validate(bytes));
  const module = new WebAssembly.Module(bytes);
  const [section] = WebAssembly.Module.customSections(
    module,
    "metadata.code.branch_hint",
  );
  ok(section !== undefined);
  deepStrictEqual([...new Uint8Array(section)], [1, 0, 1, 5, 1, 1]);
});
