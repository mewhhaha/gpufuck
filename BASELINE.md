# Baseline

**This file is the measurement record: what was measured, how, and what turned out to be false.** It
is deliberately append-only in spirit — superseded numbers stay, with the correction next to them,
because several of them were wrong the first time and knowing that is the point.

For what to _do_ about these numbers, ranked, see [TASKS.md](TASKS.md). This file does not plan. For
the degenerate cases and hard walls behind several of them, and the measurement traps that made some
of them wrong, see [CHALLENGES.md](CHALLENGES.md).

Every performance claim in the repository is judged against this file. Reproduce the oldest section
with `deno task bench:throughput`; later sections name their own task.

**`deno task bench` is the machine-readable half of this file.** It records exact counters — node
counts, inference transition counts, emitted byte lengths — in `benchmarks/baseline.json` and fails
when one changes, while reporting timings without ever failing on them. That division follows from
this file's own history: every defect found so far moved a counter, and no wall time here meant
anything until the machine was quiet. Prose explains; the suite catches.

Marginal cost per module is the number that matters. Totals hide the crossover, because both the CPU
and GPU paths pay the same host parse — a total-wall-time ratio flatters the GPU.

## 2026-07-24 — before the node-parallel retarget

Ryzen 7 7800X3D, RTX 4080 SUPER, Deno 2.9.2, `maxStorageBuffersPerShaderStage` 16. Corpus:
two-definition Lazuli modules, one `helper` plus `main`.

| modules | CPU parse+infer (ms) | CPU infer (ms) | host lookup (ms) | GPU batch (ms) | GPU slower |
| ------- | -------------------- | -------------- | ---------------- | -------------- | ---------- |
| 1       | 0.30                 | 0.05           | 0.02             | 12.53          | 41.1x      |
| 16      | 1.65                 | 0.27           | 0.09             | 14.50          | 8.8x       |
| 64      | 3.12                 | 1.11           | 0.12             | 19.55          | 6.3x       |
| 256     | 11.69                | 3.73           | 0.46             | 40.85          | 3.5x       |
| 1024    | 41.87                | 11.60          | 3.24             | 120.23         | 2.9x       |

Marginal cost per module at N=1024:

| work                  | µs/module | note                                        |
| --------------------- | --------- | ------------------------------------------- |
| CPU parse + inference | 39.3      | the honest end-to-end baseline              |
| CPU inference alone   | 10.2      | exactly what the GPU replaces               |
| host symbol lookup    | 3.6       | the GPU path pays this too, before dispatch |
| GPU batch total       | 103.4     |                                             |
| GPU inference share   | 99.7      | **9.7x the CPU work it replaces**           |

## Noise

GPU batch timings spread roughly 30% run to run on this machine: the same tree measured 96.6, 101.2,
108.3, 117.1, and 129.7 µs/module across separate runs. **A single run cannot distinguish a real
change from noise.** Compare medians across at least three runs, and treat anything under about 20%
as unmeasured. The flat-grid lowering change looked like a 14% win on one run and was flat under a
proper A/B.

## What these numbers mean

**The GPU loses at every batch size, and the gap converges rather than crossing.** Its marginal cost
per module exceeds the CPU's total cost per module, so no batch size wins. The CPU baseline is
`inferTypes` in `src/semantic/type_inference.ts` — the host Hindley-Milner implementation that the
GPU shader is differentially tested against in `tests/semantic_gpu_diagnostic_parity_test.ts`, so
both columns do the same work.

**Two independent causes, with different fixes.**

1. _Floor (~11.3 ms)._ Deno's GPU round trip costs ~11.3 ms per await even on a buffer with nothing
   submitted; eight concurrent awaits cost the same as one. This is the whole of the N=1 number and
   it is a runtime property, not a compiler one. Unmeasured in Chrome.
2. _Slope (~9.7x)._ The semantic, inference, and evaluator kernels are all
   `@compute @workgroup_size(1)`, one lane per module, running a serial `loop { if phase == … }`
   state machine over a 74-field `var<private>` struct. The one exception, `lower_planned_module` at
   `workgroup_size(64)`, only copies a lowering plan the host already computed — about 2,300 of the
   ~28,800 GPU transitions per module. This survives any runtime fix.

**The Amdahl ceiling is 1.35x.** Parsing is 74% of the CPU path and stays on the CPU (baba). Even a
free, instantaneous GPU inference would only take the CPU path from 39.3 to 29.1 µs/module. Every
kernel-level improvement is bounded by this until parsing moves or gets faster.

For reference, baba parses at ~0.43 µs/byte (≈2.3 MB/s) with a ~17 µs fixed cost per call, where
tree-sitter does 10–30 MB/s. A 10x parser improvement would outweigh the entire retarget.

## 2026-07-25 — against the Gleam compiler, on one large real module

The throughput numbers above use a synthetic corpus of two-definition modules, which measures
_batching_. This measures the opposite case, and the one a language implementer actually has: a
single large program, compiled once, against the production compiler for that language.

Corpus: `gleam-lang/stdlib` at `bacc20c`, nineteen source modules, 252 KB, all reachable — the entry
binds every one of the 353 public functions, so nothing is pruned. Reproduce with
`deno task bench:gleam-stdlib <checkout> <entry.gleam>`. Same machine as above; Gleam 1.17.0.

> **Superseded twice on 2026-07-26.** Path halving took the GPU phase from 3,806 ms to 1,019.6 ms,
> then contification and the pattern-lowering fix took it to 322.7 ms and the corpus from 49,964
> nodes to 17,718 — so the comparable figure went 27x → 8.0x → **3.0x**. Everything below is the
> measurement as taken; see "contification" near the end of this file for the current numbers.

| Compiler                          | Cold, whole process |
| --------------------------------- | ------------------: |
| `gleam build --target javascript` |              146 ms |
| gpufuck                           |            4,890 ms |

**gpufuck is ~33x slower**, and it is doing strictly less: Gleam typechecks _and_ emits 49
JavaScript files to disk, while gpufuck writes nothing and its Gleam frontend covers a subset of the
language. Gleam's warm incremental build is 23 ms.

Where gpufuck's time goes (medians of 9, 49,964 surface nodes):

| Phase                               |       Median |   Share |
| ----------------------------------- | -----------: | ------: |
| Parse (baba)                        |        83 ms |      2% |
| Lower to surface                    |        67 ms |      2% |
| **GPU name resolution + inference** | **3,806 ms** | **96%** |
| Emit WebAssembly (1.7 MB)           |        25 ms |      1% |
| WebGPU device and pipeline setup    |       250 ms |       — |

The GPU phase alone is **26x Gleam's entire build**. This is the same defect the table above
records, seen without batching to hide it: the resolve-and-infer kernel is one lane running a serial
state machine, so a 49,964-node module is 49,964 sequential transitions on a single GPU thread — the
worst possible shape for the hardware. Batch throughput was 9.7x slower than the CPU;
single-large-module latency is 33x, because there is nothing to amortize the per-transition cost
against.

Note the inversion against the synthetic corpus: there, parsing was 74% of the CPU path and the
Amdahl ceiling was the story. Here parsing is 2%. On real input the GPU phase _is_ the cost, so the
ceiling argument does not apply and node-level parallelism is worth the whole budget.

### Where the 3.8 seconds actually goes

Instrumenting the dispatch loop (`observeDispatch`, same corpus, quantum 524,288) splits the GPU
phase cleanly, and the split is lopsided:

| GPU phase                         | Work                  |         Time |   Per unit |
| --------------------------------- | --------------------- | -----------: | ---------: |
| Core lowering and name resolution | 668,619 steps         |       141 ms |     211 ns |
| **Hindley-Milner inference**      | 6,112,582 transitions | **4,048 ms** | **662 ns** |

That is 13.4 semantic steps and **122.3 inference transitions per surface node**. Inference is 96%
of the GPU time; the resolution phase everyone assumes is the problem costs 141 ms.

**It is not round-trip bound.** The whole compile takes 14 dispatches, so `mapAsync` accounts for
about 160 ms of the 3,800. Sweeping the dispatch quantum confirms it, and incidentally re-measures
the stall:

| Quantum |    Median |
| ------: | --------: |
|  16,384 | 10,585 ms |
|  65,536 |  5,410 ms |
| 131,072 |  4,683 ms |
| 262,144 |  3,787 ms |
| 524,288 |  3,926 ms |

The curve flattens by 262,144 — the default of 524,288 is already at the plateau, so ~3,800 ms is a
genuine compute floor. The excess at 16,384 works out to 6,785 ms over ~610 dispatches, or 11.1 ms
each, which matches the 11.4 ms `mapAsync` figure measured independently above.

### Against our own CPU, and against Gleam

`inferTypes` is the differential oracle — the same Hindley-Milner, the same input — so the ratio
isolates the GPU rather than comparing two algorithms:

|                                              |     Time | vs Gleam |
| -------------------------------------------- | -------: | -------: |
| `gleam build` (typecheck **and** JS codegen) |   146 ms |       1x |
| gpufuck CPU Hindley-Milner alone             |   766 ms |     5.2x |
| gpufuck GPU full compile                     | 3,607 ms |      25x |

Two separate problems, and the smaller one is the GPU. **The GPU is 4.7x our own CPU** — better than
the 9.7x the synthetic batch corpus reported, because a large module amortizes fixed cost. But our
CPU inference is already **5.2x slower than Gleam's entire build**, codegen included. Making the GPU
match the CPU would still leave the compiler five times slower than the thing it is competing with.
The inference implementation is a target independent of where it runs.

### The GPU curve is transition count, not transition cost

Sweeping module size on the GPU path separates the two possible causes:

| Surface nodes | Inference transitions | Per node | ns per transition |
| ------------: | --------------------: | -------: | ----------------: |
|         2,343 |                53,566 |     22.9 |             1,205 |
|         4,417 |               105,344 |     23.8 |               834 |
|        33,864 |             5,739,578 |    169.5 |               576 |
|        49,964 |             6,112,582 |    122.3 |               568 |

**Per-transition cost falls as the module grows** (1,205 -> 568 ns), so this is not a
memory-hierarchy effect and not fixed overhead per transition; the shader gets _more_ efficient per
step at scale. All of the superlinearity is in the transition count, which scales as **n^1.68**.

At the small-module rate the full corpus would take 1.14 million transitions instead of 6.11 million
— a **5.4x excess**, worth ~2,800 ms of the 3,469 ms inference phase. Work per node jumps sevenfold
between 4,417 and 33,864 nodes, so there is a threshold effect worth isolating rather than a smooth
constant-factor drift.

This is the defect on the production path, and it is independent of the single-lane occupancy
problem. Fixing transition count and parallelising the kernel multiply.

### The CPU oracle is separately quadratic, and it is not on the compile path

`inferTypes` scales as **n^1.30** (nine points, 1,334 to 49,964 nodes; the exponent holds at 1.29
when the same roots are spread across 71 small functions instead of one, so it is not an artifact of
the benchmark entry). The cause is structural rather than subtle: `generalize` calls
`freeEnvironmentParameters`, which walks every type in the whole environment on every `let`; six
sites copy the entire environment with `new Map(environment)` to add one binding; and
`globalEnvironment()` is rebuilt per SCC component. There are no Remy levels, no path compression in
`prune`, and no visited-set memoization in `occurs`/`replaceParameters`.

**The shader does not share this algorithm.** It has Remy levels, epoch-marked traversal, a
persistent skip-list environment, and lazy instantiation. The two paths are differentially tested on
_results_, not asymptotics, and they curve alike for unrelated reasons — n^1.30 from environment
scans on the CPU, n^1.68 from transition count on the GPU.

So fixing the oracle speeds up the differential tests and this benchmark's CPU column. It does not
make compilation faster: `inferTypes` appears only in `tests/`, `benchmarks/`, and its own file.

