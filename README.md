# gpufuck

`gpufuck` is a GPU-backed compiler backend for functional languages. A language frontend supplies
syntax, source-language rules, and desugaring; gpufuck resolves names, analyzes dependencies, infers
and checks types on WebGPU, lowers to a resolved Functional Core, and emits ordinary WebAssembly.

The generated `.wasm` does not require a GPU, WebGPU, Deno, or this package.

```text
source text
    │  your parser, module system, and language-specific checks
    ▼
Functional Surface / optional Type Core and Effect Core
    │  packing, static linking, and optional incremental cache
    ▼
GPU resolution, SCC analysis, inference, coverage, and Core lowering
    ▼
resolved Functional Core
    │  reachability, specialization, representation selection, and Wasm emission
    ▼
portable WebAssembly
```

The portable language includes:

- strict eager and lazy call-by-need evaluation;
- `i32`, `i64`, `f32`, `f64`, Boolean, unit, tuples, and nominal algebraic data;
- immutable bindings, closures, higher-order functions, recursion, and pattern matching;
- Hindley–Milner inference, indexed constructor results, and annotated predicative rank-N
  parameters;
- typed static modules, incremental compilation, required compile-time execution, and optional
  partial evaluation;
- algebraic-effect lowering and explicit host capabilities;
- a versioned structured-value ABI for Wasm arguments, results, text, bytes, arrays, slices, and
  resources.

This is a backend, not a universal source-language implementation. Frontends retain control of
syntax, module discovery, language-specific name rules, numeric semantics, effect policy, ownership,
and user-facing diagnostics.

## Installation

Compilation requires Deno 2.9 or newer, Deno's unstable WebGPU API, and a WebGPU adapter exposed by
the host.

```sh
deno add jsr:@mewhhaha/gpufuck@^0.1.0
```

Enable WebGPU in `deno.json`:

```json
{
  "unstable": ["webgpu"]
}
```

The package entry point is the language-neutral API:

```ts
import { GpuFunctionalCompiler, requestWebGpuDevice } from "@mewhhaha/gpufuck";
```

The bundled Lazuli, Gleam, Haskell, OCaml, Rust, and 1SubML frontends are repository examples; they
are not loaded by the published entry point.

### Machines without a GPU

There is no built-in CPU semantic-compiler fallback. `requestWebGpuDevice()` throws with setup
evidence when WebGPU is disabled, adapter discovery fails, or no hardware or software adapter is
available. A host-provided software adapter can be used for compatibility, although it is normally
much slower than a hardware adapter.

Only the build machine needs WebGPU. Compile and cache Wasm on a GPU-equipped builder, then run the
artifact on CPU-only deployment targets.

## Compile a first module

This program constructs `main = 40 + 2`, asks the GPU to resolve and infer it, emits Wasm, and runs
the exported function:

```ts
import {
  buildFunctionalSurfaceModule,
  compileFunctionalModuleToWasm,
  FunctionalBinaryOperator,
  FunctionalEvaluationProfile,
  GpuFunctionalCompiler,
  requestWebGpuDevice,
  surface,
} from "@mewhhaha/gpufuck";

const source = "main = 40 + 2";
const module = buildFunctionalSurfaceModule(
  [{
    name: "main",
    parameters: [],
    annotation: null,
    body: surface.binary(
      FunctionalBinaryOperator.Add,
      surface.integer(40),
      surface.integer(2),
    ),
  }],
  [],
  "main",
  new TextEncoder().encode(source).byteLength,
  { evaluationProfile: FunctionalEvaluationProfile.StrictEager },
);

const device = await requestWebGpuDevice();
try {
  const compiler = await GpuFunctionalCompiler.create(device);
  const compilation = await compiler.compileModule(module);
  if (!compilation.ok) {
    const diagnostic = compilation.diagnostics[0];
    throw new Error(
      `${diagnostic.code} at bytes ${diagnostic.span.startByte}..${diagnostic.span.endByte}: ` +
        diagnostic.message,
    );
  }

  try {
    const wasmBytes = await compileFunctionalModuleToWasm(compilation.module);
    const { instance } = await WebAssembly.instantiate(wasmBytes);
    const main = instance.exports.main;
    if (typeof main !== "function") throw new Error("compiled module did not export main");
    console.log(main()); // 42
  } finally {
    compilation.module.destroy();
  }
} finally {
  device.destroy();
}
```

`runFunctionalWasmModule()` is the shorter emit, instantiate, run, and decode path. Use
`compileFunctionalModuleToWasm()` when the bytes need to be cached, shipped, or instantiated by a
different runtime.

