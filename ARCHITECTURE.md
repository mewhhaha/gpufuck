# Architecture

System boundaries, compilation stages, GPU machines, and the decisions a change must not silently
reverse. The integration path is in [README.md](README.md), commands in
[DEVELOPMENT.md](DEVELOPMENT.md), and measured performance in [BASELINE.md](BASELINE.md) — which
every claim here is judged against.

## 1. Purpose and scope

Gpufuck is a semantic compiler for functional languages whose purpose is to be a fast compiler on
the GPU. Resolved Functional Core is the pivot: the GPU Core evaluator executes it, and the
WebAssembly backend compiles it to a binary module.

The project owns the portable Functional Surface and packed module ABI, target-level typed modules
and static linking, Core lowering, dependency analysis, Hindley–Milner inference and coverage, a
bounded GPU evaluator, WebAssembly emission with its storage plan and host boundary, bounded
compile-time execution, and the bounded-work, cancellation, diagnostic, and device-ownership
contracts around all of it.

A source-language implementation owns lexing, parsing, module discovery, visibility, source-specific
scoping, numeric literal defaulting, mutation and ownership rules, effect classification, and every
filename, line/column, excerpt, and wording concern in diagnostics. A feature enters the target only
when several languages can describe it without importing one frontend's syntax or policy.

Non-goals: parsing inside WGSL; replacing source-language ownership or effect checking; emitting
native machine code; impredicative inference or dependent types.

## 2. System context

```text
frontend: parse ─► source checks ─► desugar ─► artifacts and spans
    ▼  module artifacts and static linker
packed Functional ABI, version 5
    ▼  CPU: symbol lookup and lowering plan (src/semantic/symbol_lookup.ts)
    ▼  GPU: Core lowering, then the persistent inference machine
resolved Functional Core
    ├─►  GPU Core evaluator, delegating to bounded Wasm where WGSL cannot go
    └─►  WebAssembly backend: storage plan, codegen, host boundary, binary
```

The CPU/GPU boundary is not where earlier revisions of this document placed it, and the difference
matters when reading a profile.

**Name resolution runs on the CPU, and always has.** `createLoweringPlan` in
[`symbol_lookup.ts`](src/semantic/symbol_lookup.ts) walks the packed surface on the host: it
computes de Bruijn depths for lexical names, resolves remaining names to global definition or
constructor indices, resolves case-arm constructors, and records the first deterministic diagnostic.
It writes one four-word record per surface node behind a magic header. The shader predicate
`indexed_local_resolutions_are_available` in [`compiler_shader.ts`](src/semantic/compiler_shader.ts)
checks for that header and copies the precomputed Core tag and payload into the resolved node. The
GPU decides nothing there.

What the GPU does own is inference: dependency SCC discovery, union-find, occurs checks,
unification, generalization and instantiation, annotation subsumption and skolemization, indexed
constructor refinement, coverage, entry concreteness, and serialization of the inferred type.

Decisions move in one direction only. A frontend must not patch resolved Core indices after
checking.

## 3. The IR ladder

**Functional Surface** is the required high-level target: scalar, static text, and static bytes
literals; names and explicit runtime faults; lambdas and unary application; immutable `let`,
lambda-valued `let-rec`, and local mutually recursive groups; `if`, primitive operations, and
numeric conversions; nominal constructors and flat constructor cases; persistent indexed `Store`
operations; definitions, annotations, nominal declarations, and an entry. Every node carries source
spans and an explicit evaluation mode. [`surface_builder.ts`](src/functional/surface_builder.ts)
offers ergonomic objects and packs them; [`abi.ts`](src/functional/abi.ts) is the portable boundary.
Lists, records, traits, source modules, and multi-argument functions are not Core primitives — they
lower into nominal declarations, explicit dictionaries, linked artifacts, and unary functions, and
[`recursive_groups.ts`](src/functional/recursive_groups.ts) lambda-lifts local SCCs into top-level
ones with captures made explicit.

