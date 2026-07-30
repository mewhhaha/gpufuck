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

### 14. Fuse the parser cursor into Surface lowering

**Re-measured 2026-07-29 after CPU and Wasm work.** On the stdlib corpus the frontend takes 118.5 ms
of a 276.2 ms cold compile. The existing cursor-to-AST and AST-to-Surface walks remain the largest
single cold phase. On the earlier 256-module corpus of realistic Gleam — 1.46 MB, 300,544 surface
nodes — the GPU resolves and infers everything in **87.9 ms**, 0.29 µs per node, while the serial
frontend takes **1,865 ms**. The frontend is 96% of the compile and the GPU is 3.9%.

Split three ways, because the first two versions of this item were both wrong — the first blamed the
parser for lowering, the second blamed baba for our AST construction:

| Phase                          |   Time |      Rate | Share |
| ------------------------------ | -----: | --------: | ----: |
| baba parse                     | 758 ms | 1.89 MB/s |   41% |
| Our Gleam AST construction     | 477 ms |         — |   26% |
| Our lowering to packed surface | 578 ms |         — |   31% |

**57% of the frontend is our code.** The oldest section of BASELINE predicted the frontend would
matter and was then buried for a day, because on the pre-fix Gleam standard library the GPU phase
was 96% of the compile and the frontend looked irrelevant.

Ranked, with the one that is done first:

- ~~**Parse in parallel on the host.**~~ **Done, and it was the cheapest win in the project.**
  `ParallelGleamFrontend` had been written, tested, measured at 4.2× and left on no path. Wired into
  `bench:gleam-corpus` and `bench` it is **4.7–6.5×** on 16 cores, taking the corpus from 2,314 ms
  to **465 ms** and from 1.22× to **6.05×** against `gleam build`. Node counts are asserted equal
  across both paths. Still unavailable to the playground, which needs browser workers, and to any
  public entry point — a consumer has to reach for it deliberately.
- **Fuse the Gleam AST away.** `parseGleamModule` walks baba's cursor into a `GleamModule` and
  `lowerGleamSource` then walks that into the packed surface — two full tree walks over the same
  program, 1,055 ms combined, 57% of the frontend. Lowering straight from the cursor removes one.
  **The largest remaining item and entirely ours.** Risk: the AST may be load-bearing for
  diagnostics and for the `use` desugaring, so it may not be a clean fusion. Measure whether it can
  be bypassed before committing.
- **Make baba faster.** 1.89 MB/s against tree-sitter's 10–30 MB/s is an implementation gap rather
  than an algorithmic wall, but it is 41% of the frontend and a separate project (`@mewhhaha/baba`).
  Worth asking for; not worth waiting for. A GPU lexer is the speculative version — see
  [CHALLENGES.md](CHALLENGES.md) for why its throughput case is weak and its residency case is not.
- **Profile lowering.** 578 ms serial, 31% of the frontend, never examined. Now a tracked timing in
  `deno task bench` so it cannot drift unwatched. With the pool in place it is ~120 ms of a 465 ms
  compile, so the reason to look is that it is unexamined rather than that it is large.

It also reframes item 7. A free GPU inference phase saves 88 ms of a **465 ms** corpus compile with
the pool in place, so the 12× the kernel needs is real for single-module latency and close to
irrelevant for throughput.

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

### 4. ~~WebAssembly emission is 38% of cold stdlib compilation~~ — direct globals done

The strict-global experiment landed. A shared Core index proves when every use of a strict top-level
function supplies its full arity; those definitions no longer receive a global closure or
initializer store. References to globals already known to be in weak-head normal form load the value
directly instead of inlining the thunk-force path. Lazy and non-WHNF globals retain their existing
memoizing thunk and blackhole behavior.

Against `c0935a5`, three fresh stdlib benchmark processes put median Wasm emission at 87.1 ms
instead of 127.8 ms, a 31.8% reduction. The complete cold path fell from 281.4 ms to 239.4 ms. The
artifact fell from 999.2 KiB to 780.9 KiB: 141 definitions are direct-only, indirect functions fell
from 1,854 to 1,522, and instruction bytes from 950,202 to 735,506. All 438 genuinely lazy global
thunks remain.

The force state machine is now also shared across dynamic evaluation boundaries instead of copied
into every caller. On the stdlib corpus this reduced median Wasm emission from 87.1 ms to 78.7 ms
and the artifact from 780.9 KiB to 544.1 KiB. Strict and lazy numeric loops remained within 2%; a
force-heavy program improved 19.4%. The next backend target is the remaining global initialization
and storage work, not more copies of the force path.

Structural lowering still expands 13,702 Core nodes to 17,719: 1,572 applications, 476 lambdas, 812
case arms, and 1,157 pattern binders. Removing those backend-only nodes now has a measured
4,017-node target, but it requires teaching every Wasm analysis to consume packed exact-arity
applications and case metadata. It is a separate change from code-volume reduction.

At batch 1,024 the split was 22% frontend, 15% GPU, **63% Wasm emission** (442 µs/module). It is
also mostly _fixed_ per module: `40 + 2` is 8 Core nodes and still emits a 1,244-byte code section,
because every module carries its own allocator, free list, and thunk-forcing runtime. The code
section is 91–98% of every artifact.

Two shapes of fix, and they are independent:

