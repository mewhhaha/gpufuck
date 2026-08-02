# Challenges

**The degenerate cases, hard walls, and open problems — what breaks, why it breaks now, and what
would fix it.**

This file is not a plan and not a measurement record. [TASKS.md](TASKS.md) ranks what to do next and
[BASELINE.md](BASELINE.md) records what was measured; this one exists so a shape that breaks the
compiler is written down once instead of being rediscovered. Several entries below were discovered
by hitting them accidentally while measuring something else, which is the argument for the file.

Each entry states what it is, why it is a problem _now_ rather than in principle, and what would
address it. Where a fix is speculative it says so — this project has repeatedly been wrong about
which fix would pay, and the entries reflect that.

## Hard walls

These are not slowness. They are inputs the compiler cannot accept at all, and no amount of tuning
changes them.

### A module cannot exceed 65,536 surface nodes

`SurfaceExpressionEncoder.reserveNode` throws
`functional surface module exceeds 65536 expression
nodes`. Because the frontend links imports into
one module, **a real project of about 60,000 nodes cannot be handed to this compiler at all.**
Measured: at ~1,174 nodes per realistic Gleam module, that ceiling arrives at **51 modules**.

Why it matters now: it is reached before anything interesting about performance is. The Gleam
standard library fits only because it is 17,718 nodes; it did not fit before the or-pattern fix, and
a project twice the stdlib's size is simply not compilable.

How to tackle it, in increasing order of work:

- **Submodule splitting** ([TASKS](TASKS.md) item 2) sidesteps it — compile pieces separately and
  batch them, which the ABI permits since the cap is per module. This needs wave sequencing, because
  inference has to flow a type from a definition to its users. 3.38× available parallelism, 21
  waves.
- **Widen the field.** The cap is an ABI property, so raising it is a version bump and touches every
  packed record. Mechanical, but not local.
- **Mandatory top-level annotations** cut the dependency edge that forces wave sequencing, so
  modules could be checked in one flat batch. That is Go's and Zig's bargain, and Lazuli already has
  the syntax.

### Compilation fuel is capped at 10,000,000 steps

`maximumSteps` rejects anything larger. A program whose inference needs more transitions than that
cannot be compiled, and the limit is not derived from the input — it is a constant. The Gleam stdlib
uses 405,343, so there is headroom today, but the headroom is not a property anyone checked.

How to tackle: derive the cap from node count with a generous multiplier, so the failure mode is
"this program is pathological" rather than "this constant was chosen in 2026".

### No WebGPU means no compiler

By design, and stated in ARCHITECTURE as a decision: there is no CPU fallback, because a silent one
would have different performance and cancellation behaviour and would make every number in BASELINE
meaningless. The cost is real — a machine without an adapter cannot use the compiler.

This bites in practice more than it sounds. The playground's own in-app browser during development
reported **WebGPU present but no adapter granted**, which is a third state beyond "works" and
"absent" and the page handles it only as an error message.

How to tackle: nothing, without reversing the decision. The honest mitigation is that the CPU oracle
in `src/semantic/type_inference.ts` already implements the same Hindley–Milner and is differentially
tested against the shader — it is a fallback that exists but is deliberately not wired up.

## Performance pathologies

### One lane per module, measured three ways

The semantic, inference and evaluator kernels are `@compute @workgroup_size(1)`. Every attempt to
route around it without changing what a lane does has failed:

| Attempt                              | Result                                     |
| ------------------------------------ | ------------------------------------------ |
| Packing modules into warps (8/32/64) | Flat to within noise; reverted             |
| Splitting generation from solving    | Generation is 31% of transitions, so 1.45× |
| Definition-level waves               | 3.38×, and 21 round trips cost 237 ms      |

And the cost is quantified: the same nodes cost **0.29 µs each across 256 independent modules and
11.34 µs linked into one — 39×.** That is the whole penalty, from a third direction.

