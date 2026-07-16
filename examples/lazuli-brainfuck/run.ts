import {
  GpuBrainfuckCompiler,
  GpuLazuliCompiler,
  GpuLazuliEvaluator,
  type GpuLazuliModule,
  type LazuliEvaluationStats,
  requestWebGpuDevice,
} from "../../mod.ts";

const COMPILER_PATH = "examples/lazuli-brainfuck/compiler.laz";

export interface LazuliBrainfuckRuntime {
  readonly module: GpuLazuliModule;
  readonly evaluator: GpuLazuliEvaluator;
  readonly compilerInitializationMilliseconds: number;
  readonly compilerFirstDispatchWarmupMilliseconds: number;
  readonly compilerCompilationMilliseconds: number;
  readonly evaluatorInitializationMilliseconds: number;
}

export interface LazuliBrainfuckCompilation {
  readonly wasmHex: string;
  readonly wasmBytes: Uint8Array<ArrayBuffer>;
  readonly evaluationMilliseconds: number;
  readonly evaluationStats: LazuliEvaluationStats;
}

export interface BrainfuckExecution {
  readonly finalCell: number;
  readonly output: readonly number[];
}

export async function createLazuliBrainfuckRuntime(
  device: GPUDevice,
): Promise<LazuliBrainfuckRuntime> {
  const source = await Deno.readTextFile(COMPILER_PATH);
  const compilerInitializationStart = performance.now();
  const compiler = await GpuLazuliCompiler.create(device);
  const compilerInitializationMilliseconds = performance.now() - compilerInitializationStart;
  const compilerWarmupStart = performance.now();
  const warmup = await compiler.compile("fn main = 0;", {
    maximumStepsPerDispatch: 65_536,
  });
  const compilerFirstDispatchWarmupMilliseconds = performance.now() - compilerWarmupStart;
  if (!warmup.ok) {
    throw new Error(`Lazuli compiler warmup failed: ${warmup.diagnostics[0].message}`);
  }
  warmup.module.destroy();
  const compilationStart = performance.now();
  const compilation = await compiler.compile(source, { maximumSteps: 10_000_000 });
  const compilerCompilationMilliseconds = performance.now() - compilationStart;
  if (!compilation.ok) {
    const diagnostic = compilation.diagnostics[0];
    throw new Error(
      `Lazuli Brainfuck compiler failed to compile at bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ${diagnostic.message}`,
    );
  }
  const evaluatorInitializationStart = performance.now();
  let evaluator: GpuLazuliEvaluator;
  try {
    evaluator = await GpuLazuliEvaluator.create(device);
  } catch (cause) {
    compilation.module.destroy();
    throw cause;
  }
  return {
    module: compilation.module,
    evaluator,
    compilerInitializationMilliseconds,
    compilerFirstDispatchWarmupMilliseconds,
    compilerCompilationMilliseconds,
    evaluatorInitializationMilliseconds: performance.now() - evaluatorInitializationStart,
  };
}

export async function compileBrainfuckSource(
  runtime: LazuliBrainfuckRuntime,
  source: string,
): Promise<LazuliBrainfuckCompilation> {
  const evaluationStart = performance.now();
  const evaluation = await runtime.evaluator.evaluate(runtime.module, {
    input: { kind: "text", value: source },
    resultForm: "deep",
    maximumSteps: 1_000_000,
    maximumStepsPerDispatch: 65_536,
    heapSlots: 100_000,
    stackFrames: 100_000,
    maximumResultNodes: 1_000_000,
  });
  const evaluationMilliseconds = performance.now() - evaluationStart;
  if (!evaluation.ok) {
    throw new Error(
      `Lazuli Brainfuck compilation faulted with ${evaluation.fault.code}: ${evaluation.fault.message}`,
    );
  }
  if (evaluation.value.kind !== "text") {
    throw new Error(
      `Lazuli Brainfuck compiler returned ${evaluation.value.kind}; expected text`,
    );
  }
  if (evaluation.value.value.startsWith("error:")) {
    throw new Error(`Lazuli Brainfuck compiler rejected the source: ${evaluation.value.value}`);
  }
  const wasmBytes = decodeWasmHex(evaluation.value.value);
  if (!WebAssembly.validate(wasmBytes)) {
    throw new Error(
      `Lazuli Brainfuck compiler emitted ${wasmBytes.byteLength} invalid WebAssembly bytes`,
    );
  }
  return {
    wasmHex: evaluation.value.value,
    wasmBytes,
    evaluationMilliseconds,
    evaluationStats: evaluation.stats,
  };
}

