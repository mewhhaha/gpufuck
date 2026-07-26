# Tasks

Ranked future work. Every item carries the measurement that justifies it, because several plausible
items on this list turned out to be worth nothing once measured, and two that looked like defects
were reverted after the fix made things slower.

The rule this list is written under: **do not start an item without re-measuring its premise.** The
numbers below were taken on one machine (Ryzen 7 7800X3D, RTX 4080 SUPER, Deno 2.9.2) and some of
them are already the second or third version of a number that was wrong the first time. See
[BASELINE.md](BASELINE.md) for how each was taken.

## Now

### 0. ~~Tail calls are lost inside `let`-bound lambdas~~ — done

**Fixed by contification.** `joinPointLambda` recognises a `let`-bound one-parameter lambda that
ignores its parameter and is only ever tail-called, and `compileTailPosition` emits it as a wasm
`block` label rather than a closure — shared, and still in the enclosing function's tail position.
The guarded countdown below now completes 100,000 iterations; regression test
`keeps guarded Gleam
scalar recursion stack safe`. Note that fixing codegen alone did nothing:
`#containsTailCall` has to descend into the join body too, or the function is never registered as a
loop at all.

The bug, for the record: `#containsTailCall` in `src/functional/wasm_function_analysis.ts` descends
through `Let`, `Case`, `CaseArm` and `If` but stops at `Lambda`, so a self-tail-call inside a
`let`-bound lambda compiles to a stack-growing closure call. `lowerSequentialCase` binds every later
arm to a fallback lambda, which means **guarded Gleam already loses tail recursion**:

```gleam
fn countdown(n, total) {
  case n {
    m if m <= 0 -> total
    _ -> countdown(n - 1, total + 1)
  }
}
```

overflows the stack at 100,000 iterations on `main` today. Valid Gleam, silently miscompiled.

The fix is contification: recognise `let f = \_ -> B in E` where every reference to `f` in `E` is a
saturated call in tail position, and compile calls to `f` as jumps rather than closure calls, so
tail calls inside `B` stay tail calls of the enclosing function. This is a prerequisite for item 1,
which needs exactly that shape.

### 1. ~~Multi-subject `case` with or-patterns explodes~~ — done, 2.8x smaller corpus

**Fixed.** It was body duplication: `lowerPattern` handed the entire rest of the match to every
non-matching constructor arm of a test, compounding at every level of a nested pattern —
`(4^2n - 1)/3` copies of each arm body. Binding that continuation to one join point per pattern
sequence makes it linear, and item 0's contification means the join point costs nothing at runtime.

| Arms | Before | After |
| ---: | -----: | ----: |
|    1 |     94 |    63 |
|    2 |  1,214 |   113 |
|    3 | 19,134 |   163 |
|    4 | throws |   213 |

Four arms now compiles instead of exceeding the 65,536-node ABI cap, so the correctness half is
closed too. Reproduce with `deno task measure:or-patterns`.

**The Gleam stdlib corpus shrank from 49,964 nodes to 17,718** — 64.5% of it was duplicated arm
bodies, more than the 52% estimated from `list::sequences` alone. Inference transitions fell
1,265,365 → 405,343 and the emitted Wasm 1,745 KB → 999 KB. Every per-node figure recorded before
this was measured against a corpus 2.8x larger than the program it claimed to compile.

Lowering got _faster_, 6.7x on that corpus, because there are far fewer nodes to build.

Item 2 below was waiting on this; its available-parallelism numbers now want re-measuring against
the smaller corpus.

### 2. Splitting a module into submodules caps at 1.9x today

A natural idea, since batching 1,024 modules beats `gleam build` by 17x while one large module loses
by 33x: have the frontend split large modules and batch the pieces. Same node count, 7.6x apart.

The dependency structure permits it — 21 shallow waves, 1,035 SCC components, largest SCC of 3, so
mutual recursion is not the obstacle, and `definition_wavefront.ts` already computes the schedule
and is used by nothing in the compiler. Definition-level available parallelism is 1.9x, because one
definition is 52% of the corpus and a definition cannot be split across submodules.

**That 1.9x is the wrong granularity for anything except submodule splitting.** Constraint
generation works on nodes, not definitions, and at node level the same corpus is **574x wide** at a
depth of 87 — including `list::sequences`, the definition that caps the 1.9x, which is itself 65
levels deep and roughly 400x wide inside. See BASELINE.md. Item 7 is where that width is worth
collecting; splitting into submodules is not.

So the order is: fix the explosion, re-measure available parallelism, and only then decide whether
wave-scheduled submodule batching is worth building. Inference across waves also needs each
submodule to declare the types it imports, which is what the earlier wave infers — a sequence of
batches, each internally parallel, not one flat batch.

**Build the consumer before the supply.** Restructuring a _language_ to be splittable is tempting
and measurably works on the graph — the same 40-term Lazuli program goes from 1.0x to 13.3x
available parallelism by bounding definition size and adding a balanced reduction tree. But compile
time across those three shapes is 13.0, 13.3, and 14.0 ms: the tree is _slower_, because nothing
consumes the structure and more definitions is more work for the single lane. Two things could
consume it — submodule batching through the path that already beats `gleam build` by 17x, or
parallel inference across definitions (item 7). Until one exists, frontend restructuring buys
nothing.

