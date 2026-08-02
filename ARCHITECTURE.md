# Architecture

This document records the current compiler boundaries and the choices a local change must not
silently reverse. Consumer integration lives in [README.md](README.md), commands in
[DEVELOPMENT.md](DEVELOPMENT.md), and measurements in [BASELINE.md](BASELINE.md).

## 1. Purpose and scope

gpufuck is a typed backend for functional-language frontends. A frontend owns syntax and
source-language policy, lowers into Functional Surface, and receives checked Functional Core that
the backend emits as linear-memory WebAssembly.

The project owns:

- the language-neutral Surface and packed ABI;
- name resolution, type inference, annotations, indexed refinements, and coverage;
- static module linking and effect summaries;
- a CPU compiler and an optional GPU semantic compiler;
- one public execution target and runtime: linear-memory WebAssembly; and
- Canonical ABI adapters, component boundaries, SIMD, stores, resource limits, and diagnostics.

Parsing, module discovery, visibility, numeric defaulting, ownership policy, source-specific effect
rules, and diagnostic presentation belong to the frontend. The backend does not carry an alternative
parser, source language, Wasm-GC target, Type Core, capability solver, or Storage Core.

## 2. Compilation pipeline

```text
frontend parser and checks
        │
        ▼
Functional Surface / module artifacts
        │
        ├── link, prune unreachable definitions, resolve names
        │
        ├── CPU inference (ordinary profile and compiler-service default)
        │       or
        └── GPU inference (explicit or GPU-only profile)
                │
                ▼
        resolved Functional Core
                │
                ▼
       linear-memory WebAssembly
                │
                ├── private runtime or Canonical ABI adapters
                └── synchronous or suspending host capabilities
```

CPU and GPU semantic compilation consume the same packed input and must produce equivalent Core,
types, effects, and diagnostics. The internal GPU graph evaluator exists for differential and
compiler tests; it is not a second public runtime. Applications execute emitted Wasm.

## 3. The minimal core

The core keeps one representation for each necessary semantic distinction.

### Bindings and effects

There is one `let` node. Its evaluation mode says whether the value is call-by-need or strictly
sequenced. A lazy binding may be deleted when unused, moved within its lexical scope, or compiled at
its sole strict use. A strict binding preserves evaluation before its body. Effects are carried by
ordinary callable definitions and immutable effect sets; frontends use strict bindings wherever
source sequencing must be observable.

Explicit `delay` and `force` are nominal `$ThunkType` construction and elimination. They are for
programs where a thunk is itself a value, not the compiler's default implementation of every local.

### Functions and data

Functions are unary. The Surface builder curries source-level parameter and argument lists.
Algebraic data is nominal and consumed by exhaustive `case`; records, lists, variants, and source
tuples lower to ordinary type declarations and constructors. The reserved `$TupleType` and `$Tuple`
form the standard pair, so products do not require a separate structural type primitive.

The type vocabulary is deliberately small: i32 integer, signed i64, f32, f64, boolean, unit,
function, parameter, named application, and predicative `forall` in schemas. There is no second
f64-backed whole-number family.

### Primitive operations

Surface primitive calls pack through one `Prim` node. Lowering turns it into the target-specific
Core operation after validating its operation and arity. Keeping arithmetic, conversion, buffer, and
store syntax out of the packed tag set prevents every primitive addition from growing the Surface
machine.

Structural equality remains a single erased primitive. Gleam and JavaScript AOT reach the backend
after the type-directed phase that could synthesize an equality function, so removing it would
require adding dictionaries or frontend-specific equality generation. Scalar equality remains the
normal fast path.

### Indexed data

Constructor result schemas may refine their declared nominal result. Those equalities are scoped to
the matching `case` arm. This machinery is not required by ordinary algebraic data, but it remains a
live part of the core because Lazuli uses indexed equality witnesses. A frontend that does not need
them should emit ordinary constructor results and use the Hindley–Milner profile.

## 4. Packed ABI

Functional ABI version 10 uses fixed-width `u32` records. Surface and Core nodes have eight words;
definitions have four, type declarations and constructors five, and schema nodes six. Counts are
explicit and `0xffffffff` is the absent index.

`ExpressionTag.Let` stores its evaluation mode in `NodeWord.Child2`. `ExpressionTag.Prim` stores the
operation identifier and argument spine. Resolved Core reuses the node layout but replaces names and
packed primitives with resolved local/global/constructor indices and concrete Core operations.

Type schemas use one linked-preorder encoding for host and GPU inference. The decoder rejects bad
indices, cycles, reused or unreachable records, invalid child counts, and excessive depth before
semantic use. An ABI-breaking layout or tag change increments `MODULE_ABI_VERSION` and updates every
encoder, shader decoder, host decoder, transfer format, trace, and malformed-input test together.

## 5. Modules and linking

A frontend emits one `ModuleArtifact` per source module. `linkModules()` qualifies private names,
follows reachable imports, validates typed boundaries, preserves source ranges, and selects the
entry. `surface_reachability.ts` then removes definitions unreachable from the entry, so unused
frontend runtime declarations do not enter inference or code generation.

Spans are UTF-8 byte offsets. `locateDiagnostic()` maps a linked span back to its owning source;
line and column conversion remains a frontend concern.

## 6. Semantic compilation

