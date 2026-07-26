/**
 * Where the inference transitions actually go.
 *
 * The transition count is a single scalar, which gives a total and says nothing about shape. This
 * charges every transition to the frame kind that did it, and groups those kinds by what a
 * generate-then-solve encoding would do with them:
 *
 *   - **generate**: reads a Core node and its children and emits a constraint. Fixed work per node,
 *     no shared mutable state. This is the part that could become one lane per node.
 *   - **solve**: union-find, unification, occurs, generalize, instantiate. The fold.
 *   - **overhead**: validation, Tarjan, serialization, epoch clearing. Neither, and mostly fixed.
 *
 * Two findings came out of it, both in BASELINE. Generation is far too small a share for a parallel
 * generation pass to pay — it was 11.4% and is now 31.0%, an Amdahl ceiling of 1.45x. And the buckets
 * located the whole n^1.68 curve in eight visitors that walked variable link chains without ever
 * writing back, which was worth 4.83x once fixed.
 *
 * Also reports the round-trip count, because at ~11.3 ms each they stop being a rounding error once
 * the transition count falls far enough, and definition-level available parallelism, whose recorded
 * 1.9x was measured on a corpus that was 64% duplicated nodes.
 *
 * Usage:
 *   deno task profile:frames                          # the default Lazuli source
 *   deno task profile:frames examples/lazuli/x.laz    # any Lazuli source
 *   deno task profile:frames --gleam <stdlib-checkout>
 *
 * @module
 */
import { requestWebGpuDevice } from "../functional.ts";
import type { EncodedModule } from "../functional.ts";
import { parseLazuliSource } from "../src/lazuli/frontend.ts";
import { lazuliSurfaceToModule } from "../src/lazuli/functional_adapter.ts";
import { lowerGleamSources } from "../gleam.ts";
import { readGleamStdlib } from "./gleam_stdlib_corpus.ts";
import { GpuSemanticCompiler } from "../src/semantic/gpu_semantic_compiler.ts";
import { DEFINITION_WORD_LENGTH, DefinitionWord } from "../src/semantic/abi.ts";
import { semanticDefinitionParallelismProfile } from "../src/semantic/definition_wavefront.ts";
import type { GpuCompilationDispatchObservation } from "../src/semantic/gpu_type_inference_contract.ts";
import {
  INFERENCE_PROFILE_BUCKET_NAMES,
  INFERENCE_PROFILE_FRAME_BUCKETS,
} from "../src/semantic/type_inference_shader.ts";

const DEFAULT_SOURCE = "examples/lazuli/brainfuck_compiler.laz";

/**
 * Which frame kinds are generation, which are the solve. Bucket indices are
 * `INFERENCE_PROFILE_BUCKET_NAMES` positions.
 *
 * `LocalLookup` is counted as generation even though it instantiates: under DESIGN.md rule 5 it
 * becomes a flat per-function table lookup, so it is work the re-encoding removes rather than
 * parallelises. `Constructor` and the schema conversions are generation for the same reason — they
 * turn declared syntax into types without consulting the substitution.
 */
const GENERATE = new Set([
  0, // Expression
  9, // SchemaConvert
  10, // SchemaVisit
  12, // Constructor
  13, // LocalLookup
  14, // CaseBind
  21, // SchemaParameterCheck
  22, // FieldParameterRecoverability
  32, // SchemaOccurrence
]);

const SOLVE = new Set([
  1, // Prune
  2, // Unify
  3, // Occurs
  4, // OccursVisit
  5, // Generalize
  6, // GeneralizeVisit
  7, // Instantiate
  8, // InstantiateVisit
  11, // MappingLookup
  20, // FindType
  23, // PatternMatch
  24, // RefinementRollback
  25, // FullyZonked
  26, // FullyZonkedVisit
  27, // Rigidify
  28, // RigidifyVisit
  29, // IndexedShape
  30, // Subsume
  31, // ForallSearch
]);

function group(bucket: number): "generate" | "solve" | "overhead" {
  if (GENERATE.has(bucket)) return "generate";
  if (SOLVE.has(bucket)) return "solve";
  return "overhead";
}