An untested third lever, worth knowing before designing a language for this: wave sequencing exists
only because inference must flow a type from a definition to its users. Mandatory (or cached)
top-level annotations cut that edge, so every definition could be checked in one flat batch with no
waves at all. That is the trade Go and Zig make, Lazuli already has the annotation syntax, and the
current wavefront analysis would not credit it because it derives dependencies from references
rather than from types.

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

### 4. WebAssembly emission is 63% of batch cost

At batch 1,024 the split is 22% frontend, 15% GPU, **63% Wasm emission** (442 µs/module). It is also
mostly _fixed_ per module: `40 + 2` is 8 Core nodes and still emits a 1,244-byte code section,
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

### 6. ~~Transition count scales as n^1.68~~ — done, 4.83x

**Fixed.** Eight visitors chased variable link chains one charged transition per hop and never wrote
back, so every chain was rewalked. One shared `halve_variable_link` helper (path halving) took the
Gleam stdlib from **6,112,586 transitions to 1,265,365** and the GPU phase from 3,806 ms to 1,019.6
ms. Per-node cost is 122.3 → 25.3, and the curve is now linear: 23.5 transitions per node at 1,128
nodes against 25.3 at 49,964. Against `gleam build`, 25x → **8.0x**; against our own CPU oracle,
4.7x → **1.3x**. Full numbers and the A/B in BASELINE.

What is left in this area, in order:

**6a. Union by rank is still missing.** Halving shortens chains but orientation is still decided by
which side happens to be a variable. Cheap to add, unmeasured, and probably small now.

**6b. `Apply` stage 41 chases links inline in its own frame** rather than through the shared helper.
It fell 2.3x for free when the other eight compressed the chains it walks; routing it through
`halve_variable_link` too would compress them itself.

**6c. Instantiation still copies the scheme graph per use.** `InstantiateVisit` fell 65x to 3.7%, so
what remained after the chase was removed is small — the 50.0% was almost entirely chain-walking,
not copying. Reprofile before spending anything here; the premise mostly evaporated.

The profile is now flat — Unify 19.7%, Prune 16.2%, Expression 15.5% — with no dominant term. The
next real win is occupancy (item 7), not further transition-count work.

### 7. Parallelise the inference kernel — but not by splitting generation from solving

`type_inference_shader.ts` is `@compute @workgroup_size(1)` — one lane of roughly ten thousand. This
is the retarget's original premise and now the largest win available outright: item 6 removed the
work that should not have existed, and what is left is 1.27M transitions still running on one lane.

**The generate-then-solve re-encoding was proposed and killed by measurement before it was built.**
The plan was one wide dispatch emitting constraints, then a wavefront solve. Profiling said
generation was **11.4%** of transitions and solving 81.2%, an Amdahl ceiling of **1.13x**. After
path halving (item 6) the split is 35.0/49.3 and the ceiling is **1.54x** — better, because the
solve shrank 8x rather than because generation improved, and still not a reason to build it. Do not
rebuild this argument without re-reading BASELINE; it was convincing and it was wrong.

Three further entanglements would have to be undone even if the split did pay, all found by reading
the kernel rather than by measurement:

- **Generation is not bottom-up.** Expected types propagate _downward_ through frame word 11, and
  `Apply` stage 41 branches on the _pruned_ callee's kind. Which constraint to emit depends on
  having solved earlier ones.
- **Allocation order is load-bearing.** `Apply` records `state.type_top` watermarks and hands them
  to unify to elide the occurs check. That encodes sequential allocation order as a semantic
  invariant and does not survive a parallel map.
- **There is backtracking inside "generation."** The rigid-refinement trail is a mutable undo log
  with rollback checkpoints taken at case-arm entry.

What survives from the original argument:

- **Node-level width is real and grows with program size.** Depth 87 on the Gleam stdlib, mean width
  579, widest level 22,101. Across five programs, 74–99% of nodes sit in levels wider than a warp,
  and width grows ~14x for 70x the nodes. The crossover is in the thousands of nodes.
- **Unification can be parallel.** The capability spike in ARCHITECTURE §9 verified that
  `atomicCompareExchangeWeak` union-find converges under contention. That is the hard primitive and
  it is not speculative — and it is the 81.2%, not the 11.4%.
- **Divergence is bucketable.** Every Core node carries a tag; grouping by tag before dispatch gives
  each warp one node kind instead of eleven.

**Reshaping lanes is not the lever — measured and reverted.** Packing modules into workgroups
(`workgroup_size` 8, 32 and 64 against the current 1) is flat to within noise on the batch corpus,
even though those modules are structurally identical and so are the best case for it. Both shapes
launch the same thread count: the unpacked one hides latency with more warps exactly as well as the
packed one fills lanes, and packing worsens the access pattern because each lane's workspace arena
sits at a widely separated base. Batch parallelism is therefore already saturated at N=1024, and the
only parallelism left is **inside one module**. See BASELINE.

**One constraint dominates the design.** A GPU round trip in Deno costs 11.3 ms even when the shader
does nothing (measured, BASELINE.md). One dispatch per dependency wave would spend 21 × 11.3 = 237
ms on the Gleam stdlib before computing anything — worse than `gleam build`'s entire 146 ms. So the
whole wavefront has to live inside a single dispatch, as a persistent kernel with in-kernel
synchronisation, or the work has to move off Deno. Anything that dispatches per wave is dead on
arrival regardless of how good the kernel is.

And the payoff shows up in throughput, not latency: even a free inference phase leaves parse, lower,
and emit at 152 ms against Gleam's 146 ms total.

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
