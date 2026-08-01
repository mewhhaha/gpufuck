import { deepStrictEqual } from "node:assert/strict";

import {
  GpuCompiler,
  GpuWasmEncoder,
  prepareLinearWasmModuleEncoding,
  requestWebGpuDevice,
} from "../functional.ts";
import { encodeWasmModule } from "../src/functional/wasm_binary.ts";
import { compileSweepSource, GpuSweepCompiler } from "../sweep.ts";

const source = Deno.readTextFileSync("examples/sweep/editor.sweep");
const lowered = compileSweepSource("editor", source);
if (!lowered.ok) throw new Error(lowered.diagnostics[0]?.message ?? "Sweep lowering failed");

const device = await requestWebGpuDevice();
try {
  const inferenceCompiler = await GpuCompiler.create(device);
  const checkingCompiler = await GpuSweepCompiler.create(device);
  const wasmEncoder = await GpuWasmEncoder.create(device);
  const inferenceMilliseconds: number[] = [];
  let inferenceFailure: string | undefined;
  for (let iteration = 0; iteration < 8; iteration++) {
    const started = performance.now();
    const compilation = await inferenceCompiler.compileModule(lowered.module, {
      maximumSteps: 10_000_000,
    });
    if (!compilation.ok) {
      inferenceFailure = `${compilation.diagnostics[0].code}: ${
        compilation.diagnostics[0].message
      }`;
      break;
    }
    if (iteration !== 0) inferenceMilliseconds.push(performance.now() - started);
    compilation.module.destroy();
  }

  const checkingMilliseconds: number[] = [];
  const checkingKernelMilliseconds: number[] = [];
  let constraintCount = 0;
  let checkedModule: Awaited<ReturnType<GpuSweepCompiler["compileSource"]>> | undefined;
  for (let iteration = 0; iteration < 8; iteration++) {
    const started = performance.now();
    const compilation = await checkingCompiler.compileSource("editor", source);
    if (!compilation.ok) throw new Error(compilation.diagnostics[0].message);
    if (iteration !== 0) {
      checkingMilliseconds.push(performance.now() - started);
      checkingKernelMilliseconds.push(compilation.checkingMilliseconds);
    }
    constraintCount = compilation.constraintCount;
    if (iteration === 7) {
      checkedModule = compilation;
    } else {
      compilation.module.destroy();
    }
  }
  if (checkedModule === undefined || !checkedModule.ok) {
    throw new Error("checking-only benchmark omitted its final compiled module");
  }

  try {
    const preparationStarted = performance.now();
    const encoding = prepareLinearWasmModuleEncoding(
      checkedModule.module,
      await checkedModule.module.readCoreNodes(),
    );
    const preparationMilliseconds = performance.now() - preparationStarted;
    const cpuEncodingMilliseconds: number[] = [];
    const gpuEncodingMilliseconds: number[] = [];
    let wasmBytes = 0;
    let functionBodyBytes = 0;
    for (let iteration = 0; iteration < 8; iteration++) {
      const cpuStarted = performance.now();
      const cpu = encodeWasmModule(encoding).bytes;
      const cpuMilliseconds = performance.now() - cpuStarted;
      const gpu = await wasmEncoder.encode(encoding);
      deepStrictEqual(gpu.bytes, cpu);
      if (iteration !== 0) {
        cpuEncodingMilliseconds.push(cpuMilliseconds);
        gpuEncodingMilliseconds.push(gpu.milliseconds);
      }
      wasmBytes = gpu.bytes.byteLength;
      functionBodyBytes = gpu.functionBodyBytes;
    }

    console.log(JSON.stringify(
      {
        sourceBytes: new TextEncoder().encode(source).byteLength,
        surfaceNodes: lowered.module.nodeCount,
        definitions: lowered.module.definitionCount,
        checkingConstraints: constraintCount,
        inferenceCompileMilliseconds: inferenceMilliseconds.length === 0
          ? null
          : median(inferenceMilliseconds),
        inferenceFailure,
        checkingCompileMilliseconds: median(checkingMilliseconds),
        checkingKernelMilliseconds: median(checkingKernelMilliseconds),
        wasmPreparationMilliseconds: rounded(preparationMilliseconds),
        cpuLinearEncodingMilliseconds: median(cpuEncodingMilliseconds),
        gpuLinearEncodingMilliseconds: median(gpuEncodingMilliseconds),
        functionBodyBytes,
        wasmBytes,
      },
      null,
      2,
    ));
  } finally {
    checkedModule.module.destroy();
  }
} finally {
  device.destroy();
}

function median(samples: number[]): number {
  samples.sort((left, right) => left - right);
  return rounded(samples[Math.floor(samples.length / 2)]!);
}

function rounded(value: number): number {
  return Number(value.toFixed(3));
}