### Why "2x faster than Gleam" is not reachable

The CPU-side work alone — parse 71 ms, lower 58 ms, emit Wasm 23 ms warm — totals **152 ms**, which
already exceeds Gleam's entire 146 ms cold build including JavaScript codegen. An infinitely fast
GPU still loses. Stacking every plausible win (5.4x from transition count, 20x from parallelising
the kernel, 4x on the parser, 2x on lowering) lands around 124 ms warm against Gleam's 23 ms warm.

The reachable goal is closing the gap from **33x to roughly 2-6x**, which needs, in order of
measured value: the n^1.68 transition count, the single-lane kernel, then the parser at 3.5 MB/s
against tree-sitter's 10-30.

Two measurement traps this benchmark hit, recorded so the next person does not:

- Lowering prunes to what the entry reaches. A small `main` lowered 252 KB of Gleam to **66 surface
  nodes** and produced a meaningless 124 ms. The entry must root every export.
- `compileModuleToWasm` memoizes per module, so a median over repeats times a cache hit and reports
  0.8 ms for a 25 ms operation. Each sample needs a freshly compiled module.

## 2026-07-25 — throughput, where the GPU wins

Everything above measures latency: one large program, compiled once. That is the case gpufuck loses
badly. This measures the opposite, and the conclusion reverses.

`gleam build` has no cross-package batching, so its per-package cost is a floor. Measured cold five
times on a minimal package containing the identical program: **11 ms**. Reproduce the gpufuck side
with `deno task bench:gleam-batch`.

| Batch | Serial frontend | Parallel frontend |    GPU | Wasm emit | Per module |  vs Gleam |
| ----: | --------------: | ----------------: | -----: | --------: | ---------: | --------: |
|     1 |           25 ms |              2 ms |  13 ms |      0 ms |  15,562 µs |      0.7x |
|    32 |           27 ms |              7 ms |  17 ms |      2 ms |     806 µs |     13.6x |
|   512 |          323 ms |             76 ms |  60 ms |    237 ms |     729 µs |     15.1x |
| 1,024 |          649 ms |            156 ms | 104 ms |    453 ms |     697 µs | **15.8x** |

Wasm emission is included because Gleam writes JavaScript to disk. The one-time WebGPU setup is
excluded; at batch 1,024 it amortizes to under a microsecond per module.

**Latency and throughput point opposite ways, and both are real.** One large module: 33x slower than
Gleam. A thousand independent modules: 15.8x faster. Which number matters depends entirely on
whether the workload is "build this project" or "compile these thousand programs" — a playground, a
package registry, a CI corpus, a Test262-style sweep.

### What the batch profile shows

At batch 1,024 the cost is **22% frontend, 15% GPU, 63% Wasm emission**. The GPU is the cheapest
phase in the pipeline. Two things follow.

`ParallelGleamFrontend` (`src/gleam/parallel_frontend.ts`) took the frontend from 649 ms to 156 ms,
a **4.2x** speedup on 16 cores. Parsing and lowering are pure functions of a source string, so they
parallelise across compilation units with nothing shared. The gap from the theoretical 15x is worker
message copying and per-worker JIT warmup, not contention.

Wasm emission is now the dominant cost at 442 µs/module, and it is worth knowing what it is _not_:
Core readback from the GPU is 1 µs, the three runtime body builders are 22 µs, and the
content-addressed fingerprint (`JSON.stringify` plus SHA-256 over every Core node) is 34 µs. The
remaining ~540 µs is instruction emission, and it is mostly **fixed per module** — `40 + 2` lowers
to 8 Core nodes and still emits a 1,244-byte code section, because every module carries its own
allocator, free list, and thunk-forcing runtime. The code section is 91-98% of every artifact.

### The compact-scalar path is attempted and discarded on every module

Profiling the emit path rather than reasoning about it found a specific defect.
`compileWasmArtifact` tries a compact-scalar encoding first, and discovers whether it was allowed
only _after_ compiling:

```
requiresRuntime = requestedAllocator || requestedThunkForce
                || bodies.some(usesMemory || usesIndirectCalls)
```

The gate that guards the attempt (`compactScalarEligible` in `wasm_backend_plan.ts`) checks the
evaluation profile, effects, host capabilities, and Store tags. It is true for **100% of Gleam
modules** and the attempt then succeeds for **0%** — measured across 14 program shapes including
`pub fn main() -> Int { 42 }`. Every module therefore builds a compiler, compiles its entry and
exports, throws the result away, builds a second compiler, and compiles again.

Forcing the gate off measured the cost: **371 -> 275 µs/module, 26% of codegen**, taking batch 1,024
from 15.8x to 20.3x against Gleam with byte-identical output (checksummed over 128 artifacts).

The fix is not a Core-tag predicate, which is what I tried first. Instrumenting the bail shows
`usesMemory` is true for every Gleam program — including `main() -> Bool { 1 < 2 }`, where
`requestedAllocator` is false — so the discriminator is set during emission and is not derivable
from the Core tags. A conservative tag list guessed at it and broke `functional_simd_test.ts`: the
compact path is live for F32x4 programs, which use `surface.apply` and still qualify because the
callee is a direct call. That attempt is reverted.

The causal chain is now fully traced, and both obvious fixes were tried and failed.

A nullary Gleam function lowers to `Lambda(Unit)`, because Functional Core has no zero-argument
functions. A synthetic `$gleam/entry` module (`src/gleam/frontend.ts`) then supplies the argument as
`Apply(sourceEntry, Constructor $Unit)`. A nullary constructor is not allocated — it lives in a
shared value slot and compiles to `i32Const(offset); i64Load(0)` — but that load is a _memory_
instruction, which is what sets `usesMemory`.

**Fixing the entry wrapper does not pay.** Every nullary constructor compiles to that same load, so
any program mentioning `None`, `Nil`, or an enum tag uses memory regardless of how the entry is
built. Removing the synthetic `$Unit` would only help programs that use no nullary constructor at
all.

**Aborting early does not pay either, and measurably hurts.** `usesMemory` is tracked incrementally,
so a sentinel thrown from its setter does abandon the attempt — verified firing on 100% of modules,
with byte-identical output. But the entry is a _direct_ call, so emission inlines the whole program
and only reaches a memory instruction near the end; almost nothing is saved. Meanwhile converting
`usesMemory` from a plain field to an accessor put a branch on every memory instruction in the
backend. Measured over three runs each: baseline 419 ms, early-abort 444 ms. Net loss. Reverted.

What the ceiling actually is, measured over three runs with the gate forced off: **347–357 ms
against a 419 ms baseline**, or 577–600 µs/module against 631, which is **18.3–19.1x** rather than
the 20.3x a single noisy run suggested. Roughly a 16% saving on emission is available to whoever
finds a correct way to claim it — smaller than the 26% first measured, and the difference is
run-to-run noise on a shared machine, which single-run comparisons in this file previously missed.

A third approach remains untried: stop inlining through the entry's direct call during the
speculative attempt, so the memory instruction is reached immediately rather than after the whole
program has been emitted.

That points at two different fixes with different shapes. Emitting bodies on the GPU is the
data-parallel one: the Core is already in GPU buffers, emission is a local per-node mapping, and
LEB128's data-dependent offsets are a size pass plus a prefix sum plus a write pass. Not re-emitting
an identical runtime per module is the cheaper one. The batch case wants the second first.

## 2026-07-25 — how splittable is a large module?

If batching 1,024 modules beats `gleam build` by 17x, the obvious question is whether a frontend can
split one large module into submodules and batch those. The arithmetic is inviting: ~55,000 nodes as
1,024 modules costs 645 ms, and ~50,000 nodes as one module costs 4,890 ms — **7.6x for the same
node count**.

`src/semantic/definition_wavefront.ts` already computes the dependency graph, SCC components, and a
wave schedule. Nothing in the compiler uses it; only tests, a benchmark, and the profiler do. Asked
about the Gleam stdlib corpus:

| Measure                   |    Value |
| ------------------------- | -------: |
| Definitions               |    1,039 |
| SCC components            |    1,035 |
| Largest SCC               |        3 |
| Dependency waves          |       21 |
| Widest wave               |      246 |
| Total work                |   49,964 |
| Critical path work        |   26,845 |
| **Available parallelism** | **1.9x** |

Mutual recursion is not the obstacle — the largest SCC is three definitions, and the graph is 21
shallow waves. The obstacle is that **one definition is 52% of the corpus**:

| Definition              |  Nodes | Share |
| ----------------------- | -----: | ----: |
| `gleam/list::sequences` | 25,985 | 52.0% |
| `gleam/uri::to_string`  |  5,480 | 11.0% |
| `gleam/uri::origin`     |  1,505 |  3.0% |

`list::sequences` alone is **97% of the critical path**. A single definition cannot be split across
submodules, so splitting caps at 1.9x on this corpus regardless of how it is done. The figure is not
an artifact of the benchmark entry: spreading the same 353 roots across 71 small functions gives the
same 1.9x.

### Why one function is half the corpus: pattern lowering explodes

`sequences` is 62 lines of Gleam. It becomes 25,985 Core nodes — about 420 nodes per source line.
The cause is a multi-subject `case` with or-patterns, which Gleam's stdlib uses freely:

```gleam
case compare(prev, new), direction {
  order.Gt, Descending | order.Lt, Ascending | order.Eq, Ascending -> ...
```

Reduced, with two subjects and two or-alternatives per arm:

| Arms | Surface nodes                   | Growth |
| ---: | ------------------------------- | -----: |
|    1 | 94                              |      — |
|    2 | 1,214                           |    13x |
|    3 | 19,134                          |    16x |
|    4 | exceeds the 65,536-node ABI cap | throws |

Each additional arm multiplies node count by 13–16x, and four arms is a hard failure rather than a
slow compile. This is a correctness bug before it is a performance one, and it is the largest single
lever on single-module compile time — the GPU is slow on this corpus partly because the corpus is
26,000 nodes larger than it should be.

## 2026-07-25 — designing a language to be splittable

Lazuli is ours to change, so: how splittable is it now, and what would designing for it look like?

Today it is in the same regime as Gleam. Same profile, applied to the samples:

| Sample               | Defs | Waves | Available parallelism | Largest definition |
| -------------------- | ---: | ----: | --------------------: | -----------------: |
| `brainfuck_compiler` |   20 |     5 |                  2.3x |                22% |
| `proofs`             |    5 |     2 |                  1.7x |                37% |
| `syntax-tour`        |    3 |     2 |                  1.0x |                89% |
| Gleam stdlib         | 1039 |    21 |                  1.9x |                52% |

Two ceilings, and which one binds differs by program. Available parallelism cannot exceed
`totalWork / largestDefinition`, because a definition is atomic — it cannot be split across
submodules. Where no definition dominates, dependency depth binds instead. For the Gleam stdlib the
first is exactly binding: 49,964 / 25,985 = 1.9, the measured figure.

### Restructuring moves it a long way

The same arithmetic written three ways, 40 terms each:

| Shape                                    | Defs | Waves | Parallelism | Largest def |
| ---------------------------------------- | ---: | ----: | ----------: | ----------: |
| One expression in `main`                 |    1 |     1 |        1.0x |        100% |
| One definition per term, flat `main`     |   41 |     2 |        3.3x |         28% |
| Per term, plus a balanced reduction tree |   80 |     8 |       13.3x |          2% |

Note the tree has _more_ waves and more parallelism: depth was not the constraint, definition size
was. Bounding definition size is the lever; accepting more waves is the price, and it is cheap.

### None of it is realized

| Shape | Nodes | Definitions | Compile |
| ----- | ----: | ----------: | ------: |
| mono  |   239 |           1 | 13.0 ms |
| split |   279 |          41 | 13.3 ms |
| tree  |   318 |          80 | 14.0 ms |

