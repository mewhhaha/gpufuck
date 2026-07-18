# Changelog

All notable changes to gpufuck are documented here. The project follows
[Semantic Versioning](https://semver.org/).

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