Reuse one `GpuFunctionalCompiler` for the lifetime of a device. Compiler creation includes shader
and pipeline initialization; recreating it for every source defeats the intended batching and cache
behavior.

## Connect a language frontend

A frontend should lower its language only as far as the portable functional surface:

1. Parse source and enforce source-language syntax, scope, ownership, and effect rules.
2. Desugar conveniences into functions, immutable bindings, applications, conditionals,
   constructors, and cases.
3. Choose the module's default evaluation profile and override individual binding boundaries only
   where the source language requires it.
4. Convert nominal declarations and explicit annotations into `FunctionalTypeSchema` values.
5. Attach UTF-8 byte spans to definitions, declarations, expressions, and types.
6. Build an encoded module, compile it, and translate neutral diagnostics back into source-language
   terminology.

A small source AST can lower directly to `FunctionalSurfaceExpression`:

```ts
import {
  FunctionalBinaryOperator,
  type FunctionalSurfaceExpression,
  surface,
} from "@mewhhaha/gpufuck";

type SourceExpression =
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "variable"; readonly name: string }
  | {
    readonly kind: "call";
    readonly callee: SourceExpression;
    readonly arguments: readonly SourceExpression[];
  }
  | {
    readonly kind: "add";
    readonly left: SourceExpression;
    readonly right: SourceExpression;
  };

function lowerExpression(expression: SourceExpression): FunctionalSurfaceExpression {
  switch (expression.kind) {
    case "integer":
      return surface.integer(expression.value);
    case "variable":
      return surface.name(expression.name);
    case "call":
      return surface.apply(
        lowerExpression(expression.callee),
        ...expression.arguments.map(lowerExpression),
      );
    case "add":
      return surface.binary(
        FunctionalBinaryOperator.Add,
        lowerExpression(expression.left),
        lowerExpression(expression.right),
      );
  }
}
```

`buildFunctionalSurfaceModule()` interns names, curries multi-parameter definitions, installs the
reserved unit and pair constructors, and packs the public ABI. Frontends that already own a packed
IR can encode `EncodedFunctionalModule` directly.

### Source feature mapping

| Source-language construct | Portable lowering                                                 |
| ------------------------- | ----------------------------------------------------------------- |
| Multiple parameters       | `parameters` or nested unary lambdas                              |
| Function call             | Left-associated `apply` nodes                                     |
| Tuple and unit            | Reserved pair and unit constructors                               |
| Struct, enum, or variant  | A nominal declaration, optionally lowered from a closed row       |
| Nested pattern            | Nested flat `case` expressions                                    |
| Local binding             | `let`                                                             |
| Local recursion           | `let-rec` or a mutually recursive `let-rec-group`                 |
| Module or record          | A generated nominal type or a linked module artifact              |
| Typeclass or trait        | Static evidence resolution or an explicit dictionary value        |
| Effect                    | Effect Core or an explicit host capability                        |
| Ownership or borrowing    | A frontend proof plus a selected host-boundary ownership contract |

The GPU resolves portable lexical names, global definitions, constructors, dependencies, recursive
SCCs, annotations, and case coverage. A frontend must still reject constructs whose meaning belongs
to that language, such as an illegal Rust move or an OCaml forward reference.

### Evaluation strategy

`buildFunctionalSurfaceModule()` defaults to `FunctionalEvaluationProfile.StrictEager`. A
Haskell-like frontend normally selects `LazyCallByNeed`. Mixed languages can set the evaluation mode
of an individual `let` value or application argument.

The choice is recorded in resolved Core and observed identically by the GPU evaluator and Wasm
backend. It controls implicit evaluation at binding boundaries. Explicit laziness is separate:
`surface.delay(expression)` creates a typed `Thunk value`, and `surface.force(thunk)` evaluates it
at most once and shares the result. Use `functionalThunkType(valueSchema)` when an exported boundary
needs an explicit thunk annotation.

### Types and inference

Ordinary and recursive definitions can omit annotations. Add a `FunctionalTypeSchema` where the
source language requires an exported contract, a higher-rank boundary, or a non-principal indexed
result.

```ts
const optionType = {
  name: "Option",
  parameters: ["value"],
  constructors: [
    { name: "None", fields: [] },
    {
      name: "Some",
      fields: [{ name: "value", type: { kind: "parameter", name: "value" } }],
    },
  ],
} as const;
```