Thirteen-fold available parallelism, and the tree compiles _slower_ — more definitions is more work
for the single lane that processes them. The inference kernel is one lane per module, and
`definition_wavefront.ts` is not on the compile path, so nothing consumes the structure.

Restructuring a language for splittability is therefore necessary but not sufficient, and doing it
first would be building a supply with no demand. The consumer has to exist: either split into real
submodules and batch them through the path that already beats `gleam build` by 17x, or parallelise
inference across definitions within a module.

## 2026-07-25 — what each language feature costs to compile

If a language is to be designed for this pipeline, the question is which constructs are expensive.
Measured on Lazuli: one program per feature, the feature repeated 30 times, so the figure is
marginal cost per use rather than fixed overhead.

| Feature                      | Nodes/use | Inference transitions/use |
| ---------------------------- | --------: | ------------------------: |
| `let` binding                |       4.0 |                        23 |
| Arithmetic on literals       |       6.0 |                        29 |
| Polymorphic instantiation    |       4.0 |                        48 |
| `if` / `then` / `else`       |       7.0 |                        51 |
| Top-level definition         |       5.0 |                        63 |
| Annotated 1-param function   |       8.0 |                       123 |
| Unannotated 1-param function |       8.0 |                       135 |
| Constructor plus `case`      |       8.0 |                       166 |
| Unannotated 3-param function |      18.0 |                       323 |

**Arity is the dominant cost, and it is exactly linear.** Core has only unary lambdas, so an
n-parameter function is n nested ones:

| Parameters | Nodes/use | Transitions/use | Marginal      |
| ---------: | --------: | --------------: | ------------- |
|          1 |       8.0 |             135 | —             |
|          2 |      13.0 |             233 | +5 nodes, +98 |
|          3 |      18.0 |             323 | +5 nodes, +90 |
|          4 |      23.0 |             413 | +5 nodes, +90 |
|          5 |      28.0 |             503 | +5 nodes, +90 |

A five-parameter function costs 3.7x the inference of a one-parameter function. This is a property
of the Core ABI, not of Lazuli: every frontend pays it. An n-ary lambda and application node would
remove it for all of them.

Two results worth stating because they contradict what looked obvious:

**Annotations buy about 9%**, not the step change assumed when "mandatory top-level annotations" was
floated as the Go/Zig trade. Annotated and unannotated one-parameter functions are 123 and 135
transitions. Annotations may still change _wave_ structure, which this does not measure, but the
per-definition inference saving is marginal.

**Sharing beats duplicating.** One polymorphic function instantiated 30 times costs 1,449
transitions; thirty monomorphic functions used once each cost 4,050. Polymorphism is cheaper than
the duplication it avoids, by 2.8x here.

Scale caveat: these compiles run 12.5–18.6 ms against an ~11.4 ms fixed `mapAsync` floor, so the
ratios matter at batch scale or on large modules, not for one small compile. And the ceiling on
language design is lower than the ceiling on the kernel: avoiding the expensive constructs is worth
maybe 2–4x on inference, where parallelising the single-lane kernel is worth 10–50x.

## 2026-07-25 — Sweep at a realistic size

`examples/sweep/editor.sweep` is the pure core of a terminal editor: a zipper buffer, a cursor, and
an edit loop over eleven key commands, in 280 lines with no I/O, no strings, and no built-in
collections. It is the largest thing the language can express, and it exists because the other
samples are too small to say anything. Reproduce with `deno task bench:sweep-editor`.

| Measure                    |                  Value |
| -------------------------- | ---------------------: |
| Source                     | 280 lines, 8,707 bytes |
| Surface nodes              |                    718 |
| Definitions / constructors |                34 / 21 |
| Parse and lower            |                0.93 ms |
| GPU compile                |                23.7 ms |
| Emit WebAssembly           |       21.7 ms, 24.8 KB |
| Inference transitions      |                 15,537 |
| Dependency waves           |                      7 |
| Available parallelism      |                   3.6x |
| Largest definition         |                    13% |

**One number here is a real result and one is a trap.**

The real one is parse throughput: **0.106 µs/byte against baba's 1.20 µs/byte** on the Gleam stdlib,
the same measurement on both sides. A hand-written recursive-descent parser for a small grammar is
**12x** faster than the generated one, which is the same finding as the parser entry in TASKS and
now has a second data point.

The trap is transitions-per-node. 21.6 looks excellent against the Gleam stdlib's 122.3, and it is
not a language result at all: the n^1.68 curve means small programs score well whatever they are
written in, and Gleam at 2,343 nodes measures 22.9. Sweep at 718 nodes sitting at 21.6 is the curve,
not the design.

The structural figures are somewhere between the two. 13% largest definition and 3.6x available
parallelism beat the Gleam stdlib's 52% and 1.9x, but that reflects a program written as many small
functions rather than anything the language enforces — Sweep has no rule against a 26,000-node
function, it just did not happen to contain one.

## 2026-07-25 — the dispatch floor, and what it forecloses

The stall attributed to `mapAsync` throughout this file is not `mapAsync`. Measured directly with a
one-workgroup shader that increments a single `u32`:

| Round trip                       |   Median |
| -------------------------------- | -------: |
| `submit` + `onSubmittedWorkDone` | 11.29 ms |
| `submit` + copy + `mapAsync`     | 11.30 ms |

**Identical with no readback at all**, so the cost is the submit-to-sync path in Deno's WebGPU, not
the buffer mapping. The earlier attribution was wrong; the magnitude was right.

This is the hard bound on any single-program latency claim, and it is worth stating plainly because
it forecloses more than the inference work does:

- One empty round trip costs 11.3 ms. A CPU typechecks a 5,000-node module in about 1 ms. The work
  in a normal program is smaller than the cost of asking the GPU to do it.
- Gleam compiles its entire 252 KB standard library in 146 ms — thirteen round trips.
- A wavefront design with one dispatch per dependency wave would pay 21 x 11.3 = 237 ms on the
  stdlib in dispatch alone, before computing anything.

So a parallel inference kernel has to keep the whole wavefront inside **one** dispatch — a
persistent kernel with in-kernel synchronisation — or run somewhere other than Deno. That is a
design constraint, not a preference.

None of this touches throughput, which is where the measurements already favour the GPU: at batch
1,024 the fixed cost amortizes to 11 µs per module and gpufuck is ~17x faster than `gleam build`.

## 2026-07-25 — the width was there, measured at the wrong granularity

Everything above about available parallelism was measured per _definition_, treating each as atomic.
That gave 1.9x for the Gleam stdlib and the conclusion that one definition being 52% of the corpus
caps what any parallel design can do. **That conclusion was wrong**, and it was wrong because
constraint generation does not work on definitions — it works on nodes. A node is ready when its
children are, and resolved Core already stores every child at a higher index.

Computing each node's height with one reverse sweep:

| Measure                               |    Value |
| ------------------------------------- | -------: |
| Nodes                                 |   49,964 |
| Deepest definition (`uri::to_string`) |       87 |
| Average width at that depth           | **574x** |
| Widest single level                   |   22,101 |
| Levels wider than 1,000               |        6 |

The whole-corpus depth measures 355, but that is the benchmark's synthetic entry again — 353 nested
`let` bindings are a 353-deep chain by themselves. The deepest thing anyone actually wrote is 87.

And the definition that capped the earlier figure is not a bottleneck at this granularity:
`list::sequences` is 25,985 nodes and **65 levels deep**, so it is roughly 400x wide inside itself.
The unit that looked atomic is one of the widest things in the corpus.

22,101 nodes on the widest level is more than the concurrent lanes on this adapter, so that level
alone saturates it.

### How typical is that? Width is a function of program size

574x is an average over a very skewed distribution, and the average flatters it. Measured across
five real programs, reporting the _work-weighted_ view — what share of nodes sit in levels wide
enough to be worth dispatching:

| Program            |  Nodes | Depth | Mean | Median | >32 | >256 | >1024 |
| ------------------ | -----: | ----: | ---: | -----: | --: | ---: | ----: |
| `lazuli proofs`    |     43 |     7 |    6 |      4 |  0% |   0% |    0% |
| `sweep editor`     |    718 |    17 |   42 |     24 | 74% |  42% |    0% |
| `sweep vim`        |    923 |    25 |   37 |     12 | 84% |  45% |    0% |
| `lazuli brainfuck` |  1,128 |    32 |   35 |      6 | 74% |  49% |    0% |
| Gleam stdlib       | 50,390 |    87 |  579 |     24 | 99% |  97% |   79% |

The median level is 4–24 nodes wide in every one of them, the stdlib included, so 574x is not a
level anyone will see — it is 50,000 nodes divided by a depth that barely moved.

Two things generalise, and they point the same way:

**Most of the _work_ is in wide levels even when most _levels_ are narrow.** 74–99% of nodes sit in
levels wider than a warp for every program above 43 nodes. Narrow levels are numerous and cheap; the
wide ones hold the nodes.

**Width grows much faster than depth.** 70x the nodes buys 5.1x the depth, so mean width grows about
14x. A bigger program is _more_ parallel, not less — the opposite of the usual intuition about
critical paths.

Which puts the crossover in the thousands of nodes. A 1,000-node module has levels of a few hundred
at best, one warp's worth, so a GPU is pointless for it whatever the dispatch cost. A 50,000-node
module has 79% of its work in levels above 1,024 and genuinely saturates the adapter. That is the
same conclusion the batch result reached from the other side — the GPU needs volume, and it does not
care whether the volume arrives as one large program or a thousand small ones.

None of this makes single-program latency free: the 11.3 ms dispatch floor still applies, and
unification is a separate problem from generating the constraints. But it disposes of the claim that
a normal program has nothing wide enough to be worth a GPU, and the earlier 1.9x was an artifact of
asking about the wrong granularity.

## 2026-07-26 — where the 6.1 million transitions go, and why re-encoding will not pay

The plan was to re-encode Hindley-Milner as constraint _generation_ (one lane per Core node, a map)
plus a wavefront _solve_, on the argument that the current kernel entangles the two and so cannot
use the node-level width measured above. Before writing the kernel, the split was measured:
`deno task profile:frames --gleam <stdlib-checkout>` charges every transition to the frame kind on
top of the stack. Same corpus, same 49,964 nodes, and the total reproduces BASELINE's figure exactly
at 6,112,586.

| Frame kind           |   Transitions |     Share | Group    |
| -------------------- | ------------: | --------: | -------- |
| **InstantiateVisit** | **3,056,557** | **50.0%** | solve    |
| **Prune**            | **1,003,705** | **16.4%** | solve    |
| ForallSearch         |       521,157 |      8.5% | solve    |
| Expression           |       452,709 |      7.4% | generate |
| ConcreteVisit        |       286,311 |      4.7% | overhead |
| Unify                |       249,253 |      4.1% | solve    |
| Constructor          |        94,051 |      1.5% | generate |
| SchemaVisit          |        70,601 |      1.2% | generate |
| everything else (17) |       378,242 |      6.2% | mixed    |

| Group     |   Transitions |     Share |
| --------- | ------------: | --------: |
| generate  |       699,519 |     11.4% |
| **solve** | **4,966,457** | **81.2%** |
| overhead  |       446,611 |      7.3% |

**The re-encoding is dead, and this is what killed it.** Generation is 11.4% of the work. Making it
infinitely parallel is an Amdahl ceiling of **1.13x** — 122.3 transitions per node become 108.3.
Every argument for the split was correct about the shape of the algorithm and wrong about where the
time was, which is the same mistake the definition-granularity width measurement made.

### The prize is somewhere else, and it is bigger

**Half of all inference work is copying polymorphic type schemes.** `InstantiateVisit` is 50.0% of
6.1 million transitions on its own. That also locates the n^1.68 superlinearity recorded above,
because the blowup is entirely a scale effect — the same profile on a 1,128-node Lazuli program:

