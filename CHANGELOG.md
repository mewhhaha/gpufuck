# Changelog

All notable changes to gpufuck are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

This release narrows the project toward one purpose: being a fast compiler on the GPU. Roughly
49,000 net lines of non-documentation code were removed. It is a large, deliberate reduction in
capability, and the compiler is not yet fast — see [BASELINE.md](BASELINE.md).

The WebAssembly backend was removed during this cycle and restored before release. It stays because
Ducklang compiles through it and has no other code generator; it imports `functional.ts` by relative
path, so there is no version for it to pin to.

### Removed

- Removed the Haskell, OCaml, Rust, 1SubML, and PureScript frontends and the Brainfuck GPU compiler.
- Removed incremental compilation and its persistent caches, so every compilation is cold.
- Removed row types, existentials, the capability resolver, and constraint elaboration.
- Removed Type Core apart from `type_core_contract.ts`, which the comptime constant encoder needs.
- Removed Effect Core from the public API. Its modules are still in `src/functional/`, but nothing
  imports them and neither entry point exports them.
- Removed partial evaluation.
- Removed the browser playground and its GitHub Pages workflow.
- Removed the `src/lazuli/` re-export shim; its implementation files now live in `src/semantic/`.
- Reduced the published subpaths to `.` (`functional.ts`) and `./core` (`core.ts`). The `wasm`,
  `comptime`, `effects`, and `type-services` subpaths no longer exist; the WebAssembly backend,
  storage planning, and the comptime executor are exported from the root instead.

### Changed

- `GpuFunctionalEvaluator.evaluate` now selects a runtime instead of rejecting programs. It inspects
  resolved Core before dispatch and delegates programs needing 64-bit floats, portable whole-number
  f64, text, bytes, runtime faults, buffer append, stores, structural equality, 32-bit float
  division, or 32-bit square root to bounded WebAssembly execution; everything else runs on the GPU
  evaluator. Callers pass no flag. The delegated path rejects the GPU-only dispatch, heap, and stack
  options with a `TypeError` and caps semantic steps at 1,000,000.
- Gleam's `Int` now lowers to 64-bit integers instead of the f64-backed JavaScript model. Division
  and remainder keep Gleam's rules: a zero divisor yields `0`, and division truncates toward zero.
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
