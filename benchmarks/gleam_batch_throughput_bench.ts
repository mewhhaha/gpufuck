/**
 * Same-process compiler throughput on identical independent Gleam modules.
 *
 * Both compilers receive N modules in one resident process and emit executable output. This avoids
 * charging Gleam one process and package startup per module, which measured service orchestration
 * rather than compiler throughput.
 *
 * Usage: deno task bench:gleam-batch
 */
import {
  compileModulesToWasm,
  compileModuleToWasm,
  CpuCompiler,
  GpuCompiler,
  ParallelFunctionalCompilerService,
  requestWebGpuDevice,
} from "../functional.ts";
import { ParallelGleamCompiler, ParallelGleamFrontend } from "../gleam.ts";

const SIZES = [1, 32, 128, 512, 1024] as const;
const REPETITIONS = 5;

const program = (index: number, generation = 0) =>
  `pub type Option(a) {
  None
  Some(a)
}

fn map(option, transform) {
  case option {
    None -> None
    Some(value) -> Some(transform(value))
  }
}

fn twice(function, value) { function(function(value)) }

pub fn main() -> Int {
  let doubled = map(Some(${generation * 10_000 + index % 50 + 1}), fn(value) { value * 2 })
  let bumped = twice(fn(value) { value + ${index % 7 + 1} }, ${index % 11})
  case doubled {
    None -> bumped
    Some(value) -> value + bumped
  }
}
`;

function median(samples: readonly number[]): number {
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]!;
}

