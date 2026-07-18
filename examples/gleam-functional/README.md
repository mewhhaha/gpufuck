# Gleam functional frontend

This directory exercises a practical pure subset of Gleam as a gpufuck frontend. A Baba-generated
parser produces the syntax tree; the Gleam adapter lowers it into the neutral surface. The frontend
supports inferred local and cross-module functions, explicit nominal type and constructor imports,
generic algebraic types and aliases, constants, strings, static byte-aligned bit arrays, panic,
annotated JavaScript externals, labeled calls and records, constructor and scalar cases, guards,
multiple subjects, list spreads, arbitrary tuples, anonymous functions, captures, `use`, pipelines,
recursion, and Gleam's strict evaluation order. Integer and `f64` operators follow Gleam's separate
syntax, aggregate equality is structural, and floating-point division by zero produces zero.

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

This is not yet a complete Gleam JavaScript target. Dynamic and non-byte-aligned bit-array segments,
bit-array destructuring options, zero-argument or generic externals, JavaScript-specific runtime
representations, and the Gleam/OTP libraries still need adapter work. Externals are conservatively
effectful and synchronous and must use concrete boundary types. The compatibility contract is the
observable JavaScript-target behavior, not the generated JavaScript representation.

Regenerate the parser after changing `language/gleam/grammar.baba`:

```sh
deno task generate:gleam
```