**Type schemas** are structural trees over primitives, parameters, tuples, named applications,
functions, and explicit `forall`, encoded in one canonical linked preorder. Each six-word record
holds tag, symbol, first child index, next sibling index, and the two span bytes; definition roots,
type-parameter tables, constructor-field roots, and indexed result roots share one metadata buffer.
Inferred output uses the same format and decoder in
[`type_schema_abi.ts`](src/semantic/type_schema_abi.ts), so host and shader formats cannot drift.
The decoder rejects cycles, reused records, invalid siblings and symbols, wrong child counts,
unreachable records, and excessive depth before anything is trusted.

**Resolved Core** is the trusted semantic input to evaluation. Nodes carry numeric local depths,
definition and constructor indices, child indices, span bytes, and evaluation mode; names are never
resolved twice. The decoded shape is `FunctionalCoreNode` in
[`compiler_module.ts`](src/functional/compiler_module.ts); the packed form stays on buffers owned by
`GpuFunctionalModule`, with `readCoreNodes()` as an explicit readback. Indexed runtime state uses
the neutral `Store a` primitive — persistent new, length, checked read, write, and growth, bounded
to 16,777,216 elements — which keeps JavaScript object semantics inside the JavaScript frontend.

## 4. Modules, linking, and packed ABIs

The frontend emits one `FunctionalModuleArtifact` per source module.
[`module_linker.ts`](src/functional/module_linker.ts) validates artifact structure, qualifies every
definition, nominal type, and constructor, rewrites references, turns each import alias into an
annotated boundary definition, checks evaluation-profile and host-capability compatibility, rejects
duplicates and missing imports, concatenates source ranges without losing the owning module, and
selects the entry. The import annotation makes the GPU verify the importer's declared contract
against the exported implementation.
[`surface_reachability.ts`](src/functional/surface_reachability.ts) then retains only definitions
reachable from the entry, so an unused frontend-runtime builtin adds no GPU typechecking work. There
is no incremental cache; it was removed and has not returned, so every compilation is cold.

WebGPU storage buffers favor flat fixed-width records, so object graphs become indexed arrays before
submission. Functional ABI version 5 uses eight `u32` words per Core node, four per definition, five
per nominal type declaration, five per constructor, and six per schema node. Counts are explicit and
`0xffffffff` is the absent index. Every length, root, child, symbol, arity, profile, capability, and
span is validated before semantic use. Malformed packed input is an API contract violation and
throws before submission; a well-formed program that cannot be typed returns a diagnostic; device
failure and impossible internal state propagate as infrastructure errors.

## 5. GPU semantic compilation

[`compiler.ts`](src/functional/compiler.ts) is the language-neutral facade: it validates options and
device-derived size limits, normalizes host contracts, admits work under a transient memory budget,
and delegates to `src/semantic/`. Some internal names retain `Lazuli` for ABI compatibility, but no
source syntax reaches the shaders. `GpuFunctionalCompiler.create(device)` builds and validates the
pipelines once, reading shader compilation messages before asynchronous pipeline creation so invalid
WGSL fails at initialization rather than on the first user source; device limits determine maximum
node, definition, type, constructor, and transient storage. [`webgpu.ts`](src/webgpu.ts) requests
`maxStorageBuffersPerShaderStage` of 16 (clamped to adapter support) because the existing kernels
already bind all eight WebGPU guarantees by default, and opts into `timestamp-query` when available.

**Core lowering** validates node tags, children, symbols, and declaration ranges; checks case binder
and constructor shape; records definition dependency edges; and retains both span ends and the
evaluation mode. When the host lowering plan is present it supplies the resolved tag and payload.
Two kernels exist: `compile_lazuli` is the persistent per-lane state machine at
`@compute @workgroup_size(1)`, and `lower_planned_lazuli` is the one data-parallel production kernel
— at `@compute @workgroup_size(64)` it copies the plan for every `(program, node)` pair in a single
dispatch, gated on the remaining plan fitting the current fuel and quantum. Programs under 64
remaining nodes use the serial path, and packed batches use it for at most four lanes because wider
batches already expose lane parallelism.

