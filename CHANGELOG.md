# Changelog

All notable changes to gpufuck are documented here. Releases up to 0.3.0 were published to JSR under
[Semantic Versioning](https://semver.org/); the project is no longer published, so entries below are
dated rather than versioned.

## Unreleased

This release narrows the project toward one purpose: being a fast compiler on the GPU. Roughly
45,000 net lines of non-documentation code were removed, taking `src/` from 78,209 to 61,195 lines.
It is a large, deliberate reduction in capability, and **the compiler is not yet fast** — nothing in
this release improved compile throughput. See [BASELINE.md](BASELINE.md) for the measurements and
the criteria that would call the approach dead.

The WebAssembly backend was removed during this cycle and restored before release. It stays because
Ducklang compiles through it and has no other code generator; it imports `functional.ts` by relative
path, so there is no version for it to pin to.

### Added

Surface builder coverage, each addition because two unrelated frontends hand-rolled the same
workaround.

- `surface.at(span)` returns a builder that stamps a span on every node each helper produces,
  including the interior spine of a fold or desugaring. Every surface node kind already carried an
  optional span, but no builder emitted one, so Gleam abandoned the builder and hand-wrote node
  literals at 116 span sites while Ducklang emitted no spans at all and got location-free
  diagnostics. Stamping only the outermost node lost one span per curried lambda parameter and per
  extra application argument, which is exactly what the hand-written literals had kept. `case` arms
  and the `otherwise` default carry spans of their own, so `at` fills in only the ones a caller left
  blank rather than overwriting a more precise arm span.
- `surface.let`, `surface.if`, and `surface.case` cover the binding, branching, and matching shapes
  the value helpers could not reach. They elaborate nothing — these are Core shapes already — but
  without them a lowering fell back to hand-written node literals and had to remember the span on
  each one, which defeats `at`. `let-rec` and `let-rec-group` have no builder because no frontend
  emits them.
- `surface.lambda` accepts a parameter list as well as a single name, folding right. Definitions and
  recursive bindings already took a list and `apply` already folded a spine, so the inline lambda
  was the only binding form that made a frontend curry by hand.
- A `case` takes an optional `otherwise` arm. Inference rejects a non-exhaustive case, so a frontend
  wanting a fallback had to enumerate the owning type's constructors itself and hoist the fallback
  into a thunk to avoid duplicating it per arm. The expansion binds the scrutinee once, so it is
  evaluated once and can be handed to the arm's binder.

`fixed_vector.ts` and the native SIMD path are exported again, so a frontend can reach `F32x4` with
`{ simd: "wasm-simd" }` and get real `v128` instructions instead of four scalar operations.
`capability_resolver.ts` is also back as the type-resolution primitive.

### Removed

- Removed the Haskell, OCaml, Rust, 1SubML, and PureScript frontends and the Brainfuck GPU compiler.
- Removed incremental compilation and its persistent caches, so every compilation is cold.
- Removed row types, existentials, and constraint elaboration.
- Removed Effect Core. A handler lowered to a closed `A -> B` with no `resume`, so it could not
  express exceptions, generators, async or backtracking, and effects were capped at a 32-bit mask.
  Frontends elaborate effects themselves, as Koka and Eff do.
- Removed partial evaluation.
- Removed the `src/lazuli/` re-export shim. `src/lazuli/` is now the Lazuli frontend itself, moved
  out of `src/semantic/` so the neutral layer holds only the GPU semantic compiler.
- Stopped publishing to JSR, and deleted the release workflow, the version field, and the subpath
  exports with it. Nothing consumed the package: Ducklang, the only external consumer, imports
  `functional.ts` by relative path. `functional.ts` is now the sole entry point — `core.ts` and the
  `wasm`, `comptime`, `effects`, and `type-services` subpaths are gone, and the WebAssembly backend,
  storage planning, and the comptime executor are reachable from the root.

### Changed

- **Every public name lost its `Functional`/`FUNCTIONAL_` prefix.** The module is called
  `functional.ts`; repeating that in `FunctionalSurfaceExpression` and `FUNCTIONAL_NODE_WORD_LENGTH`
  bought nothing a namespace import does not already give. So `SurfaceExpression`, `CoreNode`,
  `WasmExecution`, `NODE_WORD_LENGTH`, `GpuCompiler`, and 359 others. Two names could not simply
  lose the prefix: `FunctionalWasmFunctionType` became `WasmFunctionTypeIndex`, because
  `WasmFunctionType` is the unrelated signature interface in the same file, and the private
  `GpuEvaluator.createBackend` overload became `createWithCollectionSyntax` to make room for the
  public one.
- **The GPU semantic layer no longer speaks a second vocabulary.** `src/semantic/` was named
  `Lazuli*` throughout, from when it was the Lazuli-specific compiler, and `src/functional/abi.ts`
  was a wall of aliases bridging the two. Inspecting the pairs showed they were not all the same
  thing: the word layouts, tags, operators, size constants, `Span`, `Type`, `TypeSchema`,
  `SourceType`, `TypeDeclaration`, and `CoreNode` were genuinely one declaration wearing two names,
  and those collapsed — the wall is now a re-export list. The rest were not aliases at all.
  `LazuliValue` carries `text` and no `float-64`; `GpuLazuliModule` lacks ten fields `GpuModule`
  has; `GpuEvaluator` _wraps_ the GPU backend and adds the Wasm fallback. Those are two layers, not
  two names, so they are now `SemanticValue`, `GpuSemanticModule`, and `GpuSemanticEvaluator` —
  named for the layer they belong to.
- **Diagnostic codes are one namespace.** The semantic layer emitted `L####`, the public API
  `F####`, and three separate sites did `` `F${code.slice(1)}` `` string surgery between them,
  bridged by a mapped type that resolved to `never` if either prefix ever changed. The semantic
  codes are now `F####` too, so the mapped type, the three remaps, and a
  `replaceAll("Lazuli", "functional")` over fault messages are all deleted — the messages say what
  they mean at the point they are written.
- **The Gleam frontend lost the prefix as well.** It was held back from the API-wide rename because
  `GleamFunctional*` plausibly meant "Gleam lowered to Functional Core" — but that is what every
  frontend here does, so the word distinguished nothing. `gleam_functional.ts` and
  `gleam_functional_cli.ts` are now `gleam.ts` and `gleam_cli.ts`, `src/gleam_functional/` is
  `src/gleam/`, `examples/gleam-functional/` is `examples/gleam/`, and all 34 `Gleam*Functional*`
  identifiers dropped the word — `GleamFunctionalExpression` is `GleamExpression`,
  `lowerGleamFunctionalSource` is `lowerGleamSource`, `renderGleamFunctionalTrace` is
  `renderGleamTrace`. The `run:gleam-functional` and `trace:gleam-functional` tasks are `run:gleam`
  and `trace:gleam`, and `generate:gleam` names the generated parser `gleam`.
- **Five test files moved from `lazuli_*` to `semantic_*`.** `concurrent_compilation`,
  `gpu_diagnostic_parity`, `gpu_workspace`, `type_inference`, and `type_schema_abi` test the GPU
  semantic layer, not the Lazuli frontend, and were named after the layer's old name.
  `gleam_functional_test.ts` is `gleam_test.ts` and `tools/profile_lazuli_compiler.ts` is
  `tools/profile_semantic_compiler.ts`, behind the renamed `profile:semantic-compiler` task. The
  files that really do test a frontend — `lazuli_test.ts`, `lazuli_cli_test.ts`, `gleam_test.ts`,
  and the `javascript_*` files — keep their names.
- `GpuEvaluator.evaluate` now selects a runtime instead of rejecting programs. It inspects resolved
  Core before dispatch and delegates programs needing 64-bit floats, portable whole-number f64,
  text, bytes, runtime faults, buffer append, stores, structural equality, 32-bit float division, or
  32-bit square root to bounded WebAssembly execution; everything else runs on the GPU evaluator.
  Callers pass no flag. The delegated path rejects the GPU-only dispatch, heap, and stack options
  with a `TypeError` and caps semantic steps at 1,000,000.
- The GPU evaluator's default heap budget went from `max(256, definitions + nodes * 4)` slots to
  `max(1024, (definitions + nodes * 4) * 8)`. Boxing 64-bit integers did not widen a heap slot — a
  slot is a fixed eight-word record for every kind — it changed how many are allocated: an `i32`
  result is an immediate payload and allocates nothing, while every 64-bit result takes a fresh
  slot, and the heap is a bump allocator with no reclamation inside a run. A node inside a loop or a
  recursive function therefore consumes a slot per evaluation, not one per node, so no static
  per-node factor is exact and the multiplier is a budget, matching the one the Gleam CLI arrived at
  empirically after its kernel example exhausted the old default.

  The floor stays at 1024 rather than following the CLI to 4096, because it sets the batch ceiling:
  `evaluateBatch` sums per-lane heap slots into one buffer and throws a `RangeError` past
  `maxStorageBufferBindingSize`. Measured on a 128 MiB binding limit, a 4096-slot floor caps a batch
  at 1024 lanes and a 1024-slot floor caps it at 4096. The floor only binds for modules under
  roughly 128 nodes, and those are exactly the ones a caller batches by the thousand; real programs
  clear it on the multiplier alone. Neither number is principled — heap demand tracks the i64 values
  produced during evaluation, so it correlates with the step budget rather than the node count, and
  a step-proportional heap is the honest fix.
- Gleam's `Int` now lowers to 64-bit integers instead of the f64-backed JavaScript model. Division
  and remainder keep Gleam's rules: a zero divisor yields `0`, and division truncates toward zero.
- `renderCompilationTrace` renders 64-bit values as exact unquoted digits. They arrive as BigInt,
  which `JSON.stringify` refuses; quoting them would change the shape every checked-in trace uses
  and routing them through `Number` would lose precision past 2^53.
- `requestWebGpuDevice()` now requests `maxStorageBuffersPerShaderStage` of 16, clamped to adapter
  support, and opts into `timestamp-query` when the adapter exposes it.
- Documented the measured baseline and its kill criteria in `BASELINE.md`, and corrected the
  long-standing claim that name resolution runs on the GPU. It runs on the host, in
  `src/semantic/symbol_lookup.ts`; the shader copies the resulting lowering plan.

## 0.3.0 - 2026-07-19

- Expanded the Baba-based Gleam frontend to compile all 1,521 pinned JavaScript-targeted stdlib
  tests and execute the 444 tests whose reachable definitions require no runtime adapter.
- Added linked-definition elimination and tail-position constructor-case lowering to reduce emitted
  Wasm while retaining reachable `Init` capabilities and rewritten module-boundary representations.
- Added specialized polymorphic host operations, semantic-to-runtime representation contracts,
  checked erased values with runtime type descriptors, opaque resource tables, and portable
  bit-precise buffers.

## 0.2.0 - 2026-07-19

- Added first-class static text and bytes, structural equality, and explicit located runtime faults
  across Functional Surface, GPU inference, compile-time IR, and Wasm execution.
- Added nominal type and constructor module interfaces with incremental dependency tracking.
- Added direct host-bound definitions for source-language external functions.
- Expanded the Gleam frontend with inferred module interfaces, labeled calls and records, guards,
  multiple-subject cases, exact lists, bit arrays, panic, and JavaScript externals.
- Added f64-backed whole-number primitives for Gleam-compatible `Int`, direct text and byte
  concatenation, destructuring lets, exact and prefix string patterns, float patterns, module
  aliases, external opaque types, and target-specific fallback bodies.
- Added a pinned upstream Gleam stdlib execution check and value-level differential coverage against
  the official Gleam JavaScript backend.

## 0.1.0 - 2026-07-18

Initial public release.

- Added the language-neutral Functional Surface, resolved Functional Core, Type Core, and Effect
  Core contracts.
- Added GPU name resolution, dependency analysis, type inference, indexed constructor checking, case
  coverage, and bounded compile-time execution.
- Added strict and call-by-need evaluation, mutually recursive groups, explicit thunks, rank-N
  boundaries, higher-kinded normalization, capability evidence, existential packages, and shared
  record, variant, and effect rows.
- Added whole-program Wasm emission with reachability analysis, compact scalar workers, tail-loop
  lowering, lambda-set specialization, structured values, host capabilities, and async effects.
- Added typed static linking, incremental compilation, persistent caches, deterministic diagnostics,
  cancellation, and elastic GPU workspaces.
- Added verified Storage Core manifests, lexical arenas, owned promotion, deterministic recursive
  destruction, and opt-in standalone Wasm retain/drop exports.
- Added Rust-profile move checking and explicit frontend borrows that erase after ownership proof.