async function gleamStdlibModule(checkout: string): Promise<EncodedModule> {
  const corpus = await readGleamStdlib(checkout);
  const frontend = lowerGleamSources(corpus.all, {
    module: corpus.entry.name,
    exportName: "main",
  });
  if (!frontend.ok) throw new Error(`lowering failed: ${frontend.diagnostics[0]?.message}`);
  return frontend.lowered.module;
}

async function lazuliModule(path: string): Promise<EncodedModule> {
  const source = await Deno.readTextFile(path);
  const parsed = parseLazuliSource(source);
  if (!parsed.ok) throw new Error(`${path}: ${parsed.diagnostics[0]?.message}`);
  return lazuliSurfaceToModule(parsed.surface, new TextEncoder().encode(source).byteLength);
}

const gleamIndex = Deno.args.indexOf("--gleam");
const [label, module] = gleamIndex >= 0
  ? [
    "gleam stdlib",
    await gleamStdlibModule(
      Deno.args[gleamIndex + 1] ?? (() => {
        console.error("usage: profile_inference_frames.ts --gleam <stdlib-checkout>");
        Deno.exit(2);
      })(),
    ),
  ]
  : [Deno.args[0] ?? DEFAULT_SOURCE, await lazuliModule(Deno.args[0] ?? DEFAULT_SOURCE)];

const device = await requestWebGpuDevice();
const surface = module;

// Cumulative counters, so the last observation of the run carries the whole total.
let profile: Uint32Array<ArrayBufferLike> = new Uint32Array(
  INFERENCE_PROFILE_BUCKET_NAMES.length,
);
let transitions = 0;
let semanticSteps = 0;

/**
 * Round trips per compile. Each one costs ~11.3 ms in Deno even with nothing submitted, so once the
 * transition count falls far enough the dispatch count stops being a rounding error and starts being
 * the bill.
 */
let dispatches = 0;

async function compileOnce(compiler: GpuSemanticCompiler): Promise<number> {
  dispatches = 0;
  const started = performance.now();
  const compilation = await compiler.compile(
    surface,
    module.sourceByteLength,
    { maximumSteps: 20_000_000, maximumStepsPerDispatch: 524_288 },
    undefined,
    {
      observeDispatch: (observation: GpuCompilationDispatchObservation) => {
        dispatches += 1;
        if (observation.inferenceTransitions < transitions) return;
        profile = observation.inferenceProfile;
        transitions = observation.inferenceTransitions;
        semanticSteps = observation.semanticSteps;
      },
    },
  );
  const elapsed = performance.now() - started;
  if (!compilation.ok) {
    throw new Error(`compilation failed: ${compilation.diagnostics[0]?.message}`);
  }
  compilation.module.destroy();
  return elapsed;
}

/**
 * The counting kernel is about 40% slower, so timing it would report a number nobody can compare
 * against BASELINE. Time the production pipeline, count with the profiling one, and print both --
 * transition counts are identical either way, which the two runs also cross-check.
 */
const productionCompiler = await GpuSemanticCompiler.create(device);
const samples: number[] = [];
for (let repetition = 0; repetition < 3; repetition++) {
  samples.push(await compileOnce(productionCompiler));
}
samples.sort((left, right) => left - right);
const elapsed = samples[1]!;

/**
 * Definition-level available parallelism, from the resolved Core the GPU produced.
 *
 * Reported here rather than in its own tool because it shares this one's premise: the recorded 1.9x
 * was measured when one definition was 52% of the corpus, and that definition turned out to be
 * mostly duplicated arm bodies. Both numbers have to be re-read together or neither means anything.
 */
const parallelismCompilation = await productionCompiler.compile(
  surface,
  module.sourceByteLength,
  { maximumSteps: 20_000_000, maximumStepsPerDispatch: 524_288 },
  undefined,
);
if (!parallelismCompilation.ok) {
  throw new Error(`compilation failed: ${parallelismCompilation.diagnostics[0]?.message}`);
}
const coreNodes = await parallelismCompilation.module.readCoreNodes();
const roots = Array.from({ length: surface.definitionCount }, (_, definition) => {
  const root = surface.definitionWords[
    definition * DEFINITION_WORD_LENGTH + DefinitionWord.RootNode
  ];
  if (root === undefined) {
    throw new Error(`surface omits the root node for definition ${definition}`);
  }
  return root;
});
const parallelism = semanticDefinitionParallelismProfile(roots, coreNodes);
parallelismCompilation.module.destroy();

