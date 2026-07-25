/**
 * The throughput case, which is the one batching is for and the one a GPU can win.
 *
 * `gleam_stdlib_compile_bench.ts` measures latency: one large program, compiled once. That is the
 * case gpufuck loses badly (33x). This measures the opposite: N independent programs compiled
 * together, which is what a playground, a package registry, a CI corpus, or a test262-style sweep
 * actually asks for. `gleam build` has no cross-package batching, so its per-package cost is a
 * floor no matter how small the package is.
 *
 * The reference is 11 ms: `gleam build --target javascript` on a minimal package containing the
 * identical program, measured cold five times on the same machine. That number includes Gleam's
 * process start and project load, which is a real property of the tool rather than an artifact --
 * there is no batch mode to compare against.
 *
 * Wasm emission is included because Gleam writes JavaScript to disk; leaving it out would flatter
 * this side. The one-time WebGPU setup (~250 ms) is excluded, since at batch 1024 it amortizes to
 * well under a microsecond per module.
 *
 * Usage: deno task bench:gleam-batch
 */
import { compileModuleToWasm, GpuCompiler, requestWebGpuDevice } from "../functional.ts";
import { lowerGleamSource, ParallelGleamFrontend } from "../gleam.ts";

const program = (i: number) =>
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

fn twice(f, x) { f(f(x)) }

pub fn main() -> Int {
  let doubled = map(Some(${i % 50 + 1}), fn(value) { value * 2 })
  let bumped = twice(fn(v) { v + ${i % 7 + 1} }, ${i % 11})
  case doubled {
    None -> bumped
    Some(value) -> value + bumped
  }
}
`;

const device = await requestWebGpuDevice();
const compiler = await GpuCompiler.create(device);
// Created once and reused, as a real caller would, and warmed so worker startup is not charged to
// any single batch.
const pool = ParallelGleamFrontend.create();
await pool.lower(Array.from({ length: 32 }, (_, i) => ({ name: "p", source: program(i) })));
// Gleam emits JavaScript to disk, so emit Wasm here or the comparison flatters us.
console.log("batch  serialLower  parLower  gpuMs  wasmMs  usPerModule  vsGleam(11ms)");
for (const size of [1, 8, 32, 128, 512, 1024]) {
  const units = Array.from({ length: size }, (_, i) => ({ name: "p", source: program(i) }));
  let ls = performance.now();
  for (const unit of units) {
    const f = lowerGleamSource(unit.name, unit.source);
    if (!f.ok) {
      console.log(`lower failed: ${f.diagnostics[0].message.slice(0, 80)}`);
      Deno.exit(1);
    }
  }
  const serialLowerMs = performance.now() - ls;
  ls = performance.now();
  const lowered = await pool.lower(units);
  const lowerMs = performance.now() - ls;
  const mods = lowered.map((result) => {
    if (!result.ok) {
      console.log(`lower failed: ${result.diagnostic.slice(0, 80)}`);
      Deno.exit(1);
    }
    return result.module;
  });
  const times: number[] = [];
  let wasmMs = 0;
  for (let r = 0; r < 3; r++) {
    const s = performance.now();
    const results = await compiler.compileBatch(mods, { maximumSteps: 10_000_000 });
    const g = performance.now() - s;
    const w = performance.now();
    for (const x of results) {
      if (!x.ok) {
        console.log(
          `compile failed ${x.diagnostics[0].code} ${x.diagnostics[0].message.slice(0, 60)}`,
        );
        Deno.exit(1);
      }
      await compileModuleToWasm(x.module);
    }
    if (r === 2) wasmMs = performance.now() - w;
    times.push(g);
    for (const x of results) if (x.ok) x.module.destroy();
  }
  times.sort((a, b) => a - b);
  const perModule = ((times[1]! + lowerMs + wasmMs) * 1000) / size;
  console.log(
    `${String(size).padStart(5)} ${serialLowerMs.toFixed(0).padStart(12)} ${
      lowerMs.toFixed(0).padStart(9)
    } ${times[1]!.toFixed(0).padStart(6)} ${wasmMs.toFixed(0).padStart(7)} ${
      perModule.toFixed(0).padStart(12)
    } ${(11000 / perModule).toFixed(1).padStart(14)}x`,
  );
}
pool.terminate();
device.destroy();