**Inference** consumes resolved nodes and canonical schema metadata. The baseline discipline is
Hindley–Milner. Indexed constructors add equality refinements scoped to a case arm. Predicative
rank-N parameters are checked only when annotated: actual schemes instantiated, expected schemes
skolemized, parameters compared contravariantly and results covariantly. Quantified values are not
inferred impredicatively.

**Truly bounded microsteps.** Fuel and cancellation depend on one invariant: a charged transition
performs constant-bounded work. Input-sized algorithms are durable work frames, not loops hidden
inside an invocation. A transition inspects at most one record or edge, pushes at most two frames,
allocates at most one record per arena, and advances one phase; fuel increments only when semantic
work advances. This matters more than asymptotic complexity — a linear scan of a million records
inside one "step" would make a one-step dispatch uncancellable for its duration. The default budget
is 1,000,000 transitions with a hard cap of 10,000,000.

**Workspace arenas.** Inference keeps separate arenas for types, environments, frames, refinements,
scratch, and output, sized from input shape. When one fills,
[`gpu_type_inference_runner.ts`](src/semantic/gpu_type_inference_runner.ts) doubles only that
capacity subject to device limits, allocates a replacement, copies live records at their new bases,
patches bases and capacities, resumes the same phase with the same fuel and results, and destroys
the old workspace after a successful transfer. A failed copy, allocation error, or cancellation owns
both buffers until both are destroyed.

**Batching.** `compileBatch()` packs independent programs into lanes; one mapped state readback
observes the batch at a quantum boundary, results preserve input order, and successful lanes are
copied into independently owned buffers only after their terminal state is known.
[`gpu_dispatch_scheduler.ts`](src/functional/gpu_dispatch_scheduler.ts) coalesces ready dispatches
into one command buffer, and [`compilation_admission.ts`](src/functional/compilation_admission.ts)
bounds concurrency by request count and estimated transient bytes. Cancellation is checked while
queued, before submission, and after the validation scope resolves; a submitted dispatch cannot be
interrupted mid-command, so bounded quanta set the observation interval.
[`definition_wavefront.ts`](src/semantic/definition_wavefront.ts) schedules the condensed dependency
graph in deterministic waves on host and GPU; the GPU seam is a reusable device-resident plan whose
wave buffer can feed later passes, not a lower-latency replacement for the host algorithm.

## 6. Measured cost

[BASELINE.md](BASELINE.md) is authoritative and reproducible with `deno task bench:throughput`. The
summary below exists so this document is not read in isolation. Marginal cost per module at batch
1024, on a Ryzen 7 7800X3D with an RTX 4080 SUPER and Deno 2.9.2:

| Work                                 | Runs on | Per module |
| ------------------------------------ | ------- | ---------: |
| Parsing plus inference               | CPU     |    39.3 µs |
| Hindley–Milner inference alone       | CPU     |    10.2 µs |
| Host symbol lookup and lowering plan | CPU     |     3.6 µs |
| Hindley–Milner inference             | GPU     |    99.7 µs |

Three conclusions, none of them flattering.

The GPU is **9.7× slower** than the CPU at the one phase it exclusively owns, and loses at every
batch size measured — marginal GPU cost per module exceeds total CPU cost per module, so the curves
converge rather than crossing. Both columns do the same work: the CPU baseline is `inferLazuliTypes`
in [`type_inference.ts`](src/semantic/type_inference.ts), differentially tested against the shader.