| Bucket           |   1,128 nodes |          49,964 nodes |
| ---------------- | ------------: | --------------------: |
| InstantiateVisit |    120 (0.5%) | 3,056,557 (**50.0%**) |
| Prune            | 4,869 (18.4%) |     1,003,705 (16.4%) |
| ForallSearch     |     17 (0.1%) |        521,157 (8.5%) |
| Expression       | 3,953 (14.9%) |        452,709 (7.4%) |
| _generate_       |       _40.6%_ |               _11.4%_ |
| _solve_          |       _46.0%_ |               _81.2%_ |

Generation's share **falls** with program size, from 40.6% to 11.4%, because the solve grows
superlinearly underneath it. So the bigger the program — exactly the case the GPU needs — the less
there is to gain from parallelising generation.

Three things are now ranked ahead of any re-encoding, all cheaper than one:

1. **Instantiation sharing (50.0%).** `start_lazy_instantiate` already defers the copy with a
   `TYPE_INSTANCE` thunk, but `materialize_type_instance` then copies the whole scheme graph per
   use. At stdlib scale that is three million transitions of graph copying.
2. **Path compression in `prune` (16.4%).** `prune_transition`
   (`src/semantic/type_inference_shader.ts`) walks the variable link chain and never writes back, so
   every hop costs a full transition and the same chain is rewalked. There is no union by rank
   either. This is the textbook fix and it changes no semantics.
3. **`ForallSearch` (8.5%)**, which is 0.1% small and 8.5% large — another scale term.

### The same number is the best evidence yet for DESIGN.md rule 1

Killing the re-encoding is not the same as vindicating the current algorithm, and the two
conclusions are easy to confuse. Re-encoding _keeps_ the solve and merely reorganises it, so it is
capped by the 11.4%. Rule 1 — full annotations, checking rather than inference — **deletes** the
solve, and the solve is 81.2%.

DESIGN.md flags, honestly, that the only number it had was "annotations are worth ~9%", and that
this neither supports nor refutes the rule because it measured annotations fed to an engine that
solves anyway. This is the better number. A checking-only pipeline has no unification variables, so
`Prune` (16.4%) does not exist; explicit type arguments make instantiation a substitution into a
known scheme rather than a search, which is most of `InstantiateVisit` (50.0%) and all of
`ForallSearch` (8.5%).

That remains an argument rather than a measurement — the constant factors of a checking kernel are
still unknown, and this repository has been wrong about constant factors before. But the cheapest
experiment DESIGN.md proposes is now the one with the largest measured number behind it, and Sweep
is the frontend already sitting there to run it against.

### A previous finding does not survive the scale

BASELINE records that one polymorphic function instantiated 30 times costs 1,449 transitions where
thirty monomorphic copies cost 4,050, concluding polymorphism is 2.8x cheaper than monomorphising.
That was measured on a small synthetic module. At stdlib scale instantiation is half of all work, so
the conclusion is at best size-dependent. It is not evidence for monomorphising — that would
multiply the node count — but "polymorphism is cheap" should not be quoted without the size.

### The instrument costs 40%, so it is a second pipeline

The counters are a build-time shader variant (`TYPE_INFERENCE_PROFILE_SHADER`), not a runtime flag.
A dynamically indexed store into the private state struct spills it out of registers: measured over
three runs each, **3,668-3,937 ms without the store against 5,173-5,190 ms with it**. Keeping the
`profile` array in the struct while never indexing it costs nothing, so both variants share one ABI,
one workspace and one set of buffers, and only the pipeline differs. Transition counts are identical
either way, so the shares above are unaffected by the instrument's own cost.

One known imprecision: the buckets sum to one more than `transitions` on runs that grow an arena,
because `discardGrowthTransition` rewinds the scalar and cannot know which bucket to rewind. The
tool prints the discrepancy rather than hiding it.

## 2026-07-26 — path halving: 4.83x fewer transitions, and the n^1.68 curve is gone

Acting on the bucket above. `prune_transition` walked a bound variable's link chain one charged
transition per hop and never wrote back, so every chain was rewalked from the start by every visitor
that touched it. Grepping for the pattern found **eight** sites doing the identical uncompressed
chase — prune, occurs, generalize, instantiate, forall-search, concrete, fully-zonked and rigidify
visitors — now all sharing one `halve_variable_link` helper that points each node at its grandparent
as it passes.

Only word 1 is compressed. Rigid refinement lives in word 3 and is undone by
`refinement_rollback_transition` from a trail of (node, previous value) pairs, so shortcutting a
rigid chain would survive a rollback that restores the link it skipped.

Gleam stdlib, 49,964 nodes, same corpus and machine:

| Bucket           |        Before |         After |    Factor |
| ---------------- | ------------: | ------------: | --------: |
| InstantiateVisit |     3,056,557 |        46,954 |   **65x** |
| ForallSearch     |       521,157 |         7,244 |   **72x** |
| ConcreteVisit    |       286,311 |        38,877 |      7.4x |
| Prune            |     1,003,705 |       204,700 |      4.9x |
| Expression       |       452,709 |       195,591 |      2.3x |
| GeneralizeVisit  |        27,663 |        16,887 |      1.6x |
| OccursVisit      |        46,817 |        37,444 |      1.3x |
| Unify            |       249,253 |       249,253 |         — |
| **total**        | **6,112,586** | **1,265,365** | **4.83x** |

Unify, Occurs, Constructor, SchemaVisit, LocalLookup and the phase buckets are unchanged to the
transition, which is the check that only chase-bearing code moved. `Expression` fell 2.3x without
being touched, because `Apply` stage 41 chases links inline inside its own frame and benefits from
chains the other eight shortened.

| Measure                          |    Before |          After |
| -------------------------------- | --------: | -------------: |
| Inference transitions            | 6,112,586 |      1,265,365 |
| Transitions per surface node     |     122.3 |       **25.3** |
| GPU resolve + infer              |  3,806 ms | **1,019.6 ms** |
| Comparable to `gleam build`      | ~3,956 ms | **1,166.7 ms** |
| vs `gleam build` (146 ms)        |       25x |       **8.0x** |
| vs our own CPU oracle (773.6 ms) |      4.7x |       **1.3x** |

Both columns are on the 49,964-node corpus. The pattern-lowering fix later showed 64% of those nodes
were duplicated arm bodies, so the per-node figures in this table — 122.3 and 25.3 — are per
_duplicated_ node. The ratio between them stands; the absolute values do not describe the program.

**The n^1.68 transition count is gone.** 23.5 transitions per node on a 1,128-node program against
25.3 on a 49,964-node one — 1.08x over 44x the nodes, which is linear inside the noise. The entire
superlinearity was uncompressed chains being rewalked, and BASELINE's "5.4x excess worth ~2,800 ms"
turns out to have been an underestimate: the actual recovery is 2,787 ms of a 3,806 ms phase.

**It buys nothing on small programs, which is the consistency check.** The 1,128-node Lazuli program
is 26,473 transitions before and after, exactly. Short chains have nothing to halve, which is what
makes this the same scale effect the bucket table found rather than a second unrelated one.

**No regression on the batch path.** Synthetic two-definition corpus at N=1024, GPU inference share,
three runs each: 99.5 / 97.9 / 101.9 µs with halving against 102.6 / 105.1 / 98.4 µs without.
Medians 99.5 and 102.6, comfortably inside the documented 30% band — those modules have no chains to
compress, so the two extra reads per prune are free rather than a cost.

### What this does to the re-encoding argument

The generate/solve split moves from 11.4/81.2 to **35.0/49.3** — the solve shrank by 8x and
generation barely moved, so generation's share rose without generation getting cheaper. An
infinitely parallel generation phase is now an Amdahl ceiling of **1.54x** rather than 1.13x. Still
not a reason to build it, and the profile is now much flatter — Unify 19.7%, Prune 16.2%, Expression
15.5% — so there is no single dominant term left to attack. The next real win is occupancy, not
encoding.

## 2026-07-26 — warp packing is not the occupancy lever. Measured, reverted

With transition count fixed, the obvious next target was warp utilization. Inference is
`@compute @workgroup_size(1)` dispatched `laneCount` times, so on this adapter every module owns a
workgroup that occupies a whole warp with **one of thirty-two lanes active**. Packing several
modules per workgroup looked like free occupancy.

Synthetic batch corpus at N=1024, GPU inference share, medians of three runs each:

| Workgroup size | Runs (µs)        | Median |
| -------------: | ---------------- | -----: |
|      1 _(was)_ | 99.5 97.9 101.9  |   99.5 |
|              8 | 99.4 97.9 102.4  |   99.4 |
|             32 | 99.5 98.3 96.0   |   98.3 |
|             64 | 96.1 107.3 103.3 |  103.3 |

**Flat.** Nothing outside the noise band across a 64x change in workgroup shape. Reverted.

**Divergence is not the explanation, which is what makes this conclusive.** The corpus modules are
structurally identical — `fn helper{i} n = n * {k}; fn main = helper{i} {i};`, differing only in
literals — so the packed lanes run in near-lockstep and should have shown the best case for packing.
They showed nothing.

The explanation is that **thread count was never the constraint; batch size is.** Both shapes launch
exactly 1,024 threads. Size 1 gives 1,024 warps at 1/32 lane utilization, size 32 gives 32 warps
fully packed. The kernel is latency-bound on scattered workspace reads, so the extra warps in the
unpacked shape hide latency exactly as well as the extra lanes fill it in the packed one. Packing
also makes the access pattern worse, not better: each lane owns a contiguous workspace arena at a
widely separated base, so thirty-two lanes in one warp issue thirty-two scattered transactions where
before they were spread across warps.

**What this rules out.** "Make the workgroup bigger" is off the table permanently, and so is any
occupancy plan that reshapes lanes without changing what a lane does. Batch-level parallelism is
already saturated — at N=1024 the adapter has all the independent work it can be given. The only
parallelism left is **inside a single module**, which is the hard problem item 7 describes, and
which the 11.3 ms dispatch floor constrains to one dispatch. Interleaving the workspace across lanes
so packed reads coalesce is the one variant not tried, and it is an ABI change for an unmeasured
gain.

## 2026-07-26 — the or-pattern explosion is body duplication, and the obvious fix is blocked

TASKS item 1 asked for measurement before a fix: is the multi-subject or-pattern blowup duplicating
arm _bodies_ or re-binding scrutinees? `deno task measure:or-patterns` answers it by growing the
body without touching the pattern matrix, so the two scale differently.

Two subjects over a three-constructor type, two or-alternatives per arm:

| Arms | body=1 | body=2 | body=4 | Implied body copies |
| ---: | -----: | -----: | -----: | ------------------: |
|    1 |     94 |    104 |    124 |                   5 |
|    2 |  1,214 |  1,384 |  1,724 |                  85 |
|    3 | 19,134 | 21,864 | 27,324 |               1,365 |
|    4 | throws | throws | throws |                   — |

Exactly reproduces the recorded 94 / 1,214 / 19,134 / throws. **It is body duplication**: 5, 85 and
1,365 copies is `(4^2n - 1)/3`, a base-16 exponential in the arm count.

The cause is one line. `lowerPattern` in `src/gleam/lowering.ts` compiles a constructor test as a
`case` over every constructor of the type, and hands the failure continuation — the entire rest of
the match — to each non-matching arm:

```
body: constructor === normalized.constructor
  ? this.lowerPatternSequence(binders, normalized.arguments, success, failure)
  : failure,
```

`SurfaceExpression` is a value tree, so that is a real copy, and because it happens at every level
of a nested or multi-subject pattern the copies compound.

### The obvious fix works and is blocked by a second, pre-existing bug

Binding the failure continuation to a join point once, exactly as `lowerSequentialCase` already does
with its `$gleam_case_fallback_N` lambdas, makes it linear:

