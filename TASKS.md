# Tasks

Ranked future work. Every item carries the measurement that justifies it, because several plausible
items on this list turned out to be worth nothing once measured, and two that looked like defects
were reverted after the fix made things slower.

The rule this list is written under: **do not start an item without re-measuring its premise.** The
numbers below were taken on one machine (Ryzen 7 7800X3D, RTX 4080 SUPER, Deno 2.9.2) and some of
them are already the second or third version of a number that was wrong the first time. See
[BASELINE.md](BASELINE.md) for how each was taken.

For the shapes that break the compiler outright rather than merely slow it down — the ABI node cap,
the recursion forms that lose tail position, the measurement traps that produced wrong numbers — see
[CHALLENGES.md](CHALLENGES.md). Items here are things to build; entries there are things to know
before building them.

## Closed on 2026-07-26

Numbers stay stable so prose elsewhere still resolves; the measurements live in
[BASELINE.md](BASELINE.md).

- **0. Tail calls lost inside `let`-bound lambdas.** A live correctness bug — guarded Gleam
  overflowed the stack at 100,000 iterations because `#containsTailCall` stopped at `Lambda`. Fixed
  by contifying join points: a `let`-bound lambda that is only ever tail-called becomes a wasm
  `block` label, not a closure. Note that fixing codegen alone did nothing; the analysis has to
  descend into the join body too, or the function is never registered as a loop at all.
- **1. Multi-subject `case` with or-patterns exploded.** Body duplication — `lowerPattern` handed
  the whole rest of the match to every non-matching constructor arm, `(4^2n - 1)/3` copies per arm.
  One join point per pattern sequence makes it linear: 19,134 nodes to 163 at three arms, and four
  arms compiles instead of exceeding the ABI cap. **The Gleam stdlib corpus fell from 49,964 nodes
  to 17,718** — 64.5% was duplicated arm bodies. `deno task
  measure:or-patterns`.
- **6. Transition count scaled as n^1.68.** Eight visitors walked variable link chains one charged
  transition per hop and never wrote back. Path halving plus the smaller corpus took 6,112,586
  transitions to 405,343, and per-node cost is now flat at 22.9 against 23.5 on a program 44x
  smaller. The profile that remains has no bucket above 18.5%.

## Now

### 14. The frontend is the bottleneck: 62% parsing, 33% lowering

**Re-measured 2026-07-26 and it has inverted.** On a 256-module corpus of realistic Gleam — 1.46 MB,
300,544 surface nodes — the GPU resolves and infers everything in **87.9 ms**, 0.29 µs per node,
while the frontend takes **1,911 ms**. The frontend is **96%** of the compile and the GPU is 3.9%.

Split further, because the first version of this item blamed the parser for all of it and was wrong
by a third: **parse 1,237 ms at 1.16 MB/s, lower 674 ms.** Lowering — host-side tree walking that
builds the packed surface arrays — is a third of the frontend and appears nowhere else on this list.

That makes this the largest lever by a wide margin, ahead of the kernel. baba runs at roughly 1.4
MB/s where tree-sitter does 10–30 MB/s. The oldest section of BASELINE predicted exactly this and
was then buried for a day, because on the pre-fix Gleam standard library the GPU phase was 96% of
the compile and the parser looked irrelevant.

Two directions, unmeasured:

- **Make baba faster.** 1.16 MB/s against tree-sitter's 10–30 MB/s is a 10–25x implementation gap on
  the CPU, not an algorithmic wall. Separate project, so the work is outside this repo; 10x takes
  parsing to ~124 ms.
- **Look at lowering at all.** 578 ms on the 256-module corpus, 31% of the frontend, never profiled.
  It is now a tracked timing in `deno task bench` so it cannot drift unwatched, but nobody has
  looked at where it goes. With the parallel frontend in place the whole frontend is 335 ms, so this
  is ~100 ms of a 465 ms compile — no longer the crisis it looked like, and the reason to profile it
  is that it is unexamined rather than that it is large.
- **Parse in parallel on the host.** `ParallelGleamFrontend` already exists and measured 4.2x on 16
  cores, but it is not on the path any benchmark or the playground uses. That is the cheap half.

It also reframes item 7. A free GPU inference phase now saves 87.9 ms of a 2,240 ms corpus compile;
the 12x it needs is real for single-module latency and close to irrelevant for throughput.

### 7. Parallelise the inference kernel — node-level, inside one dispatch

