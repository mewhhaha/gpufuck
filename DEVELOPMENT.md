# Development

This guide is for contributors changing gpufuck itself. Consumers embedding the compiler should
start with [README.md](README.md); implementation boundaries and rationale live in
[ARCHITECTURE.md](ARCHITECTURE.md); measured performance lives in [BASELINE.md](BASELINE.md).

## Prerequisites

- Deno 2.9 or newer;
- a WebGPU adapter exposed to Deno;
- Deno's unstable WebGPU API, already enabled by this repository's `deno.json`.

Optional: `just` plus `tree-sitter` and Helix for the Lazuli editor-support recipes.

No dependency installation step is needed. Deno resolves the pinned imports in `deno.json` and
`deno.lock`.

## Repository map

| Path                         | Responsibility                                                     |
| ---------------------------- | ------------------------------------------------------------------ |
| `functional.ts`              | Complete published language-neutral API                            |
| `core.ts`                    | Surface/Core contracts and GPU compilation, without the evaluator  |
| `src/functional/`            | Functional ABI, compiler facade, linking, contracts, evaluator     |
| `src/semantic/`              | Host lowering plan, GPU shaders, runners, and the inference oracle |
| `src/webgpu.ts`              | Device request, required limits, and setup diagnostics             |
| `src/gleam_functional/`      | Repository-only Gleam parser, lowering, and trace adapter          |
| `language/lazuli/`, `gleam/` | Baba grammars and generated parser/editor artifacts                |
| `examples/lazuli/`           | Lazuli sample programs                                             |
| `examples/gleam-functional/` | Gleam sample modules and traces                                    |
| `examples/javascript-aot/`   | JavaScript frontend, grammar, and the pinned Test262 harness       |
| `tests/`                     | Behavioral, differential, stress, growth, and cancellation tests   |
| `benchmarks/`                | Deno benchmark entry points                                        |
| `tools/`                     | Profiling, Gleam stdlib check, and editor-support scripts          |

All JavaScript-specific code lives under `examples/javascript-aot/`. The repository's `src/`
directory stays language-neutral.

## Normal verification loop

Run the focused test for the code being changed first, then the full checks:

```sh
deno test --allow-read tests/functional_compiler_test.ts
deno task fmt
deno task lint
deno task check
deno task test
git diff --check
```

The pinned upstream compatibility checks are separate because they fetch or invoke external
repositories:

```sh
deno task check:gleam-stdlib
deno task check:javascript-test262
```

`check:gleam-stdlib` accepts an existing checkout as its first argument and requires the commit the
tool records, so results cannot silently change with upstream `main`. It is now compile coverage
only — the execution half went with the Wasm backend.

`check:javascript-test262` pins the Test262 checkout and inventories every standalone test under
`test/language`. Its counts are a frontend-readiness baseline, not conformance results: positive
tests are wrapped with an AOT entry, negative tests must fail in their specified phase, and every
ready mode is compiled as a fresh GPU artifact. Time, memory, and compiler-fuel exhaustion are
reported as resource limits rather than semantic compilation failures.

`deno task test` uses `deno test --parallel` with `DENO_JOBS=2`. GPU tests are not ordinary
millisecond unit tests: some deliberately force workspace growth, single-transition dispatches,
device-limit failures, or cancellation. Individual stress tests can take 20–40 seconds; that is
expected when the test name describes one of those boundaries, and it is not the latency of a normal
compilation. Do not raise `DENO_JOBS` blindly — each worker owns WebGPU pipelines and buffers, and
more workers can increase device contention. Measure the full suite on the active adapter first.

## Test ownership

Tests are grouped by externally observable contract: `functional_compiler_test.ts` for surface
packing, GPU diagnostics, inference, batches, and cancellation;
`functional_language_features_test.ts` for Core semantics through compile-and-evaluate;
`lazuli_gpu_workspace_test.ts` for arena growth, device bounds, cleanup, and exact fuel;
`lazuli_gpu_diagnostic_parity_test.ts` for shader-versus-oracle parity; `semantic_*_test.ts` for
host lowering plans and dependency-wave schedules; and the frontend-named files for source-language
behavior and trace stability.

`inferLazuliTypes` in `src/semantic/type_inference.ts` is a differential oracle and the CPU column
in BASELINE.md. Production inference must remain on the GPU path; do not turn the oracle into an
implicit CPU fallback. When adding a regression test, assert through a public boundary. Internal
instrumentation exists for deterministic dispatch, fuel, workspace, and cancellation tests, but must
not be exported through `functional.ts`.

## Generated parsers

Canonical grammars are `language/<name>/grammar.baba` and
`examples/javascript-aot/language/grammar.baba`. Regenerate with `deno task generate:lazuli`,
`generate:gleam`, or `generate:javascript-aot` after a grammar or metadata change, and review both
the grammar diff and the generated diff. Generated output is excluded from formatting.
`just install` builds and installs the Tree-sitter parser and Helix queries into the user's Helix
configuration; it is a local developer action and must never run in automated tests or publishing.

