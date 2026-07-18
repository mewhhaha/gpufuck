# Gleam functional frontend

This directory exercises a practical pure subset of Gleam as a gpufuck frontend. A Baba-generated
parser produces the syntax tree; the Gleam adapter lowers it into the neutral surface. The frontend
supports inferred local functions, annotated public module boundaries, generic algebraic types,
constructor and scalar cases, lists, tuples, anonymous functions, pipelines, recursion, and Gleam's
strict evaluation order.

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

Public functions need complete annotations because their types are serialized into module artifacts.
Local functions remain inferred. Strings, bit arrays, guards, record update syntax, effects, and the
BEAM/JavaScript runtime libraries are outside this portable Functional Core profile.

Regenerate the parser after changing `language/gleam/grammar.baba`:

```sh
deno task generate:gleam
```