Single-compile latency is a separate defect. Deno's `mapAsync` stalls roughly **11.4 ms per await**
even on a buffer with nothing submitted, and concurrent awaits do not amortize it. That floor is the
entire one-module number. It is a runtime property, not a compiler one, but any design that reads
back between phases pays it per phase.

Parsing is **74%** of the CPU path and stays on the CPU, so by Amdahl's law a free instantaneous GPU
inference would only take that path from 39.3 to 29.1 µs/module — a **1.35×** ceiling. The retarget
is worth doing because the GPU phase is currently a regression, not because the ceiling above it is
high. A faster parser would outweigh the entire retarget.

## 7. External consumers

**Ducklang is why the WebAssembly backend exists.** Ducklang is a separate language project — an
Interaction Calculus inspired language, kept in a checkout beside this one — whose own README states
its pipeline as:

```text
Source -> Frontend -> semantic Core -> gpufuck Functional Core -> Wasm
```

It owns parsing, its own semantic Core, and the lowering into Functional Surface;
`experiments/gpufuck/core_lowering.ts` is its entire backend adapter. It has no other code
generator, so deleting gpufuck's Wasm emission leaves Ducklang with no target at all.

What it imports from `functional.ts`: `GpuFunctionalCompiler` and `requestWebGpuDevice`,
`linkFunctionalModules` and the `surface` builders, `compileFunctionalModuleToWasm`,
`runFunctionalWasmModule` and `runFunctionalWasmModuleAsync` with their `init` and host-value types,
`planFunctionalModuleStorage`, and `GpuFunctionalComptimeExecutor`. Storage planning, comptime, and
the host boundary are load-bearing for it, not vestigial.

The coupling is a **relative import**, `../../../gpufuck/functional.ts`, not a JSR version range.
There is no pin and no release step between the two projects: a change here reaches Ducklang on its
next compile, and a removed export breaks it immediately.
[`tests/functional_wasm_smoke_test.ts`](tests/functional_wasm_smoke_test.ts) is the in-repo guard —
nothing else in the suite emits WebAssembly, so without it the code generator can be deleted or
broken and the suite stays green.

## 8. Runtimes

A successful `GpuFunctionalModule` owns resolved node, definition, and constructor buffers, plus
counts, roots, qualified names, arities, the entry and its inferred type, nominal declarations, host
capability contracts, source ranges, evaluation profile, and an idempotent `destroy()`. Two runtimes
consume it, and `GpuFunctionalEvaluator.evaluate` chooses between them without the caller deciding.

[`evaluator.ts`](src/functional/evaluator.ts) is a bounded graph reducer over resolved Core
supporting strict and call-by-need binding, lane-local fuel, bounded heap and stack, cancellation,
and deep-result limits. Portable WGSL exposes no `i64` or `f64`, and its floating-point rules do not
promise host-Wasm rounding, so the reducer represents wrapping `i64` with two words and handles only
a safe `f32` subset.

`moduleNumericRequirements` reads resolved Core once per module — cached in a `WeakMap` — and sets
two flags. `signedInteger64` keeps evaluation on the GPU but forces a deep result form so 64-bit
values survive readback. `boundedWasm` routes the whole program to
`evaluateFunctionalModuleWithBoundedWasm`, which compiles it through the same backend and runs it
under a fuel-instrumented module. That second set is 64-bit float and portable whole-number f64
literals; text, bytes, runtime faults, buffer append, and all five `Store` operations; 64-bit float
and portable whole-number arithmetic; structural equality; 32-bit float division and square root;
and every numeric conversion touching `f64`. `evaluateBatch` splits the batch when any lane needs
the delegated path.

The delegation is not free of seams, and they are contract violations rather than diagnostics: the
bounded-Wasm path throws a `TypeError` for the GPU-only `maximumStepsPerDispatch`, `heapSlots`, and
`stackFrames` options, and for any module declaring host capabilities, because `evaluate()` has
nowhere to take a runner `init` — such a program must go through `runFunctionalWasmModule` instead.
Its step budget is capped at 1,000,000, below the evaluator's configurable fuel.

