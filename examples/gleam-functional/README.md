# Gleam functional frontend

This directory exercises a practical pure subset of Gleam as a gpufuck frontend. A Baba-generated
parser produces the syntax tree; the Gleam adapter lowers it into the neutral surface. The frontend
supports inferred local and cross-module functions, explicit nominal type and constructor imports,
generic algebraic types and aliases, constants, string concatenation and prefix patterns, static
byte-aligned bit arrays, panic, annotated JavaScript externals with source fallbacks, labeled calls
and records, tuple projections, destructuring lets, exhaustive nested patterns, guards, multiple
subjects, list spreads, arbitrary tuples, anonymous functions, captures, `use`, pipelines,
recursion, and Gleam's strict evaluation order. `Int` uses portable f64-backed whole-number
operators to match the JavaScript target beyond i32, aggregate equality is structural, and
floating-point division by zero produces zero.

Run a single module:

```sh
deno task run:gleam-functional option_map examples/gleam-functional/option_map.gleam
```

Run the linked three-module kernel:

```sh
deno task run:gleam-functional kernel/main \
  kernel/math=examples/gleam-functional/kernel/math.gleam \
  kernel/program=examples/gleam-functional/kernel/program.gleam \
  kernel/main=examples/gleam-functional/kernel/main.gleam
```

Public functions and constants may omit annotations. Their linked types are inferred on the GPU;
incremental compilation conservatively invalidates dependents when an inferred export changes.
Explicit annotations still provide narrower interface fingerprints.

Run the official-backend differential check and the pinned upstream standard-library probe with:

```sh
deno task test:gleam-differential
deno task check:gleam-stdlib
```

The pinned check parses, lowers, GPU-typechecks, and links all 19 modules in Gleam's `stdlib`
package, then executes a host-independent harness through Wasm. This is compile coverage, not
complete runtime parity. Bit-array patterns compile to explicit host capabilities, while generic,
zero-argument, and non-JavaScript externals use fail-fast definitions until a Gleam runtime adapter
supplies their semantics. JavaScript-specific runtime representations and the Gleam/OTP libraries
also remain adapter work. The compatibility contract is observable JavaScript-target behavior, not
the generated JavaScript representation.

Regenerate the parser after changing `language/gleam/grammar.baba`:

```sh
deno task generate:gleam
```