The route that changes what a lane does now works. Concrete annotated modules carry a topologically
ordered type witness into one checking dispatch. Lanes independently validate terms, types, and
equations; only per-module status records return to the host, with full inference as the fallback.
On the 8,616-node Blot stress project it measures 105.9 ms against 108.3 ms on CPU, excluding
adapter and pipeline creation; the former 16384-transition state-machine pathology is absent on that
path.

Why warp packing does not help, since it looks like it should: both shapes launch the same thread
count, so the unpacked one hides latency with extra warps exactly as well as the packed one fills
lanes. The workspace is also lane-major — each lane's arena sits at a widely separated base — so
thirty-two packed lanes issue thirty-two scattered transactions.

How to tackle: node-level parallelism inside a **single** dispatch. The pieces are established —
`atomicCompareExchangeWeak` union-find converges under contention (ARCHITECTURE §9 spike), Core is a
flat array with children at higher indices, and node tags allow bucketing by kind to cut divergence.
Interleaving the workspace across lanes so packed reads coalesce is the one variant never tried, and
it is an ABI change for an unmeasured gain.

### A GPU round trip costs 11.3 ms in Deno even when empty

Eight concurrent awaits cost the same as one, so this is a per-await latency, not throughput. It is
the entire N=1 number in the oldest benchmark and it is a runtime property, not a compiler one.
**Unmeasured in browsers**, which matters because the playground quotes it.

Why it matters now: it forecloses a whole class of design. Anything that dispatches once per
dependency wave spends 21 × 11.3 = 237 ms on the Gleam stdlib before computing anything — worse than
`gleam build`'s entire 146 ms. Every parallel-inference design must therefore fit in one dispatch,
as a persistent kernel with in-kernel synchronisation.

How to tackle: measure it in Chrome first, because the constraint may be Deno-specific and the whole
design space widens if so. Otherwise, encode dependent passes back-to-back in one command buffer —
memory is coherent between passes, and `gpu_batch_compiler.ts` already does this for three passes.

### The frontend is 96% of a realistic compile, and 57% of it is our code

Split three ways on the 256-module corpus (1,464 KB), medians of five:

| Phase                          |    Time |      Rate | Share of frontend |
| ------------------------------ | ------: | --------: | ----------------: |
| baba parse                     |  758 ms | 1.89 MB/s |               41% |
| Our Gleam AST construction     |  477 ms |         — |               26% |
| Our lowering to packed surface |  578 ms |         — |               31% |
| _(GPU resolve and infer)_      | 87.9 ms |         — |                 — |

**This entry has been wrong twice, in the same direction, and that is the lesson.** First it
attributed all of parse-and-lower to baba, over-crediting the parser by a third. Then it attributed
all of parsing to baba, when 39% of that is our own walk from baba's cursor into a Gleam AST. The
frontend is three phases and only one belongs to the dependency, so a claim about "the parser" has
to say which of the three it means.

The share inverted during 2026-07-26. On the pre-fix Gleam standard library the GPU phase was 96% of
the compile and the frontend looked irrelevant; after path halving, contification and the pattern
fix the frontend is 96% and the GPU is 3.9%. The oldest section of BASELINE predicted exactly this
and was then ignored for a day.

How to tackle:

- ~~**Use `ParallelGleamFrontend`**~~ — done, and it was the cheapest win in the project: 4.7–6.5×
  on 16 cores, taking the 256-module corpus from 2,314 ms to 465 ms. It had been written, tested and
  left on no path. The playground still cannot use it without browser workers.
- **Fuse the Gleam AST away.** `parseGleamModule` walks baba's cursor into a `GleamModule` and
  `lowerGleamSource` then walks that into the packed surface — two full tree walks over the same
  program, 1,055 ms combined. Lowering straight from the cursor removes one. The largest item here,
  and entirely ours. Risk: the AST may be load-bearing for diagnostics and for the `use` desugaring,
  so it may not be a clean fusion.
