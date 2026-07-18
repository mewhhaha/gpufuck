# Architecture

This document describes gpufuck's system boundaries, compilation stages, persistent GPU machines,
Wasm backend, runtime contracts, and design decisions. It is written for frontend authors and
contributors who need to know where a decision belongs and which invariants a change must preserve.

The public integration path is in [README.md](README.md). Commands and repository workflow are in
[DEVELOPMENT.md](DEVELOPMENT.md).

## 1. Purpose and scope

Gpufuck is a reusable semantic compiler and Wasm backend for functional languages. It deliberately
does not define a universal source syntax or a universal language semantics.

The project owns:

- a portable Functional Surface and packed module ABI;
- target-level typed modules and static linking;
- GPU name resolution, dependency analysis, inference, checking, coverage, and Core lowering;
- optional type normalization, capability evidence, Type Core, Effect Core, and compile-time
  execution;
- a resolved numeric Core shared by evaluators and Wasm emission;
- whole-program Wasm analysis, representation selection, optimization, emission, and execution
  adapters;
- bounded work, cancellation points, diagnostics, source evidence, and device resource ownership.

A source-language implementation owns:

- lexing, parsing, concrete syntax, layout, macros, and source files;
- its module discovery, package graph, visibility, re-export, and coherence rules;
- source-specific scoping that differs from Functional Core;
- numeric literal defaulting, overflow semantics, mutation, ownership, and borrow checking;
- effect classification and the meaning of purity, `IO`, exceptions, and async operations;
- elaboration of language-specific type features into the optional target services;
- filenames, line/column mapping, excerpts, recovery, and source-language diagnostic wording.

This split is the central architectural constraint. A feature should enter the target only when
multiple languages can describe it without importing one frontend's syntax or policy.

### Goals

- Amortize semantic compilation across many independent programs on a GPU.
- Make fuel, dispatch quanta, and cancellation real latency bounds rather than accounting fiction.
- Preserve enough source evidence to produce useful frontend diagnostics.
- Keep emitted Wasm independent of WebGPU and gpufuck.
- Support both strict and lazy functional languages through explicit evaluation modes.
- Make advanced type execution and effects optional layers above a small Core.
- Keep every cross-process or host/device format versioned and structurally bounded.
- Prefer whole-program optimization while retaining an incremental module cache.

### Non-goals

- Parsing arbitrary languages inside WGSL.
- Replacing source-language ownership, effect, or coherence checking.
- Providing GHC, rustc, OCaml, or Zig compatibility from the target alone.
- Dynamic Wasm linking or a public relocatable Wasm object format.
- A tracing garbage collector, runtime borrow checker, unrestricted raw memory, or native SIMD in
  Functional Core.
- Impredicative inference, full dependent types, or unrestricted compile-time execution.
- Executing generated Wasm on the GPU.

## 2. System context

```text
┌──────────────────────── source-language implementation ─────────────────────────┐
│ parser ─► source AST ─► source checks ─► desugaring ─► artifacts and spans      │
└──────────────────────────────────┬──────────────────────────────────────────────┘
                                   │
               ┌───────────────────┼────────────────────────┐
               ▼                   ▼                        ▼
        Functional Surface   Type services            Effect Core
               │             and comptime                   │
               └───────────────────┬────────────────────────┘
                                   ▼
                    module artifacts and static linker
                                   ▼
                   packed Functional ABI, version 5
                                   ▼
             WebGPU resolution and persistent inference machines
                                   ▼
                        resolved Functional Core
                         │                     │
                         ▼                     ▼
               bounded GPU evaluator   whole-program Wasm backend
                                               ▼
                                      standalone `.wasm`
```

The CPU/GPU distinction is semantic rather than ideological. Parsing, structural packing, module
discovery, cache I/O, Wasm byte emission, and host integration stay on the host because they are
branch-heavy, filesystem-dependent, or latency-sensitive at small sizes. Resolution and inference
are GPU state machines because they can share pipelines and submissions across wide batches.

Generated Wasm executes in an ordinary Wasm engine. WebGPU is a build-time dependency, not a
deployment dependency.

## 3. Decision ownership by stage

The following table is the quickest answer to “where should this feature live?”

| Stage             | Decisions made                                                               | Owner                                          | Durable output                           |
| ----------------- | ---------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| Parse             | Tokens, grammar, layout, macro expansion                                     | Frontend                                       | Source AST with UTF-8 spans              |
| Source checking   | Visibility, moves, borrows, language-specific effects and coherence          | Frontend                                       | Trusted source AST                       |
| Desugar           | How source constructs map to functions, values, constructors, cases, effects | Frontend                                       | Functional Surface or optional higher IR |
| Type elaboration  | Higher-kinded application, constraints, existentials, and open rows          | Optional gpufuck service under frontend policy | First-order schemas plus evidence        |
| Artifact creation | Typed imports/exports and module-local declarations                          | Frontend using target contracts                | `FunctionalModuleArtifact`               |
| Static link       | Qualification, import/export compatibility, aggregate source ranges          | gpufuck                                        | One encoded linked module                |
| GPU resolution    | Local depths, global indices, constructor indices, dependency edges and SCCs | gpufuck                                        | Resolved numeric Core tables             |
| GPU inference     | Schemes, unification, refinements, coverage, concrete entry type             | gpufuck                                        | Checked `GpuFunctionalModule`            |
| Wasm analysis     | Reachability, captures, lambda sets, worker shapes, runtime requirements     | gpufuck                                        | Backend analysis state                   |
| Wasm emission     | Representation, direct/indirect calls, thunks, loops, memory and exports     | gpufuck                                        | Standalone bytes                         |
| Host execution    | Concrete host values, operations, ownership promises, suspension             | Application plus validated gpufuck adapter     | Execution value or structured fault      |

Decisions move only in one direction. The Wasm backend must not reinterpret source syntax, and a
frontend must not patch resolved Core indices after GPU checking.

## 4. The IR ladder

Gpufuck uses several IRs because they answer different questions. They are not mandatory passes
through one monolithic pipeline.

### 4.1 Source ASTs

Each frontend owns its AST. The repository examples intentionally have independent parsers and
lowerers under `src/haskell_functional/`, `src/ocaml_functional/`, `src/rust_functional/`, and
`src/onesubml_functional/`. They demonstrate that target-neutrality is enforced by code boundaries,
not only claimed in documentation.

Source ASTs retain conveniences such as record syntax, nested patterns, guards, multiple equations,
or Rust-style matches. Those shapes do not enter the GPU ABI directly.

### 4.2 Functional Surface

The surface is the required high-level target. It contains:

- literals and names;
- lambdas and unary application;
- immutable `let`, lambda-valued `let-rec`, and local mutually recursive groups;
- `if`, primitive unary/binary operations, and numeric conversions;
- nominal constructors and flat constructor cases;
- definitions, structural annotations, nominal declarations, and an entry;
- source spans and explicit evaluation modes.