**4a. ~~Stop abandoned compact-scalar attempts.~~ Done.** A conservative Core preflight now selects
compact emission only when the complete reachable program is supported. Acceptance followed by an
internal compact rejection is an invariant failure, not permission to discard emitted instructions
and retry. At 1,024 modules, serial Wasm emission fell 28%, parallel emission 32%, and
shared-artifact emission 22% against the same `fa34632` base.

**4b. Emit function bodies on the GPU.** The Core is already in GPU buffers, readback measures 1 µs,
emission is a local per-node mapping, and bodies are independent across functions _and_ across
modules in a batch. LEB128's data-dependent offsets are the only real obstacle: size pass, prefix
sum, write pass — the canonical GPU pattern. This is the most GPU-appropriate phase in the pipeline,
and the architecture currently has it backwards, with the hardest-to-parallelise phase (inference,
pointer-chasing and divergent) on the GPU and the easiest on the CPU.

Do 4a first: it is contained, and 4b is a large project that should start from a profile taken after
4a lands.

### 5. Frontend parallelism has more to give

Folded into item 14, which measured it properly and wired it up. The residual question is the only
part still open: `ParallelGleamFrontend` reaches 4.7–6.5× on 16 cores against a theoretical ~15×,
and the gap is believed to be worker message copying plus per-worker JIT warmup rather than
contention. Worth a profile before assuming which, and worth remembering that a `postMessage` of an
`EncodedModule` copies every packed array.

The copy diagnosis is now measured. Standalone frontend workers transfer packed buffers instead of
copying them and use size-balanced batches; compiled Core now crosses its remaining worker boundary
as one packed transferable buffer. `ParallelGleamProjectFrontend` adds project-aware parallel parse,
signature collection, and lowering. More importantly, `ParallelGleamCompiler` removes both
intermediate worker boundaries for independent entries and returns only Wasm. At 1,024 modules it is
1.79× faster than the fair same-process Gleam comparison. The remaining linked-project work is typed
module interfaces plus relocatable Core; without those, semantic SCC workers would either repeat
dependencies or change inference for unannotated exports.

## Next

### 8. The Gleam FFI adapter

957 of the 974 non-passing stdlib tests are blocked on Gleam's JavaScript FFI, not on the compiler.
That is ~207 external functions across three target files (`gleam_stdlib.mjs`, `dict.mjs`). `dict`,
`set`, `string`, `uri`, and `bit_array` are all at zero purely for want of it.

This buys correctness coverage, not speed. It is the single largest lever on "how much real Gleam
actually runs".

## Later

### 9. ~~The CPU inference oracle is O(n^1.30)~~ — done

`CpuCompiler` made this the default HM compile path, so its old priority argument became false.
Global closed schemes now stay in one shared map while lexical environments copy only local
bindings; ordinary inference variables use path compression. Raw stdlib inference fell from 102.4 ms
to 14.0 ms, and the indexed/GADT host-GPU differential corpus remains green.

### 10. ~~Nine exports never lost the prefix~~ — done

All nine renamed: `f32x4`, `hostFieldRepresentationType`, `hostFieldType`,
`resolvedCoreFingerprint`, `storeType`, `thunkType`, `wasmArenaDepth`, `wasmArenaInstance`,
`wasmInstanceArenaDepth`.

`resolvedCoreFingerprint` needed the private helper beside it renamed to `fingerprintResolvedCore`
first — a same-module collision is why that one kept its prefix when the others lost theirs.

Eighteen `functional*` names remain, all module-private, so they are noise rather than API. Left
alone deliberately: renaming them touches far more call sites for no consumer-visible gain.

### 11. ~~Sweep's flat-locals rule is stricter than it needs to be~~ — done

Scoped per path. `checkFlatLocals` copies the live-name set for each `match` arm and each `if`
branch, so `One(inner) -> ...; Two(inner) -> ...` is accepted while nested shadowing on one path is
still a diagnostic. The pass never fed a table — its return value was discarded — so this changed
what is legal and nothing about lowering. Tested both ways in `tests/sweep_test.ts`.

### 12. ~~Frontend API inconsistency~~ — mostly done

A packed-ABI limit now returns `G1004` at stage `limit` instead of escaping `lowerGleamSources` as a
bare `RangeError`. That was the instance that actually bit: it killed a benchmark run on 2026-07-26,
ending the batch and reporting nothing about the remaining modules.

Still inconsistent, and deliberately: `parseGleamModule` throws `GleamSyntaxError`. It is the
lower-level entry point and `lowerGleamSources` already catches it, so callers going through the
documented API get a result. Anyone reaching past it accepts the throw.

### 13. ~~Nullary Gleam entry allocates a Unit for nothing~~ — closed, not fixable alone

Measured at 3 nodes and 1 definition, and the `Unit` is a static load rather than an allocation, so
there was never a cost. It also cannot be removed independently: Core lambdas are unary, so a
zero-argument Gleam function must become `Lambda(_)` and something has to apply it. Lowering the
entry to a value instead would break a program that both calls `main()` and passes `main` as a
value.

Subsumed by item 3 — n-ary lambdas in Core give a genuine zero-arity function and this disappears
with them.

## Not planned

**Beating Gleam by 2× on cold single-module compilation.** The current measured floor is 118.5 ms
frontend plus 107.7 ms Wasm emission, before semantic compilation, against Gleam's 48.0 ms complete
build. Exact no-change builds are already cache lookups, but edited builds remain about 6× slower.

**A shared Wasm runtime module.** The theory was that re-emitting the allocator per module was the
fixed cost. Measured: the three runtime body builders cost 22 µs of ~540. Not the problem.