The current inference profile is Hindley–Milner with mutually recursive SCCs, GADT-style indexed
constructor results, and explicitly annotated predicative rank-N function parameters. Existential
payloads use a fixed-eliminator closure encoding, so the hidden witness cannot escape. Higher-kinded
type functions, constraints, and open rows elaborate to ordinary first-order schemas, dictionaries,
and nominal declarations before GPU inference. The system is not dependent or impredicative. The
entry definition must resolve to a concrete first-order boundary type.

## Modules, incremental builds, and dead code

Source-language modules remain a frontend concern: the frontend parses imports, discovers files and
packages, applies visibility rules, and creates one `FunctionalModuleArtifact` per source module.
Gpufuck provides the target-level static linker:

```ts
const linked = linkFunctionalModules(
  [libraryArtifact, applicationArtifact],
  { module: "application", exportName: "main" },
);
const compilation = await compiler.compileModule(linked.module);
```

The linker qualifies definitions and nominal types, checks typed imports against exports, preserves
source ranges, and produces one link-before-GPU whole program. It is not a dynamic linker or a Wasm
object-file format.

`IncrementalGpuFunctionalCompiler` fingerprints interfaces separately from implementations and
caches resolved Core by module dependency SCC. An implementation-only change can reuse unaffected
importers; an interface change invalidates the reverse dependency closure. Directory and in-memory
caches are available.

Wasm emission performs whole-program definition reachability from `main` and every requested Wasm
export. Unreachable definitions and unused runtime facilities are absent from the artifact. All
submitted definitions are still resolved and typechecked before emission, so dead code does not hide
source errors and early reachability is not currently a substitute for frontend dependency
selection.

## Compile-time execution and type programming

`GpuFunctionalComptimeExecutor` provides required, pure, bounded compile-time execution. It uses the
same module, linking, inference, and value contracts as runtime code and supports:

- pure scalar, tuple, and ADT computation;
- bounded recursion and case analysis;
- cross-module constant exports;
- reusable single-argument compile-time functions;
- generated Functional definition fragments through the canonical comptime IR schema;
- execution, output-node, output-byte, and output-depth limits.

Host capabilities and effects are deliberately unavailable during required compile-time execution.
`partiallyEvaluateFunctionalModule()` is the opportunistic counterpart: successful pure reductions
replace expressions, while faults or exhausted budgets leave the original artifact unchanged.

Type-level computation is exposed separately:

- `FunctionalTypeNormalizer` normalizes frontend-declared type functions, higher-kinded
  applications, and associated-family-style equations.
- `TypeCoreCapabilityResolver` searches bounded rules for proofs, facts, methods, fields, and other
  frontend-defined capabilities.
- `FunctionalConstraintElaborator` combines both services and inserts resolved runtime dictionaries
  into ordinary surface calls.
- `unifyFunctionalRows` shares open-row unification across records, variants, and effects; closed
  rows lower through `functionalRowTypeDeclaration()` or `functionalEffectOperationsFromRow()`.
- `GpuTypeCoreExecutor` runs pure type programs over symbols, values, and type trees.

These services are optional. A simple Hindley–Milner frontend can ignore them.

## Effects, hosts, and ownership

Effects are explicit rather than inferred from arbitrary host calls. A frontend can lower an
algebraic-effect program with `lowerFunctionalEffectProgram()` or submit verified Effect Core with
`compileEffectModule()`.

At the Wasm boundary, an optional `Init` value carries declared host values and operations. Each
operation has a concrete parameter and result type and may be synchronous or suspending. Suspending
operations use `runFunctionalWasmModuleAsync()`, which resumes through bounded deterministic replay;
the synchronous runner rejects them. Both runners accept an `AbortSignal`. The async runner races
each suspension against that signal, releases the invocation arena before waiting, and can reuse the
compiled module after cancellation.

`FunctionalHostOwnership` describes transfer, unique, bounded-borrow, and frozen-shareable contracts
for host values. Gpufuck validates and enforces the selected boundary representation, but it does
not infer a source language's ownership rules or provide a runtime borrow checker. Languages such as
Rust must prove moves and borrows before lowering.

After GPU compilation, `planFunctionalModuleStorage()` exposes the backend representation decisions
for frontend audits and build tooling:

```ts
import { FunctionalStorageClass, planFunctionalModuleStorage } from "@mewhhaha/gpufuck";

const storage = await planFunctionalModuleStorage(compilation.module);
if (!storage.verification.ok) throw new Error("unreachable: derived storage was not verified");
if (storage.summary.invocationArenaValues > 0) {
  console.log("the module uses invocation-lifetime allocation");
}
```

