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
worst possible shape, and it is what the current kernel does: one lane, 6.1 million sequential
transitions at 568 ns each.

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

Honest caveat: this repository measured annotations as worth only ~9%. That number does **not**
support this rule, and it does not refute it either — it measured annotations fed to an inference
engine that solves anyway. A checking-only pipeline is a different algorithm, and its cost is
unmeasured.

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
is tens of dependent steps rather than 6.1 million sequential ones.

That is the argument. It is not a measurement, and the honest position is that the constant factors
could eat it: a lane doing a fixed-size type check still reads its children's types from memory, and
whether that coalesces is exactly the kind of thing this project has repeatedly been wrong about
until it measured. The cheapest experiment that would settle it is a checking-only kernel for a
deliberately trivial annotated language, benchmarked against the existing inference path on the same
programs.

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
