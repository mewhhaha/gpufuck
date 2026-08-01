import { deepStrictEqual, equal, ok } from "node:assert/strict";

import {
  BinaryOperator,
  buildSurfaceModule,
  CpuCompiler,
  GpuWasmEncoder,
  prepareLinearWasmModuleEncoding,
  requestWebGpuDevice,
  surface,
} from "../functional.ts";
import {
  encodeWasmModule,
  type WasmFunctionBody,
  WasmFunctionTypeIndex,
  type WasmModuleEncoding,
  WasmValueType,
} from "../src/functional/wasm_binary.ts";

let device: GPUDevice | undefined;
let encoder: GpuWasmEncoder | undefined;

Deno.test.beforeAll(async () => {
  device = await requestWebGpuDevice();
  encoder = await GpuWasmEncoder.create(device);
});

Deno.test.afterAll(() => {
  device?.destroy();
  device = undefined;
  encoder = undefined;
});

function gpuWasmEncoder(): GpuWasmEncoder {
  if (encoder === undefined) throw new Error("GPU WebAssembly encoder was not initialized");
  return encoder;
}

Deno.test("GPU function-body emission matches the linear project backend", async () => {
  const surfaceModule = buildSurfaceModule(
    [{
      name: "main",
      parameters: [],
      annotation: null,
      body: surface.apply(
        surface.lambda(
          "value",
          surface.binary(BinaryOperator.Add, surface.name("value"), surface.integer(1)),
        ),
        surface.integer(41),
      ),
    }],
    [],
    "main",
    0,
  );
  const compilation = await new CpuCompiler().compileModule(surfaceModule);
  ok(compilation.ok, compilation.ok ? undefined : compilation.diagnostics[0].message);
  if (!compilation.ok) return;
  try {
    const encoding = prepareLinearWasmModuleEncoding(
      compilation.module,
      await compilation.module.readCoreNodes(),
    );
    const reference = encodeWasmModule(encoding).bytes;
    const emitted = await gpuWasmEncoder().encode(encoding);
    deepStrictEqual(emitted.bytes, reference);
    ok(WebAssembly.validate(emitted.bytes));
  } finally {
    compilation.module.destroy();
  }
});

Deno.test("GPU function-body emission preserves order across scan blocks", async () => {
  const functions = Array.from({ length: 300 }, (_, index): WasmFunctionBody => ({
    typeIndex: WasmFunctionTypeIndex.NullaryI32,
    localTypes: index % 2 === 0 ? [WasmValueType.I32, WasmValueType.I32, WasmValueType.I64] : [],
    instructions: [0x41, index % 64],
    signedInteger64Literals: [],
    usesMemory: false,
    usesIndirectCalls: false,
  }));
  const encoding: WasmModuleEncoding = {
    imports: [],
    functions,
    indirectFunctionIndices: [],
    entryFunctionIndex: 0,
    heapStart: 65_536,
    additionalFunctionTypes: [],
  };
  const reference = encodeWasmModule(encoding).bytes;
  const emitted = await gpuWasmEncoder().encode(encoding);
  deepStrictEqual(emitted.bytes, reference);
  equal(emitted.functionCount, 300);
  ok(WebAssembly.validate(emitted.bytes));
  const { instance } = await WebAssembly.instantiate(emitted.bytes);
  equal((instance.exports.main as () => number)(), 0);
});