- **Make baba faster, and check the direction.** Updating 5.1.0 → 7.0.0 on 2026-07-27, published as
  a parser and lexer improvement, measured **27% slower** on this grammar — 1.20 MB/s down to 0.94
  MB/s, ranges not overlapping, no opt-in missed. 7.1.0 restored parity the same day; 7.2.0 is
  unresolved against 7.1.0 because an unrelated process held 400% CPU throughout. Three bumps in a
  day, no measured CPU gain — a version bump is not a free win, in either direction.
- **The old measurement, for reference.** 1.89 MB/s against tree-sitter's 10–30 MB/s is an
  implementation gap rather than an algorithmic wall, but it is 41% of the frontend rather than all
  of it, and it is a separate project (`@mewhhaha/baba`). Worth asking for; not worth waiting for.
- ~~**A GPU lexer exists and this grammar cannot run it.**~~ **The wall is gone as of baba 7.2.0**,
  about four hours after it was recorded. All three grammars now fit:

  | Grammar        | States | 7.1.0            | 7.2.0    |
  | -------------- | -----: | ---------------- | -------- |
  | gleam          |    183 | OVER by 4,064 B  | **FITS** |
  | lazuli         |     82 | fits             | fits     |
  | javascript-aot |    238 | OVER by 19,904 B | **FITS** |

  The plans did not change shape. 7.1.0 expanded them into a dense `states × classes` table in
  workgroup storage; 7.2.0 keeps that table in device storage and needs only `512 + 36 × states`, so
  the `classCount` term that was the whole problem is gone. Automatic, with no option to set.
  `deno task check:gpu-lexer`.

  **And it is genuinely fast where it applies.** GPU lexing beats CPU parsing above an ~11–16 KiB
  band, reaching 8.7× at 117 KiB, and scales to **146 MB/s at 15 MiB** — a size the CPU parser
  cannot reach at all, since it refuses anything past ~147 KiB with `PARSER_TRACE_LIMIT`. The GPU
  side is flat at 12–13 ms below 100 KiB, which is a submit-and-sync floor rather than work; even at
  15 MiB only 38 ms of 158 ms is kernel time, the rest readback and sync.

  **What still blocks using it, in order:**

  1. Our modules average **5.7 KiB**, below the crossover, so per-module dispatch loses — and there
     is no API to lex many modules in one dispatch, which is the only shape that would clear both
     the size threshold and the setup cost.
  2. **Setup is 237.8 ms**, about fifteen lexes of the largest file the CPU can parse.
  3. The comparison is **not like-for-like**: the GPU emits tokens, `parseGleamModule` emits tokens
     _and_ a Gleam AST, and baba exposes no CPU lexer over the same plan to isolate against. The
     8.7× flatters the GPU by an unknown factor.
  4. It is async, experimental, and removable without a major release. ARCHITECTURE also lists
     parsing inside WGSL as an explicit non-goal, so adopting it reverses a recorded decision.

### WebAssembly emission is mostly fixed cost per module

`40 + 2` is eight Core nodes and still emits a 1,244-byte code section, because every module carries
its own allocator, free list and thunk-forcing runtime. The code section is 91–98% of every
artifact. At batch 1,024 emission was **63% of total cost**, though that figure predates the
node-count fix and wants re-measuring.

How to tackle: emit function bodies on the GPU — the Core is already in GPU buffers, readback
measures 1 µs, and bodies are independent across functions and modules. LEB128's data-dependent
offsets are the obstacle: size pass, prefix sum, then write. Or share one runtime across a batch
instead of per module.

### The compact-scalar path is attempted for every Gleam module and succeeds for none

100% attempt rate, 0% success, ~105 µs each. The ceiling for fixing it is 347–357 ms against a 419
ms baseline, so roughly 16% of emission. Two of three variants of the fix were tried and made things
slower; bailing at the boundary does not work because the entry is a direct call, so emission
inlines the whole program before reaching a memory instruction.

