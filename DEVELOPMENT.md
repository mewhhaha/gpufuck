# Development

This guide is for contributors changing gpufuck itself. Consumers embedding the compiler should
start with [README.md](README.md); implementation boundaries and rationale live in
[ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

Required for the normal verification loop:

- Deno 2.9 or newer;
- a WebGPU adapter exposed to Deno;
- Deno's unstable WebGPU API, already enabled by this repository's `deno.json`.

Optional tools:

- `just` for Lazuli editor-support recipes;
- `tree-sitter` and Helix for `just install`;
- Zig for `deno task compare:type-programming`;
- a hardware GPU for representative performance measurements.

No dependency installation step is needed. Deno resolves the pinned imports in `deno.json` and
`deno.lock`.

## Repository map

| Path                      | Responsibility                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `functional.ts`           | Published language-neutral API                                                               |
| `src/functional/`         | Functional ABI, optional IRs, compiler facade, linking, caches, evaluator, and Wasm backend  |
| `src/lazuli/`             | Shared packed semantic engine plus Lazuli compatibility API                                  |
| `language/lazuli/`        | Baba grammar and generated parser/editor artifacts                                           |
| `examples/functional-ir/` | Direct target-API examples                                                                   |
| `examples/*-functional/`  | Independent source-language frontend examples and traces                                     |
| `src/gleam_functional/`   | Repository-only Gleam parser, strict lowering, module artifacts, and trace adapter           |
| `src/purescript_profile/` | Repository-only stress profile for rows, capabilities, associated types, and rank-2 checking |
| `tests/`                  | Behavioral, differential, stress, cancellation, growth, and Wasm execution tests             |
| `benchmarks/`             | Deno benchmark entry points                                                                  |
| `tools/`                  | Profiling, comparison, parser, and editor-support scripts                                    |

The published package exports `functional.ts`. Repository-only compatibility and language example
entry points are intentionally separate.

## Normal verification loop

Run the focused test for the code being changed first, then the full checks:

```sh
deno test --allow-read tests/functional_wasm_test.ts
deno task fmt
deno task lint
deno task check
deno task test
git diff --check
```

`deno task test` uses `deno test --parallel` with `DENO_JOBS=2`. GPU tests are not ordinary
millisecond unit tests: some deliberately force workspace growth, single-transition dispatches,
device-limit failures, cancellation, or complete cross-backend execution. Individual stress tests
can take 20–40 seconds. That duration is expected when the test name describes one of those
boundaries; it is not the expected latency of a normal compilation.

Use Deno's filter for a focused iteration:

```sh
deno test --allow-read tests/lazuli_gpu_workspace_test.ts \
  --filter "grows each exhausted arena"
```

Do not increase test parallelism blindly. Each test worker can own WebGPU pipelines, buffers, and
readbacks. More CPU workers may increase device contention and make the suite slower or less
deterministic. Measure the full suite on the active adapter before changing `DENO_JOBS`.

## Test ownership

Tests are grouped by externally observable contract:

| Test family                                            | Contract                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------- |
| `functional_compiler_test.ts`                          | Surface packing, GPU diagnostics, inference, batches, cancellation         |
| `functional_wasm_test.ts`                              | Resolved Core to Wasm semantics, ABI, effects, host calls, specialization  |
| `functional_comptime_test.ts`                          | Required execution, generated IR, partial evaluation, incremental comptime |
| `functional_effect_core_test.ts`                       | Effect Core verification and lowering                                      |
| `functional_type_program_test.ts`, `type_core_test.ts` | Type normalization, capability evidence, Type Core execution               |
| `lazuli_gpu_workspace_test.ts`                         | Elastic arena growth, device bounds, cleanup, exact fuel                   |
| `lazuli_gpu_diagnostic_parity_test.ts`                 | GPU/TypeScript oracle parity                                               |
| `*_functional_test.ts`                                 | Source-language frontend behavior and trace stability                      |

The TypeScript inference implementation is a differential oracle. Production semantic inference must
remain on the GPU path; do not turn the oracle into an implicit CPU fallback.

When adding a regression test, assert through a public boundary where possible. Internal
instrumentation exists for deterministic dispatch, fuel, workspace, and cancellation tests, but it
must not be exported through `functional.ts`.

## Generated Lazuli files

The canonical grammar is `language/lazuli/grammar.baba`. Regenerate its parser after grammar or
metadata changes:

```sh
deno task generate:lazuli
```

Generated output under `language/lazuli/generated/` is excluded from formatting. Review both the
grammar change and generated diff.

To build and install the Tree-sitter parser and Helix queries:

```sh
just install
```

The individual recipes are:

```sh
just helix
just install-helix
```

`just install` writes to the user's Helix configuration. It is a local developer action and must not
be part of automated tests or publishing.

## Adding or changing a frontend

A source-language frontend should stay outside the semantic engine. A complete frontend change
usually includes:

1. Parse into a source-specific AST with UTF-8 byte spans.
2. Enforce source-language rules not represented by Functional Core.
3. Lower to `FunctionalSurfaceDefinition`, `FunctionalSurfaceTypeDeclaration`, optional Type Core,
   or Effect Core values.
4. Select strict or lazy evaluation deliberately.
5. Translate neutral diagnostics back to source files and terminology.
6. Add a small accepted program, a rejected program, and an end-to-end Wasm execution test.
7. Add or update a trace showing source, normalized surface, packed ABI, and resolved Core.

Repository grammars use Baba and keep generated Wasm parser artifacts beside their source under
`language/<frontend>/generated/`. Run the matching `generate:<frontend>` task after changing a
grammar, and keep cursor-to-AST conversion in the frontend rather than the neutral compiler.

Keep parsing and desugaring out of `src/functional/`. That directory is target-neutral and cannot
acquire rules named after Lazuli, Haskell, Rust, OCaml, or another source language.

Reusable elaboration belongs beside the target contracts. `recursive_groups.ts` lambda-lifts local
SCCs, `constraint_elaboration.ts` inserts normalized capability evidence, `row_types.ts` closes
record/variant/effect rows, and `existential.ts` builds fixed-eliminator packages. These passes must
produce ordinary surface constructs; do not extend the packed ABI when a bounded elaboration can
preserve the same semantics.

## Changing the packed ABI

The packed surface, resolved Core, type metadata, and Wasm value ABI are compatibility boundaries.
Before changing one:

- identify every encoder, shader decoder, host decoder, cache fingerprint, trace renderer, and test
  that consumes the record;
- reuse reserved words when the change is compatible;
- increment the relevant ABI or cache-format version when old data cannot be interpreted safely;
- add malformed-buffer and round-trip coverage;
- verify evaluator behavior separately from inference behavior.

The Functional module ABI is declared in `src/functional/abi.ts`. Canonical linked-preorder type
metadata is encoded and decoded by `src/lazuli/type_schema_abi.ts`. The public structured Wasm
boundary is in `src/functional/wasm_abi.ts` and `src/functional/wasm_value_codec.ts`.

Never silently accept a record from an unknown ABI version.

## Changing GPU semantic compilation

The semantic compiler is a persistent bounded state machine, not one invocation-sized shader
algorithm. Preserve these invariants:

- one charged transition performs constant-bounded semantic work;
- a transition inspects at most one logical record or edge and allocates at most one record per
  arena;
- work frames survive dispatch boundaries;
- workspace growth does not reset phase, results, or fuel;
- growth yields do not consume semantic fuel;
- cancellation is observed between bounded dispatches;
- every failure or cancellation path destroys owned temporary buffers;
- device loss and internal invariant violations propagate rather than becoming source diagnostics.

WGSL has no recursion and restricts portable integer and floating-point facilities. New inference
operations must therefore be expressed as explicit durable frames. An input-sized loop hidden inside
one transition invalidates the latency and cancellation guarantees even if total work still looks
linear.

After shader changes, run at least:

```sh
deno task check
deno test --allow-read tests/lazuli_gpu_diagnostic_parity_test.ts
deno test --allow-read tests/lazuli_gpu_workspace_test.ts
deno test --allow-read tests/lazuli_concurrent_compilation_test.ts
deno task test
```

Shader creation calls `getCompilationInfo()` and reports WGSL compiler diagnostics before pipeline
creation. Runtime WebGPU validation scopes must attach enough buffer sizes, adapter limits, and
operation context to distinguish source exhaustion from infrastructure failure.

## Changing Wasm emission

Wasm code generation starts from GPU-resolved Core. Preserve source evaluation semantics first;
representation and specialization are secondary.

Relevant seams:

- `wasm_function_analysis.ts`: function shapes, reachability, tail calls, numeric folds;
- `wasm_capture_analysis.ts`: lexical captures and environment layout;
- `wasm_lambda_sets.ts`: finite callee-set analysis and specialization limits;
- `wasm_codegen.ts`: orchestration and expression emission;
- `wasm_host_emitter.ts`: built-in host-buffer literals and intrinsic emission;
- `wasm_runtime_binary.ts`: allocator, thunk forcing, and runtime support bodies;
- `wasm_runtime_layout.ts`: shared runtime global indices and allocator markers;
- `wasm_value_codec.ts`: public argument and result representation;
- `wasm_execution.ts`: compilation cache, instantiation, sync/async execution, and fault
  translation.

Every optimization needs an end-to-end semantic test. For lazy code, include a case whose result
would diverge or fault if the optimizer accidentally forced an unused value. For scalar fast paths,
inspect both behavior and artifact shape. Compiler statistics belong beside cached artifacts, not in
production Wasm exports.

## Benchmarks and profiling

Run benchmarks on the same machine, adapter, power state, Deno version, and workload before and
after a performance change:

```sh
deno task bench:lazuli
deno task bench:functional-wasm
deno task bench:functional-comptime
deno task profile:lazuli-compiler
```

`profile:lazuli-compiler` separates cold WebGPU initialization, frontend preparation, semantic
dispatch, readback, and batch behavior. Record the adapter description and whether it is a software
fallback. Software adapters are useful for correctness and synchronization analysis but do not
predict hardware-GPU latency.

For code-generation changes, measure at least:

- source-to-Wasm latency after compiler warm-up;
- Wasm byte length;
- instantiation latency;
- first execution;
- repeated execution on the same instance;
- allocation and thunk counts where applicable;
- a recomputing entry separately from a retained-value entry.

Do not compare a memoized result against a recomputing implementation as if it measured code
quality. Record semantic differences in the benchmark description.

Investigate a median regression greater than 25% on the same machine before accepting it. Small
absolute changes near timer resolution need more samples rather than a percentage-only conclusion.

## Diagnostics and cleanup

Expected source failures use typed results and stable diagnostic families. API contract violations,
device failures, and internal invariant failures throw. Cancellation rejects with the caller's abort
reason.

Resource ownership must be visible in control flow:

- a successful compiled module owns its persistent GPU buffers;
- callers destroy compiled modules in `finally`;
- evaluators own and release only per-run buffers;
- workspace replacement owns both buffers until a successful copy transfers the active state;
- cache entries contain portable bytes and metadata, never live `GPUBuffer` objects.

Do not catch a WebGPU or Wasm error merely to return a generic source diagnostic. Either enrich and
rethrow it or translate it at the boundary with its original `cause` preserved.

## Publishing

The package manifest is `deno.json`; the public entry is `functional.ts`. Validate the exact
published file set with:

```sh
deno task fmt
deno task lint
deno task check
deno task test
git diff --check
deno task publish:dry-run
```

Before changing the version:

- confirm the README examples use only public exports;
- confirm new public modules are listed under `publish.include`;
- include documentation and license changes;
- document ABI or cache-version changes;
- inspect the dry-run package for repository-only frontends or generated artifacts that should not
  ship.

For the first release, create `@mewhhaha/gpufuck` on JSR and link it to the `mewhhaha/gpufuck`
GitHub repository before pushing the version tag. The release workflow publishes only tags whose
`v<version>` name exactly matches `deno.json`; for example, version `0.1.0` must be tagged `v0.1.0`.

## Commit scope

Keep generated changes, ABI migrations, performance work, and documentation reorganizations easy to
review. Preserve unrelated worktree changes. A commit should state one intent, and its tests should
make that intent observable.