The plan keeps semantic Core independent of a memory policy. Captureless and directly used closures
prefer scalar-local representation; module definitions and nullary constructors have static
lifetime; escaping closures, local thunks, and recursive environments use the invocation arena. An
`escapeStorage` records the fallback when a value that is normally virtual becomes first-class.
Ownership-transfer boundaries are `owned`, while frozen values remain `host-managed`.
`summary.automaticArenaReset` reports whether the standard runner can reclaim the invocation region
after decoding the result. A module with a static memoized thunk keeps its heap because that thunk
may retain values across calls.

This division is intentional: a frontend proves source moves, borrows, affine use, and destructor
ordering. Gpufuck validates the chosen host contract, computes captures and escape fallbacks, and
selects the Wasm representation. Persistent shared graphs still require an explicit frontend/runtime
strategy such as reference counting or host management; Functional Core does not silently add a
tracing collector.

Frontends with additional lexical regions or persistent values can describe those decisions as
`FunctionalStorageCoreProgram` operations and call `verifyFunctionalStorageCore()`. The verifier
checks LIFO arena scope, use after scope, references from longer to shorter lifetimes, promotion,
owned retain/release operations, and the selected `reject`, `host-managed`, or
`explicit-reference-counting` sharing policy. The plan returned above includes the verified Storage
Core derived by the standard backend. Reference analysis records statically named closure captures,
recursive environments, constructor fields, local bindings, and globals. Passing a frontend
`storageCore` to `compileFunctionalModuleToWasm()` makes that manifest mandatory: compilation
rejects any missing declaration, lifetime, or resolved reference edge.

Strict frontends can request standalone owned-value operations without adding them to ordinary
binaries:

```ts
const bytes = await compileFunctionalModuleToWasm(compilation.module, {
  storageCore: frontendStorageCore,
  ownedTypeExports: [{ name: "message", type: messageType }],
});

// The emitted module exports retain_message(i64) and drop_message(i64).
```

`ownedTypeExports` requires verified owned storage and strict first-order Core. Generated drop glue
walks tuples, ADTs, arrays, slices, text, bytes, numerics, and resource wrappers before returning
their blocks to the Wasm free list. Opaque host resources still require the embedding-side
`dropResource` callback. `FunctionalWasmOwnedValue.transfer()` relinquishes the JavaScript lease
when ownership crosses into emitted Wasm.

Embedders that instantiate emitted Wasm directly can create nested temporary lifetimes with
`beginFunctionalWasmArena(instance)` or the exception-safe `withFunctionalWasmArena(instance, run)`.
`encodeFunctionalWasmArenaValue()` allocates a boundary value in that scope. Promotion to a parent
arena or to owned storage performs a checked deep copy and ends the source arena, so no pointer into
the expired region survives. Owned values expose `retain()` leases and release their complete
encoded object graph after the final lease. A `dropResource` callback supplies recursive drop glue
for opaque resource fields. Arena allocation is isolated from owned free-list blocks that predate
it. `arena.reset()` must run from the innermost arena outward and restores both allocator frontiers.
The older numeric scratch-mark functions remain as compatibility wrappers over the same arena
implementation.

## Wasm boundary

Direct execution accepts one concrete first-order argument and result, or an `Init -> result` entry.
Scalars use native Wasm values where possible. Structured values use `FunctionalWasmValueAbi` v1,
whose public representation has eight-byte values and sixteen-byte aligned object headers.

Higher-order closures cannot cross the public boundary. Text, bytes, arrays, slices, and nominal
resource handles are available through `FunctionalHostTypes`. Decode limits bound structured
results, and cyclic public results are rejected.

If an application instantiates emitted bytes without gpufuck's runners, it receives native Wasm
traps. Generated modules export fault evidence so another runtime adapter can translate failures in
the same way as `runFunctionalWasmModule()`.

## Diagnostics and resource ownership

Expected source failures are returned as structured results:

| Boundary                                         | Failure channel                                            |
| ------------------------------------------------ | ---------------------------------------------------------- |
| GPU semantic compilation                         | `{ ok: false, diagnostics }` with `F1xxx`/`F2xxx` codes    |
| GPU or Wasm evaluation                           | `{ ok: false, fault }` or `FunctionalWasmRuntimeError`     |
| Static linking                                   | `FunctionalLinkError` with `F4001`–`F4007`                 |
| Wasm arguments and `Init`                        | `FunctionalWasmBoundaryError`                              |
| Required compile-time execution                  | compile, runtime, or `F5001`/`F5002` evidence              |
| Storage Core lifetime and ownership verification | `F6001`–`F6006` diagnostic or `FunctionalStorageCoreError` |
| WebGPU setup, cancellation, or invariant failure | thrown or rejected error with its cause                    |

