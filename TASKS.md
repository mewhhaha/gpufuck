# Tasks

Ranked future work. Every item carries the measurement that justifies it, because several plausible
items on this list turned out to be worth nothing once measured, and two that looked like defects
were reverted after the fix made things slower.

The rule this list is written under: **do not start an item without re-measuring its premise.** The
numbers below were taken on one machine (Ryzen 7 7800X3D, RTX 4080 SUPER, Deno 2.9.2) and some of
them are already the second or third version of a number that was wrong the first time. See
[BASELINE.md](BASELINE.md) for how each was taken.

## Now

### 1. WebAssembly emission is 63% of batch cost

At batch 1,024 the split is 22% frontend, 15% GPU, **63% Wasm emission** (442 µs/module). It is also
mostly _fixed_ per module: `40 + 2` is 8 Core nodes and still emits a 1,244-byte code section,
because every module carries its own allocator, free list, and thunk-forcing runtime. The code
section is 91–98% of every artifact.

Two shapes of fix, and they are independent:

**1a. Stop inlining through the entry's direct call during the speculative compact-scalar attempt.**
This is the only remaining variant of an idea whose other two variants were tried and failed. The
compact path is attempted for 100% of Gleam modules and succeeds for 0%, costing ~105 µs each; the
ceiling is 347–357 ms against a 419 ms baseline, so roughly **16% of emission**. Bailing at the
boundary does not work — the entry is a direct call, so emission inlines the whole program before
reaching a memory instruction, and adding the check made it slower. The abort has to happen inside
the expression compiler. Full diagnosis in BASELINE.md.

**1b. Emit function bodies on the GPU.** The Core is already in GPU buffers, readback measures 1 µs,
emission is a local per-node mapping, and bodies are independent across functions _and_ across
modules in a batch. LEB128's data-dependent offsets are the only real obstacle: size pass, prefix
sum, write pass — the canonical GPU pattern. This is the most GPU-appropriate phase in the pipeline,
and the architecture currently has it backwards, with the hardest-to-parallelise phase (inference,
pointer-chasing and divergent) on the GPU and the easiest on the CPU.

Do 1a first: it is contained, and 1b is a large project that should start from a profile taken after
1a lands.

### 2. Frontend parallelism has more to give

`ParallelGleamFrontend` got 4.2× on 16 cores, taking parse+lower from 649 ms to 156 ms at batch
1,024. The theoretical ceiling is ~15×. The gap is worker message copying and per-worker JIT warmup,
not contention — worth confirming with a profile before assuming which.

Also unaddressed: **baba parses at ~1.4 MB/s**, 58% of parse time, where tree-sitter does 10–30
MB/s. Our cursor-to-AST layer costs another 40% on top. That is a 3–8× opportunity on a phase that
is 22% of batch cost, and it is the hard floor on single-module latency — parse alone is 71 ms of
what would need to be a 73 ms budget to beat Gleam by 2×.

## Next

### 3. GPU inference transition count scales as n^1.68

6.1M transitions for 49,964 nodes, 122 per node. At the small-module rate the corpus would need 1.14
million — a **5.4× excess**, worth ~2,800 ms of a 3,469 ms inference phase. Per-transition cost is
_not_ the problem and actually improves with scale (1,205 → 568 ns), so this is algorithmic.

Work per node jumps sevenfold between 4,417 and 33,864 nodes, which suggests a threshold rather than
a smooth drift. Isolate that threshold first; it is the cheapest lead on the largest number.

This only bites single-module latency. Batching routes around it, which is why it sits below the
batch items.

### 4. Parallelise the inference kernel

`type_inference_shader.ts` is `@compute @workgroup_size(1)` — one lane of roughly ten thousand. This
is the retarget's original premise and still the largest theoretical win (10–50× on the GPU phase),
but it is also the hardest: inference is pointer-chasing and branch-divergent, the worst shape for a
GPU. Do (3) first — reducing the work is worth more than parallelising work that should not exist,
and the two multiply.

### 5. The Gleam FFI adapter

957 of the 974 non-passing stdlib tests are blocked on Gleam's JavaScript FFI, not on the compiler.
That is ~207 external functions across three target files (`gleam_stdlib.mjs`, `dict.mjs`). `dict`,
`set`, `string`, `uri`, and `bit_array` are all at zero purely for want of it.

This buys correctness coverage, not speed. It is the single largest lever on "how much real Gleam
actually runs".

## Later

### 6. The CPU inference oracle is O(n^1.30)

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

### 7. Nine exports never lost the prefix

The 0.4.0 rename covered `Functional*` but not names _starting_ with lowercase `functional`, because
the enumeration regex anchored on the capital. Still exported from `functional.ts`:

`functionalF32x4`, `functionalHostFieldRepresentationType`, `functionalHostFieldType`,
`functionalResolvedCoreFingerprint`, `functionalStoreType`, `functionalThunkType`,
`functionalWasmArenaDepth`, `functionalWasmArenaInstance`, `functionalWasmInstanceArenaDepth`.

These shipped in 0.4.0, so renaming them is a breaking change and belongs in the next one. The
lesson is worth keeping: the miss was invisible to the compiler and to the tests, and only showed up
when someone enumerated the actual export list at runtime — which is now the way to check.

### 8. Frontend API inconsistency

`parseGleamModule` and `lowerGleamSources` throw for some failures and return diagnostics for
others. Surface packing and module linking raise. Every tool driving them in bulk has to wrap both
in `try`/`catch`, and each unguarded throw ends a batch run and reports nothing about the remaining
work. Pick one convention.

### 9. Nullary Gleam entry allocates a Unit for nothing

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