How to tackle: the abort has to happen inside the expression compiler, not at the boundary. This is
the one remaining variant.

### Every extra function parameter costs +5 nodes and +90 transitions

Exactly linearly, because Core has only unary lambdas and an n-parameter function becomes n nested
ones. A five-parameter function costs 3.7× the inference of a one-parameter function. This is an ABI
property — Gleam, Lazuli and Ducklang all pay it, and no frontend design avoids it.

How to tackle: an n-ary lambda and application node. ABI version bump, so deliberate rather than
opportunistic.

## Correctness hazards

### Only self-tail-calls become loops

`tailArguments` recognises a `Local` at the self depth or a `Global` matching the recursive
definition. Everything else grows the stack: **mutual recursion, and non-tail recursion of any
shape.** There is no WebAssembly tail-call proposal in use — `grep` finds no `return_call` — so the
`br`-to-loop-header rewrite is the only stack-safety mechanism that exists.

Why it matters now: a program that recurses 100,000 times in a shape the analysis does not recognise
fails at runtime, not at compile time, and the diagnostic is a host `RangeError` about call stack
size. That is a bad failure mode for a compiler to have.

How to tackle: emit `return_call` where the target supports it, which turns every tail call into a
constant-stack operation regardless of shape. Otherwise extend the analysis to mutual recursion via
the SCC information the inference phase already computes.

### `compileTailPosition` has no `LetRec` case, but the analysis descends into one

`#containsTailCall` recurses into `LetRec.child1`, so a loop can be **detected** through a `LetRec`
and then not **emitted** through it — the tail call falls to the default branch and becomes an
ordinary call. This is the same class of defect as the `let`-bound-lambda bug fixed by
contification, and it is exactly how that one hid: analysis and codegen tail-walkers drifting apart.

Found by reading, not by a failing program. Gleam may never produce a surviving `LetRec`, since
`recursive_groups.ts` lambda-lifts local SCCs to top level — so this may be unreachable from the
current frontends. **Unverified either way**, which is the problem.

How to tackle: construct a program that reaches it, through Lazuli or a hand-built surface module.
If reachable, add the case; if not, make `#containsTailCall` stop at `LetRec` so the two walkers
agree and the trap closes.

### Contification only handles nullary join points

`joinPointLambda` requires a one-parameter lambda whose parameter is unused and whose arguments are
effect-free leaves. That covers everything the frontends emit today, because every join point comes
from `discardName()` applied to `Unit`. A join point that passes a value still becomes a closure and
still loses tail position.

How to tackle: generalise to arity _k_ with parameter locals, reusing the parallel-assignment
discipline the tail loop already implements. The encoding is the same; only the argument handling
grows.

### Nested and multi-subject patterns still cascade

The or-pattern explosion is fixed by sharing the failure continuation, not by compiling a decision
tree. `lowerPattern` still emits a `case` over every constructor of the type at every level, so a
deeply nested pattern still produces a cascade — it is linear now rather than exponential, but it is
not minimal.

How to tackle: a real pattern-matrix compiler (Maranget), where each subject is tested once and each
arm body appears once with no failure continuations at all. That would also remove the reliance on
contification, since there would be no join points to contify.

### The CPU oracle is separately O(n^1.30)

`inferTypes` scales as n^1.30 over nine points from 1,334 to 49,964 nodes. `generalize` calls
`freeEnvironmentParameters`, which walks every type in the whole environment on every `let`; six
sites copy the entire environment with `new Map(environment)` to add one binding;
`globalEnvironment()` is rebuilt per SCC component. No Rémy levels, no path compression in `prune`,
no visited-set memoization.

Why it matters now: it is not on the compile path, so it costs no user anything — but it is the
**differential oracle** the GPU shader is tested against. Its cost sets a practical ceiling on how
large a program can be differentially verified, which is a correctness limit rather than a
performance one.