Spans are UTF-8 byte offsets. Linked modules retain source ranges, and
`locateFunctionalDiagnostic()` maps aggregate offsets back to the owning module. Frontends are
responsible for filenames, line and column lookup, excerpts, and language-specific wording.

A successful `GpuFunctionalModule` owns GPU buffers. Always call `module.destroy()` in `finally`.
Evaluators release their temporary buffers automatically. Emitted Wasm bytes remain valid after the
GPU module is destroyed.

## Throughput

Use `compileBatch()` for independent programs and reuse one compiler. The scheduler coalesces ready
GPU work, admission control bounds transient device memory, and identical frontend preparation can
be shared by the caller. Tiny one-off programs are dominated by WebGPU submission and readback; wide
batches and larger programs are the intended compilation workload.

Wasm emission applies whole-program reachability, capture analysis, lambda-set specialization,
direct-call selection, uncurried native workers, tail-recursion lowering, strict numeric unboxing,
and runtime feature pruning. These optimizations preserve the frontend's chosen lazy or strict
semantics.

Benchmark numbers depend heavily on adapter, driver, Deno, and workload. The repository keeps
reproducible benchmark tasks instead of publishing machine-independent speed claims.

## Included examples

The repository contains independent frontends that exercise the public target. They demonstrate
lowering techniques, not complete compatibility with their source languages.

| Frontend                                                | Boundary demonstrated                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Gleam](examples/gleam-functional/README.md)            | Strict inference, ADTs, pipelines, and typed multi-module linking        |
| [Rust](examples/rust-functional/)                       | Enums, structs, generics, matches, moves, borrows, and rejected mutation |
| [Haskell](examples/haskell-functional/README.md)        | Laziness, inference, dictionaries, GADTs, and recursive data             |
| [OCaml](examples/ocaml-functional/README.md)            | Sequential scope, explicit recursion, variants, and lists                |
| [1SubML](examples/onesubml-functional/README.md)        | Rank-N parameters, modules as records, and expression blocks             |
| [Lazuli](examples/lazuli/)                              | Reference syntax, indexed proofs, host values, and laziness              |
| [Functional IR](examples/functional-ir/README.md)       | Direct effects, host `Init`, comptime code generation, and type programs |
| [Type programming](examples/type-programming/README.md) | Idris2-style indices and Zig-style reflection experiments                |
| [PureScript profile](examples/purescript-functional/)   | Open rows, functional dependencies, composed evidence, and rank-2 types  |

Each source-language example has a trace task that writes the source, normalized surface, packed
ABI, and GPU-resolved Core side by side. For example:

```sh
deno task trace:haskell-functional \
  examples/haskell-functional/tree.hs \
  examples/haskell-functional/tree.trace.md
```

The Gleam example includes a three-module program whose generated trace makes source modules,
normalized surface expressions, the packed ABI, and linked GPU-resolved Core directly comparable.
The PureScript example is intentionally a type-system profile rather than a syntax frontend; its
README separates the represented features from the remaining frontend work.

## Limits

Important current limits include:

- semantic compilation requires WebGPU;
- source is capped at 1 MiB, surface trees at 65,536 nodes, semantic depth at 512, and constructor
  arity at 64;
- compilation defaults to 1,000,000 persistent semantic transitions;
- the type system is HM plus indexed results and annotated predicative rank-N boundaries;
- native existential constructors, full dependent types, and impredicative inference are absent;
- raw memory intrinsics, native SIMD, tracing GC, and a runtime borrow checker are outside
  Functional Core;
- direct public Wasm boundaries exclude higher-order values and cyclic structured results;
- async effects use deterministic replay rather than stackful continuations;
- independently emitted Wasm objects and dynamic linking are not implemented.

Budgets and device limits fail with structured evidence instead of permitting unbounded GPU work.
See [ARCHITECTURE.md](ARCHITECTURE.md) for the rationale, exact stage boundaries, and implementation
invariants.

## Documentation

- [CHANGELOG.md](CHANGELOG.md) records public release changes.
- [ARCHITECTURE.md](ARCHITECTURE.md) explains the compiler pipeline, ownership boundaries, GPU
  machine, Wasm backend, decision record, and technical references.
- [DEVELOPMENT.md](DEVELOPMENT.md) covers repository setup, generated files, tests, benchmarks,
  profiling, and publishing checks.
- [`examples/functional-ir`](examples/functional-ir/README.md) contains minimal backend-first
  integration examples.
- [`examples/haskell-functional`](examples/haskell-functional/README.md) shows a larger lazy
  frontend and its current compatibility boundary.

## License

MIT. See [LICENSE](LICENSE).
