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

Three surface primitives, each because two unrelated frontends hand-rolled the same workaround.

- `surface.at(span)` returns a builder that stamps a span on the node each helper produces. Every
  surface node kind already carried an optional span, but no builder emitted one, so Gleam abandoned
  the builder and hand-wrote node literals at 116 span sites while Ducklang emitted no spans at all
  and got location-free diagnostics. Only the outermost node of a fold or desugaring is stamped;
  attributing a source range to a node the builder synthesized would be a wrong location.
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
- `GpuEvaluator.evaluate` now selects a runtime instead of rejecting programs. It inspects resolved
  Core before dispatch and delegates programs needing 64-bit floats, portable whole-number f64,
  text, bytes, runtime faults, buffer append, stores, structural equality, 32-bit float division, or
  32-bit square root to bounded WebAssembly execution; everything else runs on the GPU evaluator.
  Callers pass no flag. The delegated path rejects the GPU-only dispatch, heap, and stack options
  with a `TypeError` and caps semantic steps at 1,000,000.
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
