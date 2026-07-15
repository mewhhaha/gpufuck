# OCaml functional examples

These `.ml` fixtures use conservative OCaml syntax and compile through the same language-neutral
functional module as the Rust and Haskell profiles. Each checked-in trace places the OCaml source,
normalized functional surface, encoded ABI, and GPU-resolved core IR side by side.

| Source                                                          | Result | Boundary exercised                                                           |
| --------------------------------------------------------------- | -----: | ---------------------------------------------------------------------------- |
| [`factorial.ml`](factorial.ml) ([trace](factorial.trace.md))    |    120 | `let rec`, integer equality, conditionals, and recursive application         |
| [`list.ml`](list.ml) ([trace](list.trace.md))                   |     42 | built-in lists, `::` patterns, lambdas, higher-order mapping, and folding    |
| [`option_map.ml`](option_map.ml) ([trace](option_map.trace.md)) |     42 | a generic variant, inferred polymorphism, constructor application, and match |
| [`tree.ml`](tree.ml) ([trace](tree.trace.md))                   |     42 | postfix generic types, multi-field variants, and recursive tree transforms   |
| [`tuple.ml`](tuple.ml) ([trace](tuple.trace.md))                |     42 | tuple construction, matching, inferred functions, and local values           |

Run or trace a fixture from the repository root:

```sh
deno task run:ocaml-functional examples/ocaml-functional/tree.ml
deno task trace:ocaml-functional \
  examples/ocaml-functional/tree.ml \
  examples/ocaml-functional/tree.trace.md
```

On a machine with the OCaml toolchain, the source syntax can also be checked independently:

```sh
ocamlc -stop-after parsing examples/ocaml-functional/*.ml
```

## Current boundary

The profile accepts variant declarations with zero or more type parameters, `int`, `bool`, `unit`,
tuples, parenthesized function types in variant fields, postfix named type application, top-level
and local `let`, unary curried functions, `let rec`, `fun`, application, pure list literals and
cons, conditionals, arithmetic, comparisons, and flat constructor/list/tuple match patterns. It
enforces OCaml's sequential value scope and requires `rec` for self-reference before emitting the
shared module.

This is not a complete OCaml implementation. Records, modules, objects, polymorphic variants,
labelled and optional arguments, `and` recursion groups, exceptions, references, arrays, strings,
effects, and the value restriction are not parsed. Most importantly, the current functional backend
is lazy while OCaml is strict. These fixtures are pure and total, so their results do not depend on
evaluation order; a true OCaml frontend needs a strict evaluation profile or explicit forcing in its
lowering.
