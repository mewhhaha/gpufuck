# Haskell functional examples

Every `.hs` file in this directory is accepted unchanged by GHC and by the bounded Haskell frontend.
The matching `.trace.md` records the normalized functional surface, encoded ABI, GPU core IR,
inferred entry type, and evaluated result.

| Source                                                                      | Result | Boundary exercised                                                                                 |
| --------------------------------------------------------------------------- | -----: | -------------------------------------------------------------------------------------------------- |
| [`classes.hs`](classes.hs) ([trace](classes.trace.md))                      |     42 | first-order class declarations, concrete instances, constraints, and automatic dictionary evidence |
| [`combinators.hs`](combinators.hs) ([trace](combinators.trace.md))          |     42 | `id`, `const`, composition, argument flipping, curry/uncurry, unit, and partial application        |
| [`dictionary.hs`](dictionary.hs) ([trace](dictionary.trace.md))             |     42 | manual `Eq` dictionaries, function fields, and dictionary composition for pairs                    |
| [`factorial.hs`](factorial.hs) ([trace](factorial.trace.md))                |    120 | annotated top-level recursion and conditionals                                                     |
| [`frontend.hs`](frontend.hs) ([trace](frontend.trace.md))                   |     42 | type synonyms, `newtype`, strings, rank-2 parameters, and mutually recursive local functions       |
| [`gadt.hs`](gadt.hs) ([trace](gadt.trace.md))                               |     42 | a GADT equality witness whose pattern refines indexed result types                                 |
| [`lambda_list.hs`](lambda_list.hs) ([trace](lambda_list.trace.md))          |     42 | layout, lambdas, built-in list syntax, list patterns, and inferred list mapping                    |
| [`list.hs`](list.hs) ([trace](list.trace.md))                               |     42 | a generic list ADT with `map`, `filter`, `foldRight`, and `zipWith`                                |
| [`option_map.hs`](option_map.hs) ([trace](option_map.trace.md))             |     42 | inferred higher-order mapping over a generic optional value                                        |
| [`pattern_guards.hs`](pattern_guards.hs) ([trace](pattern_guards.trace.md)) |     42 | multiple equations, nested patterns, guards, `otherwise`, and `where` bindings                     |
| [`reader.hs`](reader.hs) ([trace](reader.trace.md))                         |     42 | pure `Reader`, `ask`, `asks`, `mapReader`, and `local` through closures stored in constructors     |
| [`records.hs`](records.hs) ([trace](records.trace.md))                      |     42 | record declarations, reordered construction, record patterns, and synthesized selectors            |
| [`result.hs`](result.hs) ([trace](result.trace.md))                         |     42 | `Result` mapping, binding, folding, and failure propagation                                        |
| [`state.hs`](state.hs) ([trace](state.trace.md))                            |     42 | pure `State` execution, mapping, `pure`, and binding                                               |
| [`tree.hs`](tree.hs) ([trace](tree.trace.md))                               |     42 | inferred recursive generic tree mapping and an annotated fold                                      |
| [`tuple.hs`](tuple.hs) ([trace](tuple.trace.md))                            |     42 | inferred polymorphism reused at Boolean and tuple types, local bindings, and tuple matching        |
| [`unicode.hs`](unicode.hs) ([trace](unicode.trace.md))                      |     42 | Unicode character and string literals lowered to code points and functional lists                  |

Run an example:

```sh
deno task run:haskell-functional examples/haskell-functional/state.hs
```

Regenerate a trace:

```sh
deno task trace:haskell-functional \
  examples/haskell-functional/state.hs \
  examples/haskell-functional/state.trace.md
```

## Current boundary

The frontend accepts layout or explicit braces, lambdas, built-in list and string syntax, record
syntax, multiple equations, nested constructor/tuple/list/record patterns, guards, `otherwise`, and
`where` bindings. It supports positional and single-constructor record ADTs, `newtype`, transparent
type synonyms, GADT constructor signatures, predicative rank-N signatures, curried definitions,
top-level and mutually recursive local functions, immutable `let`, application, `Int`, `Char`,
`String`, `Bool`, tuples, unit, `if`, `case`, arithmetic, and comparisons. `Char` and `String` use
Unicode code points and functional lists in Core. Single-parameter classes and concrete first-order
instances lower to typed dictionary ADTs; capability resolution selects evidence before upload. The
GPU still performs module name resolution, dependency analysis, inference, coverage checking,
indexed-type refinement, and core lowering.

Within this profile, `newtype` keeps a nominal one-field Core wrapper. That is observationally
equivalent because the frontend does not expose `seq` or `coerce`, but representation erasure
remains a future optimization. `Char` currently shares Core's `i32` representation rather than
introducing a separate runtime scalar kind.

This remains a bounded interoperability profile rather than a Haskell implementation. It does not
yet parse imports, existential types, higher-kinded class parameters, associated-family
declarations, generic or overlapping instances, `do`, or host `IO`. Primitive operators consume the
core's signed `i32` rather than Haskell's overloaded numeric classes. Higher-kinded normalization,
associated family evidence, and algebraic-effect lowering exist in the language-neutral functional
API; a future Haskell frontend can target those contracts without adding Haskell-specific shader
behavior.
