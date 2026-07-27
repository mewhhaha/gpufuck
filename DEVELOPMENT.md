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

| Path                         | Responsibility                                                         |
| ---------------------------- | ---------------------------------------------------------------------- |
| `functional.ts`              | The complete language-neutral API, and the only entry point for it     |
| `src/functional/`            | Functional ABI, compiler facade, linking, contracts, evaluator         |
| `src/functional/wasm_*.ts`   | WebAssembly code generators, binary emitter, runtime, host boundary    |
| `src/functional/storage_*`   | Storage plan and Storage Core verification behind the backend          |
| `src/functional/comptime*`   | Bounded compile-time execution over compiled Core                      |
| `src/semantic/`              | Host lowering plan, GPU shaders, runners, and the inference oracle     |
| `src/webgpu.ts`              | Device request, required limits, and setup diagnostics                 |
| `src/lazuli/`                | Repository-only Lazuli parser, compiler, and surface adapter           |
| `src/sweep/`, `sweep.ts`     | Sweep: the language DESIGN.md argues for, with its parser and lowering |
| `sweep_cli.ts`               | Runs one Sweep program; not part of the API                            |
| `src/gleam/`                 | Repository-only Gleam parser, lowering, worker pool, trace adapter     |
| `mod.ts`, `lazuli_cli.ts`    | The Lazuli frontend's own entry point and CLI; not part of the API     |
| `gleam.ts`, `gleam_cli.ts`   | The Gleam frontend's own entry point and CLI; not part of the API      |
| `language/lazuli/`, `gleam/` | Baba grammars and generated parser/editor artifacts                    |
| `examples/lazuli/`           | Lazuli sample programs                                                 |
| `examples/sweep/`            | Sweep sample programs                                                  |
| `examples/gleam/`            | Gleam sample modules and traces                                        |
| `examples/javascript-aot/`   | JavaScript frontend, grammar, and the pinned Test262 harness           |
| `playground/`                | Browser page compiling Gleam, bundled with `deno bundle`, no npm deps  |
| `tests/`                     | Behavioral, differential, stress, growth, and cancellation tests       |
| `benchmarks/`                | Deno benchmark entry points                                            |
| `tools/`                     | Profiling, the two Gleam stdlib checks, and editor-support scripts     |

All JavaScript-specific code lives under `examples/javascript-aot/`. The repository's `src/`
directory stays language-neutral.

