import {
  compileModulesToWasm,
  CpuCompiler,
  ParallelFunctionalCompilerService,
} from "../functional.ts";
import {
  type GleamSourceModule,
  lowerGleamSources,
  ParallelGleamFrontend,
  ParallelGleamProjectFrontend,
} from "../gleam.ts";
import { compileWasmArtifact } from "../src/functional/wasm_codegen.ts";

const SIZES = [16, 64, 256, 1024] as const;

function program(value: number): string {
  return `
pub type Option(a) {
  None
  Some(a)
}

fn map(option, transform) {
  case option {
    None -> None
    Some(value) -> Some(transform(value))
  }
}

pub fn main() -> Int {
  case map(Some(${value}), fn(number) { number * 2 }) {
    None -> 0
    Some(number) -> number
  }
}
`;
}

function project(size: number): readonly GleamSourceModule[] {
  return Array.from({ length: size }, (_, index) => {
    const name = `linked_${size}/module_${index}`;
    if (index === 0) {
      return {
        name,
        source: "pub fn value() -> Int { 1 }\n",
      };
    }
    return {
      name,
      source: `
import linked_${size}/module_${index - 1} as previous

pub fn value() -> Int {
  previous.value() + 1
}
`,
    };
  });
}

const workerCount = Deno.args[0] === undefined ? undefined : Number(Deno.args[0]);
const frontend = ParallelGleamFrontend.create(workerCount);
const projectFrontend = ParallelGleamProjectFrontend.create(workerCount);
const parallelCompiler = ParallelFunctionalCompilerService.create(workerCount);
const serialCompiler = new CpuCompiler();

try {
  console.log(`workers: ${workerCount ?? Math.max(1, (navigator.hardwareConcurrency ?? 4) - 1)}`);
  await frontend.lower(
    Array.from({ length: 24 }, (_, index) => ({
      name: `warm_${index}`,
      source: program(index),
    })),
  );
  const warm = await frontend.lower(
    Array.from({ length: 24 }, (_, index) => ({
      name: `compiler_warm_${index}`,
      source: program(10_000 + index),
    })),
  );
  const warmModules = warm.map((result) => {
    if (!result.ok) throw new Error(result.diagnostic);
    return result.module;
  });
  for (const result of await parallelCompiler.compileBatch(warmModules)) {
    if (result.ok) result.module.destroy();
  }

  console.log(
    "modules  frontendMs  serialCoreMs  parallelCoreMs  coreSpeedup  serialWasmMs  parallelWasmMs  wasmSpeedup  directPipelineMs  pipelineSpeedup  sharedWasmMs",
  );
  for (const size of SIZES) {
    const units = Array.from({ length: size }, (_, index) => ({
      name: `parallel_${size}_${index}`,
      source: program(size * 10_000 + index),
    }));
    let started = performance.now();
    const lowered = await frontend.lower(units);
    const frontendMilliseconds = performance.now() - started;
    const modules = lowered.map((result) => {
      if (!result.ok) throw new Error(result.diagnostic);
      return result.module;
    });

    started = performance.now();
    const serialResults = await serialCompiler.compileBatch(modules);
    const serialCoreMilliseconds = performance.now() - started;
    const serialModules = serialResults.map((result) => {
      if (!result.ok) throw new Error(result.diagnostics[0].message);
      return result.module;
    });

    started = performance.now();
    const parallelResults = await parallelCompiler.compileBatch(modules);
    const parallelCoreMilliseconds = performance.now() - started;
    const parallelModules = parallelResults.map((result) => {
      if (!result.ok) throw new Error(result.diagnostics[0].message);
      return result.module;
    });

    started = performance.now();
    for (const module of serialModules) {
      compileWasmArtifact(module, await module.readCoreNodes());
    }
    const serialWasmMilliseconds = performance.now() - started;

    started = performance.now();
    await parallelCompiler.emitWasmBatch(parallelModules);
    const parallelWasmMilliseconds = performance.now() - started;

    const directLowered = await frontend.lower(
      Array.from({ length: size }, (_, index) => ({
        name: `direct_${size}_${index}`,
        source: program(size * 20_000 + index),
      })),
    );
    const directModules = directLowered.map((result) => {
      if (!result.ok) throw new Error(result.diagnostic);
      return result.module;
    });
    started = performance.now();
    await parallelCompiler.compileBatchToWasm(directModules);
    const directPipelineMilliseconds = performance.now() - started;

    started = performance.now();
    await compileModulesToWasm(parallelModules);
    const sharedWasmMilliseconds = performance.now() - started;

    console.log(
      `${String(size).padStart(7)}  ${frontendMilliseconds.toFixed(1).padStart(10)}  ${
        serialCoreMilliseconds.toFixed(1).padStart(12)
      }  ${parallelCoreMilliseconds.toFixed(1).padStart(14)}  ${
        (serialCoreMilliseconds / parallelCoreMilliseconds).toFixed(2).padStart(11)
      }  ${serialWasmMilliseconds.toFixed(1).padStart(12)}  ${
        parallelWasmMilliseconds.toFixed(1).padStart(14)
      }  ${(serialWasmMilliseconds / parallelWasmMilliseconds).toFixed(2).padStart(11)}  ${
        directPipelineMilliseconds.toFixed(1).padStart(16)
      }  ${
        ((serialCoreMilliseconds + serialWasmMilliseconds) / directPipelineMilliseconds).toFixed(2)
          .padStart(15)
      }  ${sharedWasmMilliseconds.toFixed(1).padStart(12)}`,
    );

    for (const module of serialModules) module.destroy();
    for (const module of parallelModules) module.destroy();
  }

  console.log("\nmodules  serialProjectMs  parallelProjectMs  projectSpeedup");
  for (const size of SIZES) {
    const sources = project(size);
    const entry = { module: `linked_${size}/module_${size - 1}`, exportName: "value" };
    let started = performance.now();
    const serial = lowerGleamSources(sources, entry);
    const serialMilliseconds = performance.now() - started;
    if (!serial.ok) throw new Error(serial.diagnostics[0].message);

    started = performance.now();
    const parallel = await projectFrontend.lower(sources, entry);
    const parallelMilliseconds = performance.now() - started;
    if (!parallel.ok) throw new Error(parallel.diagnostics[0].message);
    console.log(
      `${String(size).padStart(7)}  ${serialMilliseconds.toFixed(1).padStart(15)}  ${
        parallelMilliseconds.toFixed(1).padStart(17)
      }  ${(serialMilliseconds / parallelMilliseconds).toFixed(2).padStart(14)}`,
    );
  }
} finally {
  frontend.terminate();
  projectFrontend.terminate();
  parallelCompiler.terminate();
}
