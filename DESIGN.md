# Designing a language that compiles fast on a GPU

A sketch, argued from hardware constraints and the measurements in [BASELINE.md](BASELINE.md). It
describes a language that does not exist. Nothing here is measured except where it says so, and the
one number that matters — what it would actually cost — is not known.

## The governing constraint

A GPU is fast at **map** and slow at **fold**. Thousands of lanes execute in lockstep; a lane that
branches differently from its neighbours serializes the warp, and a lane that chases a pointer
stalls on memory latency the scheduler can only partly hide.

Type inference is a fold. Unification threads a mutable substitution through the whole program,
union-find is pointer chasing by construction, and the work per node is data-dependent. That is the
worst possible shape, and it is what the current kernel does: one lane, 1.27 million sequential
transitions on the Gleam stdlib. (That was 6.1 million until path halving; the shape of the
algorithm is the point, not the constant.)

So the design question is not "which syntax is cheap" — measured, that is worth 2–4x. It is:

> **What must be true of a language for its compilation to be a map?**

## What has to become a sweep

Checking a program bottom-up is naturally parallel: if every child's type is known, a node's type is
a fixed-size function of its children. One lane per node, one pass, no solving.

Two things stop that today, and only one of them is the language's fault.

**The IR is already right.** Resolved Core is a flat array of fixed-size 8-word records, and
children always sit at higher indices than their parent — measured, 100% of nodes across three
programs, zero exceptions. A reverse linear sweep therefore visits every child before its parent.
The data layout needs no change at all.

**The algorithm is wrong.** Inference _solves_ rather than _checks_, so it cannot sweep. Removing
that is a language decision, not a backend one.

## The rules

**1. Every binding carries its type. No inference, only checking.**

This is the load-bearing rule and everything else is secondary to it. Checking is a bottom-up
function; inference is a global solve. With full annotations there is no unification, no
substitution, no occurs check, no generalization, and no union-find — the four things that make the
current kernel pointer-chasing and divergent.

The earlier annotation experiment was worth only ~9% because it still fed annotations to an
inference engine that solved anyway. The checking-only kernel now measures the different algorithm:
on the 8,616-node Blot stress project, cold Core compilation is 108.3 ms on CPU and 105.9 ms on the
throughput GPU path, excluding adapter and pipeline creation.

**A later measurement supports it, though less dramatically than it first appeared.** Charging every
inference transition to the frame kind that did it, on the Gleam stdlib, solving came out at
**81.2%** against generation's 11.4% — four fifths of the work being exactly what checking does not
do. Then path halving removed 4.83x of the transitions, most of them from the solve, and the split
settled at **49.3% solve against 35.0% generation**.

So the rule still aims at the larger half, and `Prune` (union-find, 16.2%) plus the instantiation
and forall machinery do not exist in a checking pipeline at all. But the honest version of the claim
is "about half", not "four fifths", and the first number was inflated by a defect rather than by the
algorithm. What remains unmeasured is the constant factor of a checking kernel, which is the whole
question and is why the experiment at the bottom of this document is still the right next one. See
[BASELINE.md](BASELINE.md).

**2. Explicit type arguments at instantiation. Polymorphism stays, inference of type arguments
goes.**

Generalization and instantiation are the expensive half of Hindley–Milner. Naming type arguments at
the call site makes instantiation a substitution into a known scheme, which is a fixed-size local
operation.

Keep the polymorphism itself: measured, one shared polymorphic function instantiated 30 times costs
1,449 transitions where thirty monomorphic copies cost 4,050. Monomorphizing to "simplify" would
cost 2.8x. This is the rule most likely to be gotten backwards.

**3. Fixed arity, n-ary in the IR.**

Measured: +5 nodes and +90 transitions per parameter, exactly linear, because Core has only unary
lambdas. A five-parameter function costs 3.7x a one-parameter function for no reason a caller would
recognise. Functions take an argument tuple; application is one node.

**4. Single-level pattern dispatch.**

`case` matches one constructor tag and binds its fields. Nesting and or-patterns are written by
hand, not desugared. Measured, constructor-plus-`case` is already the most expensive construct at
166 transitions per use, and multi-subject or-patterns explode 13–16x per arm and hard-fail at four
arms. Making the cost visible in the syntax is the honest trade: the compiler stops doing
exponential work the programmer did not ask for.

**5. Flat, uniquely-named locals.**

