/**
 * The largest thing Sweep can express, measured end to end.
 *
 * `examples/sweep/editor.sweep` is the pure core of a terminal editor -- a zipper buffer, a cursor,
 * and an edit loop -- in 280 lines with no I/O, strings, or built-in collections. It exists because
 * the other samples are too small to say anything, and because a benchmark wants a program somebody
 * might plausibly write.
 *
 * Read the output carefully. Transitions-per-node is *not* a language result: BASELINE.md records
 * Gleam at 22.9 transitions per node for a 2,343-node program and 122.3 for a 49,964-node one, so a
 * small program scores well whatever language it is written in. The figure that is a real
 * comparison is parse throughput, because it is the same measurement on both sides.
 *
 * Usage: deno task bench:sweep-editor
 */
import { compileModuleToWasm, GpuCompiler, requestWebGpuDevice } from "../functional.ts";
import { semanticDefinitionParallelismProfile } from "../src/semantic/definition_wavefront.ts";
import { GpuSemanticCompiler } from "../src/semantic/gpu_semantic_compiler.ts";
import type { GpuCompilationDispatchObservation } from "../src/semantic/gpu_type_inference_contract.ts";
import { compileSweepSource } from "../sweep.ts";

const source = Deno.readTextFileSync("examples/sweep/editor.sweep");
const bytes = new TextEncoder().encode(source).byteLength;

const parse: number[] = [];
for (let index = 0; index < 9; index++) {
  const started = performance.now();
  compileSweepSource("editor", source);
  parse.push(performance.now() - started);
}
parse.sort((left, right) => left - right);

const lowered = compileSweepSource("editor", source);
if (!lowered.ok) throw new Error(lowered.diagnostics[0]!.message);

const device = await requestWebGpuDevice();
const compiler = await GpuCompiler.create(device);
const semantic = await GpuSemanticCompiler.create(device);

let transitions = 0;
const observed = await semantic.compile(
  lowered.module,
  bytes,
  { maximumSteps: 10_000_000, maximumStepsPerDispatch: 524_288 },
  undefined,
  {
    observeDispatch: (observation: GpuCompilationDispatchObservation) => {
      transitions = Math.max(transitions, observation.inferenceTransitions);
    },
  },
);
if (!observed.ok) throw new Error(observed.diagnostics[0]!.code);
observed.module.destroy();

const gpu: number[] = [];
let wasmBytes = 0;
let wasmMilliseconds = 0;
let waves = 0;
let parallelism = 0;
let largestShare = 0;
for (let index = 0; index < 7; index++) {
  const started = performance.now();
  const compilation = await compiler.compileModule(lowered.module, { maximumSteps: 10_000_000 });
  if (!compilation.ok) throw new Error(compilation.diagnostics[0]!.code);
  gpu.push(performance.now() - started);
  if (index === 6) {
    const nodes = await compilation.module.readCoreNodes();
    const roots = [...compilation.module.definitionRoots];
    const profile = semanticDefinitionParallelismProfile(roots, nodes);
    waves = profile.waveCount;
    parallelism = profile.availableParallelism;
    const reach = (root: number): number => {
      const seen = new Set<number>();
      const stack = [root];
      let count = 0;
      while (stack.length > 0) {
        const at = stack.pop()!;
        if (at === 0xffffffff || at >= nodes.length || seen.has(at)) continue;
        seen.add(at);
        count++;
        const node = nodes[at]!;
        for (const child of [node.child0, node.child1, node.child2]) {
          if (child !== 0xffffffff) stack.push(child);
        }
      }
      return count;
    };
    largestShare = Math.max(...roots.map(reach)) / profile.totalWork;
    const emitStarted = performance.now();
    wasmBytes = (await compileModuleToWasm(compilation.module)).byteLength;
    wasmMilliseconds = performance.now() - emitStarted;
  }
  compilation.module.destroy();
}
gpu.sort((left, right) => left - right);

console.log(JSON.stringify(
  {
    sourceLines: source.split("\n").length,
    sourceBytes: bytes,
    surfaceNodes: lowered.module.nodeCount,
    definitions: lowered.module.definitionCount,
    constructors: lowered.module.constructorCount,
    parseAndLowerMilliseconds: Number(parse[4]!.toFixed(2)),
    parseMicrosecondsPerByte: Number(((parse[4]! * 1000) / bytes).toFixed(3)),
    gpuCompileMilliseconds: Number(gpu[3]!.toFixed(1)),
    emitWasmMilliseconds: Number(wasmMilliseconds.toFixed(1)),
    wasmKilobytes: Number((wasmBytes / 1024).toFixed(1)),
    inferenceTransitions: transitions,
    transitionsPerNode: Number((transitions / lowered.module.nodeCount).toFixed(1)),
    dependencyWaves: waves,
    availableParallelism: Number(parallelism.toFixed(1)),
    largestDefinitionShare: Number(largestShare.toFixed(3)),
  },
  null,
  2,
));
device.destroy();