`type_inference_shader.ts` is `@compute @workgroup_size(1)` — one lane of roughly ten thousand, now
running 405,343 transitions. **This is the only lever left**, and the bar is exact: parse and lower
are 119.4 ms and already beat `gleam build`'s entire 146 ms, so a free GPU phase wins outright and
GPU inference has to fall from 322.7 ms to **under 26.6 ms — 12x.**

Everything cheaper has been measured and ruled out:

| Lever                         | Result                                 |
| ----------------------------- | -------------------------------------- |
| Transition count              | linear; flat profile, no bucket >18.5% |
| Warp shape (`workgroup_size`) | flat across 1 / 8 / 32 / 64            |
| Dispatch count                | 2 per compile, 7% of the time          |
| Generation as a parallel map  | capped at 1.45x by its share           |
| Definition-level waves        | 3.38x, reaches 215 ms and still loses  |

So it has to be **node-level**, and it has to fit in one dispatch. What is established:

- **Node-level width is real and grows with program size.** Depth 87 on the pre-fix stdlib, mean
  width 579, widest level 22,101. Across five programs 74–99% of nodes sit in levels wider than a
  warp, and width grows ~14x for 70x the nodes. Worth re-measuring on the deduplicated corpus.
- **Unification can be parallel.** The capability spike in ARCHITECTURE §9 verified that
  `atomicCompareExchangeWeak` union-find converges under contention. That is the hard primitive and
  it is not speculative — and it is the 49.3%, not the 31.0%.
- **Divergence is bucketable.** Every Core node carries a tag; grouping by tag before dispatch gives
  each warp one node kind instead of eleven.

**One constraint dominates the design.** A GPU round trip in Deno costs 11.3 ms even when the shader
does nothing. One dispatch per dependency wave would spend 21 × 11.3 = 237 ms on the Gleam stdlib
before computing anything — worse than `gleam build` entirely. So the whole wavefront has to live
inside a single dispatch, as a persistent kernel with in-kernel synchronisation, or the work has to
move off Deno. Anything that dispatches per wave is dead on arrival regardless of kernel quality.

Three entanglements found by reading the kernel would have to be undone, and none of them is about
the type system:

- **Generation is not bottom-up.** Expected types propagate downward through frame word 11, and
  `Apply` stage 41 branches on the _pruned_ callee's kind. Which constraint to emit depends on
  having solved earlier ones.
- **Allocation order is load-bearing.** `Apply` records `state.type_top` watermarks and hands them
  to unify to elide the occurs check, encoding sequential allocation order as a semantic invariant.
- **There is backtracking inside "generation."** The rigid-refinement trail is a mutable undo log
  with rollback checkpoints taken at case-arm entry.

### 2. Submodule splitting is 3.38x, and that is not enough

Re-measured after item 1. The recorded 1.9x was real but was taken when `list::sequences` was 52% of
the corpus and 97% of its critical path — and that definition was mostly duplicated arm bodies. On
the real 17,718-node program:

| Measure                 |     Value |
| ----------------------- | --------: |
| Definitions             |     1,039 |
| SCC components          |     1,035 |
| Waves                   |        21 |
| Critical path           |     5,242 |
| Available parallelism   | **3.38x** |
| Widest wave             |       248 |
| Largest component       |         3 |
| Critical path as % work |     29.6% |

Reproduce with `deno task profile:frames --gleam <checkout>`. Mutual recursion is not the obstacle —
the largest SCC is 3 definitions — and `definition_wavefront.ts` already computes the schedule while
being used by nothing in the compiler.

**But 3.38x does not win.** GPU inference is 322.7 ms of a 442.1 ms compile and needs to reach 26.6
ms to beat `gleam build`; 3.38x takes it to ~95 ms for a 215 ms total. It would also need all 21
waves encoded into a single command buffer, because 21 round trips is 237 ms on its own. So this is
the wrong granularity for the goal, and item 7's node-level width is where the parallelism actually
is.

What it would still be good for is throughput rather than latency: routing one large module through
the batch path that already beats `gleam build` by 17x. That remains untested.

**Build the consumer before the supply.** Restructuring a _language_ to be splittable is tempting
and measurably works on the graph — the same 40-term Lazuli program goes from 1.0x to 13.3x
available parallelism by bounding definition size and adding a balanced reduction tree. But compile
time across those three shapes is 13.0, 13.3, and 14.0 ms: the tree is _slower_, because nothing
consumes the structure and more definitions is more work for the single lane.

