import {
  buildFunctionalSurfaceModule,
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
  FunctionalEvaluationProfile,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  runFunctionalWasmGcModule,
  runFunctionalWasmModule,
  surface,
} from "../functional.ts";
import { compileFunctionalWasmArtifact } from "../src/functional/wasm_codegen.ts";
import { compileFunctionalWasmGc } from "../src/functional/wasm_gc_codegen.ts";

const module = buildFunctionalSurfaceModule(
  [{
    name: "main",
    parameters: [],
    annotation: null,
    body: surface.apply(
      surface.name(FUNCTIONAL_PAIR_CONSTRUCTOR_NAME),
      surface.integer(40),
      surface.integer(2),
    ),
  }],
  [],
  "main",
  0,
  { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
);
const device = await requestWebGpuDevice();
const compiler = await GpuFunctionalCompiler.create(device);
const compilation = await compiler.compileModule(module);
if (!compilation.ok) {
  device.destroy();
  throw new Error(
    `WasmGC benchmark did not compile: ${compilation.diagnostics[0].message}`,
  );
}
const nodes = await compilation.module.readCoreNodes();
const linearBytes = compileFunctionalWasmArtifact(compilation.module, nodes).bytes;
const gcBytes = compileFunctionalWasmGc(compilation.module, nodes);
const linearModule = new WebAssembly.Module(linearBytes);
const gcModule = new WebAssembly.Module(gcBytes);
const linearInstance = new WebAssembly.Instance(linearModule);
const gcInstance = new WebAssembly.Instance(gcModule);
const linearMain = linearInstance.exports.main;
const gcMain = gcInstance.exports.main;
const gcValuePayload = gcInstance.exports.valuePayload;
const pairConstructor = compilation.module.constructorNames.indexOf(
  FUNCTIONAL_PAIR_CONSTRUCTOR_NAME,
);
if (typeof linearMain !== "function") throw new Error("linear-memory benchmark omitted main");
if (
  typeof gcMain !== "function" ||
  typeof gcValuePayload !== "function" ||
  gcValuePayload(gcMain()) !== pairConstructor
) {
  throw new Error("WasmGC benchmark artifact returned the wrong result");
}
const linearExecution = await runFunctionalWasmModule(compilation.module);
const gcExecution = await runFunctionalWasmGcModule(compilation.module);
if (
  linearExecution.value.kind !== "tuple" ||
  gcExecution.value.kind !== "tuple" ||
  linearExecution.value.values[0].kind !== "integer" ||
  gcExecution.value.values[0].kind !== "integer" ||
  linearExecution.value.values[0].value !== 40 ||
  gcExecution.value.values[0].value !== 40
) {
  throw new Error("Wasm benchmark runners returned the wrong structured result");
}

globalThis.addEventListener("unload", () => {
  compilation.module.destroy();
  device.destroy();
}, { once: true });

Deno.bench(`emit linear-memory Wasm (${linearBytes.byteLength} bytes)`, () => {
  compileFunctionalWasmArtifact(compilation.module, nodes);
});

Deno.bench(`emit WasmGC (${gcBytes.byteLength} bytes)`, () => {
  compileFunctionalWasmGc(compilation.module, nodes);
});

Deno.bench("instantiate linear-memory algebraic Wasm", () => {
  new WebAssembly.Instance(linearModule);
});

Deno.bench("instantiate WasmGC algebraic Wasm", () => {
  new WebAssembly.Instance(gcModule);
});

Deno.bench("run linear-memory algebraic Wasm", () => {
  linearMain();
});

Deno.bench("run WasmGC algebraic Wasm", () => {
  gcMain();
});