## Adding or changing a frontend

A frontend stays outside the semantic engine: parse into a source-specific AST with UTF-8 byte
spans, enforce the rules Functional Core does not represent, lower to `FunctionalSurfaceDefinition`
and `FunctionalSurfaceTypeDeclaration` values, select strict or lazy evaluation deliberately,
translate neutral diagnostics back to source terminology, and add an accepted program, a rejected
program, and an end-to-end evaluation test.

Keep parsing and desugaring out of `src/functional/` — that directory is target-neutral and cannot
acquire rules named after a source language. Reusable elaboration belongs beside the target
contracts; `recursive_groups.ts` is the model. Do not extend the packed ABI when a bounded
elaboration preserves the same semantics.

## Changing the packed ABI

The packed surface, resolved Core, and type metadata are compatibility boundaries. Before changing
one: identify every encoder, shader decoder, host decoder, trace renderer, and test that consumes
the record; reuse reserved words when the change is compatible; increment the ABI version when old
data cannot be interpreted safely; add malformed-buffer and round-trip coverage; and verify
evaluator behavior separately from inference behavior. The module ABI is `src/functional/abi.ts` and
the canonical linked-preorder type metadata is `src/semantic/type_schema_abi.ts`. Never silently
accept a record from an unknown ABI version.

## Changing GPU semantic compilation

The semantic compiler is a persistent bounded state machine. Preserve these invariants:

- one charged transition performs constant-bounded semantic work, inspecting at most one logical
  record or edge and allocating at most one record per arena;
- work frames survive dispatch boundaries;
- workspace growth does not reset phase, results, or fuel, and growth yields consume no fuel;
- cancellation is observed between bounded dispatches;
- every failure or cancellation path destroys owned temporary buffers;
- device loss and internal invariant violations propagate rather than becoming source diagnostics.

WGSL has no recursion, restricts portable integer and floating-point facilities, and rejects
unbounded `loop` inside a value-returning function, so new operations must be explicit durable
frames or explicitly bounded walks. An input-sized loop hidden inside one transition invalidates the
latency and cancellation guarantees even if total work still looks linear.

Shader creation calls `getCompilationInfo()` and reports WGSL diagnostics before pipeline creation.
Runtime validation scopes must attach enough buffer sizes, adapter limits, and operation context to
distinguish source exhaustion from infrastructure failure. After shader changes, run
`deno task
check`, the GPU parity, workspace, and concurrent-compilation tests, and then
`deno task test`.

## Benchmarks and profiling

```sh
deno task bench:throughput
deno task bench:lazuli
deno task bench:semantic-wavefront
deno task profile:lazuli-compiler
```

`bench:throughput` produces the numbers in [BASELINE.md](BASELINE.md) and decides whether a change
to the GPU path was worth making. Report **marginal cost per module**, not total wall time: both
paths pay the same host parse, so a total-wall-time ratio flatters the GPU. Update BASELINE.md in
the same commit as any change that moves it.

`profile:lazuli-compiler` separates cold WebGPU initialization, frontend preparation, semantic
dispatch, readback, batch behavior, and definition-level work and span. `bench:semantic-wavefront`
separates latency from sustained device-resident throughput — do not use a resident-throughput
number to claim lower single-compilation latency. Record the adapter description and whether it is a
software fallback; software adapters are useful for correctness and synchronization analysis but do
not predict hardware latency.

Run benchmarks on the same machine, adapter, power state, Deno version, and workload before and
after. Investigate a median regression greater than 25% before accepting it; small absolute changes
near timer resolution need more samples, not a percentage-only conclusion.

## Diagnostics and cleanup

Expected source failures use typed results and stable diagnostic families. API contract violations,
device failures, and internal invariant failures throw. Cancellation rejects with the caller's abort
reason. Constructs the GPU evaluator cannot execute throw a `TypeError` naming the construct — do
not approximate them.

Resource ownership must be visible in control flow: a successful compiled module owns its persistent
GPU buffers and callers destroy it in `finally`; evaluators own and release only per-run buffers;
workspace replacement owns both buffers until a successful copy transfers the active state. Do not
catch a WebGPU error merely to return a generic source diagnostic — enrich and rethrow it, or
translate it at the boundary with its original `cause` preserved.

## Publishing

The manifest is `deno.json` and the public entry is `functional.ts`. Run `deno task fmt`, `lint`,
`check`, and `test`, then `git diff --check` and `deno task publish:dry-run`. Before changing the
version, confirm the README examples use only public exports, confirm every module reachable from
`functional.ts` and `core.ts` is listed under `publish.include`, include documentation and license
changes, document ABI changes, and inspect the dry-run package for repository-only frontends or
generated artifacts that should not ship. The release workflow publishes only tags whose
`v<version>` name exactly matches `deno.json`.

## Commit scope

Keep generated changes, ABI migrations, performance work, and documentation reorganizations easy to
review. Preserve unrelated worktree changes. A commit should state one intent, and its tests should
make that intent observable.