| Arms | Before | After |
| ---: | -----: | ----: |
|    1 |     94 |    63 |
|    2 |  1,214 |   113 |
|    3 | 19,134 |   163 |
|    4 | throws |   213 |

+50 nodes per arm, and four arms compiles instead of exceeding the ABI cap. But it fails
`keeps multiple-subject Gleam recursion stack safe`, because **a join point is a lambda and a tail
call inside a lambda is not a tail call** — `#containsTailCall` in
`src/functional/wasm_function_analysis.ts` descends through `Let`, `Case`, `CaseArm` and `If`, and
stops at `Lambda`.

**That is a live correctness bug on `main`, not a consequence of the fix.** `lowerSequentialCase`
already binds later arms to fallback lambdas, so guarded Gleam already loses tail calls. Measured on
an unmodified tree:

```gleam
fn countdown(n, total) {
  case n {
    m if m <= 0 -> total
    _ -> countdown(n - 1, total + 1)
  }
}
```

overflows the stack at 100,000 iterations. Valid Gleam, silently miscompiled.

So the two existing pattern paths each pick one of the two failure modes, and neither is safe:

| Path                           | Rest of match     | Node count      | Tail calls |
| ------------------------------ | ----------------- | --------------- | ---------- |
| `lowerConstructorDecisionCase` | inlined per arm   | **exponential** | preserved  |
| `lowerSequentialCase`          | bound to a lambda | linear          | **broken** |

The join-point change was reverted pending contification in the backend, which fixes the tail-call
bug and makes the frontend change land unchanged. TASKS items 1 and 14.

## 2026-07-26 — contification, and the corpus was 64% duplication

Both halves landed: join-point contification in the WebAssembly backend (TASKS item 0) and the
frontend join point it unblocks (item 1).

**The backend half.** `joinPointLambda` in `src/functional/wasm_function_analysis.ts` recognises a
`let` whose value is a one-parameter lambda that ignores its parameter and whose binder is only ever
tail-called saturated. `compileTailPosition` then emits it as a label rather than a closure:

```
block $join (void) { <let body> }   ; every call site is `br $join`
<join body>                          ; emitted once, still in tail position
```

Every leaf of a tail position branches, so the join body is reachable only through a `br` — which
makes it shared rather than duplicated, and keeps it in the enclosing function's tail position so
self-calls inside it stay `br` to the loop header. Backward jumps cannot arise because `Let` is
non-recursive, so a forward `block` is sufficient and no dispatch variable is needed.

Two things the implementation needed that were not obvious from reading:

- **Codegen alone does nothing.** `#containsTailCall` has to descend into a contifiable join point's
  body as well, or the enclosing function is never registered as a loop and `compileTailPosition` is
  never called. Fixing only the emitter left the bug exactly as it was.
- **Arguments are discarded, not evaluated.** The parameter is dead, so the argument is dead. That
  is only sound for a leaf — nothing that could carry an effect — and `RuntimeFault` is excluded
  because it is an effect by itself.

Fixes the live bug: a guarded Gleam countdown now completes 100,000 iterations instead of
overflowing. Regression test `keeps guarded Gleam scalar recursion stack safe`.

**The frontend half**, re-applied unchanged from the reverted version:

| Arms | Before | After |
| ---: | -----: | ----: |
|    1 |     94 |    63 |
|    2 |  1,214 |   113 |
|    3 | 19,134 |   163 |
|    4 | throws |   213 |

Exponential to linear, +50 nodes per arm, and four arms compiles.

### The Gleam stdlib corpus was 64% duplicated nodes

| Measure               |    Before |       After | Factor |
| --------------------- | --------: | ----------: | -----: |
| Surface nodes         |    49,964 |  **17,718** |  2.82x |
| Inference transitions | 1,265,365 | **405,343** |  3.12x |
| Wasm emitted          |  1,745 KB |      999 KB |  1.75x |

**32,246 nodes of the corpus were duplicated arm bodies.** TASKS estimated `list::sequences` at
25,985 nodes and 52% of the corpus; the actual reduction is 64.5%, so the estimate was low. Every
per-node figure recorded before this point was measured against a corpus 2.8x larger than the
program it claimed to compile, including the 122.3 and 25.3 transitions-per-node numbers.

Lowering also got faster rather than slower, despite the extra node-size check. A/B under identical
(heavy) machine load, deriving lowering as `parseAndLower - parse`: **125.7 ms with join points
against 838.2 ms without**, 6.7x, because there are far fewer nodes to build.

### Timings, re-taken on a quiet machine

The first run of these happened at load average 21.9 with `clang++` builds resident, and `parse` —
which nothing in this change touches — swung between 245, 724 and 1,237 ms. Re-taken at load 2.87,
`parse` is back to 80.8 ms against the 80.2 ms recorded before any of this work, which is what makes
the rest of the column comparable. Medians of 9.

| Phase                           | Original | After halving | After contification |
| ------------------------------- | -------: | ------------: | ------------------: |
| Surface nodes                   |   49,964 |        49,964 |          **17,718** |
| Parse (baba)                    |    83 ms |       80.2 ms |             80.8 ms |
| Lower to surface                |    67 ms |       66.8 ms |             38.6 ms |
| GPU resolve and infer           | 3,806 ms |    1,019.6 ms |        **322.7 ms** |
| Emit WebAssembly                |    25 ms |       19.5 ms |              7.5 ms |
| **Comparable to `gleam build`** | 3,956 ms |    1,166.7 ms |        **442.1 ms** |
| vs `gleam build` (146 ms)       |      27x |          8.0x |            **3.0x** |
| CPU Hindley-Milner oracle       |   766 ms |      773.6 ms |            364.4 ms |
| vs our own CPU oracle           |     4.7x |          1.3x |            **0.9x** |

**The GPU is now marginally faster than our own CPU Hindley-Milner** on this corpus, 322.7 against
364.4 ms, for the first time in the project. The loaded run reported that ratio as 0.2x, so it was
flattering by a factor of four — the CPU oracle is single-threaded and suffers most under load.

Two caveats on that. `inferTypes` is separately O(n^1.30) and not on the compile path, so beating it
is a weak bar; `gleam build` is the real one and is still 3.0x away. And Gleam is doing strictly
more work, emitting 49 JavaScript files to disk where gpufuck writes nothing.

Batch throughput is unchanged to slightly better: GPU inference share 92.4 / 90.4 / 90.7 µs, median
**90.7 µs** against 99.5 µs after path halving. The synthetic corpus has no or-patterns, so there
was nothing there for the frontend fix to shrink.

Two days of measurement on the same corpus and machine: **3,956 ms to 442.1 ms, 8.9x**, and none of
it came from making the GPU wider. It came from a union-find that never wrote back and a pattern
compiler that copied the rest of the match into every constructor arm — both defects, not algorithm
limits. The single-lane kernel that this project was retargeted to fix is still single-lane.

## 2026-07-26 — re-measured premises on the deduplicated corpus, and there are no cheap wins left

Every bucket share and parallelism figure on record was taken on the 49,964-node corpus, 64% of
which turned out to be duplicated arm bodies. Re-taken on the real 17,718-node program.

**Transition count is linear, now confirmed on a real corpus.** 405,343 transitions over 17,718
nodes is **22.9 per node**, against 23.5 on a 1,128-node Lazuli program — 44x the nodes for a 0.97x
change. The n^1.68 curve is gone for good, and the earlier 122.3 and 25.3 figures were per
_duplicated_ node.

**The profile is flat.** No bucket is worth a dedicated fix:

| Bucket          | Share |
| --------------- | ----: |
| Unify           | 18.5% |
| Prune           | 15.3% |
| Expression      | 15.3% |
| phase:validate  |  7.7% |
| Constructor     |  5.2% |
| SchemaVisit     |  5.2% |
| phase:tarjan    |  5.1% |
| everything else | 27.7% |

Grouped: generate 31.0%, solve 49.3%, overhead 19.7%. The generate/solve ratio caps a
generation-only parallel pass at **1.45x**, so that idea stays dead.

**Definition-level parallelism is 3.38x, up from 1.9x.** The recorded 1.9x was real but was measured
when `list::sequences` was 52% of the corpus and 97% of its critical path — and that definition was
mostly duplication. Now:

| Measure                 |     Value |
| ----------------------- | --------: |
| Definitions             |     1,039 |
| SCC components          |     1,035 |
| Waves                   |        21 |
| Total work              |    17,718 |
| Critical path           |     5,242 |
| Available parallelism   | **3.38x** |
| Widest wave             |       248 |
| Largest component       |         3 |
| Critical path as % work |     29.6% |

Reproduce with `deno task profile:frames --gleam <checkout>`, which now reports both.

**It is not dispatch-bound, contrary to what the per-transition cost suggested.** 796 ns per
transition overall against the 568 ns recorded at 6.1M transitions looked like fixed cost taking
over, so the round trips were counted: **2 per compile, ~23 ms, 7% of 323 ms.** The rest is genuine
compute plus roughly 70 ms of per-compile setup that no longer amortizes over 15x more work. Not a
lever.

### What this leaves

Single-module latency now breaks down as parse 80.8 + lower 38.6 + GPU 322.7 = 442.1 ms, so **the
CPU phases alone (119.4 ms) already beat `gleam build`'s entire 146 ms.** A free GPU phase wins
outright. GPU inference is therefore not one target among several — it is the only one — and it
needs to reach **under 26.6 ms, which is 12x.**

Definition-level parallelism cannot get there: 3.38x takes 322.7 ms to ~95 ms, for a 215 ms total
that still loses. It would also need all 21 waves encoded into one command buffer, since 21 round
trips is 237 ms on its own. So the remaining lever is **node-level parallel inference inside a
single dispatch**, which is the hard problem, and nothing cheaper is left standing:

- Transition count: linear, flat profile, no dominant bucket.
- Warp shape: measured flat across 1/8/32/64.
- Dispatch count: 2, worth 7%.
- Generation as a parallel map: capped at 1.45x by its own share.

## 2026-07-26 — a big corpus, and the bottleneck has moved to the parser

Asked for a large example that proves it compiles fast. `deno task bench:gleam-corpus [modules]`
generates realistic Gleam — nominal types, recursive trees, guards, `Result` plumbing, tail
accumulators, roughly 1,174 surface nodes per module — and measures the two shapes separately,
because gpufuck behaves oppositely on them.

| Measure                     | 64 modules | 256 modules |
| --------------------------- | ---------: | ----------: |
| Source                      |   362.5 KB |  1,463.8 KB |
| Surface nodes               |     75,136 | **300,544** |
| **GPU batch compile**       |  **42 ms** | **87.9 ms** |
| GPU cost per node           |    0.56 µs | **0.29 µs** |
| Parse and lower (baba, CPU) |   521.3 ms |  2,152.8 ms |
| **Frontend share of total** |  **92.5%** |   **96.1%** |
| Total                       |   563.2 ms |  2,240.7 ms |
| vs `gleam build`            |       1.2x |   **1.26x** |

**The GPU compiles 300,544 nodes in 87.9 ms.** That is the part that is fast, and it is not close:
0.29 µs per node, improving with scale. Resolving names and running Hindley-Milner over 1.46 MB of
Gleam costs less than a tenth of a second.

**The compiler is not fast, because the GPU is now 3.9% of it.** baba takes 2,152.8 ms to parse and
lower the same input — 24x longer than the GPU spends compiling it — so end to end this beats
`gleam build` by 1.26x rather than by anything worth a headline.

This is exactly what the oldest section of this file predicted and then stopped being true for a
while: "baba parses at ~0.43 µs/byte where tree-sitter does 10–30 MB/s. A 10x parser improvement
would outweigh the entire retarget." On the real stdlib the GPU phase was 96% of the compile and the
parser looked irrelevant. After path halving, contification and the pattern fix, that has inverted.

### The recorded 17x holds only at toy module size

