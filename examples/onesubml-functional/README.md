# 1SubML functional examples

These fixtures use syntax from [Storyyeller's 1SubML](https://github.com/Storyyeller/1subml) and
compile through the same language-neutral functional IR, GPU resolver, GPU Hindley–Milner
inferencer, and WebAssembly backend as the Rust, Haskell, and OCaml profiles. Each checked-in trace
places the source, normalized surface, encoded ABI, and GPU-resolved core IR side by side.

| Source                                                             | Result | Boundary exercised                                                           |
| ------------------------------------------------------------------ | -----: | ---------------------------------------------------------------------------- |
| [`blocks.ml`](blocks.ml) ([trace](blocks.trace.md))                |     42 | expression blocks, sequential local bindings, and lexical scope              |
| [`combinators.ml`](combinators.ml) ([trace](combinators.trace.md)) |     42 | higher-order functions, inference, and right-associative application         |
| [`factorial.ml`](factorial.ml) ([trace](factorial.trace.md))       |    120 | `let rec`, integer equality, conditionals, and recursive application         |
| [`modules.ml`](modules.ml) ([trace](modules.trace.md))             |     42 | immutable anonymous records, field projection, tuples, and modules-as-values |
| [`rank2.ml`](rank2.ml) ([trace](rank2.trace.md))                   |     42 | explicit generic functions, rank-2 parameters, and independent instantiation |
| [`rank3.ml`](rank3.ml) ([trace](rank3.trace.md))                   |     42 | rank-2 consumers passed through a rank-3 provider                            |

Run or trace a fixture from the repository root:

```sh
deno task run:onesubml-functional examples/onesubml-functional/modules.ml
deno task trace:onesubml-functional \
  examples/onesubml-functional/modules.ml \
  examples/onesubml-functional/modules.trace.md
```

## Current boundary

The profile accepts i32 integers, booleans, immutable top-level and local `let`, `let rec`
functions, `fun`, right-associative application, two-field tuples and tuple patterns, expression
blocks, conditionals, arithmetic, comparisons, line and block comments, immutable anonymous record
literals, field shorthand, and field projection. Record field order is structural: literals with the
same field names share one generated parametric core type, while their field types remain fully
GPU-inferred. Generic `fun[T]` definitions and `[T]. T -> T` function-parameter annotations select
the predicative rank-N GPU profile. Quantifiers may occur at recursively nested function-parameter
boundaries; actual schemes are instantiated and expected schemes are skolemized on the GPU.

This is not the complete 1SubML language. Arbitrary-precision integers are narrowed to i32, and the
profile does not yet implement width subtyping between different record shapes, structural variants,
mutable fields, loops, strings, floats, type aliases, newtypes, structural coercions, existential
type members, impredicative polymorphism, polymorphic record fields, higher-kinded source types,
imports, or effects. Higher-rank annotations currently belong on top-level function definitions.
Record shapes must be evident from a literal or binding at the projection site; structural
constraints are not yet inferred through function parameters or function results. The fixtures are
pure, so the backend's lazy evaluation does not change their observable results.
