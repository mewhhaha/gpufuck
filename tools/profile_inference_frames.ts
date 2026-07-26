/**
 * Where the inference transitions actually go.
 *
 * BASELINE records 6,112,582 transitions costing 4,048 ms — 96% of GPU compile time — as a single
 * scalar. A total says nothing about whether the algorithm can be re-encoded, so this splits it by
 * the frame kind each transition was charged to, and groups those kinds by what a
 * generate-then-solve encoding would do with them:
 *
 *   - **generate**: reads a Core node and its children and emits a constraint. Fixed work per node,
 *     no shared mutable state. This is the part that could become one lane per node.
 *   - **solve**: union-find, unification, occurs, generalize, instantiate. The fold.
 *   - **overhead**: validation, Tarjan, serialization, epoch clearing. Neither, and mostly fixed.
 *
 * The split is the stop-gate on TASKS "re-encode inference": if generation is a thin slice, then
 * making it parallel cannot pay however wide the dispatch, and the effort belongs in the solver
 * instead.
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
import { semanticSurfaceFromModule } from "../src/functional/compiler.ts";
import { type GleamSourceModule, lowerGleamSources } from "../gleam.ts";
import { GpuSemanticCompiler } from "../src/semantic/gpu_semantic_compiler.ts";
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

const GLEAM_MODULES = [
  "bit_array",
  "bool",
  "bytes_tree",
  "dict",
  "dynamic",
  "dynamic/decode",
  "float",
  "function",
  "int",
  "io",
  "list",
  "option",
  "order",
  "pair",
  "result",
  "set",
  "string",
  "string_tree",
  "uri",
] as const;

/**
 * Lowering prunes to what the entry reaches, so profiling a small `main` would profile a handful of
 * nodes. The entry re-exports every public function in the corpus to root the whole library, the
 * same trick `gleam_stdlib_compile_bench.ts` needs and for the same reason.
 */
function allExportsEntry(sources: readonly GleamSourceModule[]): string {
  const lines: string[] = [];
  const calls: string[] = [];
  for (const module of sources) {
    const alias = module.name.replaceAll("/", "_");
    lines.push(`import ${module.name} as ${alias}`);
    for (const name of exportedFunctions(module.source)) {
      calls.push(`  let keep_${alias}_${name} = ${alias}.${name}`);
    }
  }
  return `${lines.join("\n")}\n\npub fn main() {\n${calls.join("\n")}\n  Nil\n}\n`;
}

function exportedFunctions(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/^pub fn ([a-z_][a-z0-9_]*)\s*\(/gm)) names.push(match[1]!);
  return names;
}

async function gleamStdlibModule(checkout: string): Promise<EncodedModule> {
  const sources: GleamSourceModule[] = await Promise.all(
    GLEAM_MODULES.map(async (name) => ({
      name: `gleam/${name}`,
      source: await Deno.readTextFile(`${checkout}/src/gleam/${name}.gleam`),
    })),
  );
  const entry: GleamSourceModule = {
    name: "stdlib_entry",
    source: allExportsEntry(sources),
  };
  const frontend = lowerGleamSources([...sources, entry], {
    module: entry.name,
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
const compiler = await GpuSemanticCompiler.create(device, { profileInference: true });

// Cumulative counters, so the last observation of the run carries the whole total.
let profile: Uint32Array<ArrayBufferLike> = new Uint32Array(
  INFERENCE_PROFILE_BUCKET_NAMES.length,
);
let transitions = 0;
let semanticSteps = 0;

const started = performance.now();
const compilation = await compiler.compile(
  semanticSurfaceFromModule(module),
  module.sourceByteLength,
  { maximumSteps: 20_000_000, maximumStepsPerDispatch: 524_288 },
  undefined,
  {
    observeDispatch: (observation: GpuCompilationDispatchObservation) => {
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
    `semantic steps in ${elapsed.toFixed(0)} ms`,
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