Name resolution currently computes de Bruijn depths on the host as a lowering plan. If every binder
in a function has a distinct name, resolution is a lookup in a per-function table — a map, and one
that can move onto the GPU with the rest.

**6. No recursive type aliases; nominal types only.**

The occurs check exists to stop infinite types. Nominal declarations with no structural recursion in
aliases remove the need for it, and with it the unbounded traversal it implies.

**7. Explicit module interfaces.**

Each module declares the types it exports. Then modules genuinely are independent, batch compilation
needs no wave sequencing, and the 17x throughput path applies to a single project rather than only
to a thousand unrelated programs.

## What this buys, and what is unknown

Compilation becomes: parse (CPU, parallel across modules) → one kernel, one lane per node, sweeping
a topologically ordered array with fixed work per lane.

The ceiling is then the dependency depth of the check, not the node count. For the Gleam stdlib the
definition graph is 21 waves deep — if a node-level sweep is similarly shallow, a 50,000-node module
is tens of dependent steps rather than 1.27 million sequential ones.

That argument now has one positive measurement. `GpuTypedCoreChecker` packs concrete modules and a
topologically ordered type witness into one dispatch. Independent lanes validate terms, witness
records, and equations; successful programs perform no atomics, and the host reads back only one
status record per module. The 8,616-node Blot stress workload is slightly GPU-faster, while the
1,454-node tour still enters general inference and remains decisively CPU-faster. Typed checking
removes the large-program pathology without making GPU startup or inference free.

## Built, and measured: the frontend half buys nothing

Sweep (`sweep.ts`, `src/sweep/`) implements every rule the frontend can implement. Rules 2, 4, 5, 6
and 7 are enforced — a violation is a diagnostic, tested in `tests/sweep_test.ts`, because a rule
the compiler does not enforce is a comment. Rule 1 is now honoured for concrete annotated modules;
unsupported or polymorphic modules still enter full inference. Rule 3 remains unimplemented because
Core arrows are still unary, so an n-ary signature still folds.

The same computation in Sweep and Lazuli, `deno task bench:sweep`:

| Functions | Sweep nodes | Lazuli nodes | Sweep transitions | Lazuli transitions | Ratio |
| --------: | ----------: | -----------: | ----------------: | -----------------: | ----: |
|         4 |          95 |           95 |             1,500 |              1,548 | 1.03x |
|        16 |         383 |          383 |             5,652 |              5,664 | 1.00x |
|        64 |       1,535 |        1,535 |            22,260 |             22,128 | 0.99x |

**Identical.** Not close — the same node counts exactly, and transition counts within noise.

The one case where Sweep might plausibly have won is nested patterns, since Lazuli desugars them and
Sweep makes you nest the matches by hand. A nine-arm nested match, both ways: **Lazuli 35 nodes,
Sweep 38**. Marginally worse, not better. There is no shape yet found where the design pays on this
pipeline.

That is the prediction at the bottom of this document, confirmed. Every rule either needs a backend
change to pay (1 and 3), or prevents a pathology rather than accelerating the common case (4), or
does not touch this pipeline at all (5, 6, 7). A language designed for a compiler that has not been
changed to exploit it compiles exactly like one that was not.

The value that remains is real but different in kind: Sweep _cannot_ express the multi-subject
or-pattern that explodes 13–16x per arm and hard-fails at four arms, because the grammar has no
or-patterns and no nesting. It is faster in the sense that a program which does not compile at all
in Gleam compiles fine here — not in the sense that anything measured got quicker.

The checking-only kernel now makes the annotated subset pay on a large module batch. An n-ary lambda
node (TASKS item 3) remains the backend change needed for the rest of the design.

## What it gives up

Type inference, which is most of the ergonomic appeal of an ML-family language. What is described
here is closer to a fast, explicitly-typed functional core — Rust's or Zig's bargain rather than
Haskell's — and it is worth being clear that the reason this repository's Lazuli infers types is
that inference is the interesting part of the problem, not an accident.

There is also an ordering argument against doing any of it yet. Language-level choices are worth
2–4x on inference; parallelising the existing kernel is worth 10–50x, and emission is 63% of batch
cost before either. A language designed for a compiler that has not been parallelised is a supply
with no demand — which this repository has already measured once, in the submodule-splitting
experiment where a 13.3x increase in available parallelism produced a _slower_ compile.