`FunctionalCompilerService` is the normal entry point. It chooses the CPU compiler for ordinary
Hindley–Milner modules, caches immutable and semantically identical inputs, applies literal-only
updates, and initializes a resident GPU compiler only when requested or required by the profile.

Host resolution builds a lowering plan with lexical depths and resolved global and constructor
indices. Inference covers Hindley–Milner unification, generalization, instantiation, annotations,
coverage, indexed refinements, and predicative rank-N checking when annotated. The TypeScript
inferencer is the CPU implementation and differential oracle; the WGSL inferencer expresses the same
work as bounded persistent state.

GPU transitions perform constant-bounded work. Frames survive dispatch boundaries, arena growth
copies and patches live state without resetting fuel, and cancellation is observed between bounded
dispatches. Batched modules keep independent lanes and deterministic result order.

## 7. WebAssembly backend

The supported target is the linear-memory backend. It emits a private tagged runtime representation
and may add Canonical ABI adapters for public records, variants, arrays, text, booleans, i64, f32,
and f64. Component tooling builds WIT and component boundaries from those adapters; hot reload swaps
compatible component instances rather than introducing another code generator.

The backend rewrites self-tail recursion into loops and contifies eligible local join points. It
performs demand and capture analysis before allocating thunks or closures. A lazy let referenced
once in a proven strict position compiles at its use, avoiding a thunk allocation while preserving
call-by-need semantics elsewhere.

Stores are immutable persistent values at the language boundary. Code generation may mutate an
allocation only when analysis proves it fresh and unaliased. In particular, a write whose sole
source is a fresh `StoreNew` reuses that allocation; writes to shared stores retain copy-on-write
behavior.

## 8. SIMD and branch metadata

`F32x4` and its mask are ordinary nominal algebraic values with portable scalar definitions. With
`{ simd: "wasm-simd" }`, native-value analysis keeps proven vector chains in `v128` across
parameters, let-bound values, projections, and compatible calls. Boxing and unboxing occur only at a
genuine generic, lazy, or public boundary. Native and boxed workers are emitted only when their
reachable call sites require them, because a partially native chain costs more than scalar code.

Branch likelihood is metadata, not semantics. Frontends may mark either `if` branch likely. The
backend also marks generated fault paths cold and resolved thunk paths hot, then emits the standard
branch-hint custom section. Engines that ignore it behave identically.

## 9. Host effects

Effect operations are typed callable evidence. Definition effect sets flow through globals,
closures, recursion, and higher-order applications. `withEffectHandler()` lexically replaces an
operation binding and can discharge its label when the replacement is pure; it is not dynamic
continuation interception.

Host capabilities become typed Wasm imports. Synchronous operations run through `runWasmModule()`;
suspending operations use `runWasmModuleAsync()`. Missing or malformed bindings fail at the host
boundary with structured evidence. Resumable or multi-shot effect handlers would require an honest
Core continuation construct and are not approximated by this system.

## 10. Ownership and failure boundaries

Malformed API input throws before compilation. Source failures return structured diagnostics. Device
loss, Wasm traps outside declared runtime faults, and violated internal invariants propagate as
infrastructure errors with their cause. Cancellation rejects with the caller's abort reason.

The application owns a supplied `GPUDevice`; a compiler service owns a device it requested. A
successful compiled module owns its GPU buffers until `destroy()`, which is idempotent. Temporary
workspaces and runtime allocations are released on success, failure, and cancellation. CPU-backed
modules keep the same lifetime contract even though destruction is a no-op.

## 11. Frontends

Repository frontends are examples, not public API:

- Gleam demonstrates strict lowering, module linking, records, bit arrays, and structural equality.
- Lazuli demonstrates lazy evaluation, indexed constructors, host values, and explicit thunks.
- Sweep demonstrates explicit checking and editor integration.
- JavaScript AOT demonstrates statement sequencing, persistent stores, and a large erased runtime.

New backend features must be expressed through language-neutral contracts under `src/functional/`.
Frontend keywords, parser nodes, and source-specific coercion rules do not enter Core.

## 12. Internal source map

| Concern                   | Primary modules                                                    |
| ------------------------- | ------------------------------------------------------------------ |
| Public API and ABI        | `functional.ts`, `src/functional/abi.ts`, `src/semantic/abi.ts`    |
| Surface and linking       | `surface_builder.ts`, `surface_contract.ts`, `module_linker.ts`    |
| Compiler service          | `compiler_service.ts`, `compiler.ts`, `compilation_admission.ts`   |
| CPU inference             | `src/semantic/type_inference.ts`, `type_schema_abi.ts`             |
| GPU inference             | `type_inference_shader.ts`, `gpu_type_inference_runner.ts`         |
| Wasm code generation      | `wasm_codegen.ts`, `wasm_binary.ts`, `wasm_artifacts.ts`           |
| Demand and reuse          | `wasm_capture_analysis.ts`, `wasm_unique_reuse_analysis.ts`        |
| Runtime and host boundary | `wasm_execution.ts`, `wasm_host_emitter.ts`, `wasm_value_codec.ts` |
| Components                | `canonical_abi.ts`, `component_boundary.ts`, `component_reload.ts` |
| Diagnostics and devices   | `diagnostics.ts`, `compilation_diagnostics.ts`, `src/webgpu.ts`    |

Only exports from `functional.ts` are package API. Other modules may be imported by repository tests
and reference frontends without becoming supported consumer entry points.