BASELINE records batch throughput as ~17x `gleam build`, and that number is not wrong — it is
measured on two-definition modules, where the frontend has almost nothing to do and the comparison
is against Gleam's ~11 ms per-package floor. At 1,174 nodes per module the frontend is 96% of the
work and the same claim is worth 1.26x.

Both Gleam bounds are reported, and at this size they coincide: the per-package floor (256 x 11 ms =
2,816 ms) and Gleam's measured rate on the standard library (257.3 KB per 146 ms, so 1,463.8 KB in
~831 ms) — the floor is larger, so the floor is what binds, and it is the bound generous to gpufuck.

### Batching is worth 39x on identical nodes

The same generated modules, compiled the two ways:

| Shape                   | GPU cost per node |
| ----------------------- | ----------------: |
| 256 independent modules |       **0.29 µs** |
| one linked module       |      **11.34 µs** |

**39x, for the same nodes.** The batch path runs one lane per module and fills the adapter; the
linked path runs one lane for the whole program. This is the single-lane kernel measured from a
third direction, and it agrees with the other two.

### "One big project" is not a shape this compiler accepts

The linked case is capped by the ABI, not by speed. A module may hold 65,536 surface nodes, and at
~1,174 nodes per module that ceiling arrives at **51 modules** — the benchmark links as many as fit
and reports the count rather than choosing silently. A real project past roughly 60,000 nodes cannot
be handed to this compiler as one module at all, which is an argument for the submodule splitting in
TASKS item 2 that has nothing to do with performance.

## 2026-07-26 — the parallel frontend was already built, and it is 6.5x

`ParallelGleamFrontend` has existed for a while, measured at 4.2x on 16 cores, and was on no path
any benchmark, tool or the playground used. Wired into the corpus benchmark and the suite, it is
better than recorded.

| Corpus      | Serial frontend | Parallel (16 workers) |  Speedup |
| ----------- | --------------: | --------------------: | -------: |
| 64 modules  |        463.4 ms |              128.5 ms |     3.6x |
| 256 modules |      1,864.9 ms |          **398.0 ms** | **4.7x** |

The corpus benchmark, whose timing includes the whole frontend rather than the suite's warmed pool,
reports **6.52x** on the same input. Both are recorded because they measure slightly different
things and neither is wrong.

**Node counts are asserted equal across both paths** — 300,544 either way — and the suite fails if
they diverge. A parallel frontend that produced different work would be worse than a slow one.

### What it does to the corpus comparison

| Measure                     |     Serial | Parallel frontend |
| --------------------------- | ---------: | ----------------: |
| Frontend                    | 2,183.7 ms |      **334.8 ms** |
| GPU batch                   |   130.5 ms |          130.5 ms |
| Total                       | 2,314.2 ms |      **465.2 ms** |
| vs `gleam build` (2,816 ms) |      1.22x |         **6.05x** |

So the 17x claim partly returns, on realistic module sizes this time: **6.05x** rather than 1.26x.
It cost nothing to get — the code was written, tested and idle.

### Parse against lower, now tracked separately

Splitting the frontend, because attributing all of it to baba over-credited the parser by a third:

| Phase         | 64 modules | 256 modules |
| ------------- | ---------: | ----------: |
| Parse         |   339.3 ms |  1,286.6 ms |
| Lower         |   124.1 ms |    578.3 ms |
| _Parse share_ |      _73%_ |       _69%_ |

> Superseded immediately below: the 1.16 MB/s is baba **plus** our cursor-to-AST walk. baba alone is
> 1.89 MB/s and is 41% of the frontend, not 69%.

baba is 1.16 MB/s here against tree-sitter's 10–30 MB/s, so parsing is a 10–25x implementation gap
on the CPU rather than an algorithmic wall. Lowering is the other 31% and has never been profiled;
both are now timings in `deno task bench` so neither can drift unwatched.

## 2026-07-26 — 57% of the frontend is our code, not baba's

Before telling the baba repository its parser is the bottleneck, the number was checked. It was
`parseGleamModule`, which is baba **plus** the walk that turns baba's cursor into a Gleam AST. Split
on the 256-module corpus, medians of five:

| Phase                          |     Time |      Rate | Share of frontend |
| ------------------------------ | -------: | --------: | ----------------: |
| baba parse                     |   758 ms | 1.89 MB/s |               41% |
| Our Gleam AST construction     |   477 ms |         — |               26% |
| Our lowering to packed surface |   578 ms |         — |               31% |
| _frontend total_               | 1,865 ms | 0.79 MB/s |              100% |

**So baba is 41% and our own code is 57%.** The 1.16 MB/s figure recorded earlier was baba plus our
AST walk; baba alone is **1.89 MB/s**. Both earlier attributions were wrong in the same direction —
first blaming the parser for lowering, then blaming baba for our AST construction — and the pattern
is worth noting: the frontend is three phases and only one of them belongs to the dependency.

### What this does to the GPU lexer argument

A GPU lexer in baba would attack 41% of the frontend, and 41% of a frontend that is already 335 ms
with the worker pool — so about 140 ms of a 465 ms compile. The throughput case for it is much
weaker than "the parser is the bottleneck" implied.

The residency case survives and is unaffected: tokens produced on-device could feed the GPU pipeline
without a round trip. But it cannot pay off alone, because our side would still build a Gleam AST on
the CPU and then lower it — 57% of the frontend that a GPU lexer does not touch.

### The lead that is actually ours

**The intermediate Gleam AST may be skippable.** `parseGleamModule` walks baba's cursor into
`GleamModule`, and `lowerGleamSource` then walks that into the packed surface — two full tree walks
over the same program, 1,055 ms combined. Lowering directly from baba's cursor to packed surface
arrays would remove one of them, and it is entirely within this repository.

Unmeasured, and the obvious risk is that the Gleam AST is load-bearing for diagnostics and for the
`use` desugaring, so removing it may not be a simple fusion. But it is a larger number than anything
a GPU lexer would return, and it needs nobody else's repository.

## 2026-07-27 — baba 7.0.0 was 27% slower; 7.1.0 recovers it exactly

Updated from 5.1.0 to 7.0.0, which is published as improving parser and lexer performance. On this
corpus it does the opposite.

The upgrade itself is clean. The breaking change is the generated-artifact format, so all three
grammars were regenerated; **no source changed**, `RuleCursor` and the parse options are identical
between the two versions, and 348 tests pass. Every counter in `deno task bench` is unchanged —
identical node counts, transition counts and emitted Wasm bytes — so 7.0.0 produces the same trees.

Parse throughput, 256 generated modules, 1.43 MB, nine samples each, back to back on a quiet
machine:

| Version   |       Median |          Rate | Samples   |
| --------- | -----------: | ------------: | --------- |
| **5.1.0** | **1,193 ms** | **1.20 MB/s** | 1170–1307 |
| 7.0.0     |     1,521 ms |     0.94 MB/s | 1458–1543 |

**27% slower, and the ranges do not overlap** — 5.1.0's slowest sample is faster than 7.0.0's
fastest. There is no opt-in being missed: `LexOptions` and `ParseOptions` are byte-identical between
versions and the CLI target flags are unchanged.

### 7.1.0 puts it back

Published the same day and taken back to back with the other two, nine samples each:

| Version   |       Median |          Rate | Range     |
| --------- | -----------: | ------------: | --------- |
| 5.1.0     |     1,193 ms |     1.20 MB/s | 1170–1307 |
| 7.0.0     |     1,487 ms |     0.96 MB/s | 1466–1569 |
| **7.1.0** | **1,197 ms** | **1.19 MB/s** | 1173–1295 |

**Parity with 5.1.0, to within 0.3%** — the ranges sit on top of each other. 7.0.0 was re-measured
here rather than quoted from the earlier run, and it reproduced at 1,487 ms against the 1,521 ms
recorded half an hour before, so the regression was real and is now gone.

7.1.0 is therefore a fix, not an improvement: it recovers what 7.0.0 lost and does not beat the
version before it. The upgrade is still worth taking — it is where the WebGPU lexer lives and where
future work lands — but nobody should expect the frontend to get faster from it.

Counters are unchanged again across all three versions, so every one of them produces identical
trees. The GPU-lexer fit is unchanged too: Gleam still exceeds workgroup storage by 4,064 B,
javascript-aot by 19,904 B, and Lazuli still fits.

### The new WebGPU lexer does not apply to this workload

7.0.0 adds a `./runtime/webgpu-lexer` export, which is the shape this project asked for. Its own
documentation rules it out here, and the numbers are not close:

- it **loses to the CPU below ~768 KiB of source**, and our modules average 5.7 KB;
- the ~226 ms device setup is "never repaid by any single document";
- it is **async**, so it cannot be hosted inside the synchronous generated `parser.lex()`;
- it accepts **guard-free grammars only**;
- it is marked experimental and may be removed without a major release.

Lexing the whole corpus as one blob would clear the size threshold, but the parser needs a tree per
module, so that is not the shape available.

### The benchmark suite is blind to this

A 27% regression sits inside the suite's 30% timing-noise band, so `deno task bench` reported
"within noise" and every counter matched. It was found only by an explicit nine-sample A/B with the
two versions swapped back to back.

That is the cost of the counters-fail/timings-advise design, and it is the right trade rather than a
defect — a suite that failed at 27% would fire on ordinary machine variation. But it means a real
performance regression can land green, and the honest mitigation is to A/B any dependency bump
directly rather than trusting the suite to catch it.

## 2026-07-27 — the WebGPU lexer, measured: two of three grammars cannot run it

Asked whether a bigger project would make baba 7.0.0's WebGPU lexer worth using. Measured rather
than reasoned, and the answer is decided before project size enters into it.

### Grammar size is the gate, not source size

The kernel holds the DFA tables in **workgroup storage**, sized by `stateCount × classCount`. On an
RTX 4080 SUPER, which reports `maxComputeWorkgroupStorageSize = 49,152 B`:

| Grammar        | Guard-free | Workgroup storage needed |          Verdict |
| -------------- | ---------: | -----------------------: | ---------------: |
| lazuli         |        yes |                     fits | runs, chunk 4096 |
| **gleam**      |        yes |       **53,216 B** (+8%) |      **refused** |
| javascript-aot |        yes |      **69,056 B** (+40%) |      **refused** |

"A storage-buffer fallback for the DFA tables is not implemented", so this is a refusal at `create`,
not a slow path. **The Gleam frontend — the one that matters here — cannot use the GPU lexer at
all**, and it is 8% over on a high-end card. The WebGPU-guaranteed floor is 16,384 B, so Gleam is
3.2x over what a conforming device must provide.

A bigger project does not change any of this. The grammar is the same size whatever you feed it.

### And on the one grammar that fits, the crossover is above what we can compile

Lazuli, `brainfuck_compiler.laz` repeated, medians of five, GPU timings including readback:

|   KiB | CPU lex | GPU lex | Winner        |
| ----: | ------: | ------: | ------------- |
|     4 |  0.2 ms | 12.8 ms | CPU           |
|    32 |  0.8 ms | 12.9 ms | CPU           |
|   130 |  2.8 ms | 13.8 ms | CPU           |
|   519 | 10.8 ms | 16.3 ms | CPU           |
| 2,077 | 43.4 ms | 23.8 ms | **GPU**       |
| 4,154 | 90.8 ms | 32.0 ms | **GPU, 2.8x** |

The crossover is between 519 KiB and 2 MiB, broadly matching baba's own ~768 KiB figure. Device
setup measured **226 ms**, exactly as documented — 2.5x the entire CPU lex of a 4 MiB file, and
amortizable across many calls in a process but never within one compile. The GPU floor is ~12.8 ms
even for 4 KiB, which is the same round-trip floor this project has measured everywhere else.

