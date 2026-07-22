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
definitions. Runtime calls preserve extra arguments and expose an `arguments` object; simple,
default, object-binding, array-binding, and sole rest parameters share that call-frame model. Object
methods, basic classes with constructors and instance methods, straight-line generators, and
deterministic fulfilled async functions are executable. The entry is an exported zero-argument
`main` function or constant.

Frontend admission is deliberately bounded before generated-parser or recursive lowering work:
source is limited to 256 KiB of UTF-8, token streams to 8,192 tokens, delimiter and prefix-operator
nesting to 256, automatic semicolon insertion to four sites, and active AOT `try` continuations to
128. Inputs beyond those boundaries produce ordinary parse or lowering diagnostics.

Programs that require object identity or property writes use a separate runtime-model lowering path.
It represents every JavaScript value with one tagged `Value` type and threads explicit state through
evaluation. The state owns a persistent heap of identity-bearing ordinary and callable objects,
string and symbol property keys, data and accessor descriptors, prototypes, lexical environments,
and normal, return, throw, break, and continue completion records. This path executes object
allocation, strict equality and SameValue, own and inherited property reads, dot and string-index
writes, hoisted `var`, function objects with captured environments, calls, and cross-call throws
caught by lexical `catch`. Identity exhaustion and dangling prototypes fail deterministically.

Object records and stable binding cells live in Functional Core `Store` values, so lookup and
updates are checked indexed operations instead of recursive host-side lists. Name and property
access lower through explicit ECMAScript-style Reference records. Property writes follow ordinary
prototype descriptors, reject inherited non-writable properties, and create persistent own
properties on eligible receivers. Runtime state carries an explicit execution context containing its
lexical and variable environments, `this` value, and realm. Each realm owns a global object;
callable objects retain their creation realm and captured lexical environment while the existing CPS
lowering represents the execution-context stack. Property calls preserve their receiver as `this`;
strict bare calls receive `undefined`, non-strict bare calls receive the realm global object, and
arrow functions retain the lexical `this` from their creation context. The runtime profile also
supports `Function.prototype.call`, nullish-list `apply`, and `bind` without bound arguments. Bound
functions preserve their target's strictness and cannot be rebound by a later call.

The runtime profile recognizes `Object.defineProperty(object, "name", descriptor)` when the key and
descriptor shape are statically visible. Accessor descriptors may provide `get`, `set`,
`enumerable`, and `configurable`; getter and setter functions run through ordinary callable dispatch
with the property receiver as `this`. Their heap and binding updates persist, and thrown values
propagate through the same completion path as direct calls. Literal-string
`String.prototype.replace` supports a string or callable replacement; callable replacements receive
the matched text, match offset, and source string.

This is a statically inferable AOT profile, not general JavaScript yet. Dynamic conditions and
logical operands currently must be Boolean; statically known primitives and objects use JavaScript
truthiness. Calls cannot rely on missing or ignored arguments. The parser applies automatic
semicolon insertion at eligible line terminators and before a closing brace while preserving the
restricted line-terminator behavior after `return`. Runtime environments map lexical names to stable
binding-cell identities in a state-threaded store. Mutable captures, recursive named function
expressions, and mutually recursive function declarations therefore observe the same current binding
instead of copying an environment snapshot. Throws propagate through lexical blocks and eligible
function calls, including supported Test262 `assert.throws` callbacks. Generator admission is
intentionally bounded to straight-line `yield` statements plus one final return; it lowers to a
durable iterator state machine. Async functions currently model deterministic fulfilled values and
immediate `then` delivery, not the ECMAScript job queue, rejection propagation, or suspension over
host work. Basic classes do not yet provide inheritance, prototype sharing, private fields, or
static initialization. General descriptor redefinition, data descriptors through
`Object.defineProperty`, imports, and the remaining dynamic coercions are subsequent vertical
slices. Runtime globals are not generally implicit; the frontend currently recognizes only the
immutable numeric globals and statically known `typeof` cases. Dynamic code generation through
`eval` or `Function` is rejected before GPU compilation.

The compatibility target is the complete applicable Test262 `test/language` corpus, not an informal
JavaScript subset. `deno task check:javascript-test262` checks out the pinned upstream revision and
reports the complete inventory, including strict and non-strict execution modes, negative-test
phases, modules, async tests, current frontend readiness, and the intentional dynamic-code
exclusion. Every ready required mode is compiled to a fresh artifact and executed. Readiness is
deliberately not labeled conformance: a test passes only once the runner can execute its harness and
observe the required result or exact failure phase. Negative probes distinguish parse, resolution,
and runtime expectations and reject a failure at the wrong phase; runtime-ready negatives retain
their expected error type for execution validation. Frontend probing runs in bounded subprocess
batches so generated-parser and lowering state cannot accumulate across the complete corpus.

At the pinned revision, all 2,047 frontend-ready positive execution modes pass GPU compilation and
Wasm execution. This number is a progress baseline, not a conformance claim: 30,991 modes still need
parser coverage, 2,659 still need lowering or runtime facilities, and the negative corpus still
needs complete execution coverage after phase-aware frontend admission.