The WebAssembly backend has an out-of-repo consumer, Ducklang, which imports `functional.ts` by
relative path for most of its modules and through a pinned JSR range for the rest — see
[ARCHITECTURE.md](ARCHITECTURE.md) section 7. Removing an export it uses breaks it at its next
compile, with no deprecation window.

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
deno task check:gpu-lexer [plan...]
deno task check:gleam-stdlib-wasm <checkout> [module ...]
deno task check:javascript-test262
```

`check:gleam-stdlib` accepts an existing checkout as its first argument and requires the commit the
tool records, so results cannot silently change with upstream `main`. It compiles the pinned corpus
and does not run it; single-program execution is covered by `deno task run:gleam`.

`check:gleam-stdlib-wasm` closes the gap the compile-only check leaves: stopping at resolved Core
says nothing about whether the code generator emits a correct program. It emits WebAssembly for one
upstream test at a time and runs it, using upstream's own assertions as the oracle — a Gleam
`assert` lowers to an explicit fault, so a test that runs to completion is a test whose assertions
held. It requires a checkout at the same pinned commit and takes an optional module filter. Failures
are classified by stage instead of thrown, because the useful output is a breakdown of what is
unsupported rather than the first thing that broke; a test blocked on Gleam's JavaScript FFI is
counted as `host`, not as a compiler failure, since folding those in would hide the number that
matters — how much of the corpus needs no runtime adapter at all.

`check:javascript-test262` pins the Test262 checkout and inventories every standalone test under
`test/language`. Its counts are a frontend-readiness baseline, not conformance results: positive
tests are wrapped with an AOT entry, negative tests must fail in their specified phase, and every
ready mode is compiled as a fresh GPU artifact. Compiled modules are never executed — the corpus is
a wide batch for measuring compile throughput and frontend coverage, and running thousands of
artifacts would measure something else. Time, memory, and compiler-fuel exhaustion are reported as
resource limits rather than semantic compilation failures.

`deno task test` uses `deno test --parallel` with `DENO_JOBS=2`. GPU tests are not ordinary
millisecond unit tests: some deliberately force workspace growth, single-transition dispatches,
device-limit failures, or cancellation. Individual stress tests can take 20–40 seconds; that is
expected when the test name describes one of those boundaries, and it is not the latency of a normal
compilation. Do not raise `DENO_JOBS` blindly — each worker owns WebGPU pipelines and buffers, and
more workers can increase device contention. Measure the full suite on the active adapter first.

### A red suite under VRAM pressure is not a regression

An intermittent red suite cost a long debugging session before the cause turned out to be outside
the repository. Device creation fails when another process is holding the card — a game holding 11
GB of this machine's 16 GB was enough to make WebGPU device creation fail inside tests — and it
looks like a race because which worker loses the allocation depends on scheduling, so the failing
test names move between runs. The dose-response settled it: on the same tree, default parallelism
produced 70 failures, `DENO_JOBS=2` produced 2, and `DENO_JOBS=1` produced 0 — of the 325 tests the
suite held when this was measured, now 333.

So before investigating the diff, re-run with `DENO_JOBS=1` and check what else is holding VRAM.
Only a failure that survives `DENO_JOBS=1` on an otherwise idle adapter is evidence of a regression.

## Test ownership

Tests are grouped by externally observable contract, and the prefix names the layer under test, not
the language a test happens to compile.

`functional_*_test.ts` owns the public API: `functional_compiler_test.ts` for surface packing, GPU
diagnostics, inference, batches, and cancellation; `functional_language_features_test.ts` for Core
semantics through compile-and-evaluate; `functional_surface_builder_test.ts` and
`functional_case_default_test.ts` for the builder and the sugar `buildSurfaceModule` elaborates;
`functional_simd_test.ts` for the `F32x4` path, which asserts on the emitted `v128` instructions;
and `functional_wasm_smoke_test.ts` for the WebAssembly backend. Those two and `gleam_test.ts` are
the only tests that reach the code generator, so a deleted or broken emitter is invisible outside
them.

`semantic_*_test.ts` owns the GPU layer: `semantic_gpu_workspace_test.ts` for arena growth, device
bounds, cleanup, and exact fuel; `semantic_gpu_diagnostic_parity_test.ts` for shader-versus-oracle
parity; `semantic_symbol_lookup_test.ts`, `semantic_definition_wavefront_test.ts`, and
`semantic_parallelism_profile_test.ts` for host lowering plans and dependency-wave schedules; and
`semantic_concurrent_compilation_test.ts`, `semantic_type_inference_test.ts`, and
`semantic_type_schema_abi_test.ts` for dispatch scheduling, inference results, and the
linked-preorder type ABI. Five of these were `lazuli_*` until the layer stopped being called Lazuli;
the point of the rename is that a frontend-named test file now really does test that frontend.

`webgpu_test.ts` covers device request, required limits, and setup diagnostics. The frontend-named
files — `lazuli_test.ts`, `lazuli_cli_test.ts`, `gleam_test.ts`, `javascript_aot_test.ts`,
`javascript_aot_property_identifier_test.ts`, and `javascript_test262_test.ts` — cover
source-language behavior and trace stability. Two files are frontend infrastructure rather than
language coverage: `gleam_parallel_frontend_test.ts` asserts that `ParallelGleamFrontend` packs the
same surface words as the single-threaded frontend, falls back inline below its unit threshold, and
isolates a failing unit from its neighbours; `javascript_test262_execution_test.ts` covers the
NDJSON worker protocol and case classification the Test262 harness depends on.

`inferTypes` in `src/semantic/type_inference.ts` is a differential oracle and the CPU column in
BASELINE.md. Production inference must remain on the GPU path; do not turn the oracle into an
implicit CPU fallback. When adding a regression test, assert through a public boundary. Internal
instrumentation exists for deterministic dispatch, fuel, workspace, and cancellation tests, but must
not be exported through `functional.ts`.

## Generated parsers

Canonical grammars are `language/<name>/grammar.baba` and
`examples/javascript-aot/language/grammar.baba`. Regenerate with `deno task generate:lazuli`,
`generate:gleam`, or `generate:javascript-aot` after a grammar or metadata change, and review both
the grammar diff and the generated diff. Generated output is excluded from formatting.
`just install` builds and installs the Tree-sitter parser and Helix queries into the user's Helix
configuration; it is a local developer action and must never run in automated tests or CI.

## Adding or changing a frontend

A frontend stays outside the semantic engine: parse into a source-specific AST with UTF-8 byte
spans, enforce the rules Functional Core does not represent, lower to `SurfaceDefinition` and
`SurfaceTypeDeclaration` values, select strict or lazy evaluation deliberately, translate neutral
diagnostics back to source terminology, and add an accepted program, a rejected program, and an
end-to-end evaluation test.

Keep parsing and desugaring out of `src/functional/` — that directory is target-neutral and cannot
acquire rules named after a source language. Reusable elaboration belongs beside the target
contracts; `recursive_groups.ts` is the model. Do not extend the packed ABI when a bounded
elaboration preserves the same semantics.

## Changing the packed ABI

The packed surface, resolved Core, and type metadata are compatibility boundaries. Before changing
one: identify every encoder, shader decoder, host decoder, trace renderer, and test that consumes
the record; reuse reserved words when the change is compatible; increment the ABI version when old
data cannot be interpreted safely; add malformed-buffer and round-trip coverage; and verify
evaluator, WebAssembly-backend, and inference behavior separately from each other. The word layouts,
tags, operators, and size constants are declared once in `src/semantic/abi.ts` and re-exported by
`src/functional/abi.ts`, which is the public boundary — change the declaration, not the re-export,
and do not reintroduce a second set of names for the same records. The canonical linked-preorder
type metadata is `src/semantic/type_schema_abi.ts`. Never silently accept a record from an unknown
ABI version.

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
`deno task check`, the GPU parity, workspace, and concurrent-compilation tests, and then
`deno task test`.

## Dependency updates

`@mewhhaha/baba` is the only direct dependency, and `deno.json` sets `"minimumDependencyAge": "0"`
because it is first-party — Deno's default 24-hour hold exists to blunt supply-chain attacks through
third-party registries, and it only ever blocked publishing and consuming the same package on the
same day. Everything else in the lock is `@std/*` pinned transitively.

**A major bump changes the generated-artifact format, not the TypeScript API.** Regenerate all three
grammars in the same commit:

```sh
deno task generate:gleam
deno task generate:lazuli
deno task generate:javascript-aot
```

**`deno task check:gpu-lexer` answers whether a grammar can use baba's WebGPU lexer.** Eligibility
is decided by the grammar, not by the program — the kernel holds the whole DFA in workgroup storage,
so a bigger project never helps. It asks `WebGpuLexer.create` rather than recomputing the size
formula, so it cannot drift from the implementation.

**A/B the parser directly; the suite will not catch it.** A 27% parse regression fits inside
`bench`'s 30% timing-noise band and lands green with every counter matching. Measure both versions
back to back with nine samples — `git stash` the version pin and the generated artifacts together,
since a plan built by one version is not comparable under another. That is how 7.0.0 was found to be
slower than 5.1.0 despite being published as an improvement; see BASELINE.

## Benchmarks and profiling

**Start with `deno task bench`.** It is the one command to run before and after a change, it needs
nothing but the repository and a GPU, and it exits non-zero when something real moved:

```sh
deno task bench          # run and diff against benchmarks/baseline.json
deno task bench:save     # accept the current numbers as the new baseline
```

The suite splits its output in two, and the split is the point:

- **Counters** — node counts, inference transition counts, emitted byte lengths. These reproduce to
  the digit. A change fails the run, because it means the compiler is doing different work. Both
  defects found on 2026-07-26 showed up here: the or-pattern explosion as a node count, the
  non-compressing union-find as a transition count.
- **Timings** — reported with a delta against the baseline, and they never fail anything. Wall times
  on this machine spread about 30% run to run and needed a quiet machine before they meant anything;
  a suite that failed on them would be ignored within a week.

So a red `bench` is a claim about work done, not about speed. Explain it or fix it, then
`bench:save` once the change is intended, in the same commit.

The `or-patterns` case is worth knowing about specifically: it records `-1` rather than throwing,
because the regression it guards is a program that stops compiling at all. It reports "this case no
longer compiles" instead of a stack trace.

The narrower benchmarks stay for the questions the suite does not answer:

```sh
deno task bench:throughput
deno task bench:lazuli
deno task bench:semantic-wavefront
deno task bench:gleam-batch
deno task bench:gleam-corpus [module-count]
deno task bench:gleam-stdlib <stdlib-checkout> [entry.gleam]
deno task profile:frames [source | --gleam <stdlib-checkout>]
deno task measure:or-patterns
deno task profile:semantic-compiler
```

`bench:throughput` produces the synthetic-corpus numbers in [BASELINE.md](BASELINE.md) and decides
whether a change to the GPU path was worth making. Report **marginal cost per module**, not total
wall time: both paths pay the same host parse, so a total-wall-time ratio flatters the GPU. Update
BASELINE.md in the same commit as any change that moves it.

`bench:gleam-batch` and `bench:gleam-stdlib` are the two ends of one axis, measured against the
Gleam compiler on real input, and BASELINE.md reports both because either alone misrepresents the
project: many independent modules compiled together, where batching wins, and one large module
compiled once, where it loses badly. `bench:gleam-stdlib` generates an entry binding every public
function in the corpus, because lowering prunes to what the entry reaches and a small `main` leaves
gpufuck compiling a handful of nodes while `gleam build` compiles all nineteen modules — an earlier
version measured 252 KB of Gleam as 66 surface nodes. Pass a path to override it.

`bench:gleam-corpus` is the same axis on generated modules of a realistic size, and it is where the
frontend/GPU split becomes visible: at 256 modules the GPU compiles 300,544 nodes in 87.9 ms while
baba takes 2,152.8 ms to parse them. `profile:frames` charges every inference transition to the
frame kind that did it, which is how both of the 2026-07-26 defects were located;
`measure:or-patterns` separates body duplication from scrutinee re-binding in pattern lowering.

`profile:semantic-compiler` separates cold WebGPU initialization, frontend preparation, semantic
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
reason. Constructs portable WGSL cannot express are delegated to bounded WebAssembly by
`evaluate()`, never approximated in the shader; the delegated path throws a `TypeError` for options
it cannot honour, such as GPU dispatch, heap, and stack controls.

Resource ownership must be visible in control flow: a successful compiled module owns its persistent
GPU buffers and callers destroy it in `finally`; evaluators own and release only per-run buffers;
workspace replacement owns both buffers until a successful copy transfers the active state. Do not
catch a WebGPU error merely to return a generic source diagnostic — enrich and rethrow it, or
translate it at the boundary with its original `cause` preserved.

## Publishing

The manifest is `deno.json` and the public entry is `functional.ts`, published to JSR as
`@mewhhaha/gpufuck`. Run `deno task fmt`, `lint`, `check`, and `test`, then `git diff --check` and
`deno task publish:dry-run`. Before changing the version, confirm the README examples use only
exports reachable from `functional.ts`, confirm no module reachable from it is caught by
`publish.exclude`, document ABI changes, and inspect the dry-run file list for repository-only
frontends or generated artifacts that should not ship. The release workflow publishes only tags
whose `v<version>` name matches `deno.json`.

The exclude list is what keeps the frontends out: `src/lazuli/`, `src/gleam/`,
`src/baba_frontend.ts`, `examples/`, `language/`, and the frontend entry points and CLIs — `mod.ts`,
`gleam.ts`, `lazuli_cli.ts`, `gleam_cli.ts` — are repository samples, not API.
`deno publish --dry-run` typechecks the published graph, so a stray import from `functional.ts` into
any of them fails there rather than after release.

Ducklang consumes gpufuck both ways at once and is mid-migration: five of its modules resolve the
import-map entry `jsr:@mewhhaha/gpufuck@^0.4.0`, and twenty-two still import `functional.ts` by
relative path against the working tree. The relative half has no version pin, so removing or
renaming an export is observable at its next compile with no deprecation window. That makes
`just typecheck` in the Ducklang checkout a stricter gate than any release check, and the only one
that exercises both paths.

## Commit scope

Keep generated changes, ABI migrations, performance work, and documentation reorganizations easy to
review. Preserve unrelated worktree changes. A commit should state one intent, and its tests should
make that intent observable.