**Our ABI caps a module at 65,536 surface nodes, and that is below the crossover.** At the two
densities measured — 4.99 bytes per node on the generated corpus, 14.5 on the Gleam standard library
— the largest compilable single module is **327 KB to 950 KB of source**. The dense case is well
under the crossover; the sparse case only just reaches it. So even a document at the ABI ceiling is
marginal at best.

### What a bigger project actually is

More files, not bigger files, and the lexer is per document. Scaling up multiplies the number of
sub-crossover lex calls, each of which loses. The one shape that would win is concatenating a whole
project into a single buffer and splitting token records at document boundaries afterwards — that is
not what the API offers, and lexing across a boundary is not obviously safe, since an unterminated
string in one file would run into the next.

So the wgpu path is not available to the Gleam frontend on this hardware, and would not pay on the
workload even where it is.

## 2026-07-27 — baba 7.2.0: the GPU lexer wall is gone

Bumped 7.1.0 → 7.2.0. The upgrade is again clean — no source change, three grammars regenerated, 348
tests passing, every counter unchanged — and this time something real moved.

### All three grammars now fit the GPU lexer

| Grammar        | States | 7.1.0            | 7.2.0    |
| -------------- | -----: | ---------------- | -------- |
| gleam          |    183 | OVER by 4,064 B  | **FITS** |
| lazuli         |     82 | fits             | fits     |
| javascript-aot |    238 | OVER by 19,904 B | **FITS** |

The plans did not change shape — identical state counts, identical transition counts, the same CSR
rows. **The kernel stopped expanding them.** 7.1.0 built a dense states × classes table in workgroup
storage, which for Gleam was 4 × (128 + 183 + 183×63) + 32 × 183 = 53,216 B against 49,152 B
available. 7.2.0 adds a second path that keeps the dense table in device storage and needs only
`512 + 36 × states` of workgroup memory — the `classCount` term, which was the entire problem, is
gone. Selection is automatic, with no option to set.

So the wall recorded on 2026-07-27 as "the WebGPU lexer refuses this grammar" lasted about four
hours. Reproduce with `deno task check:gpu-lexer`.

### GPU lexing beats CPU parsing above ~11–16 KiB per file

Gleam plan, best of nine, one file at a time:

| Source    | GPU lex | CPU parse |   Ratio |
| --------- | ------: | --------: | ------: |
| 7.4 KiB   | 12.2 ms |    6.2 ms |    0.51 |
| 14.7 KiB  | 13.0 ms |   18.1 ms |    1.39 |
| 29.3 KiB  | 13.3 ms |   48.7 ms |     3.7 |
| 117.5 KiB | 15.4 ms |  134.3 ms | **8.7** |

**The crossover is a band, not a point**, roughly 11–16 KiB. The GPU side is flat at 12–13 ms across
that whole range, which is a fixed submit-and-sync floor rather than work; the CPU side is what
moves.

Past the CPU's reach the GPU keeps scaling: 0.93 MiB at 49 MB/s, 3.8 MiB at 117 MB/s, 15.3 MiB at
**146 MB/s** — and 15.3 MiB was the top of the ladder, not a limit. The CPU parser cannot follow:
117.5 KiB is the largest single source it accepts, and 147.3 KiB throws `PARSER_TRACE_LIMIT`.

Even at 15.3 MiB the kernel is not compute-bound. Of 158 ms total, `gpuStagesTotalMs` is 38 ms;
readback is 71 ms and submit-and-sync 57 ms.

### The Gleam GPU lexer, reproducibly

`deno task bench:gpu-lexer` now measures this rather than a scratch probe. Best-of-nine per row,
because interference can only add time, so the minimum is the honest estimator. `WebGpuLexer.create`
costs **265.2 ms** one-time and reports `usesStorageTables: true`, which is the 7.2.0 mechanism
confirming itself.

| Source    |  GPU lex | CPU parse |     Ratio | Tokens |
| --------- | -------: | --------: | --------: | -----: |
| 7.4 KiB   | 12.07 ms |   6.38 ms |     0.53x |  3,546 |
| 11.0 KiB  | 13.10 ms |   9.12 ms |     0.70x |  5,278 |
| 14.7 KiB  | 13.01 ms |  12.62 ms |     0.97x |  7,010 |
| 22.0 KiB  | 13.17 ms |  22.07 ms |     1.68x | 10,474 |
| 29.3 KiB  | 13.18 ms |  27.54 ms |     2.09x | 13,938 |
| 58.5 KiB  | 12.36 ms |  62.88 ms |     5.09x | 27,794 |
| 110.0 KiB | 13.32 ms | 127.33 ms | **9.56x** | 52,042 |

Past what the CPU parser will accept at all:

| Source    |  GPU lex |      MB/s |    Tokens |
| --------- | -------: | --------: | --------: |
| 0.231 MiB | 14.08 ms |      16.4 |   110,930 |
| 0.931 MiB | 16.34 ms |      57.0 |   443,474 |
| 3.788 MiB | 34.19 ms | **110.8** | 1,773,650 |

**Crossover is 14.7 KiB**, where the ratio crosses 1.0. The GPU column is flat at 12–13 ms from 7
KiB to 110 KiB — a fifteenfold increase in input for no change in time — so below ~100 KiB this is a
submit-and-sync floor rather than work, and the crossover is really the CPU curve rising to meet a
constant.

These reproduce an independent measurement taken by a separate agent under different machine load
(12.16 / 12.90 / 13.10 ms on the GPU side, 8.7x at 117.5 KiB), which is the cross-check that matters
given the CPU column's sensitivity to load.

### Why this still does not help gpufuck today

Four reasons, in order:

1. **It is not a like-for-like comparison.** The GPU produces a token record array;
   `parseGleamModule` tokenizes _and_ builds the Gleam AST. baba exports no CPU lexer over the same
   plan, so lex-versus-lex could not be isolated. The 8.7x flatters the GPU by an unknown factor.
2. **Our files are below the crossover.** The mean corpus module is 5.7 KiB against an 11–16 KiB
   crossover, so per-module dispatch loses. A win needs many modules batched into one dispatch,
   which the API does not offer.
3. **Setup is 237.8 ms**, about 15 lexes of the largest file the CPU can parse.
4. It remains async, experimental, and removable without a major release.

### The parse A/B did not resolve, and the machine is why

An unrelated `porffor` test run held 386–403% CPU throughout. Within-run spread reached 40–56% while
the between-version gap was 40–80 ms, and the ordering flipped between interleaved rounds. Both
versions sit in a 1.09–1.37 s band consistent with 7.1.0's recorded 1,197 ms.

What can be said: **nothing resembling the 7.0.0 regression is present.** That was 1,487 ms, far
outside every band measured here. Beyond that, 7.2.0 versus 7.1.0 is unresolved and wants re-taking
on a quiet machine.

## 2026-07-27 — lexing is 1% of the frontend, so the GPU lexer cannot help

Asked why the browser takes 10 s to parse and lower 64 modules, and whether GPU lexing was being
used. It was not, and measuring what it _could_ have done settles the question.

Splitting the frontend on a 54.8 KB module, best of nine:

| Stage                     |      Time | Share of frontend |
| ------------------------- | --------: | ----------------: |
| baba lex only             |   1.13 ms |            **1%** |
| baba parse (lex + tree)   |  29.16 ms |               22% |
| + Gleam AST construction  |  75.52 ms |               57% |
| + lower to packed surface | 133.11 ms |              100% |

**Lexing is 1.13 ms of 133 ms.** A free, instantaneous GPU lexer caps the frontend win at **1.01x**.
Tree building, the Gleam AST and lowering are the other 99%, and none of them is what the kernel
does.

### This corrects yesterday's GPU lexer benchmark

`bench:gpu-lexer` reports 9.56x at 110 KiB and is labelled "not like-for-like, flatters the GPU by
an unknown factor". The factor is now known: it compares GPU **lexing** against CPU
**parse-plus-AST**, and on the CPU side lexing is 1.13 ms of a 29.16 ms parse. The comparison gives
the GPU roughly a twenty-sixth of the work and reports the ratio as a speedup.

The benchmark is still worth keeping — it bounds what the kernel can do and shows it scaling to 110
MB/s where the CPU parser refuses input at all — but **the 9.56x is not a frontend speedup and must
not be quoted as one.**

### Workers are the fix, and they are now in the browser

Parsing and lowering are pure per module, so they parallelise with nothing shared. The playground
now bundles `frontend_worker.ts` as a second entry point and runs one worker per core less one.

Batch of 64 x the 57 KB stress example, 3.57 MB of Gleam, measured live in the same browser:

| Frontend       |         Time |
| -------------- | -----------: |
| One thread     |    26,000 ms |
| **15 workers** | **4,957 ms** |

**5.3x**, consistent with the 4.7–6.5x `ParallelGleamFrontend` reaches under Deno. Roughly 4 s of
the remaining 4.9 s is one-time startup — fifteen workers each instantiating their own baba parser
before the first module completes — so the marginal cost after warmup is far lower than the total
suggests.

## 2026-07-27 — baba 7.3.0 adds a GPU _frontend_, which our grammars do not qualify for

One breaking change and one genuinely new capability.

**The break is a rename.** `./runtime/webgpu-lexer` became `./runtime/webgpu`; three files and the
import map, no logic. Everything else compiles unchanged — `generated_wasm.ts`'s exports are
identical to 7.2.0's — and 348 tests pass with every `bench` counter unchanged.

**Smaller DFAs.** The grammar compiler emits fewer states: gleam 183 → **171**, lazuli 82 → **77**,
javascript-aot 238 → **201**, a 6–16% reduction. All three still fit the GPU lexer. It does not show
up in parse time: 1,343 ms parse-only on the 256-module corpus against 1,437 / 1,287 recorded for
7.2.0 / 7.1.0, which is inside the band those two already spanned.

### The new capability is a frontend, not a lexer — and it is gated

`WebGpuFrontend` runs "lexing, structural matching, island recognition, and flat IR allocation in
one submission", with `ingestResident()` leaving the syntax IR on the device. That is materially
more than the lexer, and the residency is the argument this repository kept saying was the
compelling one: IR that never crosses back to the host could feed the GPU pipeline directly. A
`CpuFrontend` ships alongside it.

**We cannot use it.** It requires an opt-in version-3 GPU frontend section in the plan, and
`inspectGpuFrontendPlan` returns `null` for all three of our regenerated plans. There is no CLI flag
to request one — the full flag list has nothing for gpu, frontend or islands — so the section is
emitted only when the grammar qualifies. Its own documentation says the frontend "requires
compiler-proven, locally locatable islands", which is a property of the grammar rather than
something a consumer selects.

So the interesting half of 7.3.0 is unreachable from here without a grammar change, and what that
change would be is not documented in the package. Worth asking upstream before assuming Gleam's
grammar could ever qualify.

**It would still be bounded by the 1% finding, but less tightly.** A GPU _lexer_ caps the frontend
win at 1.01x because lexing is 1% of it. A GPU _frontend_ that also does structural matching and
flat IR allocation would overlap baba's tree building, which is a further 21% — and if its flat IR
could be lowered from directly, the intermediate Gleam AST at 57% comes into range too. That is the
first version of this idea with a plausible path past 1.01x, and it is unmeasured because we cannot
run it.

## 2026-07-29 — same-process comparison and CPU compilation correct the headline again

The old batch comparison was not symmetric: gpufuck compiled every module in one resident process,
while Gleam paid process and package startup once per module. The replacement benchmark gives both
compilers all inputs in one resident process and includes executable output. This supersedes the 17x
batch win and every extrapolation based on Gleam's per-package floor.

`deno task bench:gleam-batch`, Gleam 1.17.0:

