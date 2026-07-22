# JavaScript AOT frontend

This experiment parses a closed ES module with Baba, lowers JavaScript control flow into the
language-neutral Functional Surface, resolves and typechecks it on WebGPU, and emits ordinary Wasm.
All JavaScript-specific code lives in this example: `src/` contains the frontend, `language/`
contains the Baba grammar and generated parser, and `check_test262.ts` owns the pinned conformance
harness. The repository's `src/` directory remains language-neutral. Run the example with:

```sh
deno task run:javascript-aot examples/javascript-aot/number_pipeline.mjs
```

The executable slices support exported, private, local, and mutually recursive function
declarations; anonymous, named, and single-parameter arrow closures; `const`, `let`, and hoisted
`var` bindings; assignment; `while` and classic `for` loops; single-statement bodies; `break`;
`continue`; evaluated expression statements; `return`; block-scoped `if`/`else`; conditional
expressions; Boolean short-circuiting; strings; `null` and `undefined`; lexical `throw`,
`try`/`catch`, and `finally`; standard error values and `instanceof`; immutable object shapes;
homogeneous array literals; indexing; `.length`; `.map`; `.reduce`; and JavaScript `number`
arithmetic, comparison, remainder, bitwise, and shift operations. Literal unary coercion, statically
decidable `typeof`, standard radix literals, and numeric separators are also supported. Mutable
source bindings and loops lower to immutable SSA-style bindings and local recursive Core functions.
Arrays and their higher-order methods lower to a generic algebraic Core type and ordinary recursive
definitions. The entry is an exported zero-argument `main` function or constant.

Programs that require object identity or property writes use a separate runtime-model lowering path.
It represents every JavaScript value with one tagged `Value` type and threads explicit state through
evaluation. The state owns a persistent heap of identity-bearing ordinary and callable objects,
string and symbol property keys, data and accessor descriptors, prototypes, lexical environments,
and normal, return, throw, break, and continue completion records. This path executes object
allocation, strict equality and SameValue, own and inherited property reads, dot and string-index
writes, hoisted `var`, function objects with captured environments, calls, and cross-call throws
caught by lexical `catch`. Identity exhaustion and dangling prototypes fail deterministically.

This is a statically inferable AOT profile, not general JavaScript yet. Dynamic conditions and
logical operands currently must be Boolean; statically known primitives and objects use JavaScript
truthiness. Calls cannot rely on missing or ignored arguments. The parser applies automatic
semicolon insertion at eligible line terminators and before a closing brace while preserving the
restricted line-terminator behavior after `return`. Runtime environments map lexical names to stable
binding-cell identities in a state-threaded store. Mutable captures, recursive named function
expressions, and mutually recursive function declarations therefore observe the same current binding
instead of copying an environment snapshot. Throws propagate through lexical blocks and eligible
function calls, including supported Test262 `assert.throws` callbacks. General descriptor mutation
and accessor dispatch, imports, general dynamic coercion, mutable or heterogeneous arrays, classes,
generators, and async execution remain subsequent vertical slices. Runtime-model lowering also
retains a temporary 128-syntax-node/three-branch admission bound while remaining CPS joins become
explicit evaluation results. Runtime globals are not generally implicit; the frontend currently
recognizes only the immutable numeric globals and statically known `typeof` cases. Dynamic code
generation through `eval` or `Function` is rejected before GPU compilation.

The compatibility target is the complete applicable Test262 `test/language` corpus, not an informal
JavaScript subset. `deno task check:javascript-test262` checks out the pinned upstream revision and
reports the complete inventory, including strict and non-strict execution modes, negative-test
phases, modules, async tests, current frontend readiness, and the intentional dynamic-code
exclusion. Every ready required mode is compiled to a fresh artifact and executed. Readiness is
deliberately not labeled conformance: a test passes only once the runner can execute its harness and
observe the required result or exact failure phase.

At the pinned revision, 1,970 required positive execution modes currently pass frontend lowering,
GPU compilation, and Wasm execution. This number is a progress baseline, not a conformance claim;
30,952 modes still need parser coverage, 2,775 still need lowering or runtime facilities, and 4,511
negative tests still need exact phase verification.