Ahead-of-time emission is the other consumer.
[`wasm_artifacts.ts`](src/functional/wasm_artifacts.ts) exposes `compileFunctionalModuleToWasm` over
two code generators — `linear-memory`, optionally with a caller-supplied storage plan, owned-type
exports, or Wasm SIMD, and `wasm-gc` — memoizing artifacts per module and per resolved-Core
fingerprint. Host capability declarations and `wasmExports` are consumed here: capabilities become
the imported host boundary emitted by [`wasm_host_emitter.ts`](src/functional/wasm_host_emitter.ts),
and exported definitions become module exports.

## 9. The retarget

The current shape — one lane per module running a serial `loop { if phase == … }` state machine over
a large `var<private>` struct — is why section 6 reads the way it does. The direction is bulk
data-parallel kernels whose unit of parallelism is a **node**, a **definition**, or a
**constraint**, not a module:

- kernels sized to the work item, dispatched over all items in a batch;
- phases sequenced in a single command buffer with no host readback between them, so `mapAsync` is
  paid once per compilation rather than once per phase;
- indirect dispatch, each phase writing its successor's workgroup count into a buffer;
- union-find over type variables driven by atomics rather than a serial walk.

A capability spike on Deno 2.9.2 with an RTX 4080 SUPER confirmed the two behaviours this depends
on. Indirect dispatch arguments written by one dispatch are visible to `dispatchWorkgroupsIndirect`
within the same compute pass, so a phase can size its successor without a readback. And
`atomicCompareExchangeWeak`-based union-find converges under contention. Neither needed host
involvement.

One WGSL constraint shapes the implementation: a value-returning function may not contain an
unbounded `loop`. Find and path-compression walks must be written with an explicit bounded iteration
count — compatible with the constant-bounded-transition invariant, but stated in code rather than
assumed.

The retarget is judged on the GPU inference share, not total wall time. Below 10.2 µs/module it
beats the single-threaded CPU it replaces; the honest bar is the ~1.3 µs/module a multi-threaded
host reaches. If node-parallel validation and constraint generation cannot bring 99.7 µs under about
30 µs, unification and generalization will not close the gap either, since they are strictly harder
to parallelize. BASELINE.md records that criterion so it cannot be quietly relaxed.

## 10. Diagnostics and resource ownership

`F1xxx` covers structural, resolution, and work-limit diagnostics and `F2xxx` covers type,
annotation, coverage, and inference diagnostics; both arrive in the compile result. `F3001`–`F3012`
are evaluation faults, and `F4001`–`F4007` are `FunctionalLinkError`. WebGPU and device errors
reject or throw with a `cause`, and a compiler bug or corrupt trusted state throws. Spans are UTF-8
byte offsets because packed source evidence must be independent of JavaScript UTF-16 indexing;
`locateFunctionalSpan()` and `locateFunctionalDiagnostic()` map neutral evidence back to a module,
and the frontend maps that offset to lines, columns, and its own wording. Cancellation is not a
diagnostic — it rejects with the caller's abort reason.

The application owns the `GPUDevice`; pipelines live for the device's lifetime; upload and inference
workspaces belong to one compilation and are released on every success, failure, and cancellation
path; Core buffers belong to a successful `GpuFunctionalModule` until `destroy()`; evaluator heap,
stack, and readback belong to one evaluation. Workspace growth temporarily owns both old and
replacement buffers, transferring only after the copy and state patch complete. Catch blocks cannot
continue with ambiguous ownership, and module destruction is idempotent.

## 11. Frontends

