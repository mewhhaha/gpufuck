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

| Sample                                 | What it shows                                          |                    Result |
| -------------------------------------- | ------------------------------------------------------ | ------------------------: |
| [`factorial.gleam`](factorial.gleam)   | Recursion and a wildcard `case` arm                    |                 `3628800` |
| [`pipeline.gleam`](pipeline.gleam)     | `\|>` with both a partial call and a bare function     |                      `42` |
| [`list_fold.gleam`](list_fold.gleam)   | List patterns, spread tails, a function as an argument |                      `42` |
| [`option_map.gleam`](option_map.gleam) | A generic algebraic type and an anonymous function     |                      `42` |
| [`records.gleam`](records.gleam)       | Labeled constructors and fields; returns a constructor |         `Rectangle(6, 7)` |
| [`guards.gleam`](guards.gleam)         | `if` guards, a wildcard, and `<>` concatenation        | `"negative zero small …"` |
| [`result_use.gleam`](result_use.gleam) | The prelude `Result` and `use` short-circuiting        |                  `Ok(42)` |

The seven single-file samples are what `playground/build.ts` inlines into the browser page, so
adding one here adds it there.

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

The `*.trace.md` files beside each sample are generated, not hand-written: they put the Gleam source
next to the normalized surface it lowers to and the Core the GPU resolves it into, so a lowering
change shows up as a reviewable diff. Regenerate one with the same module arguments the `run`
command takes, preceded by the output path:

```sh
deno task trace:gleam pipeline examples/gleam/pipeline.trace.md examples/gleam/pipeline.gleam
```

They are excluded from formatting in `deno.json`, since the tables are emitted verbatim.

`ParallelGleamFrontend`, exported from `gleam.ts`, parses and lowers many units across a worker
pool. It exists because at batch scale the frontend, not the GPU, is the cost: at batch 1024 parse
and lower are 588 µs per module against 93 µs of GPU compilation. Both are pure functions of a
source string, so they parallelise with nothing shared. The pool falls back to the calling thread
below sixteen units, where worker startup and message copying cost more than they return, and each
worker instantiates its own Baba parser, so it is worth creating once and reusing.
`deno task bench:gleam-batch` measures it.

Run the pinned upstream standard-library probe with:

```sh
deno task check:gleam-stdlib
```

The pinned check discovers all 1,521 tests across the eighteen test modules in Gleam's `stdlib`
package through Baba, then lowers and GPU-compiles them in batches of eight. It stops at resolved
Core and never executes, so it measures the frontend and the GPU semantic phases and says nothing
about the code generator.

Execution is a second tool, which needs a checkout of the same pinned commit:

```sh
deno task check:gleam-stdlib-wasm <checkout> [module ...]
```

It emits WebAssembly for one test at a time and runs it, using upstream's own assertions as the
oracle: a Gleam `assert` lowers to an explicit fault, so a test that runs to completion is a test
whose assertions held. At `bacc20c`, 547 of the 1,521 tests pass — 97% of the 564 that need no
runtime adapter. The other 957 declare Gleam's JavaScript FFI
(`@external(javascript, "../gleam_stdlib.mjs", ...)`) as a host capability the harness supplies no
implementation for, which is an adapter gap rather than a compiler result and is reported
separately; 17 are genuine failures.

This is complete compile coverage, not complete runtime parity. Bit-array patterns compile to
explicit host capabilities, while generic opaque values and JavaScript externals still need a Gleam
runtime adapter. JavaScript-specific runtime representations and the Gleam/OTP libraries also remain
adapter work. The compatibility contract is observable JavaScript-target behavior, not the generated
JavaScript representation.

Regenerate the parser after changing `language/gleam/grammar.baba`:

```sh
deno task generate:gleam
```