An untested lever worth knowing before designing a language for this: wave sequencing exists only
because inference must flow a type from a definition to its users. Mandatory or cached top-level
annotations cut that edge, so every definition could be checked in one flat batch with no waves at
all. That is the trade Go and Zig make, Lazuli already has the annotation syntax, and the current
wavefront analysis would not credit it because it derives dependencies from references rather than
from types.

### 3. Add n-ary lambda and application to Core

Every extra function parameter costs **+5 surface nodes and +90 inference transitions**, exactly
linearly, because Core has only unary lambdas and an n-parameter function becomes n nested ones. A
five-parameter function costs 3.7x the inference of a one-parameter function.

This is an ABI property, not a frontend one — Gleam, Lazuli, and Ducklang all pay it, and no amount
of frontend design avoids it. An n-ary lambda and application node would remove it for all three. It
is an ABI version bump, so it wants doing deliberately rather than opportunistically.

Measured cost per use of the other constructs, for whoever designs a language against this pipeline:
`let` 23 transitions, arithmetic 29, polymorphic instantiation 48, `if` 51, top-level definition 63,
annotated function 123, unannotated 135, constructor plus `case` 166. Pattern matching is the most
expensive thing in the language, which is consistent with item 1.

Two things measured that contradict the obvious guess, both in BASELINE.md: annotations buy about
9%, not a step change; and one shared polymorphic function is 2.8x cheaper than thirty monomorphic
ones doing the same work, so polymorphism pays for itself.

Worth keeping in proportion: language-level choices look worth 2–4x on inference, where
parallelising the single-lane kernel (item 7) is worth 10–50x. Design the language for it, but do
not expect the language to be the win.

[DESIGN.md](DESIGN.md) argues the other end of that: what a language would look like if compiling it
were a parallel sweep rather than a solve. It is now built — Sweep, in `src/sweep/` — and measured:
against Lazuli on equivalent programs the node counts are _identical_ and the transition counts
within noise. Every rule needs a backend change to pay, prevents a pathology rather than
accelerating the common case, or does not touch this pipeline. Item 3 and a checking-only kernel are
what would make it pay; the frontend is ready and waiting for them.

### 4. WebAssembly emission is 63% of batch cost — premise needs re-measuring

**Re-measure before starting.** That 63% was taken before the pattern-lowering fix cut the Gleam
stdlib's node count by 2.8x and its emitted Wasm from 1,745 KB to 999 KB. On the single-module path
emission is now 7.5 ms of 442.1 ms. The batch corpus is synthetic Lazuli with no or-patterns, so its
split may be unchanged — but nobody has looked.

At batch 1,024 the split was 22% frontend, 15% GPU, **63% Wasm emission** (442 µs/module). It is
also mostly _fixed_ per module: `40 + 2` is 8 Core nodes and still emits a 1,244-byte code section,
because every module carries its own allocator, free list, and thunk-forcing runtime. The code
section is 91–98% of every artifact.

Two shapes of fix, and they are independent:

**4a. Stop inlining through the entry's direct call during the speculative compact-scalar attempt.**
This is the only remaining variant of an idea whose other two variants were tried and failed. The
compact path is attempted for 100% of Gleam modules and succeeds for 0%, costing ~105 µs each; the
ceiling is 347–357 ms against a 419 ms baseline, so roughly **16% of emission**. Bailing at the
boundary does not work — the entry is a direct call, so emission inlines the whole program before
reaching a memory instruction, and adding the check made it slower. The abort has to happen inside
the expression compiler. Full diagnosis in BASELINE.md.

**4b. Emit function bodies on the GPU.** The Core is already in GPU buffers, readback measures 1 µs,
emission is a local per-node mapping, and bodies are independent across functions _and_ across
modules in a batch. LEB128's data-dependent offsets are the only real obstacle: size pass, prefix
sum, write pass — the canonical GPU pattern. This is the most GPU-appropriate phase in the pipeline,
and the architecture currently has it backwards, with the hardest-to-parallelise phase (inference,
pointer-chasing and divergent) on the GPU and the easiest on the CPU.

Do 4a first: it is contained, and 4b is a large project that should start from a profile taken after
4a lands.

### 5. Frontend parallelism has more to give

`ParallelGleamFrontend` got 4.2× on 16 cores, taking parse+lower from 649 ms to 156 ms at batch
1,024. The theoretical ceiling is ~15×. The gap is worker message copying and per-worker JIT warmup,
not contention — worth confirming with a profile before assuming which.