Three live in the repository; none is part of the published entry point. **Lazuli** is the reference
language and compatibility API, not the definition of Functional Core: its Baba-generated parser
runs on the host, defaults to lazy call-by-need, and exercises inferred functions and recursive
data, partial type holes, indexed equality proofs, built-in text, bytes, and lists, and host `Init`
values. **Gleam** demonstrates the separation at module scale — its adapter owns syntax, visibility,
labels, records, bit arrays, external annotations, and pipeline desugaring. Its `Int` lowers to
64-bit integers rather than the f64-backed JavaScript model: a semantics choice, made because the
corpus is integer arithmetic and `i64` keeps it on the GPU evaluator. Division and remainder keep
Gleam's rules — the frontend guards a zero divisor and yields `0`, so `42 / 0 == 0`, and `i64`
division truncates toward zero, so `-7 / 2 == -3`. **JavaScript AOT** is the largest frontend and
the reason `Store` and continuation sharing exist in Core: it lifts statement tails and repeated
call, construction, accessor, and coercion resumptions into explicit functions so
continuation-passing lowering does not expand the input tree, and its call frames carry the callable
object as well as its target, captured realm and environment, receiver, and arguments, preserving
`arguments.callee` identity without a global lookup.

New semantic features must be exposed through `src/functional/` contracts and must not depend on any
frontend's keywords or parser structures.

## 12. Architectural decisions

Decisions that are easy to reverse accidentally in a local patch.

**Frontend syntax stays host-side.** Source grammars, filesystem lookup, recovery, macros, and
diagnostics are language-specific and branch-heavy; moving them to WGSL would couple every syntax
change to shader pipelines. The cost is now visible: parsing is the majority of the CPU path, which
bounds what the rest of the retarget can achieve.

**Inference stays GPU-side.** This is the workload the project exists to test, and two authorities
would make traces, diagnostics, and measurements depend on a hidden CPU compiler. The TypeScript
inferencer is a differential oracle, never an implicit fallback. The cost is that algorithms must be
expressed without recursion under WGSL's type limits — and are currently 9.7× slower than the
oracle. Revisit when the node-parallel retarget either closes that gap or proves it cannot.

**Constant-bounded transitions.** No input-sized loop inside one charged transition, because fuel,
cancellation, and quanta must bound wall-clock latency and not just total work. Simple recursive
algorithms become explicit frame machines with larger durable state, and WGSL independently forbids
unbounded `loop` in value-returning functions.

**Elastic region-specific growth.** Input-derived arenas, doubling only the exhausted region,
because fixed worst-case multipliers waste device memory and reduce concurrency. The cost is
copy/patch/resume logic and meticulous failure cleanup.

**Frontend-selected strictness.** The frontend picks strict or lazy defaults and may annotate
binding boundaries; explicit thunks stay ordinary typed values. Strictness is source-language
semantics — treating every value as a thunk penalizes strict languages, and forcing everything
changes Haskell-like programs.

**No implicit CPU fallback.** Compilation fails clearly when no adapter exists. A silent fallback
would have different performance and cancellation behaviour, and would make every number in section
6 meaningless. The cost is that CPU-only machines cannot use the compiler at all.

**Constructs WGSL cannot express are delegated, never approximated.** Emulating `f64` or structural
equality in WGSL would give a checked Core program substrate-dependent semantics, so `evaluate()`
routes those programs to bounded WebAssembly instead. The cost is a second execution substrate with
its own option surface and step cap (section 8). Revisit the split when the WGSL portability
baseline exposes the required scalar operations.

**The WebAssembly backend is a supported target, not an artifact of history.** It has an external
consumer that imports it by relative path with no version pin (section 7). Removing an export, or
the backend itself, breaks that consumer at its next compile with no deprecation window.

## 13. Limits and safety properties

1 MiB of source evidence, 65,536 surface nodes, semantic depth 512, constructor arity 256, stores of
16,777,216 elements, and device-derived buffer maxima. Runtime APIs add explicit fuel, heap, stack,
dispatch, output-node, output-byte, and output-depth limits. These prevent integer overflow in
byte-size calculations, keep every GPU index inside the packed representation, bound host validation
and decoding, bound denial-of-service exposure for untrusted programs, make cancellation intervals
configurable, and turn device limitations into reproducible evidence. Proof witnesses and capability
dictionaries are ordinary values; recursive proof programs can diverge, and typechecking does not
imply totality.