const profilingCompiler = await GpuSemanticCompiler.create(device, { profileInference: true });
const profiledMilliseconds = await compileOnce(profilingCompiler);
device.destroy();

const counted = profile.reduce((total, count) => total + count, 0);
const totals = { generate: 0, solve: 0, overhead: 0 };
for (let bucket = 0; bucket < profile.length; bucket++) {
  totals[group(bucket)] += profile[bucket]!;
}

const percent = (count: number) => `${((count / Math.max(1, counted)) * 100).toFixed(1)}%`;

console.log(`${label}: ${module.nodeCount} nodes, ${module.definitionCount} definitions`);
console.log(
  `${transitions.toLocaleString()} inference transitions + ${semanticSteps.toLocaleString()} ` +
    `semantic steps in ${elapsed.toFixed(0)} ms (median of 3, production kernel; ` +
    `${profiledMilliseconds.toFixed(0)} ms with counters)`,
);
console.log(
  `${dispatches} round trips at ~11.3 ms each is ~${(dispatches * 11.3).toFixed(0)} ms of the ` +
    `${elapsed.toFixed(0)} ms; ${(elapsed * 1e6 / Math.max(1, transitions)).toFixed(0)} ns per ` +
    `transition overall`,
);
if (counted !== transitions) {
  console.log(
    `note: buckets sum to ${counted.toLocaleString()}, not ${transitions.toLocaleString()}`,
  );
}

console.log("\n  bucket                              transitions     share   group");
const order = [...profile.keys()].sort((left, right) => profile[right]! - profile[left]!);
for (const bucket of order) {
  const count = profile[bucket]!;
  if (count === 0) continue;
  const name = INFERENCE_PROFILE_BUCKET_NAMES[bucket] ?? `bucket${bucket}`;
  const kind = bucket < INFERENCE_PROFILE_FRAME_BUCKETS ? group(bucket) : "overhead";
  console.log(
    `  ${name.padEnd(32)} ${count.toLocaleString().padStart(13)} ${
      percent(count).padStart(8)
    }   ${kind}`,
  );
}

console.log("\n  group          transitions     share");
for (const key of ["generate", "solve", "overhead"] as const) {
  console.log(
    `  ${key.padEnd(12)} ${totals[key].toLocaleString().padStart(13)} ${
      percent(totals[key]).padStart(8)
    }`,
  );
}
console.log(
  `\n  per node: ${(counted / Math.max(1, module.nodeCount)).toFixed(1)} transitions, of which ` +
    `${(totals.generate / Math.max(1, module.nodeCount)).toFixed(1)} generate and ` +
    `${(totals.solve / Math.max(1, module.nodeCount)).toFixed(1)} solve`,
);

console.log("\n  definition-level parallelism (the premise under submodule splitting)");
console.log(`    definitions            ${parallelism.definitionCount}`);
console.log(`    SCC components         ${parallelism.componentCount}`);
console.log(`    waves                  ${parallelism.waveCount}`);
console.log(`    total work             ${parallelism.totalWork.toLocaleString()} nodes`);
console.log(`    critical path          ${parallelism.criticalPathWork.toLocaleString()} nodes`);
console.log(`    available parallelism  ${parallelism.availableParallelism.toFixed(2)}x`);
console.log(`    widest wave            ${parallelism.maximumWavefrontDefinitions} definitions`);
console.log(`    largest component      ${parallelism.largestComponentDefinitions} definitions`);
const criticalShare = parallelism.totalWork === 0
  ? 0
  : (parallelism.criticalPathWork / parallelism.totalWork) * 100;
console.log(`    critical path is       ${criticalShare.toFixed(1)}% of all work`);