async function measureGleam(units: readonly { readonly source: string }[]): Promise<number> {
  const root = await Deno.makeTempDir({ dir: "/tmp", prefix: "gpufuck-gleam-throughput-" });
  try {
    await Deno.mkdir(`${root}/src`);
    await Deno.writeTextFile(
      `${root}/gleam.toml`,
      'name = "gpufuck_throughput"\nversion = "1.0.0"\ntarget = "javascript"\n\n[dependencies]\n',
    );
    for (const [index, unit] of units.entries()) {
      await Deno.writeTextFile(`${root}/src/module_${index}.gleam`, unit.source);
    }

    const samples: number[] = [];
    for (let repetition = 0; repetition < REPETITIONS; repetition++) {
      await runGleam(root, ["clean"]);
      samples.push(
        await runGleam(root, ["build", "--target", "javascript", "--no-print-progress"]),
      );
    }
    return median(samples);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function runGleam(cwd: string, args: readonly string[]): Promise<number> {
  const started = performance.now();
  const result = await new Deno.Command("gleam", {
    cwd,
    args: [...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `gleam ${args.join(" ")} failed in ${cwd}: ${new TextDecoder().decode(result.stderr)}`,
    );
  }
  return performance.now() - started;
}

const setupStarted = performance.now();
const device = await requestWebGpuDevice();
const gpuCompiler = await GpuCompiler.create(device);
const gpuSetupMilliseconds = performance.now() - setupStarted;
const cpuCompiler = new CpuCompiler();
const parallelCompiler = ParallelFunctionalCompilerService.create(8);
const fusedCompiler = ParallelGleamCompiler.create(8);
const pool = ParallelGleamFrontend.create();
const warm = await pool.lower(
  Array.from({ length: 32 }, (_, index) => ({
    name: `warm_${index}`,
    source: program(index, 99),
  })),
);
const warmModules = warm.map((result) => {
  if (!result.ok) throw new Error(`parallel frontend warmup failed: ${result.diagnostic}`);
  return result.module;
});
await parallelCompiler.compileBatchToWasm(warmModules);
await fusedCompiler.compile(
  Array.from({ length: 32 }, (_, index) => ({
    name: `fused_warm_${index}`,
    source: program(index, 100),
  })),
);

console.log(`resident GPU setup: ${gpuSetupMilliseconds.toFixed(1)} ms`);
console.log(
  "batch  gleamMs  cpuCoreMs  sharedWasmMs  sharedKiB  cpuTotalMs  parallelPipelineMs  parallelTotalMs  parallel/Gleam  fusedTotalMs  fused/Gleam  gpuCoreMs  separateWasmMs  separateKiB  gpuTotalMs  cpu/Gleam  gpu/Gleam",
);
try {
  for (const size of SIZES) {
    const units = Array.from({ length: size }, (_, index) => ({
      name: `module_${index}`,
      source: program(index, size),
    }));
    const lowerStarted = performance.now();
    const lowered = await pool.lower(units);
    const lowerMilliseconds = performance.now() - lowerStarted;
    const modules = lowered.map((result) => {
      if (!result.ok) throw new Error(`parallel frontend failed: ${result.diagnostic}`);
      return result.module;
    });

    const cpuSamples: number[] = [];
    let cpuModules: Awaited<ReturnType<CpuCompiler["compileBatch"]>> = [];
    for (let repetition = 0; repetition < REPETITIONS; repetition++) {
      const started = performance.now();
      const results = await cpuCompiler.compileBatch(modules);
      cpuSamples.push(performance.now() - started);
      for (const result of results) {
        if (!result.ok) throw new Error(result.diagnostics[0].message);
      }
      if (repetition === REPETITIONS - 1) {
        cpuModules = results;
      } else {
        for (const result of results) if (result.ok) result.module.destroy();
      }
    }
    const successfulCpuModules = cpuModules.map((result) => {
      if (!result.ok) throw new Error(result.diagnostics[0].message);
      return result.module;
    });
    const sharedWasmStarted = performance.now();
    const sharedArtifact = await compileModulesToWasm(successfulCpuModules);
    const sharedWasmMilliseconds = performance.now() - sharedWasmStarted;

    const parallelStarted = performance.now();
    const parallelArtifacts = await parallelCompiler.compileBatchToWasm(modules);
    const parallelPipelineMilliseconds = performance.now() - parallelStarted;
    for (const result of parallelArtifacts) {
      if (!result.ok) throw new Error(result.diagnostics[0].message);
    }

    const fusedStarted = performance.now();
    const fusedArtifacts = await fusedCompiler.compile(units);
    const fusedMilliseconds = performance.now() - fusedStarted;
    for (const result of fusedArtifacts) {
      if (!result.ok) throw new Error(result.diagnostics[0]?.message);
    }

    const gpuSamples: number[] = [];
    let gpuModules: Awaited<ReturnType<GpuCompiler["compileBatch"]>> = [];
    for (let repetition = 0; repetition < REPETITIONS; repetition++) {
      const started = performance.now();
      const results = await gpuCompiler.compileBatch(modules, { maximumSteps: 10_000_000 });
      gpuSamples.push(performance.now() - started);
      for (const result of results) {
        if (!result.ok) throw new Error(result.diagnostics[0].message);
      }
      if (repetition === REPETITIONS - 1) {
        gpuModules = results;
      } else {
        for (const result of results) if (result.ok) result.module.destroy();
      }
    }
    const separateWasmStarted = performance.now();
    let separateWasmByteLength = 0;
    for (const result of gpuModules) {
      if (!result.ok) throw new Error(result.diagnostics[0].message);
      separateWasmByteLength += (await compileModuleToWasm(result.module)).byteLength;
    }
    const separateWasmMilliseconds = performance.now() - separateWasmStarted;
    const gleamMilliseconds = await measureGleam(units);

    const cpuCoreMilliseconds = median(cpuSamples);
    const gpuCoreMilliseconds = median(gpuSamples);
    const cpuTotal = lowerMilliseconds + cpuCoreMilliseconds + sharedWasmMilliseconds;
    const parallelTotal = lowerMilliseconds + parallelPipelineMilliseconds;
    const gpuTotal = lowerMilliseconds + gpuCoreMilliseconds + separateWasmMilliseconds;
    console.log(
      `${String(size).padStart(5)} ${gleamMilliseconds.toFixed(1).padStart(8)} ${
        cpuCoreMilliseconds.toFixed(1).padStart(10)
      } ${sharedWasmMilliseconds.toFixed(1).padStart(13)} ${
        (sharedArtifact.bytes.byteLength / 1024).toFixed(1).padStart(10)
      } ${cpuTotal.toFixed(1).padStart(11)} ${
        parallelPipelineMilliseconds.toFixed(1).padStart(18)
      } ${parallelTotal.toFixed(1).padStart(15)} ${
        (parallelTotal / gleamMilliseconds).toFixed(2).padStart(14)
      } ${fusedMilliseconds.toFixed(1).padStart(13)} ${
        (fusedMilliseconds / gleamMilliseconds).toFixed(2).padStart(11)
      } ${gpuCoreMilliseconds.toFixed(1).padStart(10)} ${
        separateWasmMilliseconds.toFixed(1).padStart(14)
      } ${(separateWasmByteLength / 1024).toFixed(1).padStart(12)} ${
        gpuTotal.toFixed(1).padStart(10)
      } ${(cpuTotal / gleamMilliseconds).toFixed(2).padStart(10)} ${
        (gpuTotal / gleamMilliseconds).toFixed(2).padStart(10)
      }`,
    );

    for (const module of successfulCpuModules) module.destroy();
    for (const result of gpuModules) if (result.ok) result.module.destroy();
  }
} finally {
  pool.terminate();
  parallelCompiler.terminate();
  fusedCompiler.terminate();
  device.destroy();
}
