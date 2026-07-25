# Gleam frontend

This directory exercises a practical pure subset of Gleam as a gpufuck frontend. A Baba-generated
parser produces the syntax tree; the Gleam adapter lowers it into the neutral surface. The frontend
supports inferred local and cross-module functions, explicit nominal type and constructor imports,
generic algebraic types and aliases, constants, string concatenation and prefix patterns, static bit
arrays, panic, annotated JavaScript externals with source fallbacks, labeled calls and records,
tuple projections, destructuring lets, exhaustive nested patterns, guards, multiple subjects, list
spreads, arbitrary tuples, zero-argument functions, anonymous functions, captures, `use`, pipelines,
recursion, and Gleam's strict evaluation order. `Int` lowers to 64-bit integers, keeping Gleam's
arithmetic rules — a zero divisor yields `0`, and division truncates toward zero. Aggregate equality
is structural, and floating-point division by zero produces zero.

Run a single module:

```sh
deno task run:gleam option_map examples/gleam/option_map.gleam
```

Run the linked three-module kernel:

```sh
deno task run:gleam kernel/main \
  kernel/math=examples/gleam/kernel/math.gleam \
  kernel/program=examples/gleam/kernel/program.gleam \
  kernel/main=examples/gleam/kernel/main.gleam
```

Public functions and constants may omit annotations; their linked types are inferred on the GPU.

Run the pinned upstream standard-library probe with:

```sh
deno task check:gleam-stdlib
```

The pinned check discovers all 1,521 JavaScript-targeted tests in Gleam's `stdlib` package through
Baba, lowers and GPU-compiles them in bounded batches, and executes the 444 tests whose reachable
definitions need no Gleam runtime adapter. This is complete compile coverage, not complete runtime
parity. Bit-array patterns compile to explicit host capabilities, while generic opaque values and
JavaScript externals still need a Gleam runtime adapter. JavaScript-specific runtime representations
and the Gleam/OTP libraries also remain adapter work. The compatibility contract is observable
JavaScript-target behavior, not the generated JavaScript representation.

Regenerate the parser after changing `language/gleam/grammar.baba`:

```sh
deno task generate:gleam
```