## 14. Internal source map

| Concern                | Primary modules                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Public API and ABI     | `functional.ts`, `core.ts`, `src/functional/abi.ts`                                           |
| Surface and linking    | `surface_builder.ts`, `recursive_groups.ts`, `surface_reachability.ts`, `module_linker.ts`    |
| Facade and admission   | `compiler.ts`, `compilation_admission.ts`, `gpu_dispatch_scheduler.ts`                        |
| Host lowering plan     | `src/semantic/symbol_lookup.ts`                                                               |
| GPU lowering           | `compiler_shader.ts`, `gpu_semantic_compiler.ts`, `gpu_batch_compiler.ts`                     |
| GPU inference          | `type_inference_shader.ts`, `gpu_type_inference_runner.ts`, `gpu_type_inference_workspace.ts` |
| CPU oracle and schemas | `src/semantic/type_inference.ts`, `type_schema_abi.ts`                                        |
| Evaluation             | `src/functional/evaluator.ts`, `src/semantic/evaluator_shader.ts`                             |
| Wasm backend           | `wasm_artifacts.ts`, `wasm_codegen.ts`, `wasm_gc_codegen.ts`, `wasm_binary.ts`                |
| Wasm runtime and hosts | `wasm_execution.ts`, `wasm_host_emitter.ts`, `wasm_value_codec.ts`, `wasm_arena.ts`           |
| Storage and comptime   | `storage_plan.ts`, `storage_core.ts`, `comptime.ts`                                           |
| Diagnostics and device | `src/functional/diagnostics.ts`, `compilation_diagnostics.ts`, `src/webgpu.ts`                |

`src/functional/effect_core*.ts` and `effect_contract.ts` are in the tree but dormant: nothing
imports them and neither entry point exports them. Of Type Core only `type_core_contract.ts`
survives, and it exists because `comptime_constant.ts` needs its value and type shapes.

## 15. Technical references

Not a transcription of any one paper; these explain specific decisions.

- W3C, [WebGPU](https://www.w3.org/TR/webgpu/) and [WGSL](https://www.w3.org/TR/WGSL/) — device,
  buffer, pipeline, and limit model; scalar type constraints and the loop restrictions behind
  explicit frames and bounded walks.
- N. G. de Bruijn,
  ["Lambda calculus notation with nameless dummies"](https://doi.org/10.1016/1385-7258(72)90034-0) —
  numeric lexical binding.
- Robert Tarjan, ["Depth-first search and linear graph algorithms"](https://doi.org/10.1137/0201010)
  and, with Jan van Leeuwen,
  ["Worst-case analysis of set union algorithms"](https://doi.org/10.1145/62.2160) — SCCs and
  union-find behind dependency groups and unification.
- Luis Damas and Robin Milner,
  ["Principal type-schemes for functional programs"](https://doi.org/10.1145/582153.582176) —
  principal Hindley–Milner inference.
- Simon Peyton Jones et al.,
  ["Simple unification-based type inference for GADTs"](https://www.microsoft.com/en-us/research/publication/simple-unification-based-type-inference-for-gadts/)
  and Dimitrios Vytiniotis et al.,
  ["OutsideIn(X)"](https://www.microsoft.com/en-us/research/publication/outsideinx-modular-type-inference-with-local-assumptions/)
  — scoped equality refinement, local assumptions, and annotation boundaries.
- John Launchbury,
  ["A natural semantics for lazy evaluation"](https://doi.org/10.1145/158511.158618) — call-by-need
  sharing behind updateable thunks and blackhole detection.

References document rationale; tests and the versioned contracts are the executable specification.