export async function runBrainfuckWasm(
  wasmBytes: Uint8Array<ArrayBuffer>,
  input: readonly number[] = [],
): Promise<BrainfuckExecution> {
  const output: number[] = [];
  let inputOffset = 0;
  const instance = await WebAssembly.instantiate(wasmBytes, {
    env: {
      input: () => input[inputOffset++] ?? 0,
      output: (value: number) => {
        output.push(value & 0xff);
      },
    },
  });
  const run = instance.instance.exports.run;
  if (typeof run !== "function") {
    throw new Error('Lazuli Brainfuck WebAssembly does not export a "run" function');
  }
  const finalCell = run();
  if (typeof finalCell !== "number") {
    throw new Error(`Lazuli Brainfuck WebAssembly returned ${typeof finalCell}; expected number`);
  }
  return { finalCell, output };
}

export function decodeWasmHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) {
    throw new Error(`WebAssembly hex has odd length ${hex.length}`);
  }
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex++) {
    const offset = byteIndex * 2;
    const encodedByte = hex.slice(offset, offset + 2);
    if (!/^[0-9a-f]{2}$/.test(encodedByte)) {
      throw new Error(
        `WebAssembly hex has invalid byte ${JSON.stringify(encodedByte)} at character ${offset}`,
      );
    }
    bytes[byteIndex] = Number.parseInt(encodedByte, 16);
  }
  return bytes;
}

if (import.meta.main) {
  const source = Deno.args[0] ?? "+++[>++++<-]>.+.";
  const deviceInitializationStart = performance.now();
  const device = await requestWebGpuDevice();
  const deviceInitializationMilliseconds = performance.now() - deviceInitializationStart;
  let runtime: LazuliBrainfuckRuntime | undefined;
  try {
    runtime = await createLazuliBrainfuckRuntime(device);
    const evaluatorWarmupStart = performance.now();
    await compileBrainfuckSource(runtime, "");
    const evaluatorFirstDispatchWarmupMilliseconds = performance.now() - evaluatorWarmupStart;
    const compilation = await compileBrainfuckSource(runtime, source);
    const execution = await runBrainfuckWasm(compilation.wasmBytes);
    const warmCompilationMilliseconds: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const warmCompilation = await compileBrainfuckSource(runtime, source);
      warmCompilationMilliseconds.push(warmCompilation.evaluationMilliseconds);
    }
    const directCompilerInitializationStart = performance.now();
    const directCompiler = await GpuBrainfuckCompiler.create(device);
    const directCompilerInitializationMilliseconds = performance.now() -
      directCompilerInitializationStart;
    const directCompilationStart = performance.now();
    const directCompilation = await directCompiler.compile(source);
    const directIrCompilationMilliseconds = performance.now() - directCompilationStart;
    if (!directCompilation.ok) {
      throw new Error(
        `Dedicated GPU Brainfuck compiler rejected the source: ${directCompilation.diagnostic.message}`,
      );
    }
    directCompilation.ir.destroy();
    console.log(JSON.stringify(
      {
        source,
        deviceInitializationMilliseconds,
        compilerInitializationMilliseconds: runtime.compilerInitializationMilliseconds,
        compilerFirstDispatchWarmupMilliseconds: runtime.compilerFirstDispatchWarmupMilliseconds,
        compilerCompilationMilliseconds: runtime.compilerCompilationMilliseconds,
        evaluatorInitializationMilliseconds: runtime.evaluatorInitializationMilliseconds,
        evaluatorFirstDispatchWarmupMilliseconds,
        firstBrainfuckCompilationMilliseconds: compilation.evaluationMilliseconds,
        warmBrainfuckCompilationMilliseconds: warmCompilationMilliseconds,
        semanticSteps: compilation.evaluationStats.steps,
        wasmByteLength: compilation.wasmBytes.byteLength,
        finalCell: execution.finalCell,
        output: execution.output,
        dedicatedGpuIrComparison: {
          initializationMilliseconds: directCompilerInitializationMilliseconds,
          compilationMilliseconds: directIrCompilationMilliseconds,
          note:
            "This specialized baseline emits Brainfuck IR rather than a complete WebAssembly module.",
        },
      },
      null,
      2,
    ));
  } finally {
    runtime?.module.destroy();
    device.destroy();
  }
}
