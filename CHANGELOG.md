# Changelog

All notable changes to gpufuck are documented here. The project follows
[Semantic Versioning](https://semver.org/).

## Unreleased

- Added a portable immutable `F32x4` library and opt-in native Wasm SIMD lowering for arithmetic,
  masks, lane operations, reductions, vectorizable higher-order operations, and private unboxed
  vector workers, including linked modules, with automatic scalar fallback at lazy boundaries.
- Expanded the experimental Haskell frontend with transparent type synonyms, `newtype`, Unicode
  `Char` and `String` literals, predicative rank-N signatures, and mutually recursive local groups.
- Added an explicit, non-default WasmGC backend for pure closed Functional Core modules, including
  typed algebraic values, closures, shared lazy thunks, recursive closure cycles, wide numerics,
  bounded structured-result decoding, and blackhole diagnostics.
- Added conservative unique-ownership resolution for complete immutable Storage Core traces,
  including transitive last-use releases, escaping graphs, and exact-size reuse planning.
- Added resolved-Core uniqueness and path-liveness analysis that reuses compatible strict
  constructor allocations in Wasm while retaining fresh allocation for aliases, lazy values, owned
  exports, captures, and layout changes.
- Hardened Component Model WIT generation against identifier collisions, malformed resources, empty
  variants, and cyclic or excessively deep type schemas.

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