The builder in [`surface_builder.ts`](src/functional/surface_builder.ts) offers ergonomic objects
and then packs them. The format in [`abi.ts`](src/functional/abi.ts) is the actual portable
boundary.

The surface retains unresolved names. This is intentional: name resolution, dependency discovery,
recursive SCCs, and the relationship between annotations and definitions are part of the semantic
GPU workload.

Lists, records, traits, source modules, and multi-argument functions are not Core primitives. The
shared elaborators lower them into nominal declarations, explicit dictionaries, linked artifacts,
and unary functions. Local recursive groups are lambda-lifted into ordinary top-level SCCs, with
captured lexical values made explicit. Keeping the target small makes the same inference and backend
machinery useful to many languages.

### 4.3 Type schemas

Annotations and nominal fields use structural `FunctionalTypeSchema` trees. The supported leaves and
constructors include primitive types, parameters, tuples, named applications, functions, and
explicit `forall`.

Schemas use one canonical linked-preorder encoding. Each six-word record contains:

1. tag;
2. symbol;
3. first child index;
4. next sibling index;
5. start byte;
6. end byte.

Definition roots, type-parameter tables, constructor-field roots, and indexed result roots share the
same metadata buffer. The encoder and decoder are in
[`type_schema_abi.ts`](src/lazuli/type_schema_abi.ts). Inferred output is serialized in the same
format and read through the same decoder, preventing host and shader schema formats from drifting.

The decoder rejects cycles, reused records, invalid sibling relationships, invalid symbols, wrong
child counts, unreachable records, and excessive depth. Structural validation happens before
semantic trust.

### 4.4 Type normalization and evidence

The GPU schema ABI is deliberately first-order. Languages with higher-kinded type application or
associated families normalize those features before surface packing.

[`type_program.ts`](src/functional/type_program.ts) provides deterministic
`FunctionalTypeNormalizer` reduction.
[`capability_resolver.ts`](src/functional/capability_resolver.ts) provides bounded search for
frontend-defined predicates such as:

```text
field(owner, name)  -> fieldType
method(owner, name) -> implementation
copy(type)          -> proof
element(container)  -> elementType
```

Resolution returns an evidence tree. `verify()` can replay that tree independently, which allows
cache or transport boundaries without trusting a bare answer. Search is separate from normalization
because normalization should be deterministic while capability selection may be ambiguous.

[`constraint_elaboration.ts`](src/functional/constraint_elaboration.ts) joins normalization and
evidence search at call sites. Compile-time and erased evidence disappear; runtime evidence becomes
an explicit leading dictionary argument. This is also the higher-kinded boundary: constructor-kinded
parameters normalize before the first-order schema ABI is packed.

[`row_types.ts`](src/functional/row_types.ts) defines one open-row substitution algorithm for
records, variants, and effects. It is bounded by semantic transitions and rejects kind changes,
conflicting fields, recursive tails, and closed-row mismatches. Closed record and variant rows lower
to nominal constructors. Closed effect rows lower to Effect Core operation contracts. Open tails do
not enter the packed GPU ABI.

[`existential.ts`](src/functional/existential.ts) provides predicative existential packages through
a fixed-eliminator closure. The implementation captures a payload whose type mentions the hidden
parameter, but only a closed result crosses the package boundary. This supports abstract interfaces
without introducing impredicative inference or a new runtime representation.

[`type_core.ts`](src/functional/type_core.ts) supplies a small pure, kinded execution language for
closed type computations over types, wrapping integers, Booleans, and symbols. Structural lowering
and kind checking happen on the host; bounded execution uses the shared GPU semantic machinery.

These services do not change ordinary HM inference. Frontends opt in only when their type language
requires them.

### 4.5 Effect Core

Effect Core represents `return`, host calls, local operations, bind, branch, and handle. Its
contract is in [`effect_core_contract.ts`](src/functional/effect_core_contract.ts).

A persistent GPU pass validates one computation record per transition. It checks operation and
branch types, infers effect rows, and verifies that the computation graph is a rooted linear-use
tree. Reused or cyclic computation records fail before lowering. Handlers receive exactly one
continuation path, so malformed source cannot silently discard or duplicate a resumption through the
Effect Core representation.

[`effect_core_lowering.ts`](src/functional/effect_core_lowering.ts) lowers verified computations
into the ordinary surface. The normal resolver and inferencer then independently check embedded
value expressions. This two-stage check keeps effects explicit without adding effect-specific
expression tags to the resolved runtime Core.

### 4.6 Resolved Functional Core

Resolved Core is the trusted semantic input to evaluation and Wasm emission. Its nodes contain
numeric local depths, definition indices, constructor indices, child indices, source start/end
bytes, and evaluation mode. Surface names are never resolved a second time on the host.

The public decoded shape is `FunctionalCoreNode` in
[`compiler_module.ts`](src/functional/compiler_module.ts). The packed representation remains on GPU
buffers owned by `GpuFunctionalModule`; `readCoreNodes()` is an explicit readback for emission,
traces, and tests.

Core is small enough for multiple backends but rich enough to retain laziness decisions and source
fault locations.

## 5. Target-level modules

Source modules and target modules solve different problems.

The frontend parses imports, locates packages, applies visibility and language coherence, and emits
one `FunctionalModuleArtifact` for each selected source module. Each artifact contains definitions,
nominal types, typed imports, typed exports, source length, evaluation profile, host contracts, and
optional Wasm exports.

[`module_linker.ts`](src/functional/module_linker.ts) then:

- validates artifact structure;
- gives every definition, nominal type, and constructor a module-qualified name;
- rewrites local and imported references;
- turns each import alias into an annotated boundary definition;
- checks evaluation-profile and host-capability compatibility;
- rejects duplicate modules, missing imports, missing entries, and duplicate exports;
- concatenates source ranges without losing the owning module;
- selects one exported definition as the whole-program entry.

The import annotation makes the GPU verify the importer's declared contract against the exported
implementation. Nominal types stay qualified, so unrelated modules cannot become structurally equal
by accident.

Linking occurs before GPU compilation. Gpufuck does not currently emit independently typechecked
Wasm object files or dynamically link them at runtime.

### 5.1 Incremental compilation

[`incremental_graph.ts`](src/functional/incremental_graph.ts) fingerprints an exported interface
separately from its implementation and computes module dependency SCCs. The cache format includes:

- cache-format version;
- Functional ABI version;
- target and compiler/frontend version;
- interface and implementation fingerprints;
- dependency fingerprints;
- portable resolved Core and inferred types.

[`incremental_compiler.ts`](src/functional/incremental_compiler.ts) recompiles changed SCCs in a GPU
batch. An implementation-only change can preserve importers when the exported interface is stable.
An interface, nominal declaration, effect/capability contract, evaluation profile, or public Wasm
export change invalidates reverse dependencies. Mutually recursive modules are cached as one unit.

Cache entries never own live `GPUBuffer` objects. Relinking reconstructs an ordinary compiled
module, after which Wasm analysis remains whole-program and can optimize across module boundaries.