Also unaddressed: **baba parses at ~1.4 MB/s**, 58% of parse time, where tree-sitter does 10–30
MB/s. Our cursor-to-AST layer costs another 40% on top. That is a 3–8× opportunity on a phase that
is 22% of batch cost, and it is the hard floor on single-module latency — parse alone is 71 ms of
what would need to be a 73 ms budget to beat Gleam by 2×.

## Next

### 8. The Gleam FFI adapter

957 of the 974 non-passing stdlib tests are blocked on Gleam's JavaScript FFI, not on the compiler.
That is ~207 external functions across three target files (`gleam_stdlib.mjs`, `dict.mjs`). `dict`,
`set`, `string`, `uri`, and `bit_array` are all at zero purely for want of it.

This buys correctness coverage, not speed. It is the single largest lever on "how much real Gleam
actually runs".

## Later

### 9. The CPU inference oracle is O(n^1.30)

`inferTypes` in `src/semantic/type_inference.ts` has three separate Θ(n·|E|) terms: `generalize`
walks every type in the whole environment on every `let`, six sites copy the entire environment to
add one binding, and `globalEnvironment()` is rebuilt per SCC component. There are no Rémy levels,
no path compression in `prune`, and no visited-set memoization in `occurs`/`replaceParameters`.

**This is not on the compile path.** `inferTypes` appears only in `tests/`, `benchmarks/`, and its
own file — it is the differential oracle. Fixing it speeds up the test suite and the benchmark's CPU
column and does nothing for compilation. Worth doing when the suite gets slow, not before.

Note the shader does _not_ share this algorithm: it has Rémy levels, epoch-marked traversal, a
persistent skip-list environment, and lazy instantiation. The two are differentially tested on
results, not asymptotics.

### 10. Nine exports never lost the prefix

The 0.4.0 rename covered `Functional*` but not names _starting_ with lowercase `functional`, because
the enumeration regex anchored on the capital. Still exported from `functional.ts`:

`functionalF32x4`, `functionalHostFieldRepresentationType`, `functionalHostFieldType`,
`functionalResolvedCoreFingerprint`, `functionalStoreType`, `functionalThunkType`,
`functionalWasmArenaDepth`, `functionalWasmArenaInstance`, `functionalWasmInstanceArenaDepth`.

These shipped in 0.4.0, so renaming them is a breaking change and belongs in the next one. The
lesson is worth keeping: the miss was invisible to the compiler and to the tests, and only showed up
when someone enumerated the actual export list at runtime — which is now the way to check.

### 11. Sweep's flat-locals rule is stricter than it needs to be

Rule 5 rejects any repeated binder name in a function, which forbids sibling `match` arms reusing
one — `One(inner) -> ...; Two(inner) -> ...` is a diagnostic even though the arms are disjoint
scopes and only one is ever live. The rule exists so name resolution is a table lookup; sibling arms
do not threaten that, so the check should be per-path rather than per-function.

Found by writing a nested match in `examples/sweep/` and having the compiler reject it, which is the
right way to find it and an argument for the rule being enforced rather than described.

### 12. Frontend API inconsistency

`parseGleamModule` and `lowerGleamSources` throw for some failures and return diagnostics for
others. Surface packing and module linking raise. Every tool driving them in bulk has to wrap both
in `try`/`catch`, and each unguarded throw ends a batch run and reports nothing about the remaining
work. Pick one convention.

### 13. Nullary Gleam entry allocates a Unit for nothing

A zero-argument Gleam function lowers to `Lambda(Unit)`, and a synthetic `$gleam/entry` module then
applies it to a freshly constructed `$Unit`. Worth fixing on cleanliness grounds.

It was investigated as a performance item and is **not** one: every nullary constructor compiles to
`i32Const(offset); i64Load(0)`, so any program mentioning `None`, `Nil`, or an enum tag uses linear
memory regardless of how the entry is built.

## Not planned

**Beating Gleam by 2× on single-module compilation.** The arithmetic rules it out. CPU-side work
alone — parse 71 ms, lower 58 ms, emit 23 ms — is 152 ms, already more than Gleam's entire 146 ms
cold build including JavaScript codegen. An infinitely fast GPU still loses. Stacking every
plausible win lands around 124 ms warm against Gleam's 23 ms warm.

Throughput is the reachable goal and is already met: ~17× faster at batch 1,024.

**A shared Wasm runtime module.** The theory was that re-emitting the allocator per module was the
fixed cost. Measured: the three runtime body builders cost 22 µs of ~540. Not the problem.