How to tackle: the same fixes that worked on the shader. Path compression in `prune` is the direct
analogue of what bought 4.83× on the GPU.

## Measurement traps

Every one of these produced a wrong number that was believed for a while.

### Benchmark shape decides the answer

The recorded 17× batch win is measured on two-definition modules, where the frontend has almost
nothing to do and the comparison is against Gleam's ~11 ms per-package floor. At 1,174 nodes per
module the same claim is worth **1.26×**. Neither number is wrong; quoting either without its module
size is.

Guard: `deno task bench` fixes the corpus so shape cannot drift silently, and README now states the
17× with its size attached.

### Reachability pruning silently empties a corpus

Lowering prunes to what the entry reaches, so a benchmark with a small `main` measures almost
nothing. An earlier version of the stdlib benchmark **lowered 252 KB of Gleam to 66 surface nodes**
and compared that against `gleam build` compiling all nineteen modules.

Guard: `tools/gleam_stdlib_corpus.ts` generates an entry binding all 353 exports, shared by the
benchmark and the profiler so they cannot diverge.

### Per-node figures were measured on a corpus that was 64% duplication

The 122.3 and 25.3 transitions-per-node figures were taken on the 49,964-node stdlib. After the
pattern fix the same program is 17,718 nodes, so those are per _duplicated_ node. The ratio between
them stands; the absolute values never described the program.

### Wall times need a quiet machine, and one run proves nothing

Batch timings spread ~30% run to run: the same tree measured 96.6, 101.2, 108.3, 117.1 and 129.7
µs/module. A change under about 20% is unmeasured. Worse, a loaded machine (load average 21.9) made
`parse` — which the change under test did not touch — swing between 245, 724 and 1,237 ms, and made
a 0.9× ratio read as 0.2×.

Guard: `deno task bench` reports timings but never fails on them, and fails only on exact counters.
Two changes have been reverted after a proper A/B showed the "win" was noise or a loss.

### Averages hide skew

Node-level available parallelism averaged 574× across the stdlib, which is 50,000 nodes over a depth
that barely moved. The **median level is 4–24 nodes wide** in every program measured. What
generalises is the work-weighted figure — 74–99% of nodes sit in levels wider than a warp — not the
mean.

### The profiling kernel is 40% slower than production

A dynamically indexed store into the private state struct spills it out of registers: 3,668–3,937 ms
without against 5,173–5,190 ms with. `profile:frames` therefore times the production pipeline and
counts with a separate build-time shader variant, so a profiled timing cannot be misquoted as a real
one.

## Environmental

### Concurrent GPU processes cause test failures

VRAM pressure makes WebGPU device creation fail inside tests, with a measured dose-response: 70
failures with heavy concurrent GPU use, 2 with moderate, 0 with none. The suite also has a known
intermittent failure at roughly 2 in 17 runs, never reproduced under controlled conditions and
correlating with concurrent GPU processes.

Why it matters now: a red suite is ambiguous. It might be a regression or it might be a game
running.

How to tackle: retry device creation with backoff and report VRAM state in the failure, so the
diagnostic distinguishes "no memory" from "wrong answer".

### The browser gets the slowest frontend we have

The playground calls `lowerGleamSource` directly: baba's CPU Wasm parser, **single-threaded, on the
UI thread**. It uses neither of the two things that make the frontend fast elsewhere.

- **No worker pool.** `ParallelGleamFrontend` is 4.7–6.5x on 16 cores and needs `Worker`, which the
  playground bundle does not set up. The browser gets none of it.
- **No GPU lexer.** Nothing in this repository uses baba's `webgpu-lexer` on a compile path, in the
  browser or out of it. The GPU is used only for name resolution and inference, strictly after
  parsing has finished on the CPU.

That is fine for a 118-byte example and visible immediately at scale: batch mode compiles N copies
of whatever is in the editor, so the 57 KB generated `stress` example at 64 modules is **3.57 MB of
Gleam parsed and lowered on one thread** — measured at 9 s in a normal browser and 26 s in a slower
one. At 1,024 it would be 57 MB.