The design follows the separation between dependency structure and build actions described in
[Build Systems à la Carte](https://www.microsoft.com/en-us/research/publication/build-systems-la-carte/),
while using language-specific interface fingerprints rather than filesystem timestamps as semantic
validity evidence.

### 5.2 Reachability versus checking

The linker includes the artifacts supplied by the frontend. The GPU resolves and checks all linked
definitions. Later, Wasm emission computes reachability from the entry and explicit Wasm exports and
omits unreachable definitions.

This ordering is deliberate:

- unused declarations still receive source diagnostics;
- cached checking remains independent of a particular executable entry;
- whole-program Wasm remains small;
- the frontend retains responsibility for selecting the package dependency closure.

Early semantic slicing may be added as an optimization, but it cannot silently change whether an
unused invalid declaration is accepted.

## 6. Packed ABIs and trust boundaries

WebGPU storage buffers favor flat fixed-width records. Gpufuck therefore converts object graphs into
indexed arrays before submission.

Functional ABI version 5 shares the core physical layout with the Lazuli compatibility layer:

- expression/Core node: eight `u32` words;
- definition: four `u32` words;
- nominal type declaration: five `u32` words;
- constructor: five `u32` words;
- schema node: six `u32` words in canonical linked preorder.

The ABI stores counts explicitly and reserves `0xffffffff` as the absent index. Every buffer length,
root, child, symbol, arity, profile, primitive capability, and source span is validated before it is
used semantically.

There are three distinct version boundaries:

| Boundary                     | Current version | Purpose                                                   |
| ---------------------------- | --------------: | --------------------------------------------------------- |
| Functional/Lazuli module ABI |               5 | Host-to-GPU surface and resolved records                  |
| Functional Wasm value ABI    |               1 | Host arguments, results, structured values, and resources |
| Incremental cache format     |               1 | Portable resolved modules and dependency evidence         |

One version number cannot substitute for another. A change to cache metadata does not necessarily
change runtime values; a structured Wasm layout change does not necessarily change WGSL records.

Malformed packed input is an API contract violation and throws before GPU submission. A well-formed
program that cannot be typed returns a source diagnostic. Device allocation failure, device loss,
and impossible internal state are infrastructure failures and propagate with evidence.

## 7. GPU semantic compilation

[`compiler.ts`](src/functional/compiler.ts) is the language-neutral facade. It validates public
options and device-derived size limits, normalizes host contracts, admits work under a transient
memory budget, and delegates to the shared semantic engine in `src/lazuli/`.

The name “Lazuli” in the physical engine is historical. `src/functional/abi.ts` maps the neutral
contract onto that packed implementation, and no source-language syntax reaches its shaders.

### 7.1 Pipeline creation

`GpuFunctionalCompiler.create(device)` creates and validates the semantic-resolution and inference
compute pipelines once. Shader compilation messages are read before asynchronous pipeline creation,
so invalid WGSL fails at initialization rather than at the first user source.

Device limits determine maximum node, definition, type, constructor, and concurrent transient
storage. A device that cannot hold even one record is rejected with its reported limits.

Compiler reuse is therefore part of the API's performance model: pipeline creation is intentionally
outside individual compilation calls.

### 7.2 Resolution pass

The first persistent WGSL pass validates tables and converts the surface to Core. It:

- validates node tags, children, symbols, and declaration ranges;
- resolves lexical variables to de Bruijn-style depths;
- resolves definitions and constructors to numeric indices;
- verifies case binder and constructor shape;
- records definition dependency edges;
- retains both ends of the source span and the chosen evaluation mode.

Numeric local depths remove names from later phases and make lexical lookup independent of frontend
symbol tables. This representation follows the motivation of de Bruijn indices: alpha-equivalent
binders share one structural representation. See N. G. de Bruijn,
[“Lambda calculus notation with nameless dummies”](https://doi.org/10.1016/1385-7258(72)90034-0).

### 7.3 Inference pass

The second persistent WGSL pass consumes resolved nodes and canonical schema metadata. It performs:

- dependency SCC discovery and walking;
- union-find representative traversal;
- occurs checks and unification;
- environment lookup and lexical scheme handling;
- generalization and instantiation;
- annotation subsumption, skolemization, and variance-aware function comparison;
- indexed constructor refinement scoped to a case arm;
- compatible-constructor coverage and inaccessible-arm checks;
- entry concreteness;
- serialization of the inferred entry type.

The baseline inference discipline is Hindley–Milner, whose principal-type result originates in Luis
Damas and Robin Milner,
[“Principal type-schemes for functional programs”](https://doi.org/10.1145/582153.582176).
Dependency SCCs use the same graph concept introduced by Robert Tarjan in
[“Depth-first search and linear graph algorithms”](https://doi.org/10.1137/0201010).

Indexed constructors add local equality refinements. The architecture intentionally requires
annotations where a higher-rank or non-principal indexed boundary needs a frontend choice rather
than pretending all GADT programs have principal inferred types. Relevant background includes Peyton
Jones et al.,
[“Simple unification-based type inference for GADTs”](https://www.microsoft.com/en-us/research/publication/simple-unification-based-type-inference-for-gadts/)
and
[OutsideIn(X)](https://www.microsoft.com/en-us/research/publication/outsideinx-modular-type-inference-with-local-assumptions/).

Predicative rank-N parameters are checked only when explicitly annotated. Actual schemes are
instantiated, expected schemes are skolemized, parameter types are compared contravariantly, and
result types covariantly. Quantified values are not inferred impredicatively.

### 7.4 Truly bounded microsteps

The compiler's fuel and cancellation guarantees depend on a strict invariant: a charged semantic
transition performs constant-bounded work.

Input-sized algorithms are represented as durable work frames rather than loops hidden inside one
shader invocation. Union-find traversal, occurs checks, unification, generalization, instantiation,
schema traversal, coverage, concreteness, SCC walking, and output serialization can all suspend and
resume. One transition may:

- inspect one logical record or edge;
- push at most two durable frames;
- allocate at most one record in each arena;
- advance one semantic state-machine phase.

Fuel increments only when semantic work advances. Dispatch bookkeeping and workspace-growth yields
do not consume semantic fuel.

This definition matters more than asymptotic complexity. A linear scan of a million records inside
one “step” would make a one-step dispatch uncancellable for the duration of the scan. Explicit
frames make `maximumStepsPerDispatch` a meaningful upper bound on work between host observations.

The default total budget is 1,000,000 semantic transitions. Non-cancellable calls can use a larger
dispatch quantum to avoid readback overhead; calls carrying an `AbortSignal` use a finer default
quantum. An explicit quantum of one exists for exact fuel, growth, and cancellation tests and is
expected to be slow because every semantic transition becomes a submission/readback boundary.

### 7.5 Workspace arenas and growth

Inference keeps separate logical arenas for types, environments, work frames, refinements, scratch
records, and serialized output. Initial capacities are derived from input shape instead of fixed
large multipliers.

When an arena fills, the runner in
[`gpu_type_inference_runner.ts`](src/lazuli/gpu_type_inference_runner.ts):

1. identifies the exhausted arena from structured state;
2. doubles only that logical capacity, subject to device limits;
3. allocates a replacement workspace;
4. copies live logical records at their new bases;
5. patches bases and capacities;
6. resumes the same phase with the same fuel, results, and refinements;
7. destroys the old workspace after a successful transfer.

Output growth follows the same durable model. A failed copy, allocation error, or cancellation owns
both temporary buffers until both are destroyed. After a completed growth there is exactly one
active workspace.

Device-size and allocation-limit failures become bounded-work diagnostics only when they represent a
program exceeding the supported workspace. Device loss and violated invariants are not disguised as
source errors.

### 7.6 Batching and scheduling

`compileBatch()` packs independent programs into lanes. A workgroup advances each lane, terminal
lanes become inactive, and one mapped state readback observes the batch at a quantum boundary.
Results preserve input order.

Successful packed lanes are copied into independently owned compiled-module buffers only after their
terminal state is known. Diagnostic lanes allocate no persistent result module. If one lane needs
elastic growth, completed siblings remain valid and only the exceptional lane continues on the
scalar growth path.

[`gpu_dispatch_scheduler.ts`](src/functional/gpu_dispatch_scheduler.ts) coalesces ready dispatches
into one command buffer, up to a fixed lane limit. Two microtasks allow sibling compiler promises to
reach the queue together. [`compilation_admission.ts`](src/functional/compilation_admission.ts)
bounds concurrent work by both request count and estimated transient bytes, preventing many large
callers from exhausting one device merely because JavaScript scheduled them concurrently.

Cancellation is checked while queued, before submission, and after the validation scope resolves. A
submitted GPU dispatch cannot be interrupted mid-command; bounded quanta limit the interval until
the next observation.

## 8. Compile-time execution

Required compile-time execution is a target-neutral staging boundary, not a syntax feature.
[`comptime.ts`](src/functional/comptime.ts) accepts ordinary module artifacts whose selected exports
must evaluate to closed first-order constants.

The pipeline is:

```text
comptime artifacts
    ├─ static link and GPU semantic compilation
    ├─ purity and closed-result checks
    ├─ bounded evaluation
    ├─ canonical constant encoding
    └─ optional generated-definition decoding and splice
```

Required execution supports pure functions, recursion, scalar values, tuples, ADTs, cases, and
cross-module constants. It rejects host capabilities, effects, suspension, closures in public
results, malformed generated IR, and exhausted compilation/execution/output budgets.

Tiny closed first-order constants use cached fuel-instrumented Wasm by default because GPU
submission and readback dominate the computation. Explicit GPU evaluator controls remain available
for deterministic dispatch and workspace tests. This is a performance decision after semantic
checking, not a change in the frontend contract.

The canonical `FunctionalConstant` format distinguishes semantic values from frontend-defined
metadata. Type trees, proofs, and capability evidence are represented by declared ADTs rather than
privileged host tags. Generated code uses the schemas in
[`comptime_ir.ts`](src/functional/comptime_ir.ts); the host validates every constructor, list shape,
name, operator, and evaluation mode before splicing definitions into a normal artifact.

`partiallyEvaluateFunctionalModule()` is optional and non-authoritative. It replaces a selected pure
nullary definition only after successful bounded evaluation. A compile error, runtime fault, closure
result, or exhausted limit leaves the original definition untouched, so an optimization cannot
decide whether a runtime program is accepted.

Incremental comptime caches dependency outputs, not just implementations. If a dependency changes
but computes the same exported constants, consumers remain valid. A changed constant invalidates the
reverse dependency closure.

## 9. Compiled module and evaluator

A successful `GpuFunctionalModule` contains:

- resolved node, definition, and constructor GPU buffers;
- counts, roots, qualified names, and constructor arities;
- the selected entry and its concrete inferred type;
- nominal declarations and host capability contracts;
- explicit public Wasm exports;
- source-module ranges and evaluation profile;
- an idempotent `destroy()` operation.

The caller owns this object. Destroying it releases GPU buffers but does not invalidate Wasm bytes
already emitted from it.

[`evaluator.ts`](src/functional/evaluator.ts) is a bounded graph reducer used for differential
testing, explicit GPU evaluation, and structured traces. It supports strict and call-by-need binding
modes, lane-local fuel, bounded heap and stack, cancellation, and deep-result limits.

It is not the default deployment runtime. The source-language run commands normally emit and execute
Wasm. Keeping the evaluator independent is valuable because backend tests can compare two
implementations of the same resolved Core semantics.

Portable WGSL does not expose native `i64` or `f64`, and its floating-point rules do not promise all
host-Wasm rounding behavior. The evaluator represents wrapping `i64` with two words and handles a
safe basic `f32` subset on GPU. Operations requiring exact portable wide or division/square-root
semantics use cached fuel-instrumented Wasm. The limitation follows the scalar types defined by the
[WGSL specification](https://www.w3.org/TR/WGSL/), not a frontend restriction.

## 10. Wasm backend

Wasm emission begins only after GPU resolution and inference succeed. The host reads resolved Core
and emits a dependency-free binary directly; there is no WAT round trip.

The backend follows the [WebAssembly Core Specification](https://webassembly.github.io/spec/core/)
for binary encoding, validation, functions, tables, linear memory, numeric operations, and control
flow. Binary primitives are implemented in [`wasm_binary.ts`](src/functional/wasm_binary.ts), while
[`wasm_codegen.ts`](src/functional/wasm_codegen.ts) orchestrates analysis and emission.

### 10.1 Analysis order

Backend analyses run in an order that exposes facts to later choices:

1. Determine entry and explicit export signatures.
2. Compute global definition reachability.
3. Recognize function shapes, saturation, recursion, tail calls, and numeric folds.
4. Compute lexical captures and environment layouts.
5. Propagate lambda sets through values, calls, branches, recursion, and constructor fields.
6. Select direct workers, finite direct dispatch, or general closures.
7. Determine strict/lazy representation and runtime facilities required.
8. Emit functions, runtime support, memory/table sections, imports, exports, and fault evidence.

Analysis consumes resolved indices. No pass performs string-based source name resolution.

### 10.2 Dead-code and runtime elimination

[`wasm_function_analysis.ts`](src/functional/wasm_function_analysis.ts) walks global references from
the selected entry and every explicit Wasm export. Unreachable definitions are absent from the
artifact.

Feature reachability also controls runtime support. A strict effect-free scalar program can omit:

- linear memory;
- allocator and free list;
- thunk records and forcing;
- function table and indirect dispatch;
- unused fault globals and signatures;
- zero-valued instrumentation exports.

This is definition-level whole-program elimination plus runtime feature pruning. It is not a general
SSA optimizer: nodes inside a reachable definition remain available to structured expression
emission, and all submitted definitions were already typechecked.

### 10.3 Strict representation

Strict, captureless, effect-free integer functions are candidates for native `i32` workers. Eligible
workers:

- omit an environment parameter;
- accept and return native `i32` values internally;
- receive known strict numeric arguments eagerly;
- keep numeric loop state unboxed;
- lower saturated tail recursion to structured Wasm loops;
- can be fused into a caller when a recursive worker has one saturated use.

Boxing occurs at lazy, aggregate, higher-order, or public tagged-value boundaries. These decisions
are made from checked Core types and evaluation modes, never from source spelling.

### 10.4 Lazy call-by-need representation

Lazy globals, bindings, function arguments, and constructor fields compile to specialized thunks. A
thunk stores its code slot, captures, state, and cached value. Forcing transitions through:

```text
unevaluated ─► evaluating ─► evaluated(value)
                    │
                    └─ recursive force ─► blackhole fault
```

The fast path observes an already evaluated thunk. The slow path evaluates once and updates the
record, preserving sharing. Immediately applied lambdas and saturated constructors can bypass
closure/thunk allocation where demand is statically known, provided the transformation preserves
non-strictness.

`surface.delay()` and `surface.force()` expose the same mechanism as an explicit nominal
`Thunk value`. This is distinct from selecting a module-wide or per-boundary evaluation profile: the
former is a value in the source program, while the latter defines implicit evaluation semantics.

This operational model corresponds to the sharing requirement formalized by John Launchbury in
[“A natural semantics for lazy evaluation”](https://doi.org/10.1145/158511.158618). Gpufuck uses an
explicit Wasm heap representation rather than reproducing Launchbury's semantics as an
implementation algorithm.

### 10.5 Lambda-set specialization

[`wasm_lambda_sets.ts`](src/functional/wasm_lambda_sets.ts) tracks which lambdas can flow to each
higher-order call site.

- A singleton set becomes a direct call.
- A finite multi-lambda set becomes tagged direct dispatch.
- Structurally known higher-order arguments can remain virtual and avoid closure allocation.
- Incomplete, excessively wide, or code-growth-heavy flows retain `call_indirect`.

The pass is based on Michael Vollmer et al.,
[“Lambda Set Specialization”](https://www.cs.princeton.edu/~mpmilano/publication/lss/). Gpufuck
keeps semantic function types unchanged; lambda sets are backend representation facts, not frontend
ABI types.

Specialization limits bound code growth. Constructors used as callables, host operations, very wide
sets, and sites beyond the inline budget retain the general closure path without changing behavior.

### 10.6 Storage planning and runtime memory

[`storage_plan.ts`](src/functional/storage_plan.ts) runs after semantic Core resolution and before
Wasm emission. It is deliberately a representation pass rather than a source ownership checker.
Every closure, constructor function, and thunk that can require storage receives a durable decision:

| Storage class      | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `static`           | Reachable for the lifetime of one instantiated module                 |
| `scalar-local`     | Virtual/code-and-local representation with no allocation on that path |
| `invocation-arena` | Immutable graph storage bounded by one logical invocation             |
| `owned`            | A boundary transfers responsibility for eventual release              |
| `host-managed`     | The host retains lifetime responsibility and promises safe sharing    |

A scalar-local closure can carry `escapeStorage: "invocation-arena"`. That distinction is important:
specialization may keep the common call path allocation-free without claiming that a first-class
escape is stack-safe. Local recursive closures use invocation storage because their environment may
contain a self reference. Global thunks remain static because memoized results can be reachable from
the module's definition table after a call returns.

The plan lowers into the target-neutral Storage Core in
[`storage_core.ts`](src/functional/storage_core.ts). Storage Core is a linear sequence of
declarations, references, arena entry/exit, promotion, retain/release, and use operations. It is
deliberately separate from semantic Core: source evaluation and typechecking do not change when a
frontend picks a region or ownership policy. The verifier enforces these invariants before code
generation:

- arena declarations name the innermost active lexical arena and arenas leave in LIFO order;
- a longer-lived value cannot retain an arena value that expires first;
- values cannot be used, retained, or released after their lifetime ends;
- arena-to-owned promotion names an active source and a fresh target;
- persistent ownership is rejected, delegated to host management, or balanced by explicit retains.

Failures carry `F6001`–`F6006`, the failing operation, an optional semantic Core node, and the names
that violated the invariant. `planFunctionalModuleStorage()` returns the derived operations and
successful verification alongside its summary. A frontend that introduces more lexical arenas can
submit its own `FunctionalStorageCoreProgram` to the same verifier before emission.

Code generation consumes the derived plan and treats a missing decision as an invariant violation
with the value kind and Core node attached. A Rust-like frontend can compare its move/borrow proof
with the selected representation; a lazy frontend can inspect where thunks introduce invocation
storage. Neither needs to encode those language-specific rules into Functional Core.

General modules use aligned growing linear memory for closures, environments, constructors, thunks,
text, bytes, arrays, slices, and boxed wide values. Allocation checks are reduced only where
analysis proves a group of writes fits after one check.

The runtime exposes an explicit reusable free list for transferred host values and scratch-region
markers for temporary boundary allocations. It is not a tracing collector. Functional evaluation
allocates immutable graph objects, while ownership-transfer values can be reclaimed at explicit
boundary points.

Persistent sharing has three explicit policies. `reject` diagnoses a second durable owner.
`host-managed` requires the shared value to cross the boundary with host-managed lifetime.
`explicit-reference-counting` requires enough retains for the recorded owners. The Wasm embedding
implements the last policy with independent `FunctionalWasmOwnedValue` leases; the final release
recursively frees every encoded block and calls frontend-provided drop glue for opaque resources.
This is deterministic destruction, not cycle collection. A language requiring cyclic persistent
heaps must lower a collector or reject that shape.

Scratch arenas can reclaim a region only when no static definition, memoized global, result, or host
borrow points into it. Gpufuck therefore does not reset the entire heap at an arbitrary public call
boundary: doing so would invalidate global call-by-need results. Functional Core does not silently
choose one memory-management policy for every language.

The standard runner initializes static values before opening the invocation arena. When the plan
contains no static thunk, it resets that region after decoding the public result, including failure
paths and temporary encoded arguments. If a static thunk exists, the plan sets `automaticArenaReset`
to false and preserves the heap so memoized pointers remain valid. The explicit scratch API remains
available to an embedding with stronger reachability knowledge.

[`wasm_arena.ts`](src/functional/wasm_arena.ts) owns the runtime lifecycle. Arenas are nested and
must reset in LIFO order. Opening one snapshots both the bump frontier and owned free-list head,
then hides pre-existing free blocks so temporary allocation cannot consume storage whose ownership
predates the arena. Reset discards encoded-value ownership records created above the mark and
restores both frontiers. The standard runner and the compatibility scratch-mark API use this same
path.

`withFunctionalWasmArena()` holds a lexical arena across synchronous or asynchronous embedding code
and resets it in `finally`. Boundary values are encoded explicitly into the active arena. Promotion
decodes the selected graph, resets the source region, and re-encodes it into its parent or into
owned storage. Partial encoding failures release every block already allocated. Owned encoding is
rejected while any arena is active, preventing a temporary pointer from being mislabeled as
persistent.

The async runner does not keep a Wasm arena alive while a host promise is pending. Each replay
attempt closes its invocation arena before awaiting the suspension. An `AbortSignal` races the wait;
cancellation rejects with the signal reason, and a later invocation starts with independent replay
records and storage. Wasm itself remains synchronous, so cancellation cannot preempt instructions
inside one direct Wasm call.

This supplies invocation and embedding arenas without adding an arena opcode to semantic Core. A
source language that exposes lexically nested arenas lowers its proven scopes into Storage Core and
the explicit runtime operations; the generic compiler does not infer that source-level lifetime
promise from ordinary function types.

### 10.7 Public value ABI

[`wasm_abi.ts`](src/functional/wasm_abi.ts) defines Functional Wasm Value ABI v1. Scalars use native
Wasm values where the entry permits it. General structured values use an eight-byte tagged value and
aligned objects with a sixteen-byte header:

| Byte offset |    Width | Meaning                                                |
| ----------: | -------: | ------------------------------------------------------ |
|           0 |        4 | Object kind                                            |
|           4 |        4 | Constructor index, state, numeric kind, or resource ID |
|           8 |        4 | Field count or byte length                             |
|          12 |        4 | Reserved                                               |
|          16 | variable | Contiguous fields or bytes                             |

[`wasm_value_codec.ts`](src/functional/wasm_value_codec.ts) validates and encodes arguments, forces
structured results as required, decodes fields within `maximumResultNodes`, and rejects cyclic or
higher-order public results.

Higher-order closures remain internal because a stable cross-runtime closure ABI would expose the
backend's environment and code-table representation. One concrete first-order argument and result,
or an `Init -> result` entry, keeps the deployment boundary explicit.

### 10.8 Host capabilities and ownership

Host capabilities are declared values and operations, collected into one reserved nominal `Init`
constructor. User Core destructures that constructor like ordinary algebraic data, so inference
needs no host-specific opcode.

Each operation declares concrete input/output types, purity, and sync or suspending execution. Pure
intrinsics such as byte length or indexing may lower entirely into the module. Other operations
become Wasm imports under a capability-qualified namespace.

`FunctionalHostOwnership` records bounded-borrow, frozen-shareable, ownership-transfer, and unique
contracts. The host adapter verifies the selected representation and lifetime. The source frontend
decides whether its program is legally allowed to select that contract.

Purity is never inferred from JavaScript behavior. A frontend with no effect proof must label an
operation conservatively.

### 10.9 Effects and async replay

Handled algebraic effects lower inside the module. Operations that escape become explicit `Init`
requirements recorded on `GpuFunctionalModule.entryEffects`.

The synchronous runner rejects suspending host operations. `runFunctionalWasmModuleAsync()` uses
bounded deterministic replay:

1. run until an unresolved host Promise is encountered;
2. unwind the Wasm call;
3. await the Promise;
4. memoize its completed result;
5. restart deterministically, replaying completed effects without invoking them again;
6. continue until completion or the suspension budget is exhausted.

Replay avoids stackful continuation machinery and keeps the Wasm artifact portable, at the cost of
re-executing pure work between suspension points. The runner detects replay divergence and reports
it as a structured runtime failure.

The algebraic-effect boundary is informed by Plotkin and Pretnar,
[“Handling Algebraic Effects”](https://doi.org/10.2168/LMCS-9(4:23)2013), while the concrete replay
protocol is a gpufuck portability choice rather than an implementation of that paper's calculus.

## 11. Diagnostics

Errors are divided by trust boundary.

| Class               | Meaning                                                     | Channel                                  |
| ------------------- | ----------------------------------------------------------- | ---------------------------------------- |
| `F1xxx`             | Structural, resolution, or work-limit diagnostic            | Compile result                           |
| `F2xxx`             | Type, annotation, indexed coverage, or inference diagnostic | Compile result                           |
| `F3xxx`             | Evaluation/runtime semantic fault                           | Fault result or translated runtime error |
| `F4xxx`             | Module link or Wasm boundary contract failure               | Typed exception                          |
| `F5xxx`             | Compile-time value or output-limit failure                  | Comptime result                          |
| WebGPU/device error | Infrastructure or unavailable execution substrate           | Rejected/thrown error with cause         |
| Invariant failure   | Backend bug or corrupt trusted state                        | Thrown error                             |

Source spans are UTF-8 byte offsets because packed source evidence must be independent of JavaScript
UTF-16 indexing. Linked modules retain aggregate byte ranges. `locateFunctionalSpan()` and
`locateFunctionalDiagnostic()` map neutral evidence back to a module; the frontend maps the
module-relative offset to lines, columns, excerpts, and its own wording.

Conflicts can carry related declaration spans. Runtime-generated modules export fault code and Core
node evidence so a host not using gpufuck's runner can build equivalent translation.

Cancellation is not a source diagnostic. It rejects with the caller's abort reason. A host exception
is wrapped with capability and operation evidence while remaining accessible as `cause`.

## 12. Resource ownership and failure safety

Ownership follows the layer that allocates a resource:

| Resource                                | Owner                                       | Release point                                |
| --------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `GPUDevice`                             | Application                                 | Application shutdown                         |
| Compiler pipelines                      | `GpuFunctionalCompiler`/device lifetime     | Device destruction                           |
| Surface upload and inference workspaces | One compilation                             | Every success, failure, or cancellation path |
| Compiled Core buffers                   | Successful `GpuFunctionalModule`            | `module.destroy()`                           |
| Evaluator heap/stack/readback           | One evaluation                              | Evaluator `finally` path                     |
| Emitted Wasm bytes                      | Caller                                      | JavaScript lifetime                          |
| Compiled `WebAssembly.Module` cache     | Backend bounded cache                       | Cache eviction                               |
| Wasm instance state                     | One run unless caller instantiates directly | Run completion/GC                            |
| Directory incremental entries           | Build cache                                 | Frontend cache policy                        |

Workspace growth temporarily owns both old and replacement buffers. Ownership transfers only after
the copy and state patch complete. Catch blocks cannot continue with ambiguous ownership.

Compiled-module destruction is idempotent. Public Wasm byte arrays are independent copies so a
caller may transfer or mutate one without corrupting a later emission.

## 13. Lazuli's role

Lazuli is the reference language and compatibility API, not the definition of Functional Core. Its
Baba-generated parser runs on the host, lowers to the same neutral surface as other frontends, and
uses lazy call-by-need by default.

Lazuli exercises:

- inferred functions and recursive data;
- explicit specialization descriptors and partial type holes;
- indexed equality proofs and impossible cases;
- built-in text, bytes, and lists;
- host `Init` values;
- a compiler written in Lazuli that emits Wasm text bytes.

The historical implementation names under `src/lazuli/` are shared physical machinery. New semantic
features must be exposed through `src/functional/` contracts and must not depend on Lazuli keywords
or parser structures.

The repository's Baba-generated Gleam parser demonstrates the intended separation at module scale:
its adapter owns Gleam syntax, visibility, pipeline desugaring, and the rule that public functions
need complete artifact types; the neutral linker and GPU compiler only see strict Functional Surface
modules. A smaller Baba-generated PureScript grammar parses an explicit-layout profile that
exercises open rows, associated results, recursive capability evidence, and rank-2 checking without
claiming full PureScript compatibility. Together they distinguish a usable source adapter from a
backend-representation experiment.

The old Brainfuck compiler remains only as historical and benchmark context. Its instruction format
is not an intermediate representation for other languages.

## 14. Architectural decisions

This section records decisions that are easy to accidentally reverse in a local patch.

### 14.1 Frontend syntax stays host-side

**Decision:** parse and desugar on the host; upload flat semantic records.

**Why:** source grammars, filesystem lookup, recovery, macros, and diagnostics are language-specific
and branch-heavy. Moving them to WGSL would couple every syntax change to shader pipelines and make
the target unusable by existing frontends.

**Cost:** frontend preparation remains CPU work and each language needs an adapter.

**Revisit when:** a common pre-parsed binary frontend format needs direct ingestion—not merely when
one parser becomes slow.

### 14.2 Resolution and inference stay GPU-side

**Decision:** production name resolution, dependency analysis, inference, coverage, and Core
lowering execute in persistent GPU machines.

**Why:** these stages are the shared semantic workload gpufuck is designed to batch. Resolving names
again on the host would create two authorities and make traces, diagnostics, and performance depend
on a hidden CPU compiler.

**Cost:** algorithms must be expressed without recursion, with explicit arenas and frames, under
WGSL's portable type limits.

**Revisit when:** a fallback backend implements the same state-machine contract and is explicitly
selected, not silently used after a GPU failure.

### 14.3 One canonical schema format

**Decision:** input annotations, nominal metadata, and inferred output share six-word
linked-preorder records.

**Why:** duplicate host/shader encodings previously risked semantic drift and extra repacking.

**Cost:** the shared decoder must validate every role and the schema ABI cannot be changed casually.

**Revisit when:** a versioned successor demonstrates a measurable bottleneck or expressiveness gap.

### 14.4 Constant-bounded transitions

**Decision:** no input-sized loop is allowed inside one charged transition.

**Why:** fuel, cancellation, and dispatch quanta must bound wall-clock latency as well as total
semantic work.

**Cost:** simple recursive algorithms become explicit frame machines with larger durable state.

**Revisit when:** never as a hidden optimization; a wider transition would need an explicit bounded
constant and preserved cancellation guarantee.

### 14.5 Elastic region-specific growth

**Decision:** begin with input-derived arenas and double only the exhausted region.

**Why:** fixed worst-case multipliers waste device memory and reduce useful concurrency.

**Cost:** growth needs copy/patch/resume logic and meticulous failure cleanup.

**Revisit when:** profiling shows a stable arena-specific sizing formula can avoid copies without
inflating ordinary programs.

### 14.6 Frontend-selected strictness

**Decision:** the frontend selects strict or lazy defaults and may annotate binding boundaries;
explicit thunks remain ordinary typed values.

**Why:** strictness is source-language semantics. Treating every value as a thunk penalizes strict
languages; forcing everything changes Haskell-like programs.

**Cost:** evaluators and Wasm emission support mixed representation.

**Revisit when:** a frontend requires a thunk operation beyond deterministic call-by-need
`delay`/`force`, not merely another spelling for implicit laziness.

### 14.7 Whole-program Wasm after incremental checking

**Decision:** cache resolved module SCCs, relink them, then perform whole-program backend analysis.

**Why:** source modules need incremental builds, while DCE, capture analysis, lambda sets, and
worker specialization benefit from seeing the final entry closure.

**Cost:** Wasm emission is repeated after relinking and there is no public object-file linker.

**Revisit when:** emission dominates real incremental builds enough to justify a versioned
relocatable format without losing cross-module optimization.

### 14.8 Explicit effects and host capabilities

**Decision:** effects use Effect Core or explicit host operations; `Init` carries capabilities.

**Why:** the backend cannot infer purity from an arbitrary host implementation, and different
languages assign different meanings to `IO` and sequencing.

**Cost:** frontends must classify operations or conservatively mark them effectful.

**Revisit when:** richer effect rows are added to a versioned neutral contract, not for
language-specific syntax.

### 14.9 Deterministic replay for suspension

**Decision:** async execution unwinds and replays instead of storing stackful continuations.

**Why:** replay works with ordinary Wasm engines and keeps the emitted binary independent of a
continuation proposal or custom runtime stack.

**Cost:** pure work between suspensions can run more than once and replay must detect divergence.

**Revisit when:** portable continuation support is available on target runtimes and measurements
justify a second execution protocol.

### 14.10 No implicit CPU fallback

**Decision:** semantic compilation fails clearly when no WebGPU adapter exists.

**Why:** a silent fallback would have different performance, cancellation, higher-rank coverage, and
possibly diagnostic behavior. The TypeScript inferencer is an oracle, not a production authority.

**Cost:** CPU-only build machines need a software adapter or remote/prebuilt Wasm artifacts.

**Revisit when:** a CPU implementation passes the same differential, bounded-work, fuel, and
diagnostic contracts and is exposed as an explicit backend choice.

### 14.11 Wasm fallback for wide numeric evaluation

**Decision:** portable GPU evaluation delegates operations unavailable or insufficiently exact in
WGSL to fuel-instrumented Wasm.

**Why:** WGSL lacks portable `i64` and `f64`; pretending otherwise would produce backend-dependent
semantics.

**Cost:** evaluator execution substrate can vary by operation even though the checked Core is one
semantic program.

**Revisit when:** the WebGPU/WGSL portability baseline exposes the required scalar operations.

### 14.12 Explicit allocator, no tracing GC

**Decision:** generated general Wasm uses an explicit arena/free-list runtime.

**Why:** a tracing collector would add binary size, pauses, roots, and language policy even for
small pure programs. Strict scalar paths should not pay for it.

**Cost:** long-lived allocation-heavy programs need frontend/runtime cooperation or a different
memory strategy.

**Revisit when:** a consumer workload requires long-lived cyclic heaps and can define a neutral root
and collection contract.

## 15. Limits and safety properties

Current structural limits include 1 MiB of source evidence, 65,536 surface nodes, semantic depth
512, constructor arity 64, and device-derived buffer maxima. Runtime and compile-time APIs add
explicit fuel, heap, stack, dispatch, output-node, output-byte, output-depth, and suspension limits.

These limits serve several purposes:

- prevent integer overflow in byte-size calculations;
- ensure every GPU index fits the packed representation;
- keep host validation and decoding bounded;
- bound denial-of-service exposure for untrusted programs;
- make cancellation intervals configurable;
- turn device limitations into reproducible evidence.

The project does not claim that arbitrary untrusted Wasm host functions are safe. Host capabilities
are application code and run with the authority provided by the embedding runtime. Gpufuck validates
types and boundary shapes, not the behavior of a host implementation.

Proof witnesses and capability dictionaries are ordinary values unless a frontend/backend pass
explicitly erases them. Recursive proof programs can diverge. Typechecking does not imply totality.

## 16. Extending the architecture

### Add a source construct

First ask whether it is syntax, semantics shared by several languages, or runtime policy.

- Syntax or sugar belongs in the frontend and lowers to existing surface nodes.
- A shared type-level decision may belong in Type Core, normalization, or capability evidence.
- A shared effect construct may belong in Effect Core.
- A runtime host facility belongs in an explicit capability and Wasm ABI contract.
- A genuinely new Core semantic requires coordinated ABI, resolution, inference, evaluator, Wasm,
  diagnostic, trace, and compatibility changes.

### Add a primitive operation

Define its source-independent types and semantics first. Then update the surface operator, packed
ABI, GPU verifier/inferencer, evaluator or justified fallback, Wasm emitter, fault translation,
differential oracle, malformed-input tests, and end-to-end execution tests.

Do not add a primitive merely because one frontend has convenient syntax for it. Records, lists,
methods, and modules already demonstrate that many features lower cleanly without new opcodes.

### Add a type-system feature

Choose the lowest sufficient layer:

- deterministic type reduction: `FunctionalTypeNormalizer`;
- bounded fact or implementation discovery: capability rules and evidence;
- pure closed type execution: Type Core;
- runtime type inference shared by ordinary functions: GPU inference;
- frontend-specific elaboration, universes, totality, or coherence: frontend.

Only the last shared case should enlarge the packed inference ABI.

### Add a Wasm optimization

State the semantic preconditions in terms of resolved Core types, evaluation modes, captures, and
effects. Add a negative case that violates one precondition and must retain the general path.
Measure source-to-Wasm latency, artifact size, instantiation, first execution, warm execution,
allocations, and thunk forces separately.

## 17. Internal source map

| Concern                   | Primary modules                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| Public types and ABI      | `src/functional/abi.ts`, `functional.ts`                                                                 |
| Surface packing           | `src/functional/surface_builder.ts`                                                                      |
| Static linking            | `src/functional/module_linker.ts`                                                                        |
| Incremental graph/cache   | `src/functional/incremental_graph.ts`, `incremental_compiler.ts`, `incremental_cache.ts`                 |
| Compiler facade/admission | `src/functional/compiler.ts`, `compilation_admission.ts`                                                 |
| GPU resolution            | `src/lazuli/compiler_shader.ts`, `gpu_semantic_compiler.ts`                                              |
| GPU inference             | `src/lazuli/type_inference_shader.ts`, `gpu_type_inference_runner.ts`, `gpu_type_inference_workspace.ts` |
| Canonical schemas         | `src/lazuli/type_schema_abi.ts`                                                                          |
| Type services             | `src/functional/type_program.ts`, `type_core.ts`, `capability_resolver.ts`                               |
| Effects                   | `src/functional/effect_core.ts`, `effect_core_lowering.ts`, `effect_lowering.ts`                         |
| Comptime                  | `src/functional/comptime.ts`, `comptime_constant.ts`, `comptime_ir.ts`, `partial_evaluation.ts`          |
| Compiled module/evaluator | `src/functional/compiler_module.ts`, `evaluator.ts`                                                      |
| Wasm analyses             | `src/functional/wasm_function_analysis.ts`, `wasm_capture_analysis.ts`, `wasm_lambda_sets.ts`            |
| Wasm emission/runtime     | `src/functional/wasm_codegen.ts`, `wasm_binary.ts`, `wasm_runtime_binary.ts`                             |
| Wasm boundary/execution   | `src/functional/wasm_value_codec.ts`, `wasm_host_boundary.ts`, `wasm_execution.ts`                       |
| Diagnostics               | `src/functional/diagnostics.ts`, `src/lazuli/compilation_diagnostics.ts`                                 |

## 18. Technical references

The implementation is not a direct transcription of any one paper. These sources explain the
standards and algorithms that shaped specific decisions:

### Platform standards

- W3C, [WebGPU](https://www.w3.org/TR/webgpu/) — device, queue, buffer, pipeline, command, error
  scope, and limit model used by semantic compilation.
- W3C, [WebGPU Shading Language](https://www.w3.org/TR/WGSL/) — portable compute language and scalar
  type constraints behind explicit frames and wide-numeric fallbacks.
- WebAssembly Community Group,
  [WebAssembly Core Specification](https://webassembly.github.io/spec/core/) — binary format,
  validation, execution, numeric behavior, memory, tables, and control flow emitted by the backend.

### Names, graphs, and inference

- N. G. de Bruijn,
  [“Lambda calculus notation with nameless dummies”](https://doi.org/10.1016/1385-7258(72)90034-0) —
  numeric lexical binding representation.
- Robert Tarjan, [“Depth-first search and linear graph algorithms”](https://doi.org/10.1137/0201010)
  — strongly connected components for recursive dependency groups.
- Luis Damas and Robin Milner,
  [“Principal type-schemes for functional programs”](https://doi.org/10.1145/582153.582176) —
  principal Hindley–Milner inference.
- Robert Tarjan and Jan van Leeuwen,
  [“Worst-case analysis of set union algorithms”](https://doi.org/10.1145/62.2160) — union-find
  structure underlying representative traversal and unification.
- Simon Peyton Jones et al.,
  [“Simple unification-based type inference for GADTs”](https://www.microsoft.com/en-us/research/publication/simple-unification-based-type-inference-for-gadts/)
  — scoped equality refinement and the limits of principal inference.
- Dimitrios Vytiniotis et al.,
  [“OutsideIn(X): Modular type inference with local assumptions”](https://www.microsoft.com/en-us/research/publication/outsideinx-modular-type-inference-with-local-assumptions/)
  — local assumptions, constraints, and annotation boundaries relevant to indexed cases.

### Evaluation and optimization

- John Launchbury,
  [“A natural semantics for lazy evaluation”](https://doi.org/10.1145/158511.158618) — call-by-need
  sharing semantics motivating updateable thunks and blackhole detection.
- Michael Vollmer et al.,
  [“Lambda Set Specialization”](https://www.cs.princeton.edu/~mpmilano/publication/lss/) — finite
  callee-set analysis and direct higher-order dispatch.
- Gordon Plotkin and Matija Pretnar,
  [“Handling Algebraic Effects”](https://doi.org/10.2168/LMCS-9(4:23)2013) — algebraic operations
  and handlers informing the neutral Effect Core boundary.
- Andrey Mokhov, Neil Mitchell, and Simon Peyton Jones,
  [“Build Systems à la Carte”](https://www.microsoft.com/en-us/research/publication/build-systems-la-carte/)
  — separating dependency graphs, incremental validity, and build execution.

When a new algorithm or platform proposal materially shapes an invariant, add the primary source
next to the relevant design section and to this index. References document rationale; tests and the
versioned contracts remain the executable specification.
