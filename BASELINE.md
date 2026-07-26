# Baseline

**This file is the measurement record: what was measured, how, and what turned out to be false.** It
is deliberately append-only in spirit — superseded numbers stay, with the correction next to them,
because several of them were wrong the first time and knowing that is the point.

For what to _do_ about these numbers, ranked, see [TASKS.md](TASKS.md). This file does not plan.

Every performance claim in the repository is judged against this file. Reproduce the oldest section
with `deno task bench:throughput`; later sections name their own task.

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

> **Superseded 2026-07-26.** Path halving took the GPU phase from 3,806 ms to 1,019.6 ms and the
> comparable figure from 25x to **8.0x**. Everything below is the measurement as taken; see "path
> halving" near the end of this file for what replaced it.

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

## Kill criteria

The retarget is judged on the **GPU inference share**, not total wall time:

- Below **10.2 µs/module** it beats the single-threaded CPU it replaces.
- The honest bar is a multi-threaded host: `inferTypes` across 8 workers is ~1.3 µs/module.
- If node-parallel validation and constraint generation cannot bring 99.7 µs under ~30 µs, the
  remaining phases — unification and generalization — will not close the gap either, since they are
  strictly harder to parallelize. Retreat to module-level throughput at that point.