Mitigated rather than fixed: the batch loop now yields every eight modules and reports progress, so
the page stays responsive and the wait is visible instead of looking like a hang. The work is
unchanged.

Two real fixes, neither done:

- ~~**Workers in the bundle**~~ — **done.** `playground/frontend_worker.ts` is bundled as a second
  entry point and the page runs one worker per core less one. Measured live: 64 x the 57 KB stress
  example went **26 s to 4.9 s, 5.3x**, matching what `ParallelGleamFrontend` reaches under Deno.
  About 4 s of what remains is one-time startup, fifteen workers each instantiating their own
  parser.
- ~~**GPU lexing into `parseRecords`**~~ — **abandoned, and this is the number that ends it.** Split
  on a 54.8 KB module, baba's lexer is **1.13 ms of a 133 ms frontend, 1%**. Tree building, the
  Gleam AST and lowering are the other 99%. A free, instantaneous GPU lexer is worth **1.01x** on
  the frontend, so the pipeline being expressible via 7.2.0's `parseRecords` no longer matters.

  This also corrects `bench:gpu-lexer`'s headline: its 9.56x compares GPU lexing against CPU
  parse-plus-AST, giving the GPU roughly a twenty-sixth of the work. The benchmark still bounds the
  kernel usefully — 110 MB/s where the CPU parser refuses input entirely — but the ratio is not a
  frontend speedup.

## Cleanups, closed 2026-07-26

All five are resolved, three by changing code and two by deciding not to:

- **The identity rename is gone.** `semanticSurfaceFromModule` had already been reduced to
  `return module` by an earlier pass — the twelve-field copy this file described was long dead, and
  only the indirection survived. Deleted, along with its nine call sites.
- **Nine `functional*` exports renamed** to `f32x4`, `hostFieldRepresentationType`, `hostFieldType`,
  `resolvedCoreFingerprint`, `storeType`, `thunkType`, `wasmArenaDepth`, `wasmArenaInstance` and
  `wasmInstanceArenaDepth`. `resolvedCoreFingerprint` needed the private helper beside it renamed to
  `fingerprintResolvedCore` first, which is why that one kept its prefix when the others lost
  theirs. Eighteen `functional*` names remain, all module-private, so they are noise rather than
  API.
- **Sweep's flat-locals rule is scoped per path.** Sibling `match` arms and the two branches of an
  `if` are disjoint — only one is ever live — so reusing a binder across them threatens no scope
  chain. `checkFlatLocals` copies the live set per branch; nested shadowing on one path is still a
  diagnostic. The pass never fed a table in the first place: its return value was discarded, so this
  changed what is legal and nothing about lowering.
- **A packed-ABI limit is now a diagnostic**, `G1004` at stage `limit`, rather than a bare
  `RangeError` escaping `lowerGleamSources`. This was not hypothetical: it killed a benchmark run
  earlier the same day, which is exactly the failure the entry described — one unguarded throw
  ending a batch and reporting nothing about the rest. Reachable only by linking, because baba's own
  trace limit stops a single source long before the node cap does.

Two decided against, with the reasoning kept so they are not reopened:

- **The nullary Gleam entry stays.** A synthetic `$gleam/entry` applies a zero-argument `main` to
  `Unit`, costing 3 nodes and 1 definition. It cannot be removed independently: Core lambdas are
  unary, so a nullary Gleam function must become `Lambda(_)` and something must apply it. Lowering
  the entry to a value instead would break a program that both calls `main()` and passes `main` as a
  value. This is a symptom of Core lacking n-ary lambdas — [TASKS](TASKS.md) item 3 — and disappears
  with it.
- **The remaining eighteen private `functional*` names stay.** Renaming them touches far more call
  sites than the public nine for no consumer-visible gain.