| Modules | Gleam JS | CPU Core | Shared Wasm | CPU total | GPU Core | Separate Wasm | GPU total | CPU/Gleam |
| ------: | -------: | -------: | ----------: | --------: | -------: | ------------: | --------: | --------: |
|       1 |   2.8 ms |   0.7 ms |     10.5 ms |   43.6 ms |  13.6 ms |        2.2 ms |   48.1 ms |    15.60x |
|      32 |  13.2 ms |   9.6 ms |     34.6 ms |   53.1 ms |  21.1 ms |       25.8 ms |   55.9 ms |     4.02x |
|     128 |  44.7 ms |  28.0 ms |     87.1 ms |  193.3 ms |  39.5 ms |       55.0 ms |  172.6 ms |     4.33x |
|     512 | 179.2 ms | 168.8 ms |    388.1 ms |  653.8 ms | 119.5 ms |      290.6 ms |  507.0 ms |     3.65x |
|   1,024 | 358.6 ms | 210.0 ms |    493.2 ms |  869.2 ms | 255.5 ms |      524.4 ms |  945.9 ms |     2.42x |

There is **no compiler break-even through 1,024 modules**. The ratio is still improving at the
largest point, but extrapolating a crossing would be dishonest because frontend, Core, and Wasm
curves have different shapes.

The shared-runtime artifact does have two measured wins. Its emission time crosses the
separate-artifact path between 512 and 1,024 modules in this run. At 1,024 entries it is 2,079.0 KiB
against 3,141.0 KiB separately, a **33.8% size reduction**. At 128 and 512 entries its whole-program
analyses cost more than compiling isolated artifacts, so sharing is not a blanket compile-time win.

### The cold single-program result is 11.4x, not 3.2x

The stdlib benchmark had another cache bias. Fresh compiled-module objects still shared a global
resolved-Core fingerprint cache, so samples two through nine measured a Wasm cache hit. It now calls
raw code generation for every sample and gives Gleam the same generated entry module that gpufuck
needs to keep the whole library reachable.

`deno task bench:gleam-stdlib <checkout>`, medians of nine:

| Phase                         |         Time |
| ----------------------------- | -----------: |
| Parse and lower               |     126.1 ms |
| CPU resolve and infer         |     199.0 ms |
| GPU resolve and infer         |     396.0 ms |
| Uncached Wasm emission        |     193.1 ms |
| **CPU end to end**            | **518.2 ms** |
| GPU end to end                |     715.2 ms |
| **Gleam build to JavaScript** |  **45.5 ms** |

The default CPU route is therefore **11.39x slower** than Gleam; the GPU route is 15.72x slower.
This comparison is stricter than the old one in both directions: gpufuck emits Wasm in memory while
Gleam emits JavaScript to disk, and both compile exactly the accepted nineteen stdlib modules plus
the generated root.

### What the five changes bought

- `CpuCompiler` produces the same resolved Core and diagnostics without WebGPU. The default
  `FunctionalCompilerService` selects it for HM modules and lazily retains one GPU compiler for
  higher-rank modules.
- Closed type schemes cache their free-parameter sets during one inference run. On this corpus the
  inference-only host oracle is 124.4 ms; the previously recorded host median was 380.8 ms, a 3.1x
  reduction in that phase.
- `compileModulesToWasm` emits independent named entries in one linear-memory artifact and shares
  the runtime. Constructors, case metadata, binders, literals, definitions, and source spans are
  relocated when modules are packed.
- The benchmark now exposes the actual break-even question instead of substituting process startup.

WasmGC remains available for single modules. Its existing emitter only permits one callable entry,
so the multi-entry artifact currently uses the linear-memory backend; requesting a multi-entry
WasmGC artifact fails explicitly instead of silently dropping exports.

## 2026-07-29 — the CPU, cache, and binary pass closes half the cold gap

The follow-up used the same stdlib checkout, generated entry, nine-sample phase medians, and Gleam
1.17.0. Three complete benchmark processes were run because garbage collection moves the summed
phase result by tens of milliseconds. The table reports the median of those three medians:

| Phase                            |      gpufuck |       Gleam |
| -------------------------------- | -----------: | ----------: |
| Parse                            |      84.5 ms |           — |
| Parse and lower                  |     118.5 ms |           — |
| Raw host HM inference            |      14.0 ms |           — |
| CPU resolve, infer, and effects  |      43.6 ms |           — |
| Uncached Wasm emission           |     107.7 ms |           — |
| **Cold complete**                | **276.2 ms** | **48.0 ms** |
| **Unchanged complete**           | **0.075 ms** | **10.7 ms** |
| **Source-only single-file edit** |  **71.1 ms** | **11.7 ms** |

Cold compilation is now **5.75× Gleam**, down from 11.39×. An exact unchanged project is a cache
lookup and is about 143× faster than Gleam's no-change build. That number does not describe an
edited project: appending a comment to one source still costs about 6× Gleam because linking and
semantic compilation remain whole-project operations.

The changes and the measured reasons for them:

- `InferenceContext` shares closed global schemes and copies only lexical bindings. This removes the
  `new Map(globalEnvironment)` operation per SCC; raw inference fell from 102.4 ms to 14.0 ms.
  Ordinary inference variables also use path compression.
- Pure modules bypass lambda-set effect analysis. Effect sets created by this package retain their
  immutable identity, empty sets are shared, and the effectful path consumes lambda-set members
  without allocating a public set for every application.
- Wasm reachability uses persistent constant environments instead of copying one array per lexical
  edge. The binary encoder sizes vectors and sections once before filling them.
- `GleamFrontendService` caches parsed and lowered modules. `FunctionalCompilerService` caches
  successful CPU compilation by immutable encoded-module identity. Wasm already caches by resolved
  Core, and source-only locations no longer invalidate instruction-identical bytes.
- Gleam lowering transfers ownership of fresh artifacts to the linker, retaining validation and
  freezing while avoiding a redundant `structuredClone`.

The same-process batch benchmark was also repeated three times. At 1,024 entries the median run was
383.1 ms for Gleam and 643.6 ms for gpufuck CPU plus a shared Wasm artifact: **1.82× slower**, down
from 2.42×. The 2,079.0 KiB shared artifact remains 33.8% smaller than 3,141.0 KiB of separate
artifacts. There is still no measured cold break-even.

The remaining cold floor is no longer inference: frontend work is about 43% of the total and Wasm
emission about 39%. The parser-to-Gleam-AST-to-Surface path still builds two trees, while an edited
project still recompiles one linked Core and one monolithic Wasm body set. Those are architectural
changes, not another map or allocation fix.

## 2026-07-30 — fused workers produce the first honest batch break-even

The earlier batch path crossed worker boundaries twice: frontend workers returned packed Surface,
then semantic workers copied that Surface and returned compiled Core before Wasm emission. The
copies erased most of the semantic parallelism. `ParallelGleamCompiler` instead sends source once,
keeps parsing, lowering, host semantic compilation, and Wasm emission in one resident worker, and
returns only the final bytes. Results retain input order and one failing unit does not discard its
neighbours.

`deno task bench:gleam-batch` was run in three fresh processes. Gleam still receives all sources in
one package and resident process. Each gpufuck batch uses distinct executable literals so the
resolved-Core cache cannot turn later sizes into warm Wasm measurements. Medians of the three
process results:

| Modules | Gleam JS | Fused source-to-Wasm | Fused/Gleam |
| ------: | -------: | -------------------: | ----------: |
|       1 |   2.8 ms |               2.7 ms |       0.96× |
|      32 |  12.8 ms |              23.4 ms |       1.83× |
|     128 |  48.3 ms |              75.5 ms |       1.56× |
|     512 | 185.4 ms |             190.8 ms |       1.03× |
|   1,024 | 407.0 ms |             264.6 ms |   **0.65×** |

The useful break-even is therefore between 512 and 1,024 independent modules. At 1,024 gpufuck is
1.54× faster than Gleam. The one-module row is not a replacement for the standard-library latency
benchmark: this synthetic entry is small enough for compact-scalar Wasm and says nothing about one
large linked project.

There are two different output contracts:

- Fused workers emit one self-contained artifact per entry. They parallelise Wasm body generation
  but repeat the runtime, totalling about 3.07 MiB at 1,024 modules.
- `compileBatchToSharedWasm` compiles independent Core concurrently and then assembles exports in
  input order into one artifact. It emits about 2.03 MiB, 33.8% less, but the existing shared
  emitter performs whole-bundle analysis and body generation serially. Its median complete path is
  still about 1.7× slower than Gleam.

Returning compiled Core to the caller was not itself a throughput win. On the synthetic compiler
benchmark, worker semantic compilation at 1,024 modules was roughly tied with the serial host
because structured-cloning Core consumed the saved compute. Keeping Core resident and returning only
Wasm produced a 2.1–2.7× pipeline speedup. That boundary, rather than worker count alone, is what
created the crossover.

Linked projects retain whole-project inference because unannotated public functions can be inferred
across imports. `ParallelGleamProjectFrontend` safely parallelises parse, signature extraction, and
lowering, then links in source order. The measured 1,024-module synthetic chain improved only
1.1–1.3×; making semantic SCCs independently compilable requires typed module interfaces and
relocatable compiled imports. Running current whole-project inference once per SCC would duplicate
work and change diagnostics, so it was not presented as parallelism.

## 2026-07-30 — discarded-work audit

The pipeline was measured for work whose result was immediately discarded. Four repeated costs were
removed: unreachable definitions were rewritten before pruning, every strict module attempted
compact Wasm before falling back, source-only wrappers re-hashed unchanged semantics, and worker
boundaries cloned object-shaped Core plus owned Wasm bytes.

`deno task bench:parallel 4` was run in three fresh processes before and after the change, from the
same `fa34632` base. Medians at 1,024 modules:

| Path                     |   Before |    After | Change |
| ------------------------ | -------: | -------: | -----: |
| Parallel Core            |  91.7 ms |  79.5 ms |   -13% |
| Separate serial Wasm     | 289.4 ms | 209.1 ms |   -28% |
| Separate parallel Wasm   | 175.7 ms | 119.5 ms |   -32% |
| Fused source-to-Wasm     | 176.2 ms | 148.5 ms |   -16% |
| Shared-artifact emission | 245.5 ms | 191.4 ms |   -22% |

The fair Gleam batch benchmark was then repeated in three fresh processes. At 1,024 entries, the
median fused path is 202.2 ms against Gleam's 361.6 ms, or **1.79× faster**. The complete
CPU-plus-shared-artifact path is 534.0 ms, or **1.48× slower**, because shared body generation
remains serial.

On the 261.5 KiB standard-library corpus, medians across three fresh benchmark processes are:

| Phase                           |      gpufuck |       Gleam |
| ------------------------------- | -----------: | ----------: |
| Parse and lower                 |     107.3 ms |           — |
| CPU resolve, infer, and effects |      38.6 ms |           — |
| Uncached Wasm emission          |      89.1 ms |           — |
| **Cold complete**               | **236.6 ms** | **42.2 ms** |
| **Unchanged complete**          | **0.068 ms** | **10.4 ms** |
| **Source-only comment edit**    |  **14.4 ms** | **11.6 ms** |

The source-only path was 71.1 ms before this audit and is now within 24% of Gleam. The residual is
the linker: the frontend can reuse parsing and module lowering, and the semantic and Wasm layers
reuse stable fingerprints, but changing a source range still rebuilds one packed linked module.
Eliminating that last cost requires relocatable linked fragments with explicit source provenance;
blindly rebasing packed byte offsets would make spans at module boundaries ambiguous.

## Kill criteria

The retarget is judged on the **GPU inference share**, not total wall time:

- Below **10.2 µs/module** it beats the single-threaded CPU it replaces.
- The honest bar is a multi-threaded host: `inferTypes` across 8 workers is ~1.3 µs/module.
- If node-parallel validation and constraint generation cannot bring 99.7 µs under ~30 µs, the
  remaining phases — unification and generalization — will not close the gap either, since they are
  strictly harder to parallelize. Retreat to module-level throughput at that point.
